/**
 * track/spline.js - the Sorrel Cove centreline.
 *
 * A closed uniform Catmull-Rom spline (tension 0.5, the same evaluation as the lead's
 * work/lead/centreline.py) through the 59 waypoints of docs/TRACK-PLAN.md section 3, sampled
 * every 1.5 m into a table. Everything else in the game (road ribbon, terrain flatten, AI line,
 * progress, respawn, minimap) reads this table.
 *
 * Conventions (docs/TRACK-PLAN.md section 1):
 *   +X east, +Z south, +Y up. Racing direction is clockwise seen from above.
 *   `s` is the distance from waypoint 0 measured in the xz plane; progress = s / LAP_LENGTH.
 *   `lateral` is signed metres from the centreline, POSITIVE TO THE RIGHT of travel.
 *   right normal (nx, nz) = (-tz, tx): heading north (0, -1) puts the right at east (1, 0).
 *   `curvature` is signed 1/m, POSITIVE FOR A RIGHT HAND TURN (clockwise seen from above).
 *   `bank` is degrees; positive banks toward the inside of a right turn (right edge lower):
 *     y(lateral) = y - lateral * tan(bank).
 */
import * as THREE from 'three';
// Deterministic transcendentals, not the host's: Math.sin/cos/tan/atan2/pow/exp are not
// specified to the last bit by ECMAScript and Chrome and Node genuinely disagree, which over a
// 15 000 tick race is the difference between two cars. See src/token/detmath.js.
import { datan2, dhypot, dtan } from '../token/detmath.js?v=r6-20260906191941';

const SECTION_NAMES = {
  A: 'A harbour straight', B: 'B market corner', C: 'C lower street', D: 'D church hairpin',
  E: 'E piazza exit', F: 'F clock tower rise', G: 'G cliff entry', H: 'H cliff road', I: 'I lighthouse descent',
};

// x, z, y, width, bank, section (the 59 rows of TRACK-PLAN section 3, in order)
const RAW = [
  [-134, -6, 0.2, 14, 0, 'A'], [-134, -22, 0.2, 14, 0, 'A'], [-134, -39, 0.2, 14, 0, 'A'],
  [-134, -56, 0.2, 14, 0, 'A'], [-134, -73, 0.2, 14, 0, 'A'], [-134, -90, 0.2, 14, 0, 'A'],
  [-134, -106, 0.2, 14, 0, 'A'],
  [-132, -125, 0.5, 12, 3, 'B'], [-123, -141, 1.0, 12, 4, 'B'], [-108, -152, 1.5, 12, 4, 'B'],
  [-87, -157, 2.0, 12, 2, 'B'],
  [-67, -158, 2.7, 11, 0, 'C'], [-45, -160, 3.5, 11, 0, 'C'], [-22, -161, 4.3, 11, 0, 'C'],
  [0, -159, 5.1, 11, 0, 'C'], [22, -156, 6.0, 11, 0, 'C'], [45, -155, 6.7, 11, 0, 'C'],
  [67, -156, 7.4, 11, 0, 'C'], [90, -158, 8.0, 11, 0, 'C'], [112, -158, 8.3, 11, 0, 'C'],
  [132, -156, 8.6, 12, 4, 'D'], [148, -148, 9.0, 12, 6, 'D'], [157, -134, 9.5, 12, 7, 'D'],
  [159, -119, 9.9, 12, 7, 'D'], [153, -104, 10.3, 12, 6, 'D'], [141, -95, 10.7, 12, 4, 'D'],
  [125, -92, 11.0, 12, 2, 'D'],
  [108, -92, 11.3, 11, 0, 'E'], [92, -92, 11.6, 11, 0, 'E'], [78, -86, 12.0, 11, -3, 'E'],
  [69, -74, 12.4, 11, -4, 'E'], [65, -58, 13.1, 11, -2, 'E'],
  [67, -40, 13.9, 11, 0, 'F'], [74, -25, 14.9, 11, 0, 'F'], [72, -9, 15.9, 11, 0, 'F'],
  [63, 4, 16.9, 11, 0, 'F'], [60, 20, 17.9, 11, 0, 'F'], [65, 36, 18.9, 11, 0, 'F'],
  [67, 52, 19.6, 11, 0, 'F'], [65, 67, 20.1, 11, 0, 'F'],
  [60, 83, 20.6, 11, 3, 'G'], [49, 96, 21.1, 11, 4, 'G'], [34, 106, 21.5, 11, 4, 'G'],
  [13, 112, 21.9, 11, 2, 'G'],
  [-7, 114, 22.4, 11, 0, 'H'], [-27, 118, 23.1, 11, 0, 'H'], [-47, 119, 23.7, 11, 0, 'H'],
  [-67, 116, 24.1, 11, 0, 'H'], [-87, 114, 23.7, 11, 0, 'H'], [-108, 114, 23.1, 11, 0, 'H'],
  [-125, 112, 22.1, 11, 2, 'I'], [-141, 105, 19.9, 11, 4, 'I'], [-152, 94, 17.1, 11, 5, 'I'],
  [-159, 80, 13.8, 11, 5, 'I'], [-160, 63, 10.1, 11, 3, 'I'], [-157, 47, 6.5, 11, 0, 'I'],
  [-150, 32, 3.5, 12, 0, 'I'], [-142, 19, 1.3, 13, 0, 'I'], [-138, 7, 0.5, 14, 0, 'I'],
];

