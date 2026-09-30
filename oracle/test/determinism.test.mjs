/**
 * The property the whole staking system rests on: the same inputs produce the same clock,
 * here and on the player's machine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driveWithAI, track, THREE } from './fixtures.mjs';

const DM = await import('../../game/src/token/detmath.js');

test('the same inputs give the same time, twice', async () => {
  const a = await driveWithAI({ laps: 3, human: true, seed: 12345 });
  const b = await driveWithAI({ laps: 3, human: true, seed: 12345 });
  assert.deepEqual(a.result, b.result);
  assert.ok(a.result.finished, 'the fixture should complete three laps');
  assert.equal(Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes)), 0, 'traces differ');
});

test('different driving gives different times', async () => {
  const a = await driveWithAI({ laps: 3, human: true, seed: 12345 });
  const b = await driveWithAI({ laps: 3, human: true, seed: 999 });
  assert.notEqual(a.result.totalMs, b.result.totalMs);
});

test('detmath stays within a few ulps of the host Math', async () => {
  const buf = new ArrayBuffer(8), dv = new DataView(buf);
  const bits = (v) => { dv.setFloat64(0, v); return (BigInt(dv.getUint32(0)) << 32n) | BigInt(dv.getUint32(4)); };
  const ulps = (a, b) => {
    if (a === b || !Number.isFinite(a) || !Number.isFinite(b)) return 0n;
    let x = bits(a), y = bits(b);
    if (x >> 63n) x = (1n << 63n) - (x & ((1n << 63n) - 1n));
    if (y >> 63n) y = (1n << 63n) - (y & ((1n << 63n) - 1n));
    return x > y ? x - y : y - x;
  };
  const worst = {};
  const note = (k, got, want) => { const u = ulps(got, want); if (!worst[k] || u > worst[k]) worst[k] = u; };
  for (let i = 0; i < 60000; i++) {
    const x = (i - 30000) / 2401.0;
    note('sin', DM.dsin(x), Math.sin(x));
    note('cos', DM.dcos(x), Math.cos(x));
    note('atan', DM.datan(x), Math.atan(x));
  }
  for (let i = 1; i < 30000; i++) {
    const x = i / 1501.0, y = (i % 977) / 311.0;
    note('exp', DM.dexp(x - 10), Math.exp(x - 10));
    note('log', DM.dlog(x), Math.log(x));
    note('pow', DM.dpow(x, y), Math.pow(x, y));
    note('atan2', DM.datan2(x - 10, y - 1.5), Math.atan2(x - 10, y - 1.5));
    note('tanh', DM.dtanh(x - 10), Math.tanh(x - 10));
    note('hypot', DM.dhypot(x - 10, y - 1.5), Math.hypot(x - 10, y - 1.5));
  }
  // generous bounds: these only have to be imperceptible to a driver, not bit-exact with libm
  const limits = { sin: 2n, cos: 2n, atan: 2n, exp: 2n, log: 2n, pow: 32n, atan2: 4n, tanh: 8n, hypot: 4n };
  for (const [k, lim] of Object.entries(limits)) {
    assert.ok(worst[k] <= lim, `${k} is ${worst[k]} ulps from native, limit ${lim}`);
  }
});

test('detmath uses no host transcendental, so every engine agrees', async () => {
  // A fixed sweep hash. The browser computes the same sweep in docs/DETERMINISM.md's check;
  // if this constant ever changes, every posted time was set on different physics.
  const buf = new ArrayBuffer(8), dv = new DataView(buf);
  let h = 0x811c9dc5 >>> 0;
  const mix = (v) => { dv.setFloat64(0, v); h = Math.imul(h ^ dv.getUint32(0), 16777619) >>> 0; h = Math.imul(h ^ dv.getUint32(4), 16777619) >>> 0; };
  for (let i = 0; i < 120000; i++) { const x = (i - 60000) / 4801.0; mix(DM.dsin(x)); mix(DM.dcos(x)); mix(DM.datan(x)); }
  for (let i = 1; i < 60000; i++) {
    const x = i / 3001.0, y = (i % 977) / 311.0;
    mix(DM.dexp(x - 10)); mix(DM.dlog(x)); mix(DM.dpow(x, y)); mix(DM.datan2(x - 10, y - 1.5)); mix(DM.dtanh(x - 10));
  }
  assert.equal(h.toString(16), 'ab39accf');
});

test('the source files on the simulation path never call the host Math directly', async () => {
  const { readFile } = await import('node:fs/promises');
  const files = ['kart/physics.js', 'track/spline.js', 'track/road.js', 'track/collision.js',
                 'track/terrain.js', 'game/race.js', 'level/placements.js', 'level/colliders.js'];
  const banned = /Math\.(sin|cos|tan|tanh|asin|acos|atan|atan2|exp|expm1|log|log2|log10|pow|hypot|cbrt|sinh|cosh)\s*\(/;
  for (const f of files) {
    const src = await readFile(new URL('../../game/src/' + f, import.meta.url), 'utf8');
    const offenders = src.split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => banned.test(line) && !line.trim().startsWith('//') && !line.trim().startsWith('*'));
    assert.equal(offenders.length, 0,
      `${f} calls the host Math on the simulation path:\n` + offenders.map(([n, l]) => `  ${n}: ${l.trim()}`).join('\n'));
  }
});
