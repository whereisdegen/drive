/**
 * DRIVE  src/kart/physics.js  (owner: kart)
 *
 * The arcade kart model. One KartBody per racer, driven each frame by the input object that
 * player.js or ai/racer.js writes into `body.input`, stepped by `update(dt)` with dt already
 * clamped to 0.05 s by main.js.
 *
 * Model, in the order update() runs it:
 *   1 state timers (countdown, spin, fall, respawn, boost, invulnerability)
 *   2 longitudinal: KART.accel(v) along the heading, brake 16, reverse to 7, engine drag when
 *     coasting, the surface cap (sand 55%, grass 65%), over speed above the cap decays at
 *     KART.overspeedDecay (boost pads, espresso, mini turbo) or faster off the road
 *   3 yaw: steer rate 2.4 rad/s at rest to 1.1 rad/s at vmax, limited by a lateral grip so a
 *     fast kart has to lift or drift; in a drift the yaw is locked to the drift side with a
 *     bias and a counter steer band
 *   4 grip: the velocity DIRECTION relaxes toward the heading at KART.gripAlign[surface] per
 *     second, 2.5 in a drift, so the kart visibly slides
 *   5 hop (0.35 s, 0.5 m) and gravity, then world.moveKart for walls, ground and surface
 *   6 fall detection, the 1.6 s respawn through the spline, progress and lap bookkeeping
 *
 * Coordinates are the track plan's: +X east, +Z south, +Y up, heading in radians about +Y with
 * 0 facing +Z and counter clockwise from above, so forward = (sin h, 0, cos h) and the right
 * of travel = (-cos h, 0, sin h). Steer +1 is right, which DEcreases the heading.
 *
 * Nothing here draws. kartview.js reads pos, heading, tilt, wheelSpin, steerAngle, spinAngle,
 * drift and boost; camera.js reads pos, heading, groundY, speed, drift and tilt.
 *
 * Round 4 (motion cues): KERB BOUNCE. Each frame the two rear wheel contact points are probed
 * through world.groundAt when the kart is near a road edge; a wheel that enters the kerb band (the
 * kerb substrate, or the striped race kerb apron where road.kerbs has a station) kicks a small
 * suspension spring (`kerbHop`, metres, about 3 cm) that kartview.js applies to the body only, and
 * emits 'kerb' { id, side, speed, x, z } for the audio module. While a wheel rides the band the
 * spring is re kicked at 8 Hz so the kerb rumbles. Handling is untouched: the hop is a view value,
 * the kart never leaves the ground for it (an airborne kart loses drive and steer, and the touch
 * lap already leaves the road at two corners).
 */
import * as THREE from 'three';
// Deterministic transcendentals, not the host's: Math.sin/cos/tan/atan2/pow/exp are not
// specified to the last bit by ECMAScript and Chrome and Node genuinely disagree, which over a
// 15 000 tick race is the difference between two cars. See src/token/detmath.js.
import { datan2, dcos, dexp, dhypot, dpow, dsin } from '../token/detmath.js?v=r6-20260906191941';

export const KART = {
  vmax: 24, accel: (v) => 12 * dpow(Math.max(0, 1 - v / 24), 0.6) + 1, brake: 16, reverseMax: 7,
  steerRateLow: 2.4, steerRateHigh: 1.1,                 // rad/s at v 0 and at vmax, linear between
  gripAlign: { asphalt: 6.0, cobble: 6.0, pad: 6.0, grass: 3.5, sand: 3.0, drift: 2.5 },   // 1/s velocity to heading alignment rate
  cap: { asphalt: 1.0, cobble: 1.0, pad: 1.0, grass: 0.65, sand: 0.55 },
  // lateral grip in m/s^2: the yaw rate outside a drift is limited to latGrip / v, so at vmax on
  // asphalt the tightest arc on grip is 24^2 / 10.5 = 55 m: the 30 m church hairpin needs either a
  // lift to 17.7 m/s or a drift (the drift's yaw is locked and ignores this limit, which is why
  // drifting is faster). ai/racer.js plans its corner speeds at sqrt(9.5 x radius), just under it.
  latGrip: { asphalt: 10.5, cobble: 10.5, pad: 10.5, grass: 6.0, sand: 5.0 },
  hop: { time: 0.35, height: 0.5 },
  // drift band = yawBias + counterSteer * steer * dir, 0.10 to 1.00 of the steer rate: full counter steer nearly straightens, full steer in tightens
  drift: { yawBias: 0.55, counterSteer: 0.45, minSpeed: 7, tiers: [ { t: 1.1, boost: 4, dur: 0.7 }, { t: 2.2, boost: 6, dur: 1.1 }, { t: 3.4, boost: 8, dur: 1.6 } ] },
  pad: { boost: 9, dur: 1.4 }, espresso: { boost: 10, dur: 2.2 }, overspeedDecay: 6, offroadDecay: 16,
  coastDrag: 3.5,                                        // m/s^2 with no throttle
  spin: { time: 1.3, turns: 2, speedKeep: 0.3 }, bump: { exchange: 0.6, hop: 0.2 },
  respawn: { fall: 0.5, fade: 0.6, hold: 0.5, invuln: 1.0 },
  gravity: 22, hopGravity: 32.6,                         // hopGravity gives 0.5 m in 0.35 s
  stick: 0.6,                                            // m: a kart within this of the ground and not hopping is glued to it (crests do not launch it)
  radius: 0.7, mass: 1,
  wheelRadius: 0.22, steerLock: 0.45,                    // for the view: front wheel angle at full steer
  // round 4: the kerb bounce spring (view only). k and c give a 3 cm peak 60 ms after a 1.1 m/s kick and
  // settle inside 0.3 s; rumble re kicks at 8 Hz while a wheel stays on the band
  kerb: { kick: 1.3, rumbleKick: 0.4, rumbleHz: 8, k: 420, c: 16, track: 0.62, rearZ: -0.55, minSpeed: 3, band: 2.2 },
};

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrapAngle = (a) => { a = a % TAU; if (a > Math.PI) a -= TAU; if (a < -Math.PI) a += TAU; return a; };
const lerp = (a, b, t) => a + (b - a) * t;

