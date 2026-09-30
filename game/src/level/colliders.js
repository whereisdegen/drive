/**
 * DRIVE  src/level/colliders.js  (owner: level)
 *
 * The town's collision footprint, separated from the town's geometry.
 *
 * buildLevel() has to load 49 assets, bake them into blocks and hand them to the material
 * system before it can put a wall in the world. None of that is needed to know WHERE the walls
 * are: a collider's position and size come from PLACEMENTS and the SIZES table, both of which
 * are plain data. Splitting the two lets the verification oracle construct exactly the circuit
 * the player drove without a canvas, a texture or a GPU - and, more importantly, lets it do so
 * from the SAME code, so the two can never drift into disagreeing about where a wall is.
 *
 * build.js calls this; so does src/token/simcore.js. There is one implementation.
 *
 * A note on density. The phone tier drops half the spectator groups and boulders (they are in
 * DENSITY_ASSETS), and two of those carry colliders - so the track a phone collides with is
 * genuinely not the track a desktop collides with. That is fine for a casual race and fatal for
 * a staked one, which is why a staked run always builds this at density 1. See
 * docs/DETERMINISM.md.
 */
import * as THREE from 'three';
// Deterministic transcendentals, not the host's: Math.sin/cos/tan/atan2/pow/exp/hypot are not
// specified to the last bit by ECMAScript and Chrome and Node genuinely disagree, which over a
// 15 000 tick race is the difference between two cars. See src/token/detmath.js.
import { dcos, dsin } from '../token/detmath.js?v=r6-20260906191941';
import {
  expandPlacements, houseWalls, SIZES, CYLINDER_ASSETS, NO_COLLIDER, DENSITY_ASSETS, SINK,
} from './placements.js?v=r6-20260906191941';

const DEG2RAD = Math.PI / 180;

/** deterministic golden ratio stride, no rng needed */
export function densityKeep(index, density) {
  if (density >= 1) return true;
  return ((index * 0.6180339887) % 1) < density;
}

/**
 * The placement list after the tier's density filter. A crowd RUN is kept or dropped whole
 * (every second card of a run exposed every cut edge on the phone tier).
 */
export function levelPlacements({ spline, road, terrain, density = 1 }) {
  const list = expandPlacements({ spline, road, terrain });
  const densityIndex = new Map();
  const runKeep = new Map();
  return list.filter((p) => {
    if (!DENSITY_ASSETS.has(p.asset)) return true;
    if (p.asset === 'spectator_group' && p.run !== undefined) {
      if (!runKeep.has(p.run)) { const i = densityIndex.get('crowd_run') || 0; densityIndex.set('crowd_run', i + 1); runKeep.set(p.run, densityKeep(i, density)); }
      return runKeep.get(p.run);
    }
    const i = densityIndex.get(p.asset) || 0; densityIndex.set(p.asset, i + 1);
    return densityKeep(i, density);
  });
}

/** where a placement sits, before its collider is centred on it */
export function placementY(p, heightAt) {
  if (typeof p.y === 'number') return p.y;
  const px = p.probe ? p.probe[0] : p.x, pz = p.probe ? p.probe[1] : p.z;
  return heightAt(px, pz) + (p.lift || 0) + (p.dy || 0) - SINK;
}

/**
 * Register one placement's collider(s). Moved verbatim out of build.js, including every comment
 * that explains why a given prop is round rather than square - those reasons were paid for.
 * @returns {number} colliders added
 */
