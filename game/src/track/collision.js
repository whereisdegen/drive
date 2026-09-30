/**
 * track/collision.js - the collision world, docs/TRACK-PLAN.md section 6 and 8.
 *
 * Colliders are 2D footprints in xz with a height band: oriented boxes, cylinders and wall
 * segments, in a spatial hash (8 m cells). The ground is the road ribbon first (road.probe:
 * road surface, kerb substrate, pavement, shoulder, apron, quay), then the terrain, then water
 * below y -1.0. Karts slide along walls: a hit (3 m/s or more into the wall) keeps 60 percent of
 * the tangential speed and bounces with 20 percent of the normal speed, a graze at a shallow
 * angle keeps its speed and loses only the normal part; the ground normal is returned so the
 * kart tilts on banks. Gravity is the caller's.
 *
 * The guard wall of the cliff road is registered here from the road's wall stations (tag
 * 'guardwall', the three fall gaps open) so the circuit is drivable before the level builds;
 * the level builder may call removeTag('guardwall') if it registers its own per placement.
 *
 * Collider y: `center` is the GEOMETRIC centre (y = base + height / 2) for addBox and
 * addCylinder; addWallSegment takes the two base points and the height.
 */
import * as THREE from 'three';
// Deterministic transcendentals, not the host's: Math.sin/cos/tan/atan2/pow/exp are not
// specified to the last bit by ECMAScript and Chrome and Node genuinely disagree, which over a
// 15 000 tick race is the difference between two cars. See src/token/detmath.js.
import { dcos, dhypot, dsin } from '../token/detmath.js?v=r6-20260906191941';
import { yAt } from './road.js?v=r6-20260906191941';

const UP = new THREE.Vector3(0, 1, 0);
const KART_BAND = { lo: 0.12, hi: 1.0 };   // colliders whose top is under lo above the kart's y are driven over
const WALL_LOSS = 0.4, WALL_BOUNCE = 0.2, WALL_HIT_SPEED = 3.0;   // plan section 6: 40 percent loss and a small bounce on a hit; a graze keeps its speed

export class World {
  constructor(terrain, spline, road) {
    this.terrain = terrain; this.spline = spline; this.road = road;
    this.cell = 8;
    this.grid = new Map();
    this.list = [];
    this._stamp = 0;
    this._q = {};
    if (road && road.wallStations) {
      const a = new THREE.Vector3(), b = new THREE.Vector3();
      for (const w of road.wallStations) {
        if (w.gap) continue;
        const q = spline.atDistance(w.s, this._q);
        a.set(w.x - q.tx * 2, w.y, w.z - q.tz * 2); b.set(w.x + q.tx * 2, w.y, w.z + q.tz * 2);
        this.addWallSegment(a, b, 0.9, 'guardwall', 0.5);
      }
    }
  }