let _nextId = 1;
const _v3 = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _n = new THREE.Vector3();
const _qs = {};
const _kg = [{}, {}];
// round 4: where the striped race kerb runs, per side, as 1024 progress bins (road.kerbs stations, 4 m pitch,
// each marked 3 m either way); built once per world and shared by every body
const KERB_BINS = 1024;
const _kerbTables = new WeakMap();
function raceKerbTable(world, spline) {
  const road = world && world.road;
  if (!road || !Array.isArray(road.kerbs)) return null;
  let t = _kerbTables.get(road);
  if (t) return t;
  t = [new Uint8Array(KERB_BINS), new Uint8Array(KERB_BINS)];
  const L = spline && spline.length > 0 ? spline.length : 1061;
  const reach = Math.max(1, Math.round(3 / L * KERB_BINS));
  for (const k of road.kerbs) {
    let p = typeof k.progress === 'number' ? k.progress : (typeof k.s === 'number' ? k.s / L : null);
    if (p == null || !Number.isFinite(p)) continue;
    const sgn = k.side === 'L' ? 0 : 1;
    const c = Math.floor(((p % 1) + 1) % 1 * KERB_BINS);
    for (let d = -reach; d <= reach; d++) t[sgn][((c + d) % KERB_BINS + KERB_BINS) % KERB_BINS] = 1;
  }
  _kerbTables.set(road, t);
  return t;
}

/** How far along the lap a body is, in laps: lap - 1 + progress. Monotonic while racing forward. */
function raceProgressOf(b) { return b.lap - 1 + b.progress; }

export class KartBody {
  constructor({ world = null, spline = null, id = null, events = null } = {}) {
    this.world = world;
    this.spline = spline;
    this.events = events;
    this.id = id == null ? _nextId++ : id;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();        // world velocity, xz plus the vertical component
    this.heading = 0;
    this.speed = 0;                        // signed forward speed along the heading
    this.grounded = true;
    this.groundY = 0;
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    this.surface = 'asphalt';
    this.onRoad = true;
    this.progress = 0;
    this.lap = 1;
    this.lateral = 0;
    this.splineIndex = -1;                 // nearest sample hint for spline.nearest
    this.distance = 0;                     // metres travelled this race
    this.state = 'race';                   // 'race'|'hop'|'drift'|'spin'|'fall'|'respawn'|'finished'|'countdown'
    this.drift = { active: false, dir: 1, charge: 0, tier: 0 };
    this.boost = 0;                        // seconds of over speed remaining
    this.boostAmount = 0;
    this.shielded = false;
    this.input = { throttle: 0, steer: 0, hop: false, item: false };
    this.tilt = { roll: 0, pitch: 0 };     // radians, from the ground normal: roll positive = right side down, pitch positive = nose up
    this.wheelSpin = 0;                    // radians, accumulated
    this.steerAngle = 0;                   // radians, front wheels, positive = right
    this.spinAngle = 0;                    // radians about up added by the view during a spin out
    this.hopT = 0;                         // seconds into the hop
    this.hopHeld = false;
    this.hopWasHeld = false;
    this.vy = 0;
    this.spinT = 0;
    this.respawnT = 0;                     // seconds into the respawn sequence (fall + fade + hold)
    this.respawnPhase = null;              // 'fall'|'fade'|'hold'|null
    this.fadeAlpha = 0;                    // 0..1 black fade the post module can read
    this.invuln = 0;
    this.respawns = 0;
    this.wallHit = false;
    this.wallT = 0;
    this.lastBump = 0;
    this.checkpoints = [0.037, 0.33, 0.66];
    this.cpIndex = 0;                      // next checkpoint to cross (0 = the line)
    this.lapTime = 0;
    this.finishedLaps = 0;
    this.time = 0;
    this.cobbleShake = 0;
    this._fallTime = 0;
    this._prevProgress = 0;
    this._steerSmoothed = 0;
    this._lastRespawnPoint = { progress: 0 };
    // round 4: kerb bounce (view values) and the per side band state
    this.kerbHop = 0;                      // metres, the suspension hop kartview applies to the body
    this.kerbHopV = 0;
    this.kerbSide = 0;                     // -1 left wheel, 1 right wheel, the last wheel that hit
    this.kerbT = 0;                        // seconds left of the hit's roll cue
    this.kerbHits = 0;                     // counter, the view reads a rising value as a new hit
    this.kerbOn = false;                   // a rear wheel is on the kerb band this frame
    this._kerbOnSide = [false, false];
    this._kerbRumbleT = 0;
  }

