/**
 * track/terrain.js - the Sorrel Cove heightfield, docs/TRACK-PLAN.md section 4.
 *
 * One 2 m grid, 206 x 186 vertices over x -210..200, z -190..180, composed per vertex in this
 * order: base slope (east and south rise), cliff ridge, beach cove, sea and harbour basin cuts,
 * breakwater raise, pads, the 3 m contour terraces of the town interior, road flatten (the road
 * wins over every pad), the 65 degree cliff face on the sea side of G, H and the first half of
 * I, the lighthouse rock dome, the rock face rising inside the cliff road. Split into the 30 m
 * block tiles of section 10; tiles that lie entirely on the sea floor are not built (the sea
 * plane covers them, the sea shader reads the height grid directly).
 *
 * Where the plan's numbers contradict each other the choices are written in work/track/NOTES.md:
 * the ridge is "raise toward 24 m", not "+24 m" (the base already reaches 21 to 23 m at the
 * cliff road, +24 would put the cliff top at 46 m); west of x -127 north of the basin the ground
 * climbs toward the descent road instead of staying at -3; the rock face rises on the NORTH
 * (inner) side of the cliff road because +Z is south and the sea is south.
 *
 * Attributes on every tile: position, normal, uv (world xz / 4, metric like the road), color
 * (style lock paint plus 4 percent noise), aSplat (vec4 weights grass, sand, cobble, rock),
 * aPaint (0 grass, 1 sand, 2 cobble, 3 rock, 4 asphalt; asphalt also weights the cobble channel).
 */
import * as THREE from 'three';
// Deterministic transcendentals, not the host's: Math.sin/cos/tan/atan2/pow/exp/hypot are not
// specified to the last bit by ECMAScript and Chrome and Node genuinely disagree, which over a
// 15 000 tick race is the difference between two cars. See src/token/detmath.js.
import { dacos, dcos, dhypot, dtan } from '../token/detmath.js?v=r6-20260906191941';
import { sideProfile, noise2, smoothstep, yAt, ROAD } from './road.js?v=r6-20260906191941';

export const TERRAIN_SPEC = {
  bounds: { minX: -210, maxX: 200, minZ: -190, maxZ: 180 },
  cell: 2,
  seaLevel: -1.4, seaFloor: -3, cliffFloor: -6,
  base: { y0: 0.2, kx: 0.055, x0: -127, kz: 0.06, z0: -160, fade: [-127, -115], clamp: 26, noise: [[0.25, 14], [0.08, 4]] },
  ridge: { z0: 40, z1: 100, top: 24, xIn: [-170, -140], xOut: [50, 80], innerRise: 6 },
  cliff: { wpA: 41, wpB: 52, angleDeg: 65, drop: ROAD.CLIFF_DROP, endFeather: 22 },
  cove: { xEdge: -163, z0: 20, z1: 96, top: 3.2, slope: 0.17, floor: -3, feather: 6 },
  lighthouse: { x: -177, z: 121, radius: 26, top: 14, flat: 9 },
  basin: { xMax: -142, z0: -132, z1: 12, y: -3 },
  breakwater: { y: 0.6, rects: [{ x0: -196, x1: -142, z0: 11, z1: 17 }, { x0: -199, x1: -193, z0: -112, z1: 14 }] },
  pads: [   // section 4.7, 1.5 m blended edge unless a pad gives its own `blend`
    { name: 'quay', x0: -142, x1: -118, z0: -132, z1: 12, y: 0.2, surface: 'asphalt', cobbleNorthOf: -108, blend: 8 },   // the town climbs behind the quay houses as a slope, not an 8 m scarp
    { name: 'fish_market', x0: -128, x1: -90, z0: -168, z1: -150, y: 1.6, surface: 'cobble' },
    { name: 'piazza', x0: 118, x1: 152, z0: -140, z1: -108, y: 9.6, surface: 'cobble' },
    { name: 'church', x0: 165, x1: 198, z0: -142, z1: -108, y: 9.8, surface: 'cobble' },
    { name: 'clock_tower', x0: 40, x1: 56, z0: -4, z1: 14, y: 16.7, surface: 'cobble' },
    { name: 'layby', x0: 66, x1: 84, z0: 70, z1: 96, y: 20.6, surface: 'asphalt' },
    { name: 'grandstand', x0: -118, x1: -104, z0: -74, z1: -46, y: 0.4, surface: 'cobble' },
    { name: 'beach_hut', x0: -178, x1: -172, z0: 60, z1: 66, y: 2.6, surface: 'sand' },
  ],
  extraPads: [],   // the level may pass house pads here: { x0, x1, z0, z1, y, surface }
  flatten: { extra: 4.0, blend: 6.0, beachExtra: 2.1, beachBlend: 5.0, beachWp: [53, 58], underRoad: -0.03, underPavement: -0.02 },
  // the clock tower rise (F): its east side is a flat grass verge at pavement level out to the retaining wall line
  // (TRACK-PLAN 7.6: retaining_wall_terrace x 18 along x = 80, z -50 to 58, face west), the hill held back BEHIND
  // the wall over `behind` metres. Round 2 fix 102: the 6 m blend put a 30 to 49 degree bank between the pavement
  // and the wall, the wall's base 1.6 to 4 m up it, and a kart that left the road climbed the bank onto the wall face.
  riseVerge: { wpA: 31, wpB: 40, xWall: 80.4, behind: 5.0, z0: -50, z1: 58, zFeather: 4 },
  terraces: { x0: -110, x1: 40, z0: -150, z1: -30, step: 3, edgeMetres: 1.0 },
  paint: { grass: 0x9aa64a, sand: 0xe6cf9c, cobble: 0xa39f99, rock: 0xcdb897, rockShade: 0x8d7b63, asphalt: 0x65686e },   // cobble and asphalt match road.js PALETTE (round 1: warm grey paving)
  rockSlopeDeg: 40,
  block: 30,
};

