/**
 * TENSORACE  game/wallet/src/bridge.jsx
 *
 * The only React in this project, and the only file that knows Privy exists.
 *
 * WHY THIS SHAPE. The game is vanilla ES modules served straight off disk, with an importmap and
 * no bundler - deliberately, because that is what makes `view source` match the repo. Privy's SDK
 * is React-only, and its vanilla `js-sdk-core` cannot connect external wallets at all (embedded
 * wallets only), which would rule out exactly the thing we need: letting a player use the Phantom
 * wallet that already holds their TAO.
 *
 * So React lives here, behind an imperative façade, bundled into one file. The game never imports
 * React, never renders a component, and talks to this through `game/src/token/wallet.js` - plain
 * functions and events. If Privy is ever swapped out, that boundary is the only thing another
 * implementation has to honour.
 *
 * A React component cannot be called imperatively, so <Bridge> copies its hook results into a
 * module-scoped `live` object on every render, and the façade reads from there. That is the whole
 * trick, and it is the reason this file is small.
 */
import React, { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider, useConnectWallet, usePrivy } from '@privy-io/react-auth';
import { toSolanaWalletConnectors, useWallets, useSignAndSendTransaction, useSignMessage } from '@privy-io/react-auth/solana';

/**
 * CAIP-2 chain ids, read out of the installed SDK rather than copied from a docs page.
 * `localnet` has no CAIP-2 id and no external wallet can reach 127.0.0.1 anyway, so it maps to
 * nothing: local development runs in guest mode, and devnet is the first cluster a wallet sees.
 */
const CHAIN = {
  'mainnet-beta': 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  devnet: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  testnet: 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z',
};

/** the latest hook values, refreshed on every render of <Bridge> */
const live = {
  ready: false,
  wallets: [],
  connectWallet: null,
  signAndSendTransaction: null,
  signMessage: null,
  logout: null,
};

const listeners = new Set();
let lastKey = '';

/** tell the game when the connected address changes, and only then */
function publish() {
  const key = `${live.ready}:${live.wallets.map((w) => w.address).join(',')}`;
  if (key === lastKey) return;
  lastKey = key;
  const snapshot = { ready: live.ready, address: live.wallets[0]?.address || null };
  for (const fn of listeners) {
    try {
      fn(snapshot);
    } catch (e) {
      // a throwing listener is the game's bug, not ours, and must not stop the others
      console.error('[wallet] listener threw:', e);
    }
  }
}

/**
 * The pending connect() call, if any.
 *
 * Privy reports the outcome of a connection through callbacks passed to the HOOK, not to
 * connectWallet() - which takes modal options instead, and silently ignores anything else handed
 * to it. Getting that wrong does not fail loudly: the modal works, the wallet connects, and the
 * promise simply never settles, leaving the caller's UI saying "Connecting..." forever. That is
 * why the resolver lives out here rather than in a closure around connectWallet().
 */
let pending = null;
const settle = (address) => {
  const p = pending;
  pending = null;
  if (p) p(address);
};

function Bridge() {
  const { ready, wallets } = useWallets();
  const { connectWallet } = useConnectWallet({
    onSuccess: ({ wallet }) => settle(wallet?.address || null),
    // every non-success path, dismissal ('exited_auth_flow') included. Closing the picker is an
    // ordinary decision, so it resolves with null rather than rejecting.
    onError: () => settle(null),
  });
  const { signAndSendTransaction } = useSignAndSendTransaction();
  const { signMessage } = useSignMessage();
  const { logout, authenticated } = usePrivy();

  live.ready = ready;
  live.wallets = wallets || [];
  live.connectWallet = connectWallet;
  live.signAndSendTransaction = signAndSendTransaction;
  live.signMessage = signMessage;
  live.logout = logout;
  live.authenticated = authenticated;

  // publish AFTER the render has committed, so the game never sees a half-updated snapshot
  const first = useRef(true);
  useEffect(() => {
    publish();
    first.current = false;
  });

  return null;                     // Privy renders its own modal into its own portal
}

/**
 * Start Privy. Resolves once the SDK reports ready, so the caller knows whether a previous
 * session was restored before it decides what to draw.
 */
export function mount({ appId, cluster, rpcUrl, accent = '#ff5a4d' }) {
  if (!appId) throw new Error('mount() needs a Privy app id');

  const host = document.createElement('div');
  host.id = 'privy-root';
  document.body.appendChild(host);

  const chain = CHAIN[cluster] || null;

  createRoot(host).render(
    <PrivyProvider
      appId={appId}
      config={{
        // Solana only. This one line is what stops Phantom - which injects window.ethereum as
        // well - from being treated as an Ethereum wallet and asking the player to switch chains.
        appearance: {
          walletChainType: 'solana-only',
          walletList: ['phantom', 'solflare', 'backpack'],
          theme: 'dark',
          accentColor: accent,
          logo: undefined,
          // Privy warns and overrides this unless email/sms/social are also on. Stating it
          // explicitly agrees with what it would do anyway, and keeps the console clean.
          showWalletLoginFirst: true,
        },
        // no embedded wallets: a wallet created here would hold no SOL and no TAO, so it could
        // neither pay a fee nor place a stake. Everyone who can stake already has a wallet.
        embeddedWallets: { createOnLogin: 'off', solana: { createOnLogin: 'off' } },
        loginMethods: ['wallet'],
        externalWallets: { solana: { connectors: toSolanaWalletConnectors() } },
        ...(rpcUrl && chain ? { solana: { rpcs: { [chain]: { rpc: rpcUrl } } } } : {}),
      }}
    >
      <Bridge />
    </PrivyProvider>,
  );

  return new Promise((resolve) => {
    const api = {
      /** the connected address, base58, or null */
      get address() {
        return live.wallets[0]?.address || null;
      },
      get ready() {
        return live.ready;
      },
      get cluster() {
        return cluster;
      },

      /** called with { ready, address } whenever the connection changes */
      onChange(fn) {
        listeners.add(fn);
        if (live.ready) fn({ ready: live.ready, address: api.address });
        return () => listeners.delete(fn);
      },

      /** opens Privy's wallet picker. Resolves to the address, or null if the player closed it. */
      async connect() {
        if (api.address) return api.address;
        if (pending) return null;          // one picker at a time
        const outcome = new Promise((done) => { pending = done; });
        live.connectWallet();
        await outcome;
        // read from the hook rather than trusting the callback's argument: by the time this
        // resolves, useWallets() is the authority on what is actually connected
        return api.address;
      },

      async disconnect() {
        if (live.logout) await live.logout();
        lastKey = '';
        publish();
      },

      /**
       * Sign and broadcast. `bytes` is a serialised transaction - Privy takes a Uint8Array
       * whatever built it, which is why this project keeps using web3.js and Anchor rather than
       * migrating to @solana/kit.
       */
      async signAndSend(bytes) {
        const wallet = live.wallets[0];
        if (!wallet) throw new Error('no wallet connected');
        const res = await live.signAndSendTransaction({
          transaction: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
          wallet,
          ...(chain ? { chain } : {}),
        });
        return res?.signature || res;
      },

      /** proves control of the address, for anything the oracle wants authenticated */
      async signMessage(message) {
        const wallet = live.wallets[0];
        if (!wallet) throw new Error('no wallet connected');
        const res = await live.signMessage({
          message: typeof message === 'string' ? new TextEncoder().encode(message) : message,
          wallet,
        });
        return res?.signature || res;
      },
    };

    // resolve as soon as Privy has decided whether a previous session exists
    const stop = api.onChange(({ ready }) => {
      if (!ready) return;
      stop();
      resolve(api);
    });
  });
}
