/**
 * track/road.js - the road ribbon of docs/TRACK-PLAN.md section 3 (road build) and section 6.
 *
 * One mesh per 30 m block (section 10), built from the spline table every 1.5 m:
 *   - the road surface between -width/2 and +width/2 with the interpolated bank, strips fixed by
 *     lateral so the paint lands on its own quads: an edge line each side (0.25 m), a centre dash
 *     (0.15 m, 3 m on 3 m off) on the asphalt sections A, F, G, H, I, and (round 2 fix, item 6:
 *     "a paint line converging to the vanishing point in every straight frame", gRange 75 against
 *     the bar's 149) dashed LANE LINES a sixth of the width either side of the centre on every
 *     section, half a period out of phase with the centre dash, plus the pack's rubber in the
 *     outer lanes (a fainter pair of marks at a third of the width out, each side);
 *   - the race kerb APRON (round 2 fix, item 4: kerbRW registered on 2 of 8 frames): wherever
 *     kerb_module stations run, a 1.2 m rumble strip on the road surface inside the edge, red and
 *     white at the module's 1 m pitch and in its phase (stripeAt), rising 6 cm to the block in two
 *     facets, replacing the edge line and the town gutter on that side, so the kerb reads 1.8 m wide
 *     from the chase camera instead of a 0.6 m block at the frame's edge; the probe follows the rise;
 *   - a kerb SUBSTRATE outside each edge where the plan puts a kerb: 0.6 m wide, 0.24 m tall,
 *     top whitewash where kerb_module stations are exported (the asset sits on it and its own
 *     top at 0.26 to 0.30 m clears the substrate), warm stone where the kerb is a plain town
 *     kerb without a race module;
 *   - a 2.5 m pavement at 0.30 m (cobble slabs) through the town sections A(east), B, C, D, E, F;
 *     a 0.6 m asphalt shoulder at kerb top height on G, H, I; the quay deck strip on A west;
 *   - a 2 m warm stone sill across the road at the two surface changes (waypoints 7 and 32);
 *   - the chequered start band 1 m deep at progress 0.037 (0.5 m squares);
 *   - the RACING LINE (round 1 fix, critic: "one cobble texture tiled at one scale, no
 *     direction"): a 3.0 m polished band following the line (inside on entry, outside on exit),
 *     up to 22 percent lighter and smoother (roughness 0.45 against 0.88) with the polish
 *     wandering along s, two 0.35 m tyre marks 1.1 m apart on it, 22 percent darker on the
 *     straights rising to 42 percent into and through every corner (braking marks) with the
 *     darkness breathing along s, plus corner skids that wander up to 1.6 m off the line and fade
 *     in and out, all on their own thin layers;
 *   - in the town (cobble sections) a whitewash edge line 0.18 m, a 0.5 m stone gutter dipped
 *     3 cm inside it, a 0.36 m centre drain channel down the lower street and the piazza exit
 *     street, and asphalt repair patches (their own quads with the asphalt texture) so the
 *     cobble field is broken by things a driver reads;
 *   - the eight painted grid slots behind the start line (TRACK-PLAN 7.1);
 *   - vertex colour carries the palette plus 3 percent value noise, so the render agent's
 *     applyRoadMaterial (tint x texel / mean) keeps it. The paving tints are WARM GREY, more
 *     neutral and a step lighter than the round 0 values (cobble 0x9a8f80 -> 0xa39f99, asphalt
 *     0x4d5058 -> 0x65686e): under the warm low sun the round 0 cobble rendered as a saturated
 *     mauve brown (nearSat 0.52 to 0.65 against the bar's 0.38: lit cobble measured at sRGB
 *     (162, 117, 78)) and the asphalt crushed to near black in shade. The bar's golden hour
 *     paving is a light warm grey, lit about (150 to 205, 118 to 175, 80 to 170) with shade at
 *     half to three quarters of lit; the palette hex is the tint BEFORE the sun, and this is the
 *     tint that lands there. terrain.js paints the same cobble and asphalt values.
 *
 * Attributes on every tile: position, normal, uv, color, aSurface, aAcross, aSurf, aRM.
 *   uv       METRIC on both axes: u = s / 4, v = 0.5 + lateral / 4 (one uv unit = 4 m). The
 *            contract said "v across 0..1"; that stretches a square texel to 11 to 14 m across
 *            against 4 m along, so the metric v is used and the 0..1 value is in aAcross.
 *   aSurface 0 asphalt, 1 cobble, 2 kerb substrate, 3 pavement, 4 shoulder, 5 paint, 6 sill,
 *            7 chequer, 8 tyre mark, 9 quay deck, 10 asphalt patch, 11 gutter, 12 racing line,
 *            13 race kerb apron
 *   aAcross  0..1 across the road width (below 0 or above 1 on kerbs and pavements)
 *   aSurf    the render module's texture pick per vertex: 0 asphalt set, 1 cobble set (written
 *            here so a patch on a cobble street takes the asphalt texture; applyRoadMaterial
 *            keeps it when present)
 *   aRM      (roughness, metalness) per vertex: 0.88 paving, 0.45 racing line core, 0.62 tyre
 *            marks, 0.72 gutters, 0.70 channel, 0.80 patches, 0.50 paint and apron (glossy under the
 *            low sun) (applyRoadMaterial keeps it when present)
 * Tiles: receiveShadow true, userData { kind: 'road', block, sMin, sMax, surfaces }.
 */
// Deterministic transcendentals, not the host's: Math.sin/cos/tan/atan2/pow/exp are not
// specified to the last bit by ECMAScript and Chrome and Node genuinely disagree, which over a
// 15 000 tick race is the difference between two cars. See src/token/detmath.js.
import { datan2, dcos, dhypot, dsin, dtan, dtanh } from '../token/detmath.js?v=r6-20260906191941';
import * as THREE from 'three';
import { Spline, START_PROGRESS } from './spline.js?v=r6-20260906191941';

export const ROAD = {
  KERB_W: 0.6, KERB_H: 0.24,          // substrate; the kerb_module asset (0.30 tall) sits on the road at the kerb base
  PAVE_W: 2.5, PAVE_H: 0.30,          // pavement at kerb top height (style lock)
  SHOULDER_W: 0.6, QUAY_W: 1.0,
  EDGE_LINE: 0.25, DASH_W: 0.15, DASH_ON: 3.0, DASH_OFF: 3.0,
  LANE_W: 0.15, LANE_FRAC: 1 / 6, LANE_ON: 4.5, LANE_OFF: 1.5,   // dashed lane lines a sixth of the width either side of the centre (three lanes), long dashes so a near band frame always holds one
  PAINT_ROUGH: 0.50,                  // paint is glossy under the low sun (round 2 critic: real specular on paint)
  // the race kerb APRON (round 2 fix, item 4): where kerb_module stations run, a 1.2 m striped rumble strip on the
  // road surface inside the edge, red and white at the asset's 1 m pitch and phase, rising 6 cm to the kerb block
  // in two facets (relief the sun lands on), so the kerb reads 1.8 m wide from the chase camera instead of 0.6
  APRON_W: 1.2, APRON_W_WIDE: 1.6, APRON_ROUGH: 0.50,
  // round 3 fix, item 4 (critic: "the beach kerb is a flat stripe", "the harbour straight has no kerb"): the apron is now
  // a CONVEX rumble profile (4, 9, 15 cm over the slope) ending in a 62 degree RISER up to the kerb TOP at RACE_KERB_H,
  // and the top is striped too, so apron, riser and top are one continuous red and white kerb at the module's 1 m
  // pitch: a lit top, a lit or shaded riser (the sun is 14 degrees up, so the riser facing it is bright and the one
  // facing away is in shade) and, because the ribbon tiles now cast within CAST_DIST, a shadow onto the road.
  // RACE_KERB_H is 4 cm over the plan's 0.30 so the level's kerb_module (placed 2 cm up, 0.30 tall) is fully inside
  // the ribbon's kerb until the level stops placing it (work/fix3_track/NOTES.md); the pavement stays at 0.30.
  RACE_KERB_H: 0.34, RISER_W: 0.10, RISER_IN: 0.02, KERB_EDGE: 0.06,
  APRON_SLOPE: [[0, 0], [0.37, 0.04], [0.74, 0.09], [1, 0.15]],   // (fraction of the slope run, rise) up to the riser foot
  PAINT_WEAR: [0.55, 0.78], PAINT_WEAR_MIX: 0.85,                  // paint lines break where the surface is worn (2.4 m noise)
  DRAIN_PITCH: 9, DRAIN_SIZE: 0.45, DRAIN_ROUGH: 0.55,             // drain covers along both edges
  OUTER_TYRE: 0.75,                   // the outer lanes carry the pack's rubber at this fraction of the racing line's marks
  EDGE_LINE_TOWN: 0.25, GUTTER_W: 0.5, GUTTER_DIP: 0.03,      // cobble streets: edge paint and the stone gutter inside it
  CHANNEL_W: 0.36, CHANNEL_ROUGH: 0.70,                        // the centre drain channel down the old town streets (C and E)
  SILL_LEN: 2.0, TYRE_W: 0.35, TYRE_TRACK: 1.1, TYRE_DARKEN: 0.42, TYRE_STRAIGHT: 0.28, TYRE_ROUGH: 0.62,
  SKID_DARKEN: 0.38, SKID_WANDER: 1.6,                         // extra corner skids that wander off the line and fade in and out
  LINE_W: 3.0, LINE_SOFT: 0.55, LINE_LIGHT: 0.22, LINE_ROUGH: 0.45,  // the polished racing line band
  PATCH_PITCH: 22, PATCH_CHANCE: 0.65, PATCH_ROUGH: 0.80,           // asphalt repairs on the cobble streets
  ROUGH: 0.88, GUTTER_ROUGH: 0.72,
  GRID_W: 1.9, GRID_L: 2.6, GRID_LINE: 0.14,                        // painted grid slot: open box, front bar plus two sides
  WALL_OFFSET: 1.8,                   // guard wall centre beyond the kerb outer edge (plan: 1.2 m outside the kerb) + half the wall
  CLIFF_DROP: 4.6,                    // cliff face begins width/2 + 0.6 kerb + 4 m of verge (plan 4.3)
  GAP_HALF: 6.0,                      // the three fall gaps are 12 m wide
  BLOCK: 30, BLOCK_X0: -210, BLOCK_Z0: -190,
};

