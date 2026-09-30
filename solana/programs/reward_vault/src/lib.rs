//! reward_vault - the daily prize for the five fastest drivers, paid in TAO.
//!
//! A port of RewardVault.sol, unchanged in every rule that matters.
//!
//! HOW IT IS FUNDED
//!
//! Trading fees are collected off chain and sent here as an ordinary SPL transfer. Nothing calls
//! this program to announce that, so the vault must not keep its own idea of how much money it
//! has - it reads its real balance:
//!
//!     pool = vault.amount - owed
//!
//! `owed` is what is already allocated to winners who have not claimed. Everything above it is
//! the pool, however it arrived. `fund` exists only so a deposit shows up as an event.
//!
//! HOW IT PAYS
//!
//! Once a UTC day is over, anyone may settle it by presenting that day's standings signed by the
//! oracle. Settlement pays DAILY_BPS of the pool AS IT STANDS AT THAT MOMENT, split
//! 40 / 25 / 15 / 12 / 8 between first and fifth.
//!
//! Taking a share of the BALANCE rather than of the day's takings means the pool can never be
//! drained and never needs topping up to stay solvent: a quiet day pays less, a busy one pays
//! more, and whatever is not paid out compounds into tomorrow.
//!
//! If fewer than five drivers set a time, the places nobody filled are simply not allocated and
//! their share stays in the pool. Amounts are fixed at settlement, so a claim made on day 89 is
//! worth exactly what it was on day 1. Unclaimed prizes expire after CLAIM_WINDOW and return to
//! the pool - they are not lost and the operator cannot take them.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

pub mod attest;
pub mod errors;

use attest::{verify_oracle_signature, DayResult, PLACES};
use errors::VaultError;

declare_id!("7qLUeC98XAYMvCZybUK9e5vHGXd2u2JfCFTH4MFXSfoH");

/// share of the pool paid out per day, in basis points
pub const DAILY_BPS: u64 = 1000; // 10%
pub const CLAIM_WINDOW: i64 = 90 * 86_400;
pub const DAY: i64 = 86_400;

/// 40 / 25 / 15 / 12 / 8, summing to 10 000
pub const SPLIT_BPS: [u64; PLACES] = [4000, 2500, 1500, 1200, 800];

