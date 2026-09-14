// Throwaway smoke harness for TURBO CIRCUIT src/hud.js + src/audio.js.
// Lives OUTSIDE the repo on purpose. No jsdom: it stubs a minimal DOM and a hostile
// AudioContext (resume()/close() always REJECT) and drives the real modules.
//
//   node smoke.mjs <repo-root>
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const REPO = process.argv[2] || 'C:/Users/Zen-staff/turbo-circuit';

// ─────────────────────────────────────────────────────────────── results bookkeeping
let pass = 0, fail = 0; const failures = [];
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  ok    ' + label + (detail ? '   [' + detail + ']' : '')); }
  else { fail++; failures.push(label); console.log('  FAIL  ' + label + (detail ? '   [' + detail + ']' : '')); }
}
const eq = (a, b, label) => ok(Object.is(a, b), label, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b));
const sec = (t) => console.log('\n=== ' + t + ' ===');

// ─────────────────────────────────────────────────────────────── harness counters
const HAR = { created: { el: 0, text: 0, byTag: {} }, canvasCalls: {}, starts: 0, resumeCalls: 0, closeCalls: 0, keepSuspended: false, unhandled: 0, offCtx: null };
process.on('unhandledRejection', (e) => { HAR.unhandled++; console.log('  !! unhandledRejection: ' + e); });
const snap = () => ({ el: HAR.created.el, text: HAR.created.text });
const nodes = (s) => (HAR.created.el + HAR.created.text) - (s.el + s.text);

