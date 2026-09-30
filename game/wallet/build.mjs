/**
 * TENSORACE  game/wallet/build.mjs
 *
 * Bundles src/bridge.jsx into game/vendor/wallet.js - one file, an ES module, loaded by the game
 * only when a player actually asks for a wallet.
 *
 * This is the project's only build step, and it exists for one reason: Privy's SDK is React-only.
 * Everything else in game/ is served exactly as it is written. So the output is committed, the
 * input is small, and the boundary is one file - `game/src/token/wallet.js` - which knows nothing
 * about React and would not change if Privy were replaced.
 *
 *   npm run build     once
 *   npm run watch     while editing the bridge
 */
import { build, context } from 'esbuild';
import { statSync } from 'node:fs';

const OUT = new URL('../vendor/wallet.js', import.meta.url).pathname;

const options = {
  entryPoints: [new URL('./src/bridge.jsx', import.meta.url).pathname],
  outfile: OUT,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  /**
   * Off by default. The map is 20 MB - four times the bundle - and almost all of it maps into
   * Privy's and React's minified internals rather than anything in this repo. `--sourcemap` when
   * you are actually debugging inside the bridge.
   */
  sourcemap: process.argv.includes('--sourcemap'),
  // React reads this; without it the bundle ships development warnings and is markedly slower
  define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
  /**
   * Privy imports EVM account-abstraction clients statically, even though a solana-only,
   * wallet-only config can never call them. They are aliased to a stub that throws, rather than
   * marked `external` - an external bare specifier would survive into the bundle and the browser
   * would fail to resolve it at load time, turning a dead code path into a broken page.
   */
  alias: {
    permissionless: new URL('./src/evm-stub.js', import.meta.url).pathname,
    'permissionless/clients/pimlico': new URL('./src/evm-stub.js', import.meta.url).pathname,
    '@abstract-foundation/agw-client': new URL('./src/evm-stub.js', import.meta.url).pathname,
  },
  loader: { '.jsx': 'jsx' },
  legalComments: 'none',
  logLevel: 'info',
  metafile: true,
};

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('[wallet] watching src/bridge.jsx');
} else {
  const result = await build(options);
  if (process.argv.includes('--analyze')) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(new URL('./meta.json', import.meta.url).pathname, JSON.stringify(result.metafile));
  }
  const kb = (statSync(OUT).size / 1024).toFixed(0);
  console.log(`[wallet] game/vendor/wallet.js  ${kb} kB`);
}
