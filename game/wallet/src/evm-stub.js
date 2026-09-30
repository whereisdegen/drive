/**
 * Stubs for the EVM smart-account packages Privy imports but this app cannot reach.
 *
 * `permissionless` and `@abstract-foundation/agw-client` are ERC-4337 / Abstract-chain smart
 * account clients. Privy imports them statically, so a bundler must resolve them - but with
 * `walletChainType: 'solana-only'`, `loginMethods: ['wallet']` and no smart-wallet config, there
 * is no code path in this app that calls them. Installing ~30 MB of EVM account-abstraction
 * tooling to satisfy an import that never executes is the wrong trade.
 *
 * They throw rather than returning undefined. If one of these is ever actually called, the error
 * names the cause instead of surfacing three frames later as "x is not a function" - and it means
 * a config change has quietly turned on a feature this bundle does not carry.
 */
const unreachable = (what) => () => {
  throw new Error(
    `[wallet] ${what} was called, but this bundle is Solana-only and does not include ` +
    `EVM smart-account support. Something turned that on - check the PrivyProvider config ` +
    `in game/wallet/src/bridge.jsx, and see the alias list in game/wallet/build.mjs.`,
  );
};

export const createSmartAccountClient = unreachable('createSmartAccountClient (permissionless)');
export const createPimlicoClient = unreachable('createPimlicoClient (permissionless/clients/pimlico)');
export const createAbstractClient = unreachable('createAbstractClient (@abstract-foundation/agw-client)');
export default {};
