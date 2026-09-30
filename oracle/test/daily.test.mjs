/**
 * The daily standings and the split. These decide who gets paid real TAO, so the arithmetic is
 * checked against the program's integer maths rather than against a float.
 */
process.env.DATA_DIR = new URL('./tmp-daily/', import.meta.url).pathname;
/**
 * No chain. "Is this day over" is normally judged on the chain's clock, so a local node left
 * running from days ago would decide a finished day is still in progress and these assertions
 * would pass or fail depending on what happens to be listening on 8545. Pointing at a dead port
 * makes chainclock fall back to wall-clock time, which is deterministic - and is also exactly the
 * path a drive-only deployment with no chain takes.
 */
process.env.RPC_URL = 'http://127.0.0.1:1';
/** and no cluster, which is the chainless path and makes the clock wall-clock by construction */
delete process.env.CLUSTER;

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm, mkdir } from 'node:fs/promises';

const { saveRun } = await import('../store.mjs');
const { standings, attestDay, daysPlacedBy, sharesOf, dayOf, SPLIT_BPS, DAILY_BPS, PLACES } =
  await import('../daily.mjs');

/**
 * Real Solana public keys, because attestDay signs them and a signer cannot be handed a
 * placeholder. These used to be 0x1111... repeated-nibble EVM addresses, which base58 cannot
 * even decode - the kind of fixture that is fine until the day it has to be a real key.
 */
const { keypairFromSeed } = await import('../keys.mjs');
const [A, B, C, D, E, F] = [1, 2, 3, 4, 5, 6].map((n) => keypairFromSeed(n).address);
const TRACK = 'ab'.repeat(32);

/** a day that is safely in the past, so it always counts as closed */
const DAY = dayOf() - 3;
const at = (day, hour) => new Date(day * 86400000 + hour * 3600000).toISOString();

/**
 * saveRun stamps `at` with the current time and then spreads the run over it, so passing `at`
 * places the row in whichever day the test needs.
 */
async function seed(day, rows) {
  for (const [driver, timeMs, hour] of rows) {
    await saveRun({
      driver, trackId: TRACK, timeMs, lapMs: [], bestLapMs: (timeMs / 3) | 0,
      ticks: 1, respawns: 0, at: at(day, hour),
    }, new Uint8Array([1]));
  }
}

before(async () => {
  await rm(process.env.DATA_DIR, { recursive: true, force: true });
  await mkdir(process.env.DATA_DIR, { recursive: true });
});
after(async () => { await rm(process.env.DATA_DIR, { recursive: true, force: true }); });

test('ranks by fastest verified time, one place per driver', async () => {
  await seed(DAY, [
    [A, 150000, 3], [B, 143000, 5], [C, 147000, 9],
    [A, 141000, 14],                       // A improves: this is the one that counts
    [B, 199000, 20],                       // B gets slower: ignored
  ]);
  const s = await standings(DAY, { trackId: TRACK });
  assert.equal(s.entrants, 3);
  assert.deepEqual(s.rows.map((r) => r.driver), [A, B, C]);
  assert.deepEqual(s.rows.map((r) => r.timeMs), [141000, 143000, 147000]);
  assert.deepEqual(s.rows.map((r) => r.shareBps), [4000, 2500, 1500]);
});

test('only counts runs inside that UTC day', async () => {
  await seed(DAY - 1, [[F, 100000, 23]]);      // the day before, and far faster
  const s = await standings(DAY, { trackId: TRACK });
  assert.ok(!s.rows.some((r) => r.driver === F), 'a run from another day leaked in');
  const prev = await standings(DAY - 1, { trackId: TRACK });
  assert.equal(prev.rows[0].driver, F);
});

test('caps at five places even when more drivers race', async () => {
  await seed(DAY, [[D, 148000, 4], [E, 149000, 6], [F, 151000, 7]]);
  const s = await standings(DAY, { trackId: TRACK });
  assert.equal(s.entrants, 6);
  assert.equal(s.rows.length, PLACES);
  assert.deepEqual(s.rows.map((r) => r.shareBps), SPLIT_BPS);
  assert.ok(!s.rows.some((r) => r.driver === F), 'sixth place should not be paid');
});

