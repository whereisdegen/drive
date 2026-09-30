use anchor_lang::prelude::*;

/// Protocol settings and the two counters. One per deployment, at PDA ["config"].
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    /// two-step handover, so a typo cannot orphan the program
    pub pending_authority: Option<Pubkey>,
    /// the key whose Ed25519 signatures this program accepts as lap times
    pub oracle: Pubkey,
    /// receives the protocol fee
    pub treasury: Pubkey,
    /// the SPL mint everything is staked in
    pub stake_mint: Pubkey,
    /// protocol cut of a settled contest, in basis points; capped at MAX_FEE_BPS
    pub fee_bps: u16,
    pub duel_count: u64,
    pub pot_count: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum DuelStatus {
    Open,
    Accepted,
    Settled,
    Cancelled,
}

/// One head-to-head. PDA ["duel", id].
#[account]
#[derive(InitSpace)]
pub struct Duel {
    pub id: u64,
    pub challenger: Pubkey,
    /// Pubkey::default() until someone accepts
    pub opponent: Pubkey,
    pub stake: u64,
    /// the time to beat, in milliseconds
    pub target_ms: u32,
    pub track_id: [u8; 32],
    /// unaccepted duels can be cancelled after this
    pub join_by: i64,
    /// set on accept: the opponent must submit before this
    pub run_by: i64,
    pub accepted_at: i64,
    pub run_window: u32,
    /// what the opponent actually drove, once submitted
    pub result_ms: u32,
    pub status: DuelStatus,
    pub bump: u8,
    pub vault_bump: u8,
}

/// An open time attack. PDA ["pot", id].
#[account]
#[derive(InitSpace)]
pub struct Pot {
    pub id: u64,
    pub track_id: [u8; 32],
    pub entry_fee: u64,
    pub prize: u64,
    pub opens_at: i64,
    pub closes_at: i64,
    /// Pubkey::default() until someone posts a time
    pub leader: Pubkey,
    pub leader_ms: u32,
    pub entrants: u32,
    pub settled: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

/// One entrant's place in a pot. PDA ["entry", pot, entrant]. Its existence is the entry.
#[account]
#[derive(InitSpace)]
pub struct PotEntry {
    pub pot: Pubkey,
    pub entrant: Pubkey,
    /// 0 until they post one
    pub best_ms: u32,
    /// cleared on refund, so a refund cannot be taken twice
    pub refunded: bool,
    pub bump: u8,
}

/// A spent attestation. PDA ["nonce", driver, nonce].
///
/// On EVM this was `mapping(address => mapping(uint256 => bool))`. Here the ACCOUNT's existence
/// is the flag: `init` fails if it already exists, so replaying a nonce cannot even be
/// constructed as a transaction. Nothing is stored in it beyond the bump.
#[account]
#[derive(InitSpace)]
pub struct NonceMarker {
    pub driver: Pubkey,
    pub nonce: u64,
    pub bump: u8,
}
