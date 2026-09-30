/**
 * The daily prize: 10% of the pool, split 40/25/15/12/8 between the five fastest of a UTC day.
 *
 * NOTE ON WHAT IS NOT COVERED HERE. The 90 day claim window cannot be exercised against
 * solana-test-validator, which has no way to advance its clock - unlike the EVM suite, where
 * `evm_increaseTime` let the expiry path be tested directly. Everything up to and including
 * claiming is covered; `sweep_expired` is not, and is flagged in docs/THREAT-MODEL.md as such.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  anchor, connection, funded, provider, idl, makeMint, tokenAccount, balance,
  dayMessage, ed25519Ix, pda, leU64, ONE, oracleKeypair, Keypair, Transaction,
  SYSVAR_INSTRUCTIONS_PUBKEY, TOKEN_PROGRAM_ID, SystemProgram, RPC,
} from './helpers.mjs';

const DAILY_BPS = 1000n;
const SPLIT = [4000n, 2500n, 1500n, 1200n, 800n];

let conn, admin, oracle, mint, program, config, vault;
const racers = [];
const now = () => Math.floor(Date.now() / 1000);
/** a day that is definitely over, so settle_day's DayNotOver check passes */
const pastDay = (back = 1) => Math.floor(now() / 86400) - back;
/** today, for working out how far back the settle tool has to look */

const dayPda = (day) => pda([Buffer.from('day'), leU64(day)], program.programId);

/** what the program will allocate, in its own integer order */
const sharesOf = (pool, n) => {
  const payout = (pool * DAILY_BPS) / 10000n;
  return Array.from({ length: n }, (_, i) => (payout * SPLIT[i]) / 10000n);
};

async function settle(day, winners, timesMs, { signer = oracle, deadline = now() + 3600 } = {}) {
  const result = {
    day: new anchor.BN(day),
    winners: winners.map((w) => w.kp.publicKey),
    timesMs,
    deadline: new anchor.BN(deadline),
  };
  const msg = dayMessage({ day, winners: result.winners, timesMs, deadline });
  const ix = await program.methods.settleDay(new anchor.BN(day), result, 0)
    .accounts({ payer: admin.publicKey, systemProgram: SystemProgram.programId,
                config, vault, dayResult: dayPda(day), ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY })
    .instruction();
  return provider(conn, admin).sendAndConfirm(
    new Transaction().add(ed25519Ix(signer, msg)).add(ix), [admin]);
}

async function claim(day, racer) {
  return program.methods.claim(new anchor.BN(day))
    .accounts({ config, winner: racer.kp.publicKey, rewardMint: mint,
                tokenProgram: TOKEN_PROGRAM_ID, vault, dayResult: dayPda(day),
                winnerToken: racer.ata })
    .signers([racer.kp]).rpc();
}

before(async () => {
  conn = connection();
  admin = await funded(conn, 100);
  oracle = oracleKeypair();
  program = new anchor.Program(idl('reward_vault'), provider(conn, admin));
  config = pda([Buffer.from('config')], program.programId);
  vault = pda([Buffer.from('vault')], program.programId);

  const existing = await conn.getAccountInfo(config);
  if (existing) {
    mint = (await program.account.vaultConfig.fetch(config)).rewardMint;
  } else {
    mint = await makeMint(conn, admin);          // stands in for TAO: 9 decimals, classic SPL
    await program.methods.initialize(oracle.publicKey)
      .accounts({ authority: admin.publicKey, rewardMint: mint,
                  tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
                  config, vault })
      .signers([admin]).rpc();
  }
  for (let i = 0; i < 6; i++) {
    const kp = await funded(conn, 5);
    racers.push({ kp, ata: await tokenAccount(conn, admin, mint, kp.publicKey) });
  }

  // the settle-tool block at the bottom of this file needs `oracle` and `racers`, so its setup
  // runs from here rather than from a second `before` hook - two hooks left the order of
  // assignment implicit, and it did not hold
  await setupSettleTool();
});

