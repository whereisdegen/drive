# Threat model

This system settles tokens on which of two people drove a browser game faster. It is worth being
precise about what that can and cannot be made to mean.

## What it guarantees

**You cannot claim a time you did not drive.** The API has no endpoint that accepts a lap time.
A player submits the sequence of stick positions they fed the kart; the oracle re-drives that
sequence through the game's own physics and reports what it actually produces. A client that
posts `{ totalMs: 1 }` has posted a number nobody reads — it is echoed back next to the measured
time purely so the player can see the two agree.

Four gates stand between a submission and a signature (`oracle/replay.mjs`):

1. **Structure** — the bytes decode, the version and tick rate are ones we accept, the trace is
   within `MAX_TICKS`.
2. **Completion** — replaying it actually finishes three laps. A trace that drives into the sea
   never finishes and is rejected.
3. **Agreement** — the client's state digests, sampled every 256 ticks, match the oracle's at the
   same ticks. A mismatch means the two machines' physics drifted apart, and the run is rejected
   rather than settled at a time the player never drove. See `DETERMINISM.md`.
4. **Plausibility** — cheap anti-tool-assist heuristics, below.

On chain, an attestation is bound to one driver, one track, one trace hash, one issue time and a
single-use nonce, and expires in 30 minutes. So a signature cannot be replayed, cannot be
presented by another address, cannot be carried to a different track, and cannot be banked
against a future opponent.

## What it does not guarantee

**It cannot tell a very good driver from a script.** Replay verification proves the inputs
produce the time. It says nothing about what produced the inputs. A well-written bot that drives
the trace itself will pass every gate, because it genuinely did drive that lap.

The heuristics in `checkPlausible()` catch careless automation, not careful automation:

- input changing on essentially every tick;
- repeated full-lock steer reversals inside 10 ms;
- one lap's inputs replayed verbatim as another lap's — thousands of ticks byte-identical.

They are deliberately tuned to sit far outside human behaviour, because a false positive here
means refusing to let an honest player stake. Note what is **not** on that list: matching lap
times. At 100 Hz every time is a multiple of 10 ms, so two honest laps landing on the same value
is ordinary — an earlier version flagged it and would have rejected real players.

If you need a stronger answer than this, the honest options are human-in-the-loop review of
submitted traces (they are all kept, and each is replayable), or not staking on a single-player
browser game.

## The daily prize inherits all of this

`reward_vault` pays on the same oracle's signature, so everything below about the oracle applies to
it. Two things are specific to it:

- **The signer picks the winners.** A compromised key can sign a day's standings naming any five
  addresses and drain 10% of the pool per day. It cannot drain more than that per day, and it
  cannot touch money already owed to earlier winners, which caps the damage while the key is being
  rotated. That is a limit, not a defence.
- **The pool is the vault's real TAO balance** minus what it owes, because fees arrive as plain
  transfers. Anyone can therefore increase the pool by sending TAO, which is the intended funding
  path and harmless. Nobody can decrease it: there is no withdrawal path for the operator at all,
  and the vault's token account is owned by a PDA whose only signer is the program. Expired prizes
  go back to the pool, not to the treasury.

Settling is permissionless and pays the caller nothing, so there is no race to settle and nothing
to gain by front-running it.

## The oracle is trusted

`race_stakes` does not verify a race. It verifies a **signature** from the oracle recorded in its
config. Whoever holds that key can mint any lap time for any wallet and drain every open stake.
This is stated in the program's own header rather than buried here.

On Solana the check is structurally different and worth knowing: there is no in-program signature
recovery, so the player puts an `Ed25519Program` instruction in the same transaction and the
program reads it back out of the instructions sysvar. That is only evidence if every field of it
is checked, because the attacker chose its contents — `attest.rs` verifies the program id is the
real native one, that there is exactly one signature, that all three of its index fields say
"this instruction", that the key is the oracle's, and that the message equals the bytes the
program rebuilt itself. A verifier that merely confirms an ed25519 instruction exists verifies
nothing at all.

Mitigations present:

- attestations are bound to driver, track, trace, issue time and a one-use nonce, and expire, so
  a leaked *signature* is worth almost nothing;
- the signer is rotatable (`set_oracle`), and rotating invalidates every outstanding signature
  immediately — there is a test for exactly that;
- authority transfer is two-step: a proposed authority must call `accept_authority`, so a typo
  cannot hand control to an address nobody holds;
- a spent nonce is a PDA that exists, so a replayed attestation cannot be built into a valid
  transaction at all — it is not a runtime check that could be bypassed;
- the protocol fee is capped at 5% and cannot be raised past it;
- every accepted trace is archived, so any posted time can be independently re-driven by anyone
  who doubts it (`GET /api/runs/:id/trace`).

Mitigations **not** present: the oracle is a single hot key in one process. There is no
threshold signing, no attestation quorum, no challenge period.

If you want trustlessness rather than accountability, the replay has to happen somewhere itself
verifiable — a zk proof of the simulation, or an optimistic scheme where a signed time can be
challenged inside a window by anyone willing to re-run the trace and post a bond. Both are
substantially more work than this system.

## Other exposure

- **Denial of service.** A verification is roughly 60–100 ms of CPU. `server.mjs` throttles to 20
  verifications per IP per minute, which is a speed bump, not protection. Put a real rate limiter
  and a reverse proxy in front of anything public.
