//! The oracle's signed standings for one UTC day.
//!
//! Same mechanism as race_stakes: Solana cannot recover a signature in-program, so the caller
//! puts an Ed25519 instruction ahead of ours and we read it back through the instructions
//! sysvar, checking every field. See race_stakes/src/attest.rs for why each check is there.

use anchor_lang::prelude::*;
use solana_instructions_sysvar::load_instruction_at_checked;
use solana_sdk_ids::{ed25519_program, sysvar::instructions::ID as IX_SYSVAR_ID};

use crate::errors::VaultError;

pub const DAY_DOMAIN: &[u8; 12] = b"DRIVE:day:v1";
pub const PLACES: usize = 5;

/// One day's standings, fastest first.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct DayResult {
    /// unix day index: floor(timestamp / 86400), so days are UTC by construction on both sides
    pub day: u64,
    /// rank order, at most PLACES, no repeats
    pub winners: Vec<Pubkey>,
    /// the verified times behind the ranking, for the record
    pub times_ms: Vec<u32>,
    pub deadline: i64,
}

impl DayResult {
    /// The exact bytes the oracle signs. Length-prefixed by COUNT so a shorter winner list can
    /// never be read as a longer one with trailing rubbish.
    pub fn message(&self) -> Vec<u8> {
        let mut m = Vec::with_capacity(12 + 8 + 1 + self.winners.len() * 36 + 8);
        m.extend_from_slice(DAY_DOMAIN);
        m.extend_from_slice(&self.day.to_le_bytes());
        m.push(self.winners.len() as u8);
        for (w, t) in self.winners.iter().zip(self.times_ms.iter()) {
            m.extend_from_slice(w.as_ref());
            m.extend_from_slice(&t.to_le_bytes());
        }
        m.extend_from_slice(&self.deadline.to_le_bytes());
        m
    }
}

const SIG_LEN: usize = 64;
const KEY_LEN: usize = 32;

fn u16_at(data: &[u8], at: usize) -> Result<usize> {
    let bytes: [u8; 2] = data
        .get(at..at + 2)
        .ok_or(VaultError::MalformedEd25519Ix)?
        .try_into()
        .map_err(|_| VaultError::MalformedEd25519Ix)?;
    Ok(u16::from_le_bytes(bytes) as usize)
}

pub fn verify_oracle_signature(
    ix_sysvar: &AccountInfo,
    ed25519_ix_index: u8,
    oracle: &Pubkey,
    expected_message: &[u8],
) -> Result<()> {
    require_keys_eq!(*ix_sysvar.key, IX_SYSVAR_ID, VaultError::WrongSysvar);

    let ix = load_instruction_at_checked(ed25519_ix_index as usize, ix_sysvar)
        .map_err(|_| error!(VaultError::MissingEd25519Ix))?;
    require_keys_eq!(ix.program_id, ed25519_program::ID, VaultError::NotEd25519Program);
    require!(ix.accounts.is_empty(), VaultError::MalformedEd25519Ix);

    let data = &ix.data;
    require!(data.len() >= 2, VaultError::MalformedEd25519Ix);
    require!(data[0] == 1, VaultError::MalformedEd25519Ix);

    let base = 2;
    let sig_offset = u16_at(data, base)?;
    let sig_ix_index = u16_at(data, base + 2)?;
    let key_offset = u16_at(data, base + 4)?;
    let key_ix_index = u16_at(data, base + 6)?;
    let msg_offset = u16_at(data, base + 8)?;
    let msg_size = u16_at(data, base + 10)?;
    let msg_ix_index = u16_at(data, base + 12)?;

    const THIS_IX: usize = u16::MAX as usize;
    require!(
        sig_ix_index == THIS_IX && key_ix_index == THIS_IX && msg_ix_index == THIS_IX,
        VaultError::MalformedEd25519Ix
    );

    let key = data.get(key_offset..key_offset + KEY_LEN).ok_or(VaultError::MalformedEd25519Ix)?;
    require!(data.get(sig_offset..sig_offset + SIG_LEN).is_some(), VaultError::MalformedEd25519Ix);
    let message = data.get(msg_offset..msg_offset + msg_size).ok_or(VaultError::MalformedEd25519Ix)?;

    require!(key == oracle.as_ref(), VaultError::WrongOracleKey);
    require!(message == expected_message, VaultError::MessageMismatch);
    Ok(())
}