test('a dead heat goes to whoever set it first', async () => {
  const day = DAY - 2;
  await seed(day, [[B, 145000, 18], [A, 145000, 2]]);   // same time, A set it earlier
  const s = await standings(day, { trackId: TRACK });
  assert.deepEqual(s.rows.map((r) => r.driver), [A, B]);
});

test('the split is 40/25/15/12/8 and the shares match the contract exactly', () => {
  assert.deepEqual(SPLIT_BPS, [4000, 2500, 1500, 1200, 800]);
  assert.equal(SPLIT_BPS.reduce((a, b) => a + b, 0), 10000);
  assert.equal(DAILY_BPS, 1000);

  const pool = 331_200_000_000_000_000_000n;                 // 331.2 WETH
  const got = sharesOf(pool);
  const payout = (pool * 1000n) / 10000n;
  assert.equal(payout, 33_120_000_000_000_000_000n);
  assert.deepEqual(got, SPLIT_BPS.map((bps) => (payout * BigInt(bps)) / 10000n));
  assert.equal(got.reduce((a, b) => a + b, 0n), payout, 'five full places must spend the whole payout');
});

test('an odd pool loses nothing to anyone but rounding', () => {
  const pool = 1n;                                    // 1 wei: every share rounds to zero
  assert.deepEqual(sharesOf(pool), [0n, 0n, 0n, 0n, 0n]);
  const pool2 = 123_456_789_012_345_678n;
  const payout = (pool2 * 1000n) / 10000n;
  const total = sharesOf(pool2).reduce((a, b) => a + b, 0n);
  assert.ok(total <= payout, 'shares must never exceed the payout');
  assert.ok(payout - total < 5n, 'rounding dust should be at most a few wei');
});

test('a day that is not over cannot be signed', async () => {
  // a day in the future, so this holds regardless of how far the local chain's clock has drifted
  const r = await attestDay(dayOf() + 5, { trackId: TRACK });
  assert.equal(r.ok, false);
  assert.match(r.reason, /still running/);
});

test('a day nobody raced cannot be signed', async () => {
  const r = await attestDay(DAY - 50, { trackId: TRACK });
  assert.equal(r.ok, false);
  assert.match(r.reason, /nobody set a verified time/);
});

test('a finished day is signed with winners in rank order', async () => {
  const r = await attestDay(DAY, { trackId: TRACK });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.attestation.result.day, DAY);
  assert.equal(r.attestation.result.winners.length, PLACES);
  assert.deepEqual(r.attestation.result.winners, r.rows.map((x) => x.driver));
  assert.deepEqual(r.attestation.result.timesMs, r.rows.map((x) => x.timeMs));
  // 64 raw Ed25519 bytes, base64. Was 65 bytes of hex ECDSA (r,s,v) on EVM; Ed25519 has no
  // recovery byte because the program is told the key rather than deriving it.
  const sig = Buffer.from(r.attestation.signature, 'base64');
  assert.equal(sig.length, 64);

  // and it must actually verify against the oracle's published key over the exact bytes the
  // vault will rebuild - the only check that would catch this file and daily.mjs drifting apart
  const { createPublicKey, verify } = await import('node:crypto');
  const { dayMessage } = await import('../daily.mjs');
  const { PublicKey } = await import('@solana/web3.js');
  const raw = new PublicKey(r.attestation.signer).toBytes();
  const spki = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]),
    format: 'der', type: 'spki',
  });
  const message = dayMessage({ ...r.attestation.result, deadline: BigInt(r.attestation.result.deadline) });
  assert.ok(verify(null, message, spki, sig), 'the day signature does not verify against the signer');

  // times must be ascending: the program trusts this ordering for the split
  const t = r.attestation.result.timesMs;
  for (let i = 1; i < t.length; i++) assert.ok(t[i] >= t[i - 1], 'winners are not in rank order');
});

test('a driver can find the days they placed in', async () => {
  const days = await daysPlacedBy(A, { trackId: TRACK, window: 10 });
  const forDay = days.find((d) => d.day === DAY);
  assert.ok(forDay, 'A placed on the seeded day but was not reported');
  assert.equal(forDay.place, 1);
  assert.equal(forDay.shareBps, 4000);
});
