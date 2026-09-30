/**
 * DRIVE  src/game/race.js  (owner: game)
 *
 * The race state machine: the grid, the 3 2 1 GO countdown, lap counting through the three
 * ORDERED checkpoints, standings by race progress, the finish and the results. Nothing here
 * draws or plays a sound; it moves bodies only to place them on the grid and to freeze and
 * release them, and it emits the events in src/game/events.js for the HUD, the audio and the
 * telemetry.
 *
 *   const race = new Race({ events, bodies, spline, laps: 3, names, playerId, grid, startProgress, checkpoints });
 *   race.reset();          // bodies to the grid, frozen (state 'countdown'); state 'grid'
 *   race.start();          // 3, 2, 1 at 1 s intervals, GO at 3 s: bodies released; state 'countdown' -> 'racing'
 *   race.update(dt);       // after every body.update(dt)
 *   race.standings();      // [{ id, name, position, lap, raceProgress, total, bestLap, finished, isPlayer }]
 *   race.positionOf(id);   // 1..n live
 *
 * Lap counting. The spline's progress is 0 at waypoint 0; the start line is at START_PROGRESS
 * (0.037). A lap counts only through the checkpoints IN ORDER: cp1 at 0.33, cp2 at 0.66, then the
 * line. Driving backwards over a checkpoint hands it back. A progress jump over 0.25 in one frame
 * is a respawn or a teleport, never a crossing. kart/physics.js keeps its own copy of this logic
 * (body.lap, body.cpIndex); this module is the owner and WRITES body.lap every frame so the two
 * can never disagree in the telemetry.
 *
 * Race progress is measured from the START LINE (progress relative to startProgress, wrapped), so
 * (lap - 1 + rel) is monotonic for a kart racing forward and the contract's race_progress =
 * (lap - 1 + rel) / laps never dips at the spline's own zero.
 *
 * Finish. On the line crossing that ends the final lap a body is 'finished' (physics then
 * cruises it gently). The player's finish starts a hold (8 s by default) during which the AI keep
 * racing; when every body has finished or the hold runs out the standings are frozen, unfinished
 * racers get a projected total from their remaining distance, and 'raceEnd' fires with the
 * standings. main.js shows the results screen on that event.
 *
 * Plain hyphens only in every string; Ben reads the results screen.
 */
// Deterministic transcendentals, not the host's: Math.sin/cos/tan/atan2/pow/exp are not
// specified to the last bit by ECMAScript and Chrome and Node genuinely disagree, which over a
// 15 000 tick race is the difference between two cars. See src/token/detmath.js.
import { dcos, dsin } from '../token/detmath.js?v=r6-20260906191941';
const DEFAULT_CHECKPOINTS = [0.037, 0.33, 0.66];
const DEFAULT_START = 0.037;
const COUNTDOWN_FROM = 3;
const COUNTDOWN_STEP = 1.0;      // seconds between 3, 2, 1, GO
const GO_SHOWN = 1.0;            // seconds the countdown field reads 0 before it turns null
const PLACE_DEBOUNCE = 0.4;      // seconds between two placeChange events for one racer
const WRONG_WAY_AFTER = 2.0;     // seconds heading against the tangent before the arrow
const WRONG_WAY_SPEED = 3.0;     // m/s below which a kart is never "wrong way"
const PROJECT_SPEED = 20;        // m/s assumed for an unfinished racer's projected total

const wrap01 = (p) => p - Math.floor(p);
/** signed progress difference in -0.5..0.5 */
const dwrap = (d) => d - Math.round(d);