// ─────────────────────────────────────────────────────────────── minimal DOM stub
function makeEl(doc, tag) {
  const node = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    ownerDocument: doc,
    id: '',
    parentNode: null,
    style: {},
    _kids: [],
    _attrs: {},
    _classes: new Set(),
    _text: '',
    get className() { return Array.from(this._classes).join(' '); },
    set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); },
    get classList() {
      const s = this._classes;
      return {
        add: (c) => { s.add(c); }, remove: (c) => { s.delete(c); },
        contains: (c) => s.has(c), toggle: (c, on) => { if (on) s.add(c); else s.delete(c); },
      };
    },
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this._kids.push(c); return c; },
    insertBefore(c, ref) {
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = this;
      const i = ref ? this._kids.indexOf(ref) : -1;
      if (i < 0) this._kids.push(c); else this._kids.splice(i, 0, c);
      return c;
    },
    removeChild(c) { const i = this._kids.indexOf(c); if (i >= 0) { this._kids.splice(i, 1); c.parentNode = null; } return c; },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
    get childNodes() { return this._kids; },
    get children() { return this._kids.filter(c => c.nodeType === 1); },
    get firstChild() { return this._kids[0] || null; },
    get textContent() { return this._text + this._kids.map(c => c.textContent).join(''); },
    set textContent(v) { for (const c of this._kids) c.parentNode = null; this._kids.length = 0; this._text = String(v); },
  };
  if (String(tag).toLowerCase() === 'canvas') {
    node.width = 300; node.height = 150;
    const calls = {};
    const bump = (k) => { calls[k] = (calls[k] || 0) + 1; HAR.canvasCalls[k] = (HAR.canvasCalls[k] || 0) + 1; };
    const c2d = {
      canvas: node, _isLive: false, _calls: calls,
      lineWidth: 1, lineJoin: 'miter', lineCap: 'butt', strokeStyle: '#000', fillStyle: '#000', globalAlpha: 1,
      clearRect() { bump('clearRect'); }, beginPath() { bump('beginPath'); },
      moveTo() { bump('moveTo'); }, lineTo() { bump('lineTo'); }, closePath() { bump('closePath'); },
      stroke() { bump('stroke'); }, fill() { bump('fill'); }, arc() { bump('arc'); },
      drawImage() { bump('drawImage'); }, save() { bump('save'); }, restore() { bump('restore'); },
      translate() { bump('translate'); }, scale() { bump('scale'); }, fillRect() { bump('fillRect'); },
    };
    node.getContext = (kind) => {
      if (kind !== '2d') return null;
      c2d._isLive = (doc._byId.get('minimap') === node);
      if (!c2d._isLive) HAR.offCtx = c2d;
      return c2d;
    };
  }
  return node;
}
const doc = {
  _byId: new Map(),
  createElement(tag) { HAR.created.el++; HAR.created.byTag[tag] = (HAR.created.byTag[tag] || 0) + 1; return makeEl(doc, tag); },
  createTextNode(t) {
    HAR.created.text++;
    return { nodeType: 3, nodeValue: String(t), get textContent() { return this.nodeValue; }, set textContent(v) { this.nodeValue = String(v); }, parentNode: null };
  },
  getElementById(id) { return doc._byId.get(id) || null; },
};
function E(tag, id, cls, text) {
  const n = makeEl(doc, tag);
  if (id) { n.id = id; doc._byId.set(id, n); }
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// mirrors index.html exactly: note there is NO #results element in that markup
const hudRoot = E('div', 'hud', 'hidden');
const pos = E('div', 'hud-position');
pos.appendChild(doc.createTextNode('1'));
pos.appendChild(E('span', null, 'ord', 'st'));
hudRoot.appendChild(pos);
hudRoot.appendChild(E('div', 'hud-lap', null, 'LAP 1/3'));
hudRoot.appendChild(E('div', 'hud-coins', null, '\u25CE 0'));
const speed = E('div', 'hud-speed');
speed.appendChild(E('span', null, 'num', '0'));
speed.appendChild(doc.createTextNode(' '));
speed.appendChild(E('span', null, 'unit', 'km/h'));
hudRoot.appendChild(speed);
const speedbar = E('div', 'hud-speedbar');
speedbar.appendChild(E('i'));
hudRoot.appendChild(speedbar);
const item = E('div', 'hud-item', 'panel empty');
item.appendChild(E('span', 'hud-item-icon', null, '\u2014'));
item.appendChild(E('span', 'hud-item-roll'));
item.appendChild(E('span', null, 'count'));
hudRoot.appendChild(item);
const mmWrap = E('div', 'hud-minimap', 'panel');
const mmCanvas = E('canvas', 'minimap');
mmCanvas.width = 368; mmCanvas.height = 368;
mmWrap.appendChild(mmCanvas);
hudRoot.appendChild(mmWrap);
const drift = E('div', 'hud-drift');
drift.appendChild(E('i'));
drift.appendChild(E('u')); drift.appendChild(E('u')); drift.appendChild(E('u'));
hudRoot.appendChild(drift);
const driftLabel = E('div', 'hud-drift-label', null, 'DRIFT');
hudRoot.appendChild(driftLabel);
const slipEl = E('div', 'hud-slip', null, 'SLIPSTREAM');
hudRoot.appendChild(slipEl);
const warnEl = E('div', 'hud-warn', null, 'WRONG WAY');
hudRoot.appendChild(warnEl);
const notifyEl = E('div', 'hud-notify');
hudRoot.appendChild(notifyEl);
const standingEl = E('div', 'hud-standing');
hudRoot.appendChild(standingEl);
const inkEl = E('div', 'hud-ink');
hudRoot.appendChild(inkEl);

const overlay = E('div', 'overlay');
const card = E('div', 'card');
card.appendChild(E('div', 'title-logo', null, 'TURBO CIRCUIT'));
card.appendChild(E('div', 'title-sub', null, 'Kart Grand Prix'));
card.appendChild(E('div', 'title-blurb', null, 'blurb'));
card.appendChild(E('div', 'menu'));
card.appendChild(E('div', 'keyhelp', null, 'keys'));
overlay.appendChild(card);
globalThis.document = doc;

// ─────────────────────────────────────────────────────────────── hostile AudioContext
const T_ZERO = performance.now();
function P(init) {
  return {
    value: init || 0, _events: 0,
    setValueAtTime(v) { this.value = v; this._events++; return this; },
    linearRampToValueAtTime(v) { this.value = v; this._events++; return this; },
    exponentialRampToValueAtTime(v) {
      if (!(v > 0)) throw new Error('exponentialRampToValueAtTime needs a positive target');
      this.value = v; this._events++; return this;
    },
    cancelScheduledValues() { this._events++; return this; },
    setTargetAtTime(v) { this.value = v; this._events++; return this; },
  };
}
class FakeCtx {
  constructor() {
    this.sampleRate = 48000; this.state = 'suspended';
    this.destination = { _dest: true };
  }
  get currentTime() { return (performance.now() - T_ZERO) / 1000; }   // a real, advancing clock
  createGain() { return { _k: 'gain', gain: P(1), connect() { return this; }, disconnect() {} }; }
  createOscillator() {
    const o = { _k: 'osc', type: 'sine', frequency: P(440), detune: P(0), connect() { return this; }, stop() {} };
    o.start = () => { HAR.starts++; };
    return o;
  }
  createBiquadFilter() { return { _k: 'biquad', type: 'lowpass', frequency: P(1000), Q: P(1), connect() { return this; } }; }
  createBufferSource() {
    const s = { _k: 'src', buffer: null, loop: false, connect() { return this; }, stop() {} };
    s.start = () => { HAR.starts++; };
    return s;
  }
  createBuffer(ch, len) { const d = new Float32Array(len); return { length: len, sampleRate: 48000, getChannelData: () => d }; }
  createDynamicsCompressor() { return { _k: 'comp', threshold: P(-8), knee: P(12), ratio: P(6), attack: P(0.004), release: P(0.2), connect() { return this; } }; }
  resume() { HAR.resumeCalls++; if (!HAR.keepSuspended) this.state = 'running'; return Promise.reject(new Error('simulated autoplay block')); }
  close() { HAR.closeCalls++; this.state = 'closed'; return Promise.reject(new Error('simulated close failure')); }
}
globalThis.AudioContext = FakeCtx;

// ─────────────────────────────────────────────────────────────── fixture
const CHARS = ['vex', 'nami', 'bruno', 'pixel', 'sable', 'juno', 'fang', 'ola'];
const NAMES = ['Bolt Vexx', 'Nami Isla', 'Bruno Kask', 'Pixel-9', 'Sable Ravn', 'Juno Sky', 'Fang Rusk', 'Ola Mint'];
const TRACK = (() => {
  const N = 200, samples = [];
  const ax = 200, az = 140, len = 2 * Math.PI * Math.sqrt((ax * ax + az * az) / 2);
  for (let i = 0; i < N; i++) {
    const th = (i / N) * Math.PI * 2;
    const x = ax * Math.cos(th), z = az * Math.sin(th);
    const tx = -ax * Math.sin(th), tz = az * Math.cos(th);
    const tl = Math.hypot(tx, tz);
    samples.push({ x, z, tx: tx / tl, tz: tz / tl, nx: -tz / tl, nz: tx / tl, curvature: 0.01, s: (i * len) / N });
  }
  return { index: 0, id: 'sunset-bay', name: 'Sunset Bay', theme: 'coast', laps: 3, halfWidth: 7, length: len, samples };
})();
function makeRacer(i) {
  const th = (i / 8) * Math.PI * 2;
  return {
    id: i, name: NAMES[i % 8], charId: CHARS[i % 8], kartId: 'k-' + CHARS[i % 8], isPlayer: i === 2, cpu: i !== 2,
    x: 200 * Math.cos(th), y: 0, z: 140 * Math.sin(th), heading: th,
    speed: 20, vx: 0, vz: 0, s: (i * 60) % TRACK.length, lateral: (i - 4) * 1.5,
    lap: 1, place: i + 1, progress: i * 60, driftDir: 0, driftCharge: 0, driftTier: 0, hopTicks: 0,
    boostTicks: 0, boostKind: null, miniTurboTicks: 0, spinTicks: 0, squashTicks: 0, respawnTicks: 0,
    inkTicks: 0, pulseTicks: 0, overdriveTicks: 0, item: null, itemTicks: 0, itemRollTicks: 0,
    coins: 0, slipstreamTicks: 0, offTrack: false, surface: 'road', rocketStart: 0,
    finished: false, finishTick: 0, totalTicks: 0, ai: {}, _px: 0, _pz: 0, _ph: 0,
  };
}
const state = {
  tick: 0, phase: 'racing', countdownTicks: 0, seed: 1, rng: { next: () => 0.5, state: 1 },
  track: TRACK, racerCount: 8, laps: 3, playerIndex: 2, mode: 'cup',
  racers: Array.from({ length: 8 }, (_, i) => makeRacer(i)),
  items: [], pickups: [], particles: [], events: [], finishedOrder: [], raceTicks: 0,
};
function makeOrder(places) {
  return places.map((place, i) => ({ id: i, place, lap: state.racers[i].lap, s: state.racers[i].s, finished: false, totalTime: 0 }))
    .sort((a, b) => a.place - b.place);
}
function mutate(frame) {
  const me = state.racers[2];
  state.tick = frame;
  me.speed = 26 * (0.35 + 0.65 * Math.abs(Math.sin(frame / 47)));
  me.coins = Math.min(10, Math.floor(frame / 34));
  me.lap = frame < 100 ? 1 : frame < 200 ? 2 : 3;
  me.place = frame < 60 ? 4 : frame < 120 ? 3 : frame < 200 ? 5 : 1;
  me.driftCharge = frame < 10 ? 0 : Math.min(2.4, (frame - 10) * 0.04);
  me.driftDir = frame >= 10 && frame < 90 ? 1 : 0;
  me.driftTier = me.driftCharge >= 1.75 ? 3 : me.driftCharge >= 1.10 ? 2 : me.driftCharge >= 0.55 ? 1 : 0;
  me.slipstreamTicks = frame >= 200 && frame < 230 ? 30 : 0;
  me.inkTicks = frame >= 150 && frame < 190 ? 240 : 0;
  me.offTrack = frame > 240;
  me.boostTicks = frame % 90 > 80 ? 8 : 0;
  me.itemRollTicks = frame >= 80 && frame < 110 ? 20 : 0;
  me.item = frame >= 80 && frame < 110 ? 'nitro' : frame >= 110 && frame < 160 ? 'nitro3' : 'seeker';
  me.itemStack = 2;
  me.totalTicks = frame * 60;
  for (let i = 0; i < 8; i++) {
    const r = state.racers[i];
    r.place = i === 2 ? me.place : ((i + frame) % 8) + 1;
    r.lap = i === 2 ? me.lap : 1 + ((i + frame) % 3);
    r.progress = i === 2 ? (frame < 120 ? frame * 2 : frame < 200 ? frame * -2 : frame * 2) : i * 100 + frame;
    r.s = ((r.progress % TRACK.length) + TRACK.length) % TRACK.length;
    r.speed = 18 + (i % 4) * 2;
  }
}
const opts = (order, notifications) => ({
  camera: null, renderer: null, playerIndex: 2, track: TRACK,
  speedKmh: state.racers[2].speed * 3.6, notifications: notifications || [], order: order || [],
});
const textsOf = (el) => el.childNodes.map(c => c.textContent);
const findIn = (el, cls) => el.children.find(c => c.classList.contains(cls));
const numSpan = findIn(doc._byId.get('hud-speed'), 'num');
const fillI = doc._byId.get('hud-speedbar').children.find(c => c.tagName === 'I');
const iconEl = doc._byId.get('hud-item-icon');
const rollEl = doc._byId.get('hud-item-roll');
const countEl = findIn(doc._byId.get('hud-item'), 'count');
const dFill = drift.children.find(c => c.tagName === 'I');

// ─────────────────────────────────────────────────────────────── load the real modules
const hudMod = await import(pathToFileURL(path.join(REPO, 'src/hud.js')).href);
const audioMod = await import(pathToFileURL(path.join(REPO, 'src/audio.js')).href);

sec('MODULE SURFACE');
eq(typeof hudMod.createHUD, 'function', 'hud.js exports createHUD');
eq(typeof audioMod.createAudio, 'function', 'audio.js exports createAudio');

sec('HUD — 300 scripted frames');
const hud = hudMod.createHUD(hudRoot);
for (const k of ['update', 'showTitle', 'hide', 'showResults', 'setLap', 'dispose']) eq(typeof hud[k], 'function', 'hud.' + k + ' is a function');

const s300 = snap();
const drawBefore300 = HAR.canvasCalls.drawImage || 0;
let sawLap2 = false, sawFinal = false, sawThird = false, sawFirst = false, sawInbound = false;
let warnOnFrames = 0, warnOffAfter = 0, maxNotifyNodes = 0;
const t0 = process.hrtime.bigint();
for (let f = 0; f < 300; f++) {
  mutate(f);
  const notes = [];
  if (f === 40) notes.push({ text: 'BOOST PAD', cls: 'small' });
  if (f === 41) notes.push({ text: 'HIT!', cls: 'small' });
  hud.update(state, opts(makeOrder([4, 1, 2, 3, 5, 6, 7, 8]), notes));
  const nt = textsOf(notifyEl);
  if (nt.includes('LAP 2/3')) sawLap2 = true;
  if (nt.includes('FINAL LAP')) sawFinal = true;
  if (nt.includes('3RD PLACE!')) sawThird = true;
  if (nt.includes('1ST PLACE!')) sawFirst = true;
  if (nt.includes('BOOST PAD')) sawInbound = true;
  if (notifyEl.childNodes.length > maxNotifyNodes) maxNotifyNodes = notifyEl.childNodes.length;
  if (warnEl.classList.contains('on')) warnOnFrames++;
  if (f > 210 && f < 240 && !warnEl.classList.contains('on')) warnOffAfter++;
}
const ms300 = Number(process.hrtime.bigint() - t0) / 1e6;
const created300 = nodes(s300);
const redraws300 = (HAR.canvasCalls.drawImage || 0) - drawBefore300;
console.log('  300 updates in ' + ms300.toFixed(1) + ' ms  (' + (ms300 / 300).toFixed(3) + ' ms/frame)');
ok(true, 'update() survived 300 scripted frames without throwing');
ok(redraws300 <= 76, 'minimap redraws capped over 300 frames (cap 1 per 4 updates)', 'redraws=' + redraws300);

sec('HUD — steady state (identical state + opts, 300 more frames)');
const sFreeze = snap();
for (let f = 0; f < 300; f++) hud.update(state, opts(makeOrder([1, 2, 3, 4, 5, 6, 7, 8]), []));
const createdFrozen = nodes(sFreeze);
eq(createdFrozen, 0, 'DOM nodes created across 300 steady-state frames');
console.log('  event-driven creations over the scripted 300 frames: ' + created300);

sec('HUD — readouts');
state.racers[2].place = 1; hud.update(state, opts(makeOrder([1, 2, 3, 4, 5, 6, 7, 8]), []));
eq(String(pos.textContent), '1st', '#hud-position reads "1st" for place 1');
state.racers[2].place = 2; hud.update(state, opts(makeOrder([1, 2, 3, 4, 5, 6, 7, 8]), []));
eq(String(pos.textContent), '2nd', 'place 2 -> "2nd"');
state.racers[2].place = 3; hud.update(state, opts(makeOrder([1, 2, 3, 4, 5, 6, 7, 8]), []));
eq(String(pos.textContent), '3rd', 'place 3 -> "3rd"');
state.racers[2].place = 4; hud.update(state, opts(makeOrder([1, 2, 3, 4, 5, 6, 7, 8]), []));
eq(String(pos.textContent), '4th', 'place 4 -> "4th"');
eq(String(doc._byId.get('hud-lap').textContent), 'LAP 3/3', '#hud-lap reads "LAP 3/3"');
eq(String(doc._byId.get('hud-coins').textContent), '\u25CE 8', '#hud-coins tracks racer.coins');
ok(Number(numSpan.textContent) > 0, '#hud-speed .num is a number', 'num=' + numSpan.textContent);
ok(/%$/.test(fillI.style.width), '#hud-speedbar > i has a % width', 'width=' + fillI.style.width);
ok(String(findIn(doc._byId.get('hud-speed'), 'unit').textContent) === 'km/h', 'speed unit span kept as km/h');

sec('HUD — item slot + roulette');
state.racers[2].item = 'nitro3'; state.racers[2].itemRollTicks = 0; state.racers[2].itemStack = 2;
hud.update(state, opts(makeOrder([1, 2, 3, 4, 5, 6, 7, 8]), []));
ok(String(iconEl.textContent).length > 0, 'item glyph drawn for Triple Nitro', 'icon="' + iconEl.textContent + '"');
eq(String(countEl.textContent), '2', 'triple-nitro remaining-uses count in .count');
const rollSeen = new Set();
state.racers[2].itemRollTicks = 20;
for (let f = 0; f < 24; f++) { hud.update(state, opts(makeOrder([1, 2, 3, 4, 5, 6, 7, 8]), [])); rollSeen.add(String(rollEl.textContent)); }
ok(rollSeen.size > 1, 'roulette cycles while itemRollTicks > 0', 'distinct glyphs=' + rollSeen.size + ' ' + Array.from(rollSeen).join(''));
eq(String(iconEl.textContent), '', 'roulette blanks the static glyph');
state.racers[2].itemRollTicks = 0; state.racers[2].item = null;
hud.update(state, opts(makeOrder([1, 2, 3, 4, 5, 6, 7, 8]), []));
ok(doc._byId.get('hud-item').classList.contains('empty'), 'no item -> .empty on #hud-item');

sec('HUD — drift meter / slipstream / ink / wrong way');
const widths = [], colours = [];
for (const c of [0.3, 0.6, 1.2, 1.8]) {
  state.racers[2].driftCharge = c; state.racers[2].driftDir = 1;
  hud.update(state, opts(makeOrder([1, 2, 3, 4, 5, 6, 7, 8]), []));
  widths.push(dFill.style.width); colours.push(dFill.style.background);
}
ok(widths[0] !== widths[3], 'drift meter width follows driftCharge', widths.join(' -> '));
ok(new Set(colours).size >= 3, 'drift meter colour walks the three PHYSICS tiers', colours.join(' '));
ok(drift.classList.contains('on'), '#hud-drift gets .on while drifting');
ok(driftLabel.classList.contains('on'), '#hud-drift-label gets .on while drifting');
state.racers[2].slipstreamTicks = 40;
hud.update(state, opts(makeOrder([1, 2, 3, 4, 5, 6, 7, 8]), []));
ok(slipEl.classList.contains('on'), '#hud-slip .on while slipstreamTicks > 0');
state.racers[2].inkTicks = 240; hud.update(state, opts(makeOrder([1, 2, 3, 4, 5, 6, 7, 8]), []));
const inkOn = inkEl.style.opacity;
state.racers[2].inkTicks = 0; hud.update(state, opts(makeOrder([1, 2, 3, 4, 5, 6, 7, 8]), []));
const inkOff = inkEl.style.opacity;
ok(parseFloat(inkOn) > 0.9 && parseFloat(inkOff) === 0, '#hud-ink opacity follows inkTicks', inkOn + ' -> ' + inkOff);
ok(warnOnFrames > 0, 'WRONG WAY raised while progress fell over the sustained window', 'frames on=' + warnOnFrames);
ok(warnOffAfter >= 25, 'WRONG WAY cleared once progress recovered', 'frames off in 211..239=' + warnOffAfter);

sec('HUD — notifications');
ok(sawLap2, 'self-detected "LAP 2/3"');
ok(sawFinal, 'self-detected "FINAL LAP"');
ok(sawThird, 'self-detected "3RD PLACE!"');
ok(sawFirst, 'self-detected "1ST PLACE!"');
ok(sawInbound, 'opts.notifications appended into #hud-notify');
ok(maxNotifyNodes <= 4, '#hud-notify children stay capped', 'max=' + maxNotifyNodes);

sec('HUD — standings panel (diffed)');
const rows = standingEl.children;
eq(rows.length, 8, 'standings panel holds 8 rows');
for (let f = 0; f < 60; f++) hud.update(state, opts(makeOrder([1, 2, 3, 4, 5, 6, 7, 8]), []));
ok(standingEl.children.every((r, i) => r === rows[i]), 'standings rows are reused, never rebuilt (identity stable over 60 frames)');
const dots = rows.map(r => findIn(r, 'dot').style.background);
ok(dots.every(d => typeof d === 'string' && d.length > 0), 'every row has a colour dot', dots.slice(0, 3).join(' '));
ok(rows.some(r => r.classList.contains('me')), 'player row carries .me');
ok(rows.map(r => findIn(r, 'lap').textContent).every(t => /^L\d+$/.test(String(t))), 'every row shows a lap number', rows.map(r => findIn(r, 'lap').textContent).join(' '));
const firstBefore = findIn(standingEl.children[0], 'nm').textContent;
hud.update(state, opts(makeOrder([8, 7, 6, 5, 4, 3, 2, 1]), []));
const firstAfter = findIn(standingEl.children[0], 'nm').textContent;
ok(firstBefore !== firstAfter, 'standings reorder when the race order changes', firstBefore + ' -> ' + firstAfter);

sec('HUD — minimap');
ok(HAR.offCtx && !HAR.offCtx._isLive, 'offscreen outline canvas created once');
console.log('  offscreen raster: moveTo=' + (HAR.offCtx ? HAR.offCtx._calls.moveTo : 0) +
  ' lineTo=' + (HAR.offCtx ? HAR.offCtx._calls.lineTo : 0) +
  ' strokes=' + (HAR.offCtx ? HAR.offCtx._calls.stroke : 0) +
  ' clearRect=' + (HAR.offCtx ? HAR.offCtx._calls.clearRect : 0) + ' (samples=200)');
const drawTotal = HAR.canvasCalls.drawImage || 0;
const arcTotal = HAR.canvasCalls.arc || 0;
ok(drawTotal > 0, 'live minimap blits the offscreen circuit', 'drawImage=' + drawTotal);
ok(arcTotal / drawTotal >= 7.9 && arcTotal / drawTotal <= 8.1, 'exactly 8 dots plotted per redraw', 'arcs/redraw=' + (arcTotal / drawTotal).toFixed(2));

sec('HUD — setLap / showTitle / showResults / hide / dispose');
hud.setLap({ lap: 2, laps: 3, playerIndex: 2 });
eq(String(doc._byId.get('hud-lap').textContent), 'LAP 2/3', 'setLap writes the lap counter');
hud.showTitle({ logo: 'TURBO CIRCUIT', sub: 'KART GRAND PRIX' });
eq(String(doc._byId.get('title-logo').textContent), 'TURBO CIRCUIT', 'showTitle writes #title-logo');

const order11 = [];
for (let i = 0; i < 11; i++) order11.push({ id: i, place: i + 1, lap: 3, s: 0, finished: i < 8, totalTime: 0 });
const raceForResults = [];
for (let i = 0; i < 11; i++) { const r = makeRacer(i); r.finished = i < 8; r.totalTicks = i < 8 ? 9000 : 0; r.lap = 3; raceForResults.push(r); }
hud.showResults({ order: order11, playerIndex: 2, racers: raceForResults, laps: 3, trackName: 'Sunset Bay', chars: null, points: [15, 12, 10, 8, 6, 4, 2, 1] });
const results = card.children.find(c => c.id === 'results');
ok(!!results, 'showResults creates #results (index.html ships no such element)');
eq(results && results.parentNode === card, true, '#results inserted into the overlay card');
const table = results && results.children.find(c => c.tagName === 'TABLE');
ok(!!table, 'showResults writes a real <table>');
const tbody = table && table.children.find(c => c.tagName === 'TBODY');
eq(tbody ? tbody.children.length : -1, 11, 'one row per finisher');
const row1 = tbody.children[0].children.map(c => c.textContent);
console.log('  row 1 cells: ' + JSON.stringify(row1));
eq(row1[0], '1st', 'row 1 position + ordinal');
eq(tbody.children[2].children[0].textContent, '3rd', 'row 3 ordinal');
eq(row1[4], '0:50.000', 'BEST LAP falls back to the race average when no split was observed');
eq(tbody.children[2].children[4].textContent, '1:40.000', 'BEST LAP from an observed lap split (player)');
ok(/^\d+$/.test(row1[5]), 'cup points column present when data.points is given', 'pts=' + row1[5]);
eq(String(row1[5]), '15', 'points table applied by place');
ok(String(tbody.children[0].children[1].children[0].className).includes('sw'), 'colour swatch cell present');
const meRow = tbody.children[2];
eq(String(meRow.className), 'me', "player's row carries .me");
ok(String(meRow.children[2].textContent).includes('(YOU)'), "player's row labelled (YOU)");
const ords = tbody.children.map(r => r.children[0].textContent);
console.log('  ordinals: ' + ords.join(' '));
eq(ords[10], '11th', 'ordinal 11 -> "11th" (the 11/12/13 trap)');
eq(ords[0], '1st', 'ordinal 1 -> "1st"');
eq(ords[2], '3rd', 'ordinal 3 -> "3rd"');
eq(ords[3], '4th', 'ordinal 4 -> "4th"');
ok(!!results.children.find(c => String(c.className).includes('results-note')), 'footnote added when an average was substituted');

// main.js hides the HUD with a class at race end; hud.hide() is its new-race reset hook
hud.update(state, opts(makeOrder([1, 2, 3, 4, 5, 6, 7, 8]), [{ text: 'BACK ON TRACK', cls: 'small' }]));
ok(notifyEl.childNodes.length > 0, 'a pushed notification is pending before hide()', 'children=' + notifyEl.childNodes.length);
hud.hide();
ok(hudRoot.classList.contains('hidden'), 'hide() adds .hidden to #hud');
eq(notifyEl.childNodes.length, 0, 'hide() clears pending notifications');
hud.showResults({ order: order11, playerIndex: 2, racers: raceForResults, laps: 3, trackName: 'Sunset Bay', chars: null, points: [15, 12, 10, 8, 6, 4, 2, 1] });
eq(results.children.find(c => c.tagName === 'TABLE').children[1].children.length, 11, 'showResults still renders after hide()');
ok(true, 'showResults survives hide() (main.js calls hide() on a new race, not at race end)');

const sDispose = snap();
hud.dispose();
hud.update(state, opts(makeOrder([1, 2, 3, 4, 5, 6, 7, 8]), []));
hud.showResults({ order: order11, playerIndex: 2, racers: raceForResults, laps: 3, trackName: 'x', chars: null, points: null });
hud.hide(); hud.setLap({ lap: 1, laps: 3 }); hud.showTitle({ logo: 'x' });
eq(nodes(sDispose), 0, 'post-dispose calls create no nodes and never throw');
eq(results.parentNode, null, 'dispose() removed the #results node it created');
const hud2 = hudMod.createHUD(hudRoot);
ok(typeof hud2.update === 'function', 'createHUD can be created again after dispose()');
hud2.dispose();

// ─────────────────────────────────────────────────────────────── AUDIO
const EVENT_NAMES = ['boost', 'drift', 'hop', 'pickup', 'roll', 'throw', 'hit', 'spinout', 'respawn', 'pad', 'land', 'lap', 'finish', 'countdown', 'go', 'offroad', 'coin', 'explosion'];

sec('AUDIO — no AudioContext at all');
const savedAC = globalThis.AudioContext;
globalThis.AudioContext = undefined;
const aNoCtx = audioMod.createAudio();
let noCtxThrew = null;
try {
  aNoCtx.unlock();
  for (const n of EVENT_NAMES) aNoCtx.play(n, { tier: 2, n: 3 });
  aNoCtx.play('nope-not-an-event');
  for (let i = 0; i < 120; i++) aNoCtx.engine(state, 2);
  aNoCtx.music(true); aNoCtx.music(false);
  aNoCtx.setMuted(true); aNoCtx.setMuted(false);
  aNoCtx.dispose();
} catch (e) { noCtxThrew = e; }
ok(noCtxThrew === null, 'no AudioContext: nothing throws', noCtxThrew ? String(noCtxThrew) : '');
eq(aNoCtx.stats().voices.total, 0, 'no AudioContext: zero voices started');
eq(aNoCtx.stats().graphReady, false, 'no AudioContext: graph never built');
globalThis.AudioContext = savedAC;

sec('AUDIO — muted from the start (the --mute-audio target)');
HAR.starts = 0;
const aMuted = audioMod.createAudio();
eq(typeof aMuted.muted, 'boolean', 'audio.muted is a boolean property');
let mutedThrew = null, mutedPlayTrue = 0;
try {
  aMuted.setMuted(true);
  aMuted.unlock();
  for (let rep = 0; rep < 3; rep++) for (const n of EVENT_NAMES) { if (aMuted.play(n, { tier: 3, n: 2 })) mutedPlayTrue++; }
  for (let i = 0; i < 300; i++) aMuted.engine(state, 2);
  aMuted.music(true);
  aMuted.unlock();
} catch (e) { mutedThrew = e; }
const ms = aMuted.stats();
ok(mutedThrew === null, 'muted: nothing throws', mutedThrew ? String(mutedThrew) : '');
eq(ms.voices.total, 0, 'muted: internal voice counter is 0');
eq(HAR.starts, 0, 'muted: independent AudioContext start() count is 0 (no sound can exist)');
eq(mutedPlayTrue, 0, 'muted: play() returns false for every event name');
console.log('  muted: playCalls=' + ms.playCalls + ' skipped=' + ms.mutedSkips + ' engineCalls=' + ms.engineCalls +
  ' resumeCalls=' + HAR.resumeCalls + ' ctxState=' + ms.ctxState + ' graphReady=' + ms.graphReady);

sec('AUDIO — unmuted: unlock then every event');
HAR.starts = 0; HAR.resumeCalls = 0;
aMuted.setMuted(false);
aMuted.unlock();
aMuted.music(false);                     // keep the counter comparison deterministic
let unThrew = null, played = 0, unknownFalse = null;
try {
  for (const n of EVENT_NAMES) if (aMuted.play(n, { tier: 2, n: 3 })) played++;
  unknownFalse = aMuted.play('nope-not-an-event');
} catch (e) { unThrew = e; }
const internalNow = aMuted.stats().voices.total, startsNow = HAR.starts;
const us = aMuted.stats();
ok(unThrew === null, 'unmuted: nothing throws', unThrew ? String(unThrew) : '');
eq(played, EVENT_NAMES.length, 'all 16 CONTRACTS §8 events + coin + explosion play');
eq(unknownFalse, false, 'unknown event name returns false instead of throwing');
ok(us.voices.total > 0, 'unmuted: voices started', 'internal=' + us.voices.total + ' oneShot=' + us.voices.oneShot + ' bed=' + us.voices.bed);
eq(internalNow, startsNow, 'internal voice counter == harness AudioContext start() count');
ok(HAR.resumeCalls > 0, 'resume() attempted on the suspended context (rejection swallowed)', 'resumeCalls=' + HAR.resumeCalls);
console.log('  unmuted: voices=' + JSON.stringify(us.voices) + ' harnessStarts=' + startsNow + ' ctxState=' + us.ctxState);

sec('AUDIO — engine() is allocation-free');
const vBeforeEngine = aMuted.stats().voices.total;
let engineThrew = null;
try { for (let i = 0; i < 300; i++) aMuted.engine(state, 2); } catch (e) { engineThrew = e; }
ok(engineThrew === null, 'engine() survived 300 frames');
eq(aMuted.stats().voices.total, vBeforeEngine, 'engine() starts no voices across 300 frames (pure AudioParam writes)');
aMuted.dispose();
aMuted.dispose();

sec('AUDIO — procedural music loop');
const aMusic = audioMod.createAudio();
aLiveBranch: {
  aMusic.unlock();
  aMusic.music(true);
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 45));
  const mv = aMusic.stats().voices.music;
  ok(mv >= 4, 'music(true) schedules synthesised bass + arpeggio notes', 'music voices in 225 ms=' + mv);
  const vOff = aMusic.stats().voices.total;
  aMusic.music(false);
  await new Promise(r => setTimeout(r, 160));
  eq(aMusic.stats().voices.total, vOff, 'music(false) stops the scheduler (no further voices)');
}
aMusic.dispose();

