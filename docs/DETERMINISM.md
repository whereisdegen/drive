# Determinism

A staked time is settled by re-driving the player's recorded inputs on the server. That only
works if the server's simulation and the player's browser agree — not approximately, but to the
last bit, for about fifteen thousand consecutive steps. A kart race is chaotic: a difference too
small to print compounds into a different line into a corner, and then into a different race.

Four things had to be true. Three were easy. The fourth was not.

## 1. A fixed timestep

`main.js` runs the normal race on the real frame time, clamped to 50 ms. That is the right choice
for a game — it degrades gracefully — and it is unverifiable, because the result depends on how
fast your machine happened to be drawing.

A staked run instead steps at exactly **100 Hz** from an accumulator
(`src/token/timetrial.js`). Rendering still happens at whatever rate the display runs at; only
the simulation is pinned. A slow machine takes longer in wall-clock seconds to complete the run
and gets exactly the same lap time for it.

Consequence worth knowing: every time is a multiple of 10 ms. Two honest laps landing on the same
value is ordinary, not suspicious — see the note on heuristics in `THREAT-MODEL.md`.

## 2. Nothing random on the motion path

A staked run is solo and item-free, which removes `items.js` and `ai/racer.js` — and with them
every `Math.random()` that could touch a kart. What remains inside `physics.js` is one call at
line 475, the kerb rumble kick, which writes `kerbHopV` → `kerbHop`, and `kerbHop` is read only
by `kartview.js:1063` to lift the body mesh. It never re-enters the motion state, so it cannot
move the clock.

`simcore.normalizeBody()` additionally resets the view-side leftovers a previously-raced body
carries (smoothed steering angle, kerb spring, cobble shake). None of them feed motion today.
The point is not to rely on that still being true after the next change to `physics.js`.

## 3. The same circuit

The game builds its collision world from the render tier's density. The phone tier drops half the
`DENSITY_ASSETS`, two of which — `spectator_group` and `rock_boulder` — carry colliders. So a
phone genuinely collides with a different Sorrel Cove than a desktop does.

`src/level/colliders.js` builds the town's collision footprint from `PLACEMENTS` and the `SIZES`
table alone, without loading a single asset. `buildLevel()` calls it, and so does the oracle;
there is one implementation. A staked run always builds it at **density 1**, so every device and
the server collide with the same **927 colliders**, in the same order.

Verified by `oracle/test/world.test.mjs`: a phone-tier world and the oracle's produce an
identical collider hash, and the road surface probes identically across tiers over 13 500 samples.

## 4. The same arithmetic — the one that bit

ECMAScript pins `+ - * /` and `Math.sqrt` to IEEE-754. It explicitly does **not** specify the
accuracy of `Math.sin`, `cos`, `tan`, `atan`, `atan2`, `exp`, `log` or `pow`. Engines may differ
by around an ulp, and they do.

Measured with `oracle/tools/mathprobe.mjs`, Chrome 148.0.7778.280 against Node 23.7.0
(V8 12.9.202.28) — the same engine family:

| agree | differ |
| --- | --- |
| `sqrt` `cbrt` `log2` `hypot` | `sin` `cos` `tan` `asin` `acos` `atan` `atan2` `exp` `log` `pow` `tanh` `sinh` `log10` `expm1` |

Fourteen of eighteen. In practice: of four full races driven in Chrome and replayed in Node,
**two diverged** — one at tick 10 240, one at 13 568, each about a hundred seconds in. One of them
stopped finishing the race at all. A staking system cannot reject half its honest players.

`src/token/detmath.js` implements the needed functions from `+ - * / sqrt floor round abs` only —
all exactly specified — using the classic fdlibm kernels. Two engines running them produce
identical doubles by construction rather than by luck. Accuracy against the host `Math`, measured
in `oracle/test/determinism.test.mjs`: 1–2 ulps for `sin`, `cos`, `atan`, `exp`, `log`, `tanh`,
`atan2`; 12 for `pow`. Nothing a driver can feel — lap times were unchanged to the millisecond
after the swap.

These are used by `physics.js`, `spline.js`, `road.js`, `collision.js`, `terrain.js`, `race.js`,
`placements.js` and `colliders.js` for **every** race, not only staked ones. One physics that
behaves the same everywhere beats two that have to be kept in agreement. A test asserts that
none of those files calls the host `Math` on the simulation path, so the fix cannot quietly rot.

### Result

Seven full races driven in Chrome, replayed in Node: **7/7 verified, 0 of 436 state digests
mismatched**, every total identical to the millisecond, including two runs that involved a
respawn.

## Checking it yourself

```bash
npm test                 # repeatability, ulp bounds, and the no-host-Math guard
npm run mathprobe        # hash every Math function in this engine
```

Then in the browser console on the running game, hash the same sweep through `detmath` and
compare it against the constant asserted in `determinism.test.mjs` (`ab39accf`). If those two
disagree, that engine is not safe to set staked times on, and every posted time was set on
different physics.

## What is still not guaranteed

- **Untested engines.** Firefox and Safari have not been measured. `detmath` should make them
  agree by construction, but "should" is doing work there until somebody runs the sweep.
- **Detection, not prevention.** The trace carries a state digest every 256 ticks. If an engine
  does diverge, the run is **rejected** rather than settled at a time the player never drove —
  the oracle reports the tick the two histories parted. That is the backstop, and it is why
  `detmath` exists rather than being relied on alone.
- **The track is part of the contract.** `trackFingerprint()` hashes the spline *and* every
  collider. Change the town and every posted time belongs to a different track id.