export class Race {
  /**
   * @param {object} o
   * @param {Events} o.events
   * @param {KartBody[]} o.bodies         every body, the player first is the convention but not required
   * @param {Spline} o.spline             needs .length (metres) and .at(progress) with tx, tz
   * @param {number} [o.laps=3]
   * @param {object|Map} [o.names]        id -> racer name
   * @param {*} [o.playerId]              defaults to bodies[0].id
   * @param {Array} [o.grid]              per body index { x, y, z, heading }; reset() places bodies when given
   * @param {number} [o.startProgress]    0.037
   * @param {number[]} [o.checkpoints]    [0.037, 0.33, 0.66], the line first
   * @param {number} [o.holdAfterPlayer]  seconds the AI keep racing after the player finishes
   */
  constructor({ events = null, bodies = [], spline = null, laps = 3, names = null, playerId = null, grid = null,
                startProgress = DEFAULT_START, checkpoints = DEFAULT_CHECKPOINTS, holdAfterPlayer = 8 } = {}) {
    this.events = events;
    this.bodies = bodies;
    this.spline = spline;
    this.laps = Math.max(1, Math.round(laps) || 3);
    this.grid = grid;
    this.startProgress = startProgress;
    this.checkpoints = checkpoints.slice();
    this.holdAfterPlayer = holdAfterPlayer;
    this.playerId = playerId == null ? (bodies[0] ? bodies[0].id : 1) : playerId;
    this.lapLength = spline && Number.isFinite(spline.length) ? spline.length : 1061;
    this._names = names;

    this.state = 'grid';           // 'grid' | 'countdown' | 'racing' | 'finished'
    this.time = 0;                 // seconds since GO
    this.countdown = null;         // 3, 2, 1, 0 (GO), null once racing
    this._cdT = 0;                 // seconds into the countdown
    this._goT = -1;                // race time GO happened (0) for the GO_SHOWN window
    this.records = new Map();      // id -> record
    this._standings = [];
    this.finishOrder = 0;
    this.playerFinishedAt = null;
    this.firstFinishAt = null;
    this.ended = false;
    this._tmp = {};

    for (const b of bodies) this.records.set(b.id, this._newRecord(b));
    for (const b of bodies) if (Array.isArray(b.checkpoints)) b.checkpoints = this.checkpoints.slice();
  }

  nameOf(id) {
    const n = this._names;
    if (!n) return id === this.playerId ? 'Rafa' : `Racer ${id}`;
    if (typeof n.get === 'function') return n.get(id) || `Racer ${id}`;
    return n[id] || `Racer ${id}`;
  }

  _newRecord(b) {
    return {
      id: b.id, name: this.nameOf(b.id), isPlayer: b.id === this.playerId, body: b,
      lap: 1, cpIndex: 0, rel: 0, raceProgress: 0, prevProgress: null, lineCrossed: false,
      lapStart: 0, lapTime: 0, bestLap: null, lapTimes: [],
      total: null, finished: false, finishTime: null, finishOrder: null, projected: false,
      position: 0, prevPosition: 0, lastPlaceEmit: -1,
      wrongWayT: 0, wrongWay: false, lateral: 0,
    };
  }

  // ------------------------------------------------------------------ grid and countdown
  /** Everyone to the grid, frozen. State 'grid'. Safe to call any time (also the RACE AGAIN path). */
  reset() {
    this.state = 'grid';
    this.time = 0; this.countdown = null; this._cdT = 0; this._goT = -1;
    this.finishOrder = 0; this.playerFinishedAt = null; this.firstFinishAt = null; this.ended = false;
    this._standings = [];
    this.bodies.forEach((b, i) => {
      // freeze first: KartBody.place keeps the 'countdown' state when it is already set
      b.state = 'countdown';
      if (typeof b.resetRace === 'function') b.resetRace();
      const g = this.grid && this.grid[i];
      if (g && typeof b.place === 'function') b.place(g.x, g.y, g.z, g.heading);
      b.lap = 1;
      b.shielded = false;
      const r = this._newRecord(b);
      r.prevProgress = b.progress;
      this.records.set(b.id, r);
    });
    this._rank();
  }

  /** 3, 2, 1, GO. Bodies stay frozen until GO. */
  start() {
    if (this.state === 'countdown' || this.state === 'racing') return;
    if (this.state === 'finished') this.reset();
    for (const b of this.bodies) b.state = 'countdown';
    this.state = 'countdown';
    this._cdT = 0;
    this.countdown = COUNTDOWN_FROM;
    this.time = 0;
    this._emit('countdown', { n: COUNTDOWN_FROM });
  }

  _go() {
    this.state = 'racing';
    this.time = 0; this._goT = 0;
    this.countdown = 0;
    for (const b of this.bodies) {
      if (b.state === 'countdown') b.state = 'race';
      const r = this.records.get(b.id);
      if (r) { r.lapStart = 0; r.prevProgress = b.progress; }
    }
    this._emit('go', {});
  }

