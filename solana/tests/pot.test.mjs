/**
 * The open time attack: everyone pays the same entry, the fastest verified time takes the pool.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  anchor, connection, funded, provider, idl, makeMint, tokenAccount, balance,
  runMessage, ed25519Ix, pda, leU64, ONE, oracleKeypair, ensureConfig, waitForChainTime, chainNow, Keypair, Transaction,
  SYSVAR_INSTRUCTIONS_PUBKEY, TOKEN_PROGRAM_ID, SystemProgram,
} from './helpers.mjs';

const TRACK = Array.from(Buffer.alloc(32, 7));
const DAY = 86400;
const FEE_BPS = 250;

let conn, admin, oracle, treasury, mint, program, config;
const racers = {};
let nonce = 5000n;
const now = () => Math.floor(Date.now() / 1000);

function makeRun({ driver, timeMs, issuedAt = now() - 5 }) {
  return {
    driver: driver.publicKey, trackId: TRACK, timeMs,
    traceHash: Array.from(Buffer.alloc(32, Number(nonce) % 251)),
    issuedAt: new anchor.BN(issuedAt),
    deadline: new anchor.BN(now() + DAY),
    nonce: new anchor.BN((nonce++).toString()),
  };
}
const msgOf = (r) => runMessage({
  driver: r.driver, trackId: r.trackId, timeMs: r.timeMs, traceHash: r.traceHash,
  issuedAt: r.issuedAt.toString(), deadline: r.deadline.toString(), nonce: r.nonce.toString(),
});

const potPda = (id) => pda([Buffer.from('pot'), leU64(id)], program.programId);
const vaultPda = (p) => pda([Buffer.from('vault'), p.toBuffer()], program.programId);
const entryPda = (p, who) => pda([Buffer.from('entry'), p.toBuffer(), who.toBuffer()], program.programId);
const noncePda = (who, n) => pda([Buffer.from('nonce'), who.toBuffer(), leU64(n)], program.programId);

before(async () => {
  conn = connection();
  admin = await funded(conn, 100);
  oracle = oracleKeypair();
  treasury = Keypair.generate();
  program = new anchor.Program(idl('race_stakes'), provider(conn, admin));
  mint = await makeMint(conn, admin);
  config = pda([Buffer.from('config')], program.programId);

  const existing = await conn.getAccountInfo(config);
  if (!existing) {
    await program.methods.initialize(oracle.publicKey, FEE_BPS)
      .accounts({ config, authority: admin.publicKey, treasury: treasury.publicKey,
                  stakeMint: mint, systemProgram: SystemProgram.programId })
      .signers([admin]).rpc();
  }
});

/** a pot needs its own mint if config already fixed one, so read what config actually uses */
async function ensureRacers(names) {
  const cfg = await program.account.config.fetch(config);
  for (const n of names) {
    if (racers[n]) continue;
    const kp = await funded(conn, 20);
    racers[n] = { kp, ata: await tokenAccount(conn, admin, cfg.stakeMint, kp.publicKey, 5_000n * ONE) };
  }
  return cfg;
}

async function createPot(id, entryFee, closesAt) {
  const cfg = await program.account.config.fetch(config);
  const pot = potPda(id);
  await program.methods.createPot(new anchor.BN(id), TRACK,
      new anchor.BN(entryFee.toString()), new anchor.BN(closesAt))
    .accounts({ config, creator: admin.publicKey, stakeMint: cfg.stakeMint,
                tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
                pot, vault: vaultPda(pot) })
    .signers([admin]).rpc();
  return pot;
}

async function enter(pot, id, name) {
  const cfg = await program.account.config.fetch(config);
  const { kp, ata } = racers[name];
  await program.methods.enterPot(new anchor.BN(id))
    .accounts({ config, entrant: kp.publicKey, stakeMint: cfg.stakeMint,
                tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
                pot, vault: vaultPda(pot), entry: entryPda(pot, kp.publicKey), from: ata })
    .signers([kp]).rpc();
}

async function postTime(pot, id, name, timeMs, signer = oracle) {
  const { kp } = racers[name];
  const r = makeRun({ driver: kp, timeMs });
  const ix = await program.methods.postPotTime(new anchor.BN(id), r.nonce, r, 0)
    .accounts({ config, entrant: kp.publicKey, systemProgram: SystemProgram.programId,
                pot, entry: entryPda(pot, kp.publicKey),
                nonceMarker: noncePda(kp.publicKey, r.nonce.toString()),
                ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY })
    .instruction();
  return provider(conn, kp).sendAndConfirm(
    new Transaction().add(ed25519Ix(signer, msgOf(r))).add(ix), [kp]);
}

