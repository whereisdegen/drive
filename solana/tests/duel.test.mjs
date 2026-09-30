/**
 * The duel, end to end on a local validator, and the ways it must refuse.
 *
 * The point of most of these is the same as on EVM: a player controls the bytes they submit and
 * nothing else. They cannot assert a time, borrow someone else's attestation, or spend one twice.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  anchor, connection, funded, provider, idl, makeMint, tokenAccount, balance,
  runMessage, ed25519Ix, pda, leU64, ONE, oracleKeypair, ensureConfig, Keypair, PublicKey, Transaction,
  SYSVAR_INSTRUCTIONS_PUBKEY, TOKEN_PROGRAM_ID, SystemProgram,
} from './helpers.mjs';

const TRACK = Array.from(Buffer.alloc(32, 7));
const OTHER_TRACK = Array.from(Buffer.alloc(32, 9));
const DAY = 86400;
const FEE_BPS = 250;

let conn, admin, oracle, alice, bob, treasury, mint, program, config;
let aliceAta, bobAta, treasuryAta;
let nonce = 1n;

const now = () => Math.floor(Date.now() / 1000);

function makeRun({ driver, timeMs, track = TRACK, issuedAt = now() - 5, deadline = now() + DAY, n }) {
  return {
    driver: driver.publicKey ?? driver,
    trackId: track,
    timeMs,
    traceHash: Array.from(Buffer.alloc(32, Number(n ?? nonce) % 251)),
    issuedAt: new anchor.BN(issuedAt),
    deadline: new anchor.BN(deadline),
    nonce: new anchor.BN((n ?? nonce++).toString()),
  };
}
/** the message the oracle signs; BN fields have to come back to plain numbers for the buffer */
const msgOf = (r) => runMessage({
  driver: r.driver, trackId: r.trackId, timeMs: r.timeMs, traceHash: r.traceHash,
  issuedAt: r.issuedAt.toString(), deadline: r.deadline.toString(), nonce: r.nonce.toString(),
});

const duelPda = (id) => pda([Buffer.from('duel'), leU64(id)], program.programId);
const vaultPda = (duel) => pda([Buffer.from('vault'), duel.toBuffer()], program.programId);
const noncePda = (who, n) => pda([Buffer.from('nonce'), who.toBuffer(), leU64(n)], program.programId);

before(async () => {
  conn = connection();
  admin = await funded(conn, 100);
  oracle = oracleKeypair();
  alice = await funded(conn, 100);
  bob = await funded(conn, 100);
  treasury = Keypair.generate();

  program = new anchor.Program(idl('race_stakes'), provider(conn, admin));
  const setup = await ensureConfig(program, admin, conn, {
    treasury: treasury.publicKey,
    makeNewMint: () => makeMint(conn, admin),
  });
  config = setup.config;
  mint = setup.stakeMint;
  // the treasury recorded in config belongs to whoever initialised it
  const cfg = await program.account.config.fetch(config);
  treasury = { publicKey: cfg.treasury };
  aliceAta = await tokenAccount(conn, admin, mint, alice.publicKey, 10_000n * ONE);
  bobAta = await tokenAccount(conn, admin, mint, bob.publicKey, 10_000n * ONE);
  treasuryAta = await tokenAccount(conn, admin, mint, cfg.treasury);
});

