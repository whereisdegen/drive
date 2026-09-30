/**
 * DRIVE  oracle/store.mjs
 *
 * The leaderboard and the trace archive. A JSON index plus one .bin per verified run, written
 * atomically (tmp file then rename) so a crash mid-write cannot leave a half-parsed index.
 *
 * Keeping every accepted trace is not an optimisation, it is the point: a time on this board is
 * only meaningful because the inputs that produced it are still on disk and can be re-driven by
 * anyone who doubts it. It is also what the ghost is - a ghost here is not a recorded path, it
 * is the winner's actual inputs replayed through the same physics, so the car you are chasing
 * is driving the lap it was signed for.
 *
 * This is a single-process file store, appropriate for one game server. It is not a database:
 * there is no concurrent-writer story beyond the in-process write queue below.
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './config.mjs';
import { sameAddress } from './keys.mjs';

const INDEX = join(DATA_DIR, 'runs.json');
const TRACES = join(DATA_DIR, 'traces');

let index = null;
let queue = Promise.resolve();

async function ensure() {
  if (index) return index;
  await mkdir(TRACES, { recursive: true });
  if (existsSync(INDEX)) {
    try {
      index = JSON.parse(await readFile(INDEX, 'utf8'));
    } catch (e) {
      console.error('[store] runs.json is unreadable, starting a fresh index:', e.message);
      index = { runs: [] };
    }
  } else {
    index = { runs: [] };
  }
  if (!Array.isArray(index.runs)) index.runs = [];
  return index;
}

/** serialise writes so two requests cannot interleave a read-modify-write of the index */
function serial(fn) {
  queue = queue.then(fn, fn);
  return queue;
}

async function flush() {
  const tmp = INDEX + '.' + randomUUID() + '.tmp';
  await writeFile(tmp, JSON.stringify(index, null, 2));
  await rename(tmp, INDEX);
}

/**
 * @param {object} run  { driver, trackId, timeMs, lapMs, bestLapMs, traceHash, ticks, respawns, clientTotalMs }
 * @param {Uint8Array} traceBytes
 */
export async function saveRun(run, traceBytes) {
  return serial(async () => {
    await ensure();
    const id = randomUUID();
    await writeFile(join(TRACES, id + '.bin'), Buffer.from(traceBytes));
    const row = { id, at: new Date().toISOString(), ...run };
    index.runs.push(row);
    await flush();
    return row;
  });
}

export async function getRun(id) {
  await ensure();
  return index.runs.find((r) => r.id === id) || null;
}

export async function getTrace(id) {
  const path = join(TRACES, id + '.bin');
  if (!existsSync(path)) return null;
  return new Uint8Array(await readFile(path));
}

/**
 * The board: one row per driver, their best verified time, fastest first.
 * @param {object} o
 * @param {string} [o.trackId]  restrict to one track
 * @param {number} [o.limit=25]
 */
export async function leaderboard({ trackId = null, limit = 25 } = {}) {
  await ensure();
  const best = new Map();
  for (const r of index.runs) {
    if (trackId && r.trackId !== trackId) continue;
    const prev = best.get(r.driver);
    if (!prev || r.timeMs < prev.timeMs) best.set(r.driver, r);
  }
  const rows = [...best.values()].sort((a, b) => a.timeMs - b.timeMs).slice(0, limit);
  return rows.map((r, i) => ({
    rank: i + 1,
    id: r.id,
    driver: r.driver,
    name: r.name || null,
    timeMs: r.timeMs,
    bestLapMs: r.bestLapMs,
    lapMs: r.lapMs,
    at: r.at,
    respawns: r.respawns,
  }));
}

/**
 * every verified run by one driver, fastest first
 *
 * Matched EXACTLY. Solana addresses are base58 and case sensitive, so the case-insensitive
 * compare this used on EVM would have quietly returned another wallet's runs.
 */
export async function runsByDriver(driver, { limit = 25 } = {}) {
  await ensure();
  return index.runs
    .filter((r) => r.driver && driver && sameAddress(r.driver, driver))
    .sort((a, b) => a.timeMs - b.timeMs)
    .slice(0, limit);
}

/**
 * Every verified run set inside one UTC day, fastest first.
 * @param {number} day  unix day index: floor(unixSeconds / 86400)
 */
export async function runsOnDay(day, { trackId = null } = {}) {
  await ensure();
  return index.runs
    .filter((r) => {
      if (trackId && r.trackId !== trackId) return false;
      const t = Date.parse(r.at);
      return Number.isFinite(t) && Math.floor(t / 86400000) === day;
    })
    .sort((a, b) => a.timeMs - b.timeMs);
}

export async function stats() {
  await ensure();
  return { runs: index.runs.length, drivers: new Set(index.runs.map((r) => r.driver)).size };
}
