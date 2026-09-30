/**
 * DRIVE  main.js  (owner: game)
 *
 * The integrator. Builds the game in the order docs/ARCHITECTURE.md gives and runs the loop:
 *
 *   1 tier, renderer, screens (loading shown)
 *   2 materials and the sky panorama in parallel (the sky's atmosphere fit feeds the rig); the asset
 *     modules are warmed into the module map and the track GEOMETRY (spline, road, terrain, world) is
 *     built on the CPU while those bytes arrive
 *   3 the lighting rig
 *   4 the track surfaces (road and terrain materials) and the sea
 *   5 the level (placements, fillets, per block bake) with progress to the loading bar
 *   6 eight karts (bodies and views), chase camera, player, keyboard, touch, seven AI and the director
 *   7 items, HUD, minimap, audio (constructed, NOT started), race, post
 *   8 rig.refresh, karts to the grid, camera snap, window.__READY__, window.__START__, Screens.ready
 *   9 start (the button, Enter, or __START__): audio.start, music, race.start
 *  10 the loop: dt clamped to 0.05 for simulation, fps from the real elapsed time; update order
 *     input -> player -> AI -> director -> bodies -> bumps -> items -> race -> views -> movers ->
 *     chase -> rig -> sea -> sky -> post -> HUD and minimap -> audio -> telemetry
 *  11 finish: results screen; RACE AGAIN resets everything and shows the start screen again
 *
 * Query switches (the gate and the photograph tool use them): ?q=high|phone tier, ?strict=1 turns
 * every silently missing asset or audio file into a console.error (the gate treats that as a
 * failure), ?laps=N shortens the race (laps=1 is the forced finish check), ?drop=1 drives the
 * player off the cliff road 1.5 s after GO (the respawn check), ?sky=0 is the render module's
 * analytic sky A/B. Debug entries: window.__START__(), window.__PAUSE__(on),
 * window.__DBG__.teleport(progress) / drop() / finish().
 *
 * Everything loads relative to game/: this file must work untouched under /drive/game/ on Pages.
 * Plain hyphens only in every string.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { detectTier, getTier, applyTierToRenderer } from './src/render/quality.js?v=r6-20260906191941';
import { preloadMaterials, applyRoadMaterial, applyTerrainMaterial } from './src/render/materials.js?v=r6-20260906191941';
import { createSky } from './src/render/sky.js?v=r6-20260906191941';
import { createLightingRig } from './src/render/lighting.js?v=r6-20260906191941';
import { createPost } from './src/render/post.js?v=r6-20260906191941';
import { SPLINE, START_PROGRESS, CHECKPOINTS, LAP_LENGTH } from './src/track/spline.js?v=r6-20260906191941';
import { buildRoad } from './src/track/road.js?v=r6-20260906191941';
import { buildTerrain } from './src/track/terrain.js?v=r6-20260906191941';
import { buildSea } from './src/track/sea.js?v=r6-20260906191941';
import { World } from './src/track/collision.js?v=r6-20260906191941';
import { buildLevel } from './src/level/build.js?v=r6-20260906191941';
import { GRID, PLACEMENTS } from './src/level/placements.js?v=r6-20260906191941';
import { KartBody, resolveBumps } from './src/kart/physics.js?v=r6-20260906191941';
import { Player } from './src/kart/player.js?v=r6-20260906191941';
import { KartView } from './src/kart/kartview.js?v=r6-20260906191941';
import { ChaseCamera } from './src/kart/camera.js?v=r6-20260906191941';
import { AIRacer, PERSONALITIES } from './src/ai/racer.js?v=r6-20260906191941';
import { Director } from './src/ai/director.js?v=r6-20260906191941';
import { DriftSmoke } from './src/ai/driftfx.js?v=r6-20260906191941';
import { ItemSystem } from './src/items/items.js?v=r6-20260906191941';
import { Screens } from './src/ui/screens.js?v=r6-20260906191941';
import { HUD } from './src/ui/hud.js?v=r6-20260906191941';
import { Minimap } from './src/ui/minimap.js?v=r6-20260906191941';
import { Input } from './src/ui/input.js?v=r6-20260906191941';
import { TouchControls } from './src/ui/touch.js?v=r6-20260906191941';
import { Audio } from './src/audio/audio.js?v=r6-20260906191941';
import { Events } from './src/game/events.js?v=r6-20260906191941';
import { Race } from './src/game/race.js?v=r6-20260906191941';
import { createTelemetry } from './src/game/telemetry.js?v=r6-20260906191941';

const Q = new URLSearchParams(location.search);
const STAMP = window.__BUILD_STAMP__ || null;
const ROUND = STAMP && /^r\d+/.test(STAMP) ? STAMP.match(/^r\d+/)[0] : 'r5';
const STRICT = Q.get('strict') === '1';
const LAPS = Math.max(1, Math.min(9, parseInt(Q.get('laps') || '3', 10) || 3));
const DROP = Q.get('drop') === '1';
const ITEM_KNOB = Q.get('item') || null;   // round 2 dev knob: ?item=shield gives the player that item at GO so the gate can capture it on demand
const DEG = Math.PI / 180;
const PLAYER = { id: 1, name: 'Marisol', livery: { body: 0xed5851, suit: 0xf1e6d2, helmet: 0xed5851, stripe: 0xf1e6d2 } };
const PLAYER_GRID_SLOT = 7;   // P8, the back of the grid: the field is ahead, the race has overtaking in it

// Boot phase timing, published as window.__BOOT__ and logged once at ready. The 8 s on 4G budget
// is a BYTE budget (textures, three.js, the asset modules), so the phases say where the time went.
const BOOT = { t0: performance.now(), phases: [] };
const mark = (name) => { BOOT.phases.push({ name, t: Math.round(performance.now() - BOOT.t0) }); };
window.__BOOT__ = BOOT;

// Every asset module the level, the karts and the items will import, warmed into the browser's
// module map while the textures download (both go over the same 4G pipe, but the module fetches
// would otherwise start only after the textures finish and the level build begins). A file that
// is not there yet is skipped silently here; level/build.js and kartview.js name it in their own
// console.warn when they come to place it. URLs are the exact './assets/<name>.js' form the
// three modules use, so their assetlib cache keys match.
const KART_ASSETS = ['kart_chassis', 'kart_wheel', 'driver_racer'];
const ITEM_ASSETS = ['item_box', 'chaser_buoy', 'cannonball', 'spill_crate', 'espresso_cup', 'foam_shield', 'boost_pad'];
function assetUrl(name) { return `./assets/${name}.js${STAMP ? `?v=${STAMP}` : ''}`; }
async function prefetchAssetModules() {
  const names = [...new Set([...PLACEMENTS.map((p) => p.asset), ...KART_ASSETS, ...ITEM_ASSETS])].sort();
  let present = 0;
  await Promise.all(names.map(async (n) => {
    const url = assetUrl(n);
    try {
      const r = await fetch(url, { method: 'GET', cache: 'force-cache' });
      if (!r.ok) return;
      await import(/* @vite-ignore */ new URL(url, location.href).href);
      present++;
    } catch (e) { /* a module that fails to import is reported by its consumer, which fails the strict gate */ }
  }));
  return { present, total: names.length };
}

