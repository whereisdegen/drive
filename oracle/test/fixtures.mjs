/**
 * Shared test fixtures: a reproducible driver for the time trial.
 *
 * The game's own ai/racer.js does the driving (it contains no Math.random, so it is repeatable),
 * and `human` adds the two things that separate a person from a script - a reaction delay that
 * holds the previous input for a few ticks, and a little noise on the stick. Both matter: the
 * bot path is the control, and the human path is what the accept-side tests need.
 */
import * as THREE from 'three';

const G = '../../game/src';
export const { createTimeTrial, buildSimTrack, clamp8, stepOnce, normalizeBody, digestOf, msOf, TICK, TICK_HZ, gridSlots, stakeWorld } = await import(G + '/token/simcore.js');
export const { TraceRecorder, encodeTrace, decodeTrace, traceFrames, toBase64 } = await import(G + '/token/trace.js');
const { AIRacer, PERSONALITIES } = await import(G + '/ai/racer.js');

export { THREE };

let _track = null;
export async function track() {
  if (!_track) _track = await buildSimTrack(THREE);
  return _track;
}

/** deterministic PRNG so a "human" fixture is the same run every time the suite runs */
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function driveWithAI({ laps = 3, personality = 0, human = false, seed = 12345 } = {}) {
  const t = await track();
  const sim = await createTimeTrial({ THREE, track: t, laps });
  const ai = new AIRacer({ id: 1, name: 'Bot', body: sim.body, spline: t.spline, personality: PERSONALITIES[personality] });
  const rec = new TraceRecorder({ laps, tickHz: sim.TICK_HZ });
  sim.reset(); sim.start();
  const ctx = { racers: [sim.body], player: sim.body, items: null, time: 0, countdown: null };
  const rnd = mulberry32(seed);
  let guard = 0, hold = 0, held = { throttle: 0, steer: 0, hop: false };
  while (sim.race.state !== 'finished' && guard++ < 200000) {
    ctx.time += TICK; ctx.countdown = sim.race.countdown;
    ai.update(TICK, ctx);
    let input = { throttle: clamp8(sim.body.input.throttle * 127), steer: clamp8(sim.body.input.steer * 127), hop: !!sim.body.input.hop };
    if (human) {
      if (hold > 0) { hold--; input = held; }
      else {
        input.steer = clamp8(input.steer + (rnd() * 2 - 1) * 10);
        held = input;
        hold = 2 + Math.floor(rnd() * 5);
      }
    }
    sim.step(input);
    rec.tick(input, sim.digest());
  }
  const result = sim.result();
  return { sim, trace: rec.finish(result), result, bytes: encodeTrace(rec.finish(result)) };
}
