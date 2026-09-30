# TENSORACE — on-chain time trials

[404-Repo/drive](https://github.com/404-Repo/drive) with a staking layer on **Solana**: post a
verified lap time, stake on it, and let someone try to beat it — and a daily TAO prize for the
five fastest drivers of each UTC day.

The game is unchanged to play. What is added is a second mode — a solo, item-free time trial
that can be **proved** — and the machinery to settle tokens on the result.

```
  drive a time trial          the oracle re-drives your inputs        the program settles
  ──────────────────          ───────────────────────────────         ────────────────────
  100 Hz fixed step           same physics, headless, ~80 ms          duel: faster time takes
  inputs recorded per tick    reports the time IT measured            the pot
  ~15 kB of trace             signs an Ed25519 attestation            pot: fastest of all entrants
                                                                      daily: top 5 split TAO
```

Three ways to be paid for being quick:

| | |
| --- | --- |
| **Duel** | Post a verified time and a stake. Someone matches it and gets a window to beat it. |
| **Pot** | Open time attack: everyone pays the same entry, fastest single time takes the pool. |
| **Daily** | At 00:00 UTC, 10% of the TAO fee pool is split 40/25/15/12/8 between that day's five fastest. Claimable for 90 days — [docs/REWARDS.md](docs/REWARDS.md). |

## The one idea

**A lap time is not evidence.** Everything in a browser tab belongs to whoever opened the
console, so the system never accepts a time from a player. It accepts the *inputs* — the stick
positions, tick by tick — and re-drives them on the server through the game's own physics. The
number the oracle measures is the number that settles. What the player's screen said is recorded
next to it, and ignored.

That only works if two machines running the same inputs reach the same lap time to the
millisecond. Getting there was most of the work, and it uncovered a real bug: Chrome and Node
disagree on fourteen of eighteen `Math` functions, which diverged two of four test races about a
hundred seconds in. See **[docs/DETERMINISM.md](docs/DETERMINISM.md)**.

And it rests on a trusted oracle, which the contract says in its own header rather than hiding.
See **[docs/THREAT-MODEL.md](docs/THREAT-MODEL.md)**.

## Run it

```bash
npm install && npm start
```

Then open <http://127.0.0.1:8712>. The oracle serves the game and the API from one port, so
that is the whole setup. Press **Stakes → Drive a verified run** to set a time; the board and the
ghosts work with no wallet and no chain.

To stake, you need a cluster. The programs are Anchor programs in `solana/`:

```bash
cd solana && npm install && anchor build
```

Then, in two terminals:

```bash
# 1 - a local validator
solana-test-validator --reset

# 2 - deploy both programs, then initialise them
cd solana && anchor deploy --provider.cluster localnet
```

The program ids are fixed by `declare_id!`, so they are the same on every cluster and there is
nothing to copy between terminals:

| | |
| --- | --- |
| `race_stakes` | `3WpVj8hH1uRKF8m3N4R1zyQc1AmWomHSGyu5q5ujHH4o` |
| `reward_vault` | `7qLUeC98XAYMvCZybUK9e5vHGXd2u2JfCFTH4MFXSfoH` |

Without `CLUSTER` set, the oracle runs **chainless** — verified time trials, the shared board and
ghosts, no wallet anywhere, and the 5.2 MB wallet bundle is never even fetched. That is the
intended configuration for a hosted build, not a broken one.

## Wallets

Players connect a Solana wallet through [Privy](https://privy.io) — Phantom, Solflare or
Backpack. Set both `CLUSTER` and `PRIVY_APP_ID` to turn it on; either one missing means no wallet
is offered at all.

Guest play is unchanged: a random driver name per browser, times on the board, ghosts to race. A
wallet is needed only to stake, enter a pot or claim a prize.

Privy's SDK is React-only, so `game/wallet/` bundles it — with React — into
`game/vendor/wallet.js`, the project's single build artifact:

```bash
cd game/wallet && npm install && npm run build
```

The bundle is committed, so deploying needs no build step. `game/src/token/wallet.js` is the
boundary: plain functions, no React, and the only file the rest of the game talks to.

The bundle is **not** loaded until a player actually clicks connect.

The oracle signs with a development key (seed 42, the same one `solana/tests` trusts) until
`ORACLE_KEYPAIR` is set, and **refuses to start** with it on any non-local cluster.

The full suite — fresh validator, deploy, 29 tests including the settle tool as a subprocess:

```bash
cd solana && npm test
```

And the job that settles each day, for cron:

```bash
cd oracle && npm run settle        # DRY_RUN=1 to see what it would do
```

## Hosting it for other people

```bash
fly launch --no-deploy && fly volumes create drive_data --size 1 && fly deploy
```

`Dockerfile` and `fly.toml` are written for it, and any Docker host works the same way. A hosted
build comes up **drive-only** — verified time trials, a shared leaderboard and ghosts, with no
wallet or chain needed and nothing for your teammates to install. Players pick a display name;
the staking tabs hide themselves until contracts are deployed.

Details, including the single-machine constraint and the proxy setting that stops a team sharing
one rate limit: [docs/HOSTING.md](docs/HOSTING.md).

## Tests

```bash
npm test                    # 30: determinism, verification gates, the circuit, daily standings
cd onchain && npm test      # 49: attestations, duels, pots, the reward vault, admin
```

The suite that matters most is `oracle/test/verify.test.mjs` — it is a list of the ways someone
might try to post a time they did not drive, and the fact that each one is refused.

## What is where

| | |
| --- | --- |
| `game/src/token/simcore.js` | the deterministic time trial. **The browser and the oracle run this same file.** |
| `game/src/token/detmath.js` | `sin`/`cos`/`atan2`/`pow`/`exp`/`log`/`tanh`/`hypot` built from exact IEEE operations, so every engine agrees |
| `game/src/token/trace.js` | the input trace: 5 bytes per input *change*, not per tick |
| `game/src/token/timetrial.js` | the fixed-step loop on the player's machine |
| `game/src/token/ghost.js` | a ghost is the rival's inputs re-driven, not a recorded path |
| `game/src/token/ui.js` | board, duels, pots, and the verdict screen |
| `game/src/level/colliders.js` | the town's collision footprint, separated from its geometry |
| `oracle/replay.mjs` | the four gates a run passes before it is signed |
| `game/src/token/wallet.js` | the game's whole view of "a wallet": plain functions, lazily loaded, never probes for a provider |
| `game/wallet/src/bridge.jsx` | the only React in the project, and the only file that knows Privy exists |
| `oracle/keys.mjs` | the oracle's Ed25519 identity. Signs with node's built-in crypto and no signing library |
| `oracle/attest.mjs` | the only place the oracle key is used |
| `oracle/daily.mjs` | each UTC day's top five, and the signature that lets the vault pay them |
| `oracle/tools/settle.mjs` | the cron job that settles yesterday |
| `solana/programs/race_stakes/` | duels and pots, settled on signed attestations |
| `solana/programs/reward_vault/` | the daily TAO prize: 10% of the pool, 40/25/15/12/8, 90-day claims |
| `solana/programs/*/src/attest.rs` | reading the Ed25519 instruction back out of the sysvar, and checking every field of it |

### Changes to the original game

The staking layer is additive — `installTokens()` returns `null` if the oracle is unreachable and
the game runs exactly as before. Three things did change in place:

- **`src/token/detmath.js` is now used by the physics, spline, road, terrain and collision code**,
  in every race. Values move in the last bit or two; lap times were unchanged to the millisecond.
  One physics that behaves identically everywhere beats two that must be kept in agreement.
- **`level/build.js` lost ~120 lines** to `level/colliders.js`, which it now calls. Behaviour is
  identical — same 927 colliders, same order, same geometry hash, verified before and after.
- **`main.js` gained a branch in the frame loop**: when a staked run is active it advances the
  fixed-step simulation instead of the normal one. Rendering, HUD and audio are untouched.
