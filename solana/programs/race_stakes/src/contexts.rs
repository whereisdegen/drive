//! Account contexts.
//!
//! On EVM most of these checks were `require` statements in the function body. Here they are
//! constraints on the accounts themselves, which the runtime enforces before a single line of
//! the instruction runs. Two are worth pointing out because they replace logic rather than
//! syntax:
//!
//!   - `nonce_marker` is `init`. Creating it IS the "this attestation is spent" write, and a
//!     replay fails at account creation - there is no code path to guard.
//!   - `entry` on `enter_pot` is `init` for the same reason: entering twice cannot be built.
//!
//! Every vault is a PDA token account owned by its own contest, so no duel or pot can ever be
//! paid out of another's money.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::attest::Run;
use crate::errors::RaceError;
use crate::state::*;

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: recorded only; the token account it settles into is checked at payout time
    pub treasury: UncheckedAccount<'info>,
    pub stake_mint: InterfaceAccount<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = authority @ RaceError::NotParticipant)]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetTreasury<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = authority @ RaceError::NotParticipant)]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
    /// CHECK: recorded only
    pub treasury: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    pub next_authority: Signer<'info>,
}

// ---------------------------------------------------------------- duels

#[derive(Accounts)]
#[instruction(duel_id: u64, nonce: u64)]
pub struct OpenDuel<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub challenger: Signer<'info>,

    #[account(address = config.stake_mint @ RaceError::WrongMint)]
    pub stake_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,

    #[account(
        init,
        payer = challenger,
        space = 8 + Duel::INIT_SPACE,
        seeds = [b"duel", duel_id.to_le_bytes().as_ref()],
        bump
    )]
    pub duel: Account<'info, Duel>,

    #[account(
        init,
        payer = challenger,
        seeds = [b"vault", duel.key().as_ref()],
        bump,
        token::mint = stake_mint,
        token::authority = duel,
        token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    /// Creating this marks the attestation spent. `init` means a replay cannot be submitted.
    #[account(
        init,
        payer = challenger,
        space = 8 + NonceMarker::INIT_SPACE,
        seeds = [b"nonce", challenger.key().as_ref(), nonce.to_le_bytes().as_ref()],
        bump
    )]
    pub nonce_marker: Account<'info, NonceMarker>,

    #[account(mut, token::mint = stake_mint, token::authority = challenger)]
    pub from: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: verified against the sysvar id inside verify_oracle_signature
    pub ix_sysvar: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(duel_id: u64)]
pub struct AcceptDuel<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"duel", duel_id.to_le_bytes().as_ref()], bump = duel.bump)]
    pub duel: Account<'info, Duel>,
    #[account(mut, seeds = [b"vault", duel.key().as_ref()], bump = duel.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub opponent: Signer<'info>,

    #[account(address = config.stake_mint @ RaceError::WrongMint)]
    pub stake_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    #[account(mut, token::mint = stake_mint, token::authority = opponent)]
    pub from: InterfaceAccount<'info, TokenAccount>,
}

#[derive(Accounts)]
#[instruction(duel_id: u64, nonce: u64)]
pub struct SubmitDuel<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub opponent: Signer<'info>,

    #[account(address = config.stake_mint @ RaceError::WrongMint)]
    pub stake_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    #[account(mut, seeds = [b"duel", duel_id.to_le_bytes().as_ref()], bump = duel.bump)]
    pub duel: Account<'info, Duel>,
    #[account(mut, seeds = [b"vault", duel.key().as_ref()], bump = duel.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        payer = opponent,
        space = 8 + NonceMarker::INIT_SPACE,
        seeds = [b"nonce", opponent.key().as_ref(), nonce.to_le_bytes().as_ref()],
        bump
    )]
    pub nonce_marker: Account<'info, NonceMarker>,

    #[account(mut, token::mint = stake_mint, token::authority = opponent)]
    pub opponent_token: InterfaceAccount<'info, TokenAccount>,
    /// the challenger's payout account; checked to belong to the challenger on this duel
    #[account(mut, token::mint = stake_mint, token::authority = duel.challenger)]
    pub challenger_token: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = stake_mint, token::authority = config.treasury)]
    pub treasury_token: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: verified against the sysvar id inside verify_oracle_signature
    pub ix_sysvar: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(duel_id: u64)]
pub struct ResolveExpiredDuel<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(address = config.stake_mint @ RaceError::WrongMint)]
    pub stake_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    #[account(mut, seeds = [b"duel", duel_id.to_le_bytes().as_ref()], bump = duel.bump)]
    pub duel: Account<'info, Duel>,
    #[account(mut, seeds = [b"vault", duel.key().as_ref()], bump = duel.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = stake_mint, token::authority = duel.challenger)]
    pub challenger_token: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = stake_mint, token::authority = config.treasury)]
    pub treasury_token: InterfaceAccount<'info, TokenAccount>,
}

