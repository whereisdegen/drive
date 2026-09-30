//! race_stakes - stake on being faster round Sorrel Cove.
//!
//! A faithful port of RaceStakes.sol. Same two contests, same rules, same trust model; only the
//! machinery underneath is different.
//!
//! WHAT THIS PROGRAM CAN AND CANNOT KNOW
//!
//! A lap time is not an on-chain fact. The race happens in a browser, and nothing a browser says
//! about itself is evidence. So this program never accepts a time from a player. It accepts a
//! `Run` signed by `config.oracle` - an off-chain verifier that re-drives the player's recorded
//! inputs through the game's own physics and reports what those inputs actually produce
//! (oracle/replay.mjs). The player submits the signature; the oracle decides the number.
//!
//! That makes the oracle TRUSTED, and this program does not hide it. A dishonest or compromised
//! signer can hand anyone any time and drain every open stake. The mitigations are ordinary ones:
//! every attestation is bound to one driver, one track, one trace and one single-use nonce, so a
//! leaked signature cannot be replayed, reused on another track, or presented by another wallet;
//! attestations expire; and the authority that can rotate the signer is a two-step handover that
//! should be a multisig in production. See docs/THREAT-MODEL.md.
//!
//! WHAT CHANGED FROM THE EVM VERSION, AND WHY
//!
//!   ecrecover -> the Ed25519 native program, inspected through the instructions sysvar. Solana
//!     has no in-program signature recovery, so the player puts a signature-verify instruction
//!     ahead of ours and we check its contents field by field (see attest.rs).
//!   nonce mapping -> one PDA per (driver, nonce). The ACCOUNT's existence is the spent flag, so
//!     a replay cannot even be built into a valid transaction.
//!   msg.sender -> an explicit `Signer` account on each instruction.
//!   contract balance -> a per-contest vault token account owned by the contest's PDA, so no
//!     contest can ever be paid out of another's money.
//!   ERC20 -> token_interface, which covers Token-2022 as well as classic SPL.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

pub mod attest;
pub mod contexts;
pub mod errors;
pub mod state;

use attest::{verify_oracle_signature, Run};
use contexts::*;
use errors::RaceError;
use state::*;

declare_id!("3WpVj8hH1uRKF8m3N4R1zyQc1AmWomHSGyu5q5ujHH4o");

/// protocol cut is hard capped, whatever the authority tries to set
pub const MAX_FEE_BPS: u16 = 500; // 5%
pub const MIN_RUN_WINDOW: i64 = 10 * 60;
pub const MAX_RUN_WINDOW: i64 = 7 * 24 * 60 * 60;

/// Tolerance between the oracle's wall clock (which stamps `issued_at`) and the cluster's clock.
/// Two different clocks, not obliged to agree; without a margin an honest attempt driven the
/// moment a duel is accepted can be rejected as stale. Far smaller than an attestation's life.
pub const ISSUE_SKEW: i64 = 5 * 60;

#[program]
pub mod race_stakes {
    use super::*;

    // ------------------------------------------------------------------ setup

    pub fn initialize(ctx: Context<Initialize>, oracle: Pubkey, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, RaceError::FeeTooHigh);
        let c = &mut ctx.accounts.config;
        c.authority = ctx.accounts.authority.key();
        c.pending_authority = None;
        c.oracle = oracle;
        c.treasury = ctx.accounts.treasury.key();
        c.stake_mint = ctx.accounts.stake_mint.key();
        c.fee_bps = fee_bps;
        c.duel_count = 0;
        c.pot_count = 0;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn set_oracle(ctx: Context<AdminOnly>, oracle: Pubkey) -> Result<()> {
        ctx.accounts.config.oracle = oracle;
        Ok(())
    }