test('the fastest entrant takes the pool', async () => {
  await ensureRacers(['a', 'b', 'c']);
  const cfg = await program.account.config.fetch(config);
  const id = Number(cfg.potCount);
  const entry = 50n * ONE;
  /**
   * The close time must sit far enough ahead to fit the six transactions below - three entries and
   * three posted times - because `post_pot_time` refuses a pot that has already closed.
   *
   * An earlier version of this test used `now() + 6` on the WALL clock and slept a fixed six
   * seconds, which was flaky. Moving to the chain's clock fixed the sleep but made the window
   * WORSE: the chain runs a second or two behind, so `chainNow() + 4` was barely two wall seconds,
   * and the six transactions do not fit. Hence a margin measured against what the work actually
   * costs (~9s observed) rather than against what feels short. Waiting is polled, so a generous
   * window costs nothing once the work is done.
   */
  const closesAt = (await chainNow(conn)) + 25;           // in the chain's own frame
  const pot = await createPot(id, entry, closesAt);

  for (const n of ['a', 'b', 'c']) await enter(pot, id, n);
  await postTime(pot, id, 'a', 143680);
  await postTime(pot, id, 'b', 141220);                    // fastest
  await postTime(pot, id, 'c', 149000);

  const p = await program.account.pot.fetch(pot);
  assert.equal(p.leader.toBase58(), racers.b.kp.publicKey.toBase58());
  assert.equal(p.leaderMs, 141220);
  assert.equal(p.entrants, 3);

  await waitForChainTime(conn, closesAt + 1);               // poll, do not guess
  const before = await balance(conn, racers.b.ata);
  const treasuryAta = await tokenAccount(conn, admin, cfg.stakeMint, cfg.treasury);
  await program.methods.settlePot(new anchor.BN(id))
    .accounts({ config, pot, vault: vaultPda(pot), winner: racers.b.kp.publicKey,
                winnerToken: racers.b.ata, treasuryToken: treasuryAta,
                stakeMint: cfg.stakeMint, tokenProgram: TOKEN_PROGRAM_ID })
    .rpc();

  const prize = entry * 3n;
  const fee = (prize * BigInt(FEE_BPS)) / 10000n;
  assert.equal(await balance(conn, racers.b.ata), before + prize - fee);
});

test('only a driver\'s best time counts, and a tie keeps the earlier leader', async () => {
  await ensureRacers(['d', 'e']);
  const cfg = await program.account.config.fetch(config);
  const id = Number(cfg.potCount);
  const pot = await createPot(id, 10n * ONE, now() + 3600);
  await enter(pot, id, 'd');
  await enter(pot, id, 'e');

  await postTime(pot, id, 'd', 145000);
  await postTime(pot, id, 'd', 150000);                    // slower: ignored
  assert.equal((await program.account.potEntry.fetch(entryPda(pot, racers.d.kp.publicKey))).bestMs, 145000);

  await postTime(pot, id, 'e', 145000);                    // dead heat: d was first
  const p = await program.account.pot.fetch(pot);
  assert.equal(p.leader.toBase58(), racers.d.kp.publicKey.toBase58());
});

test('a time cannot be posted by someone who never entered', async () => {
  await ensureRacers(['f', 'g']);
  const cfg = await program.account.config.fetch(config);
  const id = Number(cfg.potCount);
  const pot = await createPot(id, 10n * ONE, now() + 3600);
  await enter(pot, id, 'f');
  await assert.rejects(() => postTime(pot, id, 'g', 140000),
    (e) => /AccountNotInitialized|NotEntered|custom program error/.test(String(e)));
});

test('entering twice is impossible', async () => {
  await ensureRacers(['h']);
  const cfg = await program.account.config.fetch(config);
  const id = Number(cfg.potCount);
  const pot = await createPot(id, 10n * ONE, now() + 3600);
  await enter(pot, id, 'h');
  await assert.rejects(() => enter(pot, id, 'h'),
    (e) => /already in use|custom program error/.test(String(e)));
});

test('a pot cannot be settled before it closes', async () => {
  await ensureRacers(['i']);
  const cfg = await program.account.config.fetch(config);
  const id = Number(cfg.potCount);
  const pot = await createPot(id, 10n * ONE, now() + 3600);
  await enter(pot, id, 'i');
  await postTime(pot, id, 'i', 143000);
  const treasuryAta = await tokenAccount(conn, admin, cfg.stakeMint, cfg.treasury);
  await assert.rejects(
    () => program.methods.settlePot(new anchor.BN(id))
      .accounts({ config, pot, vault: vaultPda(pot), winner: racers.i.kp.publicKey,
                  winnerToken: racers.i.ata, treasuryToken: treasuryAta,
                  stakeMint: cfg.stakeMint, tokenProgram: TOKEN_PROGRAM_ID }).rpc(),
    (e) => /NotYet|custom program error/.test(String(e)));
});

test('a signature from anyone but the oracle is refused on a pot time too', async () => {
  await ensureRacers(['j']);
  const cfg = await program.account.config.fetch(config);
  const id = Number(cfg.potCount);
  const pot = await createPot(id, 10n * ONE, now() + 3600);
  await enter(pot, id, 'j');
  await assert.rejects(() => postTime(pot, id, 'j', 140000, Keypair.generate()),
    (e) => /WrongOracleKey|custom program error/.test(String(e)));
});
