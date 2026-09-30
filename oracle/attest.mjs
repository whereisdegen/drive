/**
 * DRIVE  oracle/attest.mjs
 *
 * Turns a verified replay into the signed `Run` that race_stakes will accept. This is the only
 * place the oracle key is used, and it signs exactly one kind of statement:
 *
 *   "I re-drove driver D's inputs (trace hash H) on track T at time I, and they took N ms."
 *
 * The signature is bound to the driver, so nobody else can present it; to the trace, so the
 * claim is auditable against the bytes that produced it; to the track, so a time cannot be
 * carried to different geometry; to an issue time, so a banked run cannot ambush a fresh
 * opponent; and to a single-use nonce with a short expiry, so it cannot be replayed or stored.
 *
 * WHAT CHANGED FROM EVM, AND WHY IT MATTERS HERE.
 *
 * EIP-712 hashed a typed struct and the contract recovered the signer with ECDSA. Solana has no
 * in-program recover, so the player puts an Ed25519 instruction ahead of ours and the program
 * reads it back out of the instructions sysvar (race_stakes/src/attest.rs). The consequence for
 * this file is that there is no hashing and no domain separator object: the program compares the
 * signed message BYTE FOR BYTE against bytes it rebuilds itself. A field encoded one byte wider
 * here than there does not produce a wrong answer, it produces MessageMismatch on every single
 * attestation - so the layout is written once, as a table, and asserted against the Rust in
 * test/attest.test.mjs.
 */
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { keypair, ORACLE_ADDRESS, ATTESTATION_TTL } from './config.mjs';
import { signMessage, randomNonce } from './keys.mjs';
import { now as chainNow } from './chainclock.mjs';

/** must equal RUN_DOMAIN in programs/race_stakes/src/attest.rs */
export const RUN_DOMAIN = Buffer.from('DRIVE:run:v1', 'utf8');

/**
 * The wire layout of the message, in order. Mirrors `impl Run { fn message() }`: fixed width,
 * fixed order, no lengths and no delimiters, so nothing's interpretation can shift between
 * signer and verifier. Little endian throughout, because that is what Rust's to_le_bytes does.
 */
export const RUN_LAYOUT = [
  ['driver', 'pubkey', 32],
  ['trackId', 'bytes32', 32],
  ['timeMs', 'u32', 4],
  ['traceHash', 'bytes32', 32],
  ['issuedAt', 'i64', 8],
  ['deadline', 'i64', 8],
  ['nonce', 'u64', 8],
];

export const RUN_MESSAGE_LEN = RUN_DOMAIN.length + RUN_LAYOUT.reduce((n, [, , w]) => n + w, 0);

/** hex or Buffer or Uint8Array -> exactly 32 bytes */
function bytes32(v, what) {
  const b = typeof v === 'string' ? Buffer.from(v.replace(/^0x/, ''), 'hex') : Buffer.from(v);
  if (b.length !== 32) throw new Error(`${what} must be 32 bytes, got ${b.length}`);
  return b;
}

/**
 * The exact bytes the oracle signs, and the exact bytes the program rebuilds.
 * @param {{driver:string, trackId:string, timeMs:number, traceHash:string, issuedAt:bigint|number, deadline:bigint|number, nonce:bigint}} run
 */
export function runMessage(run) {
  const parts = [RUN_DOMAIN];
  for (const [name, kind, width] of RUN_LAYOUT) {
    const v = run[name];
    if (kind === 'pubkey') { parts.push(Buffer.from(new PublicKey(v).toBytes())); continue; }
    if (kind === 'bytes32') { parts.push(bytes32(v, name)); continue; }
    const b = Buffer.alloc(width);
    if (kind === 'u32') b.writeUInt32LE(Number(v), 0);
    else if (kind === 'u64') b.writeBigUInt64LE(BigInt(v), 0);
    else if (kind === 'i64') b.writeBigInt64LE(BigInt(v), 0);
    else throw new Error(`unknown field kind ${kind}`);
    parts.push(b);
  }
  const m = Buffer.concat(parts);
  if (m.length !== RUN_MESSAGE_LEN) throw new Error(`run message is ${m.length} bytes, expected ${RUN_MESSAGE_LEN}`);
  return m;
}

const sha256 = (b) => createHash('sha256').update(b).digest();

/**
 * The track's identity: its NAME and the fingerprint of its geometry, so a re-cut circuit is a
 * different track and a time cannot follow the old name onto new corners.
 *
 * sha256 rather than the keccak256 this used on EVM - it is the hash Solana programs have
 * natively, so anything that ever needs to recompute a track id on chain can.
 */
export const trackIdOf = (name, fingerprint) => sha256(Buffer.from(`${name}:${fingerprint}`, 'utf8')).toString('hex');

export const traceHashOf = (bytes) => sha256(Buffer.from(bytes)).toString('hex');

/**
 * @param {object} o
 * @param {string} o.driver       base58 wallet that will present this attestation
 * @param {string} o.trackId
 * @param {number} o.timeMs       the oracle's own measured time, never the client's
 * @param {Uint8Array} o.traceBytes
 */
export async function signRun({ driver, trackId, timeMs, traceBytes }) {
  // stamped in the chain's frame, because the program will judge issuedAt against
  // Clock::get() and the two clocks drift (see chainclock.mjs)
  const now = await chainNow();
  const run = {
    driver,
    trackId,
    timeMs,
    traceHash: traceHashOf(traceBytes),
    issuedAt: BigInt(now),
    deadline: BigInt(now + ATTESTATION_TTL),
    nonce: randomNonce(),
  };
  const signature = signMessage(keypair, runMessage(run));
  return { run: serialise(run), signature: signature.toString('base64'), signer: ORACLE_ADDRESS };
}

/**
 * bigints do not survive JSON, and the client has to hand these to Anchor as BN and byte arrays.
 * Hashes stay hex because that is what they are; the driver stays base58 because that is what a
 * Solana address is, and converting it here would only invite the client to convert it back.
 */
export function serialise(run) {
  return {
    driver: run.driver,
    trackId: run.trackId,
    timeMs: Number(run.timeMs),
    traceHash: run.traceHash,
    issuedAt: run.issuedAt.toString(),
    deadline: run.deadline.toString(),
    nonce: run.nonce.toString(),
  };
}
