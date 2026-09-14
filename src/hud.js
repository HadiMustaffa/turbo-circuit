// src/hud.js — TURBO CIRCUIT: the in-race head-up display and the results table.
// PRESENTATION team owns this file (CONTRACTS §1, §7, §11).
//
//   export function createHUD(rootEl) -> { update, showTitle, hide, showResults, setLap, dispose }
//
// Rules honoured here
//   * the markup, ids and CSS already exist in index.html — this file only WRITES into them,
//     it never rebuilds the skeleton and never injects a stylesheet;
//   * every element is looked up ONCE in createHUD(); a missing element is tolerated, never fatal;
//   * update() runs ~60x/s, so all writes are dirty-checked and the standings panel is diffed;
//   * the minimap circuit outline is rasterised once to an offscreen canvas and blitted, and the
//     live layers redraw at most every MINIMAP_EVERY update() calls;
//   * it imports nothing but ./content.js — never sim.js / tracks.js / render.js / karts.js.
import { PHYSICS, ITEMS, CHARS, RACE } from './content.js';

// ─────────────────────────────────────────────────────────────── tuning pulled from content.js
const DRIFT = (PHYSICS && PHYSICS.drift) || {};
const TIERS = Array.isArray(DRIFT.tiers) ? DRIFT.tiers : [];
const CHARGE_CAP = DRIFT.chargeCap || 2.4;
const TOP_KMH = ((PHYSICS && PHYSICS.topSpeed) || 26) * 3.6;
const SPEED_MAX = Math.max(60, TOP_KMH * 1.35);        // headroom for boosts / overdrive
const INK_MAX = (ITEMS && ITEMS.ink && ITEMS.ink.inkTicks) || 240;
const MAX_ROWS = 8;

const MINIMAP_EVERY = 4;        // update() calls between live minimap redraws (15 Hz @ 60 fps)
const NOTIFY_FRAMES = 126;      // ~2.1 s at 60 fps, matches the .notify CSS animation
const NOTIFY_MAX = 4;
const WRONG_WAY_WINDOW = 40;    // sustained window for the WRONG WAY warning
const WRONG_WAY_METRES = 1.5;

// original glyphs — no Nintendo IP anywhere in this file
const GLYPH = {
  nitro: '\u25B2', nitro3: '\u25B2\u25B2', oil: '\u25CD', cannonball: '\u2B24',
  seeker: '\u27A4', mine: '\u2737', pulse: '\u25CE', ink: '\u274B',
};
const GLYPH_LIST = Object.keys(GLYPH).map(k => GLYPH[k]);

// ─────────────────────────────────────────────────────────────── tiny helpers
function ordSuffix(n) {
  const v = Math.round(Math.abs(n)) % 100;
  if (v >= 11 && v <= 13) return 'th';
  switch (v % 10) { case 1: return 'st'; case 2: return 'nd'; case 3: return 'rd'; default: return 'th'; }
}
function ordNum(n) { return String(n) + ordSuffix(n); }

