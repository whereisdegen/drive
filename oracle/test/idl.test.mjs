/**
 * The oracle's copy of each IDL must match the Anchor build.
 *
 * A stale IDL is a nasty failure: Anchor encodes instructions from it, so a copy that has drifted
 * produces transactions the deployed program rejects - or, worse, encodes the wrong argument into
 * the right-looking instruction. Nothing about the error says "your IDL is old".
 *
 * These assertions are skipped when `solana/target/` is absent, which is the normal state of a
 * fresh clone and of the deployed image. They are not skipped when it is present, which is the
 * only situation where drift can be introduced.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const NAMES = ['race_stakes', 'reward_vault'];
const built = (n) => new URL(`../../solana/target/idl/${n}.json`, import.meta.url).pathname;
const mine = (n) => new URL(`../idl/${n}.json`, import.meta.url).pathname;

for (const name of NAMES) {
  test(`oracle/idl/${name}.json is present and parses`, () => {
    assert.ok(existsSync(mine(name)), `${mine(name)} is missing - run npm run sync-idl`);
    const idl = JSON.parse(readFileSync(mine(name), 'utf8'));
    assert.equal(idl.metadata.name, name);
    assert.ok(Array.isArray(idl.instructions) && idl.instructions.length > 0);
  });

  test(`oracle/idl/${name}.json matches the anchor build`, { skip: !existsSync(built(name)) && 'no solana/target - nothing to compare against' }, () => {
    assert.equal(
      readFileSync(mine(name), 'utf8'),
      readFileSync(built(name), 'utf8'),
      `oracle/idl/${name}.json has drifted from the build. Run: npm run sync-idl`,
    );
  });
}

test('the program ids in the IDLs are the ones config.mjs expects', async () => {
  // config.mjs hardcodes them because declare_id! makes them constants. If a program is ever
  // rebuilt under a new id, this is what catches the mismatch before a single transaction is sent.
  const { RACE_STAKES_PROGRAM, REWARD_VAULT_PROGRAM } = await import('../config.mjs');
  const idOf = (n) => JSON.parse(readFileSync(mine(n), 'utf8')).address;
  assert.equal(idOf('race_stakes'), RACE_STAKES_PROGRAM);
  assert.equal(idOf('reward_vault'), REWARD_VAULT_PROGRAM);
});