// Style lock palette (sRGB hex), converted to linear by THREE.Color at use.
export const PALETTE = {
  asphalt: 0x65686e, cobble: 0xa39f99, whitewash: 0xf1e6d2, warmStone: 0xcdb897, stoneShade: 0x8d7b63,
  pavement: 0xb0aba3, shoulder: 0x6c6e73, sand: 0xe6cf9c,
  gutter: 0x858179, channel: 0x6a6760, patch: 0x777a7e,
  patchDark: 0x585b62, patchLight: 0x74777d,   // asphalt repairs on the asphalt sections: a fresh (darker) or faded (lighter) rectangle
  drain: 0x3a3f46, drainRim: 0x8d7b63,          // drain covers: metal dark with a stone shade rim
  // paint and the apron stripes: a near neutral white (saturation 0.02, the lightness paintKerb gives the block tops) so the
  // warm sun lands it under the claims' white (luma over 200, saturation under 0.20) and a kerb red a shade
  // lighter than the palette's 0xd6402f (hue 5, HSV saturation 0.75) so the sun does not push it salmon; the same
  // values the level paints on kerb_module, so the apron continues the block's stripe (work/fix1_level, paintKerb)
  paint: 0xf8f6f2, kerbRed: 0xe64a3c, kerbWhite: 0xf8f6f2,
};

/** Grid slots P1..P8 (TRACK-PLAN 7.1), all heading north (-Z); the paint is an open box per slot. */
export const GRID_SLOTS = [
  { x: -137.5, z: -37 }, { x: -130.5, z: -35.5 }, { x: -137.5, z: -29 }, { x: -130.5, z: -27.5 },
  { x: -137.5, z: -21 }, { x: -130.5, z: -19.5 }, { x: -137.5, z: -13 }, { x: -130.5, z: -11.5 },
];

export const PAD_DEFS = [   // TRACK-PLAN 7.2, rot in degrees (chevrons point along the racing direction), 3 m wide x 4 m long
  { id: 'B1a', x: -137, z: -100, rot: 180 }, { id: 'B1b', x: -131, z: -100, rot: 180 },
  { id: 'B2', x: 60, z: -155.7, rot: 90 }, { id: 'B3', x: 64, z: 30, rot: 0 },
  { id: 'B4a', x: -90, z: 114, rot: 270 }, { id: 'B4b', x: -102, z: 114, rot: 270 },
  { id: 'B5', x: -147, z: 27, rot: 165 },
];
export const PAD_HALF = { x: 1.5, z: 2.0 };

const DEG = Math.PI / 180;
const SURF = { asphalt: 0, cobble: 1, kerb: 2, pavement: 3, shoulder: 4, paint: 5, sill: 6, chequer: 7, tyre: 8, quay: 9, patch: 10, gutter: 11, line: 12, apron: 13 };
const TEX = { asphalt: 0, cobble: 1 };   // aSurf: which PATINA set the render module blends to at the vertex

