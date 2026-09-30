/**
 * DRIVE  oracle/tools/sync-idl.mjs
 *
 * Copies the two IDLs out of the Anchor build into `oracle/idl/`.
 *
 * WHY THE ORACLE KEEPS ITS OWN COPY. The oracle ships as its own package - the Docker image copies
 * `game/` and `oracle/` and nothing else, because the Rust workspace is 2 GB of `target/` that a
 * node process has no use for. Reading the IDL from `../../solana/target/` therefore worked on a
 * developer's machine and could never have worked in the deployed image, which is the worst shape
 * a dependency can have.
 *
 * So the IDL is an artifact the oracle owns, and this is the one command that refreshes it:
 *
 *     anchor build && node tools/sync-idl.mjs
 *
 * Run it after any change to a program's instructions or accounts. test/idl.test.mjs fails if the
 * copy has drifted from the build, so a forgotten sync is caught locally rather than by a
 * transaction that cannot be encoded.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const NAMES = ['race_stakes', 'reward_vault'];
const from = (n) => new URL(`../../solana/target/idl/${n}.json`, import.meta.url).pathname;
const to = (n) => new URL(`../idl/${n}.json`, import.meta.url).pathname;

let changed = 0;
for (const name of NAMES) {
  if (!existsSync(from(name))) {
    console.error(`[idl] ${from(name)} is missing - run \`anchor build\` in solana/ first`);
    process.exit(1);
  }
  const built = readFileSync(from(name), 'utf8');
  const mine = existsSync(to(name)) ? readFileSync(to(name), 'utf8') : null;
  if (built === mine) { console.log(`[idl] ${name} unchanged`); continue; }
  writeFileSync(to(name), built);
  console.log(`[idl] ${name} updated`);
  changed++;
}
console.log(changed ? `[idl] ${changed} file(s) written` : '[idl] already in sync');
