/**
 * Shared test rig: a local validator, a mint that mimics TAO (9 decimals, classic SPL), and the
 * one thing these tests exist to exercise - building a real Ed25519 attestation the way the
 * oracle will.
 */
import anchor from '@coral-xyz/anchor';
import { readFileSync } from 'node:fs';
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, Ed25519Program,
  sendAndConfirmTransaction, SYSVAR_INSTRUCTIONS_PUBKEY,
} from '@solana/web3.js';
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

export const RPC = 'http://127.0.0.1:8899';
export const DECIMALS = 9;                 // TAO's decimals, so the arithmetic under test matches
export const ONE = 10n ** BigInt(DECIMALS);

export const idl = (name) =>
  JSON.parse(readFileSync(new URL(`../target/idl/${name}.json`, import.meta.url), 'utf8'));

/**
 * The oracle, derived from a fixed seed rather than generated.
 *
 * Each test file runs in its own process but they share one validator, and the config PDA is a
 * singleton for the life of the chain - so whichever suite runs first initialises it, and the
 * rest must be able to sign as the same oracle. A deterministic keypair is the simplest way for
 * every process to agree without passing secrets between them.
 */
export function oracleKeypair() {
  return Keypair.fromSeed(Buffer.alloc(32, 42));
}

/**
 * The mint authority, deterministic for the same reason as the oracle: the mint is created by
 * whichever suite runs first, and every other suite still has to be able to mint test balances
 * against it. It only ever signs - the fee payer is separate - so it needs no SOL.
 */
export function mintAuthority() {
  return Keypair.fromSeed(Buffer.alloc(32, 43));
}

/** the config PDA, and the mint it was initialised with (suites must use that one, not their own) */
export async function ensureConfig(program, admin, conn, { treasury, makeNewMint }) {
  const config = pda([Buffer.from('config')], program.programId);
  const existing = await conn.getAccountInfo(config);
  if (existing) {
    const cfg = await program.account.config.fetch(config);
    return { config, stakeMint: cfg.stakeMint, fresh: false };
  }
  const mint = await makeNewMint();
  await program.methods
    .initialize(oracleKeypair().publicKey, 250)
    .accounts({ config, authority: admin.publicKey, treasury, stakeMint: mint,
                systemProgram: SystemProgram.programId })
    .signers([admin]).rpc();
  return { config, stakeMint: mint, fresh: true };
}

export function connection() {
  return new Connection(RPC, 'confirmed');
}

export async function funded(conn, sol = 50) {
  const kp = Keypair.generate();
  const sig = await conn.requestAirdrop(kp.publicKey, sol * 1_000_000_000);
  await conn.confirmTransaction(sig, 'confirmed');
  return kp;
}

export function provider(conn, wallet) {
  return new anchor.AnchorProvider(conn, new anchor.Wallet(wallet), { commitment: 'confirmed' });
}

/** the exact bytes race_stakes reconstructs and compares against; see attest.rs */
export function runMessage(run) {
  const b = Buffer.alloc(12 + 32 + 32 + 4 + 32 + 8 + 8 + 8);
  let o = 0;
  b.write('DRIVE:run:v1', o); o += 12;
  run.driver.toBuffer().copy(b, o); o += 32;
  Buffer.from(run.trackId).copy(b, o); o += 32;
  b.writeUInt32LE(run.timeMs, o); o += 4;
  Buffer.from(run.traceHash).copy(b, o); o += 32;
  b.writeBigInt64LE(BigInt(run.issuedAt), o); o += 8;
  b.writeBigInt64LE(BigInt(run.deadline), o); o += 8;
  b.writeBigUInt64LE(BigInt(run.nonce), o);
  return b;
}

/** reward_vault's day message; see reward_vault/src/attest.rs */
export function dayMessage({ day, winners, timesMs, deadline }) {
  const b = Buffer.alloc(12 + 8 + 1 + winners.length * 36 + 8);
  let o = 0;
  b.write('DRIVE:day:v1', o); o += 12;
  b.writeBigUInt64LE(BigInt(day), o); o += 8;
  b.writeUInt8(winners.length, o); o += 1;
  for (let i = 0; i < winners.length; i++) {
    winners[i].toBuffer().copy(b, o); o += 32;
    b.writeUInt32LE(timesMs[i], o); o += 4;
  }
  b.writeBigInt64LE(BigInt(deadline), o);
  return b;
}

/**
 * The Ed25519 instruction that must sit in front of ours. The program reads this back through
 * the instructions sysvar and checks every field of it, so this is the real thing, not a stub.
 */
export function ed25519Ix(oracleKeypair, message) {
  return Ed25519Program.createInstructionWithPrivateKey({
    privateKey: oracleKeypair.secretKey,
    message,
  });
}

/**
 * Wait until the CHAIN's clock passes `target`, rather than sleeping a fixed number of
 * milliseconds and hoping.
 *
 * The validator's clock runs a second or two behind wall clock and the gap is not constant, so
 * "createPot closing in 3s, then sleep 6s" is a race: sometimes the chain has not reached the
 * close yet and settle_pot correctly refuses. Poll what the program will actually read.
 */
export async function waitForChainTime(conn, target, { timeoutMs = 90_000 } = {}) {
  const started = Date.now();
  for (;;) {
    const slot = await conn.getSlot('confirmed');
    const t = await conn.getBlockTime(slot);
    if (t !== null && t >= target) return t;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`chain clock did not reach ${target} within ${timeoutMs}ms (last ${t})`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

export async function chainNow(conn) {
  const slot = await conn.getSlot('confirmed');
  return conn.getBlockTime(slot);
}

export async function makeMint(conn, payer) {
  return createMint(conn, payer, mintAuthority().publicKey, null, DECIMALS, undefined, { commitment: 'confirmed' }, TOKEN_PROGRAM_ID);
}

export async function tokenAccount(conn, payer, mint, owner, amount = 0n) {
  const ata = await getOrCreateAssociatedTokenAccount(conn, payer, mint, owner, false, 'confirmed', undefined, TOKEN_PROGRAM_ID);
  if (amount > 0n) {
    await mintTo(conn, payer, mint, ata.address, mintAuthority(), amount, [], { commitment: 'confirmed' }, TOKEN_PROGRAM_ID);
  }
  return ata.address;
}

export async function balance(conn, ata) {
  return (await getAccount(conn, ata, 'confirmed', TOKEN_PROGRAM_ID)).amount;
}

/**
 * DIAGNOSTIC HAZARD, worth knowing before debugging a failure here.
 *
 * When a transaction fails, Anchor 0.32's provider re-wraps the error as
 * `new SendTransactionError(message, logs)` - the old positional signature. web3.js 1.95 changed
 * that constructor to take an options object, so `action` arrives undefined and the class throws
 * away the real message and logs, reporting only:
 *
 *     Error: Unknown action 'undefined'
 *
 * That string means "a transaction failed and the reason was destroyed in transit". It is not a
 * clue about what failed. To see the actual cause, re-run the one failing case with
 * `simulate()` instead of `rpc()`, or read the validator log, which still has the program output.
 */
export const pda = (seeds, programId) => PublicKey.findProgramAddressSync(seeds, programId)[0];
export const leU64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

export { anchor, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
         SYSVAR_INSTRUCTIONS_PUBKEY, TOKEN_PROGRAM_ID };