/** open a duel: the ed25519 instruction goes first, ours reads it back at index 0 */
async function openDuel({ id, stake, timeMs, signer = oracle, run = null, runner = alice }) {
  const r = run ?? makeRun({ driver: runner, timeMs });
  const duel = duelPda(id);
  const ix = await program.methods
    .openDuel(new anchor.BN(id), r.nonce, r, 0, new anchor.BN(stake.toString()),
              new anchor.BN(now() + DAY), new anchor.BN(3600))
    .accounts({
      config, challenger: runner.publicKey, stakeMint: mint,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      duel, vault: vaultPda(duel), nonceMarker: noncePda(runner.publicKey, r.nonce.toString()),
      from: runner === alice ? aliceAta : bobAta, ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();
  const tx = new Transaction().add(ed25519Ix(signer, msgOf(r))).add(ix);
  return provider(conn, runner).sendAndConfirm(tx, [runner]);
}

test('a duel pays the opponent when they are faster', async () => {
  const id = 0, stake = 100n * ONE;
  await openDuel({ id, stake, timeMs: 143680 });

  const duel = duelPda(id);
  await program.methods.acceptDuel(new anchor.BN(id))
    .accounts({ config, duel, vault: vaultPda(duel), opponent: bob.publicKey,
                stakeMint: mint, tokenProgram: TOKEN_PROGRAM_ID, from: bobAta })
    .signers([bob]).rpc();

  const before = await balance(conn, bobAta);
  const r = makeRun({ driver: bob, timeMs: 141000 });
  const ix = await program.methods
    .submitDuel(new anchor.BN(id), r.nonce, r, 0)
    .accounts({
      config, opponent: bob.publicKey, stakeMint: mint, tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, duel, vault: vaultPda(duel),
      nonceMarker: noncePda(bob.publicKey, r.nonce.toString()),
      opponentToken: bobAta, challengerToken: aliceAta, treasuryToken: treasuryAta,
      ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();
  await provider(conn, bob).sendAndConfirm(new Transaction().add(ed25519Ix(oracle, msgOf(r))).add(ix), [bob]);

  const pot = stake * 2n;
  const fee = (pot * BigInt(FEE_BPS)) / 10000n;
  assert.equal(await balance(conn, bobAta), before + pot - fee);
  assert.equal(await balance(conn, treasuryAta), fee);

  const d = await program.account.duel.fetch(duel);
  assert.equal(Object.keys(d.status)[0], 'settled');
  assert.equal(d.resultMs, 141000);
});

test('a signature from anyone but the oracle is refused', async () => {
  const impostor = Keypair.generate();
  await assert.rejects(
    () => openDuel({ id: 1, stake: 10n * ONE, timeMs: 143680, signer: impostor }),
    (e) => /WrongOracleKey|custom program error/.test(String(e)),
  );
});

test('an attestation cannot be presented by a different wallet', async () => {
  // signed for alice, submitted by bob
  const r = makeRun({ driver: alice, timeMs: 143680 });
  await assert.rejects(
    () => openDuel({ id: 1, stake: 10n * ONE, timeMs: 143680, run: r, runner: bob }),
    (e) => /WrongDriver|custom program error/.test(String(e)),
  );
});

test('a tampered message is refused', async () => {
  const r = makeRun({ driver: alice, timeMs: 143680 });
  const signed = msgOf(r);
  const faster = { ...r, timeMs: 100000 };          // sign the slow time, submit the fast one
  const duel = duelPda(1);
  const ix = await program.methods
    .openDuel(new anchor.BN(1), r.nonce, faster, 0, new anchor.BN((10n * ONE).toString()),
              new anchor.BN(now() + DAY), new anchor.BN(3600))
    .accounts({
      config, challenger: alice.publicKey, stakeMint: mint,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      duel, vault: vaultPda(duel), nonceMarker: noncePda(alice.publicKey, r.nonce.toString()),
      from: aliceAta, ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();
  await assert.rejects(
    () => provider(conn, alice).sendAndConfirm(new Transaction().add(ed25519Ix(oracle, signed)).add(ix), [alice]),
    (e) => /MessageMismatch|custom program error/.test(String(e)),
  );
});

test('an expired attestation is refused', async () => {
  // well in the past: the validator's clock runs a couple of seconds behind wall clock,
  // so `now() - 1` is not reliably expired from the chain's point of view
  const r = makeRun({ driver: alice, timeMs: 143680, deadline: now() - 3600 });
  await assert.rejects(
    () => openDuel({ id: 1, stake: 10n * ONE, timeMs: 143680, run: r }),
    (e) => /AttestationExpired|custom program error/.test(String(e)),
  );
});

test('a nonce cannot be spent twice', async () => {
  const shared = 999n;
  await openDuel({ id: 1, stake: 10n * ONE, timeMs: 143680, run: makeRun({ driver: alice, timeMs: 143680, n: shared }) });
  // same nonce again: the marker PDA already exists, so this cannot even be constructed
  await assert.rejects(
    () => openDuel({ id: 2, stake: 10n * ONE, timeMs: 143680, run: makeRun({ driver: alice, timeMs: 143680, n: shared }) }),
    (e) => /already in use|custom program error/.test(String(e)),
  );
});

test('a time set on another track is refused', async () => {
  const r = makeRun({ driver: alice, timeMs: 143680, track: OTHER_TRACK });
  const id = 2;
  // opening with it is fine (the duel adopts that track); submitting against a different one is not
  await openDuel({ id, stake: 10n * ONE, timeMs: 143680, run: r });
  const duel = duelPda(id);
  await program.methods.acceptDuel(new anchor.BN(id))
    .accounts({ config, duel, vault: vaultPda(duel), opponent: bob.publicKey,
                stakeMint: mint, tokenProgram: TOKEN_PROGRAM_ID, from: bobAta })
    .signers([bob]).rpc();

  const wrong = makeRun({ driver: bob, timeMs: 100000, track: TRACK });
  const ix = await program.methods
    .submitDuel(new anchor.BN(id), wrong.nonce, wrong, 0)
    .accounts({
      config, opponent: bob.publicKey, stakeMint: mint, tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId, duel, vault: vaultPda(duel),
      nonceMarker: noncePda(bob.publicKey, wrong.nonce.toString()),
      opponentToken: bobAta, challengerToken: aliceAta, treasuryToken: treasuryAta,
      ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();
  await assert.rejects(
    () => provider(conn, bob).sendAndConfirm(new Transaction().add(ed25519Ix(oracle, msgOf(wrong))).add(ix), [bob]),
    (e) => /WrongTrack|custom program error/.test(String(e)),
  );
});