#[program]
pub mod reward_vault {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, oracle: Pubkey) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.authority = ctx.accounts.authority.key();
        c.pending_authority = None;
        c.oracle = oracle;
        c.reward_mint = ctx.accounts.reward_mint.key();
        c.owed = 0;
        c.bump = ctx.bumps.config;
        c.vault_bump = ctx.bumps.vault;
        Ok(())
    }

    pub fn set_oracle(ctx: Context<AdminOnly>, oracle: Pubkey) -> Result<()> {
        ctx.accounts.config.oracle = oracle;
        Ok(())
    }

    pub fn transfer_authority(ctx: Context<AdminOnly>, next: Pubkey) -> Result<()> {
        ctx.accounts.config.pending_authority = Some(next);
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        require!(
            c.pending_authority == Some(ctx.accounts.next_authority.key()),
            VaultError::NotAuthority
        );
        c.authority = ctx.accounts.next_authority.key();
        c.pending_authority = None;
        Ok(())
    }

    /// Optional. A plain transfer to the vault funds the pool just as well; this only exists so
    /// a deposit is visible as an event.
    pub fn fund(ctx: Context<Fund>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::NothingToPay);
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.from.to_account_info(),
                    mint: ctx.accounts.reward_mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.funder.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.reward_mint.decimals,
        )?;
        emit!(Funded { from: ctx.accounts.funder.key(), amount });
        Ok(())
    }

    /// Settle a finished UTC day against the oracle's signed standings. Permissionless: the
    /// signature is what makes it authoritative, not the caller.
    pub fn settle_day(
        ctx: Context<SettleDay>,
        day: u64,
        result: DayResult,
        ed25519_ix_index: u8,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(result.day == day, VaultError::MessageMismatch);

        // a day can only be settled once it is definitely over, so nobody can settle a day that
        // still has hours of racing left in it
        let day_end = (day as i64)
            .checked_add(1)
            .and_then(|d| d.checked_mul(DAY))
            .ok_or(VaultError::Overflow)?;
        require!(now >= day_end, VaultError::DayNotOver);
        require!(now <= result.deadline, VaultError::ResultExpired);

        let n = result.winners.len();
        require!(n > 0, VaultError::NoWinners);
        require!(n <= PLACES, VaultError::TooManyWinners);
        require!(result.times_ms.len() == n, VaultError::LengthMismatch);
        for i in 0..n {
            require_keys_neq!(result.winners[i], Pubkey::default(), VaultError::NoWinners);
            for j in (i + 1)..n {
                require_keys_neq!(result.winners[i], result.winners[j], VaultError::DuplicateWinner);
            }
        }

        verify_oracle_signature(
            &ctx.accounts.ix_sysvar,
            ed25519_ix_index,
            &ctx.accounts.config.oracle,
            &result.message(),
        )?;

        let held = ctx.accounts.vault.amount;
        let owed = ctx.accounts.config.owed;
        let pool = held.saturating_sub(owed);
        let payout = (pool as u128)
            .checked_mul(DAILY_BPS as u128)
            .ok_or(VaultError::Overflow)?
            / 10_000u128;

        let d = &mut ctx.accounts.day_result;
        d.day = day;
        d.settled = true;
        d.settled_at = now;
        d.expires_at = now.checked_add(CLAIM_WINDOW).ok_or(VaultError::Overflow)?;
        d.bump = ctx.bumps.day_result;

        let mut allocated: u64 = 0;
        for i in 0..n {
            // each place takes its own share; places nobody filled are never allocated, and
            // their share stays in the pool
            let amount = u64::try_from(
                payout
                    .checked_mul(SPLIT_BPS[i] as u128)
                    .ok_or(VaultError::Overflow)?
                    / 10_000u128,
            )
            .map_err(|_| VaultError::Overflow)?;
            d.winners.push(result.winners[i]);
            d.amounts.push(amount);
            d.claimed.push(false);
            allocated = allocated.checked_add(amount).ok_or(VaultError::Overflow)?;
            emit!(PrizeAwarded {
                day,
                winner: result.winners[i],
                place: i as u8,
                time_ms: result.times_ms[i],
                amount,
            });
        }
        d.allocated = allocated;
        ctx.accounts.config.owed = owed.checked_add(allocated).ok_or(VaultError::Overflow)?;

        emit!(DaySettled { day, pool, allocated, expires_at: d.expires_at });
        Ok(())
    }

    pub fn claim(ctx: Context<Claim>, day: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let amount = {
            let d = &mut ctx.accounts.day_result;
            require!(d.settled, VaultError::NotSettled);
            require!(now <= d.expires_at, VaultError::ClaimWindowClosed);
            let who = ctx.accounts.winner.key();
            let idx = d
                .winners
                .iter()
                .position(|w| *w == who)
                .ok_or(VaultError::NotAWinner)?;
            require!(!d.claimed[idx], VaultError::AlreadyClaimed);
            d.claimed[idx] = true;
            d.amounts[idx]
        };

        ctx.accounts.config.owed = ctx
            .accounts
            .config
            .owed
            .checked_sub(amount)
            .ok_or(VaultError::Overflow)?;

        let bump = ctx.accounts.config.vault_bump;
        let seeds: &[&[u8]] = &[b"vault", &[bump]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.reward_mint.to_account_info(),
                    to: ctx.accounts.winner_token.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.reward_mint.decimals,
        )?;

        emit!(Claimed { day, winner: ctx.accounts.winner.key(), amount });
        Ok(())
    }

    /// After the claim window, anything unclaimed goes back into the pool and becomes part of a
    /// future day's prize. Permissionless; it takes nothing for the caller.
    pub fn sweep_expired(ctx: Context<SweepExpired>, day: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let d = &mut ctx.accounts.day_result;
        require!(d.settled, VaultError::NotSettled);
        require!(now > d.expires_at, VaultError::ClaimWindowOpen);

        let mut returned: u64 = 0;
        for i in 0..d.winners.len() {
            if d.claimed[i] {
                continue;
            }
            d.claimed[i] = true; // marked spent so a late claim cannot follow
            returned = returned.checked_add(d.amounts[i]).ok_or(VaultError::Overflow)?;
        }
        require!(returned > 0, VaultError::NothingToPay);

        // back into the pool by construction: the tokens never moved, only what we owe on them
        ctx.accounts.config.owed = ctx
            .accounts
            .config
            .owed
            .checked_sub(returned)
            .ok_or(VaultError::Overflow)?;

        emit!(Expired { day, returned });
        Ok(())
    }
}