/** fees arrive as a plain transfer that calls nothing - exactly how the vault will be funded */
async function sweepFeesIn(amount) {
  const src = await tokenAccount(conn, admin, mint, admin.publicKey, amount);
  const { transfer } = await import('@solana/spl-token');
  await transfer(conn, admin, src, vault, admin, amount, [], { commitment: 'confirmed' }, TOKEN_PROGRAM_ID);
}

test('a plain transfer becomes the pool, with no call to the program', async () => {
  await sweepFeesIn(100n * ONE);
  assert.equal(await balance(conn, vault), 100n * ONE);
  assert.equal((await program.account.vaultConfig.fetch(config)).owed.toString(), '0');
});

test('a day pays 10% of the pool, split 40/25/15/12/8', async () => {
  const day = pastDay(1);
  const pool = await balance(conn, vault);
  const want = sharesOf(pool, 5);

  await settle(day, racers.slice(0, 5), [141000, 143000, 145000, 147000, 149000]);

  const d = await program.account.dayResultAccount.fetch(dayPda(day));
  assert.deepEqual(d.amounts.map(String), want.map(String));
  assert.equal(d.allocated.toString(), want.reduce((a, b) => a + b, 0n).toString());
  // five full places spend the whole 10%
  assert.equal(d.allocated.toString(), ((pool * DAILY_BPS) / 10000n).toString());

  const cfg = await program.account.vaultConfig.fetch(config);
  assert.equal(cfg.owed.toString(), d.allocated.toString());
});

test('each winner claims their own share, once', async () => {
  const day = pastDay(1);
  const d = await program.account.dayResultAccount.fetch(dayPda(day));
  for (let i = 0; i < 5; i++) {
    const before = await balance(conn, racers[i].ata);
    await claim(day, racers[i]);
    assert.equal(await balance(conn, racers[i].ata), before + BigInt(d.amounts[i].toString()));
    await assert.rejects(() => claim(day, racers[i]),
      (e) => /AlreadyClaimed|custom program error/.test(String(e)));
  }
  assert.equal((await program.account.vaultConfig.fetch(config)).owed.toString(), '0');
});

test('someone who did not place cannot claim', async () => {
  await assert.rejects(() => claim(pastDay(1), racers[5]),
    (e) => /NotAWinner|custom program error/.test(String(e)));
});

test('fewer than five drivers leaves the unfilled places in the pool', async () => {
  const day = pastDay(2);
  const pool = await balance(conn, vault) - BigInt((await program.account.vaultConfig.fetch(config)).owed.toString());
  const want = sharesOf(pool, 3);                       // 40 + 25 + 15 = 80% of the payout

  await settle(day, racers.slice(0, 3), [141000, 143000, 145000]);

  const d = await program.account.dayResultAccount.fetch(dayPda(day));
  assert.equal(d.amounts.length, 3);
  assert.deepEqual(d.amounts.map(String), want.map(String));
  const fullPayout = (pool * DAILY_BPS) / 10000n;
  const allocated = BigInt(d.allocated.toString());
  assert.ok(allocated < fullPayout, 'three winners should not spend the whole payout');
  // the other 20% never left the pool
  assert.equal(fullPayout - allocated, (fullPayout * 2000n) / 10000n);
});

test('a day cannot be settled twice', async () => {
  await assert.rejects(() => settle(pastDay(2), racers.slice(0, 2), [1, 2]),
    (e) => /already in use|custom program error/.test(String(e)));
});

test('a day that is not over cannot be settled', async () => {
  const future = Math.floor(now() / 86400) + 2;
  await assert.rejects(() => settle(future, racers.slice(0, 2), [1, 2]),
    (e) => /DayNotOver|custom program error/.test(String(e)));
});

