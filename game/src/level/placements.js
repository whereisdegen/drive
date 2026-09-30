/**
 * DRIVE  src/level/placements.js  (owner: level)
 *
 * docs/TRACK-PLAN.md section 7 as data plus deterministic generators (seed 17) for the rule
 * sets. No three.js import: this file is pure data and maths so it runs in node for its own
 * tests (work/level/check.mjs) and in the browser for the build.
 *
 * Conventions (TRACK-PLAN section 1): metres, +X east, +Z south, +Y up. `rot` is degrees about
 * +Y, counter clockwise seen from above; rot 0 means the object's front (+Z face) faces south,
 * rot 90 east, rot 180 north, rot 270 west. An object's local X axis at rot r points along
 * (cos r, -sin r) in (x, z). Every rotation below is DERIVED from what must face where (fronts
 * face the road, water sides face the water), not copied from the plan's rot column, because
 * the plan and the TSV disagree on a few (quay edge, breakwater west arm, lap arch, gate arch,
 * lifeguard hut): see work/level/NOTES.md.
 *
 * A placement:
 *   { asset, x, z, rot, y, moving, tag, block, probe?, lift?, dy?, tilt?, bob? }
 *   y: null      terrain height at probe (or x, z) plus lift plus dy minus the 0.04 sink (build.js)
 *   y: number    absolute (boats at water level, bunting at road y + 6, cliff rocks at road y - 8)
 *   probe        [x, z] where the terrain height is sampled (a house's front centre, a wall's downhill foot)
 *   lift         metres added on top of the terrain height (bollards on the breakwater cap)
 *   dy           small extra offset (kerb modules 6 cm up so they top the road mesh substrate)
 *   tilt         degrees of lean (palms), applied about a horizontal axis, never a scale
 *   bob          mover parameters { amp, period, roll, phase }
 *
 * The track is sampled here from the same 59 waypoints src/track/spline.js uses (uniform
 * Catmull-Rom, closed, 1.5 m table) so kerb stations, wall stations, bunting heights and cliff
 * edges exist without the track module. When build.js is handed the real road and terrain it
 * prefers road.kerbs, road.wallStations and terrain.cliffEdge (expandPlacements below).
 */
// Deterministic transcendentals, not the host's: Math.sin/cos/tan/atan2/pow/exp/hypot are not
// specified to the last bit by ECMAScript and Chrome and Node genuinely disagree, which over a
// 15 000 tick race is the difference between two cars. See src/token/detmath.js.
import { datan2, dcos, dhypot, dsin } from '../token/detmath.js?v=r6-20260906191941';

// ------------------------------------------------------------------------------------ data
/** TRACK-PLAN section 3: [x, z, y, width, bank, section] */
export const WAYPOINTS = [
  [-134, -6, 0.2, 14, 0, 'A'], [-134, -22, 0.2, 14, 0, 'A'], [-134, -39, 0.2, 14, 0, 'A'], [-134, -56, 0.2, 14, 0, 'A'],
  [-134, -73, 0.2, 14, 0, 'A'], [-134, -90, 0.2, 14, 0, 'A'], [-134, -106, 0.2, 14, 0, 'A'],
  [-132, -125, 0.5, 12, 3, 'B'], [-123, -141, 1.0, 12, 4, 'B'], [-108, -152, 1.5, 12, 4, 'B'], [-87, -157, 2.0, 12, 2, 'B'],
  [-67, -158, 2.7, 11, 0, 'C'], [-45, -160, 3.5, 11, 0, 'C'], [-22, -161, 4.3, 11, 0, 'C'], [0, -159, 5.1, 11, 0, 'C'],
  [22, -156, 6.0, 11, 0, 'C'], [45, -155, 6.7, 11, 0, 'C'], [67, -156, 7.4, 11, 0, 'C'], [90, -158, 8.0, 11, 0, 'C'],
  [112, -158, 8.3, 11, 0, 'C'],
  [132, -156, 8.6, 12, 4, 'D'], [148, -148, 9.0, 12, 6, 'D'], [157, -134, 9.5, 12, 7, 'D'], [159, -119, 9.9, 12, 7, 'D'],
  [153, -104, 10.3, 12, 6, 'D'], [141, -95, 10.7, 12, 4, 'D'], [125, -92, 11.0, 12, 2, 'D'],
  [108, -92, 11.3, 11, 0, 'E'], [92, -92, 11.6, 11, 0, 'E'], [78, -86, 12.0, 11, -3, 'E'], [69, -74, 12.4, 11, -4, 'E'],
  [65, -58, 13.1, 11, -2, 'E'],
  [67, -40, 13.9, 11, 0, 'F'], [74, -25, 14.9, 11, 0, 'F'], [72, -9, 15.9, 11, 0, 'F'], [63, 4, 16.9, 11, 0, 'F'],
  [60, 20, 17.9, 11, 0, 'F'], [65, 36, 18.9, 11, 0, 'F'], [67, 52, 19.6, 11, 0, 'F'], [65, 67, 20.1, 11, 0, 'F'],
  [60, 83, 20.6, 11, 3, 'G'], [49, 96, 21.1, 11, 4, 'G'], [34, 106, 21.5, 11, 4, 'G'], [13, 112, 21.9, 11, 2, 'G'],
  [-7, 114, 22.4, 11, 0, 'H'], [-27, 118, 23.1, 11, 0, 'H'], [-47, 119, 23.7, 11, 0, 'H'], [-67, 116, 24.1, 11, 0, 'H'],
  [-87, 114, 23.7, 11, 0, 'H'], [-108, 114, 23.1, 11, 0, 'H'],
  [-125, 112, 22.1, 11, 2, 'I'], [-141, 105, 19.9, 11, 4, 'I'], [-152, 94, 17.1, 11, 5, 'I'], [-159, 80, 13.8, 11, 5, 'I'],
  [-160, 63, 10.1, 11, 3, 'I'], [-157, 47, 6.5, 11, 0, 'I'], [-150, 32, 3.5, 12, 0, 'I'], [-142, 19, 1.3, 13, 0, 'I'],
  [-138, 7, 0.5, 14, 0, 'I'],
];

/** docs/OBJECTS.tsv: name -> [width, depth, height, count_in_map, moving] */
export const SIZES = {
  kart_chassis: [1.20, 1.60, 0.62, 8, false], kart_wheel: [0.24, 0.44, 0.44, 32, true], driver_racer: [0.60, 0.55, 1.10, 8, true],
  results_podium: [6.00, 2.40, 1.20, 1, false], pit_toolcart: [0.90, 0.60, 1.10, 4, false], item_box: [1.00, 1.00, 1.00, 14, true],
  chaser_buoy: [0.50, 0.70, 0.60, 0, true], cannonball: [0.45, 0.45, 0.45, 0, true], spill_crate: [0.70, 0.50, 0.45, 0, true],
  espresso_cup: [0.50, 0.50, 0.50, 0, true], foam_shield: [2.40, 2.40, 2.40, 0, true], boost_pad: [3.00, 4.00, 0.06, 7, false],
  kerb_module: [4.00, 0.60, 0.30, 230, false], stone_guardwall: [4.00, 0.50, 0.90, 40, false], tyre_wall: [2.00, 0.70, 1.20, 24, false],
  harbour_bollard: [0.50, 0.50, 0.90, 40, false], bunting_run: [11.00, 0.20, 1.20, 22, false], start_gantry: [18.00, 2.40, 7.50, 1, false],
  lap_arch: [14.00, 1.60, 6.50, 1, false], race_flag_pole: [1.60, 0.30, 4.20, 30, false], grandstand_small: [12.00, 6.00, 4.80, 2, false],
  cafe_terrace: [8.00, 6.00, 2.60, 3, false], spectator_group: [3.50, 1.50, 2.55, 26, true], street_lamp: [0.80, 0.80, 4.50, 34, false],
  market_stall: [3.00, 2.40, 2.80, 8, false], produce_crate_stack: [1.20, 1.00, 1.30, 16, false], house_narrow_tall: [8.00, 10.00, 11.60, 14, false],
  house_wide_2storey: [12.00, 10.00, 8.40, 12, false], house_corner_shop: [10.00, 10.00, 8.40, 6, false], house_arcade: [12.00, 10.00, 11.60, 6, false],
  house_balcony_row: [10.00, 10.00, 11.60, 10, false], town_stair_module: [3.00, 6.00, 3.00, 8, false], retaining_wall_terrace: [6.00, 0.80, 3.00, 40, false],
  church_belltower: [16.00, 26.00, 24.00, 1, false], clock_tower: [5.00, 5.00, 17.00, 1, false], lighthouse: [7.00, 7.00, 18.00, 1, false],
  fountain: [6.00, 6.00, 3.20, 1, false], rock_tunnel: [20.00, 24.00, 12.00, 1, false], town_gate_arch: [15.00, 3.00, 10.00, 1, false],
  harbour_wall_module: [6.00, 6.00, 2.60, 30, false], quay_edge_module: [6.00, 1.20, 1.60, 24, false], jetty_module: [8.00, 2.50, 1.40, 9, false],
  fishing_boat: [3.00, 8.50, 3.60, 7, true], rowing_boat: [1.60, 4.20, 0.80, 6, true], mooring_buoy: [0.90, 0.90, 1.30, 8, true],
  harbour_davit: [1.20, 3.60, 3.40, 2, false], palm_tall: [7.00, 7.00, 9.00, 16, false], palm_short: [6.00, 6.00, 6.50, 12, false],
  pine_umbrella: [10.00, 10.00, 11.00, 14, false], bougainvillea_card: [3.00, 1.40, 4.00, 24, false], rock_cliff_module: [8.00, 6.00, 7.00, 30, false],
  rock_boulder: [2.40, 2.00, 1.60, 20, false], beach_umbrella: [2.40, 2.40, 2.30, 12, false], agave_cluster: [1.80, 1.80, 1.20, 14, false],
  deck_chair: [0.60, 1.30, 0.90, 14, false], lifeguard_hut: [3.00, 3.00, 4.60, 1, false], pedalo: [1.80, 3.20, 1.40, 3, false],
  sign_chevron_board: [2.40, 0.30, 1.60, 18, false], sign_round_post: [0.80, 0.30, 2.60, 12, false], rock_sea_stack: [12.00, 10.00, 14.00, 3, false],
};

/** count_in_map from the TSV for the counts check (build.js warns over 20% off; the rule sets are the truth) */
export const COUNTS_EXPECTED = Object.fromEntries(Object.entries(SIZES).map(([k, v]) => [k, v[3]]));

/** assets that collide as a cylinder (radius = half the smaller footprint side), everything else as a box */
export const CYLINDER_ASSETS = new Set(['palm_tall', 'palm_short', 'pine_umbrella', 'street_lamp', 'harbour_bollard',
  'rock_boulder', 'race_flag_pole', 'fountain', 'clock_tower', 'lighthouse', 'sign_round_post', 'mooring_buoy']);

/** assets that get NO collider (drive over, hang above, or flush against a wall) */
export const NO_COLLIDER = new Set(['kerb_module', 'boost_pad', 'bunting_run', 'bougainvillea_card', 'agave_cluster', 'deck_chair']);

/** assets whose count follows the tier density (quality.js TIERS.density) */
export const DENSITY_ASSETS = new Set(['spectator_group', 'bougainvillea_card', 'agave_cluster', 'rock_boulder', 'deck_chair']);

