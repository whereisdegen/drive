/**
 * DRIVE  oracle/keys.mjs
 *
 * The oracle's Ed25519 identity, and the one function that uses it.
 *
 * Signing needs no library. Ed25519 is deterministic - one message and one key produce exactly
 * one signature - so node's built-in crypto and the signature the Solana tooling would make are
 * the same 64 bytes, not merely both valid. That is asserted in test/attest.test.mjs against
 * `Ed25519Program`'s own instruction encoding, because "should be identical" is not a thing to
 * take on faith when a mismatch means every attestation is rejected on chain.
 *
 * What the key CANNOT do is worth stating: it is not a spending key. It holds no SOL, owns no
 * token account, and is not the upgrade authority. Its whole power is to state lap times - which
 * is enough to award every prize to an attacker's own wallet, and is why assertSignerIsSafe()
 * in config.mjs refuses to start with a key anyone else could have.
 */
import { createPrivateKey, sign, randomBytes } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { Keypair, PublicKey } from '@solana/web3.js';

/**
 * PKCS#8 wrapper for a bare Ed25519 seed. Fixed 16 bytes: SEQUENCE, version 0, the
 * id-Ed25519 OID (1.3.101.112), then the 32 byte seed as an OCTET STRING. node's
 * createPrivateKey wants DER; the Solana world passes seeds around naked.
 */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * The 64 byte "secret key" Solana tools use is seed || publicKey. Only the first half is
 * secret material; the second half is derived. We keep both: the seed to sign with, the
 * public half to publish.
 */
function fromSeed(seed) {
  if (seed.length !== 32) throw new Error(`ed25519 seed must be 32 bytes, got ${seed.length}`);
  const kp = Keypair.fromSeed(seed);
  return {
    publicKey: kp.publicKey,
    address: kp.publicKey.toBase58(),
    // held as a node KeyObject, so the raw bytes are not sitting in a plain Buffer we might log
    signer: createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' }),
  };
}

/** base58, no 0 O I l - the alphabet Solana uses for keys and addresses */
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** True for a string that is a real 32 byte public key, not merely base58-shaped. */
export function isAddress(s) {
  if (typeof s !== 'string' || !BASE58.test(s)) return false;
  try {
    return new PublicKey(s).toBytes().length === 32;
  } catch {
    return false;
  }
}

/**
 * Solana addresses are base58 and CASE SENSITIVE: `Foo` and `foo` are different keys, and
 * lowercasing one to compare it - the habit every EVM codebase teaches - silently merges or
 * loses drivers. Comparison is therefore exact, and this function exists so that intent is
 * visible at every call site rather than implied by the absence of a .toLowerCase().
 */
export const sameAddress = (a, b) => typeof a === 'string' && typeof b === 'string' && a === b;

/**
 * Read a signing key from the environment.
 *
 * Accepts what a Solana operator already has: a path to a CLI keypair file (the usual
 * `~/.config/solana/id.json`), or the 64 element JSON array itself, or a base58 secret key as
 * exported by the wallets. A path is the one to prefer - a key in a file can be chmod 600 and
 * is not inherited by every child process the way an environment variable is.
 */
export function loadKeypair(spec) {
  const raw = String(spec || '').trim();
  if (!raw) throw new Error('no keypair given');

  // a path to a solana CLI keypair file
  const path = raw.replace(/^~/, process.env.HOME || '~');
  if (!raw.startsWith('[') && existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error(`${path} is not a solana keypair file`);
    return fromSeed(Buffer.from(parsed.slice(0, 32)));
  }

  // the array inline
  if (raw.startsWith('[')) return fromSeed(Buffer.from(JSON.parse(raw).slice(0, 32)));

  // base58: 64 bytes is seed||pubkey, 32 bytes is a bare seed
  const bytes = Buffer.from(bs58decode(raw));
  if (bytes.length === 64) return fromSeed(bytes.subarray(0, 32));
  if (bytes.length === 32) return fromSeed(bytes);
  throw new Error(`a base58 secret key must decode to 32 or 64 bytes, got ${bytes.length}`);
}

/** web3.js keeps its base58 private; one small decoder is cheaper than another dependency */
function bs58decode(s) {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const ch of s) {
    const v = A.indexOf(ch);
    if (v < 0) throw new Error('not base58');
    n = n * 58n + BigInt(v);
  }
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of s) { if (ch !== '1') break; out.unshift(0); }   // leading zero bytes
  return out;
}

/** a keypair from a 32 byte seed, for tests and for the published development key */
export const keypairFromSeed = (byte) => fromSeed(Buffer.alloc(32, byte));

/** 64 raw signature bytes over `message`, which is what the Ed25519 native program wants */
export const signMessage = (keypair, message) => sign(null, Buffer.from(message), keypair.signer);

/** a fresh u64 nonce. The programs mark spent nonces with a PDA, so this only has to not collide. */
export const randomNonce = () => randomBytes(8).readBigUInt64LE(0);
