/**
 * DRIVE  oracle/server.mjs
 *
 * One process: the static game and the verification API on the same origin, so a player only
 * has to start one thing.
 *
 *   POST /api/runs              a finished run, for verification and (if it survives) signing
 *   GET  /api/leaderboard       the board, fastest verified time per driver
 *   GET  /api/runs/:id/trace    the raw inputs behind a posted time - the receipt
 *   GET  /api/runs/:id          that run's verified numbers
 *   GET  /api/drivers/:addr/runs
 *   GET  /api/config            addresses, chain id, track id, lap count
 *
 * The API never takes a lap time as input. POST /api/runs accepts INPUTS; replay.mjs decides
 * what they were worth. A client that posts `{ timeMs: 1 }` is posting a number nobody reads.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { isAddress } from './keys.mjs';
import { assertSignerIsSafe, PORT, HOST, PUBLIC_URL, TRUST_PROXY, CLUSTER, CHAINLESS, PRIVY_APP_ID, RACE_STAKES_PROGRAM, REWARD_VAULT_PROGRAM, REWARD_MINT, RPC_URL, ATTESTATION_TTL, banner, ORACLE_ADDRESS, USING_DEV_KEY } from './config.mjs';
import { verifyRun, trackFingerprint, LAPS, TRACK_ID, track } from './replay.mjs';
import { signRun, trackIdOf } from './attest.mjs';
import { refresh as refreshChainClock, status as chainClockStatus } from './chainclock.mjs';
import { standings, attestDay, daysPlacedBy, dayOf, PLACES, SPLIT_BPS, DAILY_BPS, CLAIM_DAYS } from './daily.mjs';
import { saveRun, getRun, getTrace, leaderboard, runsByDriver, stats } from './store.mjs';

const { TICK_HZ } = await import('../game/src/token/simcore.js');
const { fromBase64 } = await import('../game/src/token/trace.js');

const GAME_DIR = new URL('../game/', import.meta.url).pathname;
const MAX_BODY = 2 * 1024 * 1024;      // a 3-lap trace is ~15 kB; 2 MB is already absurdly generous

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.webp': 'image/webp', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2', '.bin': 'application/octet-stream', '.ico': 'image/x-icon',
};

// ------------------------------------------------------------------ crude per-IP throttle
// A verification is ~60 ms of CPU. Without this, one client can pin a core with a loop.
const RATE = { windowMs: 60_000, maxVerifies: 20 };
const hits = new Map();

/**
 * Who to charge a verification to. Behind a proxy every request arrives from the proxy's own
 * address, so without TRUST_PROXY one team sharing a tunnel would share one allowance and lock
 * each other out after twenty runs. With it, the left-most X-Forwarded-For entry is the client.
 */
function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}
function throttled(ip) {
  const now = Date.now();
  const row = hits.get(ip) || { n: 0, until: now + RATE.windowMs };
  if (now > row.until) { row.n = 0; row.until = now + RATE.windowMs; }
  row.n++;
  hits.set(ip, row);
  if (hits.size > 5000) for (const [k, v] of hits) if (now > v.until) hits.delete(k);
  return row.n > RATE.maxVerifies;
}

let TRACK_BYTES32 = null;

/**
 * A player-chosen display name. Untrusted text on a shared board: strip anything that is not
 * printable, cap the length, and return null rather than an empty string so the UI falls back to
 * the address. The UI escapes it again on the way out - this is not the only line of defence.
 */
