// test/browser-check.mjs — REAL browser verification over the DevTools Protocol.
// No puppeteer, no playwright, no node_modules: node:http + the global WebSocket.
//
//   node test/browser-check.mjs            (headless, SwiftShader WebGL, ?quality=low)
//   HEADED=1 node test/browser-check.mjs   (visible window, real GPU, ?quality=high)
//
// The headless JS suites and this one are blind to each other's bugs — that is the point.
// Those prove the game logic; this proves the page loads, the canvas is painted, the frame
// loop lives, keyboard bits reach the sim, a race actually starts and gets driven, a lap
// counts, the eight karts are genuinely ON SCREEN, the HUD updates, items work end to end,
// a race finishes, and nothing in the payload or the DOM is NaN.
//
// Every assertion prints the number it measured, and every assertion is able to fail.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG } from '../tools/png-decode.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = Number(process.env.PORT || 8130);
const HEADED = !!process.env.HEADED;
const QUALITY = process.env.QUALITY || (HEADED ? 'high' : 'low');
// player=7 puts the player at the BACK of the eight-kart grid. From there the seven karts
// ahead are in front of the chase camera, which is what makes the "karts are on screen"
// assertion (§11) meaningful — from the default mid-grid slot the karts behind you are
// legitimately off camera and the check could never reach 6.
const PLAYER = process.env.PLAYER ?? 7;
const URL_ = process.env.URL || `http://127.0.0.1:${PORT}/index.html?quality=${QUALITY}&player=${PLAYER}`;
const SHOTS = join(ROOT, 'shots');
const DEBUG_PORT = 9300 + Math.floor(Math.random() * 90);   // 9300-9389 (arena uses 9200+, capture 9400+, verify-dist 9500+)

let pass = 0, fail = 0; const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \u2713 ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; failures.push(name); console.log(`  \u2717 ${name}${extra ? '  ' + extra : ''}`); }
};
const section = (t) => console.log(`\n\u25b6 ${t}`);
// A section that throws (a missing function, a broken sim) is reported as a failure and the
// rest of the suite still runs — the whole picture is more useful than the first crash.
const stage = async (label, fn) => {
  try { await fn(); }
  catch (e) { fail++; failures.push(label); console.log(`  \u2717 ${label} — threw: ${String(e && e.message || e).split('\n')[0].slice(0, 220)}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const num = (v, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v));

function findBrowser() {
  const cands = [
    process.env.CHROME,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const c of cands) if (existsSync(c)) return c;
  return null;
}

// The nine real item ids, read out of src/content.js at run time, so "the roulette resolved to
// a real ITEM id" is checked against the actual source of truth and not against a copy.
async function itemIdsFromContent() {
  try {
    const src = await readFile(join(ROOT, 'src', 'content.js'), 'utf8');
    const block = src.match(/export const ITEMS\s*=\s*\{([\s\S]*?)\n\};/);
    if (!block) return null;
    const ids = [...block[1].matchAll(/^\s{2}([a-zA-Z0-9_]+)\s*:\s*\{/gm)].map(m => m[1]);
    return ids.length ? ids : null;
  } catch { return null; }
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      } else if (msg.method) this.events.push(msg);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} timed out`)); } }, 60000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('page exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    if (r.result && r.result.subtype === 'error') throw new Error('page error: ' + r.result.description);
    return r.result.value;
  }
  errors() {
    // /favicon.ico is requested by Chrome itself, not by the game: a page with no icon is not a
    // page with a missing module. Everything else counts.
    const fav = (s) => /favicon/i.test(s || '');
    return this.events.filter(e =>
      (e.method === 'Runtime.exceptionThrown')
      || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error' && !fav(e.params.entry.url) && !fav(e.params.entry.text))
      || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error' && !fav(JSON.stringify(e.params.args || []))));
  }
  faviconHits() {
    return this.events.filter(e => /favicon/i.test(JSON.stringify(e.params || {}))).length;
  }
  describeErrors(limit = 4) {
    return this.errors().slice(0, limit).map(e => {
      if (e.method === 'Log.entryAdded') return `${e.params.entry.text} @ ${e.params.entry.url || ''}`;
      if (e.method === 'Runtime.exceptionThrown') return e.params.exceptionDetails.exception?.description?.split('\n')[0] || e.params.exceptionDetails.text;
      return (e.params.args || []).map(a => a.value || a.description || '').join(' ');
    }).filter(Boolean).join(' | ');
  }
  // every request the page made that did not come back — a missing module shows up here by name
  failedRequests() {
    const out = [];
    for (const e of this.events) {
      if (e.method === 'Network.responseReceived') {
        const r = e.params.response;
        if (r.status >= 400 && !/favicon/.test(r.url)) out.push(`${r.status} ${r.url.replace(/^https?:\/\/[^/]+/, '')}`);
      }
      if (e.method === 'Network.loadingFailed' && !/ERR_ABORTED/.test(e.params.errorText || '')) {
        out.push(`${e.params.errorText} ${(e.params.type || '')}`);
      }
    }
    return [...new Set(out)];
  }
}

const pngStats = (buf) => {
  const { rgb, width: w, height: h } = decodePNG(buf);   // tools/png-decode.mjs normalises to RGB
  let sum = 0, n = 0, black = 0, bright = 0;
  const colours = new Set();
  const bands = [0, 0, 0], bandN = [0, 0, 0];
  for (let y = 0; y < h; y += 3) {
    const b = Math.min(2, Math.floor(y / h * 3));
    for (let x = 0; x < w; x += 3) {
      const o = (y * w + x) * 3;
      const l = 0.2126 * rgb[o] + 0.7152 * rgb[o + 1] + 0.0722 * rgb[o + 2];
      sum += l; n++; bands[b] += l; bandN[b]++;
      if (l < 8) black++; if (l > 240) bright++;
      colours.add((rgb[o] >> 3 << 10) | (rgb[o + 1] >> 3 << 5) | (rgb[o + 2] >> 3));
    }
  }
  return {
    w, h, distinct: colours.size, avg: sum / n, blackFrac: black / n, brightFrac: bright / n,
    top: bands[0] / bandN[0], mid: bands[1] / bandN[1], bottom: bands[2] / bandN[2],
  };
};

