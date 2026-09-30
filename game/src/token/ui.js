/**
 * DRIVE  src/token/ui.js  (owner: token)
 *
 * The staking surface: the board, the duels, the pots, and the one screen that matters - what
 * the oracle measured when your run came back.
 *
 * Two rules run through all of it. Nothing spends money without a press that says what it will
 * spend, and the time shown next to a stake is always the ORACLE's number, never the one this
 * tab measured for itself. Where the two differ the screen shows both, because that difference
 * is the only visible symptom of a machine whose physics drifted, and hiding it would turn a
 * detectable fault into a silent one.
 */
import { CORAL, INK, PAPER, FONT, WIDE, PIX, h, esc, pressable } from '../ui/screens.js?v=r6-20260906191941';
import * as api from './api.js?v=r6-20260906191941';
import { guestId, guestName, setGuestName, isEphemeral } from './identity.js?v=r6-20260906191941';
import * as wallet from './wallet.js?v=r6-20260906191941';

export const fmtMs = (ms) => {
  if (ms == null || !isFinite(ms)) return '-';
  const t = ms / 1000, m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(3)}`;
};
const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '-');
/** a row's display label: the name they chose, else the address */
const who = (row) => (row && row.name ? row.name : short(row && row.driver));
const ago = (iso) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' d ago';
};


const CSS = `
#stakes,#stakebar{font-family:${FONT};font-weight:800;color:${PAPER};font-variant-numeric:tabular-nums;
  -webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}
#stakebar{position:fixed;top:max(12px,env(safe-area-inset-top));right:max(12px,env(safe-area-inset-right));
  z-index:25;display:flex;gap:8px;align-items:center;pointer-events:auto}
#stakebar .chip{background:rgba(16,12,10,.72);border:2px solid rgba(242,236,226,.16);padding:7px 11px;
  font-family:${PIX};font-size:11px;letter-spacing:.09em;text-transform:uppercase;line-height:1}
#stakebar .chip.go{background:${CORAL};border-color:${CORAL};color:${INK};cursor:pointer}
#stakebar .chip.go:active{transform:translateY(1px)}

#stakes{position:fixed;inset:0;z-index:40;display:none;background:rgba(16,12,10,.82);
  backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
#stakes.on{display:flex;align-items:center;justify-content:center;padding:16px}
#stakes .sheet{width:min(760px,100%);max-height:min(88vh,880px);display:flex;flex-direction:column;
  background:${INK};border:3px solid ${CORAL}}
#stakes header{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:2px solid rgba(242,236,226,.14)}
#stakes .ttl{font-family:${WIDE};font-weight:900;font-size:26px;letter-spacing:-.03em;text-transform:uppercase;line-height:1}
#stakes .ttl i{font-style:normal;color:${CORAL}}
#stakes .spacer{flex:1}
#stakes .pix{font-family:${PIX};font-weight:400;font-size:11px;letter-spacing:.09em;text-transform:uppercase}
/* the wallet label doubles as the connect/disconnect control when a wallet is possible */
#stakes .pix.go{cursor:pointer;color:${CORAL};border-bottom:1px dotted ${CORAL};padding-bottom:1px}
#stakes .pix.go:active{transform:translateY(1px)}
#stakes nav{display:flex;gap:0;border-bottom:2px solid rgba(242,236,226,.14)}
#stakes nav button{flex:1;background:none;border:0;border-bottom:3px solid transparent;color:rgba(242,236,226,.55);
  font-family:${PIX};font-size:11px;letter-spacing:.11em;text-transform:uppercase;padding:11px 6px;cursor:pointer}
#stakes nav button.on{color:${PAPER};border-bottom-color:${CORAL}}
#stakes .body{overflow:auto;padding:16px 18px;flex:1;min-height:180px}
#stakes .foot{padding:10px 18px;border-top:2px solid rgba(242,236,226,.14);font-size:12px;min-height:1.3em;opacity:.9}
#stakes .foot.bad{color:${CORAL}}

#stakes .row{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid rgba(242,236,226,.1)}
#stakes .row:last-child{border-bottom:0}
#stakes .rank{width:26px;color:${CORAL};font-family:${PIX};font-size:12px}
#stakes .who{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
#stakes .who small{display:block;font-weight:400;opacity:.5;font-size:11px}
#stakes .t{font-size:15px;letter-spacing:-.01em}
#stakes .t small{font-weight:400;opacity:.55;font-size:11px;display:block;text-align:right}
#stakes button.act{background:${CORAL};border:0;color:${INK};font-family:${PIX};font-size:11px;letter-spacing:.08em;
  text-transform:uppercase;padding:8px 11px;cursor:pointer;white-space:nowrap}