function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const clean = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
  return clean || null;
}

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
  res.end(s);
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handleApi(req, res, url) {
  const path = url.pathname;

  // a cheap liveness probe for whatever is hosting this; no simulation, no chain call
  if (path === '/api/health') {
    return json(res, 200, { ok: true, uptimeSeconds: Math.round(process.uptime()), track: TRACK_BYTES32 });
  }

  if (path === '/api/config') {
    return json(res, 200, {
      // `cluster: null` is the client's signal to stay chainless and never load its wallet
      // code at all - not to load it and then discover there is nothing to talk to. Phantom
      // injects window.ethereum, so a client that probes before checking this once tried to
      // switch the player to an EVM chain.
      cluster: CHAINLESS ? null : CLUSTER,
      // the client needs BOTH to offer a wallet, and treats either being null as "no wallet".
      // Public: it identifies the app to Privy, it is not a credential.
      privyAppId: CHAINLESS ? null : (PRIVY_APP_ID || null),
      rpcUrl: CHAINLESS ? null : RPC_URL,
      raceStakes: RACE_STAKES_PROGRAM,
      rewardVault: REWARD_VAULT_PROGRAM,
      rewardMint: REWARD_MINT,
      daily: { places: PLACES, splitBps: SPLIT_BPS, dailyBps: DAILY_BPS, claimDays: CLAIM_DAYS, today: dayOf() },
      oracleSigner: ORACLE_ADDRESS,
      devKey: USING_DEV_KEY,
      trackName: TRACK_ID,
      trackId: TRACK_BYTES32,
      trackFingerprint: await trackFingerprint(),
      laps: LAPS,
      tickHz: TICK_HZ,
      attestationTtl: ATTESTATION_TTL,
      chainClock: chainClockStatus(),
      ...(await stats()),
    });
  }

  // ---------------------------------------------------------------- the daily prize
  // /api/daily          today, still running
  // /api/daily/:day     one UTC day's standings
  // /api/daily/:day/attestation   the same, signed, so anyone can settle it on chain
  {
    // which days did this address place in? so the UI can ask the vault about those days only
    const mp = path.match(/^\/api\/daily\/placed\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
    if (mp) {
      if (!isAddress(mp[1])) return json(res, 400, { error: 'not a solana address' });
      return json(res, 200, { driver: mp[1], days: await daysPlacedBy(mp[1], { trackId: TRACK_BYTES32 }) });
    }

    const m2 = path.match(/^\/api\/daily(?:\/(\d+))?(\/attestation)?$/);
    if (m2) {
      const day = m2[1] === undefined ? dayOf() : Number(m2[1]);
      if (!Number.isFinite(day) || day < 0 || day > 100000) return json(res, 400, { error: 'bad day index' });
      if (m2[2]) return json(res, 200, await attestDay(day, { trackId: TRACK_BYTES32 }));
      return json(res, 200, { ...await standings(day, { trackId: TRACK_BYTES32 }), splitBps: SPLIT_BPS, dailyBps: DAILY_BPS, claimDays: CLAIM_DAYS });
    }
  }

  if (path === '/api/leaderboard') {
    const limit = Math.min(100, Number(url.searchParams.get('limit')) || 25);
    return json(res, 200, { trackId: TRACK_BYTES32, rows: await leaderboard({ trackId: TRACK_BYTES32, limit }) });
  }

  let m = path.match(/^\/api\/runs\/([0-9a-f-]{36})(\/trace)?$/i);
  if (m && req.method === 'GET') {
    const row = await getRun(m[1]);
    if (!row) return json(res, 404, { error: 'no such run' });
    if (!m[2]) return json(res, 200, row);
    const bytes = await getTrace(m[1]);
    if (!bytes) return json(res, 404, { error: 'trace missing' });
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.byteLength });
    return res.end(Buffer.from(bytes));
  }

  m = path.match(/^\/api\/drivers\/([1-9A-HJ-NP-Za-km-z]{32,44})\/runs$/);
  if (m) {
    if (!isAddress(m[1])) return json(res, 400, { error: 'not a solana address' });
    return json(res, 200, { rows: await runsByDriver(m[1]) });
  }

  if (path === '/api/runs' && req.method === 'POST') {
    const ip = clientIp(req);
    if (throttled(ip)) return json(res, 429, { error: 'too many verifications, slow down' });

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      return json(res, 400, { error: 'bad body: ' + e.message });
    }

    const { driver, traceB64, digests = [], client = {}, name = null } = body || {};
    if (!driver || !isAddress(driver)) return json(res, 400, { error: 'driver must be a solana address' });
    if (typeof traceB64 !== 'string' || !traceB64) return json(res, 400, { error: 'traceB64 required' });
    if (!Array.isArray(digests)) return json(res, 400, { error: 'digests must be an array' });

    let bytes;
    try {
      bytes = fromBase64(traceB64);
    } catch {
      return json(res, 400, { error: 'traceB64 is not base64' });
    }

    const t0 = Date.now();
    let v;
    try {
      v = await verifyRun({ bytes, digests, client });
    } catch (e) {
      console.error('[oracle] replay threw:', e);
      return json(res, 500, { error: 'replay failed' });
    }
    const ms = Date.now() - t0;

    if (!v.ok) {
      console.log(`[oracle] ${driver} REJECTED (${v.status}) in ${ms}ms: ${v.reasons.join('; ')}`);
      return json(res, 200, { ok: false, ...v });
    }

    // EVM had getAddress() here to put the checksum casing back. Solana addresses have no
    // such thing - base58 is already canonical, and changing one character changes the key.
    const address = driver;
    const attestation = await signRun({ driver: address, trackId: TRACK_BYTES32, timeMs: v.totalMs, traceBytes: bytes });
    const row = await saveRun({
      driver: address, name: cleanName(name), trackId: TRACK_BYTES32, timeMs: v.totalMs, lapMs: v.lapMs,
      bestLapMs: v.bestLapMs, traceHash: attestation.run.traceHash, ticks: v.ticks,
      respawns: v.respawns, clientTotalMs: v.clientTotalMs,
    }, bytes);

    console.log(`[oracle] ${address} VERIFIED ${v.totalMs}ms in ${ms}ms (client said ${v.clientTotalMs ?? '-'})`);
    return json(res, 200, { ok: true, ...v, runId: row.id, attestation });
  }

  return json(res, 404, { error: 'no such endpoint' });
}