#[derive(Accounts)]
#[instruction(duel_id: u64)]
pub struct CancelDuel<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"duel", duel_id.to_le_bytes().as_ref()], bump = duel.bump)]
    pub duel: Account<'info, Duel>,
    #[account(mut, seeds = [b"vault", duel.key().as_ref()], bump = duel.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub caller: Signer<'info>,

    #[account(address = config.stake_mint @ RaceError::WrongMint)]
    pub stake_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    #[account(mut, token::mint = stake_mint, token::authority = duel.challenger)]
    pub challenger_token: InterfaceAccount<'info, TokenAccount>,
}

// ---------------------------------------------------------------- pots

#[derive(Accounts)]
#[instruction(pot_id: u64)]
pub struct CreatePot<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(address = config.stake_mint @ RaceError::WrongMint)]
    pub stake_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    #[account(
        init,
        payer = creator,
        space = 8 + Pot::INIT_SPACE,
        seeds = [b"pot", pot_id.to_le_bytes().as_ref()],
        bump
    )]
    pub pot: Account<'info, Pot>,
    #[account(
        init,
        payer = creator,
        seeds = [b"vault", pot.key().as_ref()],
        bump,
        token::mint = stake_mint,
        token::authority = pot,
        token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
}

#[derive(Accounts)]
#[instruction(pot_id: u64)]
pub struct EnterPot<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub entrant: Signer<'info>,

    #[account(address = config.stake_mint @ RaceError::WrongMint)]
    pub stake_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    #[account(mut, seeds = [b"pot", pot_id.to_le_bytes().as_ref()], bump = pot.bump)]
    pub pot: Account<'info, Pot>,
    #[account(mut, seeds = [b"vault", pot.key().as_ref()], bump = pot.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    /// `init` is the "already entered" check: entering twice cannot be constructed
    #[account(
        init,
        payer = entrant,
        space = 8 + PotEntry::INIT_SPACE,
        seeds = [b"entry", pot.key().as_ref(), entrant.key().as_ref()],
        bump
    )]
    pub entry: Account<'info, PotEntry>,
    #[account(mut, token::mint = stake_mint, token::authority = entrant)]
    pub from: InterfaceAccount<'info, TokenAccount>,
}

#[derive(Accounts)]
#[instruction(pot_id: u64, nonce: u64)]
pub struct PostPotTime<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub entrant: Signer<'info>,

    pub system_program: Program<'info, System>,
    #[account(mut, seeds = [b"pot", pot_id.to_le_bytes().as_ref()], bump = pot.bump)]
    pub pot: Account<'info, Pot>,
    #[account(
        mut,
        seeds = [b"entry", pot.key().as_ref(), entrant.key().as_ref()],
        bump = entry.bump,
        constraint = entry.entrant == entrant.key() @ RaceError::NotEntered
    )]
    pub entry: Account<'info, PotEntry>,
    #[account(
        init,
        payer = entrant,
        space = 8 + NonceMarker::INIT_SPACE,
        seeds = [b"nonce", entrant.key().as_ref(), nonce.to_le_bytes().as_ref()],
        bump
    )]
    pub nonce_marker: Account<'info, NonceMarker>,
    /// CHECK: verified against the sysvar id inside verify_oracle_signature
    pub ix_sysvar: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(pot_id: u64)]
pub struct SettlePot<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(address = config.stake_mint @ RaceError::WrongMint)]
    pub stake_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    #[account(mut, seeds = [b"pot", pot_id.to_le_bytes().as_ref()], bump = pot.bump)]
    pub pot: Account<'info, Pot>,
    #[account(mut, seeds = [b"vault", pot.key().as_ref()], bump = pot.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: matched against pot.leader in the instruction
    pub winner: UncheckedAccount<'info>,
    #[account(mut, token::mint = stake_mint, token::authority = winner)]
    pub winner_token: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = stake_mint, token::authority = config.treasury)]
    pub treasury_token: InterfaceAccount<'info, TokenAccount>,
}

#[derive(Accounts)]
#[instruction(pot_id: u64)]
pub struct RefundPot<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"pot", pot_id.to_le_bytes().as_ref()], bump = pot.bump)]
    pub pot: Account<'info, Pot>,
    #[account(mut, seeds = [b"vault", pot.key().as_ref()], bump = pot.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"entry", pot.key().as_ref(), entrant.key().as_ref()],
        bump = entry.bump
    )]
    pub entry: Account<'info, PotEntry>,
    pub entrant: Signer<'info>,

    #[account(address = config.stake_mint @ RaceError::WrongMint)]
    pub stake_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    #[account(mut, token::mint = stake_mint, token::authority = entrant)]
    pub entrant_token: InterfaceAccount<'info, TokenAccount>,
}
