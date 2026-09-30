/**
 * TENSORACE  src/token/wallet.js  (owner: token)
 *
 * The game's whole view of "a wallet". Plain functions, no framework, nothing imported until a
 * player actually asks to connect.
 *
 * Two properties this file exists to protect:
 *
 * 1. NOTHING LOADS UNTIL IT IS WANTED. The Privy bundle is 5.2 MB (1.5 MB over the wire) because
 *    its SDK carries the whole EVM and WalletConnect world with it. A racing game must not pay
 *    that to show a start button, so `vendor/wallet.js` is a dynamic import triggered by a click
 *    and by nothing else. Guest play never touches it.
 *
 * 2. NO WALLET CODE RUNS WITHOUT A CLUSTER. The previous version of this module probed
 *    `window.ethereum` on load to decide whether to offer a wallet. Phantom injects
 *    `window.ethereum` as well as its Solana provider, so that probe found it, auto-connected,
 *    and asked players to switch to an EVM chain that does not exist - on a build with no
 *    contracts at all. The oracle now states `cluster: null` when there is no chain, and this
 *    module refuses to load anything in that case. It never probes for a provider.
 */

let api = null;          // the bridge, once loaded
let loading = null;      // in-flight load, so two clicks do not build two Privy clients
let config = null;       // { privyAppId, cluster, rpcUrl } from the oracle

const listeners = new Set();
let current = { ready: false, address: null, available: false };

/**
 * Called once at startup with the oracle's /api/config. Cheap and synchronous: it decides whether
 * a wallet is POSSIBLE, and loads nothing.
 */
export function configure(cfg) {
  const privyAppId = cfg?.privyAppId || null;
  const cluster = cfg?.cluster || null;
  /**
   * Only the app id is required. A cluster is what makes a wallet able to SIGN; it is not what
   * makes one worth connecting. Without one, connecting still does the useful thing: the player
   * races as their own address rather than a name this browser invented, so their row survives a
   * cleared cache and follows them to another machine.
   *
   * What a wallet cannot do without a cluster is send a transaction - and nothing offers to,
   * because the staking tabs read their own flag, not this one.
   */
  config = privyAppId ? { privyAppId, cluster, rpcUrl: cfg.rpcUrl || null } : null;
  current = { ...current, available: !!config };
  emit();
  return current.available;
}

/** true when connecting is even an option. The UI hides its wallet controls when this is false. */
export const available = () => !!config;

export const address = () => current.address;
export const cluster = () => config?.cluster || null;

function emit() {
  for (const fn of listeners) {
    try {
      fn(current);
    } catch (e) {
      console.error('[wallet] listener threw:', e);
    }
  }
}

/** subscribe to { ready, address, available }. Returns an unsubscribe function. */
export function onChange(fn) {
  listeners.add(fn);
  fn(current);
  return () => listeners.delete(fn);
}

/**
 * Load the bridge. Idempotent, and concurrent callers share one load - Privy's SDK warns that a
 * second client instance causes undefined behaviour, so this is not merely an optimisation.
 */
async function load() {
  if (api) return api;
  if (loading) return loading;
  if (!config) throw new Error('no wallet configured');

  loading = (async () => {
    // literal specifier: the importmap and the build stamp both rewrite paths, and a computed
    // one cannot be analysed by either
    const mod = await import('../../vendor/wallet.js');
    api = await mod.mount({
      appId: config.privyAppId,
      cluster: config.cluster,
      rpcUrl: config.rpcUrl,
    });
    api.onChange(({ ready, address: addr }) => {
      current = { ready, address: addr, available: true };
      emit();
    });
    return api;
  })();

  try {
    return await loading;
  } catch (e) {
    loading = null;          // let a failed load be retried; a network blip should not be fatal
    throw e;
  }
}

/**
 * Open the wallet picker. Resolves to the address, or null if the player closed the modal -
 * closing it is an ordinary outcome, not an error, and the UI should simply stay as it was.
 */
export async function connect() {
  const w = await load();
  return w.connect();
}

export async function disconnect() {
  if (!api) return;
  await api.disconnect();
}

/**
 * Sign and broadcast a serialised transaction. Takes bytes rather than a Transaction object so
 * this boundary does not depend on which Solana library built it.
 * @param {Uint8Array} bytes
 * @returns {Promise<string>} the signature
 */
export async function signAndSend(bytes) {
  if (!api) throw new Error('connect a wallet first');
  return api.signAndSend(bytes);
}

/** prove control of the connected address */
export async function signMessage(message) {
  if (!api) throw new Error('connect a wallet first');
  return api.signMessage(message);
}

/** how an address is shown in the UI: first four and last four, which is what wallets do */
export const short = (a) => (a && a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || '');