export const SINK = 0.04;
/** chevron boards on a pavement are turned this many degrees toward the road so a kart slides off them (round 1) */
export const CHEVRON_TURN = 40;
export const SEA_LEVEL = -1.4;
export const SEED = 17;

// ------------------------------------------------------------------------------------ maths
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const DEG = 180 / Math.PI;
const norm360 = (d) => ((d % 360) + 360) % 360;
/** rotation (degrees) whose +Z face points along the world direction (dx, dz) */
export const facing = (dx, dz) => norm360(datan2(dx, dz) * DEG);
/** rotation whose local X axis lies along the tangent (tx, tz) and whose +Z face points to the RIGHT of travel */
export const alongRoad = (tx, tz) => facing(-tz, tx);
export const rightOf = (tx, tz) => [-tz, tx];
export const leftOf = (tx, tz) => [tz, -tx];
export const blockOf = (x, z) => `${Math.floor((x + 210) / 30)}_${Math.floor((z + 190) / 30)}`;
const r1 = (v) => Math.round(v * 100) / 100;

// ------------------------------------------------------------------------------------ track sampler
/**
 * Closed uniform Catmull-Rom through WAYPOINTS, sampled every 1.5 m. Same construction as
 * work/lead/centreline.py and src/track/spline.js; the lap comes out 1061 m within 1%.
 */
function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}
let _track = null;
export function trackTable() {
  if (_track) return _track;
  const N = WAYPOINTS.length, SUB = 24;
  const fine = [];
  for (let i = 0; i < N; i++) {
    const P = [WAYPOINTS[(i - 1 + N) % N], WAYPOINTS[i], WAYPOINTS[(i + 1) % N], WAYPOINTS[(i + 2) % N]];
    for (let k = 0; k < SUB; k++) {
      const t = k / SUB;
      const v = (j) => catmull(P[0][j], P[1][j], P[2][j], P[3][j], t);
      fine.push({ x: v(0), z: v(1), y: v(2), width: v(3), bank: v(4), section: WAYPOINTS[i][5], wp: i, k });
    }
  }
  let s = 0;
  const wpS = new Array(N);
  for (let i = 0; i < fine.length; i++) {
    const a = fine[i], b = fine[(i + 1) % fine.length];
    a.s = s;
    if (a.k === 0) wpS[a.wp] = s;
    s += dhypot(b.x - a.x, b.z - a.z);
  }
  const L = s;
  // resample every 1.5 m with tangents
  const samples = [];
  const STEP = 1.5;
  let j = 0;
  for (let d = 0; d < L; d += STEP) {
    while (j + 1 < fine.length && fine[j + 1].s <= d) j++;
    const a = fine[j], b = fine[(j + 1) % fine.length];
    const seg = (j + 1 < fine.length ? b.s : L) - a.s;
    const t = seg > 1e-9 ? (d - a.s) / seg : 0;
    const lerp = (k) => a[k] + (b[k] - a[k]) * t;
    let tx = b.x - a.x, tz = b.z - a.z; const tl = dhypot(tx, tz) || 1; tx /= tl; tz /= tl;
    samples.push({ s: d, progress: d / L, x: lerp('x'), z: lerp('z'), y: lerp('y'), width: lerp('width'), bank: lerp('bank'),
      tx, tz, section: a.section, surface: 'BCDE'.includes(a.section) ? 'cobble' : 'asphalt' });
  }
  _track = { samples, length: L, wpS, wpProgress: wpS.map((v) => v / L) };
  return _track;
}
/** interpolated sample at an arc distance (wraps) */
export function atDistance(s) {
  const T = trackTable(), n = T.samples.length;
  let d = ((s % T.length) + T.length) % T.length;
  const i = Math.min(n - 1, Math.floor(d / 1.5)), a = T.samples[i], b = T.samples[(i + 1) % n];
  const t = (d - a.s) / 1.5;
  const lerp = (k) => a[k] + (b[k] - a[k]) * t;
  let tx = lerp('tx'), tz = lerp('tz'); const tl = dhypot(tx, tz) || 1;
  return { s: d, progress: d / T.length, x: lerp('x'), z: lerp('z'), y: lerp('y'), width: lerp('width'), bank: lerp('bank'), tx: tx / tl, tz: tz / tl, section: a.section };
}
export const atProgress = (p) => atDistance(p * trackTable().length);
/** nearest table sample to a point: { sample, s, progress, lateral (positive right of travel), dist } */
export function nearest(x, z) {
  const T = trackTable();
  let best = null, bd = Infinity;
  for (const sm of T.samples) {
    const dx = x - sm.x, dz = z - sm.z, d = dx * dx + dz * dz;
    if (d < bd) { bd = d; best = sm; }
  }
  const [rx, rz] = rightOf(best.tx, best.tz);
  return { sample: best, s: best.s, progress: best.progress, lateral: (x - best.x) * rx + (z - best.z) * rz, dist: Math.sqrt(bd) };
}
/** road centre height near a point, or NaN when farther than width/2 + 8 from the centreline */
export function roadYNear(x, z) {
  const n = nearest(x, z);
  return n.dist <= n.sample.width / 2 + 8 ? n.sample.y : NaN;
}
/** a point beside the road: side -1 left of travel, +1 right; offset metres from the centreline (0 = centre) */
export function roadside(s, side, offset) {
  const sm = atDistance(s);
  const [rx, rz] = rightOf(sm.tx, sm.tz);
  // rotFaceBackToward(deg): faces the approaching karts but turned `deg` toward the road, so the road side end
  // of the object is upstream. A kart on the pavement that hits it slides along the face back onto the road
  // instead of stopping against a face square to its travel (round 1 wedge fix, chevron boards)
  const toRoad = [-rx * side, -rz * side];
  const rotFaceBackToward = (deg) => { const a = deg / DEG, ca = dcos(a), sa = dsin(a); return facing(-sm.tx * ca + toRoad[0] * sa, -sm.tz * ca + toRoad[1] * sa); };
  return { x: sm.x + rx * side * offset, z: sm.z + rz * side * offset, sm,
    rotFaceRoad: facing(-rx * side, -rz * side), rotFaceAway: facing(rx * side, rz * side),
    rotAlong: alongRoad(sm.tx, sm.tz), rotFaceBack: facing(-sm.tx, -sm.tz), rotFaceAhead: facing(sm.tx, sm.tz), rotFaceBackToward };
}

// ------------------------------------------------------------------------------------ helpers
function P(asset, x, z, rot, extra = {}) {
  if (!SIZES[asset]) throw new Error(`placements: unknown asset ${asset}`);
  const p = { asset, x: r1(x), z: r1(z), rot: r1(norm360(rot)), y: null, moving: false, tag: extra.tag || asset, block: blockOf(x, z) };
  for (const k of ['y', 'moving', 'probe', 'lift', 'dy', 'tilt', 'bob', 'alignRoad', 'paint', 'front', 'end', 'run']) if (extra[k] !== undefined) p[k] = extra[k];
  // Round 2: spectator groups are STATIC. As movers each group was up to 3 draws plus its shadow pass (three card
  // materials, merged per instance); baked into a block its three cards join the one shared card bucket the block
  // already draws for bunting, flags and bougainvillea, so 32 groups cost 0 extra draws instead of about 100 at
  // the town overview (peak draws 968 against the 900 budget in the round 2 gate). The 4 cm bob at 1 Hz they lose
  // is under a pixel beyond 8 m from the chase camera. The bob parameters are dropped here so nothing animates them.
  if (asset === 'spectator_group') { p.moving = false; delete p.bob; }
  if (p.y !== null && p.y !== undefined) p.y = r1(p.y);
  return p;
}

/**
 * A row of houses butted edge to edge. from: [x, z] the row start ON THE FRONT LINE, dir: unit
 * direction the row runs, face: unit direction from the front toward the road, list: asset names.
 * Every third gap on a row with `stairs` gets a 3 m alley with a town_stair_module climbing away
 * from the street. Returns { placements, wall: [a, b] (front line ends for the collision wall), houses }.
 */
function houseRow({ from, dir, face, list, stairs = false, tag }) {
  const out = [], houses = [];
  let cursor = 0, count = 0;
  const rot = facing(face[0], face[1]);
  for (const name of list) {
    const [w, d] = SIZES[name];
    const along = cursor + w / 2;
    const fx = from[0] + dir[0] * along, fz = from[1] + dir[1] * along;   // front centre
    const cx = fx - face[0] * d / 2, cz = fz - face[1] * d / 2;
    out.push(P(name, cx, cz, rot, { probe: [r1(fx), r1(fz)], tag }));
    houses.push({ name, x: cx, z: cz, w, d, rot, fx, fz, along });
    cursor += w; count++;
    if (stairs && count % 3 === 0 && count < list.length) {
      const gx = from[0] + dir[0] * (cursor + 1.5), gz = from[1] + dir[1] * (cursor + 1.5);
      // town_stair_module climbs toward its local -Z; rotated to face the road its top is away from the street
      out.push(P('town_stair_module', gx - face[0] * 3, gz - face[1] * 3, rot, { probe: [r1(gx), r1(gz)], tag: tag + '_stairs' }));
      cursor += 3;
    }
  }
  return { placements: out, houses, wall: [[from[0], from[1]], [from[0] + dir[0] * cursor, from[1] + dir[1] * cursor]], rot, face, length: cursor };
}

/**
 * Bougainvillea on the house fronts of a row, at the wall between windows, facing the road.
 * Round 2 (critic: "put saturated objects where the bar has them ... bougainvillea"; the share of
 * strongly saturated pixels was 4 percent of the body against the bar's 19): every house carries a
 * cascade (round 1 was every second house, capped at 7 a side) and a house 12 m wide carries one at
 * each end. The card is the most saturated 12 m^2 in the set and it costs 2 planes and a trough.
 */
function bougainvilleaOn(row, rng, tag, every = 1, max = Infinity, avoid = []) {
  const out = [];
  row.houses.forEach((h, i) => {
    if (i % every !== 0 || out.length >= max) return;
    const side = rng() < 0.5 ? -1 : 1;
    const want = h.w >= 12 ? 2 : 1;
    let placed = 0;
    for (const sd of [side, -side]) {
      if (placed >= want) break;
      const off = sd * (h.w / 2 - 2.2);
      const lx = h.fx + (-row.face[1]) * off, lz = h.fz + (row.face[0]) * off;   // slide along the front line
      const x = lx + row.face[0] * 0.22, z = lz + row.face[1] * 0.22;
      if (!clearOf(avoid, x, z, 1.6)) continue;   // a lamp, flag, board or crowd already stands at that wall: the other end, or none
      out.push(P('bougainvillea_card', x, z, h.rot, { tag })); placed++;
    }
  });
  return out;
}
/** true when no placement in `list` on the same asset class sits within `r` metres of (x, z): keeps pavement furniture apart */
function clearOf(list, x, z, r = 2.5) {
  return !list.some((p) => dhypot(p.x - x, p.z - z) < r);
}
/**
 * A run of n spectator groups (round 3, critic item 5: "the spectators are a rectangular card ... split the crowd into
 * staggered individual cutouts at two depths"). The crowd cutouts in the card atlas are cut through a figure at both
 * side edges (55 to 82 percent of the edge columns are opaque, work/fix3_level/crowd_a.png), so a lone group always
 * ends in a straight vertical edge. A run buries those ends: groups at 2.7 m pitch (the card is 3.0 m) so each end
 * sits inside its neighbour, every second group 0.45 m further from the road (a second depth, its own shadow), inner
 * groups yawed 6 degrees alternately, and the two END groups swung 24 degrees away from the road so the outermost
 * cut edge reads as the row curving back rather than a cut. rot faces the road; the run lies along the group's own
 * width axis (local X at rot r is (cos r, -sin r) in world x, z). Still a card: the texture fix is the render agent's
 * (work/fix3_level/NOTES.md).
 */
