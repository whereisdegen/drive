/**
 * DRIVE  oracle/daily.mjs
 *
 * The day's standings, and the signature that lets reward_vault pay them.
 *
 * Ranking: each driver's FASTEST oracle-verified time set between 00:00 and 24:00 UTC, five
 * fastest take the prize. One entry per wallet, so a driver who sets four good times occupies
 * one place, not four. Only verified runs exist in the store at all - an unverified run is never
 * saved - so there is nothing to filter for here beyond the day and the track.
 *
 * Days are `floor(unixSeconds / 86400)`, which makes them UTC by construction on both sides: the
 * program computes the same thing from Clock::get() and never has to be told what a day is.
 */

import { PublicKey } from '@solana/web3.js';
import { keypair, ORACLE_ADDRESS, ATTESTATION_TTL } from './config.mjs';
import { signMessage, sameAddress } from './keys.mjs';
import { runsOnDay } from './store.mjs';
import { now as chainNow, refresh as refreshChainClock } from './chainclock.mjs';

export const PLACES = 5;
export const SPLIT_BPS = [4000, 2500, 1500, 1200, 800];   // 40 / 25 / 15 / 12 / 8
export const DAILY_BPS = 1000;                            // 10% of the pool each day
export const CLAIM_DAYS = 90;

/** must equal DAY_DOMAIN in programs/reward_vault/src/attest.rs */
export const DAY_DOMAIN = Buffer.from('DRIVE:day:v1', 'utf8');

/**
 * The exact bytes reward_vault rebuilds and compares against, from `impl DayResult { fn
 * message() }`.
 *
 * The winner list is prefixed with its COUNT, and that prefix is the whole reason a short list
 * cannot be read as a longer one with trailing rubbish appended - the one place in either message
 * format where a variable-length field appears, and so the one place where an encoding needed a
 * decision rather than a width.
 */
export function dayMessage({ day, winners, timesMs, deadline }) {
  if (winners.length !== timesMs.length) throw new Error('winners and timesMs must be the same length');
  if (winners.length > PLACES) throw new Error(`at most ${PLACES} winners, got ${winners.length}`);
  const head = Buffer.alloc(8 + 1);
  head.writeBigUInt64LE(BigInt(day), 0);
  head.writeUInt8(winners.length, 8);
  const rows = winners.map((w, i) => {
    const t = Buffer.alloc(4);
    t.writeUInt32LE(timesMs[i], 0);
    return Buffer.concat([Buffer.from(new PublicKey(w).toBytes()), t]);
  });
  const tail = Buffer.alloc(8);
  tail.writeBigInt64LE(BigInt(deadline), 0);
  return Buffer.concat([DAY_DOMAIN, head, ...rows, tail]);
}

export const dayOf = (date = new Date()) => Math.floor(date.getTime() / 86400000);
export const dayStart = (day) => new Date(day * 86400000).toISOString();
/** the instant a day becomes settleable */
export const dayEnd = (day) => new Date((day + 1) * 86400000).toISOString();

/**
 * The standings for one UTC day.
 * @returns {Promise<{day, closed, rows: Array}>} rows are rank order, at most PLACES
 */
export async function standings(day, { trackId = null, limit = PLACES } = {}) {
  const runs = await runsOnDay(day, { trackId });
  // "is this day over" is judged on the CHAIN's clock, because that is the clock reward_vault
  // will judge it on. Which day a run belongs to is judged on the wall clock, because that is
  // when it was actually driven. In production the two are seconds apart.
  const chainSeconds = await chainNow();
  const best = new Map();
  for (const r of runs) {
    // keyed by the address EXACTLY as given. Solana addresses are base58 and case sensitive:
    // lowercasing to normalise - the habit every EVM codebase teaches, and what this line used
    // to do - would collapse distinct wallets into one row and hand the signature a key that
    // does not exist.
    const key = r.driver || '';
    if (!key) continue;
    if (!best.has(key) || r.timeMs < best.get(key).timeMs) best.set(key, r);
  }
  const rows = [...best.values()]
    .sort((a, b) => a.timeMs - b.timeMs || Date.parse(a.at) - Date.parse(b.at))   // a tie goes to whoever set it first
    .slice(0, limit)
    .map((r, i) => ({
      place: i + 1,
      driver: r.driver,
      name: r.name || null,
      timeMs: r.timeMs,
      bestLapMs: r.bestLapMs,
      runId: r.id,
      at: r.at,
      shareBps: SPLIT_BPS[i] ?? 0,
    }));
  return {
    day,
    startsAt: dayStart(day),
    endsAt: dayEnd(day),
    closed: chainSeconds >= (day + 1) * 86400,
    entrants: best.size,
    rows,
  };
}

/**
 * Sign a finished day so anyone can settle it on chain.
 *
 * Refuses a day that is not over, because the program refuses it too and a signature that can
 * only fail is worse than no signature - it looks like the system is broken rather than early.
 */
export async function attestDay(day, { trackId = null } = {}) {
  // Signing happens once a day and decides whether a day is closed, so it reads the chain's
  // clock fresh rather than trusting the 30-second cache the UI is happy with. Getting this
  // wrong either signs a day that will fail, or refuses one that is genuinely over.
  await refreshChainClock();
  const s = await standings(day, { trackId });
  if (!s.closed) return { ok: false, reason: `day ${day} is still running until ${s.endsAt}`, ...s };
  if (!s.rows.length) return { ok: false, reason: `nobody set a verified time on day ${day}`, ...s };

  const result = {
    day,
    winners: s.rows.map((r) => r.driver),
    timesMs: s.rows.map((r) => r.timeMs),
    deadline: (await chainNow()) + ATTESTATION_TTL,
  };
  const signature = signMessage(keypair, dayMessage(result));

  return {
    ok: true,
    ...s,
    attestation: {
      result: { ...result, deadline: String(result.deadline) },
      signature: signature.toString('base64'),
      signer: ORACLE_ADDRESS,
    },
  };
}

/**
 * The days on which `address` finished in the top five, newest first.
 *
 * The UI needs this so it can ask the vault about a handful of specific days instead of walking
 * the whole 90-day claim window one RPC call at a time.
 */
export async function daysPlacedBy(address, { trackId = null, window = CLAIM_DAYS + 1 } = {}) {
  const who = String(address || '');
  if (!who) return [];
  const today = dayOf();
  const out = [];
  for (let day = today; day > today - window; day--) {
    const s = await standings(day, { trackId });
    const row = s.rows.find((r) => sameAddress(r.driver, who));
    if (row) out.push({ day, place: row.place, timeMs: row.timeMs, shareBps: row.shareBps, closed: s.closed });
  }
  return out;
}

/** what each place would receive from a pool of `pool` base units, matching the program's integer maths */
export function sharesOf(pool, places = PLACES) {
  const p = BigInt(pool);
  const payout = (p * BigInt(DAILY_BPS)) / 10000n;
  return Array.from({ length: places }, (_, i) => (payout * BigInt(SPLIT_BPS[i])) / 10000n);
}