sec('AUDIO — blocked context (resume() rejects) + mute mid-race');
HAR.keepSuspended = true;
const aBlocked = audioMod.createAudio();
let blockedThrew = null;
try {
  aBlocked.unlock();
  for (const n of EVENT_NAMES) aBlocked.play(n);
  for (let i = 0; i < 60; i++) aBlocked.engine(state, 2);
  aBlocked.music(true);
  await new Promise(r => setTimeout(r, 60));
  aBlocked.dispose();
} catch (e) { blockedThrew = e; }
ok(blockedThrew === null, 'blocked ctx: unlock/play/engine/music never throw', blockedThrew ? String(blockedThrew) : '');
HAR.keepSuspended = false;
const vAfterDispose = aBlocked.stats().voices.total;
try { aBlocked.play('boost'); aBlocked.engine(state, 2); aBlocked.music(true); aBlocked.unlock(); aBlocked.dispose(); } catch (e) { blockedThrew = e; }
ok(blockedThrew === null, 'post-dispose calls on a disposed instance never throw');
eq(aBlocked.stats().voices.total, vAfterDispose, 'post-dispose calls start no voices');

sec('AUDIO — mute after unlock freezes the counter');
const aLive = audioMod.createAudio();
aLive.unlock();
aLive.play('boost');
const vLive = aLive.stats().voices.total;
ok(vLive > 0, 'live context started voices', 'voices=' + vLive);
aLive.setMuted(true);
for (const n of EVENT_NAMES) aLive.play(n);
for (let i = 0; i < 120; i++) aLive.engine(state, 2);
aLive.music(true);
eq(aLive.stats().voices.total, vLive, 'muting mid-race stops every new voice (counter frozen)');
eq(aLive.muted, true, 'audio.muted reflects setMuted(true)');
aLive.setMuted(false);
aLive.play('boost');
ok(aLive.stats().voices.total > vLive, 'unmuting resumes audible voices');
aLive.dispose();