function crowdRun(out, x, z, rot, n, tag, opts = {}) {
  const a = rot / DEG, ax = dcos(a), az = -dsin(a);       // along the run
  const fx = dsin(a), fz = dcos(a);                        // facing (toward the road)
  const pitch = opts.pitch || 2.7, back = opts.back === undefined ? 0.45 : opts.back;
  // round 5: `front` (default on) asks build.js for a modelled front row of figures on the ground in front of the
  // group's card stack (level/crowdrow.js); the stack itself (three card layers 0.3 m back and up) is applied to
  // every spectator_group at build time, so a group here is a placement like before
  const front = opts.front === undefined ? true : !!opts.front;
  // `end` marks the run's outer groups (-1 at the local -X end, +1 at +X) so build.js tapers their back layers toward
  // the run and stands a figure over the front layer's cut edge; `run` groups the placements of one run so the phone
  // tier's density drops whole runs, not every second card of a run (which exposed every cut edge)
  const run = crowdRun.count = (crowdRun.count || 0) + 1;
  for (let i = 0; i < n; i++) {
    const t = i - (n - 1) / 2;
    const depth = i % 2 ? back : 0;
    const end = n > 1 && (i === 0 || i === n - 1);
    const yaw = end ? (i === 0 ? -24 : 24) : (i % 2 ? 6 : -6);
    out.push(P('spectator_group', x + ax * t * pitch - fx * depth, z + az * t * pitch - fz * depth, rot + yaw, { tag, front, end: end ? (i === 0 ? -1 : 1) : 0, run }));
  }
}
/**
 * Round 5 (foliage placements): the umbrella pine crown is a set of cards, three of them near vertical at 60 degree
 * spacing through the centre. Placed at a random yaw one of the three faced the chase camera square on along the
 * racing line about a third of the time and the crown read as a flat card. The yaw is now derived from the nearest
 * road tangent so every vertical card sits 30 degrees off the camera's line of sight along the road (the bisector
 * of the 60 degree fan), with a 16 degree jitter from the same random draw the placement always took, so the seeded
 * stream is unchanged for everything placed after a pine. rot = tangent - 31.35 + 60 k: the asset's first vertical
 * card has its normal at azimuth 90 - 28.65 degrees in its own frame (pine_umbrella.js, a = i pi/3 + 0.5).
 */
function pineRot(x, z, r) {
  const n = nearest(x, z);
  const t = facing(n.sample.tx, n.sample.tz);
  const k = Math.floor(r * 6), j = (r * 6 - k - 0.5) * 16;
  return norm360(t - 31.35 + 60 * k + j);
}
/** the stall and crate dressing of a pavement stretch: fronts to the road, only where 3 m of pavement is clear */
function pavementStalls(out, T, s0, s1, side, step, tag, max, crates = true) {
  let n = 0;
  for (let s = s0; s <= s1 && n < max; s += step) {
    const sm = atDistance(s), r = roadside(s, side, sm.width / 2 + 0.6 + 1.25);
    if (!clearOf(out, r.x, r.z, 3.1)) continue;
    out.push(P('market_stall', r.x, r.z, r.rotFaceRoad, { tag })); n++;
    if (crates && n % 2 === 1) { const c = roadside(s + 2.4, side, sm.width / 2 + 0.6 + 0.75); if (clearOf(out, c.x, c.z, 1.3)) out.push(P('produce_crate_stack', c.x, c.z, r.rotFaceRoad + 15, { tag: tag + '_crates' })); }
  }
  return n;
}
/** hull paint for the painted boats (round 2): the style lock's livery colours, in a fixed order per boat class */
export const BOAT_PAINT = [0x2f5fc4, 0xd6402f, 0xf2c230, null, 0xf07a2a, 0x3fc7a0, 0xed5851];   // null keeps the asset's timber teal

// ------------------------------------------------------------------------------------ 7.1 grid, gantry, arch
export const GRID = [
  { x: -137.5, z: -37, rot: 180 }, { x: -130.5, z: -35.5, rot: 180 }, { x: -137.5, z: -29, rot: 180 }, { x: -130.5, z: -27.5, rot: 180 },
  { x: -137.5, z: -21, rot: 180 }, { x: -130.5, z: -19.5, rot: 180 }, { x: -137.5, z: -13, rot: 180 }, { x: -130.5, z: -11.5, rot: 180 },
];
export const ITEM_BOXES = [
  { x: -139, z: -84, y: null }, { x: -135.6, z: -84, y: null }, { x: -132.2, z: -84, y: null }, { x: -128.8, z: -84, y: null },
  { x: 0, z: -162.5, y: null }, { x: 0, z: -159, y: null }, { x: 0, z: -155.5, y: null },
  { x: 62, z: 50, y: null }, { x: 65.3, z: 50, y: null }, { x: 68.7, z: 50, y: null }, { x: 72, z: 50, y: null },
  { x: -97, z: 110.5, y: null }, { x: -97, z: 114, y: null }, { x: -97, z: 117.5, y: null },
  { x: 110, z: -95.4, y: null }, { x: 110, z: -92, y: null }, { x: 110, z: -88.6, y: null },   // R5 piazza exit street (round 1, items request: the R2 to R3 gap was 390 m)
];
export const BOOST_PADS = [
  { x: -137, z: -100, rot: 180 }, { x: -131, z: -100, rot: 180 }, { x: 60, z: -155.7, rot: 90 }, { x: 64, z: 30, rot: 0 },
  { x: -90, z: 114, rot: 270 }, { x: -102, z: 114, rot: 270 }, { x: -147, z: 27, rot: 165 },
];
export const LANDMARKS = {
  church: { x: 181, z: -126 }, clockTower: { x: 46, z: 6 }, lighthouse: { x: -177, z: 121 }, fountain: { x: 136, z: -124 },
  tunnel: { x: -67, z: 116 }, gate: { x: 66, z: -62 }, gantry: { x: -134, z: -45 }, lapArch: { x: 65, z: 60 },
};

// ------------------------------------------------------------------------------------ generators
/** 7.1 landmarks that span the road take their rotation from the local tangent: the face toward the approaching karts */
function genLandmarks() {
  const out = [];
  const spanFacingTraffic = (asset, x, z, tag) => { const n = nearest(x, z); return P(asset, x, z, facing(-n.sample.tx, -n.sample.tz), { tag, alignRoad: true }); };
  out.push(spanFacingTraffic('start_gantry', -134, -45, 'gantry'));
  out.push(spanFacingTraffic('lap_arch', 65, 60, 'lap_arch'));
  out.push(spanFacingTraffic('town_gate_arch', 66, -62, 'gate'));
  {  // the tunnel's axis is Z; its base sits at road y - 0.2 so the road mesh runs through it
    const n = nearest(-67, 116);
    out.push(P('rock_tunnel', -67, 116, facing(-n.sample.tx, -n.sample.tz), { tag: 'tunnel', probe: [n.sample.x, n.sample.z], dy: -0.16, alignRoad: true }));
  }
  out.push(P('church_belltower', 181, -126, 270, { tag: 'church' }));     // door faces west across the hairpin apex
  out.push(P('clock_tower', 46, 6, 90, { tag: 'clock_tower' }));           // clock faces the road to the east
  out.push(P('lighthouse', -177, 121, 45, { tag: 'lighthouse' }));         // door faces north east toward the road
  out.push(P('fountain', 136, -124, 0, { tag: 'fountain' }));
  return out;
}

/** 7.2 the seven boost pads are static assets placed by the level (items owns the trigger volume) */
function genPads() {
  return BOOST_PADS.map((b, i) => P('boost_pad', b.x, b.z, b.rot, { tag: 'pad_' + (i + 1) }));
}

