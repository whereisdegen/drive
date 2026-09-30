/**
 * What the oracle accepts and what it refuses.
 *
 * The point of every rejection case here is the same: a player controls the BYTES they send and
 * nothing else. They cannot assert a time, edit a run, or borrow someone else's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driveWithAI, encodeTrace } from './fixtures.mjs';
import { verifyRun, checkPlausible, trackFingerprint, ABSOLUTE_FLOOR_MS } from '../replay.mjs';

const honest = await driveWithAI({ laps: 3, human: true, seed: 12345 });
const bot = await driveWithAI({ laps: 3, human: false, seed: 12345 });

test('an honest run is verified, and its time is the oracle\'s own measurement', async () => {
  const v = await verifyRun({ bytes: honest.bytes, digests: honest.trace.digests, client: honest.result });
  assert.equal(v.ok, true, v.reasons.join('; '));
  assert.equal(v.status, 'verified');
  assert.equal(v.totalMs, honest.result.totalMs);
  assert.equal(v.digestsMismatched, 0);
  assert.ok(v.digestsCompared > 40, 'expected the digests to actually be compared');
});

test('a claimed time is ignored entirely', async () => {
  const v = await verifyRun({ bytes: honest.bytes, digests: honest.trace.digests, client: { totalMs: 1, lapMs: [0, 0, 1] } });
  assert.equal(v.ok, true);
  assert.equal(v.totalMs, honest.result.totalMs, 'the oracle must measure, not read');
  assert.equal(v.clientTotalMs, 1, 'the claim is reported back, not believed');
});

test('a trace that never finishes is rejected', async () => {
  const short = encodeTrace({ ...honest.trace, runs: honest.trace.runs.slice(0, 400) });
  const v = await verifyRun({ bytes: short, digests: [], client: {} });
  assert.equal(v.ok, false);
  assert.equal(v.status, 'did-not-finish');
});

test('one edited input is caught by the state digests', async () => {
  const tampered = { ...honest.trace, runs: honest.trace.runs.map((r, i) => (i === 1200 ? [r[0], r[1], -r[2], r[3]] : r)) };
  const v = await verifyRun({ bytes: encodeTrace(tampered), digests: honest.trace.digests, client: honest.result });
  assert.equal(v.ok, false);
  assert.equal(v.status, 'diverged');
  assert.ok(v.digestsMismatched > 0);
});

test('forged digests are caught', async () => {
  const v = await verifyRun({ bytes: honest.bytes, digests: honest.trace.digests.map(([t]) => [t, 123456]), client: honest.result });
  assert.equal(v.ok, false);
  assert.equal(v.status, 'diverged');
});

test('malformed input is refused before any simulation runs', async () => {
  for (const [label, args] of [
    ['garbage', { bytes: new Uint8Array([1,2,3,4,5,6,7,8,9,10,11,12]), digests: [], client: {} }],
    ['empty', { bytes: encodeTrace({ ...honest.trace, runs: [] }), digests: [], client: {} }],
    ['wrong laps', { bytes: encodeTrace({ ...honest.trace, laps: 1 }), digests: [], client: {} }],
    ['wrong tick rate', { bytes: encodeTrace({ ...honest.trace, tickHz: 60 }), digests: [], client: {} }],
  ]) {
    const v = await verifyRun(args);
    assert.equal(v.ok, false, label + ' was accepted');
    assert.equal(v.totalMs, null, label + ' produced a time');
  }
});

test('a lap replayed verbatim as another lap is caught', () => {
  const mk = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const lap1 = mk(4900, (i) => ({ throttle: 127, steer: ((i * 13) % 41) - 20, hop: false }));
  const lapA = mk(4700, (i) => ({ throttle: 127, steer: ((i * 7) % 61) - 30, hop: i % 97 === 0 }));
  const runs = Array.from({ length: 3000 }, (_, i) => [5, 127, (i % 41) - 20, 0]);
  const lapTicks = [4900, 9600, 14300];
  const res = { lapMs: [49000, 47000, 47000] };

  const spliced = checkPlausible({ runs, ticks: 14300 }, res, [...lap1, ...lapA, ...lapA], lapTicks);
  assert.equal(spliced.ok, false);
  assert.match(spliced.reasons.join(' '), /replays lap/);

  // one tick different is enough to be a real, separate lap
  const lapB = lapA.map((f, i) => (i === 2500 ? { ...f, steer: f.steer + 1 } : f));
  const ctrl = checkPlausible({ runs, ticks: 14300 }, res, [...lap1, ...lapA, ...lapB], lapTicks);
  assert.equal(ctrl.ok, true, ctrl.reasons.join('; '));
});

test('matching lap times alone are never treated as cheating', () => {
  // at 100 Hz every lap time is a multiple of 10 ms, so two honest laps landing on the same
  // value is ordinary. This is the false positive that would reject real players.
  const frames = Array.from({ length: 14300 }, (_, i) => ({ throttle: 127, steer: (i * 7) % 31 - 15, hop: false }));
  const runs = Array.from({ length: 3000 }, (_, i) => [5, 127, (i % 41) - 20, 0]);
  const res = { lapMs: [49000, 47120, 47120] };
  const r = checkPlausible({ runs, ticks: 14300 }, res, frames, [4900, 9600, 14300]);
  assert.equal(r.ok, true, r.reasons.join('; '));
});

test('the physical floor is below any real lap but above nonsense', async () => {
  assert.ok(ABSOLUTE_FLOOR_MS < honest.result.totalMs, 'floor must not reject a real run');
  assert.ok(ABSOLUTE_FLOOR_MS > 100000, 'floor looks implausibly low');
});

test('the track fingerprint is stable within a process', async () => {
  assert.equal(await trackFingerprint(), await trackFingerprint());
  assert.match(await trackFingerprint(), /^0x[0-9a-f]{8}$/);
});