  get forward() { return _v3.set(dsin(this.heading), 0, dcos(this.heading)); }
  get right() { return _v3b.set(-dcos(this.heading), 0, dsin(this.heading)); }
  get raceProgress() { return raceProgressOf(this); }
  get invulnerable() { return this.invuln > 0 || this.state === 'spin' || this.state === 'fall' || this.state === 'respawn'; }
  get airborne() { return !this.grounded; }

  /** Put the body on the grid (or anywhere): position, heading, speed zero, timers cleared. */
  place(x, y, z, heading) {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
    this.heading = heading;
    this.speed = 0; this.vy = 0;
    this.groundY = y; this.grounded = true;
    this.drift.active = false; this.drift.charge = 0; this.drift.tier = 0;
    this.boost = 0; this.boostAmount = 0;
    this.spinT = 0; this.spinAngle = 0; this.respawnT = 0; this.respawnPhase = null; this.fadeAlpha = 0;
    this.hopT = 0; this.invuln = 0; this.wallHit = false;
    this.splineIndex = -1;
    if (this.state !== 'countdown') this.state = 'race';
    this._updateProgress(true);
    this._prevProgress = this.progress;
    this.cpIndex = this.progress > this.checkpoints[0] ? 1 : 0;
  }

  /** Reset the race bookkeeping (laps, distance, respawns). Called by race.reset through main.js. */
  resetRace() {
    this.lap = 1; this.distance = 0; this.respawns = 0; this.finishedLaps = 0; this.time = 0; this.lapTime = 0;
    this.cpIndex = this.progress > this.checkpoints[0] ? 1 : 0;
  }

  steerRate(v) { return lerp(KART.steerRateLow, KART.steerRateHigh, clamp(Math.abs(v) / KART.vmax, 0, 1)); }

  surfaceCap() {
    const c = KART.cap[this.surface];
    // rubber band hook (ai/director.js writes body.rubber every frame, 0.88 to 1.10; integrator fix, see work/game/NOTES.md)
    const rb = Number.isFinite(this.rubber) && this.rubber > 0 ? clamp(this.rubber, 0.85, 1.1) : 1;
    return KART.vmax * rb * (c == null ? 1 : c);
  }

  update(dt) {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.05);
    this.time += dt;
    const inp = this.input;
    const frozen = this.state === 'countdown';
    if (this.invuln > 0) this.invuln = Math.max(0, this.invuln - dt);
    if (this.wallT > 0) { this.wallT -= dt; if (this.wallT <= 0) this.wallHit = false; }

    // --- respawn sequence: fall, fade, hold. The kart is placed at the start of the fade so the
    //     camera snap happens behind black.
    if (this.state === 'fall' || this.state === 'respawn') {
      this._stepRespawn(dt);
      return;
    }
    if (this.state === 'finished') {
      // auto cruise after the line: half throttle, steer back to the centreline, no hop
      inp.throttle = this.speed > 12 ? 0 : 0.5; inp.hop = false;   // cruise capped at 12 m/s (ai notes: finished karts ran onto the grass at 0.5 throttle)
      inp.steer = clamp(-this.lateral * 0.15, -0.6, 0.6) * (this.speed > 2 ? 1 : 0);
    }

    // --- spin out: no input, the kart keeps its heading, decelerates, and the view spins it
    let throttle = frozen ? 0 : clamp(inp.throttle || 0, -1, 1);
    let steer = frozen ? 0 : clamp(inp.steer || 0, -1, 1);
    let hop = !frozen && !!inp.hop;
    if (this.state === 'spin') {
      this.spinT += dt;
      const k = clamp(this.spinT / KART.spin.time, 0, 1);
      this.spinAngle = TAU * KART.spin.turns * (1 - dpow(1 - k, 2));   // fast start, eases out
      throttle = 0; steer = 0; hop = false;
      if (this.spinT >= KART.spin.time) { this.state = 'race'; this.spinAngle = 0; this.spinT = 0; }
    }