/** 7.3 the harbour */
function genHarbour(rng) {
  const out = [];
  // quay edge x 24 along x = -142, water to the west: the module's water side is -Z, so +Z faces east (rot 90).
  // Round 3 (critic: "the harbour straight shows no water, no boats and no quay furniture"): the module is a 0.4 m
  // coping ON a 1.6 m wall face that goes down to the water (style lock: water 1.6 m below the quay deck), so its
  // base belongs at the water line, y -1.4, with the coping top flush with the deck at 0.2. Placed on the terrain
  // (0.2) it stood 0.2 to 1.8 m: a stone parapet the length of the straight that hid the whole basin, the seven
  // moored boats, the jetties and the buoys from the chase camera (work/fix3_level/harbour_before.png). Centred at
  // x -142.3 so the wall face (-142.9) stands where the one cell terrain step is already under water (-143.0).
  for (let i = 0; i < 24; i++) out.push(P('quay_edge_module', -142.3, 7 - 6 * i, 90, { tag: 'quay_edge', y: SEA_LEVEL }));
  // north quay wall along z -133.2 from x -196 to -142, water to the south (+Z): -Z faces south means rot 180; same
  // water line placement, the coping's landward edge (-133.8) on the headland's top and its face (-132.6) in the water
  for (let i = 0; i < 9; i++) out.push(P('quay_edge_module', -193 + 6 * i, -133.2, 180, { tag: 'quay_edge_north', y: SEA_LEVEL }));
  // bollards on the quay coping x 22
  for (let i = 0; i < 22; i++) out.push(P('harbour_bollard', -141.4, 8 - 6 * i, 0, { tag: 'quay_bollard' }));
  // breakwater: 9 modules along z = 14 (sea to the south = +Z, rot 0), 21 along x = -196 (sea to the west: +Z west, rot 270)
  for (let i = 0; i < 9; i++) out.push(P('harbour_wall_module', -145 - 6 * i, 14, 0, { tag: 'breakwater_south' }));
  for (let i = 0; i < 21; i++) out.push(P('harbour_wall_module', -196, 11 - 6 * i, 270, { tag: 'breakwater_west' }));
  // 18 bollards on the breakwater cap (2.6 m above the raised footprint the terrain gives the wall)
  for (let i = 0; i < 5; i++) out.push(P('harbour_bollard', -150 - 10 * i, 15.6, 0, { tag: 'breakwater_bollard', lift: 2.6 }));
  for (let i = 0; i < 13; i++) out.push(P('harbour_bollard', -197.6, 6 - 9 * i, 0, { tag: 'breakwater_bollard', lift: 2.6 }));
  // jetties: three runs of three from the quay wall west, piles standing in the water
  for (const z of [-20, -60, -100]) for (let i = 0; i < 3; i++) out.push(P('jetty_module', -150 - 8 * i, z, 0, { tag: 'jetty', y: SEA_LEVEL - 0.2 }));
  // boats and buoys: movers on the water
  // painted boats (round 2): each hull takes one livery colour from BOAT_PAINT before the material pass (build.js paintHull),
  // the gunwale, boot top and wheelhouse keep the asset's own colours; the quay side three are the ones the straight sees
  // Round 3 (critic item 5: "sea and moored boats" on the harbour straight): the four quay side boats moor AT the quay
  // (hull side 3.6 m off the coping face, between the jetties and clear of the rowing boats) instead of 10 to 12 m out
  // in the basin, where the chase camera looking north along the 14 m road never had one inside its 59 degree frame
  // (the only boat ahead of the frame at progress 0.08 sat 56 degrees off axis). At the quay a wheelhouse and mast
  // stand 3.4 m above the coping 20 to 40 m ahead left of every point of the straight and the start grid.
  const boats = [[-147.5, -27, 355], [-147.5, -53, 5], [-147.5, -93, 358], [-147.5, -114, 2], [-170, -24.5, 80], [-172, -85, 100], [-160, -50, 5], [-182, -60, 95]];
  boats.forEach(([x, z, rot], i) => out.push(P('fishing_boat', x, z, rot, { tag: 'fishing_boat', y: -1.9, moving: true, paint: BOAT_PAINT[i % BOAT_PAINT.length],
    bob: { amp: 0.12, period: 3.1 + 0.4 * rng(), roll: 2.0, pitch: 1.0, phase: rng() * 6.283 } })));
  [[-147, -8], [-148, -42], [-149, -84]].forEach(([x, z], i) => out.push(P('rowing_boat', x, z, 90 + (rng() - 0.5) * 30, { tag: 'rowing_boat_afloat', y: -1.7, moving: true, paint: [0xd6402f, 0x2f5fc4, 0xf2c230][i],
    bob: { amp: 0.08, period: 2.4 + 0.4 * rng(), roll: 3.0, pitch: 1.5, phase: rng() * 6.283 } })));
  for (const [x, z] of [[-165, -40], [-178, -30], [-186, -75], [-170, -100], [-180, -110], [-160, 0], [-188, -10], [-175, -60]])
    out.push(P('mooring_buoy', x, z, rng() * 360, { tag: 'mooring_buoy', y: -1.6, moving: true, bob: { amp: 0.15, period: 2.0 + 0.6 * rng(), roll: 6.0, pitch: 4.0, phase: rng() * 6.283 } }));
  // davits, jib toward the water (west)
  // round 2 (integrator): the quay davits' 3.6 m arm footprint (rot 270 runs along x) stood 1.1 m inside the road edge (x -140.7) and stalled the touch harness square on; base on the coping's outer edge, arm over the water
  out.push(P('harbour_davit', -142.8, -79, 270, { tag: 'davit' }));
  out.push(P('harbour_davit', -142.8, -115, 270, { tag: 'davit' }));
  // quay houses: fronts along x = -124.5 facing west, centres at x = -119.5; the arcade at z -44 is set back to x -108
  const quayList = ['house_wide_2storey', 'house_narrow_tall', 'house_balcony_row', 'house_corner_shop', 'house_arcade', 'house_narrow_tall',
    'house_wide_2storey', 'house_balcony_row', 'house_narrow_tall', 'house_corner_shop', 'house_wide_2storey'];
  const quayZ = [-4, -14, -23, -33, -44, -54, -64, -75, -84, -93, -104];
  quayList.forEach((name, i) => {
    const setBack = name === 'house_arcade';
    const fx = setBack ? -108 : -124.5;
    out.push(P(name, fx + 5, quayZ[i], 270, { probe: [fx, quayZ[i]], tag: 'quay_houses' }));
  });
  // palms on the pavement with a small lean, lamps on the quay side coping
  for (let i = 0; i < 9; i++) out.push(P('palm_tall', -125.8, -12 * i, rng() * 360, { tag: 'quay_palm', tilt: 3 + 5 * rng() }));
  // lamps at the quay wall's foot (round 1: the plan's x -140 stood 1 m INSIDE the 14 m road's west edge at -141; the
  // touch gate's kart, hugging the left, met one head on at (-140.7, -99) and lost 1.3 s against it)
  for (let i = 0; i < 9; i++) out.push(P('street_lamp', -141.3, -6 - 12 * i, 90, { tag: 'quay_lamp' }));
  // grandstand on its pad facing the road (west), flag poles and tyre walls on the coping (long axis along the quay)
  out.push(P('grandstand_small', -111, -60, 270, { tag: 'quay_grandstand' }));
  // Round 2 saturation dressing on the harbour straight (the quay frame had 4 percent strongly saturated pixels):
  //  - flags the length of the coping every 12 m between the lamps (the plan's six at z -50..-80, at x -140, stood
  //    1 m inside the road edge like the lamps did; they move to the coping at -141.6 with the lamps), skipping the
  //    tyre wall stretch at z -37..-19
  for (let i = 0; i < 9; i++) { const z = -12 - 12 * i; if (z > -40 && z < -17) continue; out.push(P('race_flag_pole', -141.6, z, 180, { tag: 'quay_flags' })); }
  //  - bunting across the quay road: two 11 m runs per station from opposite anchors (the quay lamp heads at 4.5 m and
  //    the pavement palms), at lateral -2.75 and +2.75 and two heights so they read as two strings crossing the 14 m
  //    road; anchors at road y + 5.0 and 5.5 (the run's ends are at 1.2 m over its base). Nothing within 5 m of the gantry.
  for (let i = 0; i < 17; i++) {
    const z = -10 - 6 * i;
    if (Math.abs(z - (-45)) < 6) continue;
    const n = nearest(-134, z);
    out.push(P('bunting_run', -134 - 2.75, n.sample.z, 0, { tag: 'bunting_quay', y: n.sample.y + 3.8 }));
    out.push(P('bunting_run', -134 + 2.75, n.sample.z, 0, { tag: 'bunting_quay', y: n.sample.y + 4.3 }));
  }
  //  - a pavement cafe with its two red and white parasols in the 14 m gap in front of the set back arcade (the plan's
  //    grandstand pad; the grandstand itself stands at z -60), facing the road: "umbrellas along the promenade"
  out.push(P('cafe_terrace', -117, -44, 270, { tag: 'quay_cafe' }));
  //  - bougainvillea on every quay house front (the row is explicit here, not a houseRow): one per house, two on the 12 m ones
  //    (not behind a pavement palm trunk at z = -12 k or a crowd at z -50, -70, -90, 4: 2 m clear of those)
  const quayBusy = [-6.5, -8.6]; for (let k = 0; k < 9; k++) quayBusy.push(-12 * k);
  for (const c of [4.5, -18, -42, -66, -90]) for (const d of [-4.1, -1.35, 1.35, 4.1]) quayBusy.push(c + d);
  quayList.forEach((name, i) => {
    const w = SIZES[name][0], fx = name === 'house_arcade' ? -108 : -124.5;
    const sides = w >= 12 ? [-1, 1] : [i % 2 ? -1 : 1, i % 2 ? 1 : -1];
    let placed = 0;
    for (const sd of sides) {
      const z = quayZ[i] + sd * (w / 2 - 2.2);
      if (placed >= (w >= 12 ? 2 : 1)) break;
      if (fx === -124.5 && quayBusy.some((b) => Math.abs(b - z) < 2.0)) continue;
      out.push(P('bougainvillea_card', fx - 0.22, z, 270, { tag: 'bougainvillea_a' })); placed++;
    }
  });
  // round 2: five more groups along the pavement between the palms (the bar lines its straights with crowds; their
  // clothes are the most saturated pixels a level can put beside a road) and three on the grass bank inside the
  // market corner facing the road, where the corner frame was bare grass
  // round 3: runs of three between the pavement palms (12 m pitch, the run is 8.1 m) and a pair at the row's north end
  for (const z of [-18, -42, -66, -90]) crowdRun(out, -125, z, 270, 3, 'quay_crowd');
  crowdRun(out, -125, 4.5, 270, 2, 'quay_crowd');
  for (const [x, z] of [[-114, -137], [-104, -142], [-94, -147]]) { const n = nearest(x, z); crowdRun(out, x, z, facing(n.sample.x - x, n.sample.z - z), 2, 'corner_crowd'); }
  // round 3 (critic item 5, the harbour straight's ground floors): produce crate stacks on the quay pavement in the
  // gaps between the palms and the crowd runs, backs to the house fronts (the pavement is 1.9 m beyond the kerb strip
  // here, so a 2.4 m deep market_stall does not fit without standing on the kerb: the crate stack is 1.0 m deep).
  // A pavement awning, a cafe table pair and a shop front ground floor are asset requests (work/fix3_level/NOTES.md).
  for (const [z, rot] of [[-27.5, 250], [-52, 285], [-75.5, 262], [-103, 278]]) out.push(P('produce_crate_stack', -125.3, z, rot, { tag: 'quay_crates' }));   // 0.6 m clear of the bougainvillea troughs at z -30, -56, -78, -100
  // pit carts on the pavement beside the grid tail (round 1: the plan's (-130, -3) and (-136, -3) were ON the
  // quay road, 4 m off the centreline, in the racing line of every lap after the first)
  out.push(P('pit_toolcart', -125.7, -6.5, 270, { tag: 'grid_carts' }));
  out.push(P('pit_toolcart', -125.7, -8.6, 270, { tag: 'grid_carts' }));
  // the start straight's water side tyre walls at the wall's foot, between the bollards, off the road edge (same round 1 reason)
  for (const z of [-37, -31, -25, -19]) out.push(P('tyre_wall', -141.5, z, 90, { tag: 'quay_tyres' }));
  return out;
}

/** the lower street rows are needed by two generators (houses, bougainvillea) and by the terrace clipping */
let _lowerRows = null;
function lowerStreetRows() {
  if (_lowerRows) return _lowerRows;
  const south = ['house_narrow_tall', 'house_wide_2storey', 'house_balcony_row', 'house_arcade', 'house_narrow_tall', 'house_corner_shop',
    'house_wide_2storey', 'house_balcony_row', 'house_narrow_tall', 'house_wide_2storey', 'house_balcony_row', 'house_arcade',
    'house_narrow_tall', 'house_wide_2storey', 'house_corner_shop', 'house_narrow_tall', 'house_balcony_row', 'house_wide_2storey'];
  const north = ['house_wide_2storey', 'house_narrow_tall', 'house_corner_shop', 'house_balcony_row', 'house_narrow_tall', 'house_wide_2storey',
    'house_arcade', 'house_narrow_tall', 'house_balcony_row', 'house_wide_2storey', 'house_narrow_tall', 'house_corner_shop',
    'house_balcony_row', 'house_wide_2storey', 'house_narrow_tall', 'house_arcade', 'house_balcony_row', 'house_wide_2storey'];
  // south (uphill) side: fronts along z = -150 facing north (toward -Z); north side: fronts along z = -166 facing south
  _lowerRows = {
    south: houseRow({ from: [-70, -150], dir: [1, 0], face: [0, -1], list: south, stairs: true, tag: 'lower_south' }),
    north: houseRow({ from: [-70, -166], dir: [1, 0], face: [0, 1], list: north, stairs: false, tag: 'lower_north' }),
  };
  return _lowerRows;
}

