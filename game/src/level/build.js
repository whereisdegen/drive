/**
 * DRIVE  src/level/build.js  (owner: level)
 *
 * Turns PLACEMENTS into the town: preloads every asset through ./assetlib.js (copied verbatim,
 * never edited), instances each placement, sits it on the terrain 4 cm deep, hands it to the
 * render module's applyMaterials, adds a contact fillet under every prop in FILLET_ASSETS,
 * registers colliders and the continuous house front walls, bakes static scenery per 30 m block
 * with bakeStatic, keeps movers (boats, buoys, spectator groups) live with keepHierarchy, applies
 * the tier density, publishes visibleAssets for telemetry, and checks the counts against the TSV.
 *
 * Hard rules kept here (BRIEF section 5 items 5, 9 and 11):
 *   - never scale a placed module to fit: the only transforms are position, rotation and a lean
 *   - a placement whose asset FILE does not exist is skipped with one console.warn per asset
 *     (assets land while the engine is built); an asset whose file exists but imports EMPTY
 *     throws, because that is the silent drop that cost Rust 17 three assets for four rounds
 *   - no primitive stands in for a missing asset, ever
 *
 * Signature (docs/ARCHITECTURE.md):
 *   buildLevel(THREE, { scene, world, terrain, spline, road, tier, onProgress })
 *     -> { blocks, movers, colliders, assetNames, counts, itemBoxAnchors, padAnchors, visibleAssets(camera) }
 * Extra optional inputs (documented in work/level/NOTES.md): assetBase (default './assets/'),
 * assetUrl(name) resolver, and a `materials` override for tests.
 */
import * as THREE from 'three';
import { ASSET, preloadAssets, bakeStatic } from '../../assetlib.js?v=r6-20260906191941';
import { applyMaterials as renderApplyMaterials } from '../render/materials.js?v=r6-20260906191941';
import { SIZES, COUNTS_EXPECTED, SINK, ITEM_BOXES, BOOST_PADS, countPlacements, nearest } from './placements.js?v=r6-20260906191941';
import { FILLET_ASSETS, makeFillet } from './fillets.js?v=r6-20260906191941';
import { levelPlacements, placementY, addPlacementCollider, addHouseWalls } from './colliders.js?v=r6-20260906191941';
import { stackCrowd, makeCrowdFront, FRONT_SPECS, seedOf } from './crowdrow.js?v=r6-20260906191941';

// Round 5 (targeted, crowd depth): every spectator_group is re seated as three card layers 0.3 m back and up
// (crowdrow.js stackCrowd, near instance and far copies alike), and a modelled front row of figures stands on the
// ground in front of every crowd run, and in front of a grandstand or cafe terrace within FRONT_STAND_DIST of the
// road (the quay grandstand stands behind the quay houses, 23 m from the road: no row there). The front rows ride
// the far tier 1 copy (90 to 200 m) and are dropped past 200 m, where a 1.6 m figure is 6 px and the cards behind it
// carry the crowd. Knobs: ?crowdstack=0 keeps the asset's flat layout, ?crowdfront=0 builds no figures (the A/Bs).
const FRONT_STAND_DIST = 22;
const FRONT_FAR_TIERS = 1;

const DEG2RAD = Math.PI / 180;
const BLOCK = 30, ORIGIN_X = -210, ORIGIN_Z = -190;
// Bake granularity (integrator, round 0): placements are keyed to the plan's 30 m blocks, but the
// static bake merges 2 x 2 of them (60 m). Measured on the integrated game (work/game/census2.mjs):
// 107 blocks of 30 m gave 1289 baked meshes with 866 in view from the piazza; the whole town is in
// view from three points of the lap, so finer blocks bought no culling and cost 3x the draws.
const BAKE_SPAN = 1;          // 30 m cells for the heavy surface buckets (integrator, round 1; was 3 = 90 m for everything)
const BAKE_SPAN_COARSE = 3;   // 90 m blocks for the light buckets (metal, fabric, foliage, cards, glass, lamps)
// The hybrid granularity, measured at the piazza exit (progress 0.505, desktop, camera plus shadow pass):
// 90 m blocks 2.26M tris / 716 calls, 60 m 1.73M / 800, 30 m 1.35M / 1019. Heavy buckets (stone, plaster,
// timber, tile, ground) carry about 85 percent of a block's triangles, the light ones about half of its
// draws, so the heavy buckets bake per 30 m cell and the light ones per 90 m block.
// Light buckets (measured at the same spot on 30 m cells, draws / triangles in view): the three ground sets
// (fillets, pads: 91 / 71k), the local projection variants and unnamed parts (glass, lamps, caps: 37 / 6k), cards,
// canvas (20 / 29k). Everything else (stone, plaster, timber, tile, metal, foliage) stays on the 30 m cells.
const LIGHT_SETS = new Set(['asphalt_worn', 'sand_beach', 'grass_dry', 'canvas_stripe', 'cobble_warm']);   // cobble_warm off the road: pads and kerb beds, 26 draws for 5k triangles
function lightBucket(m) {
  if (!m || Array.isArray(m)) return false;
  const u = m.userData || {};
  if (!u.triSet) return true;
  if (u.triLocal) return true;
  if (m.alphaTest > 0 || String(u.triSet).startsWith('card')) return true;   // cutout cards: 62 draws for 10k triangles at the hairpin exit
  return LIGHT_SETS.has(u.triSet);
}
function coarseKeyOf(fineKey) {
  const [k] = String(fineKey).split('~');   // the ~fine split is dropped: one coarse block per 90 m, always drawn
  const [bx, bz] = k.split('_').map(Number);
  const f = BAKE_SPAN_COARSE / BAKE_SPAN;
  return `c${Math.floor(bx / f)}_${Math.floor(bz / f)}`;
}
// Small props bake into a second group per block, named '#nocast' so the render rig dithers them out
// over the last 8 m before the tier's scatter distance (140 m high, 90 m phone) and main.js hides the
// group past it: "cull distance for small props", the budget lever ARCHITECTURE allows. Houses,
// landmarks, walls, kerbs, trees and cliffs stay in the coarse group at every distance.
const FINE_ASSETS = new Set(['street_lamp', 'harbour_bollard', 'produce_crate_stack', 'bougainvillea_card', 'agave_cluster', 'deck_chair',
  'beach_umbrella', 'tyre_wall', 'sign_chevron_board', 'sign_round_post', 'race_flag_pole', 'bunting_run', 'pit_toolcart', 'cafe_terrace',
  'market_stall', 'rock_boulder', 'results_podium', 'harbour_davit', 'pedalo', 'rowing_boat', 'grandstand_small', 'lifeguard_hut']);