/**
 * Gzipped copies of text assets, keyed by path and mtime.
 *
 * The wallet bundle is 5.2 MB and compresses to 1.5 MB - a 3.5x saving on the one asset a player
 * waits for while a modal is supposed to be opening. Compressing it on every request would cost
 * ~200 ms of CPU each time, so the result is cached, and the mtime is part of the key so a
 * rebuild is picked up without restarting.
 *
 * Only text types, and only above a size where the CPU is worth it: gzipping a 300 byte file
 * makes it bigger.
 */
const gzipCache = new Map();
const COMPRESSIBLE = /^(text\/|application\/(javascript|json)|image\/svg)/;
const MIN_COMPRESS = 4096;

async function compressed(file, type, data, mtimeMs) {
  if (data.length < MIN_COMPRESS || !COMPRESSIBLE.test(type)) return null;
  const key = `${file}:${mtimeMs}:${data.length}`;
  const hit = gzipCache.get(key);
  if (hit) return hit;
  const { gzip } = await import('node:zlib');
  const { promisify } = await import('node:util');
  const out = await promisify(gzip)(data, { level: 6 });
  // one entry per file: a rebuild replaces its predecessor rather than growing the map
  for (const k of gzipCache.keys()) if (k.startsWith(file + ':')) gzipCache.delete(k);
  gzipCache.set(key, out);
  return out;
}

async function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/' || p === '/game' || p === '/game/') p = '/index.html';
  else if (p.startsWith('/game/')) p = p.slice(5);

  // contain the path inside the game directory: normalize first, then reject any escape
  const rel = normalize(p).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const file = join(GAME_DIR, rel);
  if (!file.startsWith(GAME_DIR)) { res.writeHead(403); return res.end('forbidden'); }

  try {
    const s = await stat(file);
    if (!s.isFile()) throw new Error('not a file');
    const data = await readFile(file);
    const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';

    const wantsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const gz = wantsGzip ? await compressed(file, type, data, s.mtimeMs) : null;

    res.writeHead(200, {
      'content-type': type,
      'content-length': (gz || data).length,
      'cache-control': 'no-cache',
      // Vary matters even with no-cache: a proxy that cached the gzipped body would otherwise
      // hand it to a client that never asked for it.
      vary: 'Accept-Encoding',
      ...(gz ? { 'content-encoding': 'gzip' } : {}),
    });
    res.end(gz || data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await serveStatic(req, res, url);
  } catch (e) {
    console.error('[oracle] unhandled:', e);
    if (!res.headersSent) json(res, 500, { error: 'internal error' });
  }
});

assertSignerIsSafe();   // before anything is served, and before the key is used to sign

const fp = await trackFingerprint();
TRACK_BYTES32 = trackIdOf(TRACK_ID, fp);
await track();              // build the collision world before the first request pays for it
await refreshChainClock();  // and learn the chain's clock before the first attestation

server.listen(PORT, HOST, () => {
  const base = PUBLIC_URL || `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
  console.log('DRIVE oracle');
  console.log(banner());
  console.log(`track id        ${TRACK_BYTES32}  (${TRACK_ID} @ ${fp})`);
  console.log(`bound to        ${HOST}:${PORT}${TRUST_PROXY ? '  (trusting X-Forwarded-For)' : ''}`);
  if (HOST === '0.0.0.0' && !PUBLIC_URL) {
    console.log('note: serving on every interface. Set PUBLIC_URL so the address printed below is');
    console.log('      the one players should actually open.');
  }
  console.log(`\n  game   ${base}/`);
  console.log(`  api    ${base}/api/config\n`);
});

// finish in-flight writes rather than truncating runs.json on a redeploy
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`\n[oracle] ${sig}, closing`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
