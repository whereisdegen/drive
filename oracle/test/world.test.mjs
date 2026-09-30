/**
 * The circuit itself. A time is only comparable to another time if both were driven on the
 * same geometry, so these check the two ways that could quietly stop being true: the render
 * tier changing the collision surface, and the staked world drifting from the game's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { track, THREE, gridSlots, stakeWorld } from './fixtures.mjs';

const G = '../../game/src';
const { SPLINE } = await import(G + '/track/spline.js');
const { buildRoad } = await import(G + '/track/road.js');
const { buildTerrain } = await import(G + '/track/terrain.js');
const { World } = await import(G + '/track/collision.js');
const { registerLevelColliders, levelPlacements } = await import(G + '/level/colliders.js');
const { GRID, DENSITY_ASSETS, NO_COLLIDER } = await import(G + '/level/placements.js');

const geomHash = (world) => {
  let h = 0;
  for (const c of world.list) {
    const k = (c.tag || '') + ':' + Math.round(c.minX * 100) + ',' + Math.round(c.maxX * 100) +
              ',' + Math.round(c.minZ * 100) + ',' + Math.round(c.maxZ * 100);
    for (let i = 0; i < k.length; i++) h = Math.imul(h ^ k.charCodeAt(i), 16777619) >>> 0;
  }
  return h.toString(16);
};

test('the drivable surface does not depend on the render tier', async () => {
  const tiers = [{}, { tier: { name: 'phone', castDist: 30 } }, { tier: { name: 'high', castDist: 40 } }];
  const worlds = tiers.map((opts) => {
    const road = buildRoad(THREE, SPLINE, opts);
    return { road, world: new World(buildTerrain(THREE, SPLINE), SPLINE, road) };
  });
  let checked = 0;
  for (let i = 0; i < 1500; i++) {
    const q = SPLINE.atDistance((i / 1500) * SPLINE.length, {});
    for (const lat of [-6, 0, 6]) {
      const x = q.x - q.tz * lat, z = q.z + q.tx * lat;
      const ref = worlds[0].world.groundAt(x, z), refP = worlds[0].road.probe(x, z);
      for (const w of worlds.slice(1)) {
        const got = w.world.groundAt(x, z), gotP = w.road.probe(x, z);
        assert.equal(got?.y, ref?.y, `ground y differs at ${x.toFixed(1)},${z.toFixed(1)}`);
        assert.equal(got?.surface, ref?.surface, 'surface differs');
        assert.equal(gotP?.surface, refP?.surface, 'road probe differs');
        checked++;
      }
    }
  }
  assert.ok(checked > 5000);
});

test('a staked run always collides with the full town, whatever the tier draws', async () => {
  const road = buildRoad(THREE, SPLINE, { tier: { name: 'phone', density: 0.5 } });
  const terrain = buildTerrain(THREE, SPLINE);
  const phoneStake = stakeWorld(THREE, { spline: SPLINE, road, terrain, World, registerLevelColliders });
  const t = await track();
  assert.equal(phoneStake.list.length, t.world.list.length, 'a phone would be timed on a different circuit');
  assert.equal(geomHash(phoneStake), geomHash(t.world));
});

test('the density filter really would drop colliders, so the guard above matters', () => {
  const full = levelPlacements({ spline: SPLINE, road: null, terrain: null, density: 1 });
  const half = levelPlacements({ spline: SPLINE, road: null, terrain: null, density: 0.5 });
  assert.ok(half.length < full.length, 'density 0.5 dropped nothing - has DENSITY_ASSETS changed?');
  const collidable = [...DENSITY_ASSETS].filter((a) => !NO_COLLIDER.has(a));
  assert.ok(collidable.length > 0,
    'no density-filtered asset carries a collider any more; STAKE_DENSITY could be relaxed');
});

test('the grid is computed the same way on both sides', async () => {
  const t = await track();
  const again = gridSlots(t.world, t.spline, GRID);
  assert.deepEqual(again, t.slots);
  assert.equal(again.length, 8);
  for (const s of again) assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.z));
});

test('the town is actually in the collision world', async () => {
  const t = await track();
  assert.ok(t.world.list.length > 900, `only ${t.world.list.length} colliders - is the level registering?`);
  const tags = new Set(t.world.list.map((c) => c.tag));
  for (const expected of ['guardwall', 'quay_edge', 'hairpin_tyres', 'church']) {
    assert.ok(tags.has(expected), `no ${expected} collider`);
  }
});
