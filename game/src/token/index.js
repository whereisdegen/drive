/**
 * DRIVE  src/token/index.js  (owner: token)
 *
 * The seam between the game and the staking layer. main.js hands it the objects it already
 * built - the collision world, the player's body, the views, the input - and gets back one
 * controller with three things the frame loop cares about: whether a staked run is on, how to
 * advance it, and which Race the HUD should be reading.
 *
 * Deliberately the ONLY file that main.js has to know about. Everything else in src/token is
 * reached through here, so the game's own modules stay unaware that any of this exists and a
 * build with the token layer deleted still runs.
 */
import { gridSlots, stakeWorld } from './simcore.js?v=r6-20260906191941';
import { World } from '../track/collision.js?v=r6-20260906191941';
import { registerLevelColliders } from '../level/colliders.js?v=r6-20260906191941';
import { createTrial } from './timetrial.js?v=r6-20260906191941';
import { installStakes, fmtMs } from './ui.js?v=r6-20260906191941';

const GHOST_LIVERY = { body: 0x9fb3c8, suit: 0xd8e2ec, helmet: 0x9fb3c8, stripe: 0xeef3f8 };

/**
 * @param {object} ctx everything the trial needs from main.js's boot
 * @returns {Promise<object|null>} the controller, or null when the oracle is not reachable
 *          (the plain game must not break because a server is down)
 */
export async function installTokens(ctx) {
  const {
    THREE, world, spline, road, terrain, scene, playerBody, views, input, touch, tier,
    laps, hud, KartBody, Race, Player, KartView, GRID, START_PROGRESS, CHECKPOINTS,
    onTrialStart, onTrialEnd,
  } = ctx;

  // A staked run is NOT driven in the world the game races in. That world is built at the render
  // tier's density, and on a phone that drops half the spectator groups and boulders - colliders
  // included - so a phone would be timed on a slightly emptier circuit than a desktop and the
  // oracle would disagree with both. This is the canonical one: same spline, road and terrain
  // (all tier-independent), full density, identical to what oracle/replay.mjs builds.
  const stake = stakeWorld(THREE, { spline, road, terrain, World, registerLevelColliders });
  const track = {
    spline, road, terrain, world: stake,
    slots: gridSlots(stake, spline, GRID),
    startProgress: START_PROGRESS,
    checkpoints: CHECKPOINTS,
  };

  let ui;
  try {
    ui = await installStakes({ onRace: (intent) => begin(intent) });
  } catch (e) {
    console.warn('[token] staking layer unavailable:', e && e.message);
    return null;
  }

  const ghostView = new KartView({ scene, livery: GHOST_LIVERY, id: 999, hero: false });
  ghostView.object.visible = false;

  const trial = await createTrial({
    THREE, track, playerBody, ghostView, input, touch, tier, laps,
    KartBody, Race, Player,
  });

  let intent = null;
  let gapT = 0;
  let controller = null;

  trial.onFinish = async (trace) => {
    ui.hideGap();
    document.body.classList.remove('trial');
    if (onTrialEnd) onTrialEnd();
    hud.banner(trace.client.totalMs != null ? fmtMs(trace.client.totalMs) : 'RUN OVER', 2200);
    await ui.submitFinishedRun(trace, intent);
    intent = null;
  };

  function begin(next) {
    intent = next;
    document.body.classList.add('trial');
    if (onTrialStart) onTrialStart(next);
    trial.begin({ ghostBytes: next.ghostBytes || null });
    if (next.label) hud.banner(next.label.toUpperCase(), 2000);
  }

  ui.onAbandon = () => { if (controller) controller.abort(); };

  controller = {
    ui, trial, track,
    get active() { return trial.active; },
    get race() { return trial.race; },

    /** the frame loop's sim step while a staked run is on */
    advance(realDt) {
      trial.advance(realDt);
      // the ghost delta is refreshed a few times a second, not every frame: it is a glance value
      gapT -= realDt;
      if (gapT <= 0) {
        gapT = 0.2;
        const s = trial.status();
        ui.showGap(s.ghostGap == null ? null : s.ghostGap);
      }
    },

    updateViews(dt) { trial.updateViews(dt); },

    abort() {
      trial.abort();
      ui.hideGap();
      document.body.classList.remove('trial');
      if (onTrialEnd) onTrialEnd();
      intent = null;
      hud.banner('RUN ABANDONED', 1600);
    },
  };
  return controller;
}