#stakes button.act.ghost{background:none;border:2px solid rgba(242,236,226,.3);color:${PAPER}}
#stakes button.act[disabled]{opacity:.35;cursor:default}
#stakes button.act:not([disabled]):active{transform:translateY(1px)}
#stakes input{background:rgba(242,236,226,.08);border:2px solid rgba(242,236,226,.2);color:${PAPER};
  font-family:${FONT};font-weight:800;font-size:14px;padding:8px 10px;width:110px}
#stakes .empty{opacity:.55;font-weight:400;font-size:13px;padding:18px 0;text-align:center}
#stakes .note{font-weight:400;font-size:12px;opacity:.65;line-height:1.55;margin:10px 0 0}
#stakes .warn{border-left:3px solid ${CORAL};padding:8px 0 8px 11px;margin:12px 0;font-weight:400;font-size:12px;line-height:1.55}
#stakes .card{border:2px solid rgba(242,236,226,.16);padding:13px;margin-bottom:11px}
#stakes .card h4{margin:0 0 8px;font-family:${PIX};font-weight:400;font-size:11px;letter-spacing:.1em;
  text-transform:uppercase;color:${CORAL}}
#stakes .grid{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
#stakes .big{font-family:${WIDE};font-weight:900;font-size:clamp(30px,7vw,44px);letter-spacing:-.03em;
  line-height:1.05;overflow-wrap:anywhere}
#stakes .big .unit{font-size:.42em;letter-spacing:0}
#stakes .laps{display:flex;gap:14px;margin-top:8px;font-weight:400;font-size:12px;opacity:.7}

/* a staked run is solo and item-free, so the item slot has nothing to show. The chip moves out
   from under the lap counter to the foot of the screen and becomes the way out of the run -
   there has to be one, or a bad lap traps you until you finish it. */
body.trial #hud .item{display:none}
body.trial #stakebar{top:auto;right:auto;left:50%;transform:translateX(-50%);
  bottom:max(14px,env(safe-area-inset-bottom))}
body.trial #sb-bal,body.trial #sb-open{display:none}
#sb-abandon{display:none}
body.trial #sb-abandon{display:block;background:rgba(16,12,10,.72);border-color:rgba(242,236,226,.3);
  color:${PAPER};cursor:pointer}

#tgap{position:fixed;left:50%;transform:translateX(-50%);top:max(14px,env(safe-area-inset-top));z-index:22;
  font-family:${PIX};font-size:13px;letter-spacing:.08em;padding:6px 12px;background:rgba(16,12,10,.7);
  display:none;color:${PAPER}}
