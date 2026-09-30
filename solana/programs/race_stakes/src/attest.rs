//! Verifying that the oracle really said what the player claims it said.
//!
//! On EVM this was `ECDSA.recover` inside the contract: cheap, self-contained, and the player
//! carried the signature. Solana has no equivalent instruction - signature verification happens
//! in the separate Ed25519 native program, which runs as its OWN instruction in the same
//! transaction and leaves no return value.
//!
//! So the pattern is: the player puts an `Ed25519Program` instruction in front of ours, and we
//! read the instructions sysvar to inspect it. That is only evidence if we check every field of
//! it ourselves - a naive implementation that merely confirms "an ed25519 instruction exists"
//! verifies nothing at all, because the attacker chose its contents. We check that the signature
//! was made by OUR oracle key, over EXACTLY the message we reconstruct from the accounts and
//! arguments at hand, and that it is a single-signature instruction so a second, unchecked
//! signature cannot ride along.
//!
//! This keeps the property the EVM design had: the oracle signs offline, the player submits, and
//! the oracle never has to co-sign a transaction or be online at settlement time.

use anchor_lang::prelude::*;
use solana_instructions_sysvar::load_instruction_at_checked;
use solana_sdk_ids::{ed25519_program, sysvar::instructions::ID as IX_SYSVAR_ID};

use crate::errors::RaceError;

/// Domain tag, so a signature over a run can never be read as a signature over anything else
/// this project might sign in future.
pub const RUN_DOMAIN: &[u8; 12] = b"DRIVE:run:v1";

/// The claim the oracle makes about one recorded run. Mirrors the EVM `Run` struct field for
/// field, so the same oracle logic produces both.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct Run {
    /// the only wallet that may present this attestation
    pub driver: Pubkey,
    /// the circuit it was set on: spline plus every collider (see docs/DETERMINISM.md)
    pub track_id: [u8; 32],
    /// total race time in milliseconds, as MEASURED by the oracle's replay - never as claimed
    pub time_ms: u32,
    /// hash of the canonical input trace, so the run behind a time stays auditable
    pub trace_hash: [u8; 32],
    /// when the oracle verified it; contests require a time set after they began
    pub issued_at: i64,
    /// unix seconds after which this signature is dead
    pub deadline: i64,
    /// single use, per driver
    pub nonce: u64,
}

impl Run {
    /// The exact bytes the oracle signs. Fixed width and fixed order: no lengths, no delimiters,
    /// nothing whose interpretation could shift between signer and verifier.
    pub fn message(&self) -> Vec<u8> {
        let mut m = Vec::with_capacity(12 + 32 + 32 + 4 + 32 + 8 + 8 + 8);
        m.extend_from_slice(RUN_DOMAIN);
        m.extend_from_slice(self.driver.as_ref());
        m.extend_from_slice(&self.track_id);
        m.extend_from_slice(&self.time_ms.to_le_bytes());
        m.extend_from_slice(&self.trace_hash);
        m.extend_from_slice(&self.issued_at.to_le_bytes());
        m.extend_from_slice(&self.deadline.to_le_bytes());
        m.extend_from_slice(&self.nonce.to_le_bytes());
        m
    }
}

/// One entry in the Ed25519 program's instruction data. 14 bytes, little endian.
const OFFSETS_LEN: usize = 14;
const SIG_LEN: usize = 64;
const KEY_LEN: usize = 32;

fn u16_at(data: &[u8], at: usize) -> Result<usize> {
    let bytes: [u8; 2] = data
        .get(at..at + 2)
        .ok_or(RaceError::MalformedEd25519Ix)?
        .try_into()
        .map_err(|_| RaceError::MalformedEd25519Ix)?;
    Ok(u16::from_le_bytes(bytes) as usize)
}

/// Confirm that an `Ed25519Program` instruction in THIS transaction signs `expected_message`
/// with `oracle`.
///
/// `ix_sysvar` must be the instructions sysvar. The Ed25519 instruction is looked up by index,
/// which the caller passes in, so a player can place it anywhere ahead of ours.
pub fn verify_oracle_signature(
    ix_sysvar: &AccountInfo,
    ed25519_ix_index: u8,
    oracle: &Pubkey,
    expected_message: &[u8],
) -> Result<()> {
    require_keys_eq!(*ix_sysvar.key, IX_SYSVAR_ID, RaceError::WrongSysvar);

    let ix = load_instruction_at_checked(ed25519_ix_index as usize, ix_sysvar)
        .map_err(|_| error!(RaceError::MissingEd25519Ix))?;

    // it must be the real native program, not something that merely looks like it
    require_keys_eq!(ix.program_id, ed25519_program::ID, RaceError::NotEd25519Program);
    require!(ix.accounts.is_empty(), RaceError::MalformedEd25519Ix);

    let data = &ix.data;
    require!(data.len() >= 2, RaceError::MalformedEd25519Ix);

    // Exactly one signature. More than one would mean fields we are not checking, and a
    // verifier that ignores part of what it is shown is not a verifier.
    let count = data[0];
    require!(count == 1, RaceError::MalformedEd25519Ix);

    let base = 2;
    let sig_offset = u16_at(data, base)?;
    let sig_ix_index = u16_at(data, base + 2)?;
    let key_offset = u16_at(data, base + 4)?;
    let key_ix_index = u16_at(data, base + 6)?;
    let msg_offset = u16_at(data, base + 8)?;
    let msg_size = u16_at(data, base + 10)?;
    let msg_ix_index = u16_at(data, base + 12)?;
    let _ = OFFSETS_LEN;

    // u16::MAX means "this instruction". Anything else points at a DIFFERENT instruction, whose
    // contents we have not inspected - refuse rather than verify half a claim.
    const THIS_IX: usize = u16::MAX as usize;
    require!(
        sig_ix_index == THIS_IX && key_ix_index == THIS_IX && msg_ix_index == THIS_IX,
        RaceError::MalformedEd25519Ix
    );

    let key = data
        .get(key_offset..key_offset + KEY_LEN)
        .ok_or(RaceError::MalformedEd25519Ix)?;
    require!(
        data.get(sig_offset..sig_offset + SIG_LEN).is_some(),
        RaceError::MalformedEd25519Ix
    );
    let message = data
        .get(msg_offset..msg_offset + msg_size)
        .ok_or(RaceError::MalformedEd25519Ix)?;

    // signed by OUR oracle, over EXACTLY the message we reconstructed
    require!(key == oracle.as_ref(), RaceError::WrongOracleKey);
    require!(message == expected_message, RaceError::MessageMismatch);

    Ok(())
}