// ------------------------------------------------------------------------------------ helpers
function hash2(x, z) {
  const s = dsin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function smooth(t) { return t * t * (3 - 2 * t); }
/** Deterministic value noise in [0, 1) at a wavelength (metres). Shared with terrain.js. */
export function noise2(x, z, wavelength = 1) {
  x /= wavelength; z /= wavelength;
  const ix = Math.floor(x), iz = Math.floor(z), fx = smooth(x - ix), fz = smooth(z - iz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
}
export function smoothstep(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function mod(a, n) { return ((a % n) + n) % n; }

/**
 * The cross section kind on one side at a distance s (TRACK-PLAN section 3 road build, section 6).
 * side: -1 left of travel, +1 right. Returns { kind, white } where
 *   kind  'pavement' kerb substrate + 2.5 m pavement (town), 'kerb' kerb substrate + shoulder,
 *         'shoulder' plain 0.6 m shoulder, 'quay' the 1 m quay deck strip (A west)
 *   white true where kerb_module stations run (the substrate top is whitewash)
 * terrain.js uses the same function so the flatten bands agree with the ribbon.
 */
export function sideProfile(spline, s, side) {
  const R = (a, b) => spline.inWaypointRange(s, a, b);
  // A: the harbour straight carries the race kerb on BOTH sides (round 3, critic bar pair 1: "no kerb and one lane
  // line on flat asphalt"); the quay side keeps its deck strip beyond the kerb block
  if (R(0, 7)) return side < 0 ? { kind: 'quay', white: true } : { kind: 'pavement', white: true };            // A
  if (R(7, 11)) return { kind: 'pavement', white: true };                                                        // B both
  if (R(11, 20)) return { kind: 'pavement', white: side > 0 ? true : R(12, 16) };                               // C outer, inner at the S bends
  if (R(20, 32)) return { kind: 'pavement', white: true };                                                       // D, E both
  if (R(32, 40)) return { kind: 'pavement', white: R(32, 39) };                                                  // F through the chicane
  if (R(40, 44)) return { kind: 'kerb', white: true };                                                           // G both
  if (R(44, 50)) return { kind: 'kerb', white: side > 0 };                                                       // H inner; sea side carries the wall
  return { kind: 'kerb', white: side > 0 ? true : R(55, 59) };                                                   // I inner; beach side from wp 55
}
/** True where the town pavement band applies (used by terrain.js for the +0.30 flatten band). */
export function hasPavement(spline, s, side) { return sideProfile(spline, s, side).kind === 'pavement'; }

/** Road surface y at a lateral offset (bank inside the width, flat beyond the edge). */
export function yAt(q, l) {
  const h = q.width / 2;
  const lb = l < -h ? -h : l > h ? h : l;
  return q.y - lb * dtan(q.bank * DEG);
}
/** Race kerb apron width for a road width: 1.2 m, 1.6 m on the 14 m harbour straight (blended over 12.5 to 13.5). */
export function apronWidth(width) { return ROAD.APRON_W + (ROAD.APRON_W_WIDE - ROAD.APRON_W) * smoothstep(12.5, 13.5, width); }
/**
 * Race kerb profile height at d metres outward from the apron's road side (apron width W): the convex slope
 * (APRON_SLOPE) over the first W - RISER_W metres, the riser up to RACE_KERB_H ending RISER_IN inside the road edge,
 * then the flat top (the kerb block, KERB_W beyond the edge). Used by the ribbon and by the probe, so the kart rides
 * exactly what it sees.
 */
export function apronRise(d, W = ROAD.APRON_W) {
  const run = W - ROAD.RISER_W, riserEnd = W - ROAD.RISER_IN, H = ROAD.RACE_KERB_H;
  if (d <= 0) return 0;
  if (d < run) {
    const t = d / run, P = ROAD.APRON_SLOPE;
    for (let k = 1; k < P.length; k++) if (t <= P[k][0]) { const [t0, y0] = P[k - 1], [t1, y1] = P[k]; return y0 + (y1 - y0) * (t - t0) / (t1 - t0); }
    return P[P.length - 1][1];
  }
  const foot = ROAD.APRON_SLOPE[ROAD.APRON_SLOPE.length - 1][1];
  if (d < riserEnd) return foot + (H - foot) * (d - run) / (riserEnd - run);
  return H;
}
/** Interpolated spline row between a and b at t (for sub row quads: the apron stripes change every metre, rows every 1.5). */
function lerpRow(a, b, t, out) {
  out.x = a.x + (b.x - a.x) * t; out.z = a.z + (b.z - a.z) * t; out.y = a.y + (b.y - a.y) * t;
  let nx = a.nx + (b.nx - a.nx) * t, nz = a.nz + (b.nz - a.nz) * t;
  const nl = dhypot(nx, nz) || 1; out.nx = nx / nl; out.nz = nz / nl;
  out.width = a.width + (b.width - a.width) * t; out.bank = a.bank + (b.bank - a.bank) * t;
  out.tx = a.tx + (b.tx - a.tx) * t; out.tz = a.tz + (b.tz - a.tz) * t; out.grade = (a.grade || 0) + ((b.grade || 0) - (a.grade || 0)) * t;
  out.s = a.s + (b.s - a.s) * t; out.surface = a.surface; out.curvature = a.curvature;
  return out;
}

// ------------------------------------------------------------------------------ tile builder
class TileBuilder {
  constructor(key) {
    this.key = key; this.pos = []; this.nrm = []; this.uv = []; this.col = []; this.surf = []; this.across = []; this.idx = [];
    this.tex = []; this.rm = [];
    this.sMin = Infinity; this.sMax = -Infinity; this.surfaces = new Set();
  }
  vertex(x, y, z, n, u, v, c, surf, across, tex = 0, rough = ROAD.ROUGH) {
    this.pos.push(x, y, z); this.nrm.push(n.x, n.y, n.z); this.uv.push(u, v); this.col.push(c.r, c.g, c.b);
    this.surf.push(surf); this.across.push(across); this.tex.push(tex); this.rm.push(rough, 0);
    return this.pos.length / 3 - 1;
  }
  /**
   * a0 a1 on the first row (left to right), b0 b1 on the second row, wound counter clockwise
   * about `n` (the intended face normal) so FrontSide culling keeps the face whichever way the
   * strip runs: the geometric normal of (a0, a1, b0) is compared with n and the quad is mirrored
   * when they disagree (vertical kerb faces on the two sides run opposite ways).
   */
  quad(a0, a1, b0, b1, n) {
    const p = this.pos;
    const ax = p[a0 * 3], ay = p[a0 * 3 + 1], az = p[a0 * 3 + 2];
    const ux = p[a1 * 3] - ax, uy = p[a1 * 3 + 1] - ay, uz = p[a1 * 3 + 2] - az;
    const vx = p[b0 * 3] - ax, vy = p[b0 * 3 + 1] - ay, vz = p[b0 * 3 + 2] - az;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * n.x + cy * n.y + cz * n.z >= 0) this.idx.push(a0, a1, b0, a1, b1, b0);
    else this.idx.push(a1, a0, b1, a0, b0, b1);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aSurface', new THREE.Float32BufferAttribute(this.surf, 1));
    g.setAttribute('aAcross', new THREE.Float32BufferAttribute(this.across, 1));
    g.setAttribute('aSurf', new THREE.Float32BufferAttribute(this.tex, 1));
    g.setAttribute('aRM', new THREE.Float32BufferAttribute(this.rm, 2));
    g.setIndex(this.idx);
    g.computeBoundingBox(); g.computeBoundingSphere();
    return g;
  }
}

/**
 * Build the ribbon. `spline` is a Spline (see spline.js). Returns
 * { tiles, kerbs, wallStations, padStations, pads, surfaceAt, heightAt, probe, material }.
 */
export function buildRoad(THREE_, spline, opts = {}) {
  const rows = spline.samples, N = spline.count, ds = spline.ds, L = spline.length;
  const C = {};
  for (const k of Object.keys(PALETTE)) C[k] = new THREE.Color(PALETTE[k]);
  const UP = new THREE.Vector3(0, 1, 0);
  const tmpN = new THREE.Vector3(), tmpC = new THREE.Color();
  const tiles = new Map();
  const blockKey = (x, z) => Math.floor((x - ROAD.BLOCK_X0) / ROAD.BLOCK) + '_' + Math.floor((z - ROAD.BLOCK_Z0) / ROAD.BLOCK);
  const tileFor = (x, z) => { const k = blockKey(x, z); let t = tiles.get(k); if (!t) { t = new TileBuilder(k); tiles.set(k, t); } return t; };

  // sills at the two surface changes; the start band
  const sills = [spline.waypointS[7], spline.waypointS[32]];
  const startS = START_PROGRESS * L;

  // per row: cornerness (max |curvature| within 12 m), braking (cornerness up to 15 m AHEAD, so the
  // tyre marks darken into a corner before it), and the racing line lateral
  const corner = new Float32Array(N), ahead = new Float32Array(N), rline = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let m = 0, ma = 0;
    for (let d = -8; d <= 8; d++) m = Math.max(m, Math.abs(rows[mod(i + d, N)].curvature));
    for (let d = 0; d <= 10; d++) ma = Math.max(ma, Math.abs(rows[mod(i + d, N)].curvature));
    corner[i] = clamp(m / 0.03, 0, 1);
    ahead[i] = clamp(ma / 0.03, 0, 1);
    const ka = rows[mod(i + 8, N)].curvature, kb = rows[mod(i - 8, N)].curvature, k0 = rows[i].curvature;
    rline[i] = 0.35 * rows[i].width * dtanh((ka - kb + 0.6 * k0) / 0.03);
  }
  // ---- race kerb runs per side (section 6): where kerb_module stations go, and where the apron stripes run.
  // Walk s in 0.5 m steps to find the white runs; a station every 4 m inside each run (the pitch stretched a
  // hair so the run closes on modules). stripeAt(s, side) gives the apron colour at s in the PHASE of the
  // module on that station: block i (0 red, 1 white, 2 red, 3 white) sits at the module's local x in
  // [-2 + i, -1 + i], and the module's +X runs along +s on the right side and along -s on the left
  // (rot = facing outward; checked in work/fix2_track/nodecheck.mjs), so the apron continues the block.
  const runs = { [-1]: [], [1]: [] };
  for (const side of [-1, 1]) {
    let runStart = -1;
    const step = 0.5;
    const flush = (sEnd) => {
      if (runStart < 0) return;
      const len = sEnd - runStart;
      const count = Math.max(1, Math.round(len / 4));
      runs[side].push({ start: runStart, len, count, pitch: len / count });
      runStart = -1;
    };
    for (let s = 0; s <= L + 1e-6; s += step) {
      const white = s < L && sideProfile(spline, s, side).white;
      if (white && runStart < 0) runStart = s;
      if (!white && runStart >= 0) flush(s);
    }
    flush(L);
    // a run that ends at the lap end and one that starts at s = 0 are one run across the origin (the harbour
    // straight holds waypoint 0): merge them so the stripes and the stations keep one phase over the wrap
    const rs = runs[side];
    if (rs.length > 1 && rs[0].start < 1e-6 && Math.abs(rs[rs.length - 1].start + rs[rs.length - 1].len - L) < 1e-6) {
      const last = rs.pop(), first = rs.shift();
      const len = last.len + first.len, count = Math.max(1, Math.round(len / 4));
      rs.push({ start: last.start, len, count, pitch: len / count });
    }
  }
  function stripeAt(s, side) {
    s = mod(s, L);
    for (const r of runs[side]) {
      const sl = s < r.start ? s + L : s;   // a run may cross the lap origin
      if (sl < r.start || sl >= r.start + r.len) continue;
      s = sl;
      const k = Math.min(r.count - 1, Math.floor((s - r.start) / r.pitch));
      const sc = r.start + r.pitch * (k + 0.5);
      const xl = side > 0 ? s - sc : sc - s;
      const blk = clamp(Math.floor(xl + 2), 0, 3);
      return blk % 2 === 0 ? 'red' : 'white';
    }
    return null;
  }
  /** [{ s0, s1, red }] stripe segments of the apron on `side` between sa and sb (boundaries found to 2 mm). */
  function stripeSegments(sa, sb, side) {
    const segs = [];
    let s0 = sa, c0 = stripeAt(sa + 0.002, side) || 'white';
    for (let s = sa + 0.1; s < sb - 1e-6; s += 0.1) {
      const c = stripeAt(s, side) || 'white';
      if (c === c0) continue;
      let lo = s - 0.1, hi = s;
      for (let k = 0; k < 6; k++) { const m = (lo + hi) / 2; if ((stripeAt(m, side) || 'white') === c0) lo = m; else hi = m; }
      segs.push({ s0, s1: hi, red: c0 === 'red' }); s0 = hi; c0 = c;
    }
    segs.push({ s0, s1: sb, red: c0 === 'red' });
    return segs;
  }
  // per row: which side carries the race kerb apron (the stripes replace the edge line and the town gutter there)
  const apronL = new Uint8Array(N), apronR = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const sm = rows[i].s + ds / 2;
    apronL[i] = sideProfile(spline, sm, -1).white ? 1 : 0; apronR[i] = sideProfile(spline, sm, 1).white ? 1 : 0;
  }
  /** metres of the road edge on one side that the racing line and the marks must stay off: the apron, or the paint and gutter */
  const edgeInset = (i, side) => ((side < 0 ? apronL[i] : apronR[i]) ? apronWidth(rows[i].width) : (rows[i].surface === 'asphalt' ? ROAD.EDGE_LINE : ROAD.EDGE_LINE_TOWN + ROAD.GUTTER_W));
  // the racing line must stay off the apron, the paint and the gutter: clamp to the inner surface on each side
  for (let i = 0; i < N; i++) {
    const h = rows[i].width / 2;
    rline[i] = clamp(rline[i], -(h - edgeInset(i, -1) - ROAD.LINE_W / 2 - 0.05), h - edgeInset(i, 1) - ROAD.LINE_W / 2 - 0.05);
  }

  /** vertex colour with 3 percent noise; `dark` darkens (tyre marks), negative lightens (the polished line). */
  function tone(base, s, l, dark = 0) {
    const n = (noise2(s, l, 1.2) - 0.5) * 0.04 + (noise2(s, l, 5) - 0.5) * 0.03;
    const f = (1 + n) * (1 - dark);
    return tmpC.copy(base).multiplyScalar(f);
  }
  /**
   * Base colour of the road surface at lateral l for the pair starting at row i (paint aware).
   * Writes surfOut.v (aSurface), surfOut.tex (aSurf), surfOut.rough (aRM.x).
   */
  const wornC = new THREE.Color();
  /**
   * Paint that BREAKS where the surface is worn (round 3, item 4: "paint lines sit in the road surface and break
   * where the surface is worn"): a 2.4 m value noise along s (its own seed per line) gates the paint toward the
   * paving under it, PAINT_WEAR_MIX at full wear, and the roughness follows so a worn dash loses its gloss too.
   */
  function wornPaint(base, sMid, seed, surfOut) {
    const w = smoothstep(ROAD.PAINT_WEAR[0], ROAD.PAINT_WEAR[1], noise2(sMid, seed, 2.4)) * ROAD.PAINT_WEAR_MIX;
    if (w <= 0) return C.paint;
    surfOut.rough = ROAD.PAINT_ROUGH + (ROAD.ROUGH - ROAD.PAINT_ROUGH) * w;
    return wornC.copy(C.paint).lerp(base, w);
  }
  function roadColourAt(i, sMid, l, surfOut) {
    const r = rows[i];
    const h = r.width / 2;
    const asphalt = r.surface === 'asphalt';
    const side = l < 0 ? -1 : 1, al = Math.abs(l);
    const apron = side < 0 ? apronL[i] : apronR[i];
    const AW = apronWidth(r.width);
    surfOut.tex = asphalt ? TEX.asphalt : TEX.cobble; surfOut.rough = ROAD.ROUGH; surfOut.edge = false;
    for (const ss of sills) if (Math.abs(sMid - ss) < ROAD.SILL_LEN / 2) { surfOut.v = SURF.sill; surfOut.tex = TEX.cobble; surfOut.rough = 0.80; return C.warmStone; }
    // the race kerb apron owns the edge on its side (its own quads, see emitApron): anything asked for there is paint
    if (apron && al > h - AW) { surfOut.v = SURF.apron; surfOut.rough = ROAD.APRON_ROUGH; surfOut.edge = true; surfOut.tex = TEX.asphalt; return C.kerbWhite; }
    // the dashed lane lines, three lanes, half a period out of phase with the centre dash (asphalt and cobble alike)
    const period = ROAD.DASH_ON + ROAD.DASH_OFF;
    const laneOn = mod(sMid, ROAD.LANE_ON + ROAD.LANE_OFF) < ROAD.LANE_ON;
    const lane = r.width * ROAD.LANE_FRAC;
    const paving = asphalt ? C.asphalt : C.cobble;
    if (asphalt) {
      if (!apron && al > h - ROAD.EDGE_LINE) { surfOut.v = SURF.paint; surfOut.rough = ROAD.PAINT_ROUGH; surfOut.edge = true; return wornPaint(paving, sMid, 510 + side * 37, surfOut); }
      const dashOn = mod(sMid, period) < ROAD.DASH_ON;
      if (dashOn && al < ROAD.DASH_W / 2) { surfOut.v = SURF.paint; surfOut.rough = ROAD.PAINT_ROUGH; return wornPaint(paving, sMid, 620, surfOut); }
      if (laneOn && Math.abs(al - lane) < ROAD.LANE_W / 2) { surfOut.v = SURF.paint; surfOut.rough = ROAD.PAINT_ROUGH; return wornPaint(paving, sMid, 700 + side * 41, surfOut); }
      surfOut.v = SURF.asphalt;
      return C.asphalt;
    }
    // town: edge paint at the gutter lip, the stone gutter inside it, cobble between (none of that beside the apron)
    // paint on the cobbles takes the flatter asphalt set (paint fills the joints; the cobble set's joints cut a line into dashes)
    if (!apron && al > h - ROAD.EDGE_LINE_TOWN) { surfOut.v = SURF.paint; surfOut.rough = ROAD.PAINT_ROUGH; surfOut.edge = true; surfOut.tex = TEX.asphalt; return wornPaint(paving, sMid, 510 + side * 37, surfOut); }
    if (!apron && al > h - ROAD.EDGE_LINE_TOWN - ROAD.GUTTER_W) { surfOut.v = SURF.gutter; surfOut.rough = ROAD.GUTTER_ROUGH; surfOut.edge = true; return C.gutter; }
    if (laneOn && Math.abs(al - lane) < ROAD.LANE_W / 2) { surfOut.v = SURF.paint; surfOut.rough = ROAD.PAINT_ROUGH; surfOut.tex = TEX.asphalt; return wornPaint(paving, sMid, 700 + side * 41, surfOut); }
    surfOut.v = SURF.cobble;
    return C.cobble;
  }

  const so = { v: 0, tex: 0, rough: ROAD.ROUGH };
  // emit one quad between rows a (s = sa) and b (s = sb) spanning lateral la0..la1 / lb0..lb1 with heights ya0.. (absolute)
  function emit(tb, a, b, sa, sb, la0, la1, lb0, lb1, ya0, ya1, yb0, yb1, na, nb, colour, surf, tex = 0, rough = ROAD.ROUGH) {
    const wa = a.width, wb = b.width;
    const v0 = tb.vertex(a.x + a.nx * la0, ya0, a.z + a.nz * la0, na, sa / 4, 0.5 + la0 / 4, colour, surf, 0.5 + la0 / wa, tex, rough);
    const v1 = tb.vertex(a.x + a.nx * la1, ya1, a.z + a.nz * la1, na, sa / 4, 0.5 + la1 / 4, colour, surf, 0.5 + la1 / wa, tex, rough);
    const v2 = tb.vertex(b.x + b.nx * lb0, yb0, b.z + b.nz * lb0, nb, sb / 4, 0.5 + lb0 / 4, colour, surf, 0.5 + lb0 / wb, tex, rough);
    const v3 = tb.vertex(b.x + b.nx * lb1, yb1, b.z + b.nz * lb1, nb, sb / 4, 0.5 + lb1 / 4, colour, surf, 0.5 + lb1 / wb, tex, rough);
    tb.quad(v0, v1, v2, v3, na);
    tb.surfaces.add(surf); tb.sMin = Math.min(tb.sMin, sa); tb.sMax = Math.max(tb.sMax, sb);
  }
  // a flat layer strip over the road surface; the lateral pair may differ between the two rows
  function stripFlat(tb, a, b, sa, sb, la0, la1, lb0, lb1, dy, na, nb, colour, surf, tex, rough) {
    emit(tb, a, b, sa, sb, la0, la1, lb0, lb1, yAt(a, la0) + dy, yAt(a, la1) + dy, yAt(b, lb0) + dy, yAt(b, lb1) + dy, na, nb, colour, surf, tex, rough);
  }
  /**
   * Lateral stops across the road with their y dip; the paint, the lane lines and the gutter land on their own
   * quads. A side with the race kerb apron starts inside it (the apron is emitted separately, striped).
   */
  function stops(h, width, asphalt, apL, apR) {
    const arr = [];
    const push = (l, dy = 0) => arr.push({ l, dy });
    const A = apronWidth(width), D = ROAD.DASH_W / 2, LW = ROAD.LANE_W / 2, lane = width * ROAD.LANE_FRAC;
    // inner span: from the left inner edge to the right inner edge, with the lane lines and the centre dash on their own quads
    const interior = (l0, l1) => {
      const cuts = [l0, -lane - LW, -lane + LW, -D, D, lane - LW, lane + LW, l1];
      for (let c = 0; c < cuts.length - 1; c++) {
        const a = cuts[c], b = cuts[c + 1];
        if (c === 0) push(a);
        const wide = (b - a) > 1.0;   // split the plain runs in three so the value noise reads
        if (wide) { push(a + (b - a) / 3); push(a + 2 * (b - a) / 3); }
        push(b);
      }
    };
    if (asphalt) {
      const E = ROAD.EDGE_LINE;
      if (apL) push(-h + A); else { push(-h); push(-h + E); }
      interior(apL ? -h + A : -h + E, apR ? h - A : h - E);
      if (apR) { /* the apron quads end at h */ } else { push(h - E); push(h); }
    } else {
      const E = ROAD.EDGE_LINE_TOWN, G = ROAD.GUTTER_W, dip = -ROAD.GUTTER_DIP;
      const inner = h - E - G;
      if (apL) push(-h + A); else { push(-h); push(-h + E); push(-h + E + G / 2, dip); }
      interior(apL ? -h + A : -inner, apR ? h - A : inner);
      if (!apR) { push(h - E - G / 2, dip); push(h - E); push(h); }
    }
    // dedupe (a lane cut can coincide with a span end on a narrow road) and keep the stops ordered
    const out = [];
    for (const s of arr) if (!out.length || s.l > out[out.length - 1].l + 1e-4) out.push(s);
    return out;
  }
  /**
   * The race kerb apron on one side of the row pair: stripes at the module phase, each on its own quad,
   * two facets rising APRON_KNEE_H over the first APRON_KNEE metres and APRON_H at the block.
   */
  const RA = {}, RB = {};
  const hiC = new THREE.Color(), fnA = new THREE.Vector3(), fnB = new THREE.Vector3();
  /**
   * The race kerb on one side of the row pair, one continuous striped profile (round 3, item 4): the convex apron
   * slope, the riser and the kerb top, every stripe on its own sub row quads in the module's phase, each facet
   * with its true normal (the riser tilts toward the road, so the sun lights the riser that faces it and shades the
   * other), the top's road edge a painted highlight strip (style lock: every convex edge carries a lighter strip).
   */
  function emitApron(tb, a, b, sa, sb, side, i) {
    const asphaltTex = TEX.asphalt;   // painted concrete: the flatter set on both pavings, so the stripes stay pure
    const K = ROAD.KERB_W;
    for (const seg of stripeSegments(sa, sb, side)) {
      if (seg.s1 - seg.s0 < 0.01) continue;
      lerpRow(a, b, (seg.s0 - sa) / ds, RA); lerpRow(a, b, (seg.s1 - sa) / ds, RB);
      Spline.normalOf(RA, nA2); Spline.normalOf(RB, nB2);
      const ha = RA.width / 2, hb = RB.width / 2;
      const Wa = apronWidth(RA.width), Wb = apronWidth(RB.width);
      const base = seg.red ? C.kerbRed : C.kerbWhite;
      const col = tone(base, (seg.s0 + seg.s1) / 2, side * ha, 0);
      hiC.copy(col).multiplyScalar(seg.red ? 1.10 : 1.03);
      // facets as fractions of the apron width (the slope stops, the riser foot, the riser head), then metres beyond
      // the road edge for the top (edge highlight, top)
      const run = Wa - ROAD.RISER_W, P = ROAD.APRON_SLOPE;
      const facets = [];
      for (let k = 1; k < P.length; k++) facets.push([P[k - 1][0] * run, P[k][0] * run, SURF.apron, ROAD.APRON_ROUGH, col]);
      facets.push([run, Wa - ROAD.RISER_IN, SURF.kerb, ROAD.APRON_ROUGH, col]);                     // the riser
      facets.push([Wa - ROAD.RISER_IN, Wa + ROAD.KERB_EDGE, SURF.kerb, 0.45, hiC]);                 // the painted edge of the top
      facets.push([Wa + ROAD.KERB_EDGE, Wa + K, SURF.kerb, 0.45, col]);                             // the top
      for (const [d0, d1, kind, rough, colour] of facets) {
        // the same facet on row b, scaled to its apron width so the profile stays continuous when the width changes
        const e0 = d0 * Wb / Wa, e1 = d1 * Wb / Wa;
        const la0 = side * (ha - Wa + d0), la1 = side * (ha - Wa + d1), lb0 = side * (hb - Wb + e0), lb1 = side * (hb - Wb + e1);
        const ya0 = yAt(RA, la0) + apronRise(d0, Wa), ya1 = yAt(RA, la1) + apronRise(d1, Wa);
        const yb0 = yAt(RB, lb0) + apronRise(e0, Wb), yb1 = yAt(RB, lb1) + apronRise(e1, Wb);
        // facet normal: up tilted toward the road by the facet's slope (rise dy over run dl outward)
        const dl = Math.max(1e-4, d1 - d0), dy = ya1 - ya0;
        fnA.set(-RA.nx * side * dy, dl, -RA.nz * side * dy).normalize();
        fnB.set(-RB.nx * side * dy, dl, -RB.nz * side * dy).normalize();
        emit(tb, RA, RB, seg.s0, seg.s1, la0, la1, lb0, lb1, ya0, ya1, yb0, yb1, fnA, fnB, colour, kind, asphaltTex, rough);
      }
    }
  }
  const nA2 = new THREE.Vector3(), nB2 = new THREE.Vector3();
  const RC = {}, RD = {}, nC2 = new THREE.Vector3(), nD2 = new THREE.Vector3();
  /** A flat rectangle [s0, s1] x [l0, l1] on the road surface, dy up, clipped to the row pair [sa, sb]. */
  function emitRect(tb, a, b, sa, sb, s0, s1, l0, l1, dy, colour, surf, tex, rough) {
    const c0 = Math.max(sa, s0), c1 = Math.min(sb, s1);
    if (c1 - c0 < 0.01) return;
    lerpRow(a, b, (c0 - sa) / ds, RC); lerpRow(a, b, (c1 - sa) / ds, RD);
    Spline.normalOf(RC, nC2); Spline.normalOf(RD, nD2);
    emit(tb, RC, RD, c0, c1, l0, l1, l0, l1, yAt(RC, l0) + dy, yAt(RC, l1) + dy, yAt(RD, l0) + dy, yAt(RD, l1) + dy, nC2, nD2, colour, surf, tex, rough);
  }
  /**
   * Deterministic repair patches: [{ s0, s1, l0, l1, colour }]. Asphalt patches on the cobble streets (the asphalt
   * texture over the cobbles), and on the asphalt sections (round 3, item 4) a fresh darker or a faded lighter
   * rectangle of the same asphalt, so the straights carry things a driver reads; they lie over the lane paint, which
   * is one more way the paint breaks.
   */
  const patches = [];
  for (let slot = 0; slot * ROAD.PATCH_PITCH < L; slot++) {
    const base = slot * ROAD.PATCH_PITCH;
    const r1 = hash2(slot * 3.1, 7.7), r2 = hash2(slot * 5.3, 1.9), r3 = hash2(slot * 2.7, 4.4), r4 = hash2(slot * 9.1, 6.2);
    if (r1 > ROAD.PATCH_CHANCE) continue;
    const s0 = base + r2 * (ROAD.PATCH_PITCH - 6), len = 2.4 + r3 * 3.2;
    const q = spline.atDistance(s0 + len / 2, {});
    if (sills.some((ss) => Math.abs(s0 + len / 2 - ss) < ROAD.SILL_LEN / 2 + len)) continue;
    if (Math.abs(s0 + len / 2 - startS) < 12) continue;   // never under the start band or the grid slots
    const onAsphalt = q.surface === 'asphalt';
    const hIn = q.width / 2 - (onAsphalt ? apronWidth(q.width) : ROAD.EDGE_LINE_TOWN + ROAD.GUTTER_W) - 0.3;
    const w = 1.2 + r1 * 1.6;
    const lc = -hIn + w / 2 + r4 * (2 * hIn - w);
    const colour = onAsphalt ? (hash2(slot * 1.7, 2.3) < 0.5 ? C.patchDark : C.patchLight) : C.patch;
    patches.push({ s0, s1: s0 + len, l0: lc - w / 2, l1: lc + w / 2, colour, hIn });
  }
  /**
   * Drain covers (round 3, item 4): a DRAIN_SIZE square of metal dark with a stone shade rim, every DRAIN_PITCH metres
   * with a jitter, on both sides, just inside the apron or the edge paint (in town: inside the gutter, on the flat
   * cobbles), never at the start band, the sills or the pads: [{ s0, s1, side }].
   */
  const drains = [];
  for (let slot = 0; slot * ROAD.DRAIN_PITCH < L; slot++) {
    for (const side of [-1, 1]) {
      const j = hash2(slot * 4.3 + side, 3.9);
      const s0 = slot * ROAD.DRAIN_PITCH + (side < 0 ? 0 : ROAD.DRAIN_PITCH / 2) + (j - 0.5) * 3;
      const sc = s0 + ROAD.DRAIN_SIZE / 2;
      if (Math.abs(sc - startS) < 14) continue;
      if (sills.some((ss) => Math.abs(sc - ss) < ROAD.SILL_LEN / 2 + 2)) continue;
      const q = spline.atDistance(sc, {});
      if (PAD_DEFS.some((p) => dhypot(q.x - p.x, q.z - p.z) < 6)) continue;
      drains.push({ s0, s1: s0 + ROAD.DRAIN_SIZE, side });
    }
  }

  const nA = new THREE.Vector3(), nB = new THREE.Vector3(), sideN = new THREE.Vector3();

  for (let i = 0; i < N; i++) {
    const a = rows[i], b = rows[(i + 1) % N];
    const sa = a.s, sb = a.s + ds;              // sb continues past the lap end so u never jumps back
    const sMid = sa + ds / 2;
    const tb = tileFor((a.x + b.x) / 2, (a.z + b.z) / 2);
    Spline.normalOf(a, nA); Spline.normalOf(b, nB);
    const ha = a.width / 2, hb = b.width / 2;

    // ---- road surface: strips fixed by fraction so the paint (and in town the gutter) get their own quads
    const asphalt = a.surface === 'asphalt';
    const SA = stops(ha, a.width, asphalt, apronL[i], apronR[i]), SB = stops(hb, b.width, asphalt, apronL[i], apronR[i]);
    // ---- the race kerb apron, striped, on the sides that carry kerb_module stations
    if (apronL[i]) emitApron(tb, a, b, sa, sb, -1, i);
    if (apronR[i]) emitApron(tb, a, b, sa, sb, 1, i);
    for (let k = 0; k < SA.length - 1; k++) {
      const lm = (SA[k].l + SA[k + 1].l) / 2;
      const base = roadColourAt(i, sMid, lm, so);
      const col = tone(base, sMid, lm);
      emit(tb, a, b, sa, sb, SA[k].l, SA[k + 1].l, SB[k].l, SB[k + 1].l,
        yAt(a, SA[k].l) + SA[k].dy, yAt(a, SA[k + 1].l) + SA[k + 1].dy, yAt(b, SB[k].l) + SB[k].dy, yAt(b, SB[k + 1].l) + SB[k + 1].dy,
        nA, nB, col, so.v, so.tex, so.rough);
    }
    const inSill = sills.some((ss) => Math.abs(sMid - ss) < ROAD.SILL_LEN / 2);

    // ---- repair patches (own layer 5 mm up, the asphalt texture): asphalt on the cobble streets, fresh or faded
    // asphalt on the asphalt sections
    if (!inSill) {
      for (const p of patches) {
        if (sb <= p.s0 || sa >= p.s1) continue;
        const l0 = clamp(p.l0, -p.hIn, p.hIn), l1 = clamp(p.l1, -p.hIn, p.hIn);
        if (l1 - l0 < 0.4) continue;
        const col = tone(p.colour, sMid, l0 + 0.3);
        emitRect(tb, a, b, sa, sb, p.s0, p.s1, l0, l1, 0.005, col, SURF.patch, TEX.asphalt, ROAD.PATCH_ROUGH);
      }
      // ---- drain covers (rim 8.5 mm up, cover 9.5 mm up, over every other layer)
      for (const d of drains) {
        if (sb <= d.s0 || sa >= d.s1) continue;
        const ap = d.side < 0 ? apronL[i] : apronR[i];
        const inset = ap ? apronWidth(a.width) : (asphalt ? ROAD.EDGE_LINE : ROAD.EDGE_LINE_TOWN + ROAD.GUTTER_W);
        const lc = d.side * (ha - inset - 0.15 - ROAD.DRAIN_SIZE / 2), hw = ROAD.DRAIN_SIZE / 2;
        emitRect(tb, a, b, sa, sb, d.s0 - 0.05, d.s1 + 0.05, lc - hw - 0.05, lc + hw + 0.05, 0.0085, tone(C.drainRim, sMid, lc), SURF.patch, TEX.asphalt, 0.75);
        emitRect(tb, a, b, sa, sb, d.s0, d.s1, lc - hw, lc + hw, 0.0095, tone(C.drain, sMid, lc), SURF.patch, TEX.asphalt, ROAD.DRAIN_ROUGH);
      }
    }

    // ---- the racing line: a polished lighter band (own layer 4 mm up), soft edged in three strips.
    // The polish wanders 0.85 to 1.0 along s so the band is worn, not painted.
    if (!inSill) {
      const ra = rline[i], rb = rline[(i + 1) % N];
      const W = ROAD.LINE_W / 2, S = ROAD.LINE_SOFT;
      const wear = 0.85 + 0.15 * noise2(sMid, 11, 7);
      const bands = [[-W, -W + S, 0.5], [-W + S, W - S, 1.0], [W - S, W, 0.5]];
      for (const [o0, o1, k] of bands) {
        const base = roadColourAt(i, sMid, ra + (o0 + o1) / 2, so);
        if (so.v === SURF.paint || so.v === SURF.gutter || so.edge) continue;
        const col = tone(base, sMid, ra + o0, -ROAD.LINE_LIGHT * k * wear);
        const rough = ROAD.ROUGH + (ROAD.LINE_ROUGH - ROAD.ROUGH) * k * wear;
        stripFlat(tb, a, b, sa, sb, ra + o0, ra + o1, rb + o0, rb + o1, 0.004, nA, nB, col, SURF.line, so.tex, rough);
      }

      // ---- tyre marks on the line (own layer 7 mm up): faint on the straights, dark into and through
      // corners, the darkness breathing along s (2.5 m noise) so they read as laid rubber, not two rails.
      // Rubber lies over the lane paint (a mark crossing a dash darkens it); it stays off the edge and the gutter.
      const breathe = 0.7 + 0.6 * noise2(sMid, 7, 2.5);
      const inten = (ROAD.TYRE_STRAIGHT + (ROAD.TYRE_DARKEN - ROAD.TYRE_STRAIGHT) * Math.max(corner[i], ahead[i])) * breathe;
      for (const off of [-ROAD.TYRE_TRACK / 2, ROAD.TYRE_TRACK / 2]) {
        const base = roadColourAt(i, sMid, ra + off, so);
        if (so.edge) continue;
        const col = tone(base, sMid, ra + off, inten);
        stripFlat(tb, a, b, sa, sb, ra + off - ROAD.TYRE_W / 2, ra + off + ROAD.TYRE_W / 2, rb + off - ROAD.TYRE_W / 2, rb + off + ROAD.TYRE_W / 2,
          0.007, nA, nB, col, SURF.tyre, so.tex, ROAD.TYRE_ROUGH);
      }
      // ---- the pack's rubber in the outer lanes (own layer 6.5 mm up, round 2 fix item 6): eight karts do not all
      // run the line, so each outer lane centre (a third of the width out) carries a fainter pair with its own
      // breathing, which is what the near ground band left and right of the player sees on a straight
      for (const lane of [-1, 1]) {
        const brOut = 0.7 + 0.6 * noise2(sMid, 13 + lane * 5, 2.5);
        const intenOut = inten / breathe * brOut * ROAD.OUTER_TYRE;
        const hIn = Math.min(a.width, b.width) / 2 - edgeInset(i, lane) - ROAD.TYRE_TRACK / 2 - ROAD.TYRE_W / 2 - 0.05;
        const lc = lane * Math.min(a.width / 3, hIn);
        for (const off of [-ROAD.TYRE_TRACK / 2, ROAD.TYRE_TRACK / 2]) {
          const base = roadColourAt(i, sMid, lc + off, so);
          if (so.edge) continue;
          const col = tone(base, sMid, lc + off, intenOut);
          stripFlat(tb, a, b, sa, sb, lc + off - ROAD.TYRE_W / 2, lc + off + ROAD.TYRE_W / 2, lc + off - ROAD.TYRE_W / 2, lc + off + ROAD.TYRE_W / 2,
            0.0065, nA, nB, col, SURF.tyre, so.tex, ROAD.TYRE_ROUGH);
        }
      }

      // ---- corner skids (own layer 6 mm up): two more marks that wander off the line by up to
      // SKID_WANDER, fade in and out over 4 to 10 m, and only exist where the road bends
      const cornerK = Math.max(corner[i], ahead[i]);
      if (cornerK > 0.15) {
        for (let k = 0; k < 2; k++) {
          const gate = smoothstep(0.5, 0.8, noise2(sMid, 300 + k * 40, 6)) * cornerK;
          if (gate < 0.05) continue;
          const wa = (noise2(sa, 100 + k * 50, 9) - 0.5) * 2 * ROAD.SKID_WANDER;
          const wb = (noise2(sb, 100 + k * 50, 9) - 0.5) * 2 * ROAD.SKID_WANDER;
          const off = (k === 0 ? -1 : 1) * ROAD.TYRE_TRACK / 2;
          const base = roadColourAt(i, sMid, ra + off + wa, so);
          if (so.edge) continue;
          const col = tone(base, sMid, ra + off + wa, ROAD.SKID_DARKEN * gate);
          const hw = ROAD.TYRE_W * 0.45;
          stripFlat(tb, a, b, sa, sb, ra + off + wa - hw, ra + off + wa + hw, rb + off + wb - hw, rb + off + wb + hw,
            0.006, nA, nB, col, SURF.tyre, so.tex, ROAD.TYRE_ROUGH);
        }
      }
    }

    // ---- the old town drain channel (own layer 9 mm up): a darker stone strip down the centre of the
    // lower street and the piazza exit street (waypoints 11 to 20 and 27 to 32), the line a driver
    // reads converging ahead on the cobbles
    if (!asphalt && !inSill && (spline.inWaypointRange(sMid, 11, 20) || spline.inWaypointRange(sMid, 27, 32))) {
      const hw = ROAD.CHANNEL_W / 2;
      const col = tone(C.channel, sMid, 0);
      stripFlat(tb, a, b, sa, sb, -hw, hw, -hw, hw, 0.009, nA, nB, col, SURF.gutter, TEX.cobble, ROAD.CHANNEL_ROUGH);
    }

    // ---- each side: kerb substrate, pavement or shoulder, apron
    for (const side of [-1, 1]) {
      const prof = sideProfile(spline, sMid, side);
      const ea = side * ha, eb = side * hb;   // edge lateral
      const yea = yAt(a, ea), yeb = yAt(b, eb);
      sideN.set(a.nx * -side, 0, a.nz * -side);  // faces the road
      const K = ROAD.KERB_W, KH = ROAD.KERB_H;
      const o = (l) => side * l;               // outward lateral helper (positive metres beyond the edge)
      if (prof.white) {
        // the race kerb: apron, riser and striped top were emitted by emitApron (top at RACE_KERB_H over ea..ea + K);
        // here only what lies beyond the block: the outer face down to the pavement, shoulder or quay deck, and that strip
        const RH = ROAD.RACE_KERB_H;
        const outN = tmpN.set(a.nx * side, 0, a.nz * side);   // faces away from the road
        const outer = (yTop, yFoot) => emit(tb, a, b, sa, sb, ea + o(K), ea + o(K), eb + o(K), eb + o(K), yea + yTop, yea + yFoot, yeb + yTop, yeb + yFoot, outN, outN, tone(C.stoneShade, sMid, ea + o(K)), SURF.kerb, TEX.cobble, 0.84);
        if (prof.kind === 'pavement') {
          const PH = ROAD.PAVE_H, PW = ROAD.PAVE_W;
          outer(RH, PH);
          for (let k = 0; k < 2; k++) {
            const l0 = K + PW * k / 2, l1 = K + PW * (k + 1) / 2;
            emit(tb, a, b, sa, sb, ea + o(l0), ea + o(l1), eb + o(l0), eb + o(l1), yea + PH, yea + PH, yeb + PH, yeb + PH, UP, UP, tone(C.pavement, sMid, ea + o((l0 + l1) / 2)), SURF.pavement, TEX.cobble, ROAD.ROUGH);
          }
          emit(tb, a, b, sa, sb, ea + o(K + PW), ea + o(K + PW + 0.5), eb + o(K + PW), eb + o(K + PW + 0.5), yea + PH, yea + PH - 0.10, yeb + PH, yeb + PH - 0.10, UP, UP, tone(C.pavement, sMid, ea + o(K + PW)), SURF.pavement, TEX.cobble, ROAD.ROUGH);
        } else if (prof.kind === 'quay') {
          // the quay side of the harbour straight: the kerb block stands on the quay deck, the deck strip runs on at road level
          const QW = ROAD.QUAY_W;
          outer(RH, 0);
          emit(tb, a, b, sa, sb, ea + o(K), ea + o(QW), eb + o(K), eb + o(QW), yea, yea, yeb, yeb, UP, UP, tone(C.warmStone, sMid, ea + o((K + QW) / 2)), SURF.quay, TEX.cobble, 0.84);
        } else {
          const SW = ROAD.SHOULDER_W;
          outer(RH, RH - 0.02);
          emit(tb, a, b, sa, sb, ea + o(K), ea + o(K + SW), eb + o(K), eb + o(K + SW), yea + RH - 0.02, yea + RH - 0.04, yeb + RH - 0.02, yeb + RH - 0.04, UP, UP, tone(C.shoulder, sMid, ea + o(K + SW / 2)), SURF.shoulder, TEX.asphalt, ROAD.ROUGH);
          emit(tb, a, b, sa, sb, ea + o(K + SW), ea + o(K + SW + 0.5), eb + o(K + SW), eb + o(K + SW + 0.5), yea + RH - 0.04, yea - 0.06, yeb + RH - 0.04, yeb - 0.06, UP, UP, tone(C.shoulder, sMid, ea + o(K + SW)), SURF.shoulder, TEX.asphalt, ROAD.ROUGH);
        }
      } else if (prof.kind === 'pavement' || prof.kind === 'kerb') {
        // kerb inner face (vertical)
        emit(tb, a, b, sa, sb, ea, ea, eb, eb, yea, yea + KH, yeb, yeb + KH, sideN, sideN, tone(C.warmStone, sMid, ea), SURF.kerb, a.surface === 'asphalt' ? TEX.asphalt : TEX.cobble, 0.84);
        // kerb top
        const top = prof.white ? C.kerbWhite : C.warmStone;
        emit(tb, a, b, sa, sb, ea, ea + o(K), eb, eb + o(K), yea + KH, yea + KH, yeb + KH, yeb + KH, UP, UP, tone(top, sMid, ea + o(K / 2)), SURF.kerb, a.surface === 'asphalt' ? TEX.asphalt : TEX.cobble, prof.white ? 0.55 : 0.80);
        if (prof.kind === 'pavement') {
          const PH = ROAD.PAVE_H, PW = ROAD.PAVE_W;
          // riser from kerb top to pavement
          emit(tb, a, b, sa, sb, ea + o(K), ea + o(K), eb + o(K), eb + o(K), yea + KH, yea + PH, yeb + KH, yeb + PH, sideN, sideN, tone(C.stoneShade, sMid, ea), SURF.kerb, TEX.cobble, 0.84);
          // pavement in two strips so the noise reads
          for (let k = 0; k < 2; k++) {
            const l0 = K + PW * k / 2, l1 = K + PW * (k + 1) / 2;
            emit(tb, a, b, sa, sb, ea + o(l0), ea + o(l1), eb + o(l0), eb + o(l1), yea + PH, yea + PH, yeb + PH, yeb + PH, UP, UP, tone(C.pavement, sMid, ea + o((l0 + l1) / 2)), SURF.pavement, TEX.cobble, ROAD.ROUGH);
          }
          // apron dropping under the terrain
          emit(tb, a, b, sa, sb, ea + o(K + PW), ea + o(K + PW + 0.5), eb + o(K + PW), eb + o(K + PW + 0.5), yea + PH, yea + PH - 0.10, yeb + PH, yeb + PH - 0.10, UP, UP, tone(C.pavement, sMid, ea + o(K + PW)), SURF.pavement, TEX.cobble, ROAD.ROUGH);
        } else {
          const SW = ROAD.SHOULDER_W;
          emit(tb, a, b, sa, sb, ea + o(K), ea + o(K + SW), eb + o(K), eb + o(K + SW), yea + KH, yea + KH - 0.02, yeb + KH, yeb + KH - 0.02, UP, UP, tone(C.shoulder, sMid, ea + o(K + SW / 2)), SURF.shoulder, TEX.asphalt, ROAD.ROUGH);
          emit(tb, a, b, sa, sb, ea + o(K + SW), ea + o(K + SW + 0.5), eb + o(K + SW), eb + o(K + SW + 0.5), yea + KH - 0.02, yea - 0.06, yeb + KH - 0.02, yeb - 0.06, UP, UP, tone(C.shoulder, sMid, ea + o(K + SW)), SURF.shoulder, TEX.asphalt, ROAD.ROUGH);
        }
      } else if (prof.kind === 'shoulder') {
        const SW = ROAD.SHOULDER_W;
        emit(tb, a, b, sa, sb, ea, ea + o(SW), eb, eb + o(SW), yea, yea - 0.01, yeb, yeb - 0.01, UP, UP, tone(C.shoulder, sMid, ea + o(SW / 2)), SURF.shoulder, TEX.asphalt, ROAD.ROUGH);
        emit(tb, a, b, sa, sb, ea + o(SW), ea + o(SW + 0.5), eb + o(SW), eb + o(SW + 0.5), yea - 0.01, yea - 0.12, yeb - 0.01, yeb - 0.12, UP, UP, tone(C.shoulder, sMid, ea + o(SW)), SURF.shoulder, TEX.asphalt, ROAD.ROUGH);
      } else if (prof.kind === 'quay') {
        const QW = ROAD.QUAY_W;
        emit(tb, a, b, sa, sb, ea, ea + o(QW), eb, eb + o(QW), yea, yea, yeb, yeb, UP, UP, tone(C.warmStone, sMid, ea + o(QW / 2)), SURF.quay, TEX.cobble, 0.84);
      }
    }
  }

  // ---- chequered start band: 2 rows of 0.5 m squares across the width at progress 0.037
  {
    const q0 = spline.atDistance(startS - 0.5, {}), q1 = spline.atDistance(startS, {}), q2 = spline.atDistance(startS + 0.5, {});
    const rowsQ = [q0, q1, q2];
    const h = q1.width / 2 - apronWidth(q1.width);   // between the two race kerb aprons
    const n = Math.round(h * 2 / 0.5);
    const tb = tileFor(q1.x, q1.z);
    for (let j = 0; j < 2; j++) {
      const a = rowsQ[j], b = rowsQ[j + 1];
      Spline.normalOf(a, nA); Spline.normalOf(b, nB);
      const sq = 2 * h / n;
      for (let k = 0; k < n; k++) {
        const l0 = -h + k * sq, l1 = l0 + sq;
        const white = (j + k) % 2 === 0;
        const col = tone(white ? C.whitewash : C.asphalt, a.s, l0);
        emit(tb, a, b, a.s, b.s, l0, l1, l0, l1, yAt(a, l0) + 0.008, yAt(a, l1) + 0.008, yAt(b, l0) + 0.008, yAt(b, l1) + 0.008, nA, nB, col, SURF.chequer, TEX.asphalt, 0.70);
      }
    }
  }

  // ---- painted grid slots (TRACK-PLAN 7.1): an open whitewash box per slot on the quay road, heading north
  {
    const yOf = (x, z) => { const y = spline.roadY(x, z); return (Number.isNaN(y) ? 0.2 : y) + 0.008; };
    // axis aligned rectangle on the road, corners in world xz
    const rect = (x0, x1, z0, z1, colour) => {
      const tb = tileFor((x0 + x1) / 2, (z0 + z1) / 2);
      const v = (x, z) => tb.vertex(x, yOf(x, z), z, UP, x / 4, z / 4, colour, SURF.paint, 0.5, TEX.asphalt, 0.70);
      const a0 = v(x0, z0), a1 = v(x1, z0), b0 = v(x0, z1), b1 = v(x1, z1);
      tb.quad(a0, a1, b0, b1, UP);
      tb.surfaces.add(SURF.paint);
    };
    const W = ROAD.GRID_W / 2, Lg = ROAD.GRID_L / 2, T = ROAD.GRID_LINE;
    for (const g of GRID_SLOTS) {
      const col = tone(C.whitewash, g.x * 3.7, g.z * 1.3);
      rect(g.x - W, g.x + W, g.z - Lg, g.z - Lg + T, col);            // front bar (north end, the direction of travel)
      rect(g.x - W, g.x - W + T, g.z - Lg, g.z + Lg, col);            // left side
      rect(g.x + W - T, g.x + W, g.z - Lg, g.z + Lg, col);            // right side
    }
  }

  // ---- meshes
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0.0, name: 'road' });
  material.userData.surface = 'ground';
  const meshes = [];
  for (const [key, tb] of tiles) {
    const g = tb.build();
    const m = new THREE.Mesh(g, material);
    m.receiveShadow = true; m.castShadow = false;
    m.name = 'road_' + key;
    m.userData = { kind: 'road', block: key, sMin: tb.sMin, sMax: tb.sMax, surfaces: Array.from(tb.surfaces) };
    meshes.push(m);
  }
  // The race kerb stands 0.34 m proud of the road and must throw its shadow onto it (round 3, item 4: "a shaded
  // outer face that casts a shadow onto the road"; the level's kerb_module sits in the coarse bake group, which never
  // casts). main.js adds the tiles with castShadow false and toggles the terrain tiles by distance; the ribbon does
  // the same for itself here: the first tile rendered each frame sets castShadow on every tile within castDist of
  // the camera (the shadow pass of the NEXT frame picks it up; onBeforeRender does not run in the shadow pass). A
  // tile behind the camera and out of range stays off. `tier.castDist` is render/quality.js's number (40 high, 30
  // phone); `road.setCastDist(m)` overrides it.
  const tier = opts.tier || {};
  let castDist = tier.castDist || (tier.name === 'phone' ? 30 : 40);
  const centres = meshes.map((m) => { const bs = m.geometry.boundingSphere; return { m, c: bs.center.clone(), r: bs.radius }; });
  let lastFrame = -1;
  const camPos = new THREE.Vector3();
  const updateCasters = (renderer, camera) => {
    const f = renderer.info.render.frame;
    if (f === lastFrame) return;
    lastFrame = f;
    camPos.setFromMatrixPosition(camera.matrixWorld);
    for (const t of centres) {
      const on = camPos.distanceTo(t.c) - t.r < castDist;
      if (on !== t.m.castShadow) t.m.castShadow = on;
    }
  };
  for (const m of meshes) m.onBeforeRender = (renderer, scene, camera) => updateCasters(renderer, camera);

  // ---- stations for the level builder: one per module inside each run (the same runs the apron stripes follow)
  const kerbs = [];
  for (const side of [-1, 1]) for (const r of runs[side]) for (let k = 0; k < r.count; k++) kerbs.push(kerbStation(mod(r.start + r.pitch * (k + 0.5), L), side));
  function kerbStation(s, side) {
    const q = spline.atDistance(s, {});
    const h = q.width / 2;
    const lat = side * (h + ROAD.KERB_W / 2);
    const ox = q.nx * side, oz = q.nz * side;          // outward (the module's +Z; its road side is -Z)
    const rot = mod(datan2(ox, oz) / DEG, 360);
    return { x: q.x + q.nx * lat, z: q.z + q.nz * lat, y: yAt(q, side * h), rot, side: side < 0 ? 'L' : 'R', progress: s / L, s, section: q.section };
  }

  // guard wall on the sea (left) side from wp 41 to wp 53, gaps 12 m at x -12 (43..44), x -94 (48..49), wp 52
  const gapS = [];
  const findX = (xTarget, wpA, wpB) => {
    let best = null, bd = Infinity;
    for (const r of rows) if (r.s >= spline.waypointS[wpA] && r.s < spline.waypointS[wpB] && Math.abs(r.x - xTarget) < bd) { bd = Math.abs(r.x - xTarget); best = r; }
    return best ? best.s : (spline.waypointS[wpA] + spline.waypointS[wpB]) / 2;
  };
  gapS.push(findX(-12, 43, 44), findX(-94, 48, 49), spline.waypointS[52]);
  const wallStations = [];
  {
    const s0 = spline.waypointS[41], s1 = spline.waypointS[53];
    const count = Math.round((s1 - s0) / 4), pitch = (s1 - s0) / count;
    for (let k = 0; k < count; k++) {
      const s = s0 + pitch * (k + 0.5);
      const q = spline.atDistance(s, {});
      const h = q.width / 2;
      const lat = -(h + ROAD.WALL_OFFSET);
      const ox = -q.nx, oz = -q.nz;
      const gap = gapS.some((g) => Math.abs(s - g) < ROAD.GAP_HALF);
      wallStations.push({ x: q.x + q.nx * lat, z: q.z + q.nz * lat, y: yAt(q, -h), rot: mod(datan2(ox, oz) / DEG, 360), progress: s / L, s, gap, side: 'L' });
    }
  }

  // boost pads
  const pads = PAD_DEFS.map((p) => {
    const y = spline.roadY(p.x, p.z);
    const rad = p.rot * DEG;
    return { ...p, y: Number.isNaN(y) ? 0 : y, cos: dcos(rad), sin: dsin(rad) };
  });
  const padStations = pads.map((p) => ({ id: p.id, x: p.x, z: p.z, y: p.y, rot: p.rot }));
  function padAt(x, z) {
    for (const p of pads) {
      const dx = x - p.x, dz = z - p.z;
      // world -> local: inverse of rotation.y = rot ( local +Z -> (sin, cos) )
      const lx = dx * p.cos - dz * p.sin;
      const lz = dx * p.sin + dz * p.cos;
      if (Math.abs(lx) <= PAD_HALF.x && Math.abs(lz) <= PAD_HALF.z) return p;
    }
    return null;
  }

  // ---- queries
  const qTmp = {};
  /**
   * Cross section probe under (x, z): { y, surface, zone, lateral, q } or null when the ribbon is
   * absent there (the terrain takes over). zone: road | kerb | pavement | shoulder | apron | quay.
   */
  function probe(x, z, hint = -1) {
    const n = spline.nearest(x, z, hint);
    const q = spline.atDistance(n.s, qTmp);
    const h = q.width / 2, l = n.lateral, al = Math.abs(l), side = l < 0 ? -1 : 1;
    const yEdge = yAt(q, side * h);
    const prof = sideProfile(spline, n.s, side);
    const AW = apronWidth(q.width);
    if (al <= h) {
      const pad = padAt(x, z);
      let dip = 0;
      if (prof.white && al > h - AW) {
        // the race kerb apron: the convex rumble up to the riser foot, then the riser to the top; the kart rides the
        // same profile the ribbon draws
        dip = apronRise(al - (h - AW), AW);
      } else if (q.surface === 'cobble') {
        // the town gutter is dipped 3 cm in the mesh (a V, 0.5 m wide, inside the edge paint); the probe follows it
        const gc = h - ROAD.EDGE_LINE_TOWN - ROAD.GUTTER_W / 2;
        dip = -ROAD.GUTTER_DIP * clamp(1 - Math.abs(al - gc) / (ROAD.GUTTER_W / 2), 0, 1);
      }
      return { y: yAt(q, l) + dip, surface: pad ? 'pad' : q.surface, zone: 'road', lateral: l, q, index: n.index, progress: n.progress };
    }
    const K = ROAD.KERB_W;
    if (prof.white && al <= h + K) return { y: yEdge + ROAD.RACE_KERB_H, surface: q.surface, zone: 'kerb', lateral: l, q, index: n.index, progress: n.progress };
    if (prof.kind === 'pavement' || prof.kind === 'kerb') {
      if (al <= h + K) return { y: yEdge + ROAD.KERB_H, surface: q.surface, zone: 'kerb', lateral: l, q, index: n.index, progress: n.progress };
      if (prof.kind === 'pavement') {
        if (al <= h + K + ROAD.PAVE_W) return { y: yEdge + ROAD.PAVE_H, surface: 'cobble', zone: 'pavement', lateral: l, q, index: n.index, progress: n.progress };
        if (al <= h + K + ROAD.PAVE_W + 0.5) { const t = (al - (h + K + ROAD.PAVE_W)) / 0.5; return { y: yEdge + ROAD.PAVE_H - 0.10 * t, surface: 'cobble', zone: 'apron', lateral: l, q, index: n.index, progress: n.progress }; }
        return null;
      }
      const SW = ROAD.SHOULDER_W, KH = prof.white ? ROAD.RACE_KERB_H - 0.02 : ROAD.KERB_H;
      if (al <= h + K + SW) return { y: yEdge + KH - 0.02, surface: 'asphalt', zone: 'shoulder', lateral: l, q, index: n.index, progress: n.progress };
      if (al <= h + K + SW + 0.5) { const t = (al - (h + K + SW)) / 0.5; return { y: yEdge + KH - 0.02 - (KH + 0.04) * t, surface: 'asphalt', zone: 'apron', lateral: l, q, index: n.index, progress: n.progress }; }
      return null;
    }
    if (prof.kind === 'shoulder') {
      const SW = ROAD.SHOULDER_W;
      if (al <= h + SW) return { y: yEdge - 0.01, surface: 'asphalt', zone: 'shoulder', lateral: l, q, index: n.index, progress: n.progress };
      if (al <= h + SW + 0.5) { const t = (al - (h + SW)) / 0.5; return { y: yEdge - 0.01 - 0.11 * t, surface: 'asphalt', zone: 'apron', lateral: l, q, index: n.index, progress: n.progress }; }
      return null;
    }
    if (prof.kind === 'quay') {
      if (al <= h + ROAD.QUAY_W) return { y: yEdge, surface: 'asphalt', zone: 'quay', lateral: l, q, index: n.index, progress: n.progress };
      return null;
    }
    return null;
  }
  function surfaceAt(x, z) { const p = probe(x, z); return p ? p.surface : null; }
  function heightAt(x, z) { const p = probe(x, z); return p ? p.y : NaN; }

  return {
    tiles: meshes, kerbs, wallStations, padStations, pads, gapS,
    surfaceAt, heightAt, probe, padAt, material, sideProfile: (s, side) => sideProfile(spline, s, side),
    stripeAt, kerbRuns: runs, apronWidth, apronRise,
    kerbInRibbon: true,                       // the striped kerb (apron, riser, top) is ribbon geometry; kerb_module is redundant
    setCastDist: (d) => { castDist = d; },
    params: ROAD, SURF,
  };
}
