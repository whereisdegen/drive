/**
 * DRIVE  src/token/simcore.js  (owner: token)
 *
 * THE deterministic time-trial simulation. This exact module runs in two places - the player's
 * browser and the oracle's Node process - and both must reach the same clock from the same
 * inputs, because the oracle's replay is what settles real tokens on chain.
 *
 * What makes it deterministic:
 *   1 FIXED timestep. main.js drives the normal race with a clamped real dt, which is
 *     frame-rate dependent; a staked run instead steps at exactly TICK seconds, so the same
 *     inputs integrate identically on a 144 Hz laptop and on a headless server.
 *   2 NO items, NO AI, NO bumps. A staked run is a solo time trial, which removes every
 *     Math.random() call on the motion path (items.js and ai/racer.js are simply never
 *     constructed) and every interaction with another body.
 *   3 QUANTISED inputs. steer and throttle arrive as int8 (-127..127), so an analog touch
 *     steer cannot carry a float that survives one machine and not another.
 *
 * The only Math.random() left inside physics.js is the kerb rumble kick at physics.js:475,
 * which writes kerbHopV -> kerbHop, and kerbHop is read exclusively by kartview.js to lift the
 * body mesh (kartview.js:1063). It never re-enters the motion state, so it cannot move the
 * clock. Nothing in physics/race/spline/collision/road is patched by this module.
 *
 *   const sim = await createTimeTrial({ THREE, laps: 3 });
 *   sim.reset(); sim.start();
 *   sim.step({ throttle: 127, steer: 0, hop: false });   // exactly one TICK
 *   sim.result();   // { finished, totalMs, lapMs: [...] }
 *
 * Residual risk, stated plainly: IEEE-754 arithmetic is exact and reproducible, but the
 * transcendentals physics.js uses (Math.sin, Math.cos, Math.pow) are NOT specified to the last
 * ulp by ECMAScript, so a different JS ENGINE may differ by one ulp and, over ~13 000 ticks,
 * chaos can amplify that. Client and oracle are both V8 (Chrome/Edge and Node), where the
 * implementations are identical. trace.js carries periodic state digests so a divergent run is
 * DETECTED and rejected rather than silently mis-timed, and the oracle's clock - never the
 * client's - is the one that settles. See docs/DETERMINISM.md.
 */
const V = '?v=r6-20260906191941';

export const TICK_HZ = 100;
export const TICK = 1 / TICK_HZ;
export const DEFAULT_LAPS = 3;

/** the player starts a time trial on pole: a solo run has no grid to fight through */
export const POLE_SLOT = 0;

/**
 * A staked run always collides with the FULL town, whatever the renderer is drawing. The phone
 * tier's density of 0.5 drops half the spectator groups and boulders, and those carry colliders,
 * so without this a phone would be timed on a slightly emptier circuit than a desktop.
 */
export const STAKE_DENSITY = 1;
const DEG = Math.PI / 180;

/**
 * Build the track once. Heavy (road + terrain + collision world), so callers cache it:
 * the browser builds it during boot, the oracle builds it once at server start.
 */
export async function buildSimTrack(THREE) {
  const { SPLINE, START_PROGRESS, CHECKPOINTS } = await import('../track/spline.js' + V);
  const { buildRoad } = await import('../track/road.js' + V);
  const { buildTerrain } = await import('../track/terrain.js' + V);
  const { World } = await import('../track/collision.js' + V);
  const { GRID } = await import('../level/placements.js' + V);
  const { registerLevelColliders } = await import('../level/colliders.js' + V);

  const spline = SPLINE;
  const road = buildRoad(THREE, spline, {});
  const terrain = buildTerrain(THREE, spline);
  const world = stakeWorld(THREE, { spline, road, terrain, World, registerLevelColliders });

  return {
    spline, road, terrain, world,
    slots: gridSlots(world, spline, GRID),
    startProgress: START_PROGRESS, checkpoints: CHECKPOINTS,
  };
}

/**
 * The collision world a staked run is driven and verified in.
 *
 * The browser passes the spline, road and terrain the game already built (all three are
 * independent of the render tier - road.js only reads opts.tier for its shadow cast distance);
 * the oracle passes ones it built headless. Both then get the same 927 colliders in the same
 * order, because both come through here.
 */
export function stakeWorld(THREE, { spline, road, terrain, World, registerLevelColliders }) {
  const world = new World(terrain, spline, road);
  // the town's walls, benches, tyre stacks and harbour edge - without loading a single asset.
  // ALWAYS at density 1: the phone tier drops half the spectator groups and boulders, two of
  // which carry colliders, and a staked run has to be the same circuit on every device.
  registerLevelColliders(THREE, { world, spline, road, terrain, density: STAKE_DENSITY });
  return world;
}

/**
 * The grid, in the plan's own order. A time trial only ever uses POLE_SLOT, but the browser and
 * the oracle must agree on it to the last bit - a start line 5 cm apart is a different race - so
 * both sides call this rather than each computing its own.
 */
export function gridSlots(world, spline, GRID) {
  return GRID.map((g) => {
    const gnd = world.groundAt(g.x, g.z);
    const y = gnd && Number.isFinite(gnd.y) ? gnd.y
      : (Number.isFinite(spline.roadY(g.x, g.z)) ? spline.roadY(g.x, g.z) : 0.2);
    return { x: g.x, y: y + 0.05, z: g.z, heading: g.rot * DEG };
  });
}

