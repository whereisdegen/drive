/**
 * DRIVE  oracle/config.mjs
 *
 * Everything the oracle needs from its environment, with defaults that work against a local
 * `solana-test-validator` and NOTHING that is safe to ship as-is to mainnet.
 *
 * One thing changed shape when this moved from EVM to Solana, and it is worth saying why. On
 * EVM a contract's address is an output of deploying it, so the oracle had to be told four
 * addresses and "no addresses configured" was a reliable signal that nothing was deployed. An
 * Anchor program's id is a compile-time constant - `declare_id!` - and is the same on every
 * cluster. So the addresses below are not configuration at all, they are facts, and "is anything
 * deployed" is no longer answerable by looking at them.
 *
 * CLUSTER is therefore explicit. Unset means the chainless "just drive" build, which is how
 * tensorace.com runs: verified time trials, a shared board and ghosts, no wallet anywhere.
 */
import { readFileSync, existsSync } from 'node:fs';
import { loadKeypair, keypairFromSeed } from './keys.mjs';

const env = process.env;

/**
 * The program ids, from `declare_id!` in each program. Constants, not settings - an override
 * exists only so a fork can run its own copy, and using one means your players' wallets talk to
 * a program this repo did not build.
 */
export const RACE_STAKES_PROGRAM = env.RACE_STAKES_PROGRAM || '3WpVj8hH1uRKF8m3N4R1zyQc1AmWomHSGyu5q5ujHH4o';
export const REWARD_VAULT_PROGRAM = env.REWARD_VAULT_PROGRAM || '7qLUeC98XAYMvCZybUK9e5vHGXd2u2JfCFTH4MFXSfoH';

/** TAO: the token traders pay fees in and winners are paid in. An SPL mint, not a contract. */
export const REWARD_MINT = env.REWARD_MINT || 'taoC6xyv2v8tDLcev4uaGUgV4vdQsWJrGft2kcBRrBY';

/**
 * Privy application id. PUBLIC by design - it identifies the app to Privy and is embedded in
 * every client that loads the wallet bundle, exactly like a Stripe publishable key.
 *
 * The Privy APP SECRET is a different thing entirely and must never appear here, in the client,
 * or in this repo. It is only needed for server-to-server calls (verifying a Privy auth token,
 * for instance), and this oracle makes none - it authenticates nothing with Privy. If that ever
 * changes, the secret belongs in `fly secrets set`, read from the environment at runtime, and
 * never written to a file.
 */
export const PRIVY_APP_ID = env.PRIVY_APP_ID || '';

/**
 * Which cluster, and therefore whether there is a chain at all.
 *
 * Deliberately has no default. A missing value is a complete, working, intended configuration -
 * not a mistake to paper over with localnet, which would have the oracle quietly reconnecting to
 * a validator that was never meant to exist.
 */
export const CLUSTER = (env.CLUSTER || '').trim();
export const CHAINLESS = CLUSTER === '';

const DEFAULT_RPC = {
  localnet: 'http://127.0.0.1:8899',
  devnet: 'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
};
export const RPC_URL = env.RPC_URL || DEFAULT_RPC[CLUSTER] || DEFAULT_RPC.localnet;

/** the only clusters where a publicly derivable key is harmless */
export const IS_LOCAL_CLUSTER = CLUSTER === 'localnet' || /127\.0\.0\.1|localhost/.test(RPC_URL);

export const PORT = Number(env.PORT || 8712);
/** 127.0.0.1 keeps it private to this machine; set HOST=0.0.0.0 to serve a network or a container */
export const HOST = env.HOST || '127.0.0.1';
/** what to print and hand to players, when the bind address is not what they type */
export const PUBLIC_URL = (env.PUBLIC_URL || '').replace(/\/+$/, '');
/**
 * Trust X-Forwarded-For for rate limiting. ONLY when something you control sets it - a reverse
 * proxy, a tunnel, a PaaS router. Off by default because a client can otherwise forge the header
 * and hand itself an unlimited budget; on, because without it every player behind one proxy
 * shares a single allowance and the team locks each other out.
 */
export const TRUST_PROXY = env.TRUST_PROXY === '1';

/** how long a signed attestation stays usable. Short: it only has to survive one transaction. */
export const ATTESTATION_TTL = Number(env.ATTESTATION_TTL || 30 * 60);

export const DATA_DIR = env.DATA_DIR || new URL('./data/', import.meta.url).pathname;

/**
 * The development signer: seed 42, the same key solana/tests/helpers.mjs uses. Deterministic on
 * purpose, so `npm run demo:duel` works against a fresh validator with nothing configured - and
 * publicly derivable in one line by anyone reading this file, which is exactly why
 * assertSignerIsSafe() will not let it near a real cluster.
 */