function bakeKeyOf(block) {
  const [bx, bz] = String(block).split('_').map(Number);
  if (!Number.isFinite(bx) || !Number.isFinite(bz)) return String(block);
  return `${Math.floor(bx / BAKE_SPAN)}_${Math.floor(bz / BAKE_SPAN)}`;
}

// Far variants per bake block (round 3, critic item 100). The hairpin exit (progress 0.44 to 0.47, the whole town in
// view) drew 1.67M then 1.55M triangles against the 1.5M budget in rounds 1 and 2 after every asset trim there was.
// Every block is now baked once per tier: the near copy is the asset as shipped; a far copy is the same placement with
// every part whose largest dimension is under the tier's `part` dropped (rivets, brackets, bunting clips, balusters,
// crate lemons, lamp fittings: parts under 25 cm are 12 percent of the placed static triangles,
// work/fix3_level/partstats2.mjs) and no contact fillet (a 6 cm ground blend is a near detail by definition). A
// BlockLOD shows the copy whose tier the block box distance falls in, with hysteresis so a block on a line does not
// flicker. The tiers keep one angular size: 25 cm at 90 m, 50 cm at 200 m and 75 cm at 300 m are all under 3 px in
// the desktop frame, so a swap is not visible in a filmstrip. Measured at the hairpin exit worst case
// (work/game/pack.mjs, progress 0.445, the AI pack ahead): 1.511M without far copies, 1.388M with 90/25 cm and
// 200/40 cm, 1.355M with 200/50 cm, 1.333M with the 300/75 cm tier (work/fix3_level/tierprobe.log). Foliage and card materials never drop a part: a palm crown is a
// feature made of parts under 50 cm and would vanish as a whole (a per material share guard was tried first and cut
// the yield from 177k to 36k, so a 2 px hole in a far wall face is the accepted trade). No decimation, no segment
// change, nothing scaled: a part is either there or not. Parts are what the asset author made
// (the keepHierarchy load keeps them; the shipped merge welds them per material, which is why the far copies are
// built from a second, unmerged load and filtered once per asset and tier). Buckets a tier did not change share the
// near bucket's geometry, so the copies cost GPU memory only where they differ. Karts are not blocks and keep their
// silhouettes. Knobs: ?far=0 builds no far copies (the A/B), ?far=N shows tier N at every distance (to eyeball a drop).
const FAR_TIERS = [{ dist: 90, part: 0.25 }, { dist: 200, part: 0.50 }, { dist: 300, part: 0.75 }];   // one angular size, about 2.6 mrad (under 3 px on the desktop frame)
// probe knob (work/fix3_level): ?fartiers=90:0.25,200:0.5 overrides the tiers for one load
{ const m = typeof location !== 'undefined' && /(^|[?&])fartiers=([0-9.:,]+)/.exec(location.search); if (m) FAR_TIERS.splice(0, FAR_TIERS.length, ...m[2].split(',').map((t) => { const [d, q] = t.split(':').map(Number); return { dist: d, part: q }; })); }
const FAR_HYST = 0.06;
const _farCam = new THREE.Vector3();
class BlockLOD extends THREE.LOD {
  /** built with the near level only; the far copies arrive through addFar once the deferred build bakes them */
  constructor(near, box) {
    super();
    this.isBlockLOD = true;
    this.addLevel(near, 0);
    this.userData.box = box;
    this.tier = 0;
  }
  /** the next tier's copy (tier 1, then 2, ...); a tier with no copy for this block keeps the previous level */
  addFar(obj) {
    obj.visible = false;
    this.addLevel(obj, FAR_TIERS[this.levels.length - 1].dist);
  }
  /** the renderer calls this per frame (autoUpdate): the block box distance decides, not the LOD's own position */
  update(camera) {
    camera.getWorldPosition(_farCam);
    const box = this.userData.box;
    const d = box ? box.distanceToPoint(_farCam) : 0;
    const n = this.levels.length;
    let t = this.tier;
    if (BlockLOD.force >= 0) t = Math.min(BlockLOD.force, n - 1);
    else {
      // move one tier at a time, each line with its own hysteresis band
      while (t + 1 < n && d > this.levels[t + 1].distance * (1 + FAR_HYST)) t++;
      while (t > 0 && d < this.levels[t].distance * (1 - FAR_HYST)) t--;
    }
    if (t !== this.tier) {
      this.tier = t;
      for (let i = 0; i < n; i++) this.levels[i].object.visible = i === t;
    }
  }
}
BlockLOD.force = -1;   // -1 by distance, N: tier N everywhere (the ?far= knob)
/** largest world dimension of a mesh (every instance of an InstancedMesh), for the far part rule */
const _pb = new THREE.Box3(), _ps = new THREE.Vector3(), _pm = new THREE.Matrix4(), _pim = new THREE.Matrix4();
function partExtent(o) {
  const geo = o.geometry;
  if (!geo || !geo.attributes.position) return 0;
  if (!geo.boundingBox) geo.computeBoundingBox();
  let mx = 0;
  if (o.isInstancedMesh) {
    for (let i = 0; i < o.count; i++) {
      o.getMatrixAt(i, _pim);
      _pb.copy(geo.boundingBox).applyMatrix4(_pm.multiplyMatrices(o.matrixWorld, _pim));
      _pb.getSize(_ps); mx = Math.max(mx, _ps.x, _ps.y, _ps.z);
    }
    return mx;
  }
  _pb.copy(geo.boundingBox).applyMatrix4(o.matrixWorld);
  _pb.getSize(_ps);
  return Math.max(_ps.x, _ps.y, _ps.z);
}
const trisOfMesh = (o) => (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3 * (o.isInstancedMesh ? o.count : 1);
/**
 * The far prototypes of an asset, one per tier: the unmerged tree with every part under the tier's `part` removed
 * (guards above), each as { obj, dropped, total } in triangles. obj is the tree after the material pass and a per
 * material merge, done ONCE here: an unmerged tree is a few hundred parts and cloning it per placement cost 3.6 s of
 * level build (measured, work/fix3_level/NOTES.md); the merged prototype is about ten meshes, like the shipped ASSET()
 * merge, and its clones share the vertexised geometry and the set materials. A tier that drops nothing gets the
 * plain merged prototype after the same material pass. Of the per placement paints only the kerb's reaches this path
 * (the same colours on every kerb, so it runs on the prototype); the painted boats are movers and have no far copy.
 */
async function farPrototypes(url, asset, materials) {
  const tree = await ASSET(url, { surfaces: false, keepHierarchy: true });
  tree.updateMatrixWorld(true);
  const parts = [];
  let total = 0;
  tree.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
    const name = (o.material && !Array.isArray(o.material) && o.material.name) || '';
    const tris = trisOfMesh(o);
    total += tris;
    parts.push({ o, tris, extent: partExtent(o), keep: name === 'foliage' || String(name).startsWith('card') });   // crowns and cards are features of parts
  });
  if (asset === 'kerb_module') paintKerb(THREE, tree);   // the kerb paint is per instance on the near path but the same for every kerb
  materials(tree, { asset, local: false, unify: false });
  const out = [];
  let base = null;   // the merged prototype of the last tier that dropped nothing, shared by every such tier
  for (const tier of FAR_TIERS) {
    let dropped = 0;
    const drop = parts.filter((q) => !q.keep && q.extent < tier.part);
    for (const q of drop) dropped += q.tris;
    if (!drop.length) {
      // nothing to drop at this tier: the prototype takes the near path exactly (shipped merge, then the material pass)
      // so its block buckets match the near buckets vertex for vertex and share their geometry
      if (!base) { base = await ASSET(url, { surfaces: false }); if (asset === 'kerb_module') paintKerb(THREE, base); materials(base, { asset, local: false, unify: false }); }
      out.push({ obj: base, dropped, total, plain: true }); continue;
    }
    const dropSet = new Set(drop.map((q) => q.o));
    const copy = tree.clone(true);   // the tiers are nested (a bigger part threshold drops a superset), each from the whole tree
    const rm = [];
    const srcList = [], dstList = [];
    tree.traverse((n) => srcList.push(n)); copy.traverse((n) => dstList.push(n));
    srcList.forEach((n, k) => { if (dropSet.has(n)) rm.push(dstList[k]); });
    for (const o of rm) o.removeFromParent();
    out.push({ obj: bakeStatic(copy), dropped, total, plain: false });
  }
  return out;
}
/** a far bucket that a tier did not change takes the near bucket's geometry (same material, same size) */
function shareUnchanged(near, far) {
  const byMat = new Map();
  near.traverse((o) => { if (o.isMesh && o.geometry) { const k = o.material; if (!byMat.has(k)) byMat.set(k, []); byMat.get(k).push(o); } });
  let shared = 0;
  far.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const cands = byMat.get(o.material) || [];
    const n = o.geometry.attributes.position.count, ni = o.geometry.index ? o.geometry.index.count : -1;
    const hit = cands.find((c) => c.geometry.attributes.position.count === n && (c.geometry.index ? c.geometry.index.count : -1) === ni);
    if (hit && hit.geometry !== o.geometry) { o.geometry.dispose(); o.geometry = hit.geometry; shared++; }
  });
  return shared;
}