#tgap.on{display:block}
#tgap.up{color:#7fd48a}
#tgap.down{color:${CORAL}}
`;

/**
 * @param {object} o
 * @param {function} o.onRace   called with an intent when the player commits to a staked run:
 *                              ({ kind, ghostBytes, label, duelId, potId, stake }) => void
 */
export async function installStakes({ onRace }) {
  // Reach the oracle FIRST. If it is not there, this throws before a single element is added to
  // the page, and the game is left exactly as it would be without any of this - rather than
  // carrying a Stakes button that does nothing.
  const config = await api.getConfig();

  /**
   * Is a wallet even possible here? The oracle says so by sending BOTH a cluster and a Privy app
   * id; either missing means this is a drive-only build.
   *
   * This must not be decided by looking for a wallet. The previous version probed
   * `window.ethereum`, and Phantom injects that alongside its Solana provider - so a build with
   * no contracts at all found "a wallet", connected to it, and asked players to switch to an EVM
   * chain that did not exist. wallet.js therefore never probes: it is told, or it stays asleep.
   */
  const walletPossible = wallet.configure(config);

  const reason = (e) => String((e && (e.shortMessage || e.message)) || e).split('\n')[0];

  /**
   * The adapter the rest of this file talks to.
   *
   * Connecting and identity are live. Everything that sends a transaction - duels, pots, claims -
   * reads `deployed`/`vaultDeployed`, which are false until the Anchor transaction layer replaces
   * the old viem `chain.js`. So those tabs hide themselves exactly as they do on a drive-only
   * build, rather than offering buttons that would throw. This object is the seam where that
   * layer lands; nothing else in this file has to change when it does.
   */
  const chain = walletPossible ? {
    get connected() { return !!wallet.address(); },
    get account() { return wallet.address(); },
    connect: () => wallet.connect(),
    disconnect: () => wallet.disconnect(),
    deployed: false,
    vaultDeployed: false,
    symbol: 'TAO',
  } : null;

  document.head.appendChild(Object.assign(document.createElement('style'), { textContent: CSS }));

  const bar = h(`<div id="stakebar">
    <div class="chip" id="sb-bal">not connected</div>
    <div class="chip go" id="sb-open">Stakes</div>
    <div class="chip go" id="sb-abandon">Abandon run</div>
  </div>`);
  const panel = h(`<div id="stakes"><div class="sheet">
    <header>
      <div class="ttl">TENSO<i>RACE</i> STAKES</div><div class="spacer"></div>
      <div class="pix" id="sk-wallet">no wallet</div>
      <button class="act ghost" id="sk-close">Close</button>
    </header>
    <nav>
      <button data-tab="board" class="on">Board</button>
      <button data-tab="duels">Duels</button>
      <button data-tab="pots">Pots</button>
      <button data-tab="daily">Daily</button>
      <button data-tab="run">Your run</button>
    </nav>
    <div class="body" id="sk-body"></div>
    <div class="foot" id="sk-foot"></div>
  </div></div>`);
  const gap = h(`<div id="tgap"></div>`);
  document.body.append(bar, panel, gap);

  const body = panel.querySelector('#sk-body');
  const foot = panel.querySelector('#sk-foot');
  const walletLabel = panel.querySelector('#sk-wallet');
  const balChip = bar.querySelector('#sb-bal');

  let tab = 'board';
  let busy = false;
  /** the last run the oracle verified and signed, waiting to be spent on something */
  let attested = null;
  let lastVerify = null;
  /** a deadline h_ hours from now, in the chain's clock rather than this browser's */
  const inHours = async (h_) => (await chain.now()) + Math.round(h_ * 3600);

  /** whichever identity this browser is racing under right now */
  const myId = () => (chain && chain.connected ? chain.account : guestId());

  const say = (msg, bad = false) => { foot.textContent = msg || ''; foot.classList.toggle('bad', !!bad); };
  const setBusy = (b) => { busy = b; body.querySelectorAll('button.act').forEach((x) => { x.disabled = b; }); };

  async function guard(label, fn) {
    if (busy) return;
    setBusy(true);
    say(label + '…');
    try {
      const out = await fn();
      if (out !== false) say(label + ' — done.');
      return out;
    } catch (e) {
      say(reason(e), true);
      return null;
    } finally {
      setBusy(false);
      refreshChips();
    }
  }

  async function refreshChips() {
    if (!chain || !chain.connected) {
      balChip.textContent = guestName();
      walletLabel.textContent = chain ? 'connect wallet' : 'guest';
      return;
    }
    walletLabel.textContent = short(chain.account);
    // no balance yet: reading it needs the SPL token layer that lands with the transactions
    balChip.textContent = short(chain.account);
  }

  // ---------------------------------------------------------------- tabs

  const TABS = { board: renderBoard, duels: renderDuels, pots: renderPots, daily: renderDaily, run: renderRun };

  /** duels, pots and the daily prize only mean anything when something is deployed */
  const chainFeatures = () => !!(chain && (chain.deployed || chain.vaultDeployed));

  async function render() {
    // a drive-only deployment hides the chain tabs rather than showing three dead ends
    const on = chainFeatures();
    for (const b of panel.querySelectorAll('nav button')) {
      if (['duels', 'pots', 'daily'].includes(b.dataset.tab)) b.hidden = !on;
    }
    if (!on && ['duels', 'pots', 'daily'].includes(tab)) tab = 'board';
    panel.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    body.innerHTML = '<div class="empty">loading…</div>';
    try {
      await TABS[tab]();
    } catch (e) {
      body.innerHTML = '';
      body.append(h(`<div class="empty">${esc(reason(e))}</div>`));
    }
  }

  function noChainLayer() {
    return h(`<div class="warn">The wallet library could not be loaded, so staking is off in this
      session. Setting verified times and racing ghosts still work.</div>`);
  }

  function needWallet(where) {
    const el = h(`<div><div class="empty">Connect a wallet to ${esc(where)}.</div></div>`);
    const btn = h(`<div style="text-align:center"><button class="act" id="cw">Connect wallet</button></div>`);
    pressable(btn.querySelector('#cw'), () => guard('Connecting', async () => { await chain.connect(); render(); }));
    el.append(btn);
    el.append(h(`<p class="note">Phantom, Solflare or Backpack. The board and the ghosts work
      without one; staking does not.</p>`));
    return el;
  }

  function notDeployed() {
    return h(`<div class="warn">RaceStakes is not deployed on chain ${config.chainId} yet, so nothing here can be staked.
      Deploy it with <b>onchain/scripts/deploy.cjs</b>, export the addresses, and restart the oracle.
      Setting times and racing ghosts works regardless.</div>`);
  }

  // ---------------------------------------------------------------- board

  async function renderBoard() {
    const { rows } = await api.getLeaderboard(25);
    body.innerHTML = '';
    // only worth saying when a signature could actually be spent on something
    if (config.devKey && chainFeatures()) {
      body.append(h(`<div class="warn">This oracle is signing with a publicly known development key, so its
        signatures are worthless as evidence. Fine for local play; see docs/THREAT-MODEL.md before
        pointing this at a chain that matters.</div>`));
    }
    // who you are on this board. With a wallet that is your address; without one, a name you pick.
    if (!chain || !chain.connected) {
      const idCard = h(`<div class="card"><h4>Racing as</h4>
        <div class="grid"><input id="sk-name" type="text" maxlength="24" value="${esc(guestName())}" style="width:190px" />
          <button class="act" id="sk-savename">Save</button>
          <span class="note" style="margin:0">Shown on the board. Your times are kept per browser.</span></div>
        ${isEphemeral() ? '<div class="warn">This browser will not let the page remember anything, so a new identity is minted every reload and your times will not group together.</div>' : ''}
      </div>`);
      const save = () => {
        const v = setGuestName(idCard.querySelector('#sk-name').value);
        idCard.querySelector('#sk-name').value = v;
        refreshChips();
        say(`Racing as ${v}.`);
        render();
      };
      pressable(idCard.querySelector('#sk-savename'), save);
      idCard.querySelector('#sk-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
      body.append(idCard);
    }

    body.append(h(`<p class="note">Every time here was produced by re-driving that player's recorded inputs on the
      server. Press <b>Ghost</b> to race the run itself — same inputs, same physics, so it drives the lap it was signed for.</p>`));

    if (!rows.length) { body.append(h(`<div class="empty">Nobody has set a verified time yet. Be first.</div>`)); }
    for (const r of rows) {
      const mine = r.driver.toLowerCase() === myId().toLowerCase();
      const row = h(`<div class="row">
        <div class="rank">${r.rank}</div>
        <div class="who">${esc(who(r))}${mine ? ' (you)' : ''}<small>${esc(ago(r.at))}${r.respawns ? ` · ${r.respawns} respawn${r.respawns > 1 ? 's' : ''}` : ''}</small></div>
        <div class="t">${fmtMs(r.timeMs)}<small>best lap ${fmtMs(r.bestLapMs)}</small></div>
      </div>`);
      const g = h(`<button class="act ghost">Ghost</button>`);
      pressable(g, () => raceGhost(r));
      row.append(g);
      if (chainFeatures()) {
        const c = h(`<button class="act">Challenge</button>`);
        pressable(c, () => { tab = 'duels'; render().then(() => say(`Post a duel from your own verified run to challenge a time like ${fmtMs(r.timeMs)}.`)); });
        row.append(c);
      }
      body.append(row);
    }
    const fresh = h(`<div class="card" style="margin-top:14px"><h4>Set a time</h4>
      <div class="grid"><button class="act" id="sk-free">Drive a verified run</button>
      <span class="note" style="margin:0">${config.laps} laps, solo, no items. The only kind of run that can be staked.</span></div></div>`);
    pressable(fresh.querySelector('#sk-free'), () => startRun({ kind: 'free', label: 'Verified run' }));
    body.append(fresh);
  }

  async function raceGhost(row) {
    try {
      const ghostBytes = await api.getTraceBytes(row.id);
      startRun({ kind: 'free', ghostBytes, label: `Chasing ${short(row.driver)} — ${fmtMs(row.timeMs)}` });
    } catch (e) {
      say(reason(e), true);
    }
  }

  // ---------------------------------------------------------------- duels

  async function renderDuels() {
    body.innerHTML = '';
    if (!chain) { body.append(noChainLayer()); return; }
    if (!chain.deployed) { body.append(notDeployed()); return; }
    if (!chain.connected) { body.append(needWallet('duel')); return; }

    // open a duel from a run the oracle has already signed
    const open = h(`<div class="card"><h4>Post a challenge</h4></div>`);
    if (attested) {
      const g = h(`<div class="grid">
        <div class="t">${fmtMs(attested.timeMs)}</div>
        <input id="dst" type="number" min="0" step="1" value="100" />
        <span class="note" style="margin:0">${esc(chain.symbol)} each</span>
        <button class="act" id="dgo">Post it</button></div>`);
      pressable(g.querySelector('#dgo'), async () => {
        const stake = chain.parse(g.querySelector('#dst').value);
        if (stake <= 0n) return say('Stake something above zero.', true);
        await guard(`Posting a ${chain.fmt(stake)} ${chain.symbol} challenge`, async () => {
          await chain.ensureAllowance(stake);
          await chain.openDuel({ ...attested.attestation, stake, joinBy: await inHours(48), runWindow: 3600 });
          attested = null;
          await render();
        });
      });
      open.append(g, h(`<p class="note">Your stake is locked until someone matches it, you cancel, or 48 hours pass.
        Whoever accepts gets one hour to beat ${esc(fmtMs(attested.timeMs))}. A dead heat goes to you.</p>`));
    } else {
      const b = h(`<div class="grid"><button class="act" id="dnew">Drive a time to post</button>
        <span class="note" style="margin:0">You can only challenge with a time you have actually set.</span></div>`);
      pressable(b.querySelector('#dnew'), () => startRun({ kind: 'open', label: 'Run to post as a challenge' }));
      open.append(b);
    }
    body.append(open);

    const nowSec = await chain.now();
    const duels = await chain.recentDuels(12);
    const me = chain.account.toLowerCase();
    const live = duels.filter((d) => d.status === 'Open' || d.status === 'Accepted');
    if (!live.length) body.append(h(`<div class="empty">No live duels.</div>`));

    for (const d of live) {
      const mine = d.challenger.toLowerCase() === me;
      const theirs = d.opponent && d.opponent.toLowerCase() === me;
      const row = h(`<div class="row">
        <div class="who">${esc(short(d.challenger))}${mine ? ' (you)' : ''}<small>${d.status === 'Open'
          ? `open · ${chain.fmt(d.stake)} ${esc(chain.symbol)} a side`
          : `accepted by ${esc(short(d.opponent))}${theirs ? ' (you)' : ''}`}</small></div>
        <div class="t">${fmtMs(d.targetMs)}<small>to beat</small></div>
      </div>`);

      if (d.status === 'Open' && !mine) {
        const b = h(`<button class="act">Accept</button>`);
        pressable(b, () => guard(`Matching ${chain.fmt(d.stake)} ${chain.symbol}`, async () => {
          await chain.ensureAllowance(d.stake);
          await chain.acceptDuel(d.id);
          await render();
          say('Accepted. Drive it now — a time set before you accepted will not count.');
        }));
        row.append(b);
      } else if (d.status === 'Open' && mine) {
        const b = h(`<button class="act ghost">Cancel</button>`);
        pressable(b, () => guard('Cancelling', async () => { await chain.cancelDuel(d.id); await render(); }));
        row.append(b);
        if (nowSec > d.joinBy) {
          const r = h(`<button class="act">Reclaim</button>`);
          pressable(r, () => guard('Reclaiming', async () => { await chain.resolveExpiredDuel(d.id); await render(); }));
          row.append(r);
        }
      } else if (d.status === 'Accepted' && theirs) {
        const canSubmit = attested && attested.attestation.run.issuedAt >= String(d.acceptedAt);
        const b = h(`<button class="act">${canSubmit ? 'Submit ' + fmtMs(attested.timeMs) : 'Drive it'}</button>`);
        pressable(b, () => {
          if (canSubmit) {
            return guard('Submitting your time', async () => {
              await chain.submitDuel(d.id, attested.attestation);
              const was = attested.timeMs; attested = null;
              await render();
              say(was < d.targetMs ? `${fmtMs(was)} beats ${fmtMs(d.targetMs)} — the pot is yours.`
                                   : `${fmtMs(was)} did not beat ${fmtMs(d.targetMs)}. The pot went to the challenger.`);
            });
          }
          return startRun({ kind: 'duel', duelId: d.id, label: `Beat ${fmtMs(d.targetMs)}`, targetMs: d.targetMs });
        });
        row.append(b);
      } else if (d.status === 'Accepted' && mine && nowSec > d.runBy) {
        const b = h(`<button class="act">Claim</button>`);
        pressable(b, () => guard('Claiming the pot', async () => { await chain.resolveExpiredDuel(d.id); await render(); }));
        row.append(b);
      }
      body.append(row);
    }
  }

  // ---------------------------------------------------------------- pots

  async function renderPots() {
    body.innerHTML = '';
    if (!chain) { body.append(noChainLayer()); return; }
    if (!chain.deployed) { body.append(notDeployed()); return; }
    if (!chain.connected) { body.append(needWallet('enter a pot')); return; }

    const mk = h(`<div class="card"><h4>Open a time attack</h4>
      <div class="grid"><input id="pfee" type="number" min="1" step="1" value="50" />
        <span class="note" style="margin:0">${esc(chain.symbol)} entry</span>
        <input id="phrs" type="number" min="1" step="1" value="24" />
        <span class="note" style="margin:0">hours</span>
        <button class="act" id="pgo">Open</button></div>
      <p class="note">Anyone can enter and post as many times as they like; only their best counts.
      When it closes the single fastest verified time takes the pool.</p></div>`);
    pressable(mk.querySelector('#pgo'), () => {
      const fee = chain.parse(mk.querySelector('#pfee').value);
      const hrs = Number(mk.querySelector('#phrs').value) || 24;
      return guard('Opening a pot', async () => {
        await chain.createPot(config.trackId, fee, await inHours(hrs));
        await render();
      });
    });
    body.append(mk);

    const nowSec = await chain.now();
    const pots = (await chain.recentPots(8)).filter((p) => p.entryFee > 0n);
    if (!pots.length) body.append(h(`<div class="empty">No pots yet.</div>`));

    for (const p of pots) {
      const closed = nowSec >= p.closesAt;
      const entered = await chain.enteredPot(p.id);
      const row = h(`<div class="row">
        <div class="who">Pot #${p.id}<small>${p.entrants} in · ${chain.fmt(p.prize)} ${esc(chain.symbol)} pool · ${
          closed ? 'closed' : 'closes in ' + Math.max(1, Math.round((p.closesAt - nowSec) / 3600)) + ' h'}</small></div>
        <div class="t">${p.leader === '0x0000000000000000000000000000000000000000' ? '-' : fmtMs(p.leaderMs)}<small>${
          p.leader === '0x0000000000000000000000000000000000000000' ? 'no times yet' : 'leader ' + esc(short(p.leader))}</small></div>
      </div>`);

      if (p.settled) {
        row.append(h(`<span class="pix" style="opacity:.5">settled</span>`));
      } else if (closed) {
        const any = p.leader !== '0x0000000000000000000000000000000000000000';
        const b = h(`<button class="act">${any ? 'Pay the winner' : 'Refund me'}</button>`);
        pressable(b, () => guard(any ? 'Settling' : 'Refunding', async () => {
          await (any ? chain.settlePot(p.id) : chain.refundPot(p.id));
          await render();
        }));
        row.append(b);
      } else if (!entered) {
        const b = h(`<button class="act">Enter ${chain.fmt(p.entryFee)}</button>`);
        pressable(b, () => guard('Entering', async () => {
          await chain.ensureAllowance(p.entryFee);
          await chain.enterPot(p.id);
          await render();
        }));
        row.append(b);
      } else {
        const canPost = attested && attested.attestation.run.issuedAt >= String(p.opensAt);
        const b = h(`<button class="act">${canPost ? 'Post ' + fmtMs(attested.timeMs) : 'Drive a time'}</button>`);
        pressable(b, () => {
          if (canPost) {
            return guard('Posting your time', async () => {
              await chain.postPotTime(p.id, attested.attestation);
              attested = null;
              await render();
            });
          }
          return startRun({ kind: 'pot', potId: p.id, label: `Time attack — pot #${p.id}` });
        });
        row.append(b);
      }
      body.append(row);
    }
  }

  // ---------------------------------------------------------------- the daily prize

  const placeLabel = (n) => ['1st', '2nd', '3rd', '4th', '5th'][n - 1] || `${n}th`;

  async function renderDaily() {
    body.innerHTML = '';
    const d = await api.getDaily();
    const split = d.splitBps || [4000, 2500, 1500, 1200, 800];

    // the pool, if the vault is deployed and reachable
    let pool = null, payout = null;
    if (chain && chain.vaultDeployed) {
      try {
        pool = await chain.vaultPool();
        payout = await chain.vaultNextPayout();
      } catch { /* shown as unavailable below */ }
    }

    body.append(h(`<div class="card">
      <h4>The pool</h4>
      <div class="big">${pool === null ? '—' : esc(chain.fmtEth(pool)) + ' <span class="unit">WETH</span>'}</div>
      <p class="note">Trading fees collect here. At 00:00 UTC, <b>${(d.dailyBps ?? 1000) / 100}%</b> of whatever the
        pool holds is split between the five fastest drivers of that day — ${split.map((b) => b / 100 + '%').join(' / ')} —
        and the rest rolls into tomorrow, so the pool never empties.
        ${payout === null ? '' : `Settling now would pay out <b>${esc(chain.fmtEth(payout))} WETH</b>.`}
        Prizes are claimable for <b>${d.claimDays ?? 90} days</b>; anything unclaimed goes back into the pool.</p>
      ${pool === null ? '<div class="warn">The reward vault is not deployed on this chain yet, so the standings below are for show.</div>' : ''}
    </div>`));

    // today's standings
    const head = h(`<div class="card"><h4>${d.closed ? 'Day ' + d.day + ' — final' : "Today's standings, still running"}</h4>
      <p class="note" style="margin:0 0 6px">${esc(d.startsAt.slice(0, 10))} UTC · ${d.entrants} driver${d.entrants === 1 ? '' : 's'} ·
        your best verified time of the day is what counts, one place each.</p></div>`);
    if (!d.rows.length) {
      head.append(h(`<div class="empty">Nobody has set a verified time today. First one takes ${split[0] / 100}%.</div>`));
    }
    for (const r of d.rows) {
      const mine = r.driver.toLowerCase() === myId().toLowerCase();
      const cut = payout === null ? null : (payout * BigInt(r.shareBps)) / 10000n;
      head.append(h(`<div class="row">
        <div class="rank">${r.place}</div>
        <div class="who">${esc(who(r))}${mine ? ' (you)' : ''}<small>${esc(ago(r.at))}</small></div>
        <div class="t">${fmtMs(r.timeMs)}<small>${r.shareBps / 100}%${cut === null ? '' : ' · ' + esc(chain.fmtEth(cut)) + ' WETH'}</small></div>
      </div>`));
    }
    body.append(head);

    if (!chain) { body.append(noChainLayer()); return; }
    if (!chain.vaultDeployed) return;
    if (!chain.connected) { body.append(needWallet('claim a prize')); return; }

    // what this player can claim, across the days they actually placed in
    const card = h(`<div class="card"><h4>Your prizes</h4></div>`);
    let placed = [];
    try {
      placed = (await api.getPlacedDays(chain.account)).days || [];
    } catch { /* leave empty */ }

    const rows = [];
    for (const p of placed) {
      let day;
      try { day = await chain.vaultDay(p.day); } catch { continue; }
      if (!day.settled) { rows.push({ ...p, state: 'unsettled' }); continue; }
      const [amount, open] = await chain.vaultClaimable(p.day, chain.account);
      rows.push({ ...p, amount, open, state: amount > 0n ? (open ? 'claimable' : 'expired') : 'claimed', expiresAt: day.expiresAt });
    }

    if (!rows.length) {
      card.append(h(`<div class="empty">You have not placed in the top ${d.splitBps ? d.splitBps.length : 5} yet.</div>`));
    }
    const claimableDays = rows.filter((r) => r.state === 'claimable');
    for (const r of rows) {
      const daysLeft = r.expiresAt ? Math.ceil((r.expiresAt - Date.now() / 1000) / 86400) : null;
      const row = h(`<div class="row">
        <div class="rank">${placeLabel(r.place)}</div>
        <div class="who">Day ${r.day}<small>${fmtMs(r.timeMs)} · ${r.shareBps / 100}%</small></div>
        <div class="t">${r.amount ? esc(chain.fmtEth(r.amount)) : '—'}<small>${
          r.state === 'claimable' ? `WETH · ${daysLeft} day${daysLeft === 1 ? '' : 's'} left`
          : r.state === 'claimed' ? 'claimed'
          : r.state === 'expired' ? 'expired' : 'not settled yet'}</small></div>
      </div>`);
      if (r.state === 'claimable') {
        const b = h(`<button class="act">Claim</button>`);
        pressable(b, () => guard(`Claiming ${chain.fmtEth(r.amount)} WETH`, async () => {
          await chain.claimDay(r.day);
          await render();
        }));
        row.append(b);
      } else if (r.state === 'unsettled' && r.closed) {
        const b = h(`<button class="act ghost">Settle day</button>`);
        pressable(b, () => guard(`Settling day ${r.day}`, async () => {
          const att = await api.getDayAttestation(r.day);
          if (!att.ok) { say(att.reason, true); return false; }
          await chain.settleDay(att.attestation);
          await render();
        }));
        row.append(b);
      }
      card.append(row);
    }
    if (claimableDays.length > 1) {
      const all = h(`<div class="grid" style="margin-top:10px"><button class="act">Claim all ${claimableDays.length} days</button></div>`);
      pressable(all.querySelector('button'), () => guard('Claiming everything', async () => {
        await chain.claimDays(claimableDays.map((r) => r.day));
        await render();
      }));
      card.append(all);
    }
    body.append(card);

    body.append(h(`<p class="note">Anyone can settle a finished day — the oracle's signature is what makes the
      standings count, not who sends the transaction. Settling costs you gas and pays you nothing; it just
      unlocks that day's prizes for the people who won them.</p>`));
  }

  // ---------------------------------------------------------------- your run

  async function renderRun() {
    body.innerHTML = '';
    if (!lastVerify) {
      body.append(h(`<div class="empty">No run submitted yet this session.</div>`));
      const b = h(`<div style="text-align:center"><button class="act" id="gorun">Drive one</button></div>`);
      pressable(b.querySelector('#gorun'), () => startRun({ kind: 'free', label: 'Verified run' }));
      body.append(b);
      return;
    }
    const v = lastVerify;
    const drift = v.clientTotalMs != null && v.totalMs != null ? v.clientTotalMs - v.totalMs : null;
    body.append(h(`<div class="card">
      <h4>${v.ok ? 'Verified by the oracle' : 'Rejected — ' + esc(v.status)}</h4>
      <div class="big">${v.totalMs == null ? '—' : fmtMs(v.totalMs)}</div>
      <div class="laps">${(v.lapMs || []).map((m, i) => `<span>L${i + 1} ${fmtMs(m)}</span>`).join('')}</div>
      <p class="note">
        ${v.totalMs == null ? '' : `Measured by re-driving your ${v.ticks} recorded ticks on the server.`}
        ${drift === null ? '' : (drift === 0
          ? ' Your machine and the server agreed exactly.'
          : ` <b>Your machine measured ${esc(fmtMs(v.clientTotalMs))}, ${Math.abs(drift)} ms ${drift > 0 ? 'slower' : 'faster'}.</b> The server's number is the one that counts.`)}
        ${v.digestsCompared ? ` ${v.digestsMismatched ? v.digestsMismatched + ' of ' + v.digestsCompared + ' state checks disagreed.' : v.digestsCompared + ' state checks matched.'}` : ''}
      </p>
      ${v.reasons && v.reasons.length ? `<div class="warn">${v.reasons.map(esc).join('<br>')}</div>` : ''}
    </div>`));

    if (v.ok && attested && chainFeatures()) {
      body.append(h(`<p class="note">This run is signed and ready to spend on a duel or a pot. It expires
        ${Math.round(config.attestationTtl / 60)} minutes after it was verified, and can only be used once.</p>`));
      const g = h(`<div class="grid"><button class="act" id="tod">Post as a duel</button>
        <button class="act ghost" id="top">Use in a pot</button></div>`);
      pressable(g.querySelector('#tod'), () => { tab = 'duels'; render(); });
      pressable(g.querySelector('#top'), () => { tab = 'pots'; render(); });
      body.append(g);
    } else if (!v.ok) {
      const b = h(`<div style="text-align:center;margin-top:12px"><button class="act" id="again">Drive it again</button></div>`);
      pressable(b.querySelector('#again'), () => startRun({ kind: 'free', label: 'Verified run' }));
      body.append(b);
    }
  }

  // ---------------------------------------------------------------- run lifecycle

  function startRun(intent) {
    close();
    onRace(intent);
  }

  /** called by the game when a staked run finishes; submits it and shows the verdict */
  async function submitFinishedRun(trace, intent) {
    tab = 'run';
    lastVerify = null;
    attested = null;
    open();
    body.innerHTML = '<div class="empty">The server is re-driving your run…</div>';
    say('Verifying');
    try {
      // a connected wallet is the real identity; otherwise this browser's own guest id, so a
      // team sharing a board gets one row each instead of all collapsing into one
      const driver = chain && chain.connected ? chain.account : guestId();
      const v = await api.submitRun({ driver, trace, name: guestName() });
      lastVerify = v;
      if (v.ok && v.attestation) attested = { timeMs: v.totalMs, attestation: v.attestation };
      await render();
      if (!v.ok) say('That run cannot be staked.', true);
      else if (!chain || !chain.connected) say('Verified, but no wallet was connected, so it is not bound to an address.');
      else say(`Verified: ${fmtMs(v.totalMs)}.`);

      // carry the player straight back to whatever they were trying to do
      if (v.ok && chain && chain.connected && intent && intent.kind !== 'free') {
        tab = intent.kind === 'duel' ? 'duels' : intent.kind === 'pot' ? 'pots' : 'duels';
        await render();
      }
    } catch (e) {
      body.innerHTML = '';
      body.append(h(`<div class="empty">${esc(reason(e))}</div>`));
      say('Could not reach the oracle.', true);
    }
  }

  // ---------------------------------------------------------------- wiring

  const open = () => { panel.classList.add('on'); render(); refreshChips(); };
  const close = () => panel.classList.remove('on');

  pressable(bar.querySelector('#sb-open'), open);
  pressable(bar.querySelector('#sb-abandon'), () => { if (out.onAbandon) out.onAbandon(); });
  pressable(panel.querySelector('#sk-close'), close);
  panel.querySelectorAll('nav button').forEach((b) => pressable(b, () => { tab = b.dataset.tab; render(); }));
  panel.addEventListener('click', (e) => { if (e.target === panel) close(); });
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && panel.classList.contains('on')) close(); });
  /**
   * Reconnecting.
   *
   * This used to call `window.ethereum.request({ method: 'eth_accounts' })` on load, to pick up a
   * wallet already authorised for this origin. Phantom injects `window.ethereum`, so on a build
   * with no contracts that call found it, connected, and asked the player to switch to an EVM
   * chain that did not exist - which is exactly what a Solana player saw when they opened
   * tensorace.com.
   *
   * There is nothing to replace it with, and that is the point: Privy restores its own session,
   * and says so through wallet.onChange. No probing, no provider sniffing, and nothing at all
   * happens here on a drive-only build.
   */
  if (walletPossible) {
    wallet.onChange(() => {
      refreshChips();
      if (panel.classList.contains('on')) render();
    });

    // the wallet label in the panel header is the connect/disconnect control
    walletLabel.classList.add('go');
    pressable(walletLabel, async () => {
      if (chain.connected) {
        await guard('Disconnecting', () => chain.disconnect());
      } else {
        // the player closing the picker resolves to null. That is a decision, not a failure,
        // so it is reported as nothing at all rather than as an error.
        await guard('Connecting', async () => {
          const addr = await chain.connect();
          if (!addr) { say(''); return false; }
          return true;
        });
      }
      render();
    });
  }
  refreshChips();

  const out = {
    config, chain, open, close,
    submitFinishedRun,
    /** set by index.js: how to give up on the run in progress */
    onAbandon: null,
    /** the ghost delta banner during a run */
    showGap(seconds) {
      if (seconds == null) { gap.classList.remove('on'); return; }
      gap.classList.add('on');
      const ahead = seconds > 0;
      gap.classList.toggle('up', ahead);
      gap.classList.toggle('down', !ahead);
      gap.textContent = `${ahead ? '+' : '−'}${Math.abs(seconds).toFixed(2)} vs ghost`;
    },
    hideGap() { gap.classList.remove('on'); },
    setBarVisible(v) { bar.style.display = v ? 'flex' : 'none'; },
  };
  return out;
}
