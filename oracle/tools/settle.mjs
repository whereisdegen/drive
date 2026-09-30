/**
 * DRIVE  oracle/tools/settle.mjs
 *
 * Settles finished days on reward_vault. Run it from cron just after midnight UTC:
 *
 *     5 0 * * *  cd /path/to/drive/oracle && node tools/settle.mjs >> settle.log 2>&1
 *
 * Settling is permissionless - the oracle's signature is what makes the standings count, not who
 * sends the transaction - so this is a convenience, not a privileged job. If it never runs,
 * nothing is lost: any winner can settle their own day from the game's Daily tab, and the prizes
 * stay claimable for 90 days from whenever settlement happens.
 *
 * It walks back over the claim window and settles anything closed but unsettled, so a few days
 * of downtime cost nothing.
 *
 *   SETTLER_KEYPAIR   the key that pays the fee and the day account's rent. Needs SOL, and
 *                     nothing else - it is not the oracle and has no authority over anything.
 *                     Defaults to the oracle's own key, which is fine on a local validator.
 *   LOOKBACK_DAYS     how far back to check (default 7)
 *   DRY_RUN=1         report what it would do and send nothing
 *
 * ONE DIFFERENCE FROM THE EVM VERSION WORTH KNOWING. There, settling cost gas and nothing else.
 * Here it also allocates a `day` account, and the sender pays its rent - a few thousand lamports,
 * permanently. So a settler with no SOL fails in a way that looks like a program error but is
 * not; the balance is checked up front and reported plainly instead.
 */
import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey, Transaction, Ed25519Program, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, sendAndConfirmTransaction } from '@solana/web3.js';
import anchor from '@coral-xyz/anchor';

import { CHAINLESS, CLUSTER, RPC_URL, REWARD_VAULT_PROGRAM, DEV_ORACLE_SEED, ORACLE_ADDRESS } from '../config.mjs';
import { attestDay, dayOf, dayMessage } from '../daily.mjs';
import { trackFingerprint, TRACK_ID } from '../replay.mjs';
import { trackIdOf } from '../attest.mjs';

const DRY = process.env.DRY_RUN === '1';
const LOOKBACK = Number(process.env.LOOKBACK_DAYS || 7);

if (CHAINLESS) {
  console.error('[settle] CLUSTER is unset, so there is no vault to settle on. Set CLUSTER first.');
  process.exit(1);
}

/** the payer. A solana CLI keypair file, or the development key on a local validator. */
const settler = process.env.SETTLER_KEYPAIR
  ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.SETTLER_KEYPAIR.replace(/^~/, process.env.HOME), 'utf8'))))
  : Keypair.fromSeed(Buffer.alloc(32, DEV_ORACLE_SEED));

const connection = new Connection(RPC_URL, 'confirmed');
const programId = new PublicKey(REWARD_VAULT_PROGRAM);
// the oracle's own copy, refreshed by tools/sync-idl.mjs. NOT read out of solana/target: the
// deployed image contains only game/ and oracle/, so that path exists on a laptop and nowhere else.
const idl = JSON.parse(readFileSync(new URL('../idl/reward_vault.json', import.meta.url), 'utf8'));
const program = new anchor.Program(idl, new anchor.AnchorProvider(connection, new anchor.Wallet(settler), { commitment: 'confirmed' }));

const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, programId)[0];
const configPda = pda([Buffer.from('config')]);
const vaultPda = pda([Buffer.from('vault')]);
const dayPda = (day) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(day));
  return pda([Buffer.from('day'), b]);
};

const trackId = trackIdOf(TRACK_ID, await trackFingerprint());
const today = dayOf();

// the vault has to exist before any of this means anything. A missing config is the normal state
// of a cluster nobody has run `initialize` on, so say that rather than failing on a decode.
const config = await program.account.vaultConfig.fetchNullable(configPda);
if (!config) {
  console.error(`[settle] reward_vault has no config on ${CLUSTER} - it has not been initialised yet`);
  process.exit(1);
}

