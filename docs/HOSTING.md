# Hosting it

One process serves the game and the verification API on one port, so there is one thing to
deploy. It needs about **512 MB** (109 MB idle, 241 MB peak while replaying a run) and a little
disk for the leaderboard.

## Fly.io

```bash
fly launch --no-deploy            # pick a name, and set it in fly.toml + PUBLIC_URL
fly volumes create drive_data --size 1 --region lhr
fly deploy
```

`fly.toml` is written for this already. Three settings in it matter:

- **`max_machines_running = 1`.** `oracle/store.mjs` is a single-process file store — a JSON index
  plus one file per run, serialised by an in-process write queue. Two machines over one volume
  would corrupt the index. Scaling out means replacing the store with a database first.
- **`TRUST_PROXY = "1"`.** Fly's router terminates the connection, so without this every request
  looks like it comes from the same address and the whole team shares one rate-limit allowance
  (20 verifications a minute). Only ever set this behind a proxy you control — a client can
  otherwise forge `X-Forwarded-For` and hand itself an unlimited budget.
- **The `drive_data` mount.** Miss it and every deploy wipes the leaderboard.

## Any VPS with Docker

```bash
docker build -t drive .
docker volume create drive_data
docker run -d --name drive -p 8712:8712 \
  -v drive_data:/app/oracle/data \
  -e PUBLIC_URL=https://drive.yourdomain.com \
  -e TRUST_PROXY=1 \
  drive
```

Put a reverse proxy in front for TLS. `TRUST_PROXY=1` is correct here for the same reason, and
only if the proxy is the one setting the header.

## Without Docker

```bash
npm ci --omit=dev
HOST=0.0.0.0 PUBLIC_URL=https://drive.yourdomain.com TRUST_PROXY=1 npm start
```

Runs on Node 22+. `npm ci` at the repo ROOT, not in `oracle/` — the game's modules import `three`
by bare specifier, and Node resolves that by walking up from the importing file, so it has to be
installed at the top.

## What the team gets

No wallet, no chain, no accounts. Open the URL and drive.

- **Verified time trials** — three solo laps, replayed on the server, timed to the millisecond.
- **A shared leaderboard** — one row per person, best time each.
- **Ghosts** — race anyone's posted run. The ghost is their actual inputs re-driven, not a
  recorded path, so it drives the lap it was timed for.
- **Names** — each browser mints itself an id on first run and the player picks a display name
  (Stakes → Board → *Racing as*). Identity lives in that browser's `localStorage`, so a different
  browser or a cleared profile is a different player. Private windows are ephemeral and the UI
  says so.

The duels, pots and daily-prize tabs hide themselves when no contracts are deployed, which is the
default for a hosted build: `CLUSTER` is unset, so the oracle comes up chainless and the game
hides the staking tabs. That is one variable, deliberately — the program ids are compile-time
constants, so there is nothing else that could accidentally half-configure a chain.

To turn staking on later, set `CLUSTER` (`devnet` or `mainnet-beta`), optionally `RPC_URL` for a
paid endpoint, `ORACLE_KEYPAIR`, and `PRIVY_APP_ID`. The oracle **refuses to start** on a
non-local cluster while it is still using the development key.

## The two Privy values are not alike

`PRIVY_APP_ID` is **public**. It identifies the app to Privy, it is embedded in every client that
loads the wallet bundle, and it belongs in `fly.toml` like any other setting - it is a
publishable key, not a credential.

The Privy **app secret** is a credential. It is for server-to-server calls, this oracle makes
none, and it must never be written to `fly.toml`, to any file in this repo, or to the client. If
server-side Privy calls are ever needed:

```bash
fly secrets set PRIVY_APP_SECRET=...
```

which stores it encrypted and injects it at runtime. A secret that has been pasted anywhere it
should not be - a chat, a ticket, a commit - is burned; rotate it in the Privy dashboard rather
than hoping.

## Health and operations

- `GET /api/health` — liveness, no simulation and no chain call.
- `SIGTERM` closes the server and lets in-flight writes finish, so a redeploy cannot truncate
  `runs.json`.
- Disk grows by roughly **15 kB per verified run**. That is the point — a time means nothing if
  the run behind it is gone — but there is no pruning, so a 1 GB volume holds on the order of
  60 000 runs.
- The rate limit is 20 verifications per IP per minute. It is a speed bump, not protection; put a
  real limiter in front of anything public.

## One thing to know about the signing key

A chainless deployment still signs attestations, and they are unusable — there is no cluster to
spend them on. So the development key is harmless here, and the oracle allows it while `CLUSTER`
is unset or local.

The moment you point it at a real cluster it will **refuse to start** without `ORACLE_KEYPAIR`.
That is deliberate: see [THREAT-MODEL.md](THREAT-MODEL.md).