    // --- longitudinal
    let v = this.speed;
    this._pushed = false;
    const cap = this.surfaceCap();
    const effCap = cap + (this.boost > 0 ? this.boostAmount : 0);
    let a = 0;
    if (throttle > 0.02) {
      if (v < effCap) a = KART.accel(Math.max(0, v)) * throttle;
      if (v < 0) a = KART.brake;                         // braking out of reverse
    } else if (throttle < -0.02) {
      if (v > 0.3) a = -KART.brake;
      else a = v > -KART.reverseMax ? -6 * -throttle : 0;
    } else {
      a = -Math.sign(v) * Math.min(KART.coastDrag, Math.abs(v) / dt);
    }
    if (this.state === 'spin') a = -Math.sign(v) * Math.min(5, Math.abs(v) / dt);
    if (!this.grounded) a *= 0.15;                       // no drive in the air
    v += a * dt;
    if (v > effCap) {
      const decay = (this.boost > 0 || cap >= KART.vmax - 1e-6) ? KART.overspeedDecay : KART.offroadDecay;
      v = Math.max(effCap, v - decay * dt);
    }
    if (v < -KART.reverseMax) v = -KART.reverseMax;
    if (Math.abs(v) < 0.02 && Math.abs(throttle) < 0.02) v = 0;

    // --- boost timer
    if (this.boost > 0) { this.boost -= dt; if (this.boost <= 0) { this.boost = 0; this.boostAmount = 0; } }

    // --- hop and drift state machine
    const hopPressed = hop && !this.hopWasHeld;
    this.hopWasHeld = hop;
    if (this.state === 'race' && hopPressed && this.grounded && Math.abs(v) > 1) {
      this.state = 'hop'; this.hopT = 0; this.vy = KART.hopGravity * KART.hop.time * 0.5; this.grounded = false;
      this.drift.charge = 0; this.drift.tier = 0;
      if (Math.abs(steer) > 0.3) { this.drift.dir = steer > 0 ? 1 : -1; this.drift.pending = true; } else this.drift.pending = false;
    }
    if (this.state === 'hop') {
      this.hopT += dt;
      // a steer held during the hop picks the drift side
      if (Math.abs(steer) > 0.3 && hop) { this.drift.dir = steer > 0 ? 1 : -1; this.drift.pending = true; }
      if (this.grounded || this.hopT > KART.hop.time + 0.25) {
        if (hop && this.drift.pending && v > KART.drift.minSpeed) {
          this.state = 'drift'; this.drift.active = true; this.drift.charge = 0; this.drift.tier = 0;
        } else { this.state = 'race'; this.drift.active = false; }
        this.drift.pending = false;
      }
    }
    if (this.state === 'drift') {
      const d = this.drift;
      // charge builds faster when steering into the drift, slower when counter steering
      const into = steer * d.dir;
      d.charge += dt * (1 + 0.35 * clamp(into, -1, 1));
      const tiers = KART.drift.tiers;
      d.tier = d.charge >= tiers[2].t ? 3 : d.charge >= tiers[1].t ? 2 : d.charge >= tiers[0].t ? 1 : 0;
      const end = !hop || v < KART.drift.minSpeed * 0.6 || !this.grounded && this.vy < -3;
      if (end) {
        if (hop === false && d.tier > 0) {
          const t = tiers[d.tier - 1];
          this.applyBoost(t.boost, t.dur);
          v = Math.max(v, this.speed);                    // the push lands this frame, not after the velocity is rebuilt below
          if (this.events) this.events.emit('miniTurbo', { id: this.id, tier: d.tier });
        }
        this.state = 'race'; d.active = false; d.charge = 0; d.tier = 0;
      }
    }

    // --- yaw
    const rate = this.steerRate(v);
    const lowSpeed = clamp(Math.abs(v) / 2.5, 0, 1);       // a stationary kart does not pivot
    let yawRate = 0;
    if (this.state === 'drift') {
      const d = this.drift;
      const band = KART.drift.yawBias + KART.drift.counterSteer * clamp(steer * d.dir, -1, 1);
      yawRate = -d.dir * rate * band;                     // steer right = heading decreases
    } else if (this.state !== 'spin') {
      const cmd = -steer * rate * lowSpeed;
      const grip = KART.latGrip[this.surface] == null ? KART.latGrip.asphalt : KART.latGrip[this.surface];
      const wMax = Math.abs(v) > 1 ? grip / Math.abs(v) : rate;
      yawRate = clamp(cmd, -wMax, wMax);
      if (!this.grounded) yawRate *= 0.35;
    }
    if (v < 0) yawRate = -yawRate;                         // reversing steers the other way
    this.heading = wrapAngle(this.heading + yawRate * dt);

    // --- grip: rotate the velocity direction toward the heading
    const align = this.state === 'drift' ? KART.gripAlign.drift : (KART.gripAlign[this.surface] == null ? KART.gripAlign.asphalt : KART.gripAlign[this.surface]);
    const hv = dhypot(this.vel.x, this.vel.z);
    let theta = hv > 0.05 ? datan2(this.vel.x, this.vel.z) : this.heading;
    const targetTheta = v >= 0 ? this.heading : this.heading + Math.PI;
    const k = 1 - dexp(-align * dt * (this.grounded ? 1 : 0.25));
    theta += wrapAngle(targetTheta - theta) * k;
    const mag = Math.abs(v);
    this.vel.x = dsin(theta) * mag;
    this.vel.z = dcos(theta) * mag;