const vault = await connection.getTokenAccountBalance(vaultPda);
const decimals = vault.value.decimals;
const amount = (v) => (Number(v) / 10 ** decimals).toLocaleString('en-US', { maximumFractionDigits: 4 });
const held = BigInt(vault.value.amount);
const pool = held - BigInt(config.owed.toString());

console.log(`[settle] ${new Date().toISOString()} vault ${vaultPda.toBase58()} on ${CLUSTER} as ${settler.publicKey.toBase58()}${DRY ? ' (dry run)' : ''}`);
console.log(`[settle] pool ${amount(pool)} TAO, next payout ${amount((pool * 1000n) / 10000n)} TAO (owed ${amount(config.owed.toString())} already)`);

const lamports = await connection.getBalance(settler.publicKey);
if (lamports === 0 && !DRY) {
  console.error(`[settle] ${settler.publicKey.toBase58()} holds no SOL; it cannot pay the fee or the day account's rent`);
  process.exit(1);
}

// Catch a mismatched oracle here rather than one signature at a time. This is the single most
// likely misconfiguration after a redeploy, and on chain it looks like WrongOracleKey on every
// day forever rather than like a settings problem.
if (config.oracle.toBase58() !== ORACLE_ADDRESS) {
  console.error(`[settle] the vault trusts oracle ${config.oracle.toBase58()} but this process signs`);
  console.error(`[settle] as ${ORACLE_ADDRESS} - every signature would be rejected`);
  process.exit(1);
}

let settled = 0, skipped = 0;
for (let day = today - 1; day >= today - LOOKBACK; day--) {
  // the day account existing IS "already settled": the program creates it with `init`, so a
  // second settlement cannot be built at all. No boolean to read and no race to lose.
  if (await connection.getAccountInfo(dayPda(day))) { skipped++; continue; }

  const att = await attestDay(day, { trackId });
  if (!att.ok) { console.log(`[settle] day ${day}: ${att.reason}`); skipped++; continue; }

  const r = att.attestation.result;
  console.log(`[settle] day ${day}: ${r.winners.length} winner(s), fastest ${(r.timesMs[0] / 1000).toFixed(3)}s`);
  if (DRY) { settled++; continue; }

  try {
    const result = {
      day: new anchor.BN(r.day),
      winners: r.winners.map((w) => new PublicKey(w)),
      timesMs: r.timesMs.map(Number),
      deadline: new anchor.BN(r.deadline),
    };

    // The Ed25519 instruction goes FIRST and the program is told where to find it. Index 0 here,
    // which is also what ed25519IxIndex says - the program reads the sysvar at exactly that
    // index and compares the message byte for byte, so the two must agree.
    const sigIx = Ed25519Program.createInstructionWithPublicKey({
      publicKey: new PublicKey(att.attestation.signer).toBytes(),
      message: dayMessage({ ...r, deadline: BigInt(r.deadline) }),
      signature: Buffer.from(att.attestation.signature, 'base64'),
    });

    const settleIx = await program.methods
      .settleDay(new anchor.BN(r.day), result, 0)
      .accounts({
        payer: settler.publicKey,
        systemProgram: SystemProgram.programId,
        config: configPda,
        vault: vaultPda,
        dayResult: dayPda(day),
        ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    const tx = new Transaction().add(sigIx, settleIx);
    const sig = await sendAndConfirmTransaction(connection, tx, [settler], { commitment: 'confirmed' });
    console.log(`[settle] day ${day} settled in ${sig}`);
    settled++;
  } catch (e) {
    // an Anchor error buries the useful line in a log array; dig it out rather than printing 200 lines
    const logs = e?.logs?.filter((l) => l.includes('Error') || l.includes('failed')) || [];
    console.error(`[settle] day ${day} FAILED: ${String(e.message).split('\n')[0]}${logs.length ? '\n           ' + logs[0] : ''}`);
  }
}
console.log(`[settle] done: ${settled} settled, ${skipped} skipped`);
