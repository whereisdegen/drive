# The daily prize

Trading fees from the token launch are paid out to the five fastest drivers of each UTC day, in
TAO, claimable for 90 days.

## The rule

At 00:00 UTC a day closes. Whoever set the five fastest **oracle-verified** times during that day
share **10% of the vault's TAO balance**. Note that this is two splits, not one: 10% of the pool
becomes the day's payout, and *that* is divided 40/25/15/12/8. First place takes 4% of the pool,
not 40% of it.

| place | share of the payout | of a 300 TAO pool |
| ---: | ---: | ---: |
| 1st | 40% | 12 TAO |
| 2nd | 25% | 7.5 TAO |
| 3rd | 15% | 4.5 TAO |
| 4th | 12% | 3.6 TAO |
| 5th | 8% | 2.4 TAO |

The whole payout is 30 TAO; the remaining 270 rolls over.

Your **best** time of the day is the one that counts, so a driver occupies one place however many
runs they set. A dead heat goes to whoever set it first. Only verified runs exist in the
leaderboard at all — a time that fails replay verification is never stored, so it can never place.

## Why a share of the balance, not of the day's fees

Taking 10% of what the vault **holds** rather than of what came in that day has three properties
worth having:

- **It cannot be drained.** A day always pays a tenth of what is there and leaves nine tenths. The
  vault is solvent by construction; there is no accounting to get wrong.
- **It never needs topping up to keep working.** A day with no trading still pays a prize, just a
  smaller one.
- **It compounds.** Quiet days leave more behind, so a busy week raises every subsequent day's
  prize rather than spiking one and starving the next.

The trade-off is that payouts lag volume: a surge in fees is paid out over the following weeks
rather than the same night. That is deliberate — the alternative rewards whoever happened to race
on the day of a spike.

## How the money gets in

The launch platform takes the trading tax and collects the fees; those are swept to the vault as
an ordinary **SPL token transfer** to the vault's PDA token account. Nothing calls the program to
announce it, so the vault never keeps its own idea of what it holds — it reads its real balance:

```
pool = vault.amount - config.owed
```

`owed` is TAO already allocated to winners who have not claimed. Everything above it is the pool,
however it arrived. `fund()` exists only so a deposit shows up as an event for indexers; a plain
transfer works identically.

## How the money gets out

1. **Settle.** Once a day is over, anyone presents that day's standings signed by the oracle.
   Settlement fixes each winner's amount at that moment, so a claim made on day 89 is worth
   exactly what it was worth on day 1.
2. **Claim.** Each winner calls `claim(day)` — or `claimMany` for several at once. The game's
   **Daily** tab finds the days you placed in and shows what is waiting.
3. **Expire.** After 90 days, `sweep_expired(day)` returns anything unclaimed to the pool. It is
   not burned and the operator cannot take it; it becomes part of a future day's prize.

Settling is permissionless and pays the caller nothing — the oracle's signature is what makes the
standings authoritative, not the sender. `oracle/tools/settle.mjs` does it from cron:

```
5 0 * * *  cd /path/to/drive/oracle && node tools/settle.mjs >> settle.log 2>&1
```

If that job never runs, nothing is lost: any winner can settle their own day from the Daily tab,
and the 90-day window starts from whenever settlement happens, not from the day itself.

## Edge cases, decided

- **Fewer than five drivers.** Unfilled places are never allocated and their share stays in the
  pool. Three drivers take 40/25/15 of the payout; the other 20% rolls over.
- **Nobody raced.** The day cannot be settled at all — there is nothing to sign. The pool is
  untouched.
- **Sixth place and below.** Paid nothing. One place per address.
- **Rounding.** Each share is an independent integer division, so a few wei of dust can remain
  unallocated. It stays in the pool.
- **Days are UTC** by construction on both sides: `floor(unixSeconds / 86400)`. The contract
  computes the same day index from `block.timestamp` and never has to be told what a day is.

## Pointing it at the real TAO

The vault pays every prize in whatever mint it was initialised with, and that choice is
permanent — `reward_mint` is fixed at `initialize` and there is no instruction to change it.
Get it wrong and the fix is a new vault, not a setting.

TAO is `taoC6xyv2v8tDLcev4uaGUgV4vdQsWJrGft2kcBRrBY`. Before initialising, ask the cluster what
that mint actually is rather than trusting the string:

```bash
solana account taoC6xyv2v8tDLcev4uaGUgV4vdQsWJrGft2kcBRrBY --url mainnet-beta
spl-token display taoC6xyv2v8tDLcev4uaGUgV4vdQsWJrGft2kcBRrBY --url mainnet-beta
```

What to check, and why each one matters:

- **It is a mint at all.** A base58 string that decodes cleanly is not evidence of anything; every
  32 bytes is a valid-looking address.
- **Decimals.** The split is integer arithmetic over base units, so decimals decide what a "share"
  is worth. The test suite uses 9, which is the Solana default.
- **Which token program owns it.** Classic SPL Token and Token-2022 are different programs. The
  vault uses `token_interface`, so it handles either — but the mint's owning program must be passed
  as `token_program` at `initialize`, and passing the wrong one fails there rather than later.
- **Whether it has a transfer fee.** A Token-2022 mint can charge a fee on every transfer. The
  vault's pool is its real balance, so a transfer fee on the way *in* is harmless, but a fee on the
  way *out* means a winner receives less than `claim` allocated. This is worth checking explicitly,
  because it is the one property that makes the arithmetic in this document wrong.

On a local validator, `makeMint` in `solana/tests/helpers.mjs` puts up a 9-decimal SPL stand-in.
A stand-in mint on mainnet is worthless.

## What this inherits

The winners are decided by verified lap times, so everything in
[DETERMINISM.md](DETERMINISM.md) and [THREAT-MODEL.md](THREAT-MODEL.md) applies here too — in
particular, the same oracle that signs a lap time also signs the day's standings, and is trusted
in the same way.