    pub fn set_fee_bps(ctx: Context<AdminOnly>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, RaceError::FeeTooHigh);
        ctx.accounts.config.fee_bps = fee_bps;
        Ok(())
    }

    pub fn set_treasury(ctx: Context<SetTreasury>) -> Result<()> {
        ctx.accounts.config.treasury = ctx.accounts.treasury.key();
        Ok(())
    }

    /// Two-step, because a mistyped authority on a one-step handover is unrecoverable.
    pub fn transfer_authority(ctx: Context<AdminOnly>, next: Pubkey) -> Result<()> {
        ctx.accounts.config.pending_authority = Some(next);
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        require!(
            c.pending_authority == Some(ctx.accounts.next_authority.key()),
            RaceError::NotParticipant
        );
        c.authority = ctx.accounts.next_authority.key();
        c.pending_authority = None;
        Ok(())
    }

    // ------------------------------------------------------------------ duels

    /// Post a verified time and a stake, and wait for someone to try to beat it.
    pub fn open_duel(
        ctx: Context<OpenDuel>,
        duel_id: u64,
        nonce: u64,
        run: Run,
        ed25519_ix_index: u8,
        stake: u64,
        join_by: i64,
        run_window: i64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        // the seed carries `id` and `nonce`, so tie them to the counter and the attestation
        require!(duel_id == ctx.accounts.config.duel_count, RaceError::BadState);
        require!(nonce == run.nonce, RaceError::NonceSpent);
        require!(stake > 0, RaceError::ZeroStake);
        require!(join_by > now, RaceError::BadWindow);
        require!(
            (MIN_RUN_WINDOW..=MAX_RUN_WINDOW).contains(&run_window),
            RaceError::BadWindow
        );

        consume_run(
            &ctx.accounts.config,
            &ctx.accounts.ix_sysvar,
            ed25519_ix_index,
            &run,
            &ctx.accounts.challenger.key(),
            &run.track_id,
            now,
        )?;

        let d = &mut ctx.accounts.duel;
        d.id = duel_id;
        d.challenger = ctx.accounts.challenger.key();
        d.opponent = Pubkey::default();
        d.stake = stake;
        d.target_ms = run.time_ms;
        d.track_id = run.track_id;
        d.join_by = join_by;
        d.run_by = 0;
        d.accepted_at = 0;
        d.run_window = run_window as u32;
        d.result_ms = 0;
        d.status = DuelStatus::Open;
        d.bump = ctx.bumps.duel;
        d.vault_bump = ctx.bumps.vault;

        ctx.accounts.config.duel_count = ctx
            .accounts
            .config
            .duel_count
            .checked_add(1)
            .ok_or(RaceError::Overflow)?;

        pull_exact(
            &ctx.accounts.token_program,
            &ctx.accounts.from,
            &mut ctx.accounts.vault,
            &ctx.accounts.challenger.to_account_info(),
            &ctx.accounts.stake_mint,
            stake,
        )?;

        emit!(DuelOpened {
            id: d.id,
            challenger: d.challenger,
            stake,
            target_ms: d.target_ms,
            track_id: d.track_id,
            join_by,
        });
        Ok(())
    }

    /// Match the stake and start your window to beat the posted time.
    pub fn accept_duel(ctx: Context<AcceptDuel>, _duel_id: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let d = &mut ctx.accounts.duel;
        require!(d.status == DuelStatus::Open, RaceError::BadState);
        require!(now <= d.join_by, RaceError::TooLate);
        require_keys_neq!(
            ctx.accounts.opponent.key(),
            d.challenger,
            RaceError::SelfDuel
        );

        d.opponent = ctx.accounts.opponent.key();
        d.accepted_at = now;
        d.run_by = now
            .checked_add(d.run_window as i64)
            .ok_or(RaceError::Overflow)?;
        d.status = DuelStatus::Accepted;
        let stake = d.stake;
        let run_by = d.run_by;
        let id = d.id;

        pull_exact(
            &ctx.accounts.token_program,
            &ctx.accounts.from,
            &mut ctx.accounts.vault,
            &ctx.accounts.opponent.to_account_info(),
            &ctx.accounts.stake_mint,
            stake,
        )?;

        emit!(DuelAccepted { id, opponent: ctx.accounts.opponent.key(), run_by });
        Ok(())
    }

    /// Submit your attempt. Strictly faster than the target wins the pot; a tie or a slower time
    /// hands it to the challenger, who does not have to do anything.
    pub fn submit_duel(
        ctx: Context<SubmitDuel>,
        _duel_id: u64,
        nonce: u64,
        run: Run,
        ed25519_ix_index: u8,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(nonce == run.nonce, RaceError::NonceSpent);
        {
            let d = &ctx.accounts.duel;
            require!(d.status == DuelStatus::Accepted, RaceError::BadState);
            require_keys_eq!(ctx.accounts.opponent.key(), d.opponent, RaceError::NotParticipant);
            require!(now <= d.run_by, RaceError::TooLate);
            // the attempt has to be driven after the gauntlet was picked up, not pulled from a drawer
            require!(
                run.issued_at + ISSUE_SKEW >= d.accepted_at,
                RaceError::StaleRun
            );
            let track = d.track_id;
            consume_run(
                &ctx.accounts.config,
                &ctx.accounts.ix_sysvar,
                ed25519_ix_index,
                &run,
                &ctx.accounts.opponent.key(),
                &track,
                now,
            )?;
        }

        let d = &mut ctx.accounts.duel;
        d.status = DuelStatus::Settled;
        d.result_ms = run.time_ms;
        let opponent_won = run.time_ms < d.target_ms;

        let pot = d.stake.checked_mul(2).ok_or(RaceError::Overflow)?;
        let (payout, fee) = split(pot, ctx.accounts.config.fee_bps)?;
        let id = d.id;
        let target = d.target_ms;
        let bump = d.bump;

        let winner = if opponent_won {
            ctx.accounts.opponent_token.to_account_info()
        } else {
            ctx.accounts.challenger_token.to_account_info()
        };
        pay_from_duel(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &winner,
            &ctx.accounts.treasury_token,
            &ctx.accounts.duel.to_account_info(),
            &ctx.accounts.stake_mint,
            id,
            bump,
            payout,
            fee,
        )?;

        emit!(DuelSettled {
            id,
            winner: if opponent_won { ctx.accounts.opponent.key() } else { ctx.accounts.duel.challenger },
            winner_ms: run.time_ms,
            target_ms: target,
            payout,
            fee,
        });
        Ok(())
    }

    /// Accepted but not submitted in time: the challenger takes both stakes.
    pub fn resolve_expired_duel(ctx: Context<ResolveExpiredDuel>, _duel_id: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let d = &mut ctx.accounts.duel;
        require!(d.status == DuelStatus::Accepted, RaceError::BadState);
        require!(now > d.run_by, RaceError::NotYet);

        d.status = DuelStatus::Settled;
        let pot = d.stake.checked_mul(2).ok_or(RaceError::Overflow)?;
        let (payout, fee) = split(pot, ctx.accounts.config.fee_bps)?;
        let (id, bump, challenger, target) = (d.id, d.bump, d.challenger, d.target_ms);

        pay_from_duel(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.challenger_token.to_account_info(),
            &ctx.accounts.treasury_token,
            &ctx.accounts.duel.to_account_info(),
            &ctx.accounts.stake_mint,
            id,
            bump,
            payout,
            fee,
        )?;

        emit!(DuelSettled { id, winner: challenger, winner_ms: 0, target_ms: target, payout, fee });
        Ok(())
    }

    /// Withdraw an open duel: early by the challenger, or by anyone once `join_by` has passed.
    /// No fee - nobody competed for it.
    pub fn cancel_duel(ctx: Context<CancelDuel>, _duel_id: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let d = &mut ctx.accounts.duel;
        require!(d.status == DuelStatus::Open, RaceError::BadState);
        let by_challenger = ctx.accounts.caller.key() == d.challenger;
        require!(by_challenger || now > d.join_by, RaceError::NotYet);

        d.status = DuelStatus::Cancelled;
        let (id, bump, stake) = (d.id, d.bump, d.stake);

        let seeds: &[&[u8]] = &[b"duel", &id.to_le_bytes(), &[bump]];
        transfer_signed(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.challenger_token.to_account_info(),
            &ctx.accounts.duel.to_account_info(),
            &ctx.accounts.stake_mint,
            stake,
            &[seeds],
        )?;

        emit!(DuelCancelled { id });
        Ok(())
    }

    // ------------------------------------------------------------------ pots

    pub fn create_pot(
        ctx: Context<CreatePot>,
        pot_id: u64,
        track_id: [u8; 32],
        entry_fee: u64,
        closes_at: i64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(pot_id == ctx.accounts.config.pot_count, RaceError::BadState);
        require!(entry_fee > 0, RaceError::ZeroStake);
        require!(closes_at > now, RaceError::BadWindow);

        let p = &mut ctx.accounts.pot;
        p.id = pot_id;
        p.track_id = track_id;
        p.entry_fee = entry_fee;
        p.prize = 0;
        p.opens_at = now;
        p.closes_at = closes_at;
        p.leader = Pubkey::default();
        p.leader_ms = 0;
        p.entrants = 0;
        p.settled = false;
        p.bump = ctx.bumps.pot;
        p.vault_bump = ctx.bumps.vault;

        ctx.accounts.config.pot_count = ctx
            .accounts
            .config
            .pot_count
            .checked_add(1)
            .ok_or(RaceError::Overflow)?;

        emit!(PotCreated { id: p.id, track_id, entry_fee, closes_at });
        Ok(())
    }

    /// Entering creates the entry PDA, so entering twice is impossible by construction.
    pub fn enter_pot(ctx: Context<EnterPot>, _pot_id: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let p = &mut ctx.accounts.pot;
        require!(!p.settled, RaceError::BadState);
        require!(now < p.closes_at, RaceError::TooLate);

        let fee = p.entry_fee;
        p.entrants = p.entrants.checked_add(1).ok_or(RaceError::Overflow)?;
        p.prize = p.prize.checked_add(fee).ok_or(RaceError::Overflow)?;
        let id = p.id;

        let e = &mut ctx.accounts.entry;
        e.pot = ctx.accounts.pot.key();
        e.entrant = ctx.accounts.entrant.key();
        e.best_ms = 0;
        e.refunded = false;
        e.bump = ctx.bumps.entry;

        pull_exact(
            &ctx.accounts.token_program,
            &ctx.accounts.from,
            &mut ctx.accounts.vault,
            &ctx.accounts.entrant.to_account_info(),
            &ctx.accounts.stake_mint,
            fee,
        )?;

        emit!(PotEntered { id, entrant: ctx.accounts.entrant.key() });
        Ok(())
    }

    /// Post a verified time. Only an improvement on your own best is recorded.
    pub fn post_pot_time(
        ctx: Context<PostPotTime>,
        _pot_id: u64,
        nonce: u64,
        run: Run,
        ed25519_ix_index: u8,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(nonce == run.nonce, RaceError::NonceSpent);
        {
            let p = &ctx.accounts.pot;
            require!(!p.settled, RaceError::BadState);
            require!(now < p.closes_at, RaceError::TooLate);
            // only times driven while this pot was live count towards it
            require!(run.issued_at + ISSUE_SKEW >= p.opens_at, RaceError::StaleRun);
            let track = p.track_id;
            consume_run(
                &ctx.accounts.config,
                &ctx.accounts.ix_sysvar,
                ed25519_ix_index,
                &run,
                &ctx.accounts.entrant.key(),
                &track,
                now,
            )?;
        }

        let e = &mut ctx.accounts.entry;
        let improved = e.best_ms == 0 || run.time_ms < e.best_ms;
        if improved {
            e.best_ms = run.time_ms;
        }

        let p = &mut ctx.accounts.pot;
        // first valid time leads; after that only a strictly faster one takes it, so the earliest
        // poster of a tied time keeps the lead
        let takes_lead =
            improved && (p.leader == Pubkey::default() || run.time_ms < p.leader_ms);
        if takes_lead {
            p.leader = ctx.accounts.entrant.key();
            p.leader_ms = run.time_ms;
        }

        emit!(PotTimePosted {
            id: p.id,
            entrant: ctx.accounts.entrant.key(),
            time_ms: run.time_ms,
            is_new_leader: takes_lead,
        });
        Ok(())
    }

    /// After the close, pay the fastest entrant.
    pub fn settle_pot(ctx: Context<SettlePot>, _pot_id: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let p = &mut ctx.accounts.pot;
        require!(!p.settled, RaceError::BadState);
        require!(now >= p.closes_at, RaceError::NotYet);
        require_keys_neq!(p.leader, Pubkey::default(), RaceError::BadState);
        require_keys_eq!(ctx.accounts.winner.key(), p.leader, RaceError::NotParticipant);

        p.settled = true;
        let prize = p.prize;
        p.prize = 0;
        let (payout, fee) = split(prize, ctx.accounts.config.fee_bps)?;
        let (id, bump, leader, leader_ms) = (p.id, p.bump, p.leader, p.leader_ms);

        let seeds: &[&[u8]] = &[b"pot", &id.to_le_bytes(), &[bump]];
        transfer_signed(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.winner_token.to_account_info(),
            &ctx.accounts.pot.to_account_info(),
            &ctx.accounts.stake_mint,
            payout,
            &[seeds],
        )?;
        if fee > 0 {
            transfer_signed(
                &ctx.accounts.token_program,
                &ctx.accounts.vault,
                &ctx.accounts.treasury_token.to_account_info(),
                &ctx.accounts.pot.to_account_info(),
                &ctx.accounts.stake_mint,
                fee,
                &[seeds],
            )?;
        }

        emit!(PotSettled { id, winner: leader, winner_ms: leader_ms, payout, fee });
        Ok(())
    }

    /// Reclaim your entry from a closed pot in which nobody set a verified time.
    pub fn refund_pot(ctx: Context<RefundPot>, _pot_id: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let p = &ctx.accounts.pot;
        require!(now >= p.closes_at, RaceError::NotYet);
        require_keys_eq!(p.leader, Pubkey::default(), RaceError::BadState);
        require!(!ctx.accounts.entry.refunded, RaceError::BadState);

        let amount = p.entry_fee;
        let (id, bump) = (p.id, p.bump);
        ctx.accounts.entry.refunded = true;
        let p = &mut ctx.accounts.pot;
        p.prize = p.prize.saturating_sub(amount);

        let seeds: &[&[u8]] = &[b"pot", &id.to_le_bytes(), &[bump]];
        transfer_signed(
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.entrant_token.to_account_info(),
            &ctx.accounts.pot.to_account_info(),
            &ctx.accounts.stake_mint,
            amount,
            &[seeds],
        )?;

        emit!(PotRefunded { id, entrant: ctx.accounts.entrant.key(), amount });
        Ok(())
    }
}