    // --- vertical: hop gravity while hopping, world gravity otherwise
    const g = this.state === 'hop' ? KART.hopGravity : KART.gravity;
    if (!this.grounded) this.vy -= g * dt;
    this.vel.y = this.vy;

    // --- move through the world
    this._move(dt);

    // --- speed is the forward component of what came back (walls slow us)
    const f = this.forward;
    const fwd = this.vel.x * f.x + this.vel.z * f.z;
    // the magnitude, signed by the forward component: taking the projection itself would lose
    // cos(slip) every frame and turn a steady corner into a 40% per second brake
    this.speed = Math.sign(fwd || 1) * dhypot(this.vel.x, this.vel.z);
    if (Math.abs(this.speed) < 0.02 && Math.abs(throttle) < 0.02) this.speed = 0;

    // --- derived for the view
    const targetSteer = this.state === 'drift' ? this.drift.dir * 0.7 + steer * 0.3 : steer;
    this._steerSmoothed += (targetSteer - this._steerSmoothed) * Math.min(1, dt * 12);
    this.steerAngle = this._steerSmoothed * KART.steerLock;
    this.wheelSpin += (this.speed / KART.wheelRadius) * dt;
    if (this.wheelSpin > 1e4 || this.wheelSpin < -1e4) this.wheelSpin %= TAU;
    this.distance += dhypot(this.vel.x, this.vel.z) * dt;
    this.cobbleShake = this.surface === 'cobble' && this.grounded && Math.abs(this.speed) > 4 ? 1 : 0;
    this._updateTilt();
    this._kerbs(dt);

    // --- fall detection
    const water = this.surface === 'water';
    const fallRule = this.world && typeof this.world.isFall === 'function' ? this.world.isFall(this.pos) : (this.pos.y < -1.0);
    // a face steeper than about 53 degrees (the cliff face below the guard wall gaps) is not ground a kart
    // can hold: it slides down it and the fall clock runs (integrator, round 0: the ?drop=1 check landed on
    // the 65 degree face and drove back up to the road at 9 m/s)
    const steep = this.grounded && this.groundNormal && this.groundNormal.y < 0.6 && !this.onRoad;
    if (steep) { this.vel.x += this.groundNormal.x * 14 * dt; this.vel.z += this.groundNormal.z * 14 * dt; }
    // wedged: throttle held, not moving, for 5 s while racing (a kart pinned between two colliders off the
    // road has no other way back; the ?drop=1 style respawn puts it on the centreline). Integrator, round 0:
    // the forced finish run sat 100 s against the inner cliff modules of section H.
    if (this.state === 'race' && Math.abs(throttle) > 0.5 && Math.abs(this.speed) < 0.6 && this.grounded) {
      this._stuckT = (this._stuckT || 0) + dt;
      if (this._stuckT > 5) { this._stuckT = 0; this.startRespawn(); return; }
    } else this._stuckT = 0;
    if (water || this.pos.y < -1.0 || fallRule || steep) {
      this._fallTime += dt;
      if (water || this.pos.y < -1.0 || this._fallTime > 0.5) this.startRespawn();
    } else this._fallTime = 0;

