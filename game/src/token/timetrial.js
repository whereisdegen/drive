/**
 * DRIVE  src/token/timetrial.js  (owner: token)
 *
 * The staked run, on the player's machine.
 *
 * A normal DRIVE race is eight karts, items, and a frame-rate-dependent dt - lovely to play,
 * impossible to verify. A staked run is the same kart on the same circuit with all of that
 * removed: solo, no items, and a FIXED 100 Hz step driven by an accumulator, so the run can be
 * re-driven by the oracle and produce the same clock to the millisecond.
 *
 * The rendering is untouched. main.js keeps drawing at whatever rate the display runs at; this
 * module only takes over what the simulation does between frames, and records what the driver
 * asked for on each of those ticks.
 *
 *   const trial = await createTrial({ ... });
 *   trial.begin({ ghostBytes });       // countdown starts
 *   trial.advance(realDt);             // once a frame, from main.js
 *   trial.onFinish = (trace, result) => ...;
 */
import { TICK, TICK_HZ, stepOnce, normalizeBody, POLE_SLOT, clamp8, msOf, digestOf } from './simcore.js?v=r6-20260906191941';
import { TraceRecorder, decodeTrace } from './trace.js?v=r6-20260906191941';
import { Ghost } from './ghost.js?v=r6-20260906191941';

/** a frame that took longer than this many ticks is not chased; the sim just runs slower than
    the wall clock rather than spiralling. The trace stays valid either way. */
const MAX_STEPS_PER_FRAME = 12;

export async function createTrial({ THREE, track, playerBody, playerView, ghostView, input, touch, tier, laps = 3, KartBody, Race, Player }) {
  const race = new Race({
    events: null, bodies: [playerBody], spline: track.spline, laps,
    names: { [playerBody.id]: 'You' }, playerId: playerBody.id, grid: [track.slots[POLE_SLOT]],
    startProgress: track.startProgress, checkpoints: track.checkpoints, holdAfterPlayer: 0,
  });

  // a private Player so the trial reads the sticks exactly as the race does, but emits no
  // item events into the game's bus
  const reader = new Player({ body: playerBody, input, touch, events: null, tier });

  let active = false;
  let acc = 0;
  let recorder = null;
  let ghost = null;
  let finished = false;
  // the player's KartBody was built against the game's collision world; a staked run has to be
  // driven in the canonical one, so the body is lent to it and handed back afterwards
  let gameWorld = null;

  const api = {
    race, laps, TICK, TICK_HZ,
    get active() { return active; },
    get ghost() { return ghost; },
    get recorder() { return recorder; },
    onFinish: null,
    onTick: null,

    /**
     * @param {object} o
     * @param {Uint8Array} [o.ghostBytes]  a rival's trace to race alongside
     */
    begin({ ghostBytes = null } = {}) {
      recorder = new TraceRecorder({ laps, tickHz: TICK_HZ });
      if (gameWorld === null) gameWorld = playerBody.world;
      playerBody.world = track.world;
      race.reset();
      normalizeBody(playerBody);
      reader.enabled = true;

      ghost = null;
      if (ghostBytes) {
        try {
          ghost = new Ghost({ THREE, track, trace: decodeTrace(ghostBytes), view: ghostView, laps, KartBody, Race });
          ghost.reset();
        } catch (e) {
          console.warn('[trial] ghost trace unusable:', e.message);
          ghost = null;
        }
      }
      if (ghostView && !ghost) ghostView.object.visible = false;

      acc = 0;
      finished = false;
      active = true;
      race.start();
      if (ghost) ghost.start();
    },

    /** stop without submitting anything */
    abort() {
      active = false;
      this._restore();
      finished = false;
      recorder = null;
      if (ghost) ghost.hide();
      ghost = null;
    },

    /**
     * Advance the simulation by `realDt` of wall clock, in whole fixed ticks.
     * Called once a frame by main.js instead of the normal update block.
     */
    advance(realDt) {
      if (!active) return;
      acc += Math.min(realDt, 0.25);           // a tab that was hidden does not owe us 40 seconds
      let steps = 0;
      while (acc >= TICK && steps < MAX_STEPS_PER_FRAME) {
        acc -= TICK;
        steps++;

        reader.update(TICK);                   // sticks -> playerBody.input
        const frame = {
          throttle: clamp8(playerBody.input.throttle * 127),
          steer: clamp8(playerBody.input.steer * 127),
          hop: !!playerBody.input.hop,
        };
        stepOnce(playerBody, race, frame, null);
        recorder.tick(frame, digestOf(playerBody, race));
        if (ghost) ghost.step();
        if (this.onTick) this.onTick(frame);

        if (!finished && race.state === 'finished') {
          finished = true;
          active = false;
          acc = 0;
          this._finish();
          break;
        }
      }
      if (steps === MAX_STEPS_PER_FRAME) acc = 0;   // give up on the backlog rather than compound it
    },

    _restore() {
      if (gameWorld !== null) { playerBody.world = gameWorld; gameWorld = null; }
    },

    _finish() {
      this._restore();
      const r = race.records.get(playerBody.id);
      const result = {
        totalMs: r && r.finished ? msOf(r.total) : null,
        lapMs: r ? r.lapTimes.map(msOf) : [],
        bestLapMs: r && r.bestLap != null ? msOf(r.bestLap) : null,
        respawns: playerBody.respawns | 0,
      };
      const trace = recorder.finish(result);
      if (ghost) ghost.hide();
      if (this.onFinish) this.onFinish(trace, result);
    },

    /** live numbers for the HUD while a staked run is on */
    status() {
      const r = race.records.get(playerBody.id);
      return {
        state: race.state,
        countdown: race.countdown,
        time: race.time,
        lap: r ? r.lap : 1,
        bestLapMs: r && r.bestLap != null ? msOf(r.bestLap) : null,
        ghostGap: ghost && !ghost.done ? ghost.gapTo(race, playerBody) : null,
      };
    },

    /** keep the ghost's kart drawn */
    updateViews(dt) {
      if (ghost) ghost.updateView(dt);
    },
  };
  return api;
}