/** 7.4 the market corner and the lower street */
function genMarketAndLowerStreet(rng) {
  const out = [];
  // fish market: two rows of four stalls facing the road (south)
  for (const x of [-120, -116, -112, -108]) out.push(P('market_stall', x, -166, 0, { tag: 'market' }));
  for (const x of [-122, -118, -114, -110]) out.push(P('market_stall', x, -160, 0, { tag: 'market' }));
  for (const [x, z] of [[-125.5, -166.5], [-104, -164], [-100, -158], [-124, -158], [-94, -166], [-90, -160]]) out.push(P('produce_crate_stack', x, z, rng() * 360, { tag: 'market_crates' }));   // round 3 (integrator): the first stack stood at (-126, -150) on the market corner's outside margin and pinned the touch gate's kart for 5 s (a wedge respawn); it sits by the west stall row now
  out.push(P('street_lamp', -128, -142, 0, { tag: 'market_lamp' }));
  out.push(P('street_lamp', -98, -148, 0, { tag: 'market_lamp' }));
  for (const [x, z] of [[-126, -120], [-124, -128], [-119, -136], [-112, -143], [-104, -148], [-96, -152]]) {
    const n = nearest(x, z);
    out.push(P('tyre_wall', x, z, alongRoad(n.sample.tx, n.sample.tz), { tag: 'market_tyres' }));
  }
  // houses both sides
  const rows = lowerStreetRows();
  out.push(...rows.south.placements, ...rows.north.placements);
  // bunting across the street, long axis across the road (Z). Round 2: every 4.5 m (was 9) and hung at road y + 5.0
  // (was 6.0: anchors at 6.2 m, first floor balcony height, so the strings sit in the upper third of the chase frame
  // instead of its top edge), alternating a 7 degree skew so the runs read as a zigzag between facing balconies
  for (let i = 0; i < 43; i++) {
    const x = -64 + 4.5 * i;
    const n = nearest(x, -158);
    out.push(P('bunting_run', x, n.sample.z, 90 + (i % 2 ? 7 : -7), { tag: 'bunting', y: n.sample.y + 5.0 }));
  }
  // chevron boards on the OUTSIDE of the market corner (a right hander: outside is the left, the quay side), in a row
  // before and through the bend, turned toward the road so a kart slides off them (round 1 rule)
  {
    const T = trackTable(), s0 = T.wpS[7] - 6, s1 = T.wpS[9];
    for (let k = 0; k < 4; k++) {
      const s = s0 + ((s1 - s0) * (k + 0.5)) / 4, r = roadside(s, -1, atDistance(s).width / 2 + 0.6 + 1.4);
      out.push(P('sign_chevron_board', r.x, r.z, r.rotFaceBackToward(CHEVRON_TURN), { tag: 'chevrons_b' }));
    }
  }
  // lamps alternating sides every 16 m on the pavements
  for (let i = 0; i < 12; i++) {
    const x = -62 + 16 * i, n = nearest(x, -158), side = i % 2 === 0 ? 1 : -1;
    const r = roadside(n.s, side, n.sample.width / 2 + 0.6 + 1.25);
    out.push(P('street_lamp', r.x, r.z, r.rotFaceRoad, { tag: 'street_lamp_c' }));
  }
  // spectators on the north pavement facing the road
  for (const x of [-30, 20, 70, 110]) {
    const n = nearest(x, -158), r = roadside(n.s, -1, n.sample.width / 2 + 0.6 + 1.5);
    crowdRun(out, r.x, r.z, r.rotFaceRoad, 2, 'crowd_c', { back: 0.35 });
  }
  // chevron boards on the outside (north) of the right hand S bend, facing the approaching karts (round 2: four in a row, was two)
  for (const x of [-12, -2, 8, 14]) {
    const n = nearest(x, -158), r = roadside(n.s, -1, n.sample.width / 2 + 0.6 + 1.4);
    out.push(P('sign_chevron_board', r.x, r.z, r.rotFaceBackToward(CHEVRON_TURN), { tag: 'chevrons_c' }));
  }
  // flag poles on the south pavement every 22 m
  for (let i = 0; i < 8; i++) {
    const x = -60 + 22 * i, n = nearest(x, -158), r = roadside(n.s, 1, n.sample.width / 2 + 0.6 + 1.9);
    out.push(P('race_flag_pole', r.x, r.z, r.rotAlong, { tag: 'flags_c' }));
  }
  // round 2: flags on both pavements every 11 m (the south row's gaps and the whole north pavement), 1.6 m behind the
  // kerb so the pole clears the house fronts at 2.5 m, skipping any spot within 2.5 m of a lamp, crowd, board or flag
  for (const side of [1, -1]) {
    for (let i = 0; i < 17; i++) {
      const x = (side > 0 ? -49 : -55) + 11 * i, n = nearest(x, -158), r = roadside(n.s, side, n.sample.width / 2 + 0.6 + 1.6);
      if (!clearOf(out, r.x, r.z, 2.5)) continue;
      out.push(P('race_flag_pole', r.x, r.z, r.rotAlong, { tag: 'flags_c' }));
    }
  }
  // round 3 (critic item 5, ground level dressing: "every house's ground floor is a blank plaster wall with an arch ...
  // add shop fronts with awnings, cafe tables and chairs, ... bins, planters and signage"): awning stalls with crate
  // stacks on both pavements of the lower street wherever 3 m of pavement is clear of lamps, flags, boards, crowds and
  // stairs, fronts to the road, backs 5 cm off the house walls. The market_stall (striped awning, counter, crates,
  // chalk board) and produce_crate_stack (crates, lemons, net) are the two pavement shop assets in docs/OBJECTS.tsv;
  // a bin, a planter and a cafe table that fits a 2.5 m pavement are not in the TSV (request in NOTES.md).
  {
    const T2 = trackTable(), sC0 = T2.wpS[11] + 8, sC1 = T2.wpS[20] - 6;
    pavementStalls(out, T2, sC0 + 3, sC1, -1, 13, 'street_stalls_n', 7);
    pavementStalls(out, T2, sC0 + 9, sC1, 1, 13, 'street_stalls_s', 7);
  }
  // bougainvillea on every house front, both sides, two on the wide houses (round 2; was every second house, 7 a side),
  // placed last so a cascade never shares its wall spot with a lamp, flag, board or crowd
  out.push(...bougainvilleaOn(rows.south, rng, 'bougainvillea_c', 1, Infinity, out));
  out.push(...bougainvilleaOn(rows.north, rng, 'bougainvillea_c', 1, Infinity, out));
  // terraces behind the south houses: contour lines base = 6, 9, 12, 15 (TRACK-PLAN 4.9)
  out.push(...genTerraces());
  // pines and palms on the terrace floors, nudged off a wall line if the plan put one there
  for (const [x, z] of [[-40, -130], [0, -130], [-30, -114], [10, -114], [-20, -98], [20, -98]]) { const q = offTerraceLine(x, z); out.push(P('pine_umbrella', q[0], q[1], pineRot(q[0], q[1], rng()), { tag: 'terrace_pine' })); }
  for (const [x, z] of [[-50, -114], [-10, -98], [30, -130], [40, -114]]) { const q = offTerraceLine(x, z); out.push(P('palm_short', q[0], q[1], rng() * 360, { tag: 'terrace_palm', tilt: 2 + 4 * rng() })); }
  return out;
}

/** TRACK-PLAN 4.1 base slope without noise, for the contour lines */
export const baseSlope = (x, z) => 0.2 + 0.055 * Math.max(0, x + 127) + 0.06 * Math.max(0, z + 160);
const GRAD = [0.055, 0.06], GRADN = dhypot(0.055, 0.06);
const DOWNHILL = [-GRAD[0] / GRADN, -GRAD[1] / GRADN];
export const TERRACE_ROT = facing(DOWNHILL[0], DOWNHILL[1]);   // 222.5 degrees: the +Z face points downhill (north west)
function offTerraceLine(x, z) {
  const b = baseSlope(x, z), frac = ((b % 3) + 3) % 3;
  const margin = 0.15;   // 1.8 m clear of the line in ground distance
  if (frac < margin) { const k = (margin - frac) / GRADN; return [r1(x - DOWNHILL[0] * k), r1(z - DOWNHILL[1] * k)]; }
  if (frac > 3 - margin) { const k = (frac - (3 - margin)) / GRADN; return [r1(x + DOWNHILL[0] * k), r1(z + DOWNHILL[1] * k)]; }
  return [x, z];
}
function genTerraces() {
  const out = [];
  let walls = 0;
  const rows = lowerStreetRows();
  const pads = rows.south.placements.map((p) => { const [w, d] = SIZES[p.asset]; return { x0: p.x - w / 2 - 1, x1: p.x + w / 2 + 1, z0: p.z - d / 2 - 1, z1: p.z + d / 2 + 1 }; });
  const dir = [GRAD[1] / GRADN, -GRAD[0] / GRADN];   // along the line, south west to north east
  for (const k of [6, 9, 12, 15]) {
    const c = k - 0.2;
    const zAt = (x) => (c - 0.055 * (x + 127)) / 0.06 - 160;
    const xAt = (z) => (c - 0.06 * (z + 160)) / 0.055 - 127;
    const x0 = Math.max(-110, xAt(-30)), x1 = Math.min(40, xAt(-150));
    if (x1 <= x0) continue;
    const L = (x1 - x0) / dir[0];
    for (let d = 3; d + 3 <= L + 0.01; d += 6) {
      const x = x0 + dir[0] * d, z = zAt(x);
      const n = nearest(x, z);
      if (n.dist < n.sample.width / 2 + 4 + 6) continue;                               // road flatten zone
      if (pads.some((p) => x > p.x0 && x < p.x1 && z > p.z0 && z < p.z1)) continue;   // house pads
      if (z < -139) continue;                                                          // the lower street houses and their pads end at z -139 (north is -Z)
      out.push(P('retaining_wall_terrace', x, z, TERRACE_ROT, { tag: 'terrace_k' + k, probe: [r1(x + DOWNHILL[0] * 1.6), r1(z + DOWNHILL[1] * 1.6)] }));
      // round 2: a bougainvillea cascade over every third terrace wall, trough at the wall's downhill foot, facing downhill
      // like the wall: the hillside inside the market corner and above the lower street was bare grass and pale stone in
      // the corner frame (progress 0.15, 2 percent strongly saturated pixels)
      if ((++walls % 3) === 1) out.push(P('bougainvillea_card', x + DOWNHILL[0] * 0.62, z + DOWNHILL[1] * 0.62, TERRACE_ROT, { tag: 'bougainvillea_terrace', probe: [r1(x + DOWNHILL[0] * 1.6), r1(z + DOWNHILL[1] * 1.6)] }));
    }
  }
  return out;
}