/**
 * A solo, fixed-step time trial over a prebuilt track.
 * @param {object} o
 * @param {*} o.THREE
 * @param {object} [o.track]   from buildSimTrack; built on demand when omitted
 * @param {number} [o.laps=3]
 * @param {*} [o.events]       optional bus; the oracle passes none, the browser passes the game's
 */
export async function createTimeTrial({ THREE, track = null, laps = DEFAULT_LAPS, events = null } = {}) {
  const t = track || await buildSimTrack(THREE);
  const { KartBody } = await import('../kart/physics.js' + V);
  const { Race } = await import('../game/race.js' + V);

  const body = new KartBody({ world: t.world, spline: t.spline, id: 1, events });
  const pole = t.slots[POLE_SLOT];
  const race = new Race({
    events, bodies: [body], spline: t.spline, laps,
    names: { 1: 'You' }, playerId: 1, grid: [pole],
    startProgress: t.startProgress, checkpoints: t.checkpoints,
    holdAfterPlayer: 0,        // solo: the race is over the instant the driver crosses the line
  });

  let ticks = 0;

  const api = {
    TICK, TICK_HZ, laps, track: t, body, race,
    get ticks() { return ticks; },
    get state() { return race.state; },
    /** race clock in seconds; 0 until GO */
    get time() { return race.time; },

    reset() { ticks = 0; race.reset(); normalizeBody(body); },
    start() { race.start(); },

    /**
     * Advance exactly one TICK. `input` is the quantised trace frame.
     * Order matches main.js minus the systems a time trial does not have.
     * @param {{throttle:number, steer:number, hop:boolean}} input  throttle/steer as int8
     */
    step(input) {
      stepOnce(body, race, input, events);
      ticks++;
      return race.state;
    },

    /** a cheap, stable fingerprint of the motion state, for divergence detection */
    digest() {
      return digestOf(body, race);
    },

    result() {
      const r = race.records.get(1);
      const done = !!(r && r.finished);
      return {
        finished: done,
        totalMs: done ? msOf(r.total) : null,
        lapMs: r ? r.lapTimes.map(msOf) : [],
        bestLapMs: r && r.bestLap != null ? msOf(r.bestLap) : null,
        laps,
        ticks,
        respawns: body.respawns | 0,
        distance: Math.round(body.distance || 0),
      };
    },
  };
  return api;
}

/**
 * Put a KartBody into the exact state a freshly constructed one is in.
 *
 * race.reset() clears everything that decides where the kart goes, but a body that has already
 * raced also carries view-side leftovers (the smoothed steering angle the front wheels are
 * drawn at, the kerb spring, the cobble shake). Today none of those re-enter the motion path,
 * so none of them can move the clock - but "today" is not a guarantee worth staking tokens on,
 * and auditing that list again after every change to physics.js is not a plan. Both sides call
 * this before a staked run, so the two bodies are equal by construction rather than by audit.
 */
export function normalizeBody(body) {
  body._steerSmoothed = 0;
  body.steerAngle = 0;
  body.spinAngle = 0;
  body.wheelSpin = 0;
  body.cobbleShake = 0;
  body._fallTime = 0;
  body._kerbRumbleT = 0;
  body.kerbHop = 0; body.kerbHopV = 0; body.kerbT = 0; body.kerbHits = 0; body.kerbSide = 0;
  body.kerbOn = false;
  body._kerbOnSide = [false, false];
  body.tilt.roll = 0; body.tilt.pitch = 0;
  body.shielded = false;
  body.boost = 0; body.boostAmount = 0;
  body.lastBump = 0;
  body.wallHit = false; body.wallT = 0;
  body.input.throttle = 0; body.input.steer = 0; body.input.hop = false; body.input.item = false;
  return body;
}

/**
 * ONE simulation tick, and the only place either side is allowed to advance a staked run.
 * The browser calls this on the body it is already rendering; the oracle calls it on a body it
 * built headless. Same function, same order, same fixed dt - so there is one implementation of
 * "what happens in a tick" rather than two that have to be kept in agreement.
 */
export function stepOnce(body, race, input, events = null) {
  const bi = body.input;
  bi.throttle = clamp8(input && input.throttle) / 127;
  bi.steer = clamp8(input && input.steer) / 127;
  bi.hop = !!(input && input.hop);
  bi.item = false;
  if (events && typeof events.tick === 'function') events.tick(TICK);
  body.update(TICK);
  race.update(TICK);
}

export function clamp8(v) {
  const n = Math.round(Number(v) || 0);
  return n > 127 ? 127 : n < -127 ? -127 : n;
}

/** seconds -> integer milliseconds; the on-chain unit is the millisecond */
export function msOf(sec) {
  return Number.isFinite(sec) ? Math.round(sec * 1000) : null;
}

/**
 * 32-bit digest of the values that define the motion state. Quantised to 1/1024 m and
 * 1/4096 rad so a harmless last-ulp difference does not trip it, while a real divergence
 * (a different line, a wall the other machine did not hit) does.
 */
export function digestOf(body, race) {
  let h = 0x811c9dc5 >>> 0;
  const mix = (n) => {
    h ^= n >>> 0; h = Math.imul(h, 0x01000193) >>> 0;
  };
  mix(Math.round(body.pos.x * 1024));
  mix(Math.round(body.pos.y * 1024));
  mix(Math.round(body.pos.z * 1024));
  mix(Math.round(body.heading * 4096));
  mix(Math.round(body.speed * 1024));
  mix(Math.round((body.progress || 0) * 65536));
  mix((body.lap | 0) * 31 + (body.respawns | 0));
  if (race) mix(Math.round((race.time || 0) * 1000));
  return h >>> 0;
}