- **Storage.** Every accepted trace is kept (~15 kB each). That is the point — a time means
  nothing if the run behind it is gone — but it grows without bound and there is no pruning.
- **The file store.** `oracle/store.mjs` is a JSON index plus one file per run, with an
  in-process write queue. It is correct for one server process and has no concurrent-writer
  story beyond that. Two oracle processes over one data directory will corrupt the index.
- **Front-running settlement.** Anyone may call `settle_pot` and `resolve_expired_duel`; they pay
  the fee and the funds go where the program says. There is nothing to gain by racing them.
- **Rent.** Settling a day creates an account, and its rent is paid by whoever sends the
  transaction — permanently. Small, but it means a settler with no SOL fails in a way that looks
  like a program error and is not. `tools/settle.mjs` checks its own balance first and says so.
- **Griefing a duel.** An opponent can accept and never submit. They forfeit their stake to the
  challenger when the window expires, so this costs them more than it costs you.
- **Ties.** A dead heat goes to the defender in a duel, and to the earliest poster in a pot.
  Arbitrary, but fixed and stated up front.

## The stake token must transfer exactly

`RaceStakes` computes every payout from the **recorded** stake: a duel pays `stake * 2`, a pot
pays the sum of its entries. A token that skims a percentage on transfer breaks that arithmetic —
the contract credits 100, receives 95, and the first settlement reverts with two players' money
already locked inside it.

This is not hypothetical here: the token is launching on STONK, and Token-2022 supports a
transfer-fee extension that does exactly this. So `pull_exact()` reloads the vault's balance after
every incoming transfer and fails with `FeeOnTransferToken` if the amount received is not the
amount credited. The mismatch is caught on the first transfer, when the only thing at risk is one
transaction's fee.

The programs use `token_interface`, so they accept both classic SPL Token and Token-2022 mints.
That is convenience, not endorsement: a Token-2022 mint can carry extensions — transfer fees, a
permanent delegate, transfer hooks, non-transferability — that change what a transfer means.
**Check the mint's extensions before initialising against it.** A permanent delegate in particular
can move tokens out of any account holding that mint, the vault's included, and no amount of care
in these programs prevents it.

The guard stays regardless. It costs one account reload per deposit and it is the difference
between a failed transaction and two players' stakes locked in a program that cannot pay them — if
the mint's fee policy is ever changed after launch, this is what catches it. `reward_vault` is
unaffected either way: it reads its own balance rather than trusting a number it was handed.

## The program upgrade authority is a hot key

**Decided 2026-09-30, deliberately, by the operator.** Both programs keep a single hot key as
their upgrade authority: not a multisig, not burned.

State plainly what that means, because it is the largest residual risk in the system and it is
larger than the oracle key. Whoever holds the upgrade authority can replace either program with
arbitrary code. A replaced `reward_vault` can transfer the whole pool out; a replaced
`race_stakes` can take every open stake. None of the guarantees above survive it — not the nonce
PDAs, not the two-step authority transfer, not the fee cap — because all of them are properties of
the code currently deployed, and the upgrade authority is precisely the power to change that code.

So the honest summary is: **players are trusting the holder of that key, not the programs.**
Everything else in this document describes what the programs do for someone who has already
extended that trust.

The choice is defensible — it buys the ability to fix a bug in a system that has not been audited,
which is a real benefit and not a small one — but it should be stated to players rather than
implied, and it is the first thing to change if this grows beyond a team playing with it. The
mitigations that cost nothing and are worth having anyway:

- keep the upgrade key on different hardware from the oracle key, so one compromise is not both;
- keep it offline; it is needed only to deploy, never to run;
- write down who holds it and what happens if they are unavailable.

## Before this goes anywhere real

- [ ] `ORACLE_KEYPAIR` set to a key that is not the development one. The oracle **refuses to
      start** with seed 42 on any non-local cluster — `ALLOW_DEV_KEY=1` overrides it, and should
      not be used on mainnet.
- [x] A decision about the program upgrade authority. It is a single hot key, on purpose — see
      above. Keep it offline and on different hardware from the oracle key.
- [ ] The oracle behind TLS and a real rate limiter.
- [ ] Oracle signing key in a KMS or HSM, not an environment variable. `loadKeypair` accepts a file
      path for this reason; a path can be `chmod 600` and is not inherited by child processes.
- [ ] The TAO mint checked against the cluster — decimals, owning token program, and **extensions**
      — not by eyeballing the address. See [REWARDS.md](REWARDS.md). `reward_mint` is fixed at
      `initialize` and cannot be changed afterwards.
- [ ] A funded key for `tools/settle.mjs`, and monitoring that it ran. Nothing is lost if it stops
      — winners can settle their own day — but they should not have to. It needs SOL for both the
      fee and the day account's rent.
- [ ] One real duel and one real day for a trivial amount before announcing anything. The cost of
      being wrong is two locked stakes.
- [ ] An independent audit of `programs/race_stakes` and `programs/reward_vault`. The 29 tests in
      `solana/tests/` are not one.
- [ ] `sweep_expired` exercised somehow. It is the **one instruction with no test**: it needs the
      clock 90 days forward and `solana-test-validator` cannot advance its clock, unlike the EVM
      suite where `evm_increaseTime` covered this path directly. A `litesvm` test can set the clock
      sysvar and would close the gap. Until then, treat the 90-day expiry as inspected but
      unexercised.
- [ ] A decision, written down, about what happens when the oracle is wrong — because at some
      point it will be.