// ---------------------------------------------------------------- state

#[account]
#[derive(InitSpace)]
pub struct VaultConfig {
    pub authority: Pubkey,
    pub pending_authority: Option<Pubkey>,
    pub oracle: Pubkey,
    pub reward_mint: Pubkey,
    /// allocated to winners and not yet claimed; never part of the pool
    pub owed: u64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct DayResultAccount {
    pub day: u64,
    pub settled: bool,
    pub settled_at: i64,
    pub expires_at: i64,
    pub allocated: u64,
    #[max_len(5)]
    pub winners: Vec<Pubkey>,
    #[max_len(5)]
    pub amounts: Vec<u64>,
    #[max_len(5)]
    pub claimed: Vec<bool>,
    pub bump: u8,
}

// ---------------------------------------------------------------- contexts

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub reward_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    #[account(init, payer = authority, space = 8 + VaultConfig::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, VaultConfig>,
    #[account(
        init, payer = authority, seeds = [b"vault"], bump,
        token::mint = reward_mint, token::authority = vault, token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = authority @ VaultError::NotAuthority)]
    pub config: Account<'info, VaultConfig>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, VaultConfig>,
    pub next_authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Fund<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, VaultConfig>,
    #[account(mut)]
    pub funder: Signer<'info>,
    #[account(address = config.reward_mint @ VaultError::WrongMint)]
    pub reward_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    #[account(mut, seeds = [b"vault"], bump = config.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = reward_mint, token::authority = funder)]
    pub from: InterfaceAccount<'info, TokenAccount>,
}

#[derive(Accounts)]
#[instruction(day: u64)]
pub struct SettleDay<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, VaultConfig>,
    #[account(seeds = [b"vault"], bump = config.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    /// `init` is the "already settled" check: a second settlement cannot be constructed
    #[account(
        init, payer = payer, space = 8 + DayResultAccount::INIT_SPACE,
        seeds = [b"day", day.to_le_bytes().as_ref()], bump
    )]
    pub day_result: Account<'info, DayResultAccount>,
    /// CHECK: verified against the sysvar id inside verify_oracle_signature
    pub ix_sysvar: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(day: u64)]
pub struct Claim<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, VaultConfig>,
    pub winner: Signer<'info>,
    #[account(address = config.reward_mint @ VaultError::WrongMint)]
    pub reward_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    #[account(mut, seeds = [b"vault"], bump = config.vault_bump)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [b"day", day.to_le_bytes().as_ref()], bump = day_result.bump)]
    pub day_result: Account<'info, DayResultAccount>,
    #[account(mut, token::mint = reward_mint, token::authority = winner)]
    pub winner_token: InterfaceAccount<'info, TokenAccount>,
}

#[derive(Accounts)]
#[instruction(day: u64)]
pub struct SweepExpired<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, VaultConfig>,
    #[account(mut, seeds = [b"day", day.to_le_bytes().as_ref()], bump = day_result.bump)]
    pub day_result: Account<'info, DayResultAccount>,
}

// ---------------------------------------------------------------- events

#[event]
pub struct Funded { pub from: Pubkey, pub amount: u64 }
#[event]
pub struct DaySettled { pub day: u64, pub pool: u64, pub allocated: u64, pub expires_at: i64 }
#[event]
pub struct PrizeAwarded { pub day: u64, pub winner: Pubkey, pub place: u8, pub time_ms: u32, pub amount: u64 }
#[event]
pub struct Claimed { pub day: u64, pub winner: Pubkey, pub amount: u64 }
#[event]
pub struct Expired { pub day: u64, pub returned: u64 }