function stamp(url) {
  const v = typeof window !== 'undefined' ? window.__BUILD_STAMP__ : null;
  return v ? `${url}?v=${v}` : url;
}
function meshCount(obj) {
  let n = 0;
  obj.traverse((o) => { if (o.isMesh && o.geometry && o.geometry.attributes.position && o.geometry.attributes.position.count > 0) n++; });
  return n;
}
/** does the asset module exist at all: a 404 is "not landed yet", anything else is "present" */
async function exists(url) {
  try {
    const r = await fetch(url, { method: 'GET', cache: 'force-cache' });
    return r.ok;
  } catch (e) { return false; }
}
export async function buildLevel(THREE_, opts) {
  const { scene, world, terrain, spline, road, tier, onProgress } = opts;
  const T = THREE_ || THREE;
  const applyMaterials = opts.materials && opts.materials.applyMaterials ? opts.materials.applyMaterials : renderApplyMaterials;
  const assetBase = opts.assetBase || './assets/';
  const assetUrl = opts.assetUrl || ((name) => `${assetBase}${name}.js`);
  const density = typeof tier === 'object' && tier ? (tier.density ?? 1) : (tier === 'phone' ? 0.5 : 1);
  const heightAt = terrain && terrain.heightAt ? (x, z) => terrain.heightAt(x, z) : () => 0;
  const paintAt = terrain && terrain.paintAt ? (x, z) => terrain.paintAt(x, z) : () => 'grass';
  const progress = (f, label) => { if (onProgress) onProgress(Math.max(0, Math.min(1, f)), label); };

  // 1. the list (shared with src/level/colliders.js, which the verification oracle builds from)
  const list = levelPlacements({ spline, road, terrain, density });
  const names = [...new Set(list.map((p) => p.asset))].sort();

  // 2. which assets have landed
  progress(0.02, 'checking assets');
  const present = new Set(), missing = new Set();
  await Promise.all(names.map(async (n) => { (await exists(stamp(assetUrl(n))) ? present : missing).add(n); }));
  for (const n of [...missing].sort()) {
    const k = list.filter((p) => p.asset === n).length;
    console.warn(`[level] asset not landed yet: ${n} (${k} placements skipped, no stand in)`);
  }
  const staticNames = names.filter((n) => present.has(n) && !list.some((p) => p.asset === n && p.moving));
  progress(0.05, 'preloading assets');
  await preloadAssets(staticNames.map((n) => stamp(assetUrl(n))));

  // 3. instance and place
  const blockGroups = new Map();     // key -> Group being filled
  const blockNames = new Map();      // key -> Set of asset names
  const blockBoxes = new Map();      // key -> Box3 in world space
  const movers = [];
  const counts = new Map();
  const assetNames = new Set();
  let colliders = 0;
  const emptyChecked = new Set();
  const tmpBox = new T.Box3();

  const groupFor = (key) => {
    let g = blockGroups.get(key);
    if (!g) { g = new T.Group(); g.name = 'block_' + key; blockGroups.set(key, g); blockNames.set(key, new Set()); blockBoxes.set(key, new T.Box3()); }
    return g;
  };
  const addCollider = (p, size, y) => { colliders += addPlacementCollider(T, world, p, size, y); };

  // far copies: desktop tier only (the phone tier passes the triangle budget at 950k and its memory is the scarcer
  // resource); ?far=0 switches them off for the A/B, ?far=N forces tier N at every distance
  const qs = typeof location !== 'undefined' ? location.search : '';
  const farKnob = /(^|[?&])far=(-?\d)/.exec(qs);
  const tierName = typeof tier === 'object' && tier ? tier.name : tier;
  const farOn = opts.farVariant !== undefined ? !!opts.farVariant : (farKnob ? farKnob[2] !== '0' : tierName !== 'phone');
  BlockLOD.force = farKnob ? +farKnob[2] : -1;   // far=0 builds none, far=N forces tier N
  const placed = [];   // { p, y, url, bakeKey } of every static placement, for the deferred far build
  const fronts = [];   // { row, bakeKey } of every generated front row, cloned into the far tier 1 groups
  const crowdStack = !/(^|[?&])crowdstack=0/.test(qs), crowdFront = !/(^|[?&])crowdfront=0/.test(qs);
  let stacked = 0, frontRows = 0, frontFigures = 0;
  const place = (obj, p, y, materials = true) => {
    obj.position.set(p.x, y, p.z);
    obj.rotation.set(0, p.rot * DEG2RAD, 0);
    if (p.tilt) {
      // a lean, never a scale: rotate about a horizontal axis chosen from the placement's own rotation
      const lean = p.tilt * DEG2RAD, dir = (p.rot * 0.7 + p.x * 0.31 + p.z * 0.17) % (Math.PI * 2);
      obj.rotateOnWorldAxis(new T.Vector3(Math.cos(dir), 0, Math.sin(dir)), lean);
    }
    obj.name = p.tag;
    obj.userData.asset = p.asset;
    // unify stays OFF for movers too (integrator, round 0): with unify the spectator groups' crowd cards took
    // the asset's dominant set and rendered as opaque black squares at the lower street and the piazza
    // (rounds/r0 finish run frames 1 and 2)
    if (!materials) return;   // a far copy cloned from a prototype that already went through the material pass
    if (p.asset === 'kerb_module') paintKerb(T, obj);
    if (p.paint) paintHull(T, obj, p.paint);
    applyMaterials(obj, { asset: p.asset, local: !!p.moving, unify: false });
  };

  const n = list.length;
  for (let i = 0; i < n; i++) {
    const p = list[i];
    if (i % 40 === 0) progress(0.08 + 0.72 * (i / n), `placing ${p.asset}`);
    if (missing.has(p.asset)) continue;
    const size = SIZES[p.asset];
    const url = stamp(assetUrl(p.asset));
    let obj = await ASSET(url, { surfaces: false, keepHierarchy: !!p.moving });
    if (meshCount(obj) === 0) {
      // the file exists (checked above) and still produced nothing: this is the silent drop, so it is a hard failure
      throw new Error(`[level] asset ${p.asset} imported EMPTY from ${url}: refusing to build a town with a hole in it`);
    }
    emptyChecked.add(p.asset);
    // height
    const y = placementY(p, heightAt);
    place(obj, p, y);
    if (p.asset === 'spectator_group' && crowdStack && stackCrowd(T, obj, seedOf(p.x, p.z), p.end || 0)) stacked++;
    counts.set(p.asset, (counts.get(p.asset) || 0) + 1);
    assetNames.add(p.asset);
    addCollider(p, size, y);

    if (p.moving) {
      // Movers bob as a whole (no joint is animated here), so each instance is merged per material
      // through assetlib's bakeStatic in its own local frame (integrator, round 0: 38 movers were 747
      // meshes and 693 draws from the piazza; now about one draw per material per mover).
      if (!/(^|[?&])nomoverbake=1/.test(typeof location !== 'undefined' ? location.search : '')) obj = bakeMover(T, obj);   // ?nomoverbake=1 is the A/B knob
      obj.name = p.tag;
      obj.userData.asset = p.asset;
      obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      scene.add(obj);
      const bob = p.bob || { amp: 0.05, period: 2.5, roll: 1, pitch: 0.5, phase: 0 };
      const baseY = y, baseRot = p.rot * DEG2RAD;
      let t = bob.phase || 0;
      movers.push({
        asset: p.asset, object: obj, tag: p.tag, x: p.x, z: p.z,
        update(dt) {
          t += dt;
          const w = (Math.PI * 2) / (bob.period || 2.5);
          obj.position.y = baseY + (bob.amp || 0) * Math.sin(t * w);
          obj.rotation.set((bob.pitch || 0) * DEG2RAD * Math.sin(t * w * 0.71 + 1.3), baseRot, (bob.roll || 0) * DEG2RAD * Math.sin(t * w * 0.53));
        },
      });
      continue;
    }

    const bakeKey = bakeKeyOf(p.block) + (FINE_ASSETS.has(p.asset) ? '~fine' : '');
    const g = groupFor(bakeKey);
    g.add(obj);
    blockNames.get(bakeKey).add(p.asset);
    // fillet under props that stand on the terrain (never under things at an absolute y: boats, bunting, cliff rocks; a road station y counts as ground)
    let fillet = null;
    const spec = FILLET_ASSETS[p.asset];
    if (spec && (p.y === null || p.onGround)) {
      fillet = makeFillet(p, [size[0], size[1]], spec, heightAt, paintAt(p.x, p.z));
      if (fillet) { applyMaterials(fillet, { asset: 'fillet' }); g.add(fillet); }
    }
    // the modelled front row on the ground in front of a crowd, a near grandstand or a cafe terrace (crowdrow.js)
    const fspec = crowdFront && typeof p.y !== 'number' ? frontSpecFor(p) : null;
    if (fspec) {
      const rr = p.rot * DEG2RAD, cr = Math.cos(rr), sr = Math.sin(rr);
      const groundY = (lx, lz) => heightAt(p.x + lx * cr + lz * sr, p.z - lx * sr + lz * cr) - SINK - y;
      // the figures take the heavy set the host asset itself draws in this cell (the c2 crowd's timber step: 'timber_painted'),
      // so they merge into a bucket the block already has: 0 extra draws (measured at the hairpin exit: a bucket of their
      // own cost 5 to 7 there), and a 30 m cell casts from every bucket, so they throw contact shadows
      const row = makeCrowdFront(T, fspec, seedOf(p.x, p.z) ^ 0x5bd1e995, groundY, p.end || 0, heavySetOf(obj) || 'metal');
      row.position.set(p.x, y, p.z);
      row.rotation.set(0, rr, 0);
      row.name = p.tag + '_front';
      row.userData.asset = p.asset;
      applyMaterials(row, { asset: 'crowd_front', local: false, unify: false });
      g.add(row);
      fronts.push({ row, bakeKey });
      frontRows++; frontFigures += row.children.length;
    }
    if (farOn) placed.push({ p, y, url, bakeKey });   // the far copies of this placement are built after level ready (step 9)
  }
  if (stacked || frontRows) console.log(`[level] crowd depth: ${stacked} spectator groups layered (per layer size 0.9 to 1.1 and mirror; a flat three card asset is re seated 0.3 m back and up per layer), ${frontRows} modelled front rows with ${frontFigures} figures`);

  // 4. house front walls as continuous collision segments
  colliders += addHouseWalls(T, world, heightAt);

  // 5a. hybrid granularity: move every light bucket mesh (world transform kept) from its 30 m cell group
  // into the 90 m block group, so the heavy buckets cull finely and the light ones do not multiply draws
  if (BAKE_SPAN_COARSE > BAKE_SPAN) {
    for (const [key, g] of [...blockGroups]) {
      if (key.startsWith('c')) continue;
      g.updateMatrixWorld(true);
      const move = [];
      g.traverse((o) => { if (o.isMesh && lightBucket(o.material)) move.push(o); });
      if (!move.length) continue;
      const ck = coarseKeyOf(key);
      const cg = groupFor(ck);
      for (const m of move) cg.attach(m);
      for (const n of blockNames.get(key)) blockNames.get(ck).add(n);
    }
  }

  // 5. bake per block
  progress(0.82, 'baking blocks');
  const blocks = new Map();
  let k = 0;
  const bakeGroup = (g, key) => {
    g.updateMatrixWorld(true);
    let empty = true; g.traverse((o) => { if (o.isMesh && o.geometry && o.geometry.attributes.position && o.geometry.attributes.position.count > 0) empty = false; });
    if (empty) return null;   // a cell whose every mesh moved to the coarse block
    const baked = bakeStatic(g);
    // a coarse (light bucket) block casts only from its cards (bunting, crowds, fronds) and canvas awnings:
    // fillets, pads, glass, lamp heads and caps have no shadow anyone can see (23 calls and 67k triangles
    // of shadow pass at the piazza exit); the 30 m cells cast from every bucket
    const coarse = key.startsWith('c');
    baked.traverse((o) => {
      if (!o.isMesh) return;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      const u = (m && m.userData) || {};
      o.castShadow = !coarse || (m && m.alphaTest > 0) || u.triSet === 'canvas_stripe';
      o.receiveShadow = true;
    });
    return baked;
  };
  for (const [key, g] of blockGroups) {
    const baked = bakeGroup(g, key);
    if (!baked) continue;
    // (no '#nocast' suffix: the rig's dithered fade variant of a CARD material dropped its alpha test and
    // the standalone bougainvillea cards drew as 3 x 4 m black squares; main.js hides the fine group by
    // distance instead, and a pop at 140 m on props under 2 m is not visible)
    baked.name = 'block_' + key + (key.endsWith('~fine') ? '_fine' : '');
    tmpBox.setFromObject(baked);
    blockBoxes.get(key).copy(tmpBox);
    // behind a BlockLOD when far copies are on: the far twins of this block arrive from the deferred build
    let node = baked;
    if (farOn) { node = new BlockLOD(baked, tmpBox.clone()); node.name = 'lod_' + key; }
    node.userData.fine = key.endsWith('~fine');
    node.userData.block = key;
    node.userData.assets = [...blockNames.get(key)];
    node.userData.box = tmpBox.clone();
    scene.add(node);
    blocks.set(key, node);
    if ((++k) % 8 === 0) progress(0.82 + 0.15 * (k / blockGroups.size), 'baking blocks');
  }

  // 6. anchors for items
  const itemBoxAnchors = ITEM_BOXES.map((b) => ({ x: b.x, y: (typeof b.y === 'number' ? b.y : heightAt(b.x, b.z)) + 0.5, z: b.z }));
  const padAnchors = BOOST_PADS.map((b) => ({ x: b.x, y: heightAt(b.x, b.z), z: b.z, rot: b.rot * DEG2RAD }));

  // 7. counts against the TSV (the rule sets are the truth; a 20% gap is logged, never fatal)
  const expected = COUNTS_EXPECTED;
  const planned = countPlacements(list);
  const lines = [];
  for (const [name, exp] of Object.entries(expected)) {
    if (!exp && !planned.get(name)) continue;
    const got = counts.get(name) || 0, plan = planned.get(name) || 0;
    const off = exp ? Math.abs(plan - exp) / exp : 0;
    if (missing.has(name) && plan) lines.push(`${name}: 0 placed of ${plan} planned (asset not landed)`);
    else if (off > 0.2 && plan) lines.push(`${name}: ${got} placed, TSV ${exp} (${Math.round(off * 100)}% off, rule set is the truth)`);
  }
  if (lines.length) console.warn('[level] counts vs docs/OBJECTS.tsv:\n  ' + lines.join('\n  '));
  console.log(`[level] placed ${[...counts.values()].reduce((a, b) => a + b, 0)} objects of ${assetNames.size} assets in ${blocks.size} blocks, ${movers.length} movers, ${colliders} colliders, ${missing.size} assets missing`);

  // 8. visibility for telemetry: asset names in the frustum within 40 m (block boxes and mover positions)
  const frustum = new T.Frustum(), pm = new T.Matrix4(), sph = new T.Sphere(), camPos = new T.Vector3();
  function visibleAssets(camera) {
    if (!camera) return [];
    camera.updateMatrixWorld();
    pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(pm);
    camera.getWorldPosition(camPos);
    const out = new Set();
    for (const [key, b] of blocks) {
      const box = b.userData.box;
      if (!box || box.isEmpty()) continue;
      if (box.distanceToPoint(camPos) > 40) continue;
      if (!frustum.intersectsBox(box)) continue;
      for (const nme of b.userData.assets) out.add(nme);
      void key;
    }
    for (const m of movers) {
      const d = Math.hypot(m.object.position.x - camPos.x, m.object.position.z - camPos.z);
      if (d > 40) continue;
      sph.set(m.object.position, 2.5);
      if (frustum.intersectsSphere(sph)) out.add(m.asset);
    }
    return [...out];
  }

  progress(1, 'level ready');

  // 9. the far copies, built AFTER the level is ready in time slices between frames (round 3): built inline they
  // cost 1.2 s of the 8 s ready budget (7.8 s measured on 4G in the round 3 gate); a block needs its far copy only
  // once the camera is 90 m from it, which is several seconds after the countdown, and until then the BlockLOD keeps
  // drawing the near copy. Order: prototypes per asset (a second, unmerged load filtered per tier, the material pass
  // and a merge, once per asset), the copies per placement into per tier groups under the near block's key, the
  // light bucket hoist per tier, then one bake per block and tier attached to the block's BlockLOD. `far.done`
  // turns true at the end (probes wait on it); a failure is logged and leaves every block on its near copy.
  const far = { on: farOn, done: !farOn, error: null, tiers: FAR_TIERS.map((t) => ({ ...t })), dropped: FAR_TIERS.map(() => 0), total: 0, blocks: 0, shared: 0 };
  if (farOn) far.promise = buildFarDeferred();
  async function buildFarDeferred() {
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const SLICE = 6;   // ms of far work per frame
    let t0 = now();
    const yieldFrame = () => new Promise((r) => { if (typeof requestAnimationFrame === 'function' && !(typeof document !== 'undefined' && document.hidden)) requestAnimationFrame(() => r()); else setTimeout(r, 0); });
    const slice = async () => { if (now() - t0 > SLICE) { await yieldFrame(); t0 = now(); } };
    // start only once the game reports ready (main.js sets window.__READY__ after the karts, items and audio): the
    // first slices otherwise interleave with the rest of the boot (round 3 gate run 3: karts and ready phases +370 ms)
    for (let waited = 0; typeof window !== 'undefined' && !window.__READY__ && waited < 600; waited++) await yieldFrame();
    const tStart = now();
    let work = 0;
    try {
      // a. prototypes per asset
      const protos = new Map();
      for (const name of [...new Set(placed.map((e) => e.p.asset))]) {
        const w0 = now();
        protos.set(name, await farPrototypes(stamp(assetUrl(name)), name, applyMaterials));
        work += now() - w0;
        await slice();
      }
      // b. the copies per placement, per tier
      const farGroups = FAR_TIERS.map(() => new Map());
      const farGroupFor = (ti, key) => {
        let g = farGroups[ti].get(key);
        if (!g) { g = new T.Group(); g.name = `far${ti + 1}_` + key; farGroups[ti].set(key, g); }
        return g;
      };
      let i = 0;
      for (const e of placed) {
        const w0 = now();
        const fps = protos.get(e.p.asset);
        for (let ti = 0; ti < FAR_TIERS.length; ti++) {
          const fp = fps[ti];
          const objF = fp.obj.clone(true);
          far.dropped[ti] += fp.dropped; if (ti === 0) far.total += fp.total;
          place(objF, e.p, e.y, false);
          if (e.p.asset === 'spectator_group' && crowdStack) stackCrowd(T, objF, seedOf(e.p.x, e.p.z), e.p.end || 0);   // the same layers as the near instance
          farGroupFor(ti, e.bakeKey).add(objF);
          // no fillet in a far copy: a contact blend 6 cm high is a near detail by definition (the ground sets were
          // 75k triangles in the hairpin exit view, most of them past 90 m); the far prop still sits 4 cm into the ground
        }
        work += now() - w0;
        if ((++i) % 16 === 0) await slice();
      }
      // the front rows ride the first far tier(s) as clones (shared geometry and materials), then drop
      for (const f of fronts) {
        const w0 = now();
        for (let ti = 0; ti < Math.min(FRONT_FAR_TIERS, FAR_TIERS.length); ti++) farGroupFor(ti, f.bakeKey).add(f.row.clone(true));
        work += now() - w0;
        if ((++i) % 16 === 0) await slice();
      }
      // c. the light bucket hoist, the same split as the near blocks so every far twin sits under the near key
      if (BAKE_SPAN_COARSE > BAKE_SPAN) {
        for (let ti = 0; ti < FAR_TIERS.length; ti++) {
          for (const [key, g] of [...farGroups[ti]]) {
            if (key.startsWith('c')) continue;
            const w0 = now();
            g.updateMatrixWorld(true);
            const move = [];
            g.traverse((o) => { if (o.isMesh && lightBucket(o.material)) move.push(o); });
            if (move.length) { const cg = farGroupFor(ti, coarseKeyOf(key)); for (const m of move) cg.attach(m); }
            work += now() - w0;
            await slice();
          }
        }
      }
      // d. one bake per block and tier, attached to the block's BlockLOD (never a caster: past 90 m is past castDist)
      for (const [key, node] of blocks) {
        if (!node.isBlockLOD) continue;
        const near = node.levels[0].object;
        for (let ti = 0; ti < FAR_TIERS.length; ti++) {
          const fg = farGroups[ti].get(key);
          const w0 = now();
          const baked = fg ? bakeGroup(fg, key) : null;
          if (!baked) { work += now() - w0; break; }   // nothing of this block at this tier: the previous level stays
          baked.name = near.name + '_far' + (ti + 1);
          baked.traverse((o) => { if (o.isMesh) o.castShadow = false; });
          far.shared += shareUnchanged(near, baked);
          node.addFar(baked);
          work += now() - w0;
          await slice();
        }
        if (node.levels.length > 1) far.blocks++;
      }
      far.workMs = Math.round(work); far.elapsedMs = Math.round(now() - tStart);
      console.log(`[level] far variants of ${Math.round(far.total / 1000)}k placed static triangles: ` + FAR_TIERS.map((t, ti) => `${Math.round(far.dropped[ti] / 1000)}k dropped past ${t.dist} m (parts under ${t.part} m)`).join(', ') + `; no fillets past ${FAR_TIERS[0].dist} m; ${far.blocks} of ${blocks.size} blocks carry far copies, ${far.shared} unchanged far buckets share the near geometry; ${far.workMs} ms of work over ${far.elapsedMs} ms after level ready`);
    } catch (e) {
      far.error = e;
      console.error('[level] far variants FAILED, every block stays on its near copy:', e && e.message ? e.message : e);
    }
    far.done = true;
  }

  return { blocks, movers, colliders, assetNames, counts, itemBoxAnchors, padAnchors, visibleAssets, missing, placements: list, far };
}