// ---------------------------------------------------------------- shared helpers

fn split(pot: u64, fee_bps: u16) -> Result<(u64, u64)> {
    let fee = (pot as u128)
        .checked_mul(fee_bps as u128)
        .ok_or(RaceError::Overflow)?
        / 10_000u128;
    let fee = u64::try_from(fee).map_err(|_| RaceError::Overflow)?;
    Ok((pot.checked_sub(fee).ok_or(RaceError::Overflow)?, fee))
}

/// Validate and CONSUME an attestation.
///
/// The nonce PDA is created by the `init` on the calling context, so arriving here at all means
/// this nonce was unspent. Everything else is checked explicitly.
fn consume_run(
    config: &Account<Config>,
    ix_sysvar: &AccountInfo,
    ed25519_ix_index: u8,
    run: &Run,
    presenter: &Pubkey,
    expected_track: &[u8; 32],
    now: i64,
) -> Result<()> {
    require_keys_eq!(run.driver, *presenter, RaceError::WrongDriver);
    require!(run.track_id == *expected_track, RaceError::WrongTrack);
    require!(now <= run.deadline, RaceError::AttestationExpired);
    verify_oracle_signature(ix_sysvar, ed25519_ix_index, &config.oracle, &run.message())
}

/// Move exactly `amount` into a vault, or fail.
///
/// Every payout is computed from the RECORDED stake - a duel pays `stake * 2`, a pot pays the sum
/// of its entries. A token that skims a transfer breaks that arithmetic silently: the program
/// credits 100, receives 95, and the first settlement fails with two players' money already
/// locked in the vault. Token-2022 transfer fees make this a live possibility, not a hypothetical,
/// so the shortfall is caught on the way in when the only thing at risk is one transaction's fee.
fn pull_exact<'info>(
    token_program: &Interface<'info, TokenInterface>,
    from: &InterfaceAccount<'info, TokenAccount>,
    vault: &mut InterfaceAccount<'info, TokenAccount>,
    authority: &AccountInfo<'info>,
    mint: &InterfaceAccount<'info, Mint>,
    amount: u64,
) -> Result<()> {
    let before = vault.amount;
    token_interface::transfer_checked(
        CpiContext::new(
            token_program.key(),
            TransferChecked {
                from: from.to_account_info(),
                mint: mint.to_account_info(),
                to: vault.to_account_info(),
                authority: authority.clone(),
            },
        ),
        amount,
        mint.decimals,
    )?;
    // the deserialized copy still holds the pre-transfer balance; re-read it from the account
    vault.reload()?;
    let received = vault.amount.checked_sub(before).ok_or(RaceError::Overflow)?;
    require!(received == amount, RaceError::FeeOnTransferToken);
    Ok(())
}

