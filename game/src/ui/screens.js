/**
 * ui/screens.js - loading, start, pause and results screens for DRIVE in the 404 deck system.
 *
 * Lifted from refs/rust17/ui_screens.js (the shipped Rust 17 screens) and rebuilt for a kart
 * race, to the signatures in docs/ARCHITECTURE.md and the DOM ids in tools/CONTRACT.md:
 *
 *   #load     the loading overlay: shown from construction, `display:none` and
 *             `pointer-events:none` after ready()
 *   #start    the start screen, class 'on' while shown, with #startb (START)
 *   #pause    the pause overlay, class 'on' while shown, with #resumeb (RESUME) and #overb (RESTART)
 *   #over     the results screen, class 'on' while shown, with #overb (RACE AGAIN)
 *
 * There is only ever ONE #overb in the document: the pause panel and the results panel are
 * rendered when shown and emptied when hidden, so document.getElementById('overb') is never a
 * hidden duplicate. #startb, #resumeb and #overb answer a real click and a real tap (touchend,
 * with the synthetic click that follows a tap suppressed).
 *
 * The deck system: dark ground #100c0a, the wide divider word in Pilat Extended Black, a coral
 * rule (#ED5851), pixel labels in fourzerofourpixel, content in Helvetica Now Display XBold.
 * The three licensed faces ship as woff2 subsets in game/fonts/ and are declared here from the
 * module's own location (so the same module works from game/index.html and from a test page),
 * stamped with window.__BUILD_STAMP__ when publish.sh sets it.
 *
 * Plain hyphens only in every string here: Ben reads these screens and reuses the text.
 */

export const CORAL = '#ED5851';
export const INK = '#100c0a';
export const PAPER = '#f2ece2';
export const FONT = `"Helvetica Now Display","Helvetica Neue",Helvetica,Arial,sans-serif`;
export const WIDE = `"Pilat Extended","Arial Black",Impact,sans-serif`;
export const PIX = `fourzerofourpixel,"Courier New",monospace`;

const FONT_FILES = [
  ['Pilat Extended', 'pilat.woff2', 900],
  ['Helvetica Now Display', 'helvnow.woff2', 800],
  ['fourzerofourpixel', 'fourzerofour.woff2', 400],
];

/** URL of a file under game/ relative to this module, with the build stamp when one is set. */
export function gameUrl(rel) {
  const u = new URL('../../' + rel, import.meta.url);
  const stamp = typeof window !== 'undefined' && window.__BUILD_STAMP__;
  return stamp ? `${u.href}?v=${encodeURIComponent(stamp)}` : u.href;
}

/** Declares the three brand faces once. index.html may declare them too; same URL, same cache. */
export function ensureFonts() {
  if (typeof document === 'undefined' || document.getElementById('ui-fonts')) return;
  const s = document.createElement('style');
  s.id = 'ui-fonts';
  s.textContent = FONT_FILES.map(([fam, file, w]) =>
    `@font-face{font-family:'${fam}';src:url('${gameUrl('fonts/' + file)}') format('woff2');font-weight:${w};font-style:normal;font-display:swap}`
  ).join('\n');
  document.head.appendChild(s);
  // warm the faces so the first HUD frame does not swap mid capture
  if (document.fonts && document.fonts.load) {
    for (const [fam, , w] of FONT_FILES) document.fonts.load(`${w} 16px "${fam}"`).catch(() => {});
  }
}