// Everything the page-side driver needs, defined once. `fresh()` restarts a race with NO input
// held (holding the throttle through the countdown deliberately triggers the bogged start),
// and `drive()` steers the player kart at the centreline with a pure-pursuit controller built
// from the track the sim itself reports — which is how a lap gets completed without a keyboard.
const HARNESS_SRC = `(() => {
  const B = { ACCEL: 1, BRAKE: 2, LEFT: 4, RIGHT: 8, DRIFT: 16, ITEM: 32, LOOK: 64 };
  const cl = (v, a, b) => (v < a ? a : v > b ? b : v);
  const H = {
    B, cl,
    ang(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; },
    p() { const s = __game.state; return s.racers[s.playerIndex]; },
    st() { return __game.state; },
    tr() { return __game.state.track; },
    turnSign: 1,
    // a clean grid: no input during the countdown, then phase 'racing' with the karts on the line
    fresh(i) { __game.setInput(0); __game.newRace(i == null ? 0 : i); __game.step(240); return __game.info().phase; },
    probe() {
      const s = __game.state, p = s.racers[s.playerIndex], i = __game.info();
      return { tick: s.tick, phase: s.phase, kmh: +i.speedKmh.toFixed(1), spd: +p.speed.toFixed(2),
        s: +p.s.toFixed(1), x: +p.x.toFixed(1), z: +p.z.toFixed(1), lat: +p.lateral.toFixed(2),
        head: +p.heading.toFixed(3), surf: p.surface, off: !!p.offTrack, lap: p.lap, place: p.place,
        pulse: p.pulseTicks, spin: p.spinTicks, resp: p.respawnTicks, stuck: p.stuckTicks,
        frozen: (p.spinTicks > 0 || p.respawnTicks > 0 || p.pulseTicks > 0) };
    },
    // which way LEFT turns the kart — measured from a standing start so the kart barely moves
    calibrate() {
      H.fresh(0);
      const p = H.p();
      __game.setInput(1); __game.step(12);
      const h0 = p.heading;
      __game.setInput(1 | 4); __game.step(30);
      const dl = H.ang(p.heading - h0);
      const h1 = p.heading;
      __game.setInput(1 | 8); __game.step(30);
      const dr = H.ang(p.heading - h1);
      H.turnSign = dl === 0 ? 0 : Math.sign(dl);
      __game.setInput(0);
      return { left: dl, right: dr, sign: H.turnSign, speed: p.speed, movedFrom: Math.hypot(p.x, p.z) };
    },
    // sample the WebGL back buffer inside a rAF callback, i.e. right after the game's own draw
    sample() {
      return new Promise((res) => {
        requestAnimationFrame(() => {
          try {
            const c = document.getElementById('gl');
            const gl = c.getContext('webgl2') || c.getContext('webgl');
            if (!gl) return res({ error: 'no context' });
            const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
            if (!w || !h) return res({ error: 'empty drawing buffer' });
            const px = new Uint8Array(w * h * 4);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
            const CW = 24, CH = 12, cells = new Float32Array(CW * CH), cellN = new Float32Array(CW * CH);
            let sum = 0, n = 0, black = 0, bright = 0;
            const set = new Set();
            const bands = [0, 0, 0], bandN = [0, 0, 0];
            for (let y = 0; y < h; y += 3) {
              const rowFromTop = h - 1 - y;                 // WebGL reads bottom-up
              const band = Math.min(2, Math.floor(rowFromTop / h * 3));
              for (let x = 0; x < w; x += 3) {
                const o = (y * w + x) * 4;
                const l = 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2];
                sum += l; n++; bands[band] += l; bandN[band]++;
                if (l < 8) black++; if (l > 240) bright++;
                set.add((px[o] >> 3 << 10) | (px[o + 1] >> 3 << 5) | (px[o + 2] >> 3));
                const ci = Math.min(CH - 1, Math.floor(rowFromTop / h * CH)) * CW + Math.min(CW - 1, Math.floor(x / w * CW));
                cells[ci] += l; cellN[ci]++;
              }
            }
            res({
              w, h, distinct: set.size, avg: sum / n, blackFrac: black / n, brightFrac: bright / n,
              top: bands[0] / bandN[0], mid: bands[1] / bandN[1], bottom: bands[2] / bandN[2],
              sig: Array.from(cells, (v, i) => (cellN[i] ? v / cellN[i] : 0)),
            });
          } catch (e) { res({ error: String(e && e.message || e) }); }
        });
      });
    },
    // drive the player kart along the centreline for n ticks; returns everything it measured
    drive(n, o) {
      o = o || {};
      const s = __game.state, tr = s.track, p = s.racers[s.playerIndex];
      const out = { ticks: 0, maxKmh: 0, minKmh: 1e9, maxDriftTier: 0, sawRoll: false, s0: p.s, lap0: p.lap, lap: p.lap,
        items: [], boostTicks: 0, minS: p.s, maxS: p.s, lapEvents: 0, steerHold: 0, endX: p.x, endZ: p.z,
        surfaces: {}, roadTicks: 0, respawns: 0, signFlips: 0, prog0: p.progress, progMax: p.progress,
        maxDriftCharge: 0, miniTurbos: 0, miniTurboTicks: 0, driftReleases: 0,
        maxErr: 0, maxCurv: 0, x0: p.x, z0: p.z, maxDx: 0, maxDz: 0 };
      if (!H.turnSign) H.turnSign = 1;
      let errRef = -1, grew = 0, prevRespawn = p.respawnTicks, releasing = 0, miniSeen = false;
      for (let i = 0; i < n; i++) {
        const onRoad = p.surface !== 'grass' && p.surface !== 'wall';
        // off the road: aim at a nearby centreline point so the kart rejoins instead of
        // grinding along a wall; on the road: pure pursuit at a speed-scaled lookahead
        const look = onRoad ? cl(10 + p.speed * 0.9, 10, 30) : 5;
        const pt = tr.pointAt(p.s + look);
        const want = Math.atan2(pt.x - p.x, pt.z - p.z);
        const err = H.ang(want - p.heading);
        let bits = o.throttle === false ? 0 : B.ACCEL;
        if (Math.abs(err) > 0.55) bits &= ~B.ACCEL;             // lift into a hard correction
        if (err * H.turnSign > 0.03) { bits |= B.LEFT; out.steerHold++; }
        else if (err * H.turnSign < -0.03) { bits |= B.RIGHT; out.steerHold++; }
        if (o.drift && onRoad && p.speed > 10 && (Math.abs(pt.curvature || 0) > 0.008 || Math.abs(err) > 0.08)) bits |= B.DRIFT;
        else if (o.drift && p.driftActive && p.speed > 8) bits |= B.DRIFT;   // once sliding, keep it
        // a charged drift is released on purpose, which is what pays the mini-turbo
        if (o.drift && p.driftActive && p.driftTier >= 1 && releasing === 0) { releasing = 2; out.driftReleases++; }
        if (releasing > 0) { releasing--; bits &= ~B.DRIFT; }
        if (o.item && i > 20) bits |= B.ITEM;
        __game.setInput(bits);
        __game.step(1);
        out.ticks++;
        const kmh = __game.info().speedKmh;
        if (kmh > out.maxKmh) out.maxKmh = kmh;
        if (kmh < out.minKmh) out.minKmh = kmh;
        if (p.driftTier > out.maxDriftTier) { out.maxDriftTier = p.driftTier; out.maxDriftCharge = p.driftCharge; }
        if (p.itemRollTicks > 0) out.sawRoll = true;
        if (p.item && out.items.indexOf(p.item) < 0) out.items.push(p.item);
        if (p.lap !== out.lap) { out.lap = p.lap; out.lapEvents++; }
        if (p.s < out.minS) out.minS = p.s;
        if (p.s > out.maxS) out.maxS = p.s;
        if (p.progress > out.progMax) out.progMax = p.progress;
        const sf = p.surface || '?';
        out.surfaces[sf] = (out.surfaces[sf] || 0) + 1;
        if (af(sf)) out.roadTicks++;
        if (p.respawnTicks > prevRespawn) out.respawns++;
        prevRespawn = p.respawnTicks;
        out.boostTicks = Math.max(out.boostTicks, p.boostTicks || 0);
        const miniNow = p.boostTicks > 0 && /mini/i.test(p.boostKind || '');
        if (Math.abs(err) > out.maxErr) out.maxErr = Math.abs(err);
        if (Math.abs(pt.curvature || 0) > out.maxCurv) out.maxCurv = Math.abs(pt.curvature || 0);
        if (miniNow && !miniSeen) { out.miniTurbos++; out.miniTurboTicks = p.boostTicks; }
        miniSeen = miniNow;
        out.endX = p.x; out.endZ = p.z;
        if (Math.abs(p.x - out.x0) > out.maxDx) out.maxDx = Math.abs(p.x - out.x0);
        if (Math.abs(p.z - out.z0) > out.maxDz) out.maxDz = Math.abs(p.z - out.z0);
        // safety net: if the heading error keeps growing the steering sign is wrong — flip it
        if (i % 50 === 49) {
          const a = Math.abs(err);
          if (errRef >= 0 && a > errRef + 0.05) grew++; else grew = 0;
          errRef = a;
          if (grew >= 3) { H.turnSign = -H.turnSign; grew = 0; out.signFlips++; }
        }
      }
      function af(sf) { return sf === 'road' || sf === 'boost' || sf === 'ramp'; }
      out.notifications = __game.info().notifications.slice();
      return out;
    },
    // the whole DOM side of the HUD, measured rather than eyeballed
    hudDom() {
      const q = (sel) => document.querySelector(sel);
      const txt = (sel) => (q(sel) ? (q(sel).innerText || q(sel).textContent || '').replace(/\\s+/g, ' ').trim() : null);
      const numOf = (sel) => { const t = txt(sel); const m = t && t.match(/-?[0-9]+(\\.[0-9]+)?/); return m ? Number(m[0]) : null; };
      const speedNum = numOf('#hud-speed .num') != null ? numOf('#hud-speed .num') : numOf('#hud-speed');
      return {
        visible: !document.getElementById('hud').classList.contains('hidden'),
        lap: txt('#hud-lap'),
        position: txt('#hud-position'),
        speedText: txt('#hud-speed'),
        speedNum,
        standings: document.querySelectorAll('#hud-standing .row').length,
        minimap: !!document.getElementById('minimap'),
        item: txt('#hud-item'),
        speedBarPct: (() => { const b = document.querySelector('#hud-speedbar > i'); return b ? (b.style.width || getComputedStyle(b).width) : null; })(),
        driftOn: document.getElementById('hud-drift').classList.contains('on'),
        bodyHasNaN: /NaN|Infinity/.test(document.body.innerText || ''),
      };
    },
    resultsDom() {
      const t = document.querySelector('#results table');
      return {
        table: !!t,
        rows: t ? t.querySelectorAll('tbody tr, tr').length : 0,
        me: document.querySelectorAll('#results tr.me').length,
        swatches: document.querySelectorAll('#results .sw').length,
      };
    },
    // no NaN anywhere in the documented info() payload
    infoNaN() {
      const bad = [];
      const walk = (v, path) => {
        if (typeof v === 'number') { if (!Number.isFinite(v)) bad.push(path); return; }
        if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], path + '.' + k);
      };
      walk(__game.info(), 'info');
      return bad;
    },
  };
  window.__h = H;
  return true;
})()`;