/** the first heavy (30 m cell) set a placed instance draws, after its material pass: the crowd's figures join that bucket */
function heavySetOf(obj) {
  let found = null;
  obj.traverse((o) => {
    if (found || !o.isMesh || !o.material || Array.isArray(o.material)) return;
    const u = o.material.userData || {};
    if (u.triSet && !String(u.triSet).startsWith('card') && !u.triLocal && !LIGHT_SETS.has(u.triSet) && !(o.material.alphaTest > 0)) found = u.triSet;
  });
  return found;
}
/** the front row spec for a placement, or null: crowds unless the placement says front: false, stands and cafes near the road */
function frontSpecFor(p) {
  if (p.asset === 'spectator_group') return p.front === false ? null : FRONT_SPECS.spectator_group;
  if (FRONT_SPECS[p.asset]) { const n = nearest(p.x, p.z); return n && n.dist < FRONT_STAND_DIST ? FRONT_SPECS[p.asset] : null; }
  return null;
}

/**
 * Kerb paint, per instance, BEFORE applyMaterials bakes colour into the vertices (the same route
 * kartview.js takes for the liveries). Round 1 critic: "kerb red should be hue 0, saturation 0.6 or
 * more, white luma 230 or more; in sun the red reads salmon and in shade maroon", and claim 3's
 * kerbRW counted only 3 of 8 frames. Measured on a lit kerb before this change (work/fix1_level,
 * shot at progress 0.125): red hue 8 sat 0.81 luma 76, white luma 173 sat 0.25, so the WHITE blocks
 * never met the metric's white (luma over 200, saturation under 0.20): whitewash 0xf1e6d2 under the
 * warm sun is cream. What the level can do about it:
 *   - the white stripes become a neutral near white (about 0xf1efec body, 0xf8f7f5 top, saturation 0.03,
 *     still not pure white) so the sun's warmth lands them under 0.20 where the fill reaches them; measured
 *     after: white saturation 0.07 to 0.14 in frame (was 0.25)
 *   - the red stripes turn to hue 4, saturation about 0.75, a shade lighter (about 0xea4438 body) so the
 *     sun does not push them salmon and the shade does not crush them to maroon; measured after: hue 353 to
 *     356, saturation 0.82 in frame (was hue 8, and salmon or maroon by the critic's eye)
 *   - both are renamed 'metal' (the painted set: a flat painted albedo with a specular highlight at
 *     roughness 0.45) instead of 'stone' (the dressed masonry set with its albedo variation): a
 *     painted kerb block is glossy paint on concrete, and the highlight is what lifts the sunlit
 *     faces toward the bar's glossy kerbs
 * The stone strip, the base band and the joint bed keep the asset's stone. Materials are cloned per
 * instance because ASSET() shares them across instances of the prototype.
 */