  // ------------------------------------------------------------------ registration
  _cellKey(cx, cz) { return cx + ',' + cz; }
  _insert(c) {
    const cx0 = Math.floor((c.minX - 0.5) / this.cell), cx1 = Math.floor((c.maxX + 0.5) / this.cell);
    const cz0 = Math.floor((c.minZ - 0.5) / this.cell), cz1 = Math.floor((c.maxZ + 0.5) / this.cell);
    c.cells = [];
    for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) {
      const k = this._cellKey(cx, cz);
      let list = this.grid.get(k);
      if (!list) { list = []; this.grid.set(k, list); }
      list.push(c); c.cells.push(k);
    }
    this.list.push(c);
    return c;
  }
  addBox(center, size, yaw = 0, tag = 'static') {
    const hx = size.x / 2, hz = size.z / 2, cos = dcos(yaw), sin = dsin(yaw);
    const ex = Math.abs(hx * cos) + Math.abs(hz * sin), ez = Math.abs(hx * sin) + Math.abs(hz * cos);
    return this._insert({
      type: 'box', tag, cx: center.x, cz: center.z, hx, hz, cos, sin,
      yMin: center.y - size.y / 2, yMax: center.y + size.y / 2,
      minX: center.x - ex, maxX: center.x + ex, minZ: center.z - ez, maxZ: center.z + ez,
    });
  }
  addCylinder(center, radius, height, tag = 'static') {
    return this._insert({
      type: 'cyl', tag, cx: center.x, cz: center.z, r: radius,
      yMin: center.y - height / 2, yMax: center.y + height / 2,
      minX: center.x - radius, maxX: center.x + radius, minZ: center.z - radius, maxZ: center.z + radius,
    });
  }
  addWallSegment(a, b, height = 3, tag = 'static', thickness = 0.3) {
    const t = thickness / 2;
    return this._insert({
      type: 'seg', tag, ax: a.x, az: a.z, bx: b.x, bz: b.z, t,
      yMin: Math.min(a.y, b.y), yMax: Math.max(a.y, b.y) + height,
      minX: Math.min(a.x, b.x) - t, maxX: Math.max(a.x, b.x) + t, minZ: Math.min(a.z, b.z) - t, maxZ: Math.max(a.z, b.z) + t,
    });
  }
  removeTag(tag) {
    let n = 0;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const c = this.list[i];
      if (c.tag !== tag) continue;
      for (const k of c.cells) { const list = this.grid.get(k); if (list) { const j = list.indexOf(c); if (j >= 0) list.splice(j, 1); } }
      this.list.splice(i, 1); n++;
    }
    return n;
  }
  colliders() { return this.list; }

  // ------------------------------------------------------------------ queries
  _candidates(x, z, r) {
    const out = [];
    const cx0 = Math.floor((x - r) / this.cell), cx1 = Math.floor((x + r) / this.cell);
    const cz0 = Math.floor((z - r) / this.cell), cz1 = Math.floor((z + r) / this.cell);
    const stamp = ++this._stamp;
    for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) {
      const list = this.grid.get(this._cellKey(cx, cz));
      if (!list) continue;
      for (const c of list) { if (c._stamp === stamp) continue; c._stamp = stamp; out.push(c); }
    }
    return out;
  }
  /** Circle (px, pz, r) against a collider: { pen, nx, nz } or null. */
  _pen(c, px, pz, r) {
    if (c.type === 'cyl') {
      const dx = px - c.cx, dz = pz - c.cz, d = dhypot(dx, dz);
      if (d >= c.r + r) return null;
      return d > 1e-6 ? { pen: c.r + r - d, nx: dx / d, nz: dz / d } : { pen: c.r + r, nx: 1, nz: 0 };
    }
    if (c.type === 'seg') {
      const vx = c.bx - c.ax, vz = c.bz - c.az, vv = vx * vx + vz * vz || 1;
      let t = ((px - c.ax) * vx + (pz - c.az) * vz) / vv; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = c.ax + vx * t, qz = c.az + vz * t;
      const dx = px - qx, dz = pz - qz, d = dhypot(dx, dz);
      if (d >= c.t + r) return null;
      if (d > 1e-6) return { pen: c.t + r - d, nx: dx / d, nz: dz / d };
      const l = Math.sqrt(vv); return { pen: c.t + r, nx: -vz / l, nz: vx / l };
    }
    // oriented box
    const dx = px - c.cx, dz = pz - c.cz;
    const lx = dx * c.cos - dz * c.sin, lz = dx * c.sin + dz * c.cos;
    const qx = lx < -c.hx ? -c.hx : lx > c.hx ? c.hx : lx, qz = lz < -c.hz ? -c.hz : lz > c.hz ? c.hz : lz;
    let nlx, nlz, pen;
    if (qx === lx && qz === lz) {
      const ex = c.hx - Math.abs(lx), ez = c.hz - Math.abs(lz);
      if (ex < ez) { nlx = lx < 0 ? -1 : 1; nlz = 0; pen = ex + r; } else { nlx = 0; nlz = lz < 0 ? -1 : 1; pen = ez + r; }
    } else {
      const ddx = lx - qx, ddz = lz - qz, d = dhypot(ddx, ddz);
      if (d >= r) return null;
      nlx = ddx / d; nlz = ddz / d; pen = r - d;
    }
    // local -> world: local +X is (cos, -sin), local +Z is (sin, cos)
    return { pen, nx: nlx * c.cos + nlz * c.sin, nz: -nlx * c.sin + nlz * c.cos };
  }

  /** Ground under (x, z): road first, then terrain, then water. surface: asphalt cobble pad grass sand water air. */
  groundAt(x, z, out = {}) {
    const p = this.road.probe(x, z);
    out.normal = out.normal || new THREE.Vector3();
    if (p) {
      let y = p.y;
      if (p.zone === 'apron') y = Math.max(y, this.terrain.heightAt(x, z));
      if (p.zone === 'road') this.spline.constructor.normalOf(p.q, out.normal); else out.normal.copy(UP);
      out.y = y; out.surface = p.surface; out.zone = p.zone; out.onRoad = p.zone === 'road' || p.zone === 'kerb';
      out.progress = p.progress; out.lateral = p.lateral; out.index = p.index;
      return out;
    }
    out.onRoad = false; out.zone = 'terrain'; out.progress = undefined; out.lateral = undefined;
    if (!this.terrain.inBounds(x, z)) { out.y = -6; out.normal.copy(UP); out.surface = 'air'; return out; }
    const ty = this.terrain.heightAt(x, z);
    if (ty < -1.0) { out.y = this.terrain.seaLevel; out.normal.copy(UP); out.surface = 'water'; return out; }
    this.terrain.normalAt(x, z, out.normal);
    const paint = this.terrain.paintAt(x, z);
    out.y = ty;
    out.surface = paint === 'cobble' ? 'cobble' : paint === 'asphalt' ? 'asphalt' : paint === 'sand' ? 'sand' : 'grass';
    return out;
  }

  /**
   * Integrate a kart one step and resolve it against walls and the ground.
   * pos and vel are modified in place and returned. The caller applies gravity to vel.y first.
   */
  moveKart(pos, vel, radius = 0.7, dt = 1 / 60) {
    pos.x += vel.x * dt; pos.y += vel.y * dt; pos.z += vel.z * dt;
    let hitWall = false, wallNormal = null;
    for (let iter = 0; iter < 2; iter++) {
      const cands = this._candidates(pos.x, pos.z, radius + 0.5);
      for (const c of cands) {
        if (c.yMax <= pos.y + KART_BAND.lo || c.yMin >= pos.y + KART_BAND.hi) continue;
        const h = this._pen(c, pos.x, pos.z, radius);
        if (!h) continue;
        pos.x += h.nx * h.pen; pos.z += h.nz * h.pen;
        const vn = vel.x * h.nx + vel.z * h.nz;
        if (vn < 0) {
          // A HIT (square into the wall, 3 m/s or more along the normal) loses 40 percent along the wall and bounces
          // 20 percent; a GRAZE (a kart steering along a wall at a shallow angle, a few tenths of a m/s into it) only
          // loses the normal part, scaled by how hard it came in. Round 2 fix 102: the loss used to apply every frame
          // the kart touched the wall, so a kart running the rise verge into the east retaining wall at 25 degrees
          // stalled dead against it (work/fix2_track/verge_probe.mjs: 13.6 m/s to 0 in one tick); now it slides.
          const hard = Math.min(1, -vn / WALL_HIT_SPEED);
          const keep = 1 - WALL_LOSS * hard;
          const tx = vel.x - vn * h.nx, tz = vel.z - vn * h.nz;
          vel.x = tx * keep + h.nx * (-vn) * WALL_BOUNCE * hard;
          vel.z = tz * keep + h.nz * (-vn) * WALL_BOUNCE * hard;
        }
        hitWall = true;
        wallNormal = wallNormal || new THREE.Vector3();
        wallNormal.set(h.nx, 0, h.nz);
      }
    }
    const g = this.groundAt(pos.x, pos.z, this._g || (this._g = {}));
    let grounded = false;
    if (g.surface !== 'water' && g.surface !== 'air') {
      const gap = pos.y - g.y;
      if (gap <= 0.02 || (gap < 0.35 && vel.y <= 0.5)) { pos.y = g.y; if (vel.y < 0) vel.y = 0; grounded = true; }
    }
    return { pos, vel, hitWall, wallNormal, grounded, groundY: g.y, surface: g.surface, normal: g.normal, onRoad: g.onRoad, zone: g.zone };
  }

  /** March a sphere from -> to against colliders and the ground; for the chase camera pull in. */
  sphereCast(from, to, radius = 0.4) {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const len = dhypot(dx, dy, dz);
    const steps = Math.max(1, Math.ceil(len / 0.5));
    const p = new THREE.Vector3(), prev = from.clone();
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      p.set(from.x + dx * t, from.y + dy * t, from.z + dz * t);
      let hit = false;
      const g = this.groundAt(p.x, p.z, this._g2 || (this._g2 = {}));
      if (g.surface !== 'water' && g.surface !== 'air' && p.y - radius < g.y) hit = true;
      if (!hit) {
        for (const c of this._candidates(p.x, p.z, radius + 0.5)) {
          if (c.yMax <= p.y - radius || c.yMin >= p.y + radius) continue;
          if (this._pen(c, p.x, p.z, radius)) { hit = true; break; }
        }
      }
      if (hit) return { hit: true, point: prev, dist: len * (i - 1) / steps };
      prev.copy(p);
    }
    return { hit: false, point: to.clone(), dist: len };
  }

  /** March a ray; returns { hit, point, normal, dist, tag }. For the cannonball bounce. */
  raycast(origin, dir, maxDist = 50, opts = {}) {
    const d = dir.clone().normalize();
    const step = 0.25;
    const p = new THREE.Vector3();
    const normal = new THREE.Vector3();
    for (let s = step; s <= maxDist; s += step) {
      p.copy(origin).addScaledVector(d, s);
      const g = this.groundAt(p.x, p.z, this._g3 || (this._g3 = {}));
      if (g.surface !== 'water' && g.surface !== 'air' && p.y < g.y) {
        return { hit: true, point: p.clone(), normal: normal.copy(g.normal), dist: s, tag: 'ground' };
      }
      for (const c of this._candidates(p.x, p.z, 0.6)) {
        if (opts.ignoreTag && c.tag === opts.ignoreTag) continue;
        if (c.yMax <= p.y || c.yMin >= p.y) continue;
        const h = this._pen(c, p.x, p.z, 0.05);
        if (h) return { hit: true, point: p.clone(), normal: normal.set(h.nx, 0, h.nz), dist: s, tag: c.tag };
      }
    }
    return { hit: false, point: null, normal: null, dist: maxDist, tag: null };
  }

  /** True when the kart is in the water, 4 m under the road at its progress, or 40 m off the line. */
  isFall(pos) {
    if (pos.y < -1.0) return true;
    const n = this.spline.nearest(pos.x, pos.z);
    if (Math.abs(n.lateral) >= 40) return true;
    const q = this.spline.atDistance(n.s, this._q);
    return pos.y < yAt(q, n.lateral) - 4;
  }
}