export const WAYPOINTS = RAW.map(([x, z, y, width, bank, section], i) => ({
  i, x, z, y, width, bank, section, sectionName: SECTION_NAMES[section],
}));

export const START_PROGRESS = 0.037;
export const CHECKPOINTS = [0.037, 0.33, 0.66];
export const SAMPLE_SPACING = 1.5;
export const COBBLE_SECTIONS = new Set(['B', 'C', 'D', 'E']);

const TWO_PI = Math.PI * 2;

/** Uniform Catmull-Rom, tension 0.5, on one scalar: p0..p3 control values, t in [0, 1]. */
function cr(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}
/** Derivative of the same segment with respect to t. */
function crd(p0, p1, p2, p3, t) {
  const t2 = t * t;
  return 0.5 * ((-p0 + p2) + 2 * (2 * p0 - 5 * p1 + 4 * p2 - p3) * t + 3 * (-p0 + 3 * p1 - 3 * p2 + p3) * t2);
}
function wrapAngle(a) { while (a > Math.PI) a -= TWO_PI; while (a < -Math.PI) a += TWO_PI; return a; }
function mod(a, n) { return ((a % n) + n) % n; }

const FINE = 64;   // sub steps per waypoint segment for the arc length integration

export class Spline {
  constructor(waypoints = WAYPOINTS) {
    this.waypoints = waypoints;
    const n = waypoints.length;
    const P = waypoints;
    const get = (k) => P[mod(k, n)];

    // ---- 1. fine arc length integration in xz, per segment (segment i runs from wp i to wp i+1)
    const segLen = new Float64Array(n);          // xz length of each segment
    const fineS = [];                            // per segment: cumulative xz length at each fine step (FINE+1 entries)
    let total = 0;
    for (let i = 0; i < n; i++) {
      const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
      const cum = new Float64Array(FINE + 1);
      let px = p1.x, pz = p1.z, acc = 0;
      for (let k = 1; k <= FINE; k++) {
        const t = k / FINE;
        const x = cr(p0.x, p1.x, p2.x, p3.x, t), z = cr(p0.z, p1.z, p2.z, p3.z, t);
        acc += dhypot(x - px, z - pz);
        cum[k] = acc; px = x; pz = z;
      }
      segLen[i] = acc; fineS.push(cum); total += acc;
    }
    this.length = total;
    // s at each waypoint (cumulative)
    this.waypointS = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) this.waypointS[i + 1] = this.waypointS[i] + segLen[i];

    // ---- 2. resample every ~1.5 m so the table closes exactly
    const N = Math.max(8, Math.round(total / SAMPLE_SPACING));
    const ds = total / N;
    this.ds = ds;
    this.count = N;
    const rows = new Array(N);
    let seg = 0, k = 0;   // walking cursor over the fine table
    for (let r = 0; r < N; r++) {
      const s = r * ds;
      // advance to the segment holding s
      while (seg < n - 1 && s >= this.waypointS[seg + 1]) { seg++; k = 0; }
      const local = s - this.waypointS[seg];
      const cum = fineS[seg];
      while (k < FINE - 1 && cum[k + 1] < local) k++;
      const a = cum[k], b = cum[k + 1];
      const f = b > a ? (local - a) / (b - a) : 0;
      const t = (k + f) / FINE;
      const p0 = get(seg - 1), p1 = get(seg), p2 = get(seg + 1), p3 = get(seg + 2);
      const x = cr(p0.x, p1.x, p2.x, p3.x, t);
      const z = cr(p0.z, p1.z, p2.z, p3.z, t);
      const y = cr(p0.y, p1.y, p2.y, p3.y, t);
      const width = cr(p0.width, p1.width, p2.width, p3.width, t);
      const bank = cr(p0.bank, p1.bank, p2.bank, p3.bank, t);
      let dx = crd(p0.x, p1.x, p2.x, p3.x, t), dz = crd(p0.z, p1.z, p2.z, p3.z, t);
      const dy = crd(p0.y, p1.y, p2.y, p3.y, t);
      const dl = dhypot(dx, dz) || 1;
      const tx = dx / dl, tz = dz / dl;
      const section = p1.section;
      rows[r] = {
        index: r, s, progress: s / total, x, y, z, tx, tz, nx: -tz, nz: tx,
        grade: dy / dl,                       // dy per metre of xz travel
        width, bank, curvature: 0, section, wp: seg,
        surface: COBBLE_SECTIONS.has(section) ? 'cobble' : 'asphalt',
      };
    }
    // signed curvature from the heading change over the neighbours, smoothed over 5 rows
    const raw = new Float64Array(N);
    for (let r = 0; r < N; r++) {
      const a = rows[mod(r - 1, N)], b = rows[mod(r + 1, N)];
      raw[r] = wrapAngle(datan2(b.tz, b.tx) - datan2(a.tz, a.tx)) / (2 * ds);
    }
    for (let r = 0; r < N; r++) {
      let acc = 0;
      for (let d = -2; d <= 2; d++) acc += raw[mod(r + d, N)];
      rows[r].curvature = acc / 5;
    }
    this.samples = rows;