const PAINT = { grass: 0, sand: 1, cobble: 2, rock: 3, asphalt: 4 };
const PAINT_NAME = ['grass', 'sand', 'cobble', 'rock', 'asphalt'];
const DEG = Math.PI / 180;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

/** Distance outside an axis aligned rect (0 inside). */
function rectDist(x, z, r) {
  const dx = Math.max(r.x0 - x, 0, x - r.x1), dz = Math.max(r.z0 - z, 0, z - r.z1);
  return dhypot(dx, dz);
}

export function buildTerrain(THREE_, spline, spec = TERRAIN_SPEC) {
  const B = spec.bounds, cell = spec.cell;
  const nx = Math.round((B.maxX - B.minX) / cell) + 1, nz = Math.round((B.maxZ - B.minZ) / cell) + 1;
  const heights = new Float32Array(nx * nz);
  const paint = new Uint8Array(nx * nz);
  const S = spec;
  const wpS = spline.waypointS;
  const sCliffA = wpS[S.cliff.wpA], sCliffB = wpS[S.cliff.wpB];
  const tanCliff = dtan(S.cliff.angleDeg * DEG);
  const gradLen = dhypot(S.base.kx, S.base.kz);            // base rise per metre along the gradient
  const terraceFrac = (gradLen * S.terraces.edgeMetres) / S.terraces.step;
  const pads = S.pads.concat(spec.extraPads || []);

  function smoothBase(x, z) {
    const b = S.base;
    if (x < b.x0) {
      if (z >= S.basin.z0 && z <= S.basin.z1) return S.seaFloor;                       // harbour basin and the sea west of the quay
      if (z > S.basin.z1) return b.y0 + b.kz * Math.max(0, z - b.z0) * smoothstep(-166, -140, x);   // the descent hill east of the beach
      return b.y0 + 0.4 * smoothstep(-200, -160, x);                                     // the headland north of the harbour
    }
    const f = z > S.basin.z1 ? 1 : smoothstep(b.fade[0], b.fade[1], x);
    return Math.min(b.clamp, b.y0 + b.kx * Math.max(0, x - b.x0) + b.kz * Math.max(0, z - b.z0) * f);
  }

  const qTmp = {};
  function compose(x, z, out) {
    let y = smoothBase(x, z);
    const isSeaBase = y <= S.seaFloor + 1e-6;
    // noise (never on the sea floor)
    if (!isSeaBase) for (const [amp, wl] of S.base.noise) y += (noise2(x, z, wl) - 0.5) * 2 * amp;
    // ---- cliff ridge: raise toward the cliff top between z 40 and 100, feathered at both x ends
    {
      const rz = smoothstep(S.ridge.z0, S.ridge.z1, z);
      const fx = smoothstep(S.ridge.xIn[0], S.ridge.xIn[1], x) * (1 - smoothstep(S.ridge.xOut[0], S.ridge.xOut[1], x));
      y = lerp(y, Math.max(y, S.ridge.top), rz * fx);
    }
    // ---- beach cove
    let coveW = 0;
    {
      const c = S.cove;
      const w = smoothstep(c.xEdge + 3, c.xEdge, x) * smoothstep(c.z0 - c.feather, c.z0, z) * (1 - smoothstep(c.z1, c.z1 + c.feather, z));
      if (w > 0) {
        const cove = Math.max(c.floor, c.top - (c.xEdge - x) * c.slope);
        y = lerp(y, cove, w); coveW = w;
      }
    }
    // ---- open sea: west of the breakwater, the south coast east of the cliff, south west beyond the lighthouse
    {
      const wW = smoothstep(-193, -199, x) * smoothstep(-135, -129, z);
      y = lerp(y, S.seaFloor, wW);
      const wS = smoothstep(122, 145, z) * smoothstep(50, 70, x);
      y = lerp(y, S.cliffFloor, wS);
      const wSW = smoothstep(98, 110, z) * smoothstep(-155, -170, x);
      y = lerp(y, S.seaFloor, wSW);
    }
    // ---- breakwater
    let breakW = 0;
    for (const r of S.breakwater.rects) {
      const w = 1 - smoothstep(0, 1.0, rectDist(x, z, r));
      if (w > 0) { y = lerp(y, Math.max(y, S.breakwater.y), w); breakW = Math.max(breakW, w); }
    }
    out.breakW = breakW;
    // ---- pads
    let padW = 0, padSurface = null;
    for (const p of pads) {
      const w = 1 - smoothstep(0, p.blend || 1.5, rectDist(x, z, p));
      if (w <= 0) continue;
      y = lerp(y, p.y, w);
      if (w > padW) { padW = w; padSurface = p.cobbleNorthOf !== undefined && z < p.cobbleNorthOf ? 'cobble' : p.surface; }
    }
    // ---- terraces (town interior), 3 m steps of the smooth base with a 1 m blended edge
    {
      const t = S.terraces;
      if (x >= t.x0 && x <= t.x1 && z >= t.z0 && z <= t.z1) {
        const b = S.base;
        const sb = b.y0 + b.kx * Math.max(0, x - b.x0) + b.kz * Math.max(0, z - b.z0);
        const q = sb / t.step, fl = Math.floor(q);
        const terr = t.step * (fl + smoothstep(0, terraceFrac, q - fl)) + (noise2(x, z, 4) - 0.5) * 0.10;
        const edge = smoothstep(t.x0, t.x0 + 6, x) * (1 - smoothstep(t.x1 - 6, t.x1, x)) * smoothstep(t.z0, t.z0 + 6, z) * (1 - smoothstep(t.z1 - 6, t.z1, z));
        y = lerp(y, terr, edge * (1 - padW));
      }
    }
    // ---- road flatten (the road wins over pads and terraces)
    const n = spline.nearest(x, z);
    let q = null, l = 0, h = 0, side = 1, yEdge = 0;
    if (n.dist < 45) {
      q = spline.atDistance(n.s, qTmp);
      l = n.lateral; h = q.width / 2; side = l < 0 ? -1 : 1;
      const al = Math.abs(l);
      yEdge = yAt(q, side * h);
      const prof = sideProfile(spline, n.s, side);
      const F = S.flatten;
      const beachSide = side < 0 && n.s >= wpS[F.beachWp[0]] && n.s < wpS[F.beachWp[1]];
      const extra = beachSide ? F.beachExtra : F.extra, blend = beachSide ? F.beachBlend : F.blend;
      let yr;
      if (al <= h) yr = yAt(q, l) + F.underRoad;
      else if (al <= h + ROAD.KERB_W) yr = yEdge;                                            // under the kerb substrate
      else if (prof.kind === 'pavement') yr = yEdge + ROAD.PAVE_H + F.underPavement;         // the pavement band
      else yr = yEdge;
      let w = al <= h + extra ? 1 : 1 - smoothstep(0, blend, al - h - extra);
      // the rise verge: on the east of F the flatten reaches the retaining wall line, whatever the lateral
      const V = S.riseVerge;
      if (V && l < 0 && n.s >= wpS[V.wpA] && n.s <= wpS[V.wpB]) {   // heading south, east is the LEFT of travel (l < 0)
        const zw = smoothstep(V.z0 - V.zFeather, V.z0, z) * (1 - smoothstep(V.z1, V.z1 + V.zFeather, z));
        const xw = 1 - smoothstep(V.xWall, V.xWall + V.behind, x);
        w = Math.max(w, zw * xw);
      }
      if (w > 0) y = lerp(y, yr, w);
      out.flattenW = w;
    } else out.flattenW = 0;
    // ---- cliff face on the sea side of G, H and the first half of I
    if (q && l < 0 && n.s >= sCliffA && n.s <= sCliffB) {
      const d = -l - (h + S.cliff.drop);
      if (d > 0) {
        let face = yEdge - d * tanCliff;
        // the floor rises toward both ends so the face fades into the ground instead of a wall across the map
        const fa = 1 - smoothstep(0, S.cliff.endFeather, n.s - sCliffA);
        const fb = 1 - smoothstep(0, S.cliff.endFeather, sCliffB - n.s);
        const floor = S.cliffFloor + 14 * Math.max(fa, fb);
        face = Math.max(face, floor);
        y = Math.min(y, face);
      }
    }
    // ---- harbour basin: a hard step at the quay line (plan 4.6, "one cell"), except under the ribbon itself
    if (x < S.basin.xMax && z >= S.basin.z0 && z <= S.basin.z1 && out.flattenW < 0.999) y = Math.min(y, S.basin.y);
    // ---- lighthouse rock dome
    let domeR = Infinity;
    {
      const L = S.lighthouse;
      const r = dhypot(x - L.x, z - L.z); domeR = r;
      if (r < L.radius) y = Math.max(y, L.top * (1 - smoothstep(L.flat, L.radius, r)) + (noise2(x, z, 5) - 0.5) * 0.3 * (r > L.flat ? 1 : 0));
    }
    out.domeR = domeR;
    // ---- rock face rising on the inner (north) side of the cliff road
    if (q && l > 0 && n.s >= wpS[43] && n.s <= wpS[50]) {
      const d = l - (h + S.flatten.extra + 2);
      if (d > 0) y += S.ridge.innerRise * smoothstep(0, 6, d) * (1 - smoothstep(10, 45, d)) * (1 + 0.3 * (noise2(x, z, 6) - 0.5));
    }
    out.y = y; out.coveW = coveW; out.padW = padW; out.padSurface = padSurface;
    out.n = n; out.q = q; out.l = l; out.h = h; out.side = side;
    return out;
  }

  // ---- 1. heights and the paint class before slope
  const info = { y: 0 };
  const beachWp = S.flatten.beachWp;
  for (let iz = 0; iz < nz; iz++) {
    const z = B.minZ + iz * cell;
    for (let ix = 0; ix < nx; ix++) {
      const x = B.minX + ix * cell;
      compose(x, z, info);
      const k = iz * nx + ix;
      heights[k] = info.y;
      // paint
      let p = PAINT.grass;
      if (info.padW > 0.5 && info.padSurface) p = PAINT[info.padSurface] ?? PAINT.cobble;
      if (info.coveW > 0.5) p = PAINT.sand;
      if (info.breakW > 0.5) p = PAINT.cobble;                                  // the breakwater cap carries harbour_wall_module
      if (info.domeR < S.lighthouse.radius * 0.75) p = PAINT.rock;               // the lighthouse rock
      if (info.y < -1.2) p = PAINT.sand;
      if (info.q && info.n.dist < 45) {
        const al = Math.abs(info.l), h = info.h, s = info.n.s, side = info.side;
        const prof = sideProfile(spline, s, side);
        if (al <= h + ROAD.KERB_W) p = info.q.surface === 'cobble' ? PAINT.cobble : PAINT.asphalt;
        else if (prof.kind === 'pavement' && al <= h + ROAD.KERB_W + ROAD.PAVE_W + 0.5) p = PAINT.cobble;
        else if (side < 0 && s >= wpS[beachWp[0]] && s < wpS[beachWp[1]] && al <= h + S.flatten.beachExtra) p = PAINT.sand;
        else if (side < 0 && s >= sCliffA && s <= sCliffB && al <= h + S.cliff.drop + 1.5) p = PAINT.sand;   // dust on the cliff verge
      }
      paint[k] = p;
    }
  }
  // ---- 2. normals and the rock override by slope
  const normals = new Float32Array(nx * nz * 3);
  const cosRock = dcos(S.rockSlopeDeg * DEG);
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const k = iz * nx + ix;
      const hl = heights[iz * nx + Math.max(0, ix - 1)], hr = heights[iz * nx + Math.min(nx - 1, ix + 1)];
      const hd = heights[Math.max(0, iz - 1) * nx + ix], hu = heights[Math.min(nz - 1, iz + 1) * nx + ix];
      const sx = (ix === 0 || ix === nx - 1) ? cell : 2 * cell, sz = (iz === 0 || iz === nz - 1) ? cell : 2 * cell;
      let vx = -(hr - hl) / sx, vy = 1, vz = -(hu - hd) / sz;
      const len = dhypot(vx, vy, vz); vx /= len; vy /= len; vz /= len;
      normals[k * 3] = vx; normals[k * 3 + 1] = vy; normals[k * 3 + 2] = vz;
      if (vy < cosRock && heights[k] > -1.2) paint[k] = PAINT.rock;
    }
  }

  // ---- 3. tiles per block
  const cols = Object.fromEntries(Object.entries(S.paint).map(([k, v]) => [k, new THREE.Color(v)]));
  const tmpC = new THREE.Color();
  const perBlock = Math.round(S.block / cell);
  const nbx = Math.ceil((B.maxX - B.minX) / S.block), nbz = Math.ceil((B.maxZ - B.minZ) / S.block);
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, name: 'ground' });
  material.userData.surface = 'ground';
  const tiles = [];
  for (let bz = 0; bz < nbz; bz++) {
    for (let bx = 0; bx < nbx; bx++) {
      const ix0 = bx * perBlock, iz0 = bz * perBlock;
      const ix1 = Math.min(nx - 1, ix0 + perBlock), iz1 = Math.min(nz - 1, iz0 + perBlock);
      if (ix1 <= ix0 || iz1 <= iz0) continue;
      // skip tiles entirely on the sea floor
      let maxH = -Infinity;
      for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) maxH = Math.max(maxH, heights[iz * nx + ix]);
      if (maxH < -2.5) continue;
      const w = ix1 - ix0 + 1, d = iz1 - iz0 + 1;
      const pos = new Float32Array(w * d * 3), nrm = new Float32Array(w * d * 3), uv = new Float32Array(w * d * 2);
      const col = new Float32Array(w * d * 3), splat = new Float32Array(w * d * 4), apaint = new Float32Array(w * d);
      let v = 0;
      for (let iz = iz0; iz <= iz1; iz++) {
        for (let ix = ix0; ix <= ix1; ix++, v++) {
          const k = iz * nx + ix;
          const x = B.minX + ix * cell, z = B.minZ + iz * cell, y = heights[k];
          pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
          nrm[v * 3] = normals[k * 3]; nrm[v * 3 + 1] = normals[k * 3 + 1]; nrm[v * 3 + 2] = normals[k * 3 + 2];
          uv[v * 2] = x / 4; uv[v * 2 + 1] = z / 4;
          const p = paint[k];
          apaint[v] = p;
          splat[v * 4] = p === PAINT.grass ? 1 : 0; splat[v * 4 + 1] = p === PAINT.sand ? 1 : 0;
          splat[v * 4 + 2] = (p === PAINT.cobble || p === PAINT.asphalt) ? 1 : 0; splat[v * 4 + 3] = p === PAINT.rock ? 1 : 0;
          if (p === PAINT.rock) {
            const steep = clamp((1 - normals[k * 3 + 1]) / 0.6, 0, 1);
            tmpC.copy(cols.rock).lerp(cols.rockShade, 0.35 + 0.5 * steep);
          } else tmpC.copy(cols[PAINT_NAME[p]]);
          if (y < -1.2) tmpC.multiplyScalar(0.82);
          const nz1 = (noise2(x, z, 3) - 0.5) * 0.06 + (noise2(x, z, 17) - 0.5) * 0.05;
          tmpC.multiplyScalar(1 + nz1);
          col[v * 3] = tmpC.r; col[v * 3 + 1] = tmpC.g; col[v * 3 + 2] = tmpC.b;
        }
      }
      const idx = [];
      for (let j = 0; j < d - 1; j++) for (let i = 0; i < w - 1; i++) {
        const a = j * w + i, b = a + 1, c = a + w, e = c + 1;
        idx.push(a, c, b, b, c, e);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setAttribute('aSplat', new THREE.BufferAttribute(splat, 4));
      g.setAttribute('aPaint', new THREE.BufferAttribute(apaint, 1));
      g.setIndex(idx);
      g.computeBoundingBox(); g.computeBoundingSphere();
      const m = new THREE.Mesh(g, material);
      m.receiveShadow = true; m.castShadow = false;
      const key = bx + '_' + bz;
      m.name = 'terrain_' + key;
      m.userData = { kind: 'terrain', block: key, bx, bz };
      tiles.push(m);
    }
  }

  // ---- queries
  function heightAt(x, z) {
    const fx = clamp((x - B.minX) / cell, 0, nx - 1.0001), fz = clamp((z - B.minZ) / cell, 0, nz - 1.0001);
    const ix = Math.floor(fx), iz = Math.floor(fz), tx = fx - ix, tz = fz - iz;
    const k = iz * nx + ix;
    const h00 = heights[k], h10 = heights[k + 1], h01 = heights[k + nx], h11 = heights[k + nx + 1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }
  function normalAt(x, z, out = new THREE.Vector3()) {
    const e = 0.5;
    const hl = heightAt(x - e, z), hr = heightAt(x + e, z), hd = heightAt(x, z - e), hu = heightAt(x, z + e);
    return out.set(-(hr - hl) / (2 * e), 1, -(hu - hd) / (2 * e)).normalize();
  }
  const nTmp = new THREE.Vector3();
  function slopeAt(x, z) { return dacos(clamp(normalAt(x, z, nTmp).y, -1, 1)); }
  function paintAt(x, z) {
    const ix = clamp(Math.round((x - B.minX) / cell), 0, nx - 1), iz = clamp(Math.round((z - B.minZ) / cell), 0, nz - 1);
    return PAINT_NAME[paint[iz * nx + ix]];
  }
  function blockOf(x, z) {
    const bx = Math.floor((x - B.minX) / S.block), bz = Math.floor((z - B.minZ) / S.block);
    return { bx, bz, key: bx + '_' + bz };
  }
  function inBounds(x, z) { return x >= B.minX && x <= B.maxX && z >= B.minZ && z <= B.maxZ; }

  // ---- the cliff top line every 2 m for the rock cladding and the fall test
  const cliffEdge = [];
  for (let s = sCliffA; s <= sCliffB; s += 2) {
    const q = spline.atDistance(s, {});
    const lat = -(q.width / 2 + S.cliff.drop);
    const x = q.x + q.nx * lat, z = q.z + q.nz * lat;
    cliffEdge.push({ x, z, y: heightAt(x, z), nx: -q.nx, nz: -q.nz, s, progress: s / spline.length });
  }

  return {
    tiles, heightAt, normalAt, slopeAt, paintAt, blockOf, inBounds, cliffEdge, bounds: B, material,
    grid: { nx, nz, cell, x0: B.minX, z0: B.minZ, heights, paint, normals },
    spec: S, seaLevel: S.seaLevel,
  };
}