export const DEV_ORACLE_SEED = 42;

export const keypair = env.ORACLE_KEYPAIR ? loadKeypair(env.ORACLE_KEYPAIR) : keypairFromSeed(DEV_ORACLE_SEED);
export const USING_DEV_KEY = keypair.address === keypairFromSeed(DEV_ORACLE_SEED).address;
/** the oracle's public identity, base58. Must equal `config.oracle` in both programs. */
export const ORACLE_ADDRESS = keypair.address;

/**
 * Refuse to sign for a real cluster with the key from the test suite.
 *
 * This was a warning once, and a warning is the wrong shape for it: the failure is silent, total
 * and irreversible - anyone can mint lap times and name themselves the day's winner, and nothing
 * about the system looks broken while it happens. A process that will not start is noticed in
 * seconds; a warning scrolled past at 2am is not.
 *
 * ALLOW_DEV_KEY=1 overrides, for knowingly testing against devnet with a worthless vault.
 */
export function assertSignerIsSafe() {
  if (!USING_DEV_KEY || CHAINLESS || IS_LOCAL_CLUSTER || env.ALLOW_DEV_KEY === '1') return;
  console.error(`
  REFUSING TO START.

  ORACLE_KEYPAIR is unset, so this process would sign with the development key
  (${ORACLE_ADDRESS}), which is seed 42 - derivable
  in one line by anyone who reads oracle/config.mjs. On ${CLUSTER} that means anyone can
  mint any lap time for any wallet, name themselves the winner of every day, and take the
  TAO pool.

  Set ORACLE_KEYPAIR to a keypair nobody else has - a path to a keypair file is better than
  the key itself in an environment variable - and make sure its public key matches the
  oracle recorded in both race_stakes and reward_vault.

  If you genuinely mean to run a throwaway signer on a public cluster, set ALLOW_DEV_KEY=1.
`);
  process.exit(1);
}

/** true when the private key is sitting in a file inside the repo, which is how .env files get committed */
export function keyLooksCommitted() {
  const spec = env.ORACLE_KEYPAIR;
  if (!spec) return false;
  try {
    const here = new URL('./', import.meta.url).pathname;
    // the keypair FILE being in the repo is the same exposure as the key being in a committed .env
    const asPath = spec.replace(/^~/, env.HOME || '~');
    if (existsSync(asPath) && !asPath.includes('/.config/solana/')) {
      const inRepo = new URL('../', import.meta.url).pathname;
      if (asPath.startsWith(inRepo)) return asPath;
    }
    for (const name of ['.env', '.env.local', '../.env']) {
      const path = here + name;
      if (existsSync(path) && readFileSync(path, 'utf8').includes(spec)) return path;
    }
  } catch { /* best effort */ }
  return false;
}

export function banner() {
  const lines = [`oracle signer   ${ORACLE_ADDRESS}`];

  if (CHAINLESS) {
    // a deliberate "just drive" deployment, not a broken one. Say so plainly, because a wall of
    // warnings about unset addresses is exactly what a misconfiguration looks like.
    lines.push('');
    lines.push('mode            DRIVE ONLY - CLUSTER is unset, so there is no chain.');
    lines.push('                Verified time trials, the shared board and ghosts all work.');
    lines.push('                Duels, pots and the daily prize hide themselves in the game.');
    lines.push('                To turn them on, set CLUSTER (localnet, devnet, mainnet-beta).');
    if (USING_DEV_KEY) {
      lines.push('');
      lines.push('                The signing key is the public development one. Harmless here:');
      lines.push('                there is no chain, so no signature can be spent on anything.');
    }
  } else {
    lines.push(`cluster         ${CLUSTER}`);
    lines.push(`rpc             ${RPC_URL}`);
    lines.push(`race_stakes     ${RACE_STAKES_PROGRAM}`);
    lines.push(`privy app       ${PRIVY_APP_ID || '(unset - players cannot connect a wallet)'}`);
    lines.push(`reward_vault    ${REWARD_VAULT_PROGRAM}`);
    lines.push(`TAO mint        ${REWARD_MINT}`);
    if (USING_DEV_KEY) {
      lines.push('');
      lines.push('!! ORACLE_KEYPAIR is unset, so this process is signing with the development key,');
      lines.push('!! seed 42, which anyone reading config.mjs can reproduce. Allowed here only');
      lines.push(`!! because ${CLUSTER} is local. On any other cluster this process refuses to start.`);
    }
  }

  const committed = keyLooksCommitted();
  if (committed) {
    lines.push('');
    lines.push(`!! the signing key is sitting in ${committed}. Check it is gitignored, and treat it`);
    lines.push('!! as exposed if that file has ever been committed, copied or backed up.');
  }
  return lines.join('\n');
}