/** 7.5 the church hairpin and the piazza */
function genPiazza(rng) {
  const out = [];
  for (const [x, z] of [[166, -140], [170, -124], [166, -108], [150, -96]]) {
    const n = nearest(x, z);
    crowdRun(out, x, z, facing(n.sample.x - x, n.sample.z - z), 2, 'crowd_d');
  }
  for (const [x, z] of [[163, -136], [165, -128], [165, -120], [163, -112], [158, -104], [150, -98]]) { const n = nearest(x, z); out.push(P('tyre_wall', x, z, alongRoad(n.sample.tx, n.sample.tz), { tag: 'hairpin_tyres' })); }
  // chevron boards in a continuous row round the OUTSIDE of the hairpin (round 2: eight along the bend at even
  // spacing, 2 m outside the kerb, was four; the bar lines the outside of every corner with boards)
  {
    const s0 = nearest(162, -146).s, s1 = nearest(155, -100).s;
    for (let k = 0; k < 8; k++) {
      const s = s0 + ((s1 - s0) * (k + 0.5)) / 8, r = roadside(s, -1, atDistance(s).width / 2 + 0.6 + 1.4);
      out.push(P('sign_chevron_board', r.x, r.z, r.rotFaceBackToward(CHEVRON_TURN), { tag: 'chevrons_d' }));
    }
  }
  out.push(P('cafe_terrace', 128, -136, 20, { tag: 'piazza_cafe' }));
  out.push(P('cafe_terrace', 142, -112, 200, { tag: 'piazza_cafe' }));
  // round 2: the grass bank OUTSIDE the hairpin entry (left of travel from the lower street's end to the first board) was
  // bare in the frames at progress 0.35 and 0.42: four crowds on the bank and three flags between them and the kerb
  {
    const T = trackTable(), s19 = T.wpS[19];
    for (let k = 0; k < 4; k++) {
      const s = s19 + 8 + 12 * k, sm = atDistance(s), r = roadside(s, -1, sm.width / 2 + 3.5);
      if (clearOf(out, r.x, r.z, 3)) crowdRun(out, r.x, r.z, r.rotFaceRoad, 2, 'crowd_d_entry');
      if (k < 3) { const f = roadside(s + 6, -1, sm.width / 2 + 2.0); if (clearOf(out, f.x, f.z, 2.5)) out.push(P('race_flag_pole', f.x, f.z, f.rotAlong, { tag: 'flags_d_entry' })); }
    }
  }
  // round 2: a row of four market stalls (red and white awnings) along the piazza's north edge facing the lower street's
  // end and the hairpin entry, 2 m clear of the north cafe's swung corner; the lower street's last frames look straight at them
  for (const x of [126, 130, 134, 138]) out.push(P('market_stall', x, -143.5, 180, { tag: 'piazza_market' }));
  for (const [x, z] of [[122, -136], [150, -136], [122, -112], [150, -112]]) out.push(P('palm_tall', x, z, rng() * 360, { tag: 'piazza_palm', tilt: 2 + 4 * rng() }));
  for (const [x, z] of [[130, -128], [142, -128], [130, -120], [142, -120]]) out.push(P('street_lamp', x, z, 0, { tag: 'piazza_lamp' }));
  for (const [x, z] of [[124, -128], [148, -120]]) out.push(P('produce_crate_stack', x, z, rng() * 360, { tag: 'piazza_crates' }));
  // flag poles at the piazza's kerb line (the inside of the hairpin) facing the road
  for (const p of [0.400, 0.418, 0.436, 0.455]) { const T = trackTable(); const r = roadside(p * T.length, 1, atProgress(p).width / 2 + 2.5); out.push(P('race_flag_pole', r.x, r.z, r.rotAlong, { tag: 'flags_d' })); }
  // piazza exit street houses
  const southE = houseRow({ from: [118, -84], dir: [-1, 0], face: [0, -1], list: ['house_corner_shop', 'house_balcony_row', 'house_narrow_tall', 'house_wide_2storey'], tag: 'exit_south' });
  const northE = houseRow({ from: [118, -100], dir: [-1, 0], face: [0, 1], list: ['house_arcade', 'house_narrow_tall', 'house_balcony_row', 'house_corner_shop'], tag: 'exit_north' });
  out.push(...southE.placements, ...northE.placements);
  // round 2: the exit street gets bunting between its facing balconies (four runs over the housed stretch, x 110 to 77;
  // the plan kept this street open for the harbour view, which starts where the houses end at x 74) and flags on the
  // north pavement between the houses' doors
  for (const x of [110, 99, 88, 77]) { const n = nearest(x, -92), r = roadside(n.s, 1, 0); out.push(P('bunting_run', r.x, r.z, r.rotFaceAhead + (x % 2 ? 7 : -7), { tag: 'bunting_e', y: n.sample.y + 5.0 })); }
  for (const x of [105, 94, 83]) { const n = nearest(x, -92), r = roadside(n.s, -1, n.sample.width / 2 + 0.6 + 1.6); if (clearOf(out, r.x, r.z, 2.5)) out.push(P('race_flag_pole', r.x, r.z, r.rotAlong, { tag: 'flags_e' })); }
  // round 2: the gate bend (a left hander, outside on the right) lines its outside with four boards, none within 4 m of
  // the gate's piers, and a crowd either side of the road just before the gate: the frame into the sun at progress 0.51
  // was the arch, grass and kerbs
  {
    const T = trackTable(), G = LANDMARKS.gate;
    for (const pr of [0.505, 0.511, 0.517, 0.523, 0.529]) {
      const s = pr * T.length, r = roadside(s, 1, atDistance(s).width / 2 + 0.6 + 1.4);
      if (dhypot(r.x - G.x, r.z - G.z) < 9 || !clearOf(out, r.x, r.z, 2.5)) continue;
      out.push(P('sign_chevron_board', r.x, r.z, r.rotFaceBackToward(CHEVRON_TURN), { tag: 'chevrons_e' }));
    }
    const s = nearest(68, -70).s;
    for (const side of [-1, 1]) { const r = roadside(s, side, atDistance(s).width / 2 + 3.0); crowdRun(out, r.x, r.z, r.rotFaceRoad, 2, 'gate_crowd'); }
    // round 3: a stall pair with crates on the exit street's south pavement (its houses' ground floors face the frame at progress 0.49)
    pavementStalls(out, T, nearest(104, -92).s, nearest(80, -90).s, 1, 12, 'exit_stalls', 2);
  }
  out.push(...bougainvilleaOn(southE, rng, 'bougainvillea_e', 1, Infinity, out));
  out.push(...bougainvilleaOn(northE, rng, 'bougainvillea_e', 1, Infinity, out));
  for (const [x, z] of [[100, -112], [84, -112]]) out.push(P('pine_umbrella', x, z, pineRot(x, z, rng()), { tag: 'exit_pine' }));
  genPiazza.rows = { southE, northE };
  return out;
}

/** 7.6 the clock tower rise */
function genRise(rng) {
  const out = [];
  out.push(P('cafe_terrace', 54, 2, 90, { tag: 'rise_cafe' }));
  // west side houses facing east, fronts along x = 52, centres x = 47 (the clock tower pad gap is z -4..14)
  const westA = houseRow({ from: [52, -50], dir: [0, 1], face: [1, 0], list: ['house_wide_2storey', 'house_balcony_row', 'house_narrow_tall'], tag: 'rise_west' });
  const westB = houseRow({ from: [52, 15], dir: [0, 1], face: [1, 0], list: ['house_corner_shop', 'house_wide_2storey', 'house_arcade', 'house_narrow_tall'], tag: 'rise_west' });
  out.push(...westA.placements, ...westB.placements);
  genRise.rows = { westA, westB };
  // east side retaining wall along x = 80, face west toward the road, base on the road side (lower) terrace
  for (let i = 0; i < 18; i++) out.push(P('retaining_wall_terrace', 80, -47 + 6 * i, 270, { tag: 'rise_wall', probe: [78.4, -47 + 6 * i] }));
  // round 2: bougainvillea cascades over every second module of that wall (the descent frame at progress 0.56 is the
  // wall, grass and a kerb: nothing saturated in it), trough at the wall's foot on the road side, facing the road.
  // Skipped where the wall stands at the kerb (the chicane's outside, z -38 to -14, where the tyre walls and boards are)
  for (const z of [25, 40]) { const n = nearest(70, z), r = roadside(n.s, -1, n.sample.width / 2 + 3.0); if (clearOf(out, r.x, r.z, 3)) crowdRun(out, r.x, r.z, r.rotFaceRoad, 2, 'rise_crowd'); }
  for (const [x, z] of [[90, -40], [92, -10], [90, 20], [92, 50]]) out.push(P('pine_umbrella', x, z, pineRot(x, z, rng()), { tag: 'rise_pine' }));
  for (const [x, z] of [[86, -25], [86, 5], [86, 35], [86, 58]]) out.push(P('palm_short', x, z, rng() * 360, { tag: 'rise_palm', tilt: 2 + 4 * rng() }));
  // lamps on the west pavement (right of travel heading south) every 18 m
  const T = trackTable();
  const sF0 = T.wpS[32], sF1 = T.wpS[39];
  for (let i = 0; i < 6; i++) { const r = roadside(sF0 + 6 + 18 * i, 1, atDistance(sF0 + 6 + 18 * i).width / 2 + 0.6 + 1.25); out.push(P('street_lamp', r.x, r.z, r.rotFaceRoad, { tag: 'rise_lamp' })); }
  // chicane furniture
  for (const [x, z] of [[80, -22], [80, -16], [50, 18], [50, 24]]) { const n = nearest(x, z); out.push(P('tyre_wall', x, z, alongRoad(n.sample.tx, n.sample.tz), { tag: 'chicane_tyres' })); }
  // chevron boards before the right hand bend of the chicane on its outside (east), facing the approaching karts.
  // Round 2 (integrator, track's request): the boards' wall side end touches the retaining wall face (x 79.6) and the flag
  // poles and the crowd stand against it, so a kart that runs the flat verge is deflected toward the road by the angled
  // board face instead of being pinned between a pole and the wall (verge_probe: 13.6 m/s to 0).
  for (const z of [-38, -33, -28, -23]) { const n = nearest(74, z); const r = roadside(n.s, -1, n.sample.width / 2 + 0.6 + 1.4); out.push(P('sign_chevron_board', 78.5, r.z, r.rotFaceBackToward(CHEVRON_TURN), { tag: 'chevrons_f' })); }
  for (const [x, z] of [[50, -30], [79.2, 10], [52, 40]]) { const n = nearest(x, z); crowdRun(out, x, z, facing(n.sample.x - x, n.sample.z - z), 2, 'crowd_f', { back: x > 70 ? 0 : 0.45 }); }
  for (let i = 0; i < 4; i++) { const s = sF0 + 10 + 25 * i; const r = roadside(s, -1, atDistance(s).width / 2 + 0.6 + 1.9); out.push(P('race_flag_pole', 79.3, r.z, r.rotAlong, { tag: 'flags_f' })); }
  // round 2: flags on the west pavement too, between the lamps
  for (let i = 0; i < 5; i++) { const s = sF0 + 15 + 22 * i; const r = roadside(s, 1, atDistance(s).width / 2 + 0.6 + 1.6); if (clearOf(out, r.x, r.z, 2.5)) out.push(P('race_flag_pole', r.x, r.z, r.rotAlong, { tag: 'flags_f_west' })); }
  void sF1;
  // the cliff entry lay by (pad y 20.6)
  out.push(P('pit_toolcart', 72, 78, 90, { tag: 'layby_carts' }));
  out.push(P('pit_toolcart', 78, 78, 90, { tag: 'layby_carts' }));
  for (const [x, z] of [[84, 74], [84, 80], [84, 86], [82, 92]]) out.push(P('tyre_wall', x, z, 90, { tag: 'layby_tyres' }));
  out.push(P('grandstand_small', 76, 90, 300, { tag: 'layby_grandstand' }));
  for (const [x, z] of [[67, 72], [67, 94], [84, 71], [84, 95]]) out.push(P('race_flag_pole', x, z, 270, { tag: 'flags_layby' }));
  // round 2: bougainvillea on every house of the rise's west rows, placed last so it avoids the pavement furniture,
  // and the wall cascades from above, placed here for the same reason (a crowd stands at (78, 10))
  for (let i = 0; i < 18; i++) {
    const z = -44 + 6 * i, n = nearest(79.4, z);
    if (n.dist - n.sample.width / 2 < 2.5 || !clearOf(out, 79.4, z, 2.0)) continue;
    out.push(P('bougainvillea_card', 79.4, z, 270, { tag: 'bougainvillea_f', probe: [78.4, z] }));
  }
  out.push(...bougainvilleaOn(westA, rng, 'bougainvillea_f', 1, Infinity, out));
  out.push(...bougainvilleaOn(westB, rng, 'bougainvillea_f', 1, Infinity, out));
  return out;
}