export function h(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
export function esc(s) { return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
export const isTouchDevice = () => typeof window !== 'undefined' && (('ontouchstart' in window) || navigator.maxTouchPoints > 0) && !window.matchMedia('(pointer:fine)').matches;

/** click or tap, once per gesture, with the tap's synthetic click suppressed */
export function pressable(btn, fn) {
  let tapped = -1e9;
  btn.addEventListener('touchend', (e) => { e.preventDefault(); tapped = performance.now(); fn(e); }, { passive: false });
  btn.addEventListener('click', (e) => { if (performance.now() - tapped < 700) return; fn(e); });
}

/** m:ss.mmm, or a hyphen when there is no time */
export function fmtTime(t) {
  if (t == null || !isFinite(t) || t < 0) return '-';
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(3)}`;
}
export function ordinal(p) {
  const n = Math.max(1, Math.round(p || 1));
  const suf = n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th';
  return { n, suf, text: `${n}${suf}` };
}

const CSS = `
#load,#start,#pause,#over{position:fixed;inset:0;z-index:20;font-family:${FONT};color:${PAPER};font-weight:800;
  font-variant-numeric:tabular-nums;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}
/* TENSORACE is nine characters where DRIVE was five - 2.06x the width at the same size - and
   the start screen's column is capped at min(560px, 86vw). 9.2vw keeps it inside that column
   at every width, and 60px is where it stops growing because the column stops growing. */
#load .ttl,#start .ttl,#pause .ttl,#over .ttl{font-family:${WIDE};font-weight:900;font-size:clamp(25px,8.8vw,57px);line-height:.86;letter-spacing:-.045em;color:${PAPER};text-transform:uppercase;white-space:nowrap}
.ttl i{font-style:normal;color:${CORAL}}
.pix{font-family:${PIX};font-weight:400;font-size:11px;letter-spacing:.08em;text-transform:uppercase}
.rule{height:4px;background:${CORAL};width:min(340px,42vw);margin:14px 0 12px}
.track{font-family:${PIX};font-size:clamp(13px,2.2vw,18px);letter-spacing:.14em;text-transform:uppercase;color:${CORAL};margin-top:10px}
#load{background:${INK};display:flex;flex-direction:column;justify-content:flex-end;padding:0 max(24px,6vw) max(28px,env(safe-area-inset-bottom));z-index:30}
#load .sub{font-size:13px;letter-spacing:.02em;opacity:.8;margin-top:6px}
#load .bar{width:min(520px,72vw);height:6px;background:rgba(242,236,226,.12);margin-top:22px}
#load .fill{height:100%;width:0;background:${CORAL};transition:width .15s linear}
#load .lbl{margin-top:10px;min-height:1.4em;opacity:.8}
#load .credit{position:absolute;right:max(24px,6vw);bottom:max(28px,env(safe-area-inset-bottom));text-align:right;opacity:.55;line-height:1.7}
#start{display:none;background:linear-gradient(90deg,rgba(16,12,10,.88) 0%,rgba(16,12,10,.74) 46%,rgba(16,12,10,.18) 100%)}
#start.on{display:block}
#start .col{position:absolute;left:max(24px,6vw);top:max(22px,env(safe-area-inset-top));bottom:max(56px,env(safe-area-inset-bottom));width:min(560px,86vw);display:flex;flex-direction:column;justify-content:flex-end}
#start .mode{font-size:clamp(18px,3vw,26px);letter-spacing:-.01em;margin-top:6px}
#start .meta{font-size:14px;margin:6px 0 2px;font-weight:600;opacity:.85}
#start .meta i{color:${CORAL};font-style:normal;font-weight:800}
#start .keys{display:grid;grid-template-columns:auto 1fr;gap:4px 16px;margin:16px 0 20px;max-width:440px;line-height:1.45;opacity:.85;font-size:13px}
#start .keys span:nth-child(odd){color:${CORAL}}
#startb,#overb,#resumeb{display:block;pointer-events:auto;cursor:pointer;width:min(440px,100%);padding:16px 22px;
  background:${CORAL};color:${INK};border:0;border-radius:0;font-family:${WIDE};font-weight:900;
  font-size:22px;letter-spacing:-.02em;text-transform:uppercase;touch-action:manipulation;text-align:left;
  box-shadow:6px 6px 0 ${INK};margin:0}
