/**
 * DRIVE  oracle/test/attest.test.mjs
 *
 * The oracle and the programs must agree on two things exactly: the bytes of a message, and the
 * 64 bytes of a signature over it. Neither is a thing to take on trust, because neither fails
 * gracefully - a message one byte different, or a signature made by a subtly different
 * implementation, is rejected on chain 100% of the time with the same opaque error, and no test
 * that stays inside this directory would notice.
 *
 * So both are checked against something OUTSIDE this directory:
 *
 *   - the message, against solana/tests/helpers.mjs, which is the builder that the 24 tests in
 *     solana/tests exercise against the real deployed programs. If the oracle agrees with those
 *     helpers, it agrees with the Rust, transitively and by construction.
 *   - the signature, against @solana/web3.js's own Ed25519Program instruction encoding, which is
 *     what actually gets submitted. The oracle signs with node's built-in crypto and no signing
 *     library at all; this is what earns that.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, Ed25519Program } from '@solana/web3.js';

import { runMessage, RUN_MESSAGE_LEN, RUN_DOMAIN, trackIdOf, traceHashOf, serialise } from '../attest.mjs';
import { dayMessage, DAY_DOMAIN, sharesOf, DAILY_BPS, SPLIT_BPS } from '../daily.mjs';
import { keypairFromSeed, signMessage, isAddress, sameAddress, randomNonce } from '../keys.mjs';

// the builders the passing on-chain suite uses
import { runMessage as refRunMessage, dayMessage as refDayMessage } from '../../solana/tests/helpers.mjs';

const anyRun = () => ({
  driver: Keypair.fromSeed(Buffer.alloc(32, 7)).publicKey.toBase58(),
  trackId: trackIdOf('sorrel-cove', '0x7d338e99'),
  timeMs: 93_214,
  traceHash: traceHashOf(Buffer.from([1, 2, 3, 4, 5])),
  issuedAt: 1_790_000_000n,
  deadline: 1_790_001_800n,
  nonce: 0xdead_beef_cafe_1234n,
});

test('the run message is byte-identical to the builder the on-chain tests use', () => {
  const run = anyRun();
  const mine = runMessage(run);
  const theirs = refRunMessage({
    driver: new PublicKey(run.driver),
    trackId: Buffer.from(run.trackId, 'hex'),
    timeMs: run.timeMs,
    traceHash: Buffer.from(run.traceHash, 'hex'),
    issuedAt: run.issuedAt,
    deadline: run.deadline,
    nonce: run.nonce,
  });
  assert.equal(mine.length, RUN_MESSAGE_LEN);
  assert.equal(mine.length, 136);
  assert.ok(mine.equals(theirs), `oracle built ${mine.toString('hex')}\nhelpers built ${theirs.toString('hex')}`);
  assert.ok(mine.subarray(0, 12).equals(RUN_DOMAIN));
});

test('the day message is byte-identical, for every winner count the vault accepts', () => {
  const winners = [1, 2, 3, 4, 5].map((b) => Keypair.fromSeed(Buffer.alloc(32, b)).publicKey);
  const timesMs = [90_100, 91_200, 92_300, 93_400, 94_500];
  // one winner through five: the count prefix is the only variable-length thing in either
  // format, so it is the only place a length could be read wrong
  for (let n = 1; n <= 5; n++) {
    const arg = { day: 20_726, winners: winners.slice(0, n), timesMs: timesMs.slice(0, n), deadline: 1_790_001_800 };
    const mine = dayMessage({ ...arg, winners: arg.winners.map((w) => w.toBase58()) });
    const theirs = refDayMessage(arg);
    assert.ok(mine.equals(theirs), `n=${n}: ${mine.toString('hex')} vs ${theirs.toString('hex')}`);
    assert.equal(mine.length, 12 + 8 + 1 + n * 36 + 8);
    assert.ok(mine.subarray(0, 12).equals(DAY_DOMAIN));
  }
});

test("node's built-in crypto signs exactly what the Solana tooling would sign", () => {
  const kp = keypairFromSeed(42);
  const secret = Keypair.fromSeed(Buffer.alloc(32, 42)).secretKey;
  const message = runMessage(anyRun());

  const mine = signMessage(kp, message);
  assert.equal(mine.length, 64);

  // the instruction as web3.js builds it from the private key, versus the same instruction built
  // around the oracle's own signature. Identical data means the native program cannot tell them
  // apart, which is the only claim that matters.
  const fromPrivateKey = Ed25519Program.createInstructionWithPrivateKey({ privateKey: secret, message });
  const fromMySignature = Ed25519Program.createInstructionWithPublicKey({
    publicKey: kp.publicKey.toBytes(), message, signature: mine,
  });
  assert.ok(Buffer.from(fromPrivateKey.data).equals(Buffer.from(fromMySignature.data)));
});

test('the development signer is the one the on-chain tests trust', () => {
  // solana/tests/helpers.mjs uses seed 42, and both programs are initialised with its public key.
  // If these drift apart, every demo silently produces signatures the programs reject.
  assert.equal(keypairFromSeed(42).address, Keypair.fromSeed(Buffer.alloc(32, 42)).publicKey.toBase58());
});

test('a one-byte change anywhere in a run changes the message', () => {
  const base = runMessage(anyRun());
  const tweaks = {
    timeMs: 93_215,
    issuedAt: 1_790_000_001n,
    deadline: 1_790_001_801n,
    nonce: 0xdead_beef_cafe_1235n,
    driver: Keypair.fromSeed(Buffer.alloc(32, 8)).publicKey.toBase58(),
    trackId: trackIdOf('sorrel-cove', '0x7d338e9a'),
    traceHash: traceHashOf(Buffer.from([1, 2, 3, 4, 6])),
  };
  for (const [field, value] of Object.entries(tweaks)) {
    const changed = runMessage({ ...anyRun(), [field]: value });
    assert.ok(!changed.equals(base), `changing ${field} did not change the signed message`);
  }
});

test('a malformed hash is refused rather than silently padded', () => {
  // a 31-byte hash left-padded to 32 would sign a claim about a DIFFERENT trace
  assert.throws(() => runMessage({ ...anyRun(), traceHash: 'ab'.repeat(31) }), /32 bytes/);
  assert.throws(() => runMessage({ ...anyRun(), trackId: 'ab'.repeat(33) }), /32 bytes/);
});

test('addresses are validated as keys, not as base58-shaped strings', () => {
  assert.ok(isAddress(keypairFromSeed(1).address));
  assert.ok(!isAddress('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'));   // an EVM address
  assert.ok(!isAddress('not-base58-0OIl'));
  assert.ok(!isAddress(''));
  assert.ok(!isAddress(null));
  // base58 of the right length but 33 bytes, so not a key
  assert.ok(!isAddress('1'.repeat(44)) || new PublicKey('1'.repeat(44)).toBytes().length === 32);
});

test('addresses compare exactly, because base58 is case sensitive', () => {
  const a = keypairFromSeed(9).address;
  assert.ok(sameAddress(a, a));
  // the EVM habit: lowercase both sides. On Solana that is a different key, or no key at all.
  assert.ok(!sameAddress(a, a.toLowerCase()), 'a lowercased Solana address must not match the original');
});

test('nonces are u64 and fit the field they are written into', () => {
  for (let i = 0; i < 200; i++) {
    const n = randomNonce();
    assert.ok(n >= 0n && n <= 0xffff_ffff_ffff_ffffn);
    runMessage({ ...anyRun(), nonce: n });   // throws if it does not fit
  }
});

test('serialise survives JSON, because bigints do not', () => {
  const run = anyRun();
  const round = JSON.parse(JSON.stringify(serialise(run)));
  assert.equal(round.issuedAt, '1790000000');
  assert.equal(round.nonce, String(0xdead_beef_cafe_1234n));
  // and rebuilding from the serialised form gives the same signed bytes back
  assert.ok(runMessage({ ...round, timeMs: Number(round.timeMs) }).equals(runMessage(run)));
});

test('the split still matches the vault: 10% of the pool, 40/25/15/12/8 of that', () => {
  assert.equal(DAILY_BPS, 1000);
  assert.deepEqual(SPLIT_BPS, [4000, 2500, 1500, 1200, 800]);
  // 1000 TAO at 9 decimals
  const pool = 1000n * 10n ** 9n;
  const shares = sharesOf(pool);
  assert.deepEqual(shares.map((s) => s / 10n ** 9n), [40n, 25n, 15n, 12n, 8n]);
  // the whole payout is 10% of the pool, and the five shares account for all of it
  assert.equal(shares.reduce((a, b) => a + b, 0n), pool / 10n);
});