    // ---- 3. spatial hash of the rows for nearest() without a hint
    this.cell = 8;
    this.hash = new Map();
    for (const row of rows) {
      const key = this._cellKey(row.x, row.z);
      let list = this.hash.get(key);
      if (!list) { list = []; this.hash.set(key, list); }
      list.push(row.index);
    }
  }

  _cellKey(x, z) { return (Math.floor(x / this.cell)) + ',' + (Math.floor(z / this.cell)); }

  /** s of waypoint i (0..59; 59 is the lap length). */
  sOf(wp) { return this.waypointS[mod(wp, this.waypoints.length + 1)]; }

  /** Interpolated sample at a distance s (metres, wrapped). */
  atDistance(s, out = {}) {
    const N = this.count, L = this.length;
    s = mod(s, L);
    const k = s / this.ds;
    const i0 = Math.floor(k) % N, i1 = (i0 + 1) % N;
    const f = k - Math.floor(k);
    const a = this.samples[i0], b = this.samples[i1];
    out.s = s; out.progress = s / L; out.index = f < 0.5 ? i0 : i1;
    out.x = a.x + (b.x - a.x) * f; out.y = a.y + (b.y - a.y) * f; out.z = a.z + (b.z - a.z) * f;
    let tx = a.tx + (b.tx - a.tx) * f, tz = a.tz + (b.tz - a.tz) * f;
    const tl = dhypot(tx, tz) || 1; tx /= tl; tz /= tl;
    out.tx = tx; out.tz = tz; out.nx = -tz; out.nz = tx;
    out.grade = a.grade + (b.grade - a.grade) * f;
    out.width = a.width + (b.width - a.width) * f;
    out.bank = a.bank + (b.bank - a.bank) * f;
    out.curvature = a.curvature + (b.curvature - a.curvature) * f;
    const near = f < 0.5 ? a : b;
    out.section = near.section; out.surface = near.surface; out.wp = near.wp;
    return out;
  }

  at(progress01, out = {}) { return this.atDistance(mod(progress01, 1) * this.length, out); }

  sectionAt(progress01) { return this.at(progress01, this._tmp || (this._tmp = {})).section; }

  /**
   * Closest point on the centreline to (x, z).
   * With a hint (the racer's last index) only the 12 rows around it are searched, as the plan's
   * section 8 asks; without one the spatial hash finds the candidates (a full scan only if the
   * point is far from every row). Returns { index, progress, s, lateral, ahead } where `index`
   * is the nearest table row, `s` and `progress` are refined onto the segment, `lateral` is
   * signed metres to the right of travel and `ahead` is the along track offset from row `index`.
   */
  nearest(x, z, hintIndex = -1) {
    const rows = this.samples, N = this.count;
    let best = -1, bestD = Infinity;
    if (hintIndex >= 0) {
      for (let d = -6; d <= 6; d++) {
        const i = mod(hintIndex + d, N);
        const r = rows[i];
        const dd = (r.x - x) * (r.x - x) + (r.z - z) * (r.z - z);
        if (dd < bestD) { bestD = dd; best = i; }
      }
      // if the hint was stale (more than 9 m off) fall through to the hash
      if (bestD > 81) { best = -1; bestD = Infinity; }
    }
    if (best < 0) {
      const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
      for (let ring = 1; ring <= 3 && best < 0; ring++) {
        for (let ix = cx - ring; ix <= cx + ring; ix++) {
          for (let iz = cz - ring; iz <= cz + ring; iz++) {
            const list = this.hash.get(ix + ',' + iz);
            if (!list) continue;
            for (const i of list) {
              const r = rows[i];
              const dd = (r.x - x) * (r.x - x) + (r.z - z) * (r.z - z);
              if (dd < bestD) { bestD = dd; best = i; }
            }
          }
        }
      }
      if (best < 0) {   // far off the track: scan everything
        for (let i = 0; i < N; i++) {
          const r = rows[i];
          const dd = (r.x - x) * (r.x - x) + (r.z - z) * (r.z - z);
          if (dd < bestD) { bestD = dd; best = i; }
        }
      }
    }
    // refine onto the two segments touching the best row
    const r = rows[best], rp = rows[mod(best - 1, N)], rn = rows[mod(best + 1, N)];
    let along = 0, dist2 = Infinity;
    // segment best -> next
    {
      const ax = r.x, az = r.z, bx = rn.x, bz = rn.z;
      const vx = bx - ax, vz = bz - az, vv = vx * vx + vz * vz || 1;
      let t = ((x - ax) * vx + (z - az) * vz) / vv; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + vx * t, pz = az + vz * t;
      const d2 = (x - px) * (x - px) + (z - pz) * (z - pz);
      if (d2 < dist2) { dist2 = d2; along = t * this.ds; }
    }
    // segment prev -> best
    {
      const ax = rp.x, az = rp.z, bx = r.x, bz = r.z;
      const vx = bx - ax, vz = bz - az, vv = vx * vx + vz * vz || 1;
      let t = ((x - ax) * vx + (z - az) * vz) / vv; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + vx * t, pz = az + vz * t;
      const d2 = (x - px) * (x - px) + (z - pz) * (z - pz);
      if (d2 < dist2) { dist2 = d2; along = (t - 1) * this.ds; }
    }
    const s = mod(r.s + along, this.length);
    const q = this.atDistance(s, this._q || (this._q = {}));
    const lateral = (x - q.x) * q.nx + (z - q.z) * q.nz;
    return { index: best, progress: s / this.length, s, lateral, ahead: along, dist: Math.sqrt(dist2) };
  }

  /** World point on the road surface at a lateral offset (bank applied inside the road width). */
  point(progress01, lateral, out = new THREE.Vector3()) {
    const q = this.at(progress01, this._p || (this._p = {}));
    const h = q.width / 2;
    const lb = lateral < -h ? -h : lateral > h ? h : lateral;
    out.set(q.x + q.nx * lateral, q.y - lb * dtan(q.bank * Math.PI / 180), q.z + q.nz * lateral);
    return out;
  }

  /** Unit 3D tangent (includes the grade). */
  tangent(progress01, out = new THREE.Vector3()) {
    const q = this.at(progress01, this._t || (this._t = {}));
    return out.set(q.tx, q.grade, q.tz).normalize();
  }

  /** Road surface normal (bank and grade) at a progress, for the kart tilt and the ribbon. */
  normal(progress01, out = new THREE.Vector3()) {
    const q = this.at(progress01, this._n || (this._n = {}));
    return Spline.normalOf(q, out);
  }
  static normalOf(q, out = new THREE.Vector3()) {
    const tb = dtan(q.bank * Math.PI / 180);
    const t = _tv.set(q.tx, q.grade, q.tz).normalize();
    const rgt = _rv.set(q.nx, -tb, q.nz).normalize();
    return out.crossVectors(rgt, t).normalize();
  }

  /** Road surface y under (x, z) if within width/2 + 2 m of the centreline, else NaN. */
  roadY(x, z) {
    const n = this.nearest(x, z);
    const q = this.atDistance(n.s, this._r || (this._r = {}));
    const h = q.width / 2;
    if (Math.abs(n.lateral) > h + 2) return NaN;
    const lb = n.lateral < -h ? -h : n.lateral > h ? h : n.lateral;
    return q.y - lb * dtan(q.bank * Math.PI / 180);
  }

  /** True when s lies in [sOf(wpA), sOf(wpB)) (waypoint indices; wpB may be 59 = the lap end). */
  inWaypointRange(s, wpA, wpB) {
    const a = this.waypointS[wpA], b = this.waypointS[wpB];
    s = mod(s, this.length);
    return s >= a && s < b;
  }
}

const _tv = new THREE.Vector3(), _rv = new THREE.Vector3();

// One shared instance so LAP_LENGTH is a real number at import time, as the contract asks.
export const SPLINE = new Spline(WAYPOINTS);
export const LAP_LENGTH = SPLINE.length;
export const LAP_LENGTH_TARGET = 1061;
if (Math.abs(LAP_LENGTH - LAP_LENGTH_TARGET) / LAP_LENGTH_TARGET > 0.01) {
  console.error(`[spline] LAP_LENGTH ${LAP_LENGTH.toFixed(1)} m is more than 1 percent off the plan's ${LAP_LENGTH_TARGET} m`);
}
