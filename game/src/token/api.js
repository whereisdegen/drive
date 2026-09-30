/**
 * DRIVE  src/token/api.js  (owner: token)
 *
 * The browser's side of the conversation with the oracle. Small on purpose: the client sends
 * what it did (inputs) and is told what that was worth (a time and a signature). It does not
 * get to have an opinion about its own lap time, and there is no endpoint through which it
 * could offer one.
 */
import { encodeTrace, toBase64 } from './trace.js?v=r6-20260906191941';

const json = async (res) => {
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`${res.status}: ${text.slice(0, 200)}`); }
  if (!res.ok && body && body.error) throw new Error(body.error);
  return body;
};

export async function getConfig() {
  return json(await fetch('/api/config'));
}

export async function getLeaderboard(limit = 25) {
  return json(await fetch(`/api/leaderboard?limit=${limit}`));
}

export async function getDriverRuns(address) {
  return json(await fetch(`/api/drivers/${address}/runs`));
}

/**
 * Submit a finished run for verification.
 * @returns {Promise<object>} { ok, status, totalMs, lapMs, reasons, runId, attestation }
 *          ok false is a normal outcome, not an exception: the caller shows `reasons`.
 */
export async function submitRun({ driver, trace, name = null }) {
  const traceB64 = toBase64(encodeTrace(trace));
  return json(await fetch('/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ driver, name, traceB64, digests: trace.digests, client: trace.client }),
  }));
}

/** one UTC day's standings; omit `day` for today */
export async function getDaily(day) {
  return json(await fetch(day === undefined ? '/api/daily' : `/api/daily/${day}`));
}

/** the days this address placed in, so the UI can ask the vault about those days only */
export async function getPlacedDays(address) {
  return json(await fetch(`/api/daily/placed/${address}`));
}

/** the oracle's signature for a finished day, so anyone can settle it */
export async function getDayAttestation(day) {
  return json(await fetch(`/api/daily/${day}/attestation`));
}

/** the raw inputs behind a posted time - what the ghost is driven from */
export async function getTraceBytes(runId) {
  const res = await fetch(`/api/runs/${runId}/trace`);
  if (!res.ok) throw new Error('trace unavailable');
  return new Uint8Array(await res.arrayBuffer());
}
