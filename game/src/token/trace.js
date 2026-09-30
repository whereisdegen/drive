/**
 * DRIVE  src/token/trace.js  (owner: token)
 *
 * The input trace: the only thing a player actually submits. A staked run is NOT a claimed
 * lap time - a claimed time is worthless, since window.__GAME__ and every number in this tab
 * belong to whoever opened the console. A run is the sequence of stick positions the driver
 * fed the kart, and the oracle re-drives that sequence through simcore.js to find out what
 * time it really produces.
 *
 * Format (canonical bytes, so the hash the contract sees is stable):
 *
 *   magic   'DRV1'                4 bytes
 *   version uint8                 1
 *   tickHz  uint16 LE             2
 *   laps    uint8                 1
 *   runs    uint32 LE             4
 *   then `runs` records of 5 bytes:
 *     n        uint16 LE   how many consecutive ticks held this input (1..65535)
 *     throttle int8       -127..127
 *     steer    int8       -127..127
 *     hop      uint8      0 or 1
 *
 * Run-length coding costs 5 bytes per input CHANGE, not per tick: a 2:15 lap at 100 Hz is
 * 13 500 ticks but a human only changes input a few hundred times, so a full 3-lap trace is a
 * couple of kilobytes. That matters because the trace is posted to the oracle and its hash is
 * written on chain.
 *
 * Digests are carried alongside (not inside) the canonical bytes: [tick, h] pairs sampled every
 * DIGEST_EVERY ticks from simcore's digestOf. The oracle compares its own digests against them
 * to catch a client that diverged (see docs/DETERMINISM.md).
 */
import { clamp8 } from './simcore.js?v=r6-20260906191941';

export const TRACE_VERSION = 1;
export const MAGIC = 0x31565244;        // 'DRV1' little-endian
export const DIGEST_EVERY = 256;        // ticks between state digests (about 2.5 s)
export const MAX_RUN = 65535;
export const MAX_TICKS = 100 * 60 * 20; // 20 minutes at 100 Hz: a hard ceiling on a submitted run

/**
 * Records one run as it is driven. One call per simulation tick, in lockstep with sim.step().
 *
 *   const rec = new TraceRecorder({ laps: 3, tickHz: 100 });
 *   rec.tick(input, sim.digest());
 *   const trace = rec.finish({ totalMs, lapMs });
 */
export class TraceRecorder {
  constructor({ laps = 3, tickHz = 100, track = 'sorrel-cove' } = {}) {
    this.laps = laps;
    this.tickHz = tickHz;
    this.track = track;
    this.runs = [];            // [{ n, throttle, steer, hop }]
    this.digests = [];         // [[tick, h]]
    this.ticks = 0;
    this._last = null;
  }

  /**
   * @param {{throttle:number, steer:number, hop:boolean}} input  already quantised to int8
   * @param {number} [digest]  simcore digest AFTER the step, sampled periodically
   */
  tick(input, digest) {
    const throttle = clamp8(input && input.throttle);
    const steer = clamp8(input && input.steer);
    const hop = input && input.hop ? 1 : 0;
    const last = this._last;
    if (last && last.throttle === throttle && last.steer === steer && last.hop === hop && last.n < MAX_RUN) {
      last.n++;
    } else {
      this._last = { n: 1, throttle, steer, hop };
      this.runs.push(this._last);
    }
    this.ticks++;
    if (digest !== undefined && (this.ticks % DIGEST_EVERY === 0)) this.digests.push([this.ticks, digest >>> 0]);
  }

  /** @param {object} client what the player's own machine thought the result was (advisory only) */
  finish(client = {}) {
    return {
      v: TRACE_VERSION,
      track: this.track,
      laps: this.laps,
      tickHz: this.tickHz,
      ticks: this.ticks,
      runs: this.runs.map((r) => [r.n, r.throttle, r.steer, r.hop]),
      digests: this.digests,
      client,
    };
  }
}

/** canonical bytes for hashing and transport */
export function encodeTrace(trace) {
  const runs = trace.runs || [];
  const buf = new ArrayBuffer(12 + runs.length * 5);
  const dv = new DataView(buf);
  dv.setUint32(0, MAGIC, true);
  dv.setUint8(4, trace.v || TRACE_VERSION);
  dv.setUint16(5, trace.tickHz || 100, true);
  dv.setUint8(7, trace.laps || 3);
  dv.setUint32(8, runs.length, true);
  let o = 12;
  for (const r of runs) {
    dv.setUint16(o, r[0], true);
    dv.setInt8(o + 2, r[1]);
    dv.setInt8(o + 3, r[2]);
    dv.setUint8(o + 4, r[3] ? 1 : 0);
    o += 5;
  }
  return new Uint8Array(buf);
}

export function decodeTrace(bytes, extra = {}) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.byteLength < 12 || dv.getUint32(0, true) !== MAGIC) throw new Error('trace: bad magic');
  const v = dv.getUint8(4);
  if (v !== TRACE_VERSION) throw new Error('trace: unsupported version ' + v);
  const tickHz = dv.getUint16(5, true);
  const laps = dv.getUint8(7);
  const count = dv.getUint32(8, true);
  if (12 + count * 5 !== u8.byteLength) throw new Error('trace: length mismatch');
  const runs = [];
  let ticks = 0;
  let o = 12;
  for (let i = 0; i < count; i++) {
    const n = dv.getUint16(o, true);
    if (n < 1) throw new Error('trace: empty run at ' + i);
    runs.push([n, dv.getInt8(o + 2), dv.getInt8(o + 3), dv.getUint8(o + 4) ? 1 : 0]);
    ticks += n;
    o += 5;
  }
  if (ticks > MAX_TICKS) throw new Error('trace: too long (' + ticks + ' ticks)');
  return { v, tickHz, laps, ticks, runs, digests: extra.digests || [], client: extra.client || {}, track: extra.track || 'sorrel-cove' };
}

/** expand the runs back into one input object per tick */
export function* traceFrames(trace) {
  for (const [n, throttle, steer, hop] of trace.runs) {
    const frame = { throttle, steer, hop: !!hop };
    for (let i = 0; i < n; i++) yield frame;
  }
}

export const toBase64 = (u8) => {
  if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
};

export const fromBase64 = (b64) => {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
};