    // --- progress and laps
    this._updateProgress(false);
  }

  _move(dt) {
    const w = this.world;
    if (w && typeof w.moveKart === 'function') {
      const r = w.moveKart(this.pos, this.vel, KART.radius, dt);
      if (r) {
        if (r.pos) this.pos.copy(r.pos);
        if (r.vel) this.vel.copy(r.vel);
        if (r.hitWall) { this.wallHit = true; this.wallT = 0.25; if (r.wallNormal) this._wallNormal = r.wallNormal; }
        if (r.surface) this.surface = r.surface;
        if (typeof r.groundY === 'number' && !Number.isNaN(r.groundY)) this.groundY = r.groundY;
        if (r.normal) this.groundNormal.copy(r.normal);
        this.onRoad = this.surface === 'asphalt' || this.surface === 'cobble' || this.surface === 'pad';
        this.vy = this.vel.y;
        // landing: the world reports grounded, or we are at or below the ground going down, or we
        // are within KART.stick of the road and not hopping (a crest must not launch the kart)
        const stick = this.state !== 'hop' && this.vy <= 0.5 && this.pos.y - this.groundY < KART.stick && this.surface !== 'air' && this.surface !== 'water';
        if (r.grounded || stick || (this.pos.y <= this.groundY + 0.02 && this.vy <= 0)) {
          if (!this.grounded && this.vy < -2) this._landed = true;
          this.pos.y = this.groundY; this.vy = 0; this.vel.y = 0; this.grounded = true;
        } else this.grounded = false;
        return;
      }
    }
    // fallback: integrate and read the ground directly
    this.pos.x += this.vel.x * dt; this.pos.y += this.vel.y * dt; this.pos.z += this.vel.z * dt;
    let gy = 0, surf = 'asphalt';
    if (w && typeof w.groundAt === 'function') {
      const gnd = w.groundAt(this.pos.x, this.pos.z);
      if (gnd) { gy = gnd.y; surf = gnd.surface || 'asphalt'; if (gnd.normal) this.groundNormal.copy(gnd.normal); }
    }
    this.groundY = gy; this.surface = surf;
    this.onRoad = surf === 'asphalt' || surf === 'cobble' || surf === 'pad';
    const stick = this.state !== 'hop' && this.vy <= 0.5 && this.pos.y - gy < KART.stick;
    if (stick || (this.pos.y <= gy + 0.02 && this.vy <= 0)) { this.pos.y = gy; this.vy = 0; this.grounded = true; }
    else this.grounded = false;
    this.vel.y = this.vy;
  }

  /**
   * Round 4: the kerb bounce. Probes the two rear wheel contact points when the kart is within
   * KART.kerb.band of a road edge; a wheel entering the kerb band kicks the hop spring and emits 'kerb'.
   */
  _kerbs(dt) {
    const C = KART.kerb;
    // the spring, always integrated so a kick settles even off the band
    this.kerbHopV += (-this.kerbHop * C.k - this.kerbHopV * C.c) * dt;
    this.kerbHop += this.kerbHopV * dt;
    if (Math.abs(this.kerbHop) < 1e-4 && Math.abs(this.kerbHopV) < 2e-3) { this.kerbHop = 0; this.kerbHopV = 0; }
    if (this.kerbT > 0) this.kerbT = Math.max(0, this.kerbT - dt);
    const w = this.world, s = this.spline;
    const on = this._kerbOnSide;
    if (!w || typeof w.groundAt !== 'function' || !this.grounded || Math.abs(this.speed) < C.minSpeed || this.state === 'spin' || this.state === 'fall' || this.state === 'respawn') {
      on[0] = on[1] = false; this.kerbOn = false; return;
    }
    // cheap reject: both rear wheels well inside the road
    let half = 6;
    if (s && typeof s.at === 'function') { const q = s.at(this.progress, _qs); if (q && q.width > 0) half = q.width / 2; }
    if (this.onRoad && Math.abs(this.lateral) + C.track < half - C.band) { on[0] = on[1] = false; this.kerbOn = false; return; }
    const hx = dsin(this.heading), hz = dcos(this.heading);
    const rx = -hz, rz = hx;                                   // right of travel
    const table = raceKerbTable(w, s);
    let any = false;
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const px = this.pos.x + rx * side * C.track + hx * C.rearZ, pz = this.pos.z + rz * side * C.track + hz * C.rearZ;
      let g = null;
      try { g = w.groundAt(px, pz, _kg[i]); } catch (e) { g = null; }
      let band = false;
      if (g && g.surface !== 'water' && g.surface !== 'air') {
        if (g.zone === 'kerb') band = true;
        else if (g.zone === 'road' && typeof g.lateral === 'number' && table) {
          // the striped race kerb apron: the outer 1.2 m of the road where a kerb_module station runs on that side
          const al = Math.abs(g.lateral), sgn = g.lateral < 0 ? 0 : 1;
          if (al > half - 1.25 && typeof g.progress === 'number') {
            const bin = ((Math.floor(g.progress * KERB_BINS) % KERB_BINS) + KERB_BINS) % KERB_BINS;
            band = table[sgn][bin] === 1;
          }
        }
      }
      const was = on[i];
      on[i] = band;
      if (band) any = true;
      if (band && !was) {
        this.kerbHopV += C.kick * Math.min(1, 0.5 + Math.abs(this.speed) / 20);
        this.kerbSide = side; this.kerbT = 0.25; this.kerbHits += 1; this._kerbRumbleT = 1 / C.rumbleHz;
        if (this.events) this.events.emit('kerb', { id: this.id, side, speed: Math.abs(this.speed), x: px, z: pz });
      }
    }
    this.kerbOn = any;
    if (any) {
      this._kerbRumbleT -= dt;
      if (this._kerbRumbleT <= 0) { this._kerbRumbleT += 1 / C.rumbleHz; this.kerbHopV += C.rumbleKick * (0.6 + Math.random() * 0.6); }
    }
  }

  _updateTilt() {
    const n = this.groundNormal;
    if (!this.grounded) { this.tilt.roll *= 0.9; this.tilt.pitch *= 0.9; return; }
    const f = this.forward, r = this.right;
    // slope along forward and along right, from the normal
    const pitch = datan2(-(n.x * f.x + n.z * f.z), Math.max(0.2, n.y));   // nose up when the ground rises ahead
    const roll = datan2(-(n.x * r.x + n.z * r.z), Math.max(0.2, n.y));    // right side down when the ground drops right
    this.tilt.pitch += (pitch - this.tilt.pitch) * 0.35;
    this.tilt.roll += (roll - this.tilt.roll) * 0.35;
  }

  _updateProgress(full) {
    const s = this.spline;
    if (!s || typeof s.nearest !== 'function') return;
    const r = s.nearest(this.pos.x, this.pos.z, full ? -1 : this.splineIndex);
    if (!r) return;
    this.splineIndex = r.index == null ? -1 : r.index;
    const prev = this.progress;
    this.progress = r.progress;
    this.lateral = r.lateral == null ? 0 : r.lateral;
    if (full) { this._prevProgress = this.progress; return; }
    // checkpoints in order: 0.33, 0.66, then the line; a lap counts only through all three
    const cps = this.checkpoints;
    const crossed = (p0, p1, c) => {
      const d = wrapAngleProgress(p1 - p0);
      if (Math.abs(d) > 0.25) return 0;                  // a respawn jump, not a crossing
      if (d > 0) { const a = wrapP(c - p0); return a >= 0 && a <= d ? 1 : 0; }
      const a = wrapP(p0 - c); return a >= 0 && a <= -d ? -1 : 0;
    };
    const next = this.cpIndex % cps.length;
    const target = cps[next];
    const c = crossed(prev, this.progress, target);
    if (c > 0) {
      if (next === 0 && this.cpIndex > 0) {
        this.lap += 1; this.finishedLaps += 1;
        if (this.events) this.events.emit('lapCrossed', { id: this.id, lap: this.lap, time: this.time });
      }
      this.cpIndex = next + 1;
    } else if (this.cpIndex > 0) {
      const back = cps[(this.cpIndex - 1) % cps.length];
      if (crossed(prev, this.progress, back) < 0) this.cpIndex -= 1;
    }
    this._prevProgress = this.progress;
  }

  /** Spin the kart out (hazard, projectile, or a hard bump). No effect while invulnerable. */
  spinOut() {
    if (this.invulnerable) return false;
    if (this.state === 'countdown' || this.state === 'finished') return false;
    this.state = 'spin'; this.spinT = 0; this.spinAngle = 0;
    this.speed *= KART.spin.speedKeep;
    this.vel.x *= KART.spin.speedKeep; this.vel.z *= KART.spin.speedKeep;
    this.drift.active = false; this.drift.charge = 0; this.drift.tier = 0;
    this.boost = 0; this.boostAmount = 0;
    if (this.events) this.events.emit('spin', { id: this.id });
    return true;
  }

  /** Over speed: the cap rises by `amount` for `dur` seconds and the kart is pushed there at once. */
  applyBoost(amount, dur) {
    this._pushed = true;
    this.boostAmount = Math.max(this.boostAmount, amount);
    this.boost = Math.max(this.boost, dur);
    const target = this.surfaceCap() + amount;
    if (this.speed < target) {
      this.speed = target;
      const hv = dhypot(this.vel.x, this.vel.z);
      if (hv > 0.05) { const k = target / hv; this.vel.x *= k; this.vel.z *= k; }
      else { const f = this.forward; this.vel.x = f.x * target; this.vel.z = f.z * target; }
    }
  }

  /**
   * Elastic bump between two karts: 60% of the relative velocity along the contact normal is
   * exchanged, both hop a little, and they are pushed apart to their radii. Called once per pair
   * by resolveBumps(); safe to call directly.
   */
  bumpWith(other) {
    const dx = other.pos.x - this.pos.x, dz = other.pos.z - this.pos.z;
    const d = dhypot(dx, dz);
    const minD = KART.radius * 2;
    if (d >= minD || d < 1e-4) return false;
    if (Math.abs(other.pos.y - this.pos.y) > 1.2) return false;
    _n.set(dx / d, 0, dz / d);
    // separate
    const push = (minD - d) * 0.5 + 0.01;
    this.pos.x -= _n.x * push; this.pos.z -= _n.z * push;
    other.pos.x += _n.x * push; other.pos.z += _n.z * push;
    // exchange along the normal
    const va = this.vel.x * _n.x + this.vel.z * _n.z;
    const vb = other.vel.x * _n.x + other.vel.z * _n.z;
    const rel = va - vb;
    if (rel > 0) {
      const j = rel * KART.bump.exchange;
      this.vel.x -= _n.x * j; this.vel.z -= _n.z * j;
      other.vel.x += _n.x * j; other.vel.z += _n.z * j;
      // speed is the MAGNITUDE signed by the forward component, as in update(): the projection
      // would lose cos(slip) on every frame of side by side contact and drain a drift to a crawl
      const f = this.forward; const fa = this.vel.x * f.x + this.vel.z * f.z;
      this.speed = Math.sign(fa || 1) * dhypot(this.vel.x, this.vel.z);
      const g = other.forward; const fb = other.vel.x * g.x + other.vel.z * g.z;
      other.speed = Math.sign(fb || 1) * dhypot(other.vel.x, other.vel.z);
      // a real knock hops both karts; rubbing along side by side does not (an airborne kart has no drive)
      if (rel > 2.5) {
        if (this.grounded && this.state !== 'hop') { this.vy = Math.max(this.vy, KART.bump.hop * 6); this.grounded = false; }
        if (other.grounded && other.state !== 'hop') { other.vy = Math.max(other.vy, KART.bump.hop * 6); other.grounded = false; }
      }
      this.lastBump = this.time; other.lastBump = other.time;
      if (this.events && rel > 2) this.events.emit('bump', { a: this.id, b: other.id, speed: rel });
    }
    return true;
  }

  /** Begin the fall, splash, fade, respawn sequence. Counts a respawn. */
  startRespawn() {
    if (this.state === 'fall' || this.state === 'respawn') return;
    this.state = 'fall'; this.respawnT = 0; this.respawnPhase = 'fall'; this.fadeAlpha = 0;
    this.drift.active = false; this.drift.charge = 0; this.drift.tier = 0;
    this.boost = 0; this.boostAmount = 0; this.spinAngle = 0;
    this.respawns += 1;
    this._lastRespawnPoint.progress = this.progress;
    this._fallTime = 0;
    if (this.events) this.events.emit('fallStart', { id: this.id });
  }

  _stepRespawn(dt) {
    const R = KART.respawn;
    this.respawnT += dt;
    const t = this.respawnT;
    if (t < R.fall) {
      // keep falling under gravity, no steering, the kart tumbles a little (view reads spinAngle)
      this.respawnPhase = 'fall';
      this.vy -= KART.gravity * dt;
      this.pos.x += this.vel.x * dt; this.pos.z += this.vel.z * dt; this.pos.y += this.vy * dt;
      this.vel.y = this.vy;
      this.spinAngle += dt * 2.5;
      this.grounded = false;
      this.fadeAlpha = 0;
      return;
    }
    if (t < R.fall + R.fade) {
      if (this.respawnPhase === 'fall') {
        this.respawnPhase = 'fade';
        if (this.events) this.events.emit('respawn', { id: this.id });
      }
      this.state = 'respawn';
      const k = (t - R.fall) / R.fade;
      this.fadeAlpha = k < 0.5 ? k * 2 : 1;
      if (k >= 0.5 && !this._placedThisRespawn) { this._placeOnSpline(); this._placedThisRespawn = true; }
      this.vel.set(0, 0, 0); this.speed = 0;
      return;
    }
    if (t < R.fall + R.fade + R.hold) {
      this.respawnPhase = 'hold';
      if (!this._placedThisRespawn) { this._placeOnSpline(); this._placedThisRespawn = true; }
      const k = (t - R.fall - R.fade) / R.hold;
      this.fadeAlpha = Math.max(0, 1 - k * 2.5);
      this.vel.set(0, 0, 0); this.speed = 0; this.grounded = true;
      return;
    }
    this.respawnPhase = null; this.fadeAlpha = 0; this._placedThisRespawn = false;
    this.invuln = R.invuln;
    this.state = 'race';
  }

  _placeOnSpline() {
    const s = this.spline;
    this.spinAngle = 0; this.vy = 0; this.vel.set(0, 0, 0);
    if (!s || typeof s.point !== 'function') {
      // no spline: back to where the fall began, on the ground
      const gy = this.world && this.world.groundAt ? (this.world.groundAt(this.pos.x, this.pos.z) || {}).y : 0;
      this.pos.y = (Number.isFinite(gy) ? gy : 0) + 0.4; this.groundY = this.pos.y - 0.4;
      return;
    }
    const lapLen = s.length || s.lapLength || (s.samples && s.samples.length ? s.samples[s.samples.length - 1].s : 1061) || 1061;
    let p = this._lastRespawnPoint.progress + 3 / lapLen;
    p -= Math.floor(p);
    const pt = s.point(p, 0, new THREE.Vector3());
    const tg = s.tangent(p, new THREE.Vector3());
    this.pos.set(pt.x, pt.y + 0.4, pt.z);
    this.groundY = pt.y;
    this.heading = datan2(tg.x, tg.z);
    this.grounded = true;
    this.groundNormal.set(0, 1, 0);
    this.tilt.roll = 0; this.tilt.pitch = 0;
    this.splineIndex = -1;
    this._updateProgress(true);
    this._prevProgress = this.progress;
  }
}

/** progress difference wrapped to -0.5..0.5 */
function wrapAngleProgress(d) { d = d - Math.round(d); return d; }
/** progress wrapped to 0..1 */
function wrapP(p) { return p - Math.floor(p); }

/**
 * Kart against kart for a whole field. O(n^2) over 8 bodies is 28 pairs; call once per frame after
 * every body.update(). Bodies in a respawn or the countdown do not collide.
 */
export function resolveBumps(bodies) {
  let hits = 0;
  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i];
    if (a.state === 'fall' || a.state === 'respawn' || a.state === 'countdown') continue;
    for (let j = i + 1; j < bodies.length; j++) {
      const b = bodies[j];
      if (b.state === 'fall' || b.state === 'respawn' || b.state === 'countdown') continue;
      if (Math.abs(a.pos.x - b.pos.x) > 2 || Math.abs(a.pos.z - b.pos.z) > 2) continue;
      if (a.bumpWith(b)) hits++;
    }
  }
  return hits;
}