  // ------------------------------------------------------------------ per frame
  update(dt) {
    if (!(dt > 0)) return;
    if (this.state === 'countdown') {
      this._cdT += dt;
      const n = COUNTDOWN_FROM - Math.floor(this._cdT / COUNTDOWN_STEP);
      if (n <= 0) { this._go(); return; }
      if (n !== this.countdown) { this.countdown = n; this._emit('countdown', { n }); }
      return;
    }
    if (this.state !== 'racing') return;
    this.time += dt;
    if (this.countdown === 0 && this.time >= GO_SHOWN) this.countdown = null;

    for (const b of this.bodies) this._track(b, dt);
    this._rank();
    this._checkEnd();
  }

  /** progress relative to the start line, 0..1 */
  rel(progress) { return wrap01(progress - this.startProgress); }

  _track(b, dt) {
    const r = this.records.get(b.id);
    if (!r) return;
    const p = b.progress;
    if (r.prevProgress === null || !Number.isFinite(p)) { r.prevProgress = p; return; }
    if (!r.finished) {
      const prev = r.prevProgress;
      const d = dwrap(p - prev);
      if (Math.abs(d) <= 0.25) {
        const cps = this.checkpoints;
        const next = r.cpIndex % cps.length;
        const target = cps[next];
        if (d > 0) {
          // forward: crossed the next checkpoint?
          const a = wrap01(target - prev);
          if (a >= 0 && a <= d) {
            if (next === 0 && r.cpIndex > 0) this._lapCrossed(r, b);
            if (next === 0) r.lineCrossed = true;
            if (!r.finished) r.cpIndex = next + 1;
          }
        } else if (d < 0 && r.cpIndex > 0) {
          // backwards over the last checkpoint hands it back
          const back = cps[(r.cpIndex - 1) % cps.length];
          const a = wrap01(prev - back);
          if (a >= 0 && a <= -d) r.cpIndex -= 1;
        }
      }
    }
    r.prevProgress = p;
    // The grid sits BEHIND the line (progress about 0.01 to 0.03 against a line at 0.037), so until a
    // kart has crossed the line once its relative progress is a small NEGATIVE number, never 0.98:
    // race_progress must be monotonic from the grid, and the gate measures the lap gain from it.
    // The grid is never more than a tenth of a lap behind the line; a kart further round than that
    // without a crossing was teleported there (the ?drop=1 check, __DBG__.teleport) and is that far in.
    let rel = this.rel(p);
    if (!r.lineCrossed && rel > 0.9) rel -= 1;
    r.rel = rel;
    r.lateral = Math.abs(b.lateral || 0);
    r.raceProgress = r.finished ? this.laps : Math.max(-0.1, Math.min(this.laps, (r.lap - 1) + r.rel));
    // the owner writes the lap the physics also counts, so telemetry and HUD read one number
    if (!r.finished) b.lap = r.lap; else b.lap = this.laps;

    // wrong way: heading against the tangent at speed for 2 s
    if (!r.finished && this.spline && typeof this.spline.at === 'function' && Math.abs(b.speed || 0) > WRONG_WAY_SPEED) {
      const q = this.spline.at(p, this._tmp);
      const fx = dsin(b.heading), fz = dcos(b.heading);
      const dot = fx * q.tx + fz * q.tz;
      const against = (b.speed > 0 ? dot : -dot) < -0.2;
      r.wrongWayT = against ? r.wrongWayT + dt : 0;
    } else r.wrongWayT = 0;
    const ww = r.wrongWayT >= WRONG_WAY_AFTER;
    if (ww !== r.wrongWay) { r.wrongWay = ww; this._emit('wrongWay', { id: b.id, on: ww }); }
  }

  _lapCrossed(r, b) {
    const lapTime = this.time - r.lapStart;
    r.lapTimes.push(lapTime);
    if (r.bestLap === null || lapTime < r.bestLap) r.bestLap = lapTime;
    r.lapStart = this.time;
    const completed = r.lap;
    this._emit('lapComplete', { id: b.id, lap: completed, time: lapTime });
    if (completed >= this.laps) { this._finish(r, b); return; }
    r.lap = completed + 1;
    if (r.lap === this.laps) this._emit('finalLap', { id: b.id });
  }

