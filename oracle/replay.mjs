/**
 * DRIVE  oracle/replay.mjs
 *
 * The verifier. Takes the bytes a player submitted and re-drives them through the SAME
 * simcore.js the browser ran, then reports the time it actually observed. Nothing the client
 * said about its own lap time is trusted or used; `trace.client` is kept only so the API can
 * tell the player "your machine said 2:14.38, we measured 2:14.38".
 *
 * A run has to survive four gates before the oracle will sign it:
 *   1 STRUCTURE   the bytes decode, the version and tick rate are ones we accept, the trace is
 *                 not longer than MAX_TICKS.
 *   2 COMPLETION  replaying it actually finishes the configured number of laps. A trace that
 *                 drives into the sea for ten minutes simply never finishes and is rejected.
 *   3 AGREEMENT   the client's periodic state digests match the oracle's at the same ticks.
 *                 A mismatch means the two machines' physics drifted apart (see
 *                 docs/DETERMINISM.md); the run is rejected rather than settled at a time the
 *                 player never actually drove.
 *   4 PLAUSIBILITY  cheap anti-tool-assist heuristics (see checkPlausible).
 *
 * Gate 4 is explicitly NOT a solved problem, and the rest of this system does not pretend it
 * is. Replay verification makes it impossible to CLAIM a time you did not drive; it does not
 * make it impossible to have a script drive for you. See docs/THREAT-MODEL.md.
 */
import * as THREE from 'three';

const G = '../game/src';
const { createTimeTrial, buildSimTrack, TICK_HZ } = await import(G + '/token/simcore.js');
const { decodeTrace, traceFrames, DIGEST_EVERY, MAX_TICKS } = await import(G + '/token/trace.js');

export const LAPS = 3;
export const TRACK_ID = 'sorrel-cove';

/** the track is built once per process and reused by every verification */
let _track = null;
export async function track() {
  if (!_track) _track = await buildSimTrack(THREE);
  return _track;
}

/**
 * Identifies the circuit a time was set on, so a run cannot be replayed against different
 * geometry and an old time cannot survive a change to the track.
 *
 * It covers BOTH halves of what a kart can hit: the spline (where the road runs) and every
 * collider in the world (where the walls, kerbs, tyre stacks and harbour edge are). Hashing
 * only the spline would let the town be rearranged under a leaderboard without invalidating a
 * single posted time - and the town is most of what makes a lap slow.
 */