test('a result signed by anyone but the oracle is refused', async () => {
  await assert.rejects(() => settle(pastDay(3), racers.slice(0, 2), [1, 2], { signer: Keypair.generate() }),
    (e) => /WrongOracleKey|custom program error/.test(String(e)));
});

test('the same address cannot take two places', async () => {
  await assert.rejects(() => settle(pastDay(3), [racers[0], racers[0]], [1, 2]),
    (e) => /DuplicateWinner|custom program error/.test(String(e)));
});

test('an expired result is refused', async () => {
  await assert.rejects(() => settle(pastDay(3), racers.slice(0, 2), [1, 2], { deadline: now() - 3600 }),
    (e) => /ResultExpired|custom program error/.test(String(e)));
});

test('a tampered winner list is refused', async () => {
  const day = pastDay(3);
  const honest = [racers[0], racers[1]];
  const times = [141000, 143000];
  const msg = dayMessage({ day, winners: honest.map((w) => w.kp.publicKey), timesMs: times, deadline: now() + 3600 });
  // sign for racers 0 and 1, then submit racer 5 in first place
  const swapped = {
    day: new anchor.BN(day),
    winners: [racers[5].kp.publicKey, racers[1].kp.publicKey],
    timesMs: times,
    deadline: new anchor.BN(now() + 3600),
  };
  const ix = await program.methods.settleDay(new anchor.BN(day), swapped, 0)
    .accounts({ payer: admin.publicKey, systemProgram: SystemProgram.programId,
                config, vault, dayResult: dayPda(day), ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY })
    .instruction();
  await assert.rejects(
    () => provider(conn, admin).sendAndConfirm(new Transaction().add(ed25519Ix(oracle, msg)).add(ix), [admin]),
    (e) => /MessageMismatch|custom program error/.test(String(e)));
});

/* -------------------------------------------------------------------------------------------- *
 * The settle tool, end to end, as a subprocess.
 *
 * oracle/tools/settle.mjs is what actually pays the prize every night, from cron, unattended. It
 * is also the only part of the oracle that builds a Solana transaction, and a wrong account order
 * or a mis-encoded argument there is invisible until midnight - by which point the failure is a
 * log line nobody reads and a day nobody got paid for.
 *
 * So this runs the real file, as a real process, with a real store behind it: `node
 * tools/settle.mjs`. Nothing is imported and re-wired, because the wiring is what is under test.
 *
 * These live at the END of this file rather than in their own, and that is deliberate. There is
 * one config PDA per program, so every test file on this validator shares one vault - and the
 * first test above asserts the vault's balance EXACTLY. A separate file would have to run after
 * this one to avoid breaking it, which means depending on the alphabetical order of filenames for
 * correctness. Same file, plain order, no hidden rule.
 * -------------------------------------------------------------------------------------------- */

const SETTLE_DAY = pastDay(4);          // untouched by anything above
const ORACLE_DIR = new URL('../../oracle/', import.meta.url).pathname;
let settleEnv = null;