  _finish(r, b) {
    r.finished = true;
    r.finishTime = this.time;
    r.total = this.time;
    r.finishOrder = ++this.finishOrder;
    r.raceProgress = this.laps;
    b.state = 'finished';
    b.lap = this.laps;
    if (this.firstFinishAt === null) this.firstFinishAt = this.time;
    if (r.isPlayer) this.playerFinishedAt = this.time;
    this._rank();
    this._emit('finish', { id: b.id, position: r.position || r.finishOrder, time: this.time });
  }

  /** standings: finished first by finish order, then by race progress, ties by lateral distance */
  _rank() {
    const rows = [...this.records.values()];
    rows.sort((a, c) => {
      if (a.finished || c.finished) {
        if (a.finished && c.finished) return a.finishOrder - c.finishOrder;
        return a.finished ? -1 : 1;
      }
      if (c.raceProgress !== a.raceProgress) return c.raceProgress - a.raceProgress;
      return a.lateral - c.lateral;
    });
    rows.forEach((r, i) => {
      const pos = i + 1;
      if (pos !== r.position) {
        const from = r.position;
        r.prevPosition = r.position;
        r.position = pos;
        if (this.state === 'racing' && from > 0 && this.time - r.lastPlaceEmit >= PLACE_DEBOUNCE) {
          r.lastPlaceEmit = this.time;
          this._emit('placeChange', { id: r.id, from, to: pos });
        }
      }
    });
    this._standings = rows;
  }

  _checkEnd() {
    if (this.ended) return;
    const all = [...this.records.values()];
    const everyone = all.every((r) => r.finished);
    const playerDone = this.playerFinishedAt !== null && this.time - this.playerFinishedAt >= this.holdAfterPlayer;
    // a race nobody can finish (all AI parked, player idle) still ends: 6 minutes after the first finish
    const stale = this.firstFinishAt !== null && this.time - this.firstFinishAt >= 360;
    if (!(everyone || playerDone || stale)) return;
    this.ended = true;
    for (const r of all) {
      if (r.finished) continue;
      const remaining = Math.max(0, this.laps - r.raceProgress) * this.lapLength;
      r.total = this.time + remaining / PROJECT_SPEED;
      r.projected = true;
    }
    this.state = 'finished';
    this._rank();
    this._emit('raceEnd', { standings: this.standings() });
  }

  // ------------------------------------------------------------------ reads
  standings() {
    return this._standings.map((r) => ({
      id: r.id, name: r.name, isPlayer: r.isPlayer, position: r.position, lap: r.lap,
      raceProgress: r.raceProgress / this.laps, total: r.total, bestLap: r.bestLap,
      finished: r.finished || r.projected, projected: r.projected, lapTimes: r.lapTimes.slice(),
    }));
  }

  positionOf(id) { const r = this.records.get(id); return r ? r.position || 0 : 0; }
  record(id) { return this.records.get(id) || null; }
  get player() { return this.records.get(this.playerId) || null; }
  /** the contract's race_progress for one racer: (lap - 1 + rel) / laps, monotonic while racing forward */
  raceProgressOf(id) { const r = this.records.get(id); return r ? r.raceProgress / this.laps : 0; }
  lapOf(id) { const r = this.records.get(id); return r ? r.lap : 0; }
  wrongWay(id) { const r = this.records.get(id); return !!(r && r.wrongWay); }
  get racing() { return this.state === 'racing'; }
  get over() { return this.state === 'finished'; }
  /** seconds of the current lap for one racer */
  lapTimeOf(id) { const r = this.records.get(id); return r ? (r.finished ? 0 : this.time - r.lapStart) : 0; }

  /** Debug entry for the ?laps=1 gate query and the harness: force the player's finish now. */
  debugFinishPlayer() {
    const r = this.records.get(this.playerId);
    if (!r || r.finished || this.state !== 'racing') return false;
    this._finish(r, r.body);
    return true;
  }

  _emit(name, payload) { if (this.events && typeof this.events.emit === 'function') this.events.emit(name, payload); }
}