fn transfer_signed<'info>(
    token_program: &Interface<'info, TokenInterface>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    mint: &InterfaceAccount<'info, Mint>,
    amount: u64,
    signer: &[&[&[u8]]],
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferChecked {
                from: vault.to_account_info(),
                mint: mint.to_account_info(),
                to: to.clone(),
                authority: authority.clone(),
            },
            signer,
        ),
        amount,
        mint.decimals,
    )
}

#[allow(clippy::too_many_arguments)]
fn pay_from_duel<'info>(
    token_program: &Interface<'info, TokenInterface>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    winner: &AccountInfo<'info>,
    treasury: &InterfaceAccount<'info, TokenAccount>,
    duel: &AccountInfo<'info>,
    mint: &InterfaceAccount<'info, Mint>,
    id: u64,
    bump: u8,
    payout: u64,
    fee: u64,
) -> Result<()> {
    let id_bytes = id.to_le_bytes();
    let seeds: &[&[u8]] = &[b"duel", &id_bytes, &[bump]];
    transfer_signed(token_program, vault, winner, duel, mint, payout, &[seeds])?;
    transfer_signed(
        token_program,
        vault,
        &treasury.to_account_info(),
        duel,
        mint,
        fee,
        &[seeds],
    )
}

// ---------------------------------------------------------------- events