async function setupSettleTool() {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mkdtemp, writeFile, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  // The tool pays the transaction fee AND the day account's rent, so the settler needs SOL. On a
  // fresh validator the oracle key has none - which the tool itself reported when this test was
  // first written, exactly as designed.
  await conn.confirmTransaction(await conn.requestAirdrop(oracle.publicKey, 5_000_000_000), 'confirmed');

  // The trackId must be the one settle.mjs will compute from the real track geometry. Guessing it
  // would make attestDay find nothing, and the tool would exit 0 having done nothing at all -
  // which is the precise failure this test exists to catch, so it is read from the oracle's own
  // code rather than written out here.
  const { trackIdOf } = await import(ORACLE_DIR + 'attest.mjs');
  const { trackFingerprint, TRACK_ID } = await import(ORACLE_DIR + 'replay.mjs');
  const trackId = trackIdOf(TRACK_ID, await trackFingerprint());

  const dataDir = await mkdtemp(join(tmpdir(), 'tensorace-settle-'));
  await mkdir(join(dataDir, 'traces'), { recursive: true });
  await writeFile(join(dataDir, 'runs.json'), JSON.stringify({
    runs: racers.slice(0, 5).map((r, i) => ({
      id: `seed-${i}`,
      at: new Date(SETTLE_DAY * 86400000 + 3600_000 * (i + 1)).toISOString(),
      driver: r.kp.publicKey.toBase58(),
      name: `racer ${i + 1}`,
      trackId,
      timeMs: 90_000 + i * 1000,      // already in rank order, fastest first
      lapMs: [30_000, 30_000, 30_000 + i * 1000],
      bestLapMs: 30_000,
      traceHash: 'ab'.repeat(32),
      ticks: 9000,
      respawns: 0,
    })),
  }));

  const run = promisify(execFile);
  settleEnv = (extra = {}) => run('node', ['tools/settle.mjs'], {
    cwd: ORACLE_DIR,
    env: { ...process.env, CLUSTER: 'localnet', RPC_URL: RPC, DATA_DIR: dataDir,
           LOOKBACK_DAYS: String(pastDay(0) - SETTLE_DAY + 1), ...extra },
  });
}

test('the settle tool: a dry run reports the day and sends nothing', async () => {
  const { stdout } = await settleEnv({ DRY_RUN: '1' });
  assert.match(stdout, new RegExp(`day ${SETTLE_DAY}: 5 winner\\(s\\), fastest 90\\.000s`), stdout);
  assert.equal(await conn.getAccountInfo(dayPda(SETTLE_DAY)), null, 'a dry run must not create the day account');
});

test('the settle tool settles on chain, and allocates the 40/25/15/12/8 split', async () => {
  // measured now, not assumed: earlier tests in this file have already moved the pool around
  const pool = (await balance(conn, vault)) - BigInt((await program.account.vaultConfig.fetch(config)).owed.toString());
  const expected = sharesOf(pool, 5);

  const { stdout } = await settleEnv();
  assert.match(stdout, new RegExp(`day ${SETTLE_DAY} settled in `), stdout);

  const d = await program.account.dayResultAccount.fetch(dayPda(SETTLE_DAY));
  assert.equal(d.settled, true);
  assert.deepEqual(
    d.winners.map((w) => w.toBase58()),
    racers.slice(0, 5).map((r) => r.kp.publicKey.toBase58()),
    'winners must be in the rank order the oracle signed',
  );
  assert.deepEqual(d.amounts.map((a) => BigInt(a.toString())), expected);
});

test('the settle tool is a no-op the second time, because the day account already exists', async () => {
  const { stdout } = await settleEnv();
  assert.match(stdout, /0 settled/, stdout);
  assert.doesNotMatch(stdout, /FAILED/);
});

test('a winner can claim what the settle tool allocated', async () => {
  // the point of settling: proof the allocation is spendable, not merely recorded
  const d = await program.account.dayResultAccount.fetch(dayPda(SETTLE_DAY));
  const before = await balance(conn, racers[0].ata);
  await claim(SETTLE_DAY, racers[0]);
  assert.equal((await balance(conn, racers[0].ata)) - before, BigInt(d.amounts[0].toString()));
});

test('the settle tool refuses a mismatched oracle up front, not one signature at a time', async () => {
  // seed 99 is not the key this vault trusts. Catching it before sending anything is the
  // difference between one clear line and a nightly failure that looks like a program bug.
  const other = Keypair.fromSeed(Buffer.alloc(32, 99));
  await assert.rejects(
    () => settleEnv({ ORACLE_KEYPAIR: JSON.stringify([...other.secretKey]) }),
    (e) => {
      assert.match(e.stderr, /the vault trusts oracle/);
      assert.match(e.stderr, /every signature would be rejected/);
      return true;
    },
  );
});