/** section 6 kerb rules as [wpFrom, wpTo, side] with side -1 left of travel, +1 right */
export function kerbRules() {
  return [
    [7, 11, -1], [7, 11, 1],            // B both
    [11, 20, 1], [12, 15, -1],          // C outer (south, right) continuous; inner only through the S bends
    [20, 27, -1], [20, 27, 1],          // D both
    [27, 32, -1], [27, 32, 1],          // E both
    [32, 38, -1], [32, 38, 1],          // F through the chicane
    [40, 44, -1], [40, 44, 1],          // G both
    [44, 50, 1],                        // H inner (north, right); the sea side carries the guard wall
    [50, 59, 1], [55, 58, -1],          // I inner east; the beach side from waypoint 55 to 58
  ];
}
/** kerb stations from the internal sampler: { x, z, rot, side: 'L'|'R', progress }, every 4 m, 0.3 m outside the road edge */
export function kerbStations() {
  const T = trackTable(), out = [];
  for (const [a, b, side] of kerbRules()) {
    const s0 = T.wpS[a], s1 = b >= WAYPOINTS.length ? T.length : T.wpS[b];
    for (let s = s0 + 2; s < s1 - 2; s += 4) {
      const r = roadside(s, side, atDistance(s).width / 2 + 0.3);
      // the kerb's road side is its -Z, so +Z faces away from the road
      out.push({ x: r1(r.x), z: r1(r.z), rot: r.rotFaceAway, side: side < 0 ? 'L' : 'R', progress: r.sm.progress });
    }
  }
  return out;
}
/** guard wall stations on the sea side from waypoint 41 to 53, 1.2 m outside the kerb, with the three 12 m gaps */
export function wallStations() {
  const T = trackTable(), out = [];
  const gaps = [nearest(-12, 113.5).s, nearest(-94, 114).s, T.wpS[52]];
  for (let s = T.wpS[41] + 2; s < T.wpS[53] - 2; s += 4) {
    const gap = gaps.some((g) => Math.abs(s - g) < 6 + 2);
    const r = roadside(s, -1, atDistance(s).width / 2 + 2.05);
    out.push({ x: r1(r.x), z: r1(r.z), rot: r.rotFaceRoad, progress: r.sm.progress, gap });
  }
  return out;
}
/** the cliff top line every 2 m from waypoint 41 to 52 (fallback for terrain.cliffEdge): { x, z, y, nx, nz } with n seaward */
export function cliffEdgeFallback() {
  const T = trackTable(), out = [];
  for (let s = T.wpS[41]; s <= T.wpS[52]; s += 2) {
    const sm = atDistance(s), [lx, lz] = leftOf(sm.tx, sm.tz), off = sm.width / 2 + 0.6 + 4;
    out.push({ x: sm.x + lx * off, z: sm.z + lz * off, y: sm.y, nx: lx, nz: lz });
  }
  return out;
}

/** kerb_module placements from stations (the track's road.kerbs or the fallback) */
export function genKerbs(stations) {
  return stations.map((k, i) => P('kerb_module', k.x, k.z, k.rot, { tag: 'kerb_' + k.side, dy: 0.06 }));
}
/** stone_guardwall placements from wall stations, skipping the gaps */
export function genGuardWalls(stations) {
  return stations.filter((w) => !w.gap).map((w) => P('stone_guardwall', w.x, w.z, w.rot, { tag: 'guardwall' }));
}
/**
 * rock_cliff_module rows from a cliff edge line ({x, z, y, nx, nz} every ~2 m, n seaward). Row 1 every 8 m,
 * base at road y - 8, set 5.2 m out where a 65 degree face has receded 3.7 m; row 2 every 8 m staggered, base
 * at road y - 15, 8.5 m out, only for x between -120 and 20. Each faces the sea with its flat back in the slope.
 */
export function genCliffRocks(edge) {
  const out = [];
  let acc = 0, next1 = 4, next2 = 8;
  for (let i = 1; i < edge.length; i++) {
    const a = edge[i - 1], b = edge[i];
    acc += dhypot(b.x - a.x, b.z - a.z);
    if (acc >= next1) {
      next1 += 8;
      out.push(P('rock_cliff_module', b.x + b.nx * 5.2, b.z + b.nz * 5.2, facing(b.nx, b.nz), { tag: 'cliff_rock_upper', y: b.y - 8 }));
    }
    if (acc >= next2) {
      next2 += 8;
      if (b.x <= 20 && b.x >= -120) out.push(P('rock_cliff_module', b.x + b.nx * 8.5, b.z + b.nz * 8.5, facing(b.nx, b.nz), { tag: 'cliff_rock_lower', y: b.y - 15 }));
    }
  }
  return out;
}

/** 7.7 the cliff: everything that is not a kerb, wall or sea side rock */
function genCliff(rng) {
  const out = [];
  const T = trackTable();
  // agave on the dust strip beyond the wall, between the gaps
  const gaps = [nearest(-12, 113.5).s, nearest(-94, 114).s, T.wpS[52]];
  const span0 = T.wpS[41] + 6, span1 = T.wpS[53] - 6;
  for (let i = 0; i < 8; i++) {
    let s = span0 + ((span1 - span0) * (i + 0.5)) / 8;
    if (gaps.some((g) => Math.abs(s - g) < 9)) s += 10;
    const r = roadside(s, -1, atDistance(s).width / 2 + 3.0 + rng() * 0.6);
    out.push(P('agave_cluster', r.x, r.z, rng() * 360, { tag: 'cliff_agave' }));
  }
  [[-30, 168, 20], [-120, 160, 300], [40, 172, 100]].forEach(([x, z, rot]) => out.push(P('rock_sea_stack', x, z, rot, { tag: 'sea_stack', y: -3 })));
  // inner side rock face: 14 modules from x 30 to x -150 at 12 m pitch, base at the foot's terrain (road y), face toward the road
  const sIn0 = nearest(30, 112).s, sIn1 = nearest(-150, 96).s;
  const innerRocks = [];
  for (let i = 0; i < 14; i++) {
    const s = sIn0 + 6 + 12 * i;
    if (s > sIn1) break;
    const sm = atDistance(s), off = sm.width / 2 + 0.6 + 4 + 3;
    const r = roadside(s, 1, off), foot = roadside(s, 1, sm.width / 2 + 0.6 + 4);
    out.push(P('rock_cliff_module', r.x, r.z, r.rotFaceRoad, { tag: 'cliff_rock_inner', probe: [r1(foot.x), r1(foot.z)] }));
    innerRocks.push({ s, sm });
  }
  for (const [x, z] of [[20, 130], [-10, 133], [-40, 134], [-100, 130], [-130, 126], [-150, 118]]) out.push(P('pine_umbrella', x, z, pineRot(x, z, rng()), { tag: 'cliff_pine' }));
  innerRocks.slice(0, 12).forEach((rk, i) => {
    if (i % 2) return;
    const r = roadside(rk.s + (rng() - 0.5) * 4, 1, rk.sm.width / 2 + 0.6 + 3.3);
    out.push(P('agave_cluster', r.x, r.z, rng() * 360, { tag: 'cliff_agave_inner' }));
  });
  // boulders between the rocks, 2 to 4 m off the kerb
  for (let i = 0; i < 10; i++) {
    const s = sIn0 + 12 * (i + 1) + (rng() - 0.5) * 2;
    if (s > sIn1) break;
    const sm = atDistance(s), r = roadside(s, 1, sm.width / 2 + 0.6 + 2 + rng() * 2 + 1.0);
    out.push(P('rock_boulder', r.x, r.z, rng() * 360, { tag: 'cliff_boulder' }));
  }
  for (const [x, z] of [[60, 92], [48, 102], [34, 110], [18, 116]]) { const n = nearest(x, z); out.push(P('race_flag_pole', x, z, alongRoad(n.sample.tx, n.sample.tz), { tag: 'flags_g' })); }
  // chevron boards: four before the cliff entry corner (right hander), two before the descent corner (right hander), outside = left
  const sG = T.wpS[40];
  for (let i = 0; i < 4; i++) { const s = sG - 34 + 9 * i; const r = roadside(s, -1, atDistance(s).width / 2 + 0.6 + 1.4); out.push(P('sign_chevron_board', r.x, r.z, r.rotFaceBackToward(CHEVRON_TURN), { tag: 'chevrons_g' })); }
  const sI = T.wpS[50];
  for (let i = 0; i < 2; i++) { const s = sI - 24 + 10 * i; const r = roadside(s, -1, atDistance(s).width / 2 + 0.6 + 1.4); out.push(P('sign_chevron_board', r.x, r.z, r.rotFaceBackToward(CHEVRON_TURN), { tag: 'chevrons_i' })); }
  for (const [x, z] of [[0, 122], [-110, 124]]) crowdRun(out, x, z, 0, 2, 'crowd_h');
  return out;
}