const failBox = document.getElementById('fail');
function fail(msg, err) {
  console.error('[game] ' + msg, err || '');
  if (failBox) { failBox.textContent = 'DRIVE failed to start: ' + msg + (err && err.message ? '\n' + err.message : ''); failBox.classList.add('on'); }
}
window.addEventListener('error', (e) => { if (failBox && !failBox.classList.contains('on')) { failBox.textContent = 'Error: ' + (e.message || e); failBox.classList.add('on'); } });

// The terrain's 169 tiles of 30 m share one material after applyTerrainMaterial; merging them 3 x 3
// (90 m, the level's bake span) takes 95 in view draws down to about 15 at no visual cost (integrator,
// round 0). Collision reads terrain.heightAt from the grid, never the tiles.
function mergeTerrainTiles(terrain, scene) {
  const tiles = terrain.tiles || [];
  if (tiles.length < 2) return;
  const mat = tiles[0].material;
  if (!tiles.every((t) => t.material === mat && t.geometry && t.geometry.attributes.position)) return;
  const groups = new Map();
  for (const t of tiles) {
    const b = t.userData.block || '';
    const [bx, bz] = String(b).split('_').map(Number);
    const key = Number.isFinite(bx) && Number.isFinite(bz) ? `${Math.floor(bx / 3)}_${Math.floor(bz / 3)}` : b;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const merged = [];
  for (const [key, list] of groups) {
    if (list.length === 1) { merged.push(list[0]); continue; }
    try {
      list.forEach((t) => t.updateMatrixWorld(true));
      const geos = list.map((t) => { const g = t.geometry.clone(); g.applyMatrix4(t.matrixWorld); return g; });
      const g = mergeGeometries(geos, false);
      if (!g) throw new Error('mergeGeometries returned null');
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = true; m.castShadow = true;
      m.userData = { kind: 'terrain', block: key, merged: list.length };
      for (const t of list) scene.remove(t);
      scene.add(m);
      merged.push(m);
    } catch (e) { console.warn('[game] terrain merge skipped for block ' + key + ':', e && e.message); merged.push(...list); }
  }
  terrain.tiles = merged;
}

async function boot() {
  // ------------------------------------------------------------------ 1 tier, renderer, screens
  const tier = getTier(detectTier());
  const canvas = document.getElementById('c');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !tier.post, powerPreference: 'high-performance', stencil: false });
  applyTierToRenderer(renderer, tier);
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.autoClear = true;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(innerHeight > innerWidth ? 78 : 60, innerWidth / innerHeight, 0.3, 900);
  camera.position.set(-137, 3, -30);
  scene.add(camera);

  const screens = new Screens(document.body, { round: ROUND, laps: LAPS, racers: 8, lapMetres: Math.round(LAP_LENGTH) });
  screens.loading(0.02, 'Waking the renderer');
  const events = new Events();
  const progress = (f, label) => screens.loading(f, label);

  mark('renderer');

  // ------------------------------------------------------------------ 2 materials and sky in parallel
  // The asset modules are warmed at the same time, and the track GEOMETRY (pure CPU) is built while
  // the bytes are still arriving; the materials are applied to it as soon as the sets are decoded.
  progress(0.05, 'Loading surfaces and sky');
  const materialsP = preloadMaterials(tier, './textures/');
  const skyP = createSky(THREE, { scene, renderer, tier });
  const prefetchP = prefetchAssetModules();

  // ------------------------------------------------------------------ 4a the track geometry (no textures needed yet)
  progress(0.08, 'Laying the road');
  const spline = SPLINE;
  const road = buildRoad(THREE, spline, { tier });
  progress(0.12, 'Shaping the coast');
  const terrain = buildTerrain(THREE, spline);
  const world = new World(terrain, spline, road);
  mark('track geometry');

  const [, sky] = await Promise.all([materialsP, skyP]);
  mark('materials and sky');
  progress(0.22, 'Placing the sun');

  // ------------------------------------------------------------------ 3 the lighting rig
  const rig = createLightingRig(THREE, { scene, renderer, camera, tier, envMap: sky.envMap || null });

  // ------------------------------------------------------------------ 4b the track surfaces and the sea
  progress(0.26, 'Painting the road');
  applyRoadMaterial(road.tiles, road);
  for (const t of road.tiles) { t.receiveShadow = true; t.castShadow = false; scene.add(t); }
  applyTerrainMaterial(terrain.tiles, terrain);
  for (const t of terrain.tiles) { t.receiveShadow = true; t.castShadow = true; scene.add(t); }
  mergeTerrainTiles(terrain, scene);
  const sea = buildSea(THREE, terrain, { tier, envMap: sky.envMap || null, patchFog: rig.patchFog });
  scene.add(sea.mesh);
  mark('track surfaces');
  const prefetched = await prefetchP;
  mark(`asset modules ${prefetched.present}/${prefetched.total}`);
  progress(0.36, 'Building the town');

  // ------------------------------------------------------------------ 5 the level
  const level = await buildLevel(THREE, {
    scene, world, terrain, spline, road, tier,
    onProgress: (f, label) => progress(0.36 + 0.40 * f, label ? label.charAt(0).toUpperCase() + label.slice(1) : 'Building the town'),
  });
  const missingAssets = new Set(level.missing || []);
  mark('level');

  // ------------------------------------------------------------------ 6 karts, camera, player, input, AI
  progress(0.78, 'Wheeling out the karts');
  const roster = [PLAYER, ...PERSONALITIES.map((p) => ({ id: p.id, name: p.name, livery: p.livery, personality: p }))];
  const names = new Map(roster.map((r) => [r.id, r.name]));
  const bodies = roster.map((r) => new KartBody({ world, spline, id: r.id, events }));
  const bodyById = new Map(bodies.map((b) => [b.id, b]));
  const playerBody = bodies[0];
  const views = new Map();
  for (const r of roster) views.set(r.id, new KartView({ scene, livery: r.livery, id: r.id, hero: r.id === PLAYER.id }));
  await Promise.all([...views.values()].map((v) => v.load()));
  // round 3 (ai -> game): pooled tyre smoke for every kart that slides, the player included (kartview ships no smoke of its own)
  const smoke = new DriftSmoke({ scene, tier });
  for (const b of bodies) smoke.attach(b.id, views.get(b.id), b);
  for (const v of views.values()) for (const m of v.missing || []) missingAssets.add(m);
  mark('karts');

  const chase = new ChaseCamera({ camera, world, tier });
  const input = new Input(canvas);
  const touch = new TouchControls(document.body);
  if (tier.name === 'phone') touch.enabled = true;
  const player = new Player({ body: playerBody, input, touch, events, tier });
  const ais = roster.slice(1).map((r) => new AIRacer({ id: r.id, name: r.name, body: bodyById.get(r.id), spline, personality: r.personality, events }));
  const director = new Director({ racers: ais, player: playerBody, spline, laps: LAPS });

  // the grid: P1..P8 of the plan, the player at the back; heading from the plan's rot (0 faces +Z, ccw)
  const grid = new Array(bodies.length);
  const slots = GRID.map((g) => ({ x: g.x, z: g.z, heading: g.rot * DEG }));
  const aiSlots = slots.filter((_, i) => i !== PLAYER_GRID_SLOT);
  bodies.forEach((b, i) => {
    const s = i === 0 ? slots[PLAYER_GRID_SLOT] : aiSlots[i - 1] || slots[i];
    const gnd = world.groundAt(s.x, s.z);
    const y = gnd && Number.isFinite(gnd.y) ? gnd.y : (Number.isFinite(spline.roadY(s.x, s.z)) ? spline.roadY(s.x, s.z) : 0.2);
    grid[i] = { x: s.x, y: y + 0.05, z: s.z, heading: s.heading };
  });

  // ------------------------------------------------------------------ 7 items, HUD, minimap, audio, race, post
  progress(0.86, 'Stocking the item boxes');
  const race = new Race({ events, bodies, spline, laps: LAPS, names, playerId: PLAYER.id, grid, startProgress: START_PROGRESS, checkpoints: CHECKPOINTS });
  const items = new ItemSystem({ scene, world, spline, bodies, views, events, tier, anchors: level.itemBoxAnchors, pads: level.padAnchors, positionOf: (id) => race.positionOf(id) });
  await items.load();
  for (const m of items.missing || []) missingAssets.add(m);
  mark('items');
  const hud = new HUD(document.body, { round: ROUND, laps: LAPS });
  const minimap = new Minimap(document.getElementById('hud'), spline, { startProgress: START_PROGRESS });
  const audio = new Audio({ events, listener: () => playerBody, base: './audio/', bodyOf: (id) => bodyById.get(id) || null });
  const post = createPost(THREE, { renderer, scene, camera, tier });
  progress(0.94, 'Warming the lights');

  // ------------------------------------------------------------------ 8 refresh, grid, ready
  rig.refresh();
  race.reset();
  chase.snapTo(playerBody);
  for (const v of views.values()) v.update(0.016, bodyById.get(v.id));
  chase.update(0.016, playerBody);
  rig.update(camera, 0.016);
  post.render(0.016);

  if (missingAssets.size) {
    const list = [...missingAssets].sort().join(', ');
    if (STRICT) console.error(`[game] strict: ${missingAssets.size} asset(s) missing, placements skipped: ${list}`);
    else console.warn(`[game] ${missingAssets.size} asset(s) not landed yet: ${list}`);
  }

  const telemetry = createTelemetry({ renderer, player: playerBody, bodies, race, items, camera, chase, tier, level, audio, views, names, round: ROUND });
  telemetry.publish();

  // ------------------------------------------------------------------ 9 start, pause, restart
  let started = false, paused = false;
  let dropArmed = DROP, dropAt = -1;
  function startRace() {
    if (started || race.state === 'countdown' || race.state === 'racing') return;
    started = true;
    audio.start();
    audio.ambience(true);
    audio.music('race');
    events.emit('uiClick', {});
    hud.setLap(1, LAPS); hud.setPosition(race.positionOf(PLAYER.id) || 8); hud.setItem(null);
    if (typeof hud.show === 'function') hud.show(true);
    race.start();
    if (DROP) { dropArmed = true; dropAt = -1; }
    canvas.focus && canvas.focus();
  }
  function setPaused(on) {
    on = !!on;
    if (on && (!started || race.state === 'finished')) return;
    if (on === paused) return;
    paused = on;
    screens.pause(on);
    if (typeof audio.pause === 'function') audio.pause(on);
    events.emit('pause', { on });
  }
  function resetAll() {
    started = false; paused = false;
    race.reset();
    items.reset();
    director.reset && director.reset();
    for (const v of views.values()) { v.setShield(false); v.setItemHeld(null); v.update(0.016, bodyById.get(v.id)); }
    chase.snapTo(playerBody);
    hud.setLap(1, LAPS); hud.setPosition(8); hud.setItem(null); hud.setBoost(0); hud.setTime(0, null);
    post.setFade(0); post.setSpeedLines(0);
    events.emit('restart', {});
    if (audio.state !== 'silent') audio.music('title');
    screens.hideAll();
    screens.ready();
  }
  screens.onStart(startRace);
  screens.onResume(() => { paused = false; if (typeof audio.pause === 'function') audio.pause(false); events.emit('pause', { on: false }); });
  screens.onRestart(() => resetAll());
  events.on('raceEnd', ({ standings }) => {
    screens.results({ standings, playerPosition: race.positionOf(PLAYER.id) });
  });
  events.on('countdown', ({ n }) => hud.countdown(n));
  events.on('go', () => { hud.countdown(0); if (ITEM_KNOB && items.give(PLAYER.id, ITEM_KNOB)) console.info('[game] ?item=' + ITEM_KNOB + ' given to the player at GO (dev knob, round 2)'); });
  events.on('finalLap', ({ id }) => { if (id === PLAYER.id) { hud.banner('FINAL LAP'); audio.music('final'); } });
  events.on('finish', ({ id }) => { if (id === PLAYER.id) hud.banner('FINISH'); });
  events.on('placeChange', ({ id, from, to }) => { if (id === PLAYER.id && from > 0) hud.flashPlace(to < from); });
  events.on('hit', ({ target, shielded }) => { if (target === PLAYER.id && !shielded) hud.hit(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && started && race.state === 'racing') setPaused(true); });

  // round 3 (integrator): the photograph tool starts through this entry; it now goes through the screen's own start path so the
  // start screen is dismissed like a real press (startRace alone left the DRIVE overlay over every tools/shot.mjs still)
  window.__START__ = () => { if (typeof screens._start === 'function' && screens.start.classList.contains('on')) screens._start(); if (!started) startRace(); };
  window.__PAUSE__ = (on) => setPaused(on === undefined ? !paused : on);
  window.__DBG__ = {
    teleport(p) {
      const q = spline.at(((p % 1) + 1) % 1);
      const h = Math.atan2(q.tx, q.tz);
      playerBody.place(q.x, q.y + 0.4, q.z, h);
      if (race.state === 'racing') playerBody.state = 'race';
      chase.snapTo(playerBody);
      return [q.x, q.y, q.z];
    },
    drop() { dropNow(); },
    finish() { return race.debugFinishPlayer(); },
    race, items, level, bodies, views, rig, sky, sea, world, spline, tier, events, audio, post, chase, scene, camera, renderer, terrain, road, smoke,
    player, input, touch, director, ais, hud, screens,
    get tokens() { return tokens; },
  };
  function dropNow() {
    // over the cliff edge at the second guard wall gap (section H, progress 0.838): the kart is placed 3 m
    // seaward of the nearest cliff top point, in the air, moving seaward; gravity and the fall rule do the rest.
    // (The first version used lateral -14 at progress 0.80, which is cliff top grass, and never fell.)
    const P = 0.838;
    const q = spline.point(P, 0, new THREE.Vector3());
    const t = spline.tangent(P, new THREE.Vector3());
    let e = null, best = Infinity;
    for (const c of terrain.cliffEdge || []) { const d = (c.x - q.x) * (c.x - q.x) + (c.z - q.z) * (c.z - q.z); if (d < best) { best = d; e = c; } }
    let x, y, z, vx, vz;
    if (e) { x = e.x + e.nx * 3; z = e.z + e.nz * 3; y = e.y + 0.5; vx = e.nx * 6; vz = e.nz * 6; }
    else { const p = spline.point(P, -22, new THREE.Vector3()); x = p.x; z = p.z; y = q.y + 0.5; vx = -t.z * 6; vz = t.x * 6; }
    playerBody.place(x, y, z, Math.atan2(t.x, t.z));
    playerBody.state = 'race';
    playerBody.vel.set(vx, 0, vz);
    chase.snapTo(playerBody);
  }

  // ------------------------------------------------------------------ the staking layer
  // Optional and self-contained: if the oracle is unreachable this returns null and the game
  // below carries on exactly as it did before any of it existed.
  let tokens = null;
  const itemVis = new Map();   // item-system groups hidden for the duration of a staked run
  try {
    // imported dynamically on purpose: the token layer reaches for an oracle, and neither that
    // nor anything it loads is allowed to be able to stop the game from booting
    const { installTokens } = await import('./src/token/index.js?v=r6-20260906191941');
    tokens = await installTokens({
      THREE, world, spline, road, terrain, scene, playerBody, views, input, touch, tier,
      laps: LAPS, hud, KartBody, Race, Player, KartView, GRID, START_PROGRESS, CHECKPOINTS,
      onTrialStart: () => {
        // a staked run is solo and item-free: park the field and every item object out of sight
        // rather than leave seven frozen karts on the grid and boxes that cannot be collected
        for (const b of bodies) if (b !== playerBody) { const v = views.get(b.id); if (v) v.object.visible = false; }
        itemVis.clear();
        scene.traverse((o) => {
          if (typeof o.name === 'string' && o.name.startsWith('items:')) { itemVis.set(o, o.visible); o.visible = false; }
        });
        setPaused(false);
        screens.hideAll();
        started = true;      // the start screen is done with; the trial owns the sim now
      },
      onTrialEnd: () => {
        for (const b of bodies) if (b !== playerBody) { const v = views.get(b.id); if (v) v.object.visible = true; }
        // put each pool back exactly as it was: an idle pool draws nothing and owns that flag itself
        for (const [o, v] of itemVis) o.visible = v;
        itemVis.clear();
      },
    });
  } catch (e) {
    console.warn('[game] staking layer failed to install:', e);
  }

  mark('ready');
  BOOT.readyMs = Math.round(performance.now() - BOOT.t0);
  BOOT.missingAssets = [...missingAssets].sort();
  console.info(`[game] ready in ${BOOT.readyMs} ms: ` + BOOT.phases.map((p) => `${p.name} ${p.t}`).join(', ') + ` (tier ${tier.name}, ${ROUND}${STAMP ? ' ' + STAMP : ''})`);
  window.__READY__ = true;
  screens.ready();
  if (Q.get('autostart') === '1') startRace();

  // ------------------------------------------------------------------ 10 the loop
  // Shadow casters by distance (integrator, round 0). The CSM shadow pass drew every baked block, mover
  // and kart in the light's frustum: 800 to 1700 extra draws per frame (work/game/census2.mjs). Only
  // casters near the camera can throw a shadow the player sees, so castShadow is toggled by the
  // distance from the camera to the block box (tier.castDist is 40 high, 30 phone; the sun is 14
  // degrees up so a 24 m tower throws 96 m, hence the wider band). Receivers are untouched.
  const CAST_DIST = tier.castDist || (tier.name === 'phone' ? 30 : 40);   // render/quality.js castDist (round 0 had 45 on the high tier)
  const FINE_FAR = tier.name === 'phone' ? 90 : 140;   // the rig's scatter fade ends here (render/lighting.js defaultCullFade)
  const casterBlocks = [...level.blocks.values()].map((g) => { const meshes = []; g.traverse((o) => { if (o.isMesh && o.castShadow) meshes.push(o); }); return { g, box: g.userData.box, meshes, on: true, fine: !!g.userData.fine }; });   // only the buckets the bake marked as casters (round 1: fillets, glass and caps never cast)
  // the seven AI drivers do not cast (the chassis and wheels give the contact shadow); the player's does
  const trisOf = (o) => { const g = o.geometry; return g ? (g.index ? g.index.count : g.attributes.position.count) / 3 : 0; };
  for (const v of views.values()) {
    // round 2 (integrator): no kart mesh under 300 triangles casts (a visor, a vent, a hub cap or a 12 triangle stripe
    // each cost a shadow draw for nothing anyone can see: 8 calls on the player kart)
    v.object.traverse((o) => { if (o.isMesh && trisOf(o) < 300) o.castShadow = false; });
    if (v.id === PLAYER.id) continue;
    if (v.driver) v.driver.traverse((o) => { if (o.isMesh) o.castShadow = false; });
    // an AI kart casts from its largest chassis bucket only (the frame): the body panels sit inside that footprint
    // (2 shadow draws and 3.3k triangles a kart at the hairpin exit with the pack ahead)
    { let big = null; v.object.traverse((o) => { if (o.isMesh && o.castShadow && (!big || trisOf(o) > trisOf(big))) big = o; }); v.object.traverse((o) => { if (o.isMesh && o !== big) o.castShadow = false; }); }
    // the AI wheels sit inside the chassis shadow at a 14 degree sun: the chassis alone gives the contact shadow (16 draws per kart saved in the shadow pass)
    for (const w of v.wheels || []) { const n = w && (w.pivot || w.spin); if (n && n.traverse) n.traverse((o) => { if (o.isMesh) o.castShadow = false; }); }
  }
  const MOVER_FAR = { mooring_buoy: 120, rowing_boat: 220, spectator_group: 220, fishing_boat: 250 };   // an 8 m boat at 250 m is 20 px long in the haze   // 0.4 m buoy at 120 m and a 3 m boat or a crowd at 220 m are under 3 px tall
  const casterMovers = level.movers.map((m) => { const meshes = []; m.object.traverse((o) => { if (o.isMesh) meshes.push(o); }); return { obj: m.object, meshes, on: true, far: MOVER_FAR[m.asset] || 0 }; });
  const DRIVER_FAR = 60;   // round 2: 7 px of helmet (was 80)
  // terrain tiles cast by the same distance rule as the blocks (round 1: every tile cast every frame, 43k triangles and 14 calls of shadow pass at the hairpin exit)
  const casterTerrain = (terrain.tiles || []).filter((t) => t.isMesh && t.geometry).map((t) => { t.updateMatrixWorld(true); if (!t.geometry.boundingBox) t.geometry.computeBoundingBox(); const box = t.geometry.boundingBox.clone().applyMatrix4(t.matrixWorld); return { t, box, on: true }; });
  const casterKarts = [...views.values()].map((v) => { const meshes = []; v.object.traverse((o) => { if (o.isMesh && o.castShadow) meshes.push(o); }); return { obj: v.object, meshes, on: true, driver: v.hero ? null : (v.driver || null) }; });
  let castFrame = 0;
  const castFwd = new THREE.Vector3(), castTmp = new THREE.Vector3();
  function updateCasters() {
    if ((castFrame++ % 6) !== 0) return;
    const cp = camera.position;
    for (const c of casterBlocks) {
      const d = c.box ? c.box.distanceToPoint(cp) : 0;
      const on = d < CAST_DIST;
      if (on !== c.on) { c.on = on; for (const m of c.meshes) m.castShadow = on; }
      if (c.fine) c.g.visible = d < FINE_FAR;
    }
    for (const c of casterMovers) {
      const d = c.obj.position.distanceTo(cp);
      const on = d < CAST_DIST;
      if (on !== c.on) { c.on = on; for (const m of c.meshes) m.castShadow = on; }
      if (c.far) c.obj.visible = d < c.far;   // sub pixel movers (buoys, rowing boats, crowds) beyond their range are not drawn
    }
    for (const c of casterTerrain) {
      const on = c.box.distanceToPoint(cp) < CAST_DIST;
      if (on !== c.on) { c.on = on; c.t.castShadow = on; }
    }
    camera.getWorldDirection(castFwd);
    for (const c of casterKarts) {
      const d = c.obj.position.distanceTo(cp);
      // round 2 (integrator): a kart more than 8 m behind the camera plane cannot throw its shadow into the frame (a 0.6 m
      // kart at a 14 degree sun shadows about 2.5 m), so the seven AI chassis behind the player leave the shadow pass (45k
      // triangles at the hairpin exit peak when the player leads)
      const behind = -(castTmp.copy(c.obj.position).sub(cp).dot(castFwd));
      const on = d < (c.driver ? 30 : CAST_DIST) && behind < 8;   // AI karts cast within 30 m (SSAO carries the contact darkening beyond that), the player always within CAST_DIST
      if (on !== c.on) { c.on = on; for (const m of c.meshes) m.castShadow = on; }
      if (c.driver) c.driver.visible = d < DRIVER_FAR;   // an AI driver past 120 m is 4 px tall: 8 draws and 7k triangles a kart for nothing
    }
  }
  const aiCtx = { racers: bodies, player: playerBody, items, time: 0, countdown: null };
  const racerRows = bodies.map((b) => ({ id: b.id, x: 0, z: 0, isPlayer: b === playerBody }));
  const audioState = { speed: 0, drift: null, boost: 0, surface: 'asphalt', position: 1, lap: 1, state: 'race' };
  let last = performance.now();
  let wrongWayT = 0;

  function onResize() {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (post && typeof post.resize === 'function') post.resize(w, h);
  }
  addEventListener('resize', onResize);
  onResize();

  function frame(now) {
    requestAnimationFrame(frame);
    const realDt = Math.max(0, (now - last) / 1000);
    last = now;
    telemetry.tick(realDt);
    const dt = Math.min(realDt, 0.05);
    events.tick(dt);

    // keys that are not driving: pause and start
    if (input.pause) { if (started && race.state !== 'finished') setPaused(!paused); }
    if (input.start && !started && screens.start.classList.contains('on')) startRace();

    const trialOn = !!(tokens && tokens.active);
    if (!paused) {
      if (trialOn) {
        // a staked run steps at a fixed 100 Hz off the REAL elapsed time, not the clamped dt,
        // so the same inputs produce the same clock here and on the oracle
        tokens.advance(realDt);
      } else {
      if (started) {
        player.update(dt);
        aiCtx.time += dt; aiCtx.countdown = race.countdown;
        for (const ai of ais) ai.update(dt, aiCtx);
        director.update(dt);
      }
      for (const b of bodies) b.update(dt);
      resolveBumps(bodies);
      items.update(dt);
      race.update(dt);
      if (dropArmed && race.state === 'racing') {
        if (dropAt < 0) dropAt = race.time + 1.5;
        else if (race.time >= dropAt) { dropArmed = false; dropNow(); }
      }
      }
      if (trialOn) tokens.updateViews(dt);
      for (const b of bodies) { const v = views.get(b.id); if (v) v.update(dt, b); }
      for (const m of level.movers) m.update(dt);
      chase.update(dt, playerBody);
      smoke.update(dt, camera);
      touch.consume();
    }
    // one shot flags (item, pause, start) are cleared AFTER the player read them (kart notes: consume
    // before player.update lost a keydown plus keyup delivered in one tick)
    input.consume();
    updateCasters();
    rig.update(camera, dt);
    sea.update(dt, camera);
    sky.update(camera, dt);
    post.setFade(playerBody.fadeAlpha || 0);
    const boostVis = playerBody.boost > 0 ? Math.min(1, playerBody.boost / 0.5) : 0;
    const fast = Math.max(0, Math.min(1, (Math.abs(playerBody.speed) - 20) / 6));   // round 3 (kart -> game): radial speed lines above 20 m/s (0 at 20, 1 at 26), not only on boost
    const lines = Math.max(boostVis, fast * 0.55, typeof items.speedLines === 'function' ? items.speedLines(PLAYER.id) || 0 : 0);
    post.setSpeedLines(lines);
    post.render(dt);

    // HUD and minimap - a staked run has its own Race, and it is the one on the clock
    const live = trialOn ? tokens.race : race;
    const rec = live.record(PLAYER.id);
    hud.update({
      position: trialOn ? 1 : (rec ? rec.position : 8), lap: live.state === 'racing' || live.state === 'finished' ? (rec ? rec.lap : 1) : 1, laps_total: LAPS,
      race_time: live.time, best_lap: rec && rec.bestLap !== null ? rec.bestLap : null,
      item: trialOn ? null : (items.held.get(PLAYER.id) || null), boost: boostVis,
    });
    if (live.wrongWay(PLAYER.id)) { wrongWayT -= dt; if (wrongWayT <= 0) { hud.banner('WRONG WAY'); wrongWayT = 1.6; } } else wrongWayT = 0;
    for (let i = 0; i < bodies.length; i++) { racerRows[i].x = bodies[i].pos.x; racerRows[i].z = bodies[i].pos.z; }
    minimap.update(racerRows);

    // audio
    audioState.speed = playerBody.speed; audioState.drift = playerBody.drift; audioState.boost = playerBody.boost;
    audioState.surface = playerBody.surface; audioState.position = rec ? rec.position : 8; audioState.lap = rec ? rec.lap : 1; audioState.state = playerBody.state;
    audio.update(dt, audioState);

    telemetry.publish({ paused });
  }
  requestAnimationFrame(frame);
}

boot().catch((e) => fail('boot threw', e));