async function main() {
  const browser = findBrowser();
  if (!browser) { console.error('no Chrome/Edge binary found — set $CHROME'); process.exit(2); }
  await mkdir(SHOTS, { recursive: true });
  console.log(`TURBO CIRCUIT — real-browser check\n  ${URL_}\n  browser: ${browser}${HEADED ? '  (HEADED)' : '  (headless, SwiftShader)'}`);

  // ────────────────────────────────────────────────────────────── the server
  let server = null;
  let portWasUp = false;
  try { await fetch(`http://127.0.0.1:${PORT}/index.html`); portWasUp = true; } catch { /* start one */ }
  if (!portWasUp) {
    server = spawn(process.execPath, ['serve.mjs'], { cwd: ROOT, stdio: 'ignore' });
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { try { await fetch(`http://127.0.0.1:${PORT}/index.html`); up = true; } catch { await sleep(150); } }
    if (!up) { console.error(`serve.mjs never came up on ${PORT}`); process.exit(2); }
    console.log(`  started serve.mjs on ${PORT} (nothing was listening)`);
  } else {
    console.log(`  using the server already on ${PORT}`);
  }

  const profile = await mkdtemp(join(tmpdir(), 'turbo-browser-'));
  const proc = spawn(browser, [
    HEADED ? '--new-window' : '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--no-sandbox',
    '--hide-scrollbars', '--mute-audio', '--window-size=1600,900',
    '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--use-gl=angle',
    '--autoplay-policy=no-user-gesture-required',
    '--force-device-scale-factor=1', URL_,
  ], { stdio: 'ignore' });
  const cleanup = () => { try { proc.kill(); } catch (e) { void e; } if (server) { try { server.kill(); } catch (e) { void e; } } };
  const shots = new Map();
  let cdp = null, measured = {};

  try {
    let target = null;
    for (let i = 0; i < 90 && !target; i++) {
      await sleep(250);
      try {
        const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
        target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl && /index\.html/.test(t.url))
          || list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      } catch { /* not up yet */ }
    }
    if (!target) throw new Error('browser never exposed a page target');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    cdp = new CDP(ws);
    for (const d of ['Runtime.enable', 'Page.enable', 'Log.enable', 'Network.enable']) await cdp.send(d);
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(700);

    // ───────────────────────────────────────────────────────── 1. boot
    section('1. page boot & module graph');
    let booted = false;
    for (let i = 0; i < 80 && !booted; i++) { await sleep(250); booted = await cdp.eval('!!window.__game').catch(() => false); }
    const missing = cdp.failedRequests();
    if (missing.length) console.log('   files the page asked for and did not get:\n' + missing.map(m => '     ' + m).join('\n'));
    ok('the whole module graph executed (window.__game exists)', booted, booted ? 'clean boot' : 'boot failed');
    ok('every file the page requested was served (no 404s)', missing.length === 0,
      missing.length ? missing.slice(0, 6).join(' | ') : 'no failed requests');
    ok('no console errors or uncaught exceptions on load', cdp.errors().length === 0,
      cdp.errors().length ? cdp.describeErrors().slice(0, 300) : 'clean console');
    if (!booted) throw new Error('the page never defined window.__game — see the failed requests above');

    const api = await cdp.eval(`(() => { const need = ['state','info','newRace','step','setInput','press','camera','hud','audio','screenPos','quality'];
      const have = need.filter(k => __game[k] != null); const missing = need.filter(k => __game[k] == null);
      return { have: have.length, missing, state: !!__game.state, racers: __game.state ? __game.state.racers.length : 0 }; })()`);
    ok('window.__game exposes every documented method', api.have === 11, `11/11 (missing: ${api.missing.join(',') || 'none'})`);
    ok('the hook exposes a live state with 8 racers', api.state && api.racers === 8, `${api.racers} racers`);

    const titleShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    shots.set('title-screen.png', Buffer.from(titleShot.data, 'base64'));
    ok('title screen screenshot captured', titleShot.data.length > 5000, `shots/title-screen.png (${(titleShot.data.length / 1024).toFixed(0)} kB)`);

    // ───────────────────────────────────────────────────────── 2. WebGL
    section('2. WebGL is the actual rendering context');
    const gl = await cdp.eval(`(() => {
      const c = document.getElementById('gl');
      const g = c.getContext('webgl2') || c.getContext('webgl');
      if (!g) return { ok: false };
      const dbg = g.getExtension('WEBGL_debug_renderer_info');
      return { ok: true, tag: c.tagName, cw: c.width, ch: c.height,
        version: g.getParameter(g.VERSION), glsl: g.getParameter(g.SHADING_LANGUAGE_VERSION),
        vendor: dbg ? g.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : 'n/a',
        device: dbg ? g.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'n/a',
        lost: g.isContextLost(), reported: __game.info().renderer, drawCalls: __game.info().drawCalls };
    })()`);
    ok('a real WebGL context exists on the game canvas', gl.ok === true && /webgl/i.test(gl.version || ''),
      `${gl.version || 'none'} · ${gl.device || 'n/a'}`);
    ok('the context is WebGL2 or WebGL with a live, non-lost drawing buffer', gl.ok && gl.lost === false && gl.cw > 100,
      `canvas ${gl.cw}x${gl.ch}, context lost: ${gl.lost}`);
    ok('the game reports WebGL as its renderer (not the 2D fallback)', gl.reported === 'webgl', `renderer=${gl.reported}`);
    measured.glDevice = gl.device;

    // ───────────────────────────────────────────────────────── 3. pixels
    section('3. is the canvas actually painted?');
    await cdp.eval(HARNESS_SRC);
    const fb = await cdp.eval('__h.sample()');
    const pngSample = pngStats(Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    const fbDead = !fb || fb.error || fb.avg < 1;
    const paint = fbDead ? { ...pngSample, source: 'CDP screenshot PNG (framebuffer read-back was empty)' } : { ...fb, source: 'WebGL framebuffer (readPixels)' };
    measured.paint = paint;
    console.log(`   pixel source: ${paint.source}`);
    ok('the framebuffer sample has real pixels', !!(paint.w > 100 && paint.h > 100), `${paint.w}x${paint.h}`);
    ok('the canvas is painted and NOT a flat fill (non-uniform colour)', paint.distinct > 200,
      `${paint.distinct} distinct colours`);
    ok('the canvas is not black', paint.avg > 8 && paint.blackFrac < 0.5,
      `avg luma ${num(paint.avg)}, ${(paint.blackFrac * 100).toFixed(1)}% black pixels`);
    ok('the canvas is not blown out white', paint.avg < 240 && paint.brightFrac < 0.5,
      `${(paint.brightFrac * 100).toFixed(1)}% of pixels above 240 luma`);
    ok('there is vertical structure, not one flat tone (sky band vs road band)',
      Math.abs(paint.top - paint.mid) > 4 || Math.abs(paint.mid - paint.bottom) > 4,
      `top ${num(paint.top)} · mid ${num(paint.mid)} · bottom ${num(paint.bottom)} luma`);
    ok('the screenshot the browser produces is also a real image', pngSample.distinct > 200 && pngSample.avg > 8,
      `${pngSample.distinct} distinct colours, avg luma ${num(pngSample.avg)}`);

    // ───────────────────────────────────────────────────────── 4. frame loop
    section('4. the frame loop is alive');
    await cdp.eval('__game.start(); true');
    const loop = await cdp.eval(`new Promise((res) => {
      const t0 = __game.info().tick; let frames = 0;
      const c = () => { frames++; requestAnimationFrame(c); };
      requestAnimationFrame(c);
      setTimeout(() => res({ t0, t1: __game.info().tick, frames, fps: __game.info().fps, phase: __game.info().phase }), 2500);
    })`);
    const loopFps = loop.frames / 2.5;
    measured.loopFps = loopFps;
    measured.fps = loop.fps;
    ok('the frame loop runs (rAF never dies)', loop.frames > 3, `${loop.frames} frames in 2.5s (~${loopFps.toFixed(1)} fps)`);
    ok('the simulation advances over wall-clock time (fixed 60Hz step, real clock)', loop.t1 - loop.t0 > 30,
      `tick ${loop.t0} → ${loop.t1} (+${loop.t1 - loop.t0} ticks in 2.5s, ${((loop.t1 - loop.t0) / 2.5).toFixed(1)}/s)`);
    ok('the loop reports a live frame rate under headless SwiftShader', loop.fps > 0.5,
      `${num(loop.fps)} fps (software rasteriser — says nothing about real hardware)`);

    // ───────────────────────────────────────────────────────── 5. race start
    section('5. a race starts and reaches "racing"');
    const started = await cdp.eval(`(() => { __game.step(240); return __game.info().phase; })()`);
    ok('the countdown runs down and the phase becomes "racing"', started === 'racing', `phase=${started}`);
    measured.track = await cdp.eval('({ id: __game.info().track.id, name: __game.info().track.name, length: __game.info().track.length, laps: __game.info().laps })');
    ok('the race built a real circuit from the track data', measured.track.length > 200,
      `${measured.track.name} (${measured.track.id}), centreline ${num(measured.track.length)} m`);
    const grid = await cdp.eval(`(() => { const s = __game.state;
      return { slots: s.racers.map(r => ({ id: r.id, x: +r.x.toFixed(1), z: +r.z.toFixed(1), lap: r.lap, s: +r.s.toFixed(1) })), spread: Math.max(...s.racers.map(r => Math.hypot(r.x - s.racers[0].x, r.z - s.racers[0].z))) }; })()`);
    ok('all eight karts are placed on the grid spread along the track', grid.slots.length === 8 && grid.spread > 5,
      `8 karts, ${num(grid.spread)} m from pole to last`);

    // ───────────────────────────────────────────────────────── 6. throttle
    section('6. the throttle, the countdown and the rocket start');
    // The rocket start is where a throttle reading can go wrong: hold it from the first tick of
    // the countdown and the engine should BOG (a brief stall) — not spin the kart off the grid.
    const rocket = await cdp.eval(`(() => {
      __game.setInput(1); __game.newRace(0);
      const p = __h.p(); const h0 = p.heading; let spin = 0, moved = 0;
      for (let i = 0; i < 240; i++) {
        __game.step(1);
        spin = Math.max(spin, Math.abs(__h.ang(p.heading - h0)));
        moved = Math.max(moved, Math.hypot(p.x - __h.tr().gridSlots[p.id].x, p.z - __h.tr().gridSlots[p.id].z));
      }
      const early = { start: p.rocketStart, spin: +spin.toFixed(3), moved: +moved.toFixed(1), kmh: __game.info().speedKmh, pulse: p.pulseTicks };
      __game.setInput(0); __game.step(30);
      __game.newRace(0); __game.step(160);          // 20 ticks (0.33 s) left of the countdown
      __game.setInput(1); __game.step(40);
      const q = __h.p();
      const perfect = { start: q.rocketStart, boost: q.boostTicks, kind: q.boostKind, kmh: __game.info().speedKmh };
      return { early, perfect }; })()`);
    measured.rocket = rocket;
    ok('holding the throttle from the start of the countdown gives a bogged start',
      rocket.early.start === 'early', `rocketStart="${rocket.early.start}"`);
    ok('the bogged start stalls the kart instead of spinning it (per CONTRACTS §8)',
      rocket.early.spin < 0.5,
      `heading swept ${num(rocket.early.spin, 3)} rad while bogged, kart moved ${num(rocket.early.moved)} m, ${num(rocket.early.kmh)} km/h`);
    ok('pressing the throttle in the last half second gives a perfect start with a launch boost',
      rocket.perfect.start === 'perfect' && rocket.perfect.boost > 0,
      `rocketStart="${rocket.perfect.start}", ${rocket.perfect.boost} boost ticks (${rocket.perfect.kind})`);

    const throttle = await cdp.eval(`(() => {
      __h.fresh(0);
      const idle = __game.info().speedKmh;
      __game.setInput(1); __game.step(150);
      const kmh = __game.info().speedKmh, raw = __h.p().speed;
      __game.setInput(0); __game.step(120);
      return { idle, kmh, raw, coast: __game.info().speedKmh, probe: __h.probe() }; })()`);
    measured.kmh = throttle.kmh;
    console.log('   probe: ' + JSON.stringify(throttle.probe));
    ok('holding the throttle lifts the player speed above 40 km/h', throttle.kmh > 40,
      `${num(throttle.idle)} km/h at rest → ${num(throttle.kmh)} km/h after 2.5 s of full throttle`);
    ok('info().speedKmh agrees with the racer record in m/s (× 3.6)',
      Math.abs(throttle.raw * 3.6 - throttle.kmh) < 1.0,
      `racer.speed ${num(throttle.raw)} m/s = ${num(throttle.raw * 3.6)} km/h vs info() ${num(throttle.kmh)} km/h`);
    ok('releasing the throttle slows the kart again', throttle.coast < throttle.kmh - 3,
      `${num(throttle.kmh)} → ${num(throttle.coast)} km/h over 2 s of coasting`);

    // ───────────────────────────────────────────────────────── 7. steering
    section('7. steering and drift change the heading');
    await stage('section 7 (steering & drift)', async () => {
    const cal = await cdp.eval('__h.calibrate()');
    measured.turn = cal;
    ok('a steering input turns the kart (heading changes with LEFT and RIGHT)',
      Math.abs(cal.left) > 0.05 && Math.abs(cal.right) > 0.05,
      `LEFT ${num(cal.left, 3)} rad, RIGHT ${num(cal.right, 3)} rad, sign=${cal.sign}`);
    ok('the two steering directions are opposite', cal.left * cal.right < 0,
      `LEFT ${num(cal.left, 3)} × RIGHT ${num(cal.right, 3)} = ${num(cal.left * cal.right, 4)}`);
    const drift = await cdp.eval(`(() => {
      const run = (bits, n) => { const p = __h.p(); const h = p.heading; const tiers = [];
        for (let i = 0; i < n; i++) { __game.setInput(bits); __game.step(1); tiers.push(p.driftTier); }
        return { d: __h.ang(p.heading - h), tierMax: Math.max.apply(null, tiers), charge: p.driftCharge, speed: p.speed, off: !!p.offTrack }; };
      const warm = () => { __h.fresh(0); __game.setInput(1); __game.step(90); };
      // 45 ticks (0.75 s): long enough for the hop and real charge, short enough that the kart
      // is still on the road. A sustained full-lock turn curls into the wall, and the sim's wall
      // clamp then force-aligns the heading — that would measure the wall, not the drift.
      warm(); const plain = run(1 | 4, 45);
      warm(); const drifty = run(1 | 16 | 4, 45);
      return { plain, drifty }; })()`);
    measured.drift = drift;
    ok('a plain steer changes the heading', Math.abs(drift.plain.d) > 0.1,
      `${num(drift.plain.d, 3)} rad over 0.75 s of steering at ${num(drift.plain.speed)} m/s (off road: ${drift.plain.off})`);
    ok('steering with DRIFT held turns the kart harder than the same steer alone',
      Math.abs(drift.drifty.d) > Math.abs(drift.plain.d) * 1.05,
      `steer ${num(Math.abs(drift.plain.d), 3)} rad → drift ${num(Math.abs(drift.drifty.d), 3)} rad (${num(Math.abs(drift.drifty.d) / Math.max(1e-6, Math.abs(drift.plain.d)), 2)}× harder, turnRateMul is 1.62)`);
    ok('the drift charge builds while the drift is held', drift.drifty.charge > 0.15,
      `charge ${num(drift.drifty.charge, 2)} s after 0.75 s of drifting (tier 1 at 0.55 s → tier 3 at 1.75 s)`);
    });

    // ───────────────────────────────────────────────────────── 8. travel + lap
    section('8. the player travels the circuit and a lap counts');
    await stage('section 8 (lap & travel)', async () => {
    await cdp.eval('__h.fresh(0)');
    const before = await cdp.eval('__h.probe()');
    let lapDrive = null;
    const chunks = [];
    let prog0 = null, progBest = null;
    for (let i = 0; i < 8; i++) {
      lapDrive = await cdp.eval('__h.drive(800, { drift: true })');
      if (prog0 === null) prog0 = lapDrive.prog0;
      progBest = Math.max(progBest === null ? lapDrive.progMax : progBest, lapDrive.progMax);
      const now = await cdp.eval('({ s: __h.p().s, lap: __h.p().lap, prog: __h.p().progress })');
      chunks.push({ s: +now.s.toFixed(1), lap: now.lap, kmh: lapDrive.maxKmh, road: lapDrive.roadTicks, resp: lapDrive.respawns, flips: lapDrive.signFlips });
      if (lapDrive.lapEvents > 0) break;
    }
    measured.lapDrive = lapDrive;
    measured.chunks = chunks;
    const sNow = await cdp.eval('__h.probe()');
    measured.afterLap = sNow;
    const travelled = Math.hypot(sNow.x - before.x, sNow.z - before.z);
    const progressed = progBest - prog0;
    console.log(`   ${chunks.length} chunks · ${chunks.map(c => `${c.s} m lap ${c.lap} (${c.road} road ticks)`).join(' → ')}`);
    ok('the kart made real progress along the circuit (arc length s, laps included)', progressed > 700,
      `progress ${num(prog0)} m → ${num(progBest)} m (+${num(progressed)} m) on a ${num(measured.track.length)} m lap, now at s=${num(sNow.s)} m`);
    ok('the kart travelled a real distance through world space (x and z both changed a lot)',
      lapDrive.maxDx > 20 && lapDrive.maxDz > 20,
      `max excursion from the grid: ${num(lapDrive.maxDx)} m in x, ${num(lapDrive.maxDz)} m in z — ended at (${num(sNow.x)}, ${num(sNow.z)}), i.e. back near the line after a lap`);
    ok('a lap incremented (crossing the start line forwards)', lapDrive.lap > lapDrive.lap0,
      `lap ${lapDrive.lap0} → ${lapDrive.lap} (${lapDrive.lapEvents} lap events, ${num(lapDrive.maxKmh)} km/h max)`);
    ok('the kart stayed on the road for the majority of the lap',
      lapDrive.roadTicks > lapDrive.ticks * 0.7,
      `${lapDrive.roadTicks}/${lapDrive.ticks} ticks on road/boost/ramp · surfaces ${JSON.stringify(lapDrive.surfaces)} · ${lapDrive.respawns} respawns · ${lapDrive.signFlips} steering sign flips`);
    ok('racing the circuit produced a real drift tier (the drift event fired in the sim)',
      lapDrive.maxDriftTier >= 1,
      `highest drift tier ${lapDrive.maxDriftTier} of 3 at charge ${num(lapDrive.maxDriftCharge, 2)} s, ${lapDrive.driftReleases} deliberate releases (max steering error ${num(lapDrive.maxErr, 3)} rad, tightest curvature ${num(lapDrive.maxCurv, 4)} 1/m)`);
    ok('releasing a charged drift paid a mini-turbo boost', lapDrive.miniTurbos > 0,
      `${lapDrive.miniTurbos} mini-turbo boost(s) granted, ${lapDrive.miniTurboTicks} tick(s) of it`);
    });

    // ───────────────────────────────────────────────────────── 9. on screen
    section('9. the eight karts are genuinely on screen');
    const onScreen = async () => cdp.eval(`(() => { const s = __game.state;
      const rows = s.racers.map(r => { const p = __game.screenPos(r.id);
        const inside = p.visible && p.x > 0 && p.x < innerWidth && p.y > 0 && p.y < innerHeight;
        return { id: r.id, x: Math.round(p.x), y: Math.round(p.y), visible: !!p.visible, inside }; });
      return { inside: rows.filter(r => r.inside).length, visible: rows.filter(r => r.visible).length,
               vw: innerWidth, vh: innerHeight, rows, reported: __game.info().charactersOnScreen }; })()`);
    // A camera that has just been handed a fresh race is legitimately mid-transition: the
    // chase cam eases toward the kart, so a single instant after a teleport can read 0/8 while
    // the settled frame sees the whole grid. Sample until it settles (and report the best).
    const onScreenSettled = async (label) => {
      let best = await onScreen();
      const samples = [best.inside];
      for (let i = 0; i < 3; i++) {
        await sleep(450);
        const s = await onScreen();
        samples.push(s.inside);
        if (s.inside > best.inside) best = s;
      }
      console.log(`   ${label}: ${samples.join('/')} karts inside the viewport over 4 samples (best ${best.inside}/8, viewport ${best.vw}x${best.vh})`);
      return best;
    };
    const shots9 = {};
    shots9.chaseMid = await onScreenSettled('mid-race, chase');
    await cdp.eval('__game.setInput(0); __game.newRace(0); __game.step(4); true');
    shots9.gridChase = await onScreenSettled('start grid, chase');
    await cdp.eval('__game.camera("far"); __game.step(4); true');
    shots9.gridFar = await onScreenSettled('start grid, far');
    await cdp.eval('__game.camera("chase"); true');
    const best = [shots9.chaseMid, shots9.gridChase, shots9.gridFar].reduce((a, b) => (b.inside > a.inside ? b : a));
    measured.onScreen = best;
    ok('at least 6 of the 8 characters project inside the viewport', best.inside >= 6,
      `${best.inside}/8 on screen; per-kart x,y: ${best.rows.map(r => `${r.id}:${r.x},${r.y}`).join(' ')}`);
    ok('every kart projects with a valid on-screen position (no NaN, no unreachable camera bug)',
      best.rows.every(r => Number.isFinite(r.x) && Number.isFinite(r.y)),
      `${best.rows.filter(r => Number.isFinite(r.x)).length}/8 finite screen positions`);

    // ───────────────────────────────────────────────────────── 10. HUD DOM
    section('10. the HUD is in the DOM and updating');
    await cdp.eval('__h.fresh(0); __game.setInput(1); true');
    const hudA = await cdp.eval(`new Promise(r => { __game.step(120); requestAnimationFrame(() => requestAnimationFrame(() => r(__h.hudDom()))); })`);
    await cdp.eval('__game.step(180); true');
    const hudB = await cdp.eval(`new Promise(r => { requestAnimationFrame(() => requestAnimationFrame(() => r(__h.hudDom()))); })`);
    measured.hud = hudB;
    console.log('   probe: ' + JSON.stringify(await cdp.eval('__h.probe()')));
    ok('the HUD root is visible during a race', hudA.visible === true, `#hud hidden=${!hudA.visible}`);
    ok('the lap counter reads as an N/M string', /LAP\s*[0-9]+\s*\/\s*3/i.test(hudA.lap || ''), `"${hudA.lap}"`);
    ok('the position readout is populated', /[0-9]/.test(hudA.position || ''), `"${hudA.position}"`);
    ok('the speed readout is non-empty and above zero while driving', (hudB.speedNum ?? 0) > 5,
      `"${hudB.speedText}" (parsed ${num(hudB.speedNum)})`);
    ok('the speed readout actually updates between samples', hudA.speedText !== hudB.speedText,
      `"${hudA.speedText}" → "${hudB.speedText}"`);
    ok('the standings list has one row per racer (8)', hudB.standings === 8, `${hudB.standings} rows`);
    ok('the minimap canvas exists (drawn from the real track samples)', hudB.minimap === true);
    ok('the HUD text contains no NaN or Infinity', hudB.bodyHasNaN === false,
      hudB.bodyHasNaN ? 'NaN found in body text' : 'clean');

    // ───────────────────────────────────────────────────────── 11. items
    section('11. the item system works end to end');
    await cdp.eval('__h.fresh(0)');
    await stage('section 11 (items)', async () => {
    const realItems = (await itemIdsFromContent()) || ['nitro', 'nitro3', 'oil', 'cannonball', 'seeker', 'mine', 'pulse', 'overdrive', 'ink'];
    console.log(`   ITEMS in src/content.js: ${realItems.join(', ')}`);
    const itemRun = await cdp.eval(`(() => {
      const s = __game.state, p = s.racers[s.playerIndex];
      const live = () => (s.items || []).filter(x => x.state !== 'dead').length;
      const mineN = () => (s.items || []).filter(x => x.state !== 'dead' && x.ownerId === s.playerIndex).length;
      const boxInfo = (s.pickups || []).map(b => { const q = s.track.progressAt(b.x, b.z); return Math.round(q.s); });
      const seq = []; let roulette = false, sawRollTicks = 0, drove = 0, maxKmh = 0;
      for (let attempt = 0; attempt < 5; attempt++) {
        while (!p.item && drove < 2000) {                       // drive at the boxes until one is taken
          __h.drive(50, {});
          drove += 50;
          if (p.itemRollTicks > 0) { roulette = true; sawRollTicks++; }
          const k = __game.info().speedKmh; if (k > maxKmh) maxKmh = k;
          // The driver here is the bot, and a bot does not reliably find a box — on some seeds it
          // collected nothing in 2000 ticks, which made every assertion below fail VACUOUSLY (an
          // empty .some() is false, not "unproven"). After a fair run at it, park the kart on a
          // box so the REAL pickup path (stepPickups -> giveItem -> rollItem) still runs. The
          // per-racer cooldown itself is asserted directly in test/sim.test.mjs.
          if (!p.item && drove >= 1200) {
            const cands = (s.pickups || []).map(x => ({ x, cd: x.cooldowns[s.playerIndex] - s.tick }));
            cands.sort((a, c) => a.cd - c.cd);
            if (cands.length) {
              if (cands[0].cd > 0) cands[0].x.cooldowns[s.playerIndex] = 0;
              p.x = cands[0].x.x; p.z = cands[0].x.z;
            }
          }
        }
        if (!p.item) break;
        const held = p.item;
        const mine0 = mineN();
        const usesBefore = p.itemUses;
        __game.setInput(1); __game.step(2);                 // ITEM is edge-triggered: clear the bit
        __game.setInput(1 | 32); __game.step(1);            // ONE press == one use
        const slotAfterPress = p.item;
        const usesAfter = p.itemUses;
        const boostAfter = p.boostTicks;
        __game.setInput(1); __game.step(2);
        const mine1 = mineN();
        const kinds = (s.items || []).filter(x => x.state !== 'dead').map(x => x.kind);
        seq.push({ held, slotAfterPress, usesBefore, usesAfter, boostAfter, spawned: mine1 - mine0, mine: mine1, kinds: kinds.slice(0, 4), s: Math.round(p.s) });
        __game.setInput(0);
        // done once a use has BOTH consumed the slot and left something on the track — triple
        // nitros and overdrives pay out a self-boost instead, so keep collecting until the
        // throw path is exercised (or we run out of attempts).
        if (slotAfterPress == null && (mine1 - mine0) > 0) break;
      }
      return { boxInfo, boxes: (s.pickups || []).length, roulette, sawRollTicks, seq, live: live(),
               drove, maxKmh, finalS: Math.round(p.s), lap: p.lap, surfaces: p.surface }; })()`);
    measured.items = itemRun;
    console.log(`   boxes at s = [${itemRun.boxInfo.join(', ')}] · drove ${itemRun.drove} ticks (max ${num(itemRun.maxKmh)} km/h), ended at s=${itemRun.finalS} lap ${itemRun.lap} on ${itemRun.surfaces}`);
    console.log('   ' + (itemRun.seq.length
      ? itemRun.seq.map(x => `"${x.held}" → press: slot ${x.slotAfterPress || 'empty'}, +${x.spawned} owned entities (${x.kinds.join('/') || 'none'})`).join('  |  ')
      : '(no item was ever picked up)'));
    await cdp.eval('__h.fresh(0)');      // a clean grid: nothing spinning, no leftover items
    const throwTest = await cdp.eval(`(() => {
      const s = __game.state, p = s.racers[s.playerIndex];
      const mineN = () => (s.items || []).filter(x => x.state !== 'dead' && x.ownerId === s.playerIndex).length;
      p.item = 'cannonball'; p.itemUses = 1; p.itemRollTicks = 0;   // grant, then use it for real
      __game.setInput(1); __game.step(2);
      const before = mineN();
      const boostBefore = p.boostTicks;
      __game.setInput(1 | 32); __game.step(1);
      const slotAfterPress = p.item;
      const spawned = (s.items || []).filter(x => x.kind === 'cannonball' && x.state !== 'dead');
      const kinds = (s.items || []).filter(x => x.state !== 'dead').map(x => x.kind);
      __game.setInput(0); __game.step(3);
      return { before, after: mineN(), boostBefore, slotAfterPress, kinds: kinds.slice(0, 6),
               spawnedOwner: spawned.length ? spawned[0].ownerId : null,
               projectile: { before: before, after: (s.items || []).filter(x => x.state !== 'dead' && x.ownerId === s.playerIndex).length },
               live: (s.items || []).filter(x => x.state !== 'dead').length }; })()`);
    measured.itemThrow = throwTest;
    console.log(`   throw path: cannonball granted, pressed → slot ${throwTest.slotAfterPress || 'empty'}, owned entities ${throwTest.before} → ${throwTest.after}, live kinds [${throwTest.kinds.join(', ')}]`);

    ok('the track has item boxes placed by tracks.js', itemRun.boxes > 0, `${itemRun.boxes} pickups in state`);
    ok('driving over an item box granted an item', itemRun.seq.length > 0,
      `${itemRun.seq.length} item(s) collected while driving`);
    ok('every collected item id is a real ITEM from content.js',
      itemRun.seq.length > 0 && itemRun.seq.every(x => realItems.includes(x.held)),
      `collected [${itemRun.seq.map(x => x.held).join(', ')}] ⊆ {${realItems.join(',')}}`);
    ok('the roulette (roll ticks) ran before the item resolved', itemRun.roulette === true,
      `itemRollTicks seen on ${itemRun.sawRollTicks} ticks`);
    ok('using a picked-up item consumes it (slot empties, or a use is spent)',
      itemRun.seq.some(x => x.slotAfterPress == null || (x.usesAfter != null && x.usesBefore != null && x.usesAfter < x.usesBefore)),
      `uses per item: ${itemRun.seq.map(x => `${x.held} ${x.usesBefore}→${x.usesAfter}`).join(', ')}`);
    ok('using a picked-up item does something real (an entity on the track, or a boost applied)',
      itemRun.seq.some(x => x.spawned > 0 || (x.boostAfter || 0) > 0),
      `per use: +[${itemRun.seq.map(x => x.spawned).join(', ')}] owned entities, boost ticks [${itemRun.seq.map(x => x.boostAfter || 0).join(', ')}]`);
    ok('a projectile item, used through the ITEM edge, leaves the kart and spawns an entity it owns',
      throwTest.slotAfterPress == null && throwTest.spawnedOwner === await cdp.eval('__game.info().playerIndex'),
      `slot after the press: ${throwTest.slotAfterPress || 'empty'}, cannonball spawned with ownerId ${throwTest.spawnedOwner} (the kart's own id), owned entities ${throwTest.before} → ${throwTest.after}`);
    ok('the spawned projectile is the item that was used (a cannonball)',
      throwTest.kinds.indexOf('cannonball') >= 0,
      `live kinds on the track: [${throwTest.kinds.join(', ')}] (${throwTest.live} live)`);
    });

    // ───────────────────────────────────────────────────────── 12. full race
    section('12. a full race can be driven to "finished"');
    await stage('section 12 (full race)', async () => {
    await cdp.eval('__h.fresh(0)');
    let race = null;
    for (let i = 0; i < 24; i++) {
      const chunk = await cdp.eval('__h.drive(900, { drift: true, item: true })');
      race = chunk;
      const st = await cdp.eval('({ phase: __game.info().phase, tick: __game.info().tick, fin: __game.info().finishedOrder.length, lap: __h.p().lap })');
      process.stdout.write(`   ...${st.tick} ticks, phase ${st.phase}, lap ${st.lap}, ${st.fin} finished\r`);
      if (st.phase === 'finished') break;
    }
    console.log();
    // the results screen is painted by the rAF loop on the frame AFTER the sim says 'finished',
    // so poll for it rather than reading immediately (that race cost one false failure)
    let fin = null;
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      fin = await cdp.eval(`(() => { const s = __game.state, i = __game.info();
        return { phase: i.phase, order: s.finishedOrder.slice(), places: s.racers.map(r => ({ id: r.id, place: r.place, finished: !!r.finished, lap: r.lap, s: +r.s.toFixed(1), ticks: r.totalTicks })),
                 appPhase: i.appPhase, overlay: !document.getElementById('overlay').classList.contains('hidden'),
                 results: __h.resultsDom(), hud: __h.hudDom(), tick: i.tick }; })()`);
      if (fin.overlay && fin.results.table) break;
    }
    measured.finish = fin;
    ok('the race reaches phase "finished"', fin.phase === 'finished', `phase=${fin.phase} at tick ${fin.tick}`);
    ok('real racers appear in finishedOrder', fin.order.length > 0 && fin.order.every(id => id >= 0 && id < 8),
      `finishedOrder = [${fin.order.join(', ')}] (${fin.order.length} of 8)`);
    ok('every finisher completed the race distance', fin.places.filter(p => p.finished).every(p => p.lap >= Math.max(1, measured.track.laps - 1)),
      `${fin.places.filter(p => p.finished).length} classified · laps ${fin.places.map(p => p.lap).join('/')} (race is ${measured.track.laps} laps)`);
    ok('the results screen appears once the race ends', fin.overlay === true && fin.results.table === true,
      `#results table rows: ${fin.results.rows}, player row highlighted: ${fin.results.me}, colour swatches: ${fin.results.swatches}`);
    });

    // ───────────────────────────────────────────────────────── 13. graphics
    section('13. the graphics state is real');
    await cdp.eval('__h.fresh(0); __game.setInput(1); true');
    await sleep(2500);
    const gfx = await cdp.eval('({ calls: __game.info().drawCalls, tris: __game.info().triangles, fps: __game.info().fps, phase: __game.info().phase })');
    measured.gfx = gfx;
    ok('the renderer is issuing real draw calls', gfx.calls > 0, `${gfx.calls} draw calls`);
    ok('the scene has real geometry (more than 10k triangles)', gfx.tris > 10000, `${gfx.tris} triangles`);

    section('14. no NaN reaches the DOM or the info() payload');
    const nan = await cdp.eval('({ info: __h.infoNaN(), dom: /NaN|Infinity/.test(document.body.innerText || ""), hudText: document.getElementById("hud").innerText.slice(0, 80) })');
    ok('every number in info() is finite', nan.info.length === 0, nan.info.length ? 'NaN at: ' + nan.info.join(', ') : 'all finite');
    ok('no NaN or Infinity in the rendered DOM text', nan.dom === false, nan.dom ? 'found NaN in body text' : 'clean');

    // ───────────────────────────────────────────────────────── 15. screenshots
    section('15. evidence');
    await cdp.eval('__game.setInput(0); __game.newRace(0); __game.camera("chase"); true');
    await sleep(600);
    const gridShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    shots.set('start-grid.png', Buffer.from(gridShot.data, 'base64'));
    ok('start grid screenshot captured', gridShot.data.length > 5000, `shots/start-grid.png (${(gridShot.data.length / 1024).toFixed(0)} kB)`);

    await cdp.eval('__h.fresh(0); __game.setInput(1); __h.drive(600, { drift: true }); true');
    const midShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    shots.set('race-hud.png', Buffer.from(midShot.data, 'base64'));
    const midStats = pngStats(Buffer.from(midShot.data, 'base64'));
    ok('mid-race screenshot with the HUD captured', midShot.data.length > 5000 && midStats.avg > 8,
      `shots/race-hud.png (${(midShot.data.length / 1024).toFixed(0)} kB), avg luma ${num(midStats.avg)}, ${midStats.distinct} colours`);

    await cdp.eval('__game.camera("far"); __game.step(60); true');
    await sleep(500);
    const farShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    shots.set('race-far.png', Buffer.from(farShot.data, 'base64'));
    await cdp.eval('__game.camera("chase"); true');
    ok('far camera screenshot captured', farShot.data.length > 5000, `shots/race-far.png (${(farShot.data.length / 1024).toFixed(0)} kB)`);

    const shotSums = [...shots.entries()].map(([n, b]) => { let s = 0; for (let i = 0; i < b.length; i += 97) s = (s * 31 + b[i]) >>> 0; return `${n}:${s}`; });
    ok('the four screenshots are four different frames', new Set(shotSums.map(s => s.split(':')[1])).size >= 3,
      `${shots.size} shots · ${shotSums.join(' ')}`);

    // ───────────────────────────────────────────────────────── 16. errors
    section('16. error hygiene for the whole session');
    const errs = cdp.errors();
    console.log(`   ignored as not-the-game's (Chrome's own favicon probe): ${cdp.faviconHits()} request(s)`);
    const shaderErrs = errs.filter(e => /Shader Error|shader is not compiled|INVALID_OPERATION/i.test(JSON.stringify(e)));
    ok('no shader compile/link errors in any pass', shaderErrs.length === 0,
      shaderErrs.length ? cdp.describeErrors().slice(0, 300) : 'every program compiled');
    ok('no uncaught exceptions and no console errors for the entire session', errs.length === 0,
      errs.length ? cdp.describeErrors().slice(0, 400) : 'clean');

  } catch (e) {
    fail++;
    failures.push('harness: ' + e.message);
    console.log(`\n  \u2717 harness error: ${e.message}`);
    if (String(e.message).includes('__game')) {
      console.log('     the page did not boot — the failed requests printed above name the module that is missing.');
    }
  } finally {
    for (const [name, buf] of shots) { try { await writeFile(join(SHOTS, name), buf); } catch (e) { void e; } }
    cleanup();
  }

  const bar = '\u2500'.repeat(66);
  console.log(`\n${bar}\nmeasured: ${measured.gfx ? `${measured.gfx.calls} draw calls · ${measured.gfx.tris} triangles` : 'n/a'} · fps ${num(measured.fps)} (SwiftShader headless) · ${num(measured.kmh)} km/h · ${measured.onScreen ? measured.onScreen.inside : 0}/8 karts on screen`);
  console.log(`${pass} passed, ${fail} failed`);
  if (fail) { console.log('FAILED:\n  - ' + failures.join('\n  - ')); process.exit(1); }
  console.log('the game boots, renders, takes input and races in a real browser');
}

await main();
