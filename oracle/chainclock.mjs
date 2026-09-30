/**
 * DRIVE  oracle/chainclock.mjs
 *
 * The oracle stamps Run.issuedAt; race_stakes compares it against Clock::get().unix_timestamp.
 * Those are two different clocks and they are not obliged to agree. If the oracle stamps
 * wall-clock time while the chain is running behind, an honest attempt driven immediately after
 * accepting a duel is rejected as stale.
 *
 * This is not hypothetical and it is not small. Solana's clock is derived from slot progress and
 * drifts from wall time by seconds under normal operation and much further on a validator that
 * has been paused or is catching up - a local `solana-test-validator` routinely sits a second or
 * two behind, which is enough to make a test suite look flaky rather than early. It has bitten
 * this project three times: StaleRun on EVM, a daily-standings failure, and the pot tests.
 *
 * So the oracle keeps its own view of the chain's clock: one getBlockTime every REFRESH_MS,
 * cached as an offset from local time. Attestations are stamped in the chain's frame of
 * reference, which is the frame the program will judge them in.
 *
 * If the RPC is unreachable the offset stays at zero and issuedAt falls back to wall clock;
 * ISSUE_SKEW in the program is the safety net underneath, not the primary mechanism.
 */
import { Connection } from '@solana/web3.js';
import { RPC_URL, CHAINLESS } from './config.mjs';

const REFRESH_MS = 30_000;

// 'confirmed' rather than 'finalized': the clock a transaction will be judged against is the one
// at the head, and waiting ~13s for finality to read a timestamp only widens the gap being measured.
const connection = CHAINLESS ? null : new Connection(RPC_URL, 'confirmed');

let offset = 0;          // chain seconds minus local seconds
let checkedAt = 0;
let reachable = null;

export async function refresh() {
  // no cluster configured, so nothing will ever compare a timestamp against Clock::get(). Skip
  // the RPC entirely rather than filling a hosted build's logs with connection failures to a
  // validator that was never meant to exist.
  if (CHAINLESS) {
    if (reachable === null) console.log('[oracle] no cluster configured: running chainless, timestamps are wall clock');
    reachable = false;
    offset = 0;
    checkedAt = Date.now();
    return offset;
  }
  try {
    const slot = await connection.getSlot('confirmed');
    const blockTime = await connection.getBlockTime(slot);
    // a slot can legitimately have no recorded time; keep the previous offset rather than
    // slamming it to zero over one empty answer
    if (blockTime === null) throw new Error(`slot ${slot} has no block time`);
    offset = blockTime - Math.floor(Date.now() / 1000);
    checkedAt = Date.now();
    if (reachable !== true) console.log(`[oracle] chain clock is ${offset >= 0 ? '+' : ''}${offset}s from local time`);
    reachable = true;
  } catch (e) {
    if (reachable !== false) console.warn('[oracle] no chain clock (' + e.message + '); stamping attestations with local time');
    reachable = false;
    offset = 0;
    checkedAt = Date.now();
  }
  return offset;
}

/** unix seconds in the chain's frame of reference */
export async function now() {
  if (Date.now() - checkedAt > REFRESH_MS) await refresh();
  return Math.floor(Date.now() / 1000) + offset;
}

export const status = () => ({ offset, reachable, checkedAt });