#[event]
pub struct DuelOpened {
    pub id: u64,
    pub challenger: Pubkey,
    pub stake: u64,
    pub target_ms: u32,
    pub track_id: [u8; 32],
    pub join_by: i64,
}
#[event]
pub struct DuelAccepted {
    pub id: u64,
    pub opponent: Pubkey,
    pub run_by: i64,
}
#[event]
pub struct DuelSettled {
    pub id: u64,
    pub winner: Pubkey,
    pub winner_ms: u32,
    pub target_ms: u32,
    pub payout: u64,
    pub fee: u64,
}
#[event]
pub struct DuelCancelled {
    pub id: u64,
}
#[event]
pub struct PotCreated {
    pub id: u64,
    pub track_id: [u8; 32],
    pub entry_fee: u64,
    pub closes_at: i64,
}
#[event]
pub struct PotEntered {
    pub id: u64,
    pub entrant: Pubkey,
}
#[event]
pub struct PotTimePosted {
    pub id: u64,
    pub entrant: Pubkey,
    pub time_ms: u32,
    pub is_new_leader: bool,
}
#[event]
pub struct PotSettled {
    pub id: u64,
    pub winner: Pubkey,
    pub winner_ms: u32,
    pub payout: u64,
    pub fee: u64,
}
#[event]
pub struct PotRefunded {
    pub id: u64,
    pub entrant: Pubkey,
    pub amount: u64,
}