sec('AUDIO — dispose before unlock');
const aVirgin = audioMod.createAudio();
let virginThrew = null;
try { aVirgin.dispose(); aVirgin.unlock(); aVirgin.play('boost'); aVirgin.engine(state, 2); aVirgin.music(true); } catch (e) { virginThrew = e; }
ok(virginThrew === null, 'dispose() before unlock() never throws');

sec('PROMISE + HUD SAFETY');
await new Promise(r => setTimeout(r, 250));
eq(HAR.unhandled, 0, 'unhandled promise rejections across the whole run (resume/close always reject here)');
const hud3 = hudMod.createHUD(hudRoot);
const scratch = node => node;
let nullThrew = null;
try { hud3.update(null, null); hud3.update(undefined); hud3.update({ racers: [] }, {}); hud3.showResults({}); hud3.setLap({}); hud3.showTitle({}); } catch (e) { nullThrew = e; }
ok(nullThrew === null, 'update(null)/empty state/showResults({}) never throw', nullThrew ? String(nullThrew) : '');
let audioNull = null;
try { const a = audioMod.createAudio(); a.engine(null, 0); a.play(null); a.play('boost', null); a.dispose(); } catch (e) { audioNull = e; }
ok(audioNull === null, 'audio.engine(null)/play(null) never throw');