export function addPlacementCollider(T, world, p, size, y) {
  if (!world || NO_COLLIDER.has(p.asset) || p.moving || !size) return 0;
  const [w, d, h] = size;
  const yaw = p.rot * DEG2RAD;
  let n = 0;

  if (p.asset === 'rock_tunnel') {
    // the tunnel collides as two side walls with the 12 m opening cut out (clear 12 of the 20 m width)
    if (world.addBox) {
      const c = dcos(yaw), s = dsin(yaw);
      for (const side of [-1, 1]) {
        const lx = side * 8, cx = p.x + lx * c, cz = p.z - lx * s;
        world.addBox(new T.Vector3(cx, y + h / 2, cz), new T.Vector3(4, h, d), yaw, 'tunnel'); n++;
      }
    }
    return n;
  }
  // Round 1 (fix, level): every collider that stands ON a drivable margin (the pavement, the quay strip, the
  // lay by) is a cylinder or a chain of cylinders, never a box. The World slides a kart along a face, but a
  // face square to the travel direction has no tangent to slide along, so a kart riding the pavement was
  // pinned by the start gantry's east leg, the gate piers, the market tyre walls and the quay davit (gate
  // runs: 0 to 8 stalls, 15 s against the davit). A round contact deflects: the kart rolls off to one side.
  const cyl = (cx, cz, r, hh, tag) => { world.addCylinder(new T.Vector3(cx, y + hh / 2, cz), r, hh, tag); n++; };
  const c = dcos(yaw), s = dsin(yaw);
  const local = (lx, lz) => [p.x + lx * c + lz * s, p.z - lx * s + lz * c];

  if (p.asset === 'start_gantry' || p.asset === 'lap_arch' || p.asset === 'town_gate_arch') {
    // arches collide by their piers only, each a cylinder that covers the square pier's corners
    if (world.addCylinder) {
      const pier = p.asset === 'start_gantry' ? 1.2 : p.asset === 'lap_arch' ? 0.8 : 1.75;
      for (const side of [-1, 1]) {
        const [cx, cz] = local(side * (w / 2 - pier / 2), 0);
        cyl(cx, cz, pier * 0.72, h, p.tag);
      }
    }
    return n;
  }
  if (p.asset === 'tyre_wall' && world.addCylinder) {
    // a capsule: three cylinders along the long axis, so the END of a tyre wall is round and a kart that
    // runs along the kerb line into it slides round instead of stopping dead against a 0.7 m flat end
    for (const lx of [-0.62, 0, 0.62]) { const [cx, cz] = local(lx, 0); cyl(cx, cz, 0.42, h, p.tag); }
    return n;
  }
  if (p.asset === 'harbour_davit' && world.addCylinder) {
    // the pedestal only (0.6 m square at the base); the jib reaches out 2.8 m at 3.4 m, above a driver's helmet
    cyl(p.x, p.z, 0.5, h, p.tag);
    return n;
  }
  if ((p.asset === 'pit_toolcart' || p.asset === 'produce_crate_stack') && world.addCylinder) {
    cyl(p.x, p.z, Math.max(w, d) / 2 * 0.95, h, p.tag);
    return n;
  }
  if (p.asset === 'quay_edge_module' && world.addBox) {
    // round 3 (integrator): the modules moved from the deck to the water line (level, item 5), which put the top of this 1.6 m
    // collider AT deck level and the harbour straight lost its barrier: both final gate runs fell into the harbour 5 s after GO.
    // The box stands on the deck (0.2 m under to 1.4 m over it) whatever the module's y; the coping is drawn where the level put it
    world.addBox(new T.Vector3(p.x, y + h + 0.4, p.z), new T.Vector3(w, h, d), yaw, p.tag); n++;
    return n;
  }
  if (CYLINDER_ASSETS.has(p.asset) && world.addCylinder) {
    const r = p.asset === 'clock_tower' || p.asset === 'lighthouse' || p.asset === 'fountain' ? Math.min(w, d) / 2 : Math.min(w, d) / 2 * 0.5;
    world.addCylinder(new T.Vector3(p.x, y + h / 2, p.z), Math.max(0.12, r), h, p.tag); n++;   // geometric centre, as addBox
  } else if (world.addBox) {
    world.addBox(new T.Vector3(p.x, y + h / 2, p.z), new T.Vector3(w, h, d), yaw, p.tag); n++;
  }
  return n;
}

/** the continuous house front walls */
export function addHouseWalls(T, world, heightAt) {
  if (!world || !world.addWallSegment) return 0;
  let n = 0;
  for (const wsg of houseWalls()) {
    const a = new T.Vector3(wsg.a[0], heightAt(wsg.a[0], wsg.a[1]), wsg.a[1]);
    const b = new T.Vector3(wsg.b[0], heightAt(wsg.b[0], wsg.b[1]), wsg.b[1]);
    world.addWallSegment(a, b, wsg.height, 'house_' + wsg.tag); n++;
  }
  return n;
}

/**
 * Build the whole town's collision set into `world`, in the same ORDER buildLevel registers it
 * (placement list order, then the house walls) - the World resolves contacts in the order its
 * spatial hash returns them, so order is part of the physics, not a detail.
 *
 * @param {object} o
 * @param {Set<string>} [o.missing]  assets whose files are absent; their placements are skipped,
 *                                   exactly as buildLevel skips them
 * @returns {number} colliders added
 */
export function registerLevelColliders(T, { world, spline, road, terrain, density = 1, missing = null, list = null } = {}) {
  const heightAt = terrain && terrain.heightAt ? (x, z) => terrain.heightAt(x, z) : () => 0;
  const items = list || levelPlacements({ spline, road, terrain, density });
  let n = 0;
  for (const p of items) {
    if (missing && missing.has(p.asset)) continue;
    n += addPlacementCollider(T || THREE, world, p, SIZES[p.asset], placementY(p, heightAt));
  }
  n += addHouseWalls(T || THREE, world, heightAt);
  return n;
}