export async function trackFingerprint() {
  const t = await track();
  const { WAYPOINTS } = await import(G + '/track/spline.js');
  let h = 0x811c9dc5 >>> 0;
  const mix = (n) => { h ^= n >>> 0; h = Math.imul(h, 0x01000193) >>> 0; };
  for (const w of WAYPOINTS) {
    mix(Math.round(w.x * 256)); mix(Math.round(w.z * 256));
    mix(Math.round((w.y || 0) * 256)); mix(Math.round((w.width || 0) * 256));
  }
  mix(Math.round(t.spline.length * 256));
  mix(t.world.list.length);
  for (const c of t.world.list) {
    mix(Math.round(c.minX * 100)); mix(Math.round(c.maxX * 100));
    mix(Math.round(c.minZ * 100)); mix(Math.round(c.maxZ * 100));
    mix(Math.round((c.lo ?? 0) * 100)); mix(Math.round((c.hi ?? 0) * 100));
  }
  return '0x' + (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * The floor no human or script can pass on this circuit, used as a sanity bound on the replay
 * itself: 3 laps of 1061 m at the kart's absolute vmax of 24 m/s with no corners at all.
 * Anything faster means the simulation, not the driver, is wrong.
 */
export const ABSOLUTE_FLOOR_MS = Math.floor((1061 * LAPS / 24) * 1000);

export async function verifyRun({ bytes, digests = [], client = {}, laps = LAPS }) {
  const reasons = [];
  let trace;
  try {
    trace = decodeTrace(bytes, { digests, client });
  } catch (e) {
    return fail('malformed', [e.message]);
  }
  if (trace.tickHz !== TICK_HZ) return fail('bad-tickrate', [`tickHz ${trace.tickHz}, expected ${TICK_HZ}`]);
  if (trace.laps !== laps) return fail('bad-laps', [`laps ${trace.laps}, expected ${laps}`]);
  if (trace.ticks > MAX_TICKS) return fail('too-long', [`${trace.ticks} ticks`]);
  if (trace.ticks < 1) return fail('empty', []);

  const t = await track();
  const sim = await createTimeTrial({ THREE, track: t, laps });
  sim.reset(); sim.start();

  // gate 3 bookkeeping: the client's digests indexed by tick
  const want = new Map(digests.map(([tick, h]) => [tick | 0, h >>> 0]));
  let compared = 0, mismatched = 0, firstBadTick = null;

  // the inputs as actually stepped, plus the tick each lap ended on, so the plausibility pass
  // can compare one lap's driving against another's
  const frames = [];
  const lapTicks = [];
  let lap = sim.body.lap;

  let n = 0;
  for (const frame of traceFrames(trace)) {
    sim.step(frame);
    n++;
    frames.push(frame);
    if (sim.body.lap !== lap) { lap = sim.body.lap; lapTicks.push(n); }
    if (n % DIGEST_EVERY === 0 && want.has(n)) {
      compared++;
      if (want.get(n) !== sim.digest()) {
        mismatched++;
        if (firstBadTick === null) firstBadTick = n;
      }
    }
    if (sim.race.state === 'finished') { lapTicks.push(n); break; }
  }

  const result = sim.result();

  // gate 3 is judged BEFORE completion, because divergence is the more informative answer: a run
  // that drifted apart from the client's physics usually fails by driving into a wall the client
  // never hit and then never finishing, and reporting that as "did not finish" would send the
  // player off to look for a mistake in their driving instead of a mismatch between machines.
  const diverged = mismatched > 0;
  if (diverged) reasons.push(`state digest mismatch from tick ${firstBadTick} (${mismatched}/${compared} sampled)`);
  if (compared === 0 && digests.length > 0) reasons.push('no digests lined up with the replay');
  if (diverged) {
    return {
      ok: false, status: 'diverged', totalMs: result.finished ? result.totalMs : null, lapMs: result.lapMs,
      bestLapMs: result.bestLapMs, laps, ticks: trace.ticks, respawns: result.respawns, distance: result.distance,
      clientTotalMs: client && Number.isFinite(client.totalMs) ? client.totalMs : null,
      digestsCompared: compared, digestsMismatched: mismatched, reasons,
    };
  }

  if (!result.finished) return fail('did-not-finish', [`replay ran ${n} ticks without completing ${laps} laps`], compared);
  if (result.totalMs < ABSOLUTE_FLOOR_MS) return fail('impossible', [`${result.totalMs} ms is below the ${ABSOLUTE_FLOOR_MS} ms physical floor`], compared);

  const plausible = checkPlausible(trace, result, frames, lapTicks);
  reasons.push(...plausible.reasons);

  const ok = !diverged && plausible.ok;
  return {
    ok,
    status: ok ? 'verified' : (diverged ? 'diverged' : 'implausible'),
    totalMs: result.totalMs,
    lapMs: result.lapMs,
    bestLapMs: result.bestLapMs,
    laps,
    ticks: trace.ticks,
    respawns: result.respawns,
    distance: result.distance,
    clientTotalMs: client && Number.isFinite(client.totalMs) ? client.totalMs : null,
    digestsCompared: compared,
    digestsMismatched: mismatched,
    reasons,
  };

  function fail(status, rs, comparedSoFar = 0) {
    return { ok: false, status, totalMs: null, lapMs: [], bestLapMs: null, laps, ticks: trace ? trace.ticks : 0,
             respawns: 0, distance: 0, clientTotalMs: client && Number.isFinite(client.totalMs) ? client.totalMs : null,
             digestsCompared: comparedSoFar, digestsMismatched: 0, reasons: rs.concat(reasons) };
  }
}

/**
 * Cheap tool-assist heuristics. These catch a naive bot, not a careful one, and they are tuned
 * to never fire on a human: every threshold below is far outside what a person produces.
 */
export function checkPlausible(trace, result, frames = [], lapTicks = []) {
  const reasons = [];
  const runs = trace.runs;
  const ticks = trace.ticks || 1;

  // a) input changes per second. A human on a keyboard changes state a few times a second; on a
  //    touch stick, analog steer can change most ticks, so the bar is the tick rate itself.
  const changesPerSec = (runs.length / ticks) * TICK_HZ;
  if (changesPerSec > TICK_HZ * 0.98) reasons.push(`input changed on ${(changesPerSec / TICK_HZ * 100).toFixed(1)}% of ticks`);

  // b) single-tick steer reversals: full-lock left to full-lock right inside 10 ms, repeatedly.
  //    A hand cannot do this; a badly written bot does it constantly.
  let flips = 0;
  for (let i = 1; i < runs.length; i++) {
    const a = runs[i - 1], b = runs[i];
    if (a[0] <= 2 && b[0] <= 2 && Math.abs(a[2] - b[2]) > 200) flips++;
  }
  if (flips > 40) reasons.push(`${flips} instantaneous full-lock steer reversals`);

  // c) one lap's inputs replayed verbatim as another's. This is the unambiguous tell: matching
  //    LAP TIMES prove nothing (at 100 Hz every time is a multiple of 10 ms, so two honest laps
  //    landing in the same bucket is ordinary), but two laps whose several-thousand-tick input
  //    sequences are byte-identical did not come from a pair of hands.
  for (let i = 1; i < lapTicks.length; i++) {
    for (let j = i + 1; j < lapTicks.length; j++) {
      if (sameInputs(frames, lapTicks[i - 1], lapTicks[i], lapTicks[j - 1], lapTicks[j])) {
        reasons.push(`lap ${j + 1} replays lap ${i + 1}'s inputs tick for tick`);
        i = lapTicks.length;
        break;
      }
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/** true when [a0,a1) and [b0,b1) are the same length and hold identical inputs throughout */
function sameInputs(frames, a0, a1, b0, b1) {
  const len = a1 - a0;
  if (len < 200 || len !== b1 - b0) return false;   // too short to be meaningful
  for (let k = 0; k < len; k++) {
    const x = frames[a0 + k], y = frames[b0 + k];
    if (!x || !y) return false;
    if (x.throttle !== y.throttle || x.steer !== y.steer || !!x.hop !== !!y.hop) return false;
  }
  return true;
}