/** 7.8 the lighthouse point, the descent and the beach */
function genLighthouseAndBeach(rng) {
  const out = [];
  const T = trackTable();
  const C = LANDMARKS.lighthouse;
  // four guard wall modules on the rock's road side, an arc at radius 22 toward the descent road
  const th0 = datan2(94 - C.z, -152 - C.x);
  for (const dd of [-16.5, -5.5, 5.5, 16.5]) {
    const th = th0 + dd / DEG, dx = dcos(th), dz = dsin(th);
    out.push(P('stone_guardwall', C.x + 22 * dx, C.z + 22 * dz, facing(dx, dz), { tag: 'lighthouse_wall' }));
  }
  for (let i = 0; i < 4; i++) { const th = th0 + Math.PI + (i - 1.5) * 0.7, rr = 9 + 6 * rng(); out.push(P('agave_cluster', C.x + rr * dcos(th), C.z + rr * dsin(th), rng() * 360, { tag: 'lighthouse_agave' })); }
  for (let i = 0; i < 4; i++) { const th = th0 + (i - 1.5) * 0.9 + 0.3, rr = 11 + 7 * rng(); out.push(P('rock_boulder', C.x + rr * dcos(th), C.z + rr * dsin(th), rng() * 360, { tag: 'lighthouse_boulder' })); }
  for (const p of [0.893, 0.905]) { const r = roadside(p * T.length, 1, atProgress(p).width / 2 + 2.0); out.push(P('race_flag_pole', r.x, r.z, r.rotAlong, { tag: 'flags_i' })); }
  // descent inner (east) side: ten retaining walls following the road, palms above, two pines
  const s0 = T.wpS[51], s1 = T.wpS[56];
  for (let i = 0; i < 10; i++) {
    const s = s0 + ((s1 - s0) * (i + 0.5)) / 10, sm = atDistance(s);
    const r = roadside(s, 1, sm.width / 2 + 3.5), foot = roadside(s, 1, sm.width / 2 + 2.6);
    out.push(P('retaining_wall_terrace', r.x, r.z, r.rotFaceRoad, { tag: 'descent_wall', probe: [r1(foot.x), r1(foot.z)] }));
    if (i % 2 === 1 && i < 8) { const q = roadside(s, 1, sm.width / 2 + 7.5); out.push(P('palm_short', q.x, q.z, rng() * 360, { tag: 'descent_palm', tilt: 2 + 4 * rng() })); }
  }
  for (const [x, z] of [[-130, 60], [-128, 40]]) out.push(P('pine_umbrella', x, z, pineRot(x, z, rng()), { tag: 'descent_pine' }));
  // the beach
  const umbrellas = [];
  for (let i = 0; i < 6; i++) { umbrellas.push([-170, 28 + 8 * i]); umbrellas.push([-178, 31 + 8 * i]); }
  umbrellas.forEach(([x, z], i) => {
    out.push(P('beach_umbrella', x, z, rng() * 360, { tag: 'beach_umbrella' }));
    const chairs = i < 2 ? 2 : 1;
    for (let c = 0; c < chairs; c++) out.push(P('deck_chair', x - 1.3 - 0.6 * c, z + (rng() - 0.5) * 2.4 + c * 1.2, 270 + (rng() - 0.5) * 30, { tag: 'deck_chair' }));
  });
  out.push(P('lifeguard_hut', -175, 63, 270, { tag: 'lifeguard_hut' }));                          // facing the sea (west)
  for (const [x, z] of [[-184, 30], [-183, 78], [-186, 90]]) out.push(P('rowing_boat', x, z, 270 + (rng() - 0.5) * 40, { tag: 'rowing_boat_beached' }));
  for (const [x, z] of [[-185, 50], [-186, 58], [-184, 68]]) out.push(P('pedalo', x, z, 270 + (rng() - 0.5) * 30, { tag: 'pedalo' }));
  for (const [x, z] of [[-166, 24], [-166, 46], [-166, 84]]) out.push(P('palm_tall', x, z, rng() * 360, { tag: 'beach_palm', tilt: 4 + 4 * rng() }));
  for (const [x, z] of [[-164, 36], [-164, 56], [-164, 76]]) crowdRun(out, x, z, 90, 3, 'crowd_i');
  for (const [x, z] of [[-170, 21], [-179, 19], [-186, 25], [-172, 95], [-180, 97], [-188, 93]]) out.push(P('rock_boulder', x, z, rng() * 360, { tag: 'cove_boulder' }));
  for (const [x, z] of [[-162, 30], [-162, 52], [-162, 74]]) out.push(P('street_lamp', x, z, 270, { tag: 'beach_lamp' }));
  // round sign posts 40 m before every corner entry, on the outside pavement: [progress of the corner, outside side]
  const corners = [[0.112, -1], [0.208, -1], [0.271, -1], [0.375, -1], [0.513, 1], [0.576, -1], [0.606, 1], [0.683, -1], [0.755, -1], [0.813, -1], [0.868, -1], [0.945, -1]];
  for (const [p, side] of corners) {
    const s = p * T.length - 40, sm = atDistance(s), r = roadside(s, side, sm.width / 2 + 0.6 + 1.2);
    out.push(P('sign_round_post', r.x, r.z, r.rotFaceBack, { tag: 'round_signs' }));
  }
  return out;
}

/**
 * Round 1 skyline (critic item 5: "cliff and promenade frames have a bald grass ridge or a flat sea horizon;
 * add the lighthouse, a church tower, a headland, harbour cranes and tall palms so far silhouettes exist at
 * three depths and pale with distance"). Everything here is an existing asset on the terrain (y null) except
 * the pines whose feet stand inside the headland rock mass (absolute y, like the cliff rows). Where and why,
 * with the terrain heights read from the build (work/fix1_level/heights.json):
 *   - the harbour mouth headland: the flat grass spit north of the north quay wall (x -206..-150, z -140..-168,
 *     y 0.2 to 0.6) was bare, so the quay frames (progress 0.03 to 0.10, looking north) had a flat sea horizon:
 *     a two row arc of rock_cliff_module, pines on top, palms and two davits along the north quay, one sea stack
 *     off the point. 70 to 100 m from the harbour straight: the far layer of the promenade frames.
 *   - the fish market: three tall palms among the stalls and two pines behind the pad (y 0.9 to 1.9), 30 to 40 m
 *     from the market corner where the skyline was the stall roofs and one lamp.
 *   - the hairpin hills: the ground south east of the hairpin rises to 21 m (road 10) and north of it to 17 m,
 *     both bare grass in every hairpin and lower street frame: pines and palms on both.
 *   - the rise's east hill (x 100..125, y 18 to 26, road 13 to 20): a second, higher rank of pines and palms
 *     behind the four the plan put on the terrace at x 86..92, so the rise frames get crowns at two depths.
 */
function genSkyline(rng) {
  const out = [];
  const pine = (x, z, tag, extra = {}) => out.push(P('pine_umbrella', x, z, pineRot(x, z, rng()), Object.assign({ tag }, extra)));
  const palm = (x, z, tag) => out.push(P('palm_tall', x, z, rng() * 360, { tag, tilt: 2 + 5 * rng() }));
  // 1. harbour mouth headland
  const ridge = [[-158, -149], [-166, -153], [-174, -157], [-182, -160], [-190, -162], [-198, -164], [-206, -167]];
  for (const [x, z] of ridge) out.push(P('rock_cliff_module', x, z, facing(-168 - x, -118 - z) + (rng() - 0.5) * 16, { tag: 'headland_rock' }));
  for (const [x, z] of [[-170, -160], [-186, -164], [-201, -170]]) out.push(P('rock_cliff_module', x, z, facing(-168 - x, -118 - z) + (rng() - 0.5) * 16, { tag: 'headland_rock_upper', y: 4.6 }));
  for (const [x, z] of [[-177, -163], [-193, -166], [-163, -157]]) pine(x, z, 'headland_pine', { y: 4.4 });
  for (const [x, z] of [[-152, -138.5], [-171, -139], [-189, -138.5]]) palm(x, z, 'north_quay_palm');
  out.push(P('harbour_davit', -161, -135.5, 0, { tag: 'north_quay_davit' }));
  out.push(P('harbour_davit', -181, -135.5, 0, { tag: 'north_quay_davit' }));
  out.push(P('rock_sea_stack', -207, -142, 20, { tag: 'headland_stack', y: -3 }));
  // 2. the fish market
  for (const [x, z] of [[-118, -170.5], [-106, -170.5], [-127.5, -165]]) palm(x, z, 'market_palm');
  for (const [x, z] of [[-114, -179], [-96, -177]]) pine(x, z, 'market_pine');
  // 3. the hairpin hills: south east above the church pad, and north above the lower street's end
  for (const [x, z] of [[177, -97], [192, -105], [186, -83], [196, -92]]) pine(x, z, 'hairpin_pine');
  for (const [x, z] of [[171, -98], [183, -90]]) palm(x, z, 'hairpin_palm');
  for (const [x, z] of [[150, -172], [132, -177], [168, -164], [183, -160]]) pine(x, z, 'hairpin_pine_n');
  for (const [x, z] of [[142, -183], [160, -178], [176, -152]]) palm(x, z, 'hairpin_palm_n');
  // 4. the rise's east hill
  for (const [x, z] of [[104, -30], [110, 0], [100, 30], [118, -15], [108, 55]]) pine(x, z, 'rise_hill_pine');
  for (const [x, z] of [[96, -58], [114, -45], [125, 25]]) palm(x, z, 'rise_hill_palm');
  return out;
}

// ------------------------------------------------------------------------------------ assembly
function generateStatic() {
  const rng = mulberry32(SEED);
  const out = [];
  out.push(...genLandmarks());
  out.push(...genPads());
  out.push(...genHarbour(rng));
  out.push(...genMarketAndLowerStreet(rng));
  out.push(...genPiazza(rng));
  out.push(...genRise(rng));
  out.push(...genCliff(rng));
  out.push(...genLighthouseAndBeach(rng));
  out.push(...genSkyline(rng));
  return out;
}

/** the rule sets that build.js swaps for the track's own stations when the modules are present */
const FALLBACK_RULE_SETS = () => [
  ...genKerbs(kerbStations()),
  ...genGuardWalls(wallStations()),
  ...genCliffRocks(cliffEdgeFallback()),
];

const STATIC = generateStatic();

/** every placement, with the kerbs, guard walls and cliff rocks from the internal sampler */
export const PLACEMENTS = [...STATIC, ...FALLBACK_RULE_SETS()];

/** movers: boats, buoys, spectator groups, with their bob parameters */
export const MOVERS = PLACEMENTS.filter((p) => p.moving);

/**
 * The house front walls per street as segments [[x0, z0], [x1, z1]] with a height, for
 * world.addWallSegment. The quay row and the rise rows are read off their placements (the arcade
 * set back is a separate segment).
 */
export function houseWalls() {
  const rows = lowerStreetRows();
  const walls = [];
  const push = (a, b, tag) => walls.push({ a, b, height: 9, tag });
  push(rows.south.wall[0], rows.south.wall[1], 'lower_south');
  push(rows.north.wall[0], rows.north.wall[1], 'lower_north');
  const e = genPiazza.rows, f = genRise.rows;
  if (e) { push(e.southE.wall[0], e.southE.wall[1], 'exit_south'); push(e.northE.wall[0], e.northE.wall[1], 'exit_north'); }
  if (f) { push(f.westA.wall[0], f.westA.wall[1], 'rise_west'); push(f.westB.wall[0], f.westB.wall[1], 'rise_west'); }
  // quay houses: fronts along x -124.5 from z 2 to -38 and -50 to -110; the arcade front at x -108 from z -50 to -38
  push([-124.5, 2], [-124.5, -38], 'quay_a'); push([-124.5, -50], [-124.5, -110], 'quay_b'); push([-108, -38], [-108, -50], 'quay_arcade');
  return walls;
}

/**
 * The full placement list for a build: the static expansion plus the rule sets, taking the kerb
 * stations, wall stations and cliff edge from the track modules when they are present and from
 * the internal sampler otherwise. Deterministic either way.
 */
export function expandPlacements({ spline, road, terrain } = {}) {
  void spline;
  // the track's stations (road.js kerbStation) use the same convention: rot = facing(outward), the kerb's road side is -Z,
  // and carry the road edge y, which is used as an absolute height when present (kerbs sit 2 cm above the substrate foot)
  const kerbs = road && Array.isArray(road.kerbs) && road.kerbs.length ? road.kerbs : kerbStations();
  const walls = road && Array.isArray(road.wallStations) && road.wallStations.length ? road.wallStations : wallStations();
  const edge = terrain && Array.isArray(terrain.cliffEdge) && terrain.cliffEdge.length > 4 ? terrain.cliffEdge : cliffEdgeFallback();
  // round 3 (track -> level): the ribbon carries the striped kerb profile (apron, riser, top); the module would sit 2 cm above it for 53 to 75k triangles a view
  const kerbP = (road && road.kerbInRibbon ? [] : genKerbs(kerbs)).map((p, i) => (typeof kerbs[i].y === 'number' ? { ...p, y: r1(kerbs[i].y + 0.02), dy: undefined, onGround: true } : p));
  const wallsKept = walls.filter((w) => !w.gap);
  const wallP = genGuardWalls(walls).map((p, i) => (typeof wallsKept[i].y === 'number' ? { ...p, y: r1(wallsKept[i].y), onGround: true } : p));
  return [...STATIC, ...kerbP, ...wallP, ...genCliffRocks(edge)];
}

/** counts per asset in a placement list */
export function countPlacements(list = PLACEMENTS) {
  const m = new Map();
  for (const p of list) m.set(p.asset, (m.get(p.asset) || 0) + 1);
  return m;
}