const _kc = { c: null };
function paintKerb(T, obj) {
  if (!_kc.c) _kc.c = new T.Color();
  const c = _kc.c, cloned = new Map();
  obj.traverse((o) => {
    if (!o.isMesh || !o.material || !o.material.color) return;
    let m = cloned.get(o.material);
    if (!m) {
      const src = o.material;
      c.copy(src.color).convertLinearToSRGB();
      const max = Math.max(c.r, c.g, c.b), min = Math.min(c.r, c.g, c.b);
      const sat = max > 0 ? (max - min) / max : 0;
      const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
      let hue = 0;
      if (max > min) { const d = max - min; hue = max === c.r ? 60 * (((c.g - c.b) / d + 6) % 6) : max === c.g ? 60 * ((c.b - c.r) / d + 2) : 60 * ((c.r - c.g) / d + 4); }
      const red = (hue < 25 || hue > 335) && sat > 0.5 && lum > 0.25;
      const white = sat < 0.2 && lum > 0.78;
      if (!red && !white) { cloned.set(src, src); return; }
      m = src.clone();
      // keep the part's own value (the top is bleached, the chamfer a shade lighter) and replace hue and saturation
      // red: hue 4, HSV saturation about 0.75, lightness lifted 12 percent (a saturated red has a low luma by
      // construction, 0.2126 R + 0.7152 G + 0.0722 B; the metric's red needs luma over 50 in the frame, and the
      // measured in frame red was 42 to 50 at the darker value). white: HSV saturation 0.03, lightness 0.93 to 0.97.
      // round 2: HSL saturation 0.92 and lightness 0.48 to 0.58 (was 0.80 and 0.52 to 0.62). Under the round 2 rig the
      // red stripes read HSV saturation p50 0.56 to 0.60 in frame (fix_level_3/5/7, 12 to 13k kerb pixels a frame, half of
      // them under the bar's 0.6): the warm sun and the fill add green and blue to a light red faster than to a deep one
      if (red) m.color.setHSL(4 / 360, 0.92, Math.min(0.58, Math.max(0.48, 0.5 * (max + min) * 1.04)), T.SRGBColorSpace);
      else m.color.setHSL(40 / 360, 0.14, Math.min(0.97, Math.max(0.93, 0.5 * (max + min) * 1.07)), T.SRGBColorSpace);
      m.name = 'metal';
      m.roughness = 0.45; m.metalness = 0.06;
      cloned.set(src, m);
    }
    if (m !== o.material) o.material = m;
  });
}