// worst case: the page has none of the ids hud.js expects
const bareDoc = {
  _byId: new Map(),
  createElement: (t) => makeEl(bareDoc, t),
  createTextNode: (t) => ({ nodeType: 3, nodeValue: String(t), parentNode: null, get textContent() { return this.nodeValue; }, set textContent(v) { this.nodeValue = String(v); } }),
  getElementById: () => null,
};
const bareRoot = makeEl(bareDoc, 'div');
const bare = hudMod.createHUD(bareRoot);
let bareThrew = null;
try {
  bare.update(state, { playerIndex: 2, track: TRACK, speedKmh: 90, notifications: [{ text: 'X', cls: '' }], order: makeOrder([1, 2, 3, 4, 5, 6, 7, 8]) });
  bare.showResults({ order: [], playerIndex: 2, racers: [] });
  bare.setLap({ lap: 2, laps: 3 }); bare.hide(); bare.showTitle({ logo: 'x' }); bare.dispose();
} catch (e) { bareThrew = e; }
ok(bareThrew === null, 'missing HUD markup degrades to no-ops instead of throwing', bareThrew ? String(bareThrew) : '');

sec('SUMMARY');
console.log('  hud.js: 300 scripted frames -> ' + created300 + ' nodes created (event-driven only)');
console.log('  hud.js: 300 steady-state frames -> ' + createdFrozen + ' nodes created');
console.log('  hud.js: minimap redraws in the scripted 300 frames = ' + redraws300 + ' (cap 76); total=' + drawTotal + ', arcs=' + arcTotal);
console.log('  hud.js: worst-case #hud-notify children = ' + maxNotifyNodes + '; update cost = ' + (ms300 / 300).toFixed(3) + ' ms/frame');
console.log('  audio.js: voices muted = 0 (harness start() calls = 0), voices unmuted = ' + internalNow + ' (harness start() calls = ' + startsNow + ')');
console.log('  assertions: ' + pass + ' passed, ' + fail + ' failed');
if (fail) console.log('  FAILED: ' + failures.join(' | '));
console.log(fail === 0 ? '\nRESULT: ALL CHECKS PASSED' : '\nRESULT: FAILURES PRESENT');
process.exit(fail === 0 ? 0 : 1);
