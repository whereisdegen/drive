/**
 * DRIVE  src/token/identity.js  (owner: token)
 *
 * Who set this time, when nobody has a wallet.
 *
 * A staked run is identified by the address that will claim the money. A run set for fun on a
 * team's shared board still has to be identified by SOMETHING, or every player collapses into one
 * leaderboard row - which is what happens if the client just sends a placeholder address.
 *
 * So each browser mints itself a random 20-byte id the first time it plays, and remembers it. It
 * is address-shaped on purpose: every path that already exists - the API's validation, the
 * oracle's store, the attestation - takes an address and needs no special case for a guest. It is
 * NOT a wallet: no key exists for it, so an attestation naming one can never be spent on chain,
 * which is exactly right for a run nobody staked.
 *
 * The display name is a label on top of that id, not the identity itself. Two players may pick
 * the same name; they still occupy separate rows, because the id underneath differs.
 *
 * A connected wallet always wins: real address, real attestation, real money.
 */
const ID_KEY = 'drive.guest.id';
const NAME_KEY = 'drive.guest.name';

const ADJECTIVES = ['Quick', 'Late', 'Loose', 'Tidy', 'Brave', 'Sideways', 'Patient', 'Wild', 'Smooth', 'Bold'];
const NOUNS = ['Kerb', 'Apex', 'Hairpin', 'Drift', 'Cove', 'Sunset', 'Quay', 'Chicane', 'Slipstream', 'Harbour'];

/** localStorage throws in some embedded and private contexts; a guest id is never worth a crash */
function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

/**
 * base58, the alphabet Solana uses. No 0, O, I or l, so an id cannot be misread aloud.
 *
 * This is written out rather than imported because identity.js loads on every visit, including
 * the guest-only path where no wallet code is fetched at all. Pulling in a library for thirty
 * lines of arithmetic would undo that.
 */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  // leading zero bytes carry no value but do carry length, and base58 spells each as '1'
  for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
  return out;
}

/**
 * A guest id, shaped like a Solana address: 32 random bytes, base58.
 *
 * It was 20 bytes of hex with an 0x prefix - an Ethereum address - and the oracle now rejects
 * that outright, so every guest submission would 400. Nobody holds a private key for this and
 * nothing can be signed with it; it exists so that a team sharing one deployment does not
 * collapse into a single leaderboard row.
 */
function randomGuestId() {
  const bytes = new Uint8Array(32);
  (globalThis.crypto || {}).getRandomValues?.(bytes);
  if (!bytes.some((b) => b)) for (let i = 0; i < 32; i++) bytes[i] = (Math.random() * 256) | 0;
  // a leading zero byte would make the id 43 characters instead of 44; harmless, but the
  // oracle's validator accepts 32-44 so either is fine
  return base58(bytes);
}

function randomName() {
  const pick = (a) => a[(Math.random() * a.length) | 0];
  return `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
}

/** the id this browser races under, minted and stored on first use */
export function guestId() {
  let id = read(ID_KEY);
  // an id from the Ethereum-shaped era fails this test and is silently reminted. Those players
  // lose their old board rows, which are unreachable anyway: the track id changed with the move
  // to Solana, so nothing recorded before it is still addressable.
  if (!id || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(id)) {
    id = randomGuestId();
    write(ID_KEY, id);
  }
  return id;
}

export function guestName() {
  let name = read(NAME_KEY);
  if (!name) {
    name = randomName();
    write(NAME_KEY, name);
  }
  return name;
}

export function setGuestName(name) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 24);
  if (!clean) return guestName();
  write(NAME_KEY, clean);
  return clean;
}

/**
 * True when this browser will not persist anything, so the guest id is remade on every reload and
 * a player's times never group together.
 *
 * Tests an actual write-read-delete round trip rather than looking for the id: the id is only
 * minted when a run is submitted, so checking for it reports every first-time visitor as
 * ephemeral.
 */
export function isEphemeral() {
  const probe = '__drive_probe__';
  try {
    localStorage.setItem(probe, '1');
    const ok = localStorage.getItem(probe) === '1';
    localStorage.removeItem(probe);
    return !ok;
  } catch {
    return true;
  }
}
