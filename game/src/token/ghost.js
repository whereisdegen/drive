/**
 * DRIVE  src/token/ghost.js  (owner: token)
 *
 * The car you are chasing.
 *
 * A ghost here is not a recorded path being played back through an interpolator. It is the
 * rival's actual INPUTS, fed tick for tick through the same physics your own kart is running,
 * in the same fixed-step loop. So the ghost brakes where they braked and runs wide where they
 * ran wide, and when it crosses the line it does so at exactly the time the oracle signed. The
 * board and the ghost cannot disagree, because they come from the same bytes.
 */
import { stepOnce, normalizeBody, POLE_SLOT } from './simcore.js?v=r6-20260906191941';
import { traceFrames, decodeTrace } from './trace.js?v=r6-20260906191941';

export class Ghost {
  /**
   * @param {object} o
   * @param {*} o.THREE
   * @param {object} o.track    the shared track from the game's boot (world, spline, slots)
   * @param {object} o.trace    a decoded trace
   * @param {*} [o.view]        a KartView to drive; omitted for a headless ghost
   * @param {number} [o.laps]
   */
  constructor({ THREE, track, trace, view = null, laps = 3, KartBody, Race }) {
    this.track = track;
    this.view = view;
    this.trace = trace;
    this.body = new KartBody({ world: track.world, spline: track.spline, id: 999, events: null });
    this.race = new Race({
      events: null, bodies: [this.body], spline: track.spline, laps,
      names: { 999: 'Ghost' }, playerId: 999, grid: [track.slots[POLE_SLOT]],
      startProgress: track.startProgress, checkpoints: track.checkpoints, holdAfterPlayer: 0,
    });
    this.frames = null;
    this.done = false;
  }

  reset() {
    this.race.reset();
    normalizeBody(this.body);
    this.frames = traceFrames(this.trace)[Symbol.iterator]();
    this.done = false;
    if (this.view) this.view.object.visible = true;
  }

  start() { this.race.start(); }

  /** one fixed tick, in lockstep with the player's */
  step() {
    if (this.done || !this.frames) return;
    const next = this.frames.next();
    if (next.done) { this.done = true; return; }
    stepOnce(this.body, this.race, next.value, null);
  }

  /** seconds the ghost is ahead (negative) or behind (positive) the player on the same lap */
  gapTo(playerRace, playerBody) {
    const a = playerBody.lap - 1 + rel(playerRace, playerBody.progress);
    const b = this.body.lap - 1 + rel(this.race, this.body.progress);
    return a - b;
  }

  updateView(dt) {
    if (this.view) this.view.update(dt, this.body);
  }

  hide() { if (this.view) this.view.object.visible = false; }
}

const wrap01 = (p) => p - Math.floor(p);
const rel = (race, progress) => wrap01(progress - race.startProgress);

/** build a Ghost from the bytes the oracle handed back */
export function ghostFromBytes(bytes, deps) {
  return new Ghost({ ...deps, trace: decodeTrace(bytes) });
}