function fmtLapTime(ticks) {
  if (!(ticks > 0)) return '\u2014';
  const sec = ticks / 60;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return m + ':' + s.toFixed(3).padStart(6, '0');
}
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function kids(el) { return (el && (el.children || el.childNodes)) || null; }
function byTag(el, tag) {
  const arr = kids(el); if (!arr) return null;
  tag = String(tag).toLowerCase();
  for (let i = 0; i < arr.length; i++) {
    const c = arr[i];
    if (c && String(c.tagName || '').toLowerCase() === tag) return c;
  }
  return null;
}
function byClass(el, cls) {
  const arr = kids(el); if (!arr) return null;
  for (let i = 0; i < arr.length; i++) {
    const c = arr[i];
    if (c && c.classList && c.classList.contains && c.classList.contains(cls)) return c;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────── createHUD
export function createHUD(rootEl) {
  const doc = (rootEl && rootEl.ownerDocument)
    || (typeof document !== 'undefined' ? document : null);
  const $id = (id) => (doc && typeof doc.getElementById === 'function' ? doc.getElementById(id) : null);
  const root = rootEl || $id('hud');

  const els = {
    root,
    position: $id('hud-position'),
    lap: $id('hud-lap'),
    coins: $id('hud-coins'),
    speed: $id('hud-speed'),
    speedbar: $id('hud-speedbar'),
    item: $id('hud-item'),
    itemIcon: $id('hud-item-icon'),
    itemRoll: $id('hud-item-roll'),
    minimap: $id('minimap'),
    drift: $id('hud-drift'),
    driftLabel: $id('hud-drift-label'),
    slip: $id('hud-slip'),
    warn: $id('hud-warn'),
    notify: $id('hud-notify'),
    standing: $id('hud-standing'),
    ink: $id('hud-ink'),
    results: $id('results'),
    logo: $id('title-logo'),
    sub: $id('title-sub'),
  };

  // sub-elements whose ids/classes exist in index.html
  const posOrd = byTag(els.position, 'span');
  const speedNum = byClass(els.speed, 'num');
  const speedUnit = byClass(els.speed, 'unit');
  const speedFill = byTag(els.speedbar, 'i');
  const driftFill = byTag(els.drift, 'i');
  const itemCount = byClass(els.item, 'count');

  // character colours are static; resolve them once instead of per frame
  const CHAR_BY_ID = Object.create(null);
  if (Array.isArray(CHARS)) for (const c of CHARS) CHAR_BY_ID[c.id] = c;
  const charColour = (racer, fallback) => {
    if (!racer) return fallback;
    const c = CHAR_BY_ID[racer.charId];
    return (c && c.colour) || racer.colour || fallback;
  };

  let disposed = false;
  let frameCount = 0;
  let resultsCreated = false;

  // race-scoped trackers, reset by hide()
  let hasLap = [];
  let lastPlace = [];
  let wwHist = [];
  let lapStart = [];         // ticks when the racer last crossed the line (for best-lap derivation)
  const bestLapTicks = Object.create(null);
  const notifySeen = new WeakSet();
  let notes = [];
  let lastOrderSig = '';

  // standings rows, diffed forever after creation
  const rows = [];

  // minimap state
  const mm = {
    built: false, track: null, off: null, offCtx: null, live: null, liveCtx: null,
    w: 368, h: 368, scale: 1, ox: 0, oy: 0, sv: null, samples: null, len: 1,
    lastFrame: -999,
  };

  // scratch vectors
  const pt = { x: 0, z: 0, nx: 0, nz: 0 };

  // ─────────────────────────────────────────── dirty-checked DOM writes
  function setText(el, str) {
    if (!el) return;
    if (el.__tct === str) return;
    el.__tct = str;
    el.textContent = str;
  }
  function setStyle(el, prop, val) {
    if (!el) return;
    let s = el.__tcs;
    if (!s) { s = el.__tcs = Object.create(null); }
    if (s[prop] === val) return;
    s[prop] = val;
    if (el.style) { try { el.style[prop] = val; } catch (e) { /* detached/stub */ } }
  }
  function setClass(el, cls, on) {
    if (!el || !el.classList) return;
    const has = el.classList.contains ? el.classList.contains(cls) : false;
    if (on && !has) el.classList.add(cls);
    else if (!on && has) el.classList.remove(cls);
  }

  // ─────────────────────────────────────────── position readout
  // index.html ships "1<span class="ord">st</span>"; we keep the number in a text node and the
  // suffix in the span so neither part is rebuilt.
  let posNumNode = null;
  function initPosition() {
    if (!els.position) return;
    const first = els.position.childNodes && els.position.childNodes[0];
    if (first && first.nodeType === 3) { posNumNode = first; return; }
    if (!doc || !doc.createTextNode) return;
    const t = doc.createTextNode('1');
    if (els.position.insertBefore) els.position.insertBefore(t, els.position.firstChild || null);
    else els.position.appendChild(t);
    posNumNode = els.position.childNodes ? els.position.childNodes[0] : null;
  }
  initPosition();

  function setPosition(place) {
    if (!els.position) return;
    const n = Math.max(1, Math.min(MAX_ROWS, place | 0 || 1));
    const s = ordSuffix(n);
    if (posOrd) {
      if (posNumNode) { const v = String(n); if (posNumNode.nodeValue !== v) posNumNode.nodeValue = v; }
      setText(posOrd, s);
      return;
    }
    setText(els.position, String(n) + s);
  }

  // ─────────────────────────────────────────── notifications
  function notify(text, cls) {
    if (disposed || !els.notify || !doc || !doc.createElement) return;
    const el = doc.createElement('div');
    el.className = cls ? ('notify ' + cls) : 'notify';
    el.textContent = text;
    els.notify.appendChild(el);
    notes.push({ el, frame: frameCount });
    while (notes.length > NOTIFY_MAX) {
      const old = notes.shift();
      if (old && old.el && old.el.parentNode) old.el.parentNode.removeChild(old.el);
    }
    return el;
  }
  function pruneNotes() {
    while (notes.length && frameCount - notes[0].frame > NOTIFY_FRAMES) {
      const old = notes.shift();
      if (old && old.el && old.el.parentNode) old.el.parentNode.removeChild(old.el);
    }
  }
  function clearNotes() {
    for (const n of notes) if (n.el && n.el.parentNode) n.el.parentNode.removeChild(n.el);
    notes = [];
  }

  // ─────────────────────────────────────────── standings panel (diffed)
  function ensureRows(n) {
    if (!els.standing || !doc || !doc.createElement) return;
    while (rows.length < n) {
      const row = doc.createElement('div');
      row.className = 'row';
      const dot = doc.createElement('span'); dot.className = 'dot';
      const pos = doc.createElement('span'); pos.className = 'pos';
      const nm = doc.createElement('span'); nm.className = 'nm';
      const lap = doc.createElement('span'); lap.className = 'lap';
      row.appendChild(dot); row.appendChild(pos); row.appendChild(nm); row.appendChild(lap);
      els.standing.appendChild(row);
      rows.push({ el: row, dot, pos, nm, lap });
    }
  }
  function fallbackOrder(racers) {
    const out = [];
    for (let i = 0; i < (racers ? racers.length : 0); i++) {
      const r = racers[i];
      if (!r) continue;
      out.push({ id: r.id != null ? r.id : i, place: r.place || i + 1, lap: r.lap || 1, s: r.s || 0 });
    }
    out.sort((a, b) => a.place - b.place);
    return out;
  }
  function updateStandings(state, order, pi, racers, laps) {
    if (!els.standing) return;
    const list = (Array.isArray(order) && order.length) ? order : fallbackOrder(racers);
    ensureRows(list.length);
    let sig = '';
    for (let i = 0; i < list.length; i++) sig += list[i].id + ',';
    if (sig !== lastOrderSig) {
      lastOrderSig = sig;
      for (let i = 0; i < list.length; i++) {
        const r = rows[i];
        if (r) els.standing.appendChild(r.el);   // appendChild moves an existing node
      }
    }
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const e = list[i];
      if (!e) { setStyle(r.el, 'display', 'none'); continue; }
      setStyle(r.el, 'display', 'flex');
      const racer = racers ? racers[e.id] : null;
      setText(r.pos, String(e.place || i + 1));
      setText(r.nm, String(racer && racer.name ? racer.name : 'KART ' + (e.id + 1)).slice(0, 13));
      setText(r.lap, 'L' + Math.min(e.lap || 1, laps || e.lap || 1));
      setStyle(r.dot, 'background', charColour(racer, '#7cf9ff'));
      setClass(r.el, 'me', e.id === pi);
    }
  }

  // ─────────────────────────────────────────── minimap
  function buildMinimap(track) {
    mm.built = true;
    mm.track = track;
    const samples = track.samples;
    mm.samples = samples;
    mm.sv = new Float64Array(samples.length);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      mm.sv[i] = s.s != null ? s.s : i * 2;
      if (s.x < minX) minX = s.x;
      if (s.x > maxX) maxX = s.x;
      if (s.z < minZ) minZ = s.z;
      if (s.z > maxZ) maxZ = s.z;
    }
    mm.len = track.length > 0 ? track.length : (mm.sv[samples.length - 1] || 1);

    if (els.minimap && !mm.liveCtx && els.minimap.getContext) {
      try { mm.liveCtx = els.minimap.getContext('2d'); } catch (e) { mm.liveCtx = null; }
      mm.live = els.minimap;
      mm.w = els.minimap.width || 368;
      mm.h = els.minimap.height || 368;
    }
    const W = mm.w, H = mm.h;

    // one offscreen raster of the circuit outline
    if (!mm.off && doc && doc.createElement) {
      try {
        mm.off = doc.createElement('canvas');
        if (mm.off) {
          mm.off.width = W; mm.off.height = H;
          mm.offCtx = mm.off.getContext ? mm.off.getContext('2d') : null;
        }
      } catch (e) { mm.off = null; mm.offCtx = null; }
    }
    if (!mm.offCtx) return;

    const pad = 18;
    const spanX = Math.max(1e-3, maxX - minX), spanZ = Math.max(1e-3, maxZ - minZ);
    mm.scale = Math.min((W - pad * 2) / spanX, (H - pad * 2) / spanZ);
    mm.ox = W / 2 - ((minX + maxX) / 2) * mm.scale;
    mm.oy = H / 2 - ((minZ + maxZ) / 2) * mm.scale;
    const mx = (x) => mm.ox + x * mm.scale;
    const my = (z) => mm.oy + z * mm.scale;

    const c = mm.offCtx;
    c.clearRect(0, 0, W, H);
    c.beginPath();
    c.moveTo(mx(samples[0].x), my(samples[0].z));
    for (let i = 1; i < samples.length; i++) c.lineTo(mx(samples[i].x), my(samples[i].z));
    c.closePath();
    c.lineJoin = 'round'; c.lineCap = 'round';
    c.strokeStyle = 'rgba(6,10,24,0.85)'; c.lineWidth = 17; c.stroke();
    c.strokeStyle = 'rgba(124,249,255,0.55)'; c.lineWidth = 12; c.stroke();
    c.strokeStyle = 'rgba(232,246,255,0.92)'; c.lineWidth = 3; c.stroke();

    // start/finish tick + a dot for the item-box groups are not needed; grid tick is enough
    const s0 = samples[0];
    const t0x = (s0.nx || 0), t0z = (s0.nz || 0);
    c.beginPath();
    c.moveTo(mx(s0.x - t0x * 3.4), my(s0.z - t0z * 3.4));
    c.lineTo(mx(s0.x + t0x * 3.4), my(s0.z + t0z * 3.4));
    c.strokeStyle = '#ffd166'; c.lineWidth = 4; c.stroke();
  }

  function samplePoint(s) {
    const samples = mm.samples, sv = mm.sv;
    const n = sv.length;
    let v = s % mm.len;
    if (v < 0) v += mm.len;
    if (v < sv[0]) { pt.x = samples[0].x; pt.z = samples[0].z; pt.nx = samples[0].nx || 0; pt.nz = samples[0].nz || 0; return pt; }
    let lo = 0, hi = n - 1;
    while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (sv[mid] <= v) lo = mid; else hi = mid; }
    const a = samples[lo], b = samples[hi];
    const ds = (b.s != null ? b.s : sv[hi]) - (a.s != null ? a.s : sv[lo]);
    const t = ds > 1e-6 ? clamp01((v - (a.s != null ? a.s : sv[lo])) / ds) : 0;
    pt.x = a.x + (b.x - a.x) * t;
    pt.z = a.z + (b.z - a.z) * t;
    pt.nx = (a.nx || 0) + ((b.nx || 0) - (a.nx || 0)) * t;
    pt.nz = (a.nz || 0) + ((b.nz || 0) - (a.nz || 0)) * t;
    return pt;
  }

  function drawMinimap(racers, pi, laps) {
    const c = mm.liveCtx;
    if (!c || !mm.samples) return;
    const W = mm.w, H = mm.h;
    const mx = (x) => mm.ox + x * mm.scale;
    const my = (z) => mm.oy + z * mm.scale;
    try {
      c.clearRect(0, 0, W, H);
      if (mm.off) c.drawImage(mm.off, 0, 0);
      for (let i = 0; i < racers.length; i++) {
        const r = racers[i];
        if (!r) continue;
        const s = (r.s != null ? r.s : (r.progress != null ? r.progress : 0));
        const p = samplePoint(s);
        const lat = r.lateral || 0;
        const x = mx(p.x) + p.nx * lat * mm.scale;   // 1:1 with the world outline
        const y = my(p.z) + p.nz * lat * mm.scale;
        const isMe = i === pi;
        c.beginPath();
        c.arc(x, y, isMe ? 9 : 6.4, 0, Math.PI * 2);
        c.fillStyle = charColour(r, '#ffffff');
        c.fill();
        c.lineWidth = isMe ? 3.4 : 1.6;
        c.strokeStyle = isMe ? '#ffffff' : 'rgba(6,10,24,0.9)';
        c.stroke();
      }
    } catch (e) { /* a canvas failure must never break the frame loop */ }
  }

  // ─────────────────────────────────────────── results table (contract §11.7)
  function ensureResults() {
    if (els.results) return els.results;
    const overlay = $id('overlay');
    const keyhelp = $id('keyhelp');
    const parent = (keyhelp && keyhelp.parentNode) || (overlay && overlay.firstElementChild) || overlay;
    if (!doc || !doc.createElement || !parent) return null;
    const el = doc.createElement('div');
    el.id = 'results';
    if (keyhelp && parent.insertBefore) parent.insertBefore(el, keyhelp);
    else parent.appendChild(el);
    els.results = el;
    resultsCreated = true;
    return el;
  }
  function clearChildren(el) {
    if (!el) return;
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function showResults(data) {
    if (disposed || !doc || !doc.createElement) return;
    data = data || {};
    const host = ensureResults();
    if (!host) return;
    clearChildren(host);

    const order = Array.isArray(data.order) ? data.order : [];
    const racers = data.racers || [];
    const chars = Array.isArray(data.chars) ? data.chars : CHARS;
    const points = Array.isArray(data.points) ? data.points : null;
    const laps = data.laps || RACE.laps || 3;
    const pi = data.playerIndex | 0;
    let usedAverage = false;

    const head = doc.createElement('div');
    head.className = 'results-head';
    head.textContent = (data.trackName || 'CIRCUIT') + ' \u2014 ' + laps + ' LAPS' + (points ? ' \u00b7 CUP POINTS' : '');
    host.appendChild(head);

    const table = doc.createElement('table');
    const thead = doc.createElement('thead');
    const htr = doc.createElement('tr');
    const cols = ['POS', '', 'DRIVER', 'LAPS', 'BEST LAP'];
    if (points) cols.push('PTS');
    for (const label of cols) {
      const th = doc.createElement('th');
      th.textContent = label;
      htr.appendChild(th);
    }
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = doc.createElement('tbody');
    const n = order.length || racers.length || 0;   // one row per finisher, however many there are
    for (let i = 0; i < n; i++) {
      const e = order[i] || { id: i, place: i + 1, lap: 0 };
      const id = e.id != null ? e.id : i;
      const racer = racers[id] || {};
      const char = (Array.isArray(chars) ? chars.find(c => c.id === racer.charId) : null) || null;
      const place = e.place || i + 1;

      const tr = doc.createElement('tr');
      if (id === pi) tr.className = 'me';

      const tdPos = doc.createElement('td');
      tdPos.textContent = ordNum(place);
      tr.appendChild(tdPos);

      const tdSw = doc.createElement('td');
      const sw = doc.createElement('span');
      sw.className = 'sw';
      sw.style.background = (char && char.colour) || racer.colour || '#7cf9ff';
      tdSw.appendChild(sw);
      tr.appendChild(tdSw);

      const tdName = doc.createElement('td');
      let nm = (char && char.name) || racer.name || ('KART ' + (id + 1));
      if (id === pi) nm += '  (YOU)';
      tdName.textContent = nm;
      tr.appendChild(tdName);

      const tdLap = doc.createElement('td');
      tdLap.textContent = String(Math.min(e.lap || 0, laps));
      tr.appendChild(tdLap);

      const tdBest = doc.createElement('td');
      let best = bestLapTicks[id];
      if (!(best > 0) && (racer.totalTicks | 0) > 0 && e.finished) {
        best = racer.totalTicks / laps;    // race average — flagged in the footnote below
        usedAverage = true;
      }
      tdBest.textContent = fmtLapTime(best);
      tr.appendChild(tdBest);

      if (points) {
        const tdPts = doc.createElement('td');
        tdPts.textContent = String(points[place - 1] != null ? points[place - 1] : 0);
        tr.appendChild(tdPts);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    host.appendChild(table);
    if (usedAverage) {
      const note = doc.createElement('div');
      note.className = 'results-note';
      note.textContent = 'No lap split was observed for some finishers \u2014 their BEST LAP column shows their race average.';
      host.appendChild(note);
    }
  }

  function showTitle(data) {
    if (disposed) return;
    data = data || {};
    const logo = data.logo || data.title;
    const sub = data.sub || data.subtitle;
    if (logo != null) setText(els.logo, String(logo));
    if (sub != null) setText(els.sub, String(sub));
  }

  // ─────────────────────────────────────────── setLap / hide / dispose
  function setLap(data) {
    if (disposed) return;
    data = data || {};
    const laps = ((data.laps || RACE.laps || 3) | 0) || 3;
    const lap = Math.max(1, Math.min(data.lap | 0 || 1, laps));
    setText(els.lap, 'LAP ' + lap + '/' + laps);
    if (data.playerIndex != null) hasLap[data.playerIndex] = lap;
    return lap;
  }

  function hide() {
    if (disposed) return;
    setClass(els.root, 'hidden', true);
    clearNotes();
    hasLap = []; lastPlace = []; wwHist = []; lapStart = [];
    for (const k in bestLapTicks) delete bestLapTicks[k];
    lastOrderSig = '';
    setStyle(els.ink, 'opacity', '0');
    setClass(els.warn, 'on', false);
    setClass(els.slip, 'on', false);
    setClass(els.drift, 'on', false);
    setClass(els.driftLabel, 'on', false);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearNotes();
    if (els.standing) clearChildren(els.standing);
    rows.length = 0;
    if (resultsCreated && els.results && els.results.parentNode) {
      els.results.parentNode.removeChild(els.results);
    } else if (els.results) {
      clearChildren(els.results);
    }
    mm.off = null; mm.offCtx = null; mm.live = null; mm.liveCtx = null;
    mm.samples = null; mm.sv = null; mm.built = false; mm.track = null;
    for (const k in els) els[k] = null;
  }

  // ─────────────────────────────────────────── the per-frame update
  function update(state, opts) {
    if (disposed || !state) return;
    frameCount++;
    opts = opts || {};
    const racers = state.racers || [];
    const pi = (opts.playerIndex != null ? opts.playerIndex : state.playerIndex) | 0;
    const me = racers[pi] || null;
    const track = opts.track || state.track || null;
    const laps = (state.laps || (track && track.laps) || RACE.laps || 3) | 0;
    const racing = state.phase === 'racing' || state.phase === 'finished';

    // ── speed readout + gradient bar
    const kmh = typeof opts.speedKmh === 'number'
      ? opts.speedKmh
      : (me ? Math.abs(me.speed || 0) * 3.6 : 0);
    setText(speedNum, String(Math.round(kmh)));
    if (speedUnit) setText(speedUnit, 'km/h');
    setStyle(speedFill, 'width', (clamp01(kmh / SPEED_MAX) * 100).toFixed(1) + '%');

    if (me) {
      // ── position readout (correct ordinals: 1st 2nd 3rd 4th 11th)
      setPosition(me.place);

      // ── lap + coins
      const lapNow = Math.max(1, Math.min(me.lap | 0 || 1, laps));
      setText(els.lap, 'LAP ' + lapNow + '/' + laps);
      setText(els.coins, '\u25CE ' + (me.coins | 0));

      // ── item slot: roulette while rolling, glyph + remaining uses otherwise
      const itemId = opts.itemId !== undefined ? opts.itemId : me.item;
      const roll = opts.itemRollTicks !== undefined ? (opts.itemRollTicks | 0) : (me.itemRollTicks | 0);
      if (roll > 0) {
        setClass(els.item, 'empty', false);
        setText(els.itemIcon, '');
        setText(els.itemRoll, GLYPH_LIST[(frameCount >> 2) % GLYPH_LIST.length]);
        setText(itemCount, '');
      } else if (itemId && ITEMS[itemId]) {
        setClass(els.item, 'empty', false);
        setText(els.itemIcon, GLYPH[itemId] || '\u25C6');
        setText(els.itemRoll, '');
        const def = ITEMS[itemId];
        let uses = null;
        if (typeof me.itemUses === 'number') uses = me.itemUses;
        else if (typeof me.itemCount === 'number') uses = me.itemCount;
        else if (typeof me.itemStack === 'number') uses = me.itemStack;
        else if ((def.stack | 0) > 1) uses = def.stack;
        else if ((def.uses | 0) > 1) uses = def.uses;
        setText(itemCount, uses && uses > 1 ? String(uses) : '');
        if (els.item.setAttribute && els.item.__tctName !== def.name) {
          els.item.__tctName = def.name;
          els.item.setAttribute('title', def.name);
        }
      } else {
        setClass(els.item, 'empty', true);
        setText(els.itemIcon, '\u2014');
        setText(els.itemRoll, '');
        setText(itemCount, '');
      }

      // ── drift charge meter (three tiers from PHYSICS.drift.tiers)
      const charge = Math.max(0, me.driftCharge || 0);
      let tier = Math.max(0, Math.min(TIERS.length, me.driftTier | 0));
      for (let i = 0; i < TIERS.length; i++) if (charge >= TIERS[i].at) tier = i + 1;
      const drifting = (me.driftDir | 0) !== 0 || charge > 0.02;
      setStyle(driftFill, 'width', (clamp01(charge / CHARGE_CAP) * 100).toFixed(1) + '%');
      setStyle(driftFill, 'background', tier > 0 ? TIERS[tier - 1].colour : '#3ad2ff');
      setClass(els.drift, 'on', drifting);
      setClass(els.driftLabel, 'on', drifting);
      if (drifting) {
        setText(els.driftLabel, tier === 0 ? 'DRIFT'
          : 'DRIFT \u00b7 ' + String(TIERS[tier - 1].name).toUpperCase());
      }

      // ── slipstream indicator
      setClass(els.slip, 'on', (me.slipstreamTicks | 0) > 0);

      // ── ink overlay follows the player's inkTicks
      setStyle(els.ink, 'opacity', (clamp01(Math.max(0, me.inkTicks | 0) / INK_MAX) * 0.96).toFixed(2));

      // ── WRONG WAY: sustained decreasing progress
      const len = (track && track.length) || 0;
      const prog = me.progress != null ? me.progress : (me.s || 0) + (me.lap | 0) * len;
      let hist = wwHist[pi];
      if (!hist) hist = wwHist[pi] = [];
      hist.push(prog);
      if (hist.length > WRONG_WAY_WINDOW) hist.shift();
      const backed = hist[0] - prog;
      const sustained = hist.length >= WRONG_WAY_WINDOW * 0.75;
      const stuckish = (me.spinTicks | 0) > 0 || (me.respawnTicks | 0) > 0;
      setClass(els.warn, 'on',
        racing && sustained && backed > WRONG_WAY_METRES && Math.abs(me.speed || 0) > 2.5 && !stuckish);

      // ── lap / place notifications we detect ourselves (and a guarded best-lap split)
      const seenLap = hasLap[pi];
      if (seenLap == null) {
        hasLap[pi] = lapNow;
        if (typeof me.totalTicks === 'number') lapStart[pi] = me.totalTicks;
      } else if (lapNow > seenLap) {
        const tt = me.totalTicks;
        if (typeof tt === 'number' && typeof lapStart[pi] === 'number' && tt > lapStart[pi]) {
          const d = tt - lapStart[pi];
          if (d > 60 * 6 && d < 60 * 600) {      // 6 s .. 10 min — only plausible laps count
            const best = bestLapTicks[pi];
            if (!(best > 0) || d < best) bestLapTicks[pi] = d;
          }
          lapStart[pi] = tt;
        }
        hasLap[pi] = lapNow;
        notify(lapNow >= laps ? 'FINAL LAP' : 'LAP ' + lapNow + '/' + laps, '');
      }
      if (racing) {
        const pl = me.place | 0;
        const prev = lastPlace[pi] | 0;
        if (!prev) lastPlace[pi] = pl;
        else if (pl && pl !== prev) {
          lastPlace[pi] = pl;
          notify(ordNum(pl).toUpperCase() + ' PLACE!', pl < prev ? '' : 'small');
        }
      }
    }

    // ── notifications pushed by main.js (identity-deduped so a filtered array never repeats)
    const inbound = opts.notifications;
    if (Array.isArray(inbound)) {
      for (let i = 0; i < inbound.length; i++) {
        const n = inbound[i];
        if (!n || typeof n !== 'object' || notifySeen.has(n)) continue;
        notifySeen.add(n);
        notify(String(n.text != null ? n.text : ''), n.cls || '');
      }
    }
    pruneNotes();

    // ── standings
    updateStandings(state, opts.order, pi, racers, laps);

    // ── minimap (outline rasterised once per track, live layer capped to MINIMAP_EVERY)
    if (track && track.samples && track.samples.length > 8) {
      if (mm.track !== track) { mm.built = false; buildMinimap(track); }
      if (mm.built && frameCount - mm.lastFrame >= MINIMAP_EVERY) {
        mm.lastFrame = frameCount;
        drawMinimap(racers, pi, laps);
      }
    }

    // extra fields that other teams' tests may poke at (not part of the frozen signature)
    if (root) root.__hudFrames = frameCount;
  }

  return { update, showTitle, hide, showResults, setLap, dispose, __els: els, __rows: rows, __mm: mm };
}