#startb:active,#overb:active,#resumeb:active{transform:translate(3px,3px);box-shadow:3px 3px 0 ${INK}}
#startb:hover,#overb:hover,#resumeb:hover{background:#ff6f67}
#pause .btns #overb{background:transparent;color:${PAPER};box-shadow:inset 0 0 0 3px ${PAPER};margin-top:12px}
#pause .btns #overb:hover{background:rgba(242,236,226,.08)}
.foot{position:absolute;left:max(24px,6vw);right:max(24px,6vw);bottom:max(18px,env(safe-area-inset-bottom));display:flex;justify-content:space-between;opacity:.7;gap:12px}
#pause{display:none;background:rgba(16,12,10,.72)}
#pause.on{display:block}
#pause .pan,#over .pan{position:absolute;left:max(24px,6vw);top:50%;transform:translateY(-50%);width:min(560px,86vw);text-align:left;max-height:92vh;overflow:auto}
#pause .big,#over .big{font-family:${WIDE};font-weight:900;font-size:clamp(40px,9vw,96px);letter-spacing:-.04em;line-height:.9;text-transform:uppercase}
#over .big.win{color:${PAPER}}#over .big.lose{color:${CORAL}}
#pause .hint{font-family:${PIX};font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.75;margin:14px 0 20px}
#over{display:none;background:linear-gradient(90deg,rgba(16,12,10,.92) 0%,rgba(16,12,10,.8) 48%,rgba(16,12,10,.25) 100%)}
#over.on{display:block}
#over .place{display:flex;align-items:baseline;gap:14px;margin:14px 0 6px}
#over .place b{font-family:${WIDE};font-weight:900;font-size:clamp(44px,8vw,80px);letter-spacing:-.04em;line-height:1;color:${CORAL}}
#over .place small{font-family:${PIX};font-size:12px;letter-spacing:.1em;text-transform:uppercase;opacity:.85}
#over .place small .num{font-family:${FONT};font-size:15px;letter-spacing:0}
#over .stats{display:flex;gap:26px;margin:8px 0 16px;font-family:${PIX};font-size:10px;text-transform:uppercase;opacity:.85;letter-spacing:.08em}
#over .stats b{display:block;font-family:${FONT};font-size:20px;margin-top:3px;letter-spacing:0}
#over table{width:100%;border-collapse:collapse;font-size:13px;margin:0 0 20px;font-weight:600}
#over th{font-family:${PIX};font-size:10px;letter-spacing:.06em;text-transform:uppercase;opacity:.6;font-weight:400;padding:4px 6px;border-bottom:2px solid ${CORAL}}
#over td{padding:5px 6px;border-bottom:1px solid rgba(242,236,226,.1);white-space:nowrap}
#over td:first-child,#over th:first-child{text-align:left;width:2.2em;font-family:${WIDE};font-weight:900;font-size:14px}
#over td:nth-child(2),#over th:nth-child(2){text-align:left}
#over td:nth-child(n+3),#over th:nth-child(n+3){text-align:right;font-variant-numeric:tabular-nums}
#over tr.me td{background:rgba(237,88,81,.18);color:${PAPER}}
#over tr.me td:first-child{color:${CORAL}}
@media (max-height:520px){#start .keys{display:none}#over .stats{display:none}}
`;

function ensureStyle() {
  ensureFonts();
  if (document.getElementById('ui-style-screens')) return;
  const s = document.createElement('style'); s.id = 'ui-style-screens'; s.textContent = CSS;
  document.head.appendChild(s);
}

const TITLE = `<div class="ttl">Tenso<i>race</i></div>`;   // .ttl uppercases; <i> is the coral half

export class Screens {
  constructor(container, { round = 'r0', laps = 3, racers = 8, lapMetres = 1061 } = {}) {
    ensureStyle();
    this.container = container || document.body;
    this.round = round;
    this.laps = laps;
    this._startFns = []; this._restartFns = []; this._resumeFns = [];
    const stamp = (typeof window !== 'undefined' && window.__BUILD_STAMP__) ? ` ${esc(window.__BUILD_STAMP__)}` : '';
    // reuse an element index.html already carries (same id), else create it
    const get = (id, html) => {
      let e = this.container.querySelector('#' + id) || document.getElementById(id);
      if (!e) { e = h(html); this.container.appendChild(e); } else { e.innerHTML = h(html).innerHTML; e.className = ''; }
      return e;
    };
    this.load = get('load', `<div id="load">${TITLE}<div class="track">Sorrel Cove</div>
      <div class="sub">Sunset coastal circuit. ${racers} racers. ${laps} laps.</div>
      <div class="bar"><div class="fill"></div></div><div class="lbl pix">Loading</div>
      <div class="credit pix">404—GEN<br>Build ${esc(round)}${stamp}<br>github.com/404-Repo/drive</div></div>`);
    const keys = isTouchDevice()
      ? '<span class="pix">Steer</span><span>Left and right pads, bottom left</span><span class="pix">Drift</span><span>Hold DRIFT while steering, release for a boost</span><span class="pix">Item</span><span>ITEM button</span><span class="pix">Brake</span><span>Hold BRAKE. The kart accelerates on its own</span>'
      : '<span class="pix">Accelerate</span><span>Up arrow or W</span><span class="pix">Brake, reverse</span><span>Down arrow or S</span><span class="pix">Steer</span><span>Left and right arrows or A and D</span><span class="pix">Hop, drift</span><span>Space. Hold with steer, release for a boost</span><span class="pix">Item</span><span>Shift or E. Hold brake to fire backwards</span><span class="pix">Pause</span><span>Esc</span>';
    this.start = get('start', `<div id="start"><div class="col">${TITLE}<div class="rule"></div>
      <div class="track">Sorrel Cove</div>
      <div class="mode">One circuit through a sunset coastal town</div>
      <div class="meta"><i>${laps}</i> laps <i>-</i> <i>${racers}</i> racers <i>-</i> <i>${lapMetres}</i> m a lap</div>
      <div class="keys">${keys}</div>
      <button id="startb" type="button">Start</button></div>
      <div class="foot pix"><span>404—GEN</span><span>Build ${esc(round)}${stamp}</span><span>Subnet 17</span></div></div>`);
    this.pauseEl = get('pause', `<div id="pause"><div class="pan"></div><div class="foot pix"><span>404—GEN</span><span>Build ${esc(round)}</span><span>Paused</span></div></div>`);
    this.over = get('over', `<div id="over"><div class="pan"></div><div class="foot pix"><span>404—GEN</span><span>Build ${esc(round)}${stamp}</span><span>Sorrel Cove</span></div></div>`);
    this.pausePan = this.pauseEl.querySelector('.pan');
    this.pan = this.over.querySelector('.pan');
    this.startb = this.start.querySelector('#startb');
    pressable(this.startb, () => this._start());
    this._paused = false;
    // Enter on the start screen starts, on the results screen restarts; Esc on the pause screen resumes
    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (e.code === 'Enter' || e.code === 'NumpadEnter') {
        if (this.start.classList.contains('on')) { e.preventDefault(); this._start(); }
        else if (this.over.classList.contains('on')) { e.preventDefault(); this._restart(e); }
        else if (this.pauseEl.classList.contains('on')) { e.preventDefault(); this._resume(e); }
      }
    });
  }

  /** the touch layer fades while any screen is up (its boxes stay measurable); the HUD only under the results */
  _overlay(on) { document.getElementById('touch')?.classList.toggle('dim', !!on); }

  loading(progress01, label) {
    const f = this.load.querySelector('.fill');
    if (f) f.style.width = (Math.max(0, Math.min(1, progress01 || 0)) * 100).toFixed(1) + '%';
    if (label != null) { const l = this.load.querySelector('.lbl'); if (l) l.textContent = label; }
  }

  ready() {
    this.loading(1, 'Ready');
    this.load.style.pointerEvents = 'none';
    this.load.style.display = 'none';
    this.start.classList.add('on');
    this._overlay(true);
    // the HUD (position, lap, timer, minimap) has nothing to say under the title; _start brings it back
    document.getElementById('hud')?.classList.add('dim');
  }

  onStart(fn) { this._startFns.push(fn); }
  onRestart(fn) { this._restartFns.push(fn); }
  onResume(fn) { this._resumeFns.push(fn); }

  get paused() { return this._paused; }

  _start() {
    if (!this.start.classList.contains('on')) return;
    this.start.classList.remove('on');
    this._overlay(false);
    document.getElementById('hud')?.classList.remove('dim');
    for (const f of this._startFns) { try { f(); } catch (e) { console.error(e); } }
  }

  /** Shows or hides the pause overlay. Ignored while the results screen is up. */
  pause(on) {
    on = !!on;
    if (on && this.over.classList.contains('on')) return;
    if (on === this._paused) return;
    this._paused = on;
    if (on) {
      this.pausePan.innerHTML = `<div class="big">Paused</div>
        <div class="hint">Sorrel Cove - lap in progress</div>
        <div class="btns"><button id="resumeb" type="button">Resume</button><button id="overb" type="button">Restart</button></div>`;
      pressable(this.pausePan.querySelector('#resumeb'), (e) => this._resume(e));
      pressable(this.pausePan.querySelector('#overb'), (e) => this._restart(e));
      this.pauseEl.classList.add('on');
      this._overlay(true);
    } else {
      this.pauseEl.classList.remove('on');
      this.pausePan.innerHTML = '';
      this._overlay(false);
    }
  }

  _resume(e) {
    if (!this._paused) return;
    this.pause(false);
    for (const f of this._resumeFns) { try { f({ event: e }); } catch (err) { console.error(err); } }
  }

  _restart(e) {
    const fromPause = this._paused;
    const fromOver = this.over.classList.contains('on');
    if (!fromPause && !fromOver) return;
    if (fromPause) { this._paused = false; this.pauseEl.classList.remove('on'); this.pausePan.innerHTML = ''; }
    if (fromOver) { this.over.classList.remove('on'); this.pan.innerHTML = ''; }
    document.getElementById('hud')?.classList.remove('dim');
    this._overlay(false);
    for (const f of this._restartFns) { try { f({ kind: fromOver ? 'results' : 'pause', event: e }); } catch (err) { console.error(err); } }
  }

  /**
   * Results: standings 1 to 8 with total time and best lap, the player highlighted, RACE AGAIN.
   * standings: [{ position, name, isPlayer, total, bestLap, finished }], playerPosition 1..8.
   */
  results({ standings = [], playerPosition } = {}) {
    if (this._paused) this.pause(false);
    const rows = [...standings].sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
    const me = rows.find((r) => r.isPlayer);
    const pp = playerPosition ?? me?.position ?? 1;
    const o = ordinal(pp);
    const won = o.n === 1;
    const title = won ? 'Winner' : 'Finish';
    const best = me ? fmtTime(me.bestLap) : '-';
    const total = me ? fmtTime(me.total) : '-';
    const leader = rows[0];
    const gap = !me || !leader ? '-' : me === leader ? '0.000' : (isFinite(me.total) && isFinite(leader.total) ? '+' + (me.total - leader.total).toFixed(3) : '-');
    this.pan.innerHTML = `<div class="big ${won ? 'win' : 'lose'}">${title}</div>
      <div class="place"><b>${o.n}<span style="font-size:.5em">${o.suf}</span></b><small>of <span class="num">${rows.length || 8}</span> - Sorrel Cove - <span class="num">${this.laps}</span> laps</small></div>
      <div class="stats"><div>Total<b>${total}</b></div><div>Best lap<b>${best}</b></div><div>Gap<b>${gap}</b></div></div>
      <table><thead><tr><th>Pos</th><th>Racer</th><th>Total</th><th>Best lap</th></tr></thead><tbody>
      ${rows.map((r) => `<tr class="${r.isPlayer ? 'me' : ''}"><td>${r.position ?? ''}</td><td>${esc(r.name)}${r.isPlayer ? ' <span class="pix" style="opacity:.7">you</span>' : ''}</td><td>${r.finished === false ? 'DNF' : fmtTime(r.total)}</td><td>${fmtTime(r.bestLap)}</td></tr>`).join('')}
      </tbody></table>
      <button id="overb" type="button">Race again</button>`;
    pressable(this.pan.querySelector('#overb'), (e) => this._restart(e));
    this.over.classList.add('on');
    // the HUD fades under the results (the 3D podium is behind the panel); restart brings it back
    document.getElementById('hud')?.classList.add('dim');
    this._overlay(true);
    if (document.pointerLockElement) document.exitPointerLock?.();
  }

  hideAll() {
    this.load.style.display = 'none'; this.load.style.pointerEvents = 'none';
    this.start.classList.remove('on');
    this.pauseEl.classList.remove('on'); this.pausePan.innerHTML = ''; this._paused = false;
    this.over.classList.remove('on'); this.pan.innerHTML = '';
    document.getElementById('hud')?.classList.remove('dim');
    this._overlay(false);
  }

  /** Back to the start screen (after RACE AGAIN the integrator resets and calls this). */
  showStart() { this.hideAll(); this.start.classList.add('on'); this._overlay(true); document.getElementById('hud')?.classList.add('dim'); }
}