/**
 * Painted boats (round 2, critic item 5: "painted boats" among the saturated objects the bar has and the
 * build lacked). Per instance, before applyMaterials, the same route as paintKerb and the kart liveries:
 * every material of the boat in the asset's timber teal family (hue 165 to 195, saturation over 0.3: the
 * hull planks, their dark band, edge strip and top) is cloned and moved to the livery hue and saturation
 * of `hex` (a style lock livery colour, placements.BOAT_PAINT), keeping the part's own lightness offset
 * from the base teal so the painted edge and the base band survive. Gunwale, boot top, deck, wheelhouse,
 * rope and iron keep the asset's colours and names. Materials are cloned because ASSET() shares them
 * between the instances of a prototype.
 */
const _hp = { c: null, t: null, hsl: { h: 0, s: 0, l: 0 }, thsl: { h: 0, s: 0, l: 0 }, base: { h: 0, s: 0, l: 0 } };
function paintHull(T, obj, hex) {
  if (!_hp.c) { _hp.c = new T.Color(); _hp.t = new T.Color(); }
  const c = _hp.c, t = _hp.t, cloned = new Map();
  t.setHex(hex, T.SRGBColorSpace); t.getHSL(_hp.thsl, T.SRGBColorSpace);
  c.setHex(0x3f8f8a, T.SRGBColorSpace); c.getHSL(_hp.base, T.SRGBColorSpace);
  obj.traverse((o) => {
    if (!o.isMesh || !o.material || Array.isArray(o.material) || !o.material.color) return;
    let m = cloned.get(o.material);
    if (!m) {
      const src = o.material;
      src.color.getHSL(_hp.hsl, T.SRGBColorSpace);
      const hue = _hp.hsl.h * 360;
      const teal = hue > 165 && hue < 195 && _hp.hsl.s > 0.3;
      if (!teal) { cloned.set(src, src); return; }
      m = src.clone();
      m.color.setHSL(_hp.thsl.h, _hp.thsl.s, Math.min(0.85, Math.max(0.12, _hp.thsl.l + (_hp.hsl.l - _hp.base.l))), T.SRGBColorSpace);
      cloned.set(src, m);
    }
    if (m !== o.material) o.material = m;
  });
}

/** block key helper shared with telemetry (TRACK-PLAN section 10) */
/** Merge a mover instance per material in its local frame; the returned group carries the same transform. */
function bakeMover(T, obj) {
  const pos = obj.position.clone(), quat = obj.quaternion.clone(), scl = obj.scale.clone();
  const ud = obj.userData;
  obj.position.set(0, 0, 0); obj.quaternion.identity(); obj.scale.set(1, 1, 1);
  obj.updateMatrixWorld(true);
  let baked;
  try { baked = bakeStatic(obj); } catch (e) { console.warn('[level] mover bake failed, kept live:', e && e.message); baked = null; }
  if (!baked || meshCount(baked) === 0) { obj.position.copy(pos); obj.quaternion.copy(quat); obj.scale.copy(scl); return obj; }
  baked.position.copy(pos); baked.quaternion.copy(quat); baked.scale.copy(scl);
  baked.userData = Object.assign({}, ud, baked.userData);
  return baked;
}
export function blockKey(x, z) { return `${Math.floor((x - ORIGIN_X) / BLOCK)}_${Math.floor((z - ORIGIN_Z) / BLOCK)}`; }
