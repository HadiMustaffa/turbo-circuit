// src/main.js — TURBO CIRCUIT: application shell, frame loop, race flow, test hook.
//
// This file is the glue and it is deliberately thin: it owns the clock, the app state
// machine (title → countdown → racing → results), input, audio routing and window.__game.
// It owns NO gameplay rules (that is sim.js) and NO drawing (render.js / hud.js).
//
// The sim runs at a fixed 60 Hz with an accumulator; rendering happens once per animation
// frame with an interpolation alpha between the last two ticks. See CONTRACTS.md §9.
import * as THREE from '../vendor/three.module.js';
import { SIM, RACE, CHARS, KARTS, TRACKS, PALETTE } from './content.js';
import { createInput, BIT, NO_INPUT } from './input.js';
import { createState, step, hashState, makeInputs, speedKmh, raceOrder } from './sim.js';
import { botInputs } from './ai.js';
import { buildTrack, TRACK_IDS } from './tracks.js';
import { createRenderer } from './render.js';
import { createHUD } from './hud.js';
import { createAudio } from './audio.js';

const Q = new URLSearchParams(location.search);
const num = (k, d) => (Q.has(k) ? Number(Q.get(k)) : d);
const flag = (k) => Q.get(k) === '1' || Q.get(k) === 'true';
const QUALITY = Q.get('quality') || (matchMedia('(pointer:coarse)').matches ? 'low' : 'high');

const canvas = document.getElementById('gl');
const overlay = document.getElementById('overlay');
const hudRoot = document.getElementById('hud');
const menuEl = document.getElementById('menu');
const cdEl = document.getElementById('countdown');
const loadingEl = document.getElementById('loading');

const input = createInput();
const audio = createAudio();
const hud = createHUD(hudRoot);
const renderer = createRenderer(canvas, { quality: QUALITY });

let track = null;
let state = null;
let playerIndex = num('player', 4);
let trackIndex = num('track', 0);
let charIndex = 0;
let cameraMode = Q.get('camera') || 'chase';
let appPhase = 'title';           // title | countdown | racing | results
let lastEvents = [];
let acc = 0;
let prev = 0;
let fps = 0, fpsAcc = 0, fpsN = 0;
let notifications = [];

// ─────────────────────────────────────────────────────────────── roster
// Slot i drives CHARS/KARTS[i], except the player's chosen character takes the player slot.
function roster(chosen = charIndex, bots = RACE.racerCount) {
  const chars = [];
  const karts = [];
  let c = 0;
  for (let i = 0; i < bots; i++) {
    if (i === playerIndex) { chars[i] = CHARS[chosen].id; karts[i] = KARTS[chosen].id; continue; }
    if (c === chosen) c++;
    chars[i] = CHARS[c % CHARS.length].id;
    karts[i] = KARTS[c % KARTS.length].id;
    c++;
  }
  return { chars, karts };
}

// ─────────────────────────────────────────────────────────────── race lifecycle
function newRace(opts = {}) {
  trackIndex = opts.track ?? (Q.has('track') ? num('track', 0) : trackIndex);
  track = buildTrack(trackIndex);
  const bots = Math.max(2, Math.min(RACE.racerCount, num('bots', RACE.racerCount)));
  const { chars, karts } = roster(charIndex, bots);
  state = createState({
    seed: opts.seed ?? num('seed', (Math.floor(Math.random() * 1e9) ^ 0x5f3759df) >>> 0),
    track, racerCount: bots, playerIndex, laps: num('laps', RACE.laps),
    mode: opts.mode || 'cup', chars, karts,
  });
  renderer.init(track, { chars, karts, playerIndex });
  renderer.setQuality(QUALITY);
  hud.hide(); hud.setLap({ lap: 1, laps: state.laps, playerIndex });
  hudRoot.classList.remove('hidden');
  overlay.classList.add('hidden');
  notifications = [];
  lastEvents = [];
  acc = 0;
  appPhase = 'countdown';
  audio.unlock();
  audio.music(true);
}

function startRace() {
  if (!state) newRace();
  appPhase = 'countdown';
}

function showResults() {
  appPhase = 'results';
  const order = raceOrder(state);
  hudRoot.classList.add('hidden');
  overlay.classList.remove('hidden');
  hud.showResults({
    order, playerIndex, racers: state.racers, laps: state.laps,
    trackName: track.name, chars: CHARS, points: state.mode === 'cup' ? RACE.pointsTable : null,
  });
  buildMenu({ results: true });
  audio.music(false);
}

function toTitle() {
  appPhase = 'title';
  hudRoot.classList.add('hidden');
  overlay.classList.remove('hidden');
  buildMenu({});
  audio.music(false);
}

// ─────────────────────────────────────────────────────────────── menu (main.js owns #overlay)
function buildMenu({ results = false } = {}) {
  menuEl.innerHTML = '';
  const btn = (label, fn, cls = '') => {
    const b = document.createElement('button');
    b.className = 'btn ' + cls; b.textContent = label; b.onclick = fn;
    menuEl.appendChild(b); return b;
  };
  if (results) {
    btn('RACE AGAIN', () => newRace({ track: trackIndex }));
    btn('NEXT CIRCUIT', () => newRace({ track: (trackIndex + 1) % TRACK_IDS.length }));
    btn('MAIN MENU', () => toTitle(), 'ghost');
    return;
  }
  // character strip
  const prevStrip = document.querySelectorAll('#overlay .card > div[data-strip]');
  prevStrip.forEach(n => n.remove());          // remove the old strip BEFORE adding the new one
  const strip = document.createElement('div');
  strip.setAttribute('data-strip', '1');
  strip.style.cssText = 'display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin:0 0 16px';
  CHARS.forEach((ch, i) => {
    const b = document.createElement('button');
    b.className = 'btn ghost' + (i === charIndex ? ' sel' : '');
    b.style.cssText = `padding:8px 12px;font-size:14px;border-color:${ch.colour};color:${ch.colour}`;
    b.textContent = ch.name;
    b.onclick = () => { charIndex = i; buildMenu({}); };
    strip.appendChild(b);
  });
  menuEl.parentElement.insertBefore(strip, menuEl);

  const chosen = CHARS[charIndex];
  const blurb = document.getElementById('title-blurb');
  if (blurb) blurb.textContent = `${chosen.name} — ${chosen.blurb}`;

  btn('🍄 GRAND PRIX', () => newRace({ track: 0, mode: 'cup' }));
  btn('⚡ TIME TRIAL', () => newRace({ track: trackIndex, mode: 'trial' }), 'ghost');
  TRACKS.forEach((t, i) => btn(t.name.toUpperCase(), () => newRace({ track: i, mode: 'cup' })));
}

// ─────────────────────────────────────────────────────────────── input → sim
function localBits() {
  if (flag('autopilot')) return null;
  if (STATE_FROZEN) return FROZEN_BITS;
  return input.bits();
}
let STATE_FROZEN = false;
let FROZEN_BITS = NO_INPUT;

function inputsFor() {
  const bits = botInputs(state);
  const arr = bits.length === state.racerCount ? bits : Array.from({ length: state.racerCount }, (_, i) => bits[i] || 0);
  const local = localBits();
  if (local !== null) arr[playerIndex] = local;
  return arr;
}

// ─────────────────────────────────────────────────────────────── HUD notifications
const NOTIFY = {
  lap: (e, r) => ({ text: `LAP ${Math.min(e.lap, r.laps)}/${r.laps}`, cls: '' }),
  finish: (e, r) => ({ text: `${ordinal(e.place).toUpperCase()}!`, cls: '' }),
  spinout: (e, r) => (e.racerId === playerIndex ? { text: 'SPUN OUT!', cls: 'small' } : null),
  respawn: (e, r) => (e.racerId === playerIndex ? { text: 'BACK ON TRACK', cls: 'small' } : null),
  drift: (e, r) => (e.racerId === playerIndex && e.tier >= 2 ? { text: e.tier === 3 ? 'SUPER MINI-TURBO' : 'MINI-TURBO', cls: 'small' } : null),
  hit: (e, r) => (e.racerId === playerIndex ? { text: 'HIT!', cls: 'small' } : null),
  pad: (e, r) => (e.racerId === playerIndex ? { text: 'BOOST PAD', cls: 'small' } : null),
};
function ordinal(n) { return n + (['th', 'st', 'nd', 'rd'][(n % 100 - n % 20 === 10 ? 0 : n % 10)] || 'th'); }

function consumeEvents() {
  if (!lastEvents.length) return;
  const evs = lastEvents.slice();
  for (const e of evs) {
    audio.play(e.type, e);
    const n = NOTIFY[e.type] ? NOTIFY[e.type](e, state) : null;
    if (n) notifications.push({ ...n, at: performance.now() });
  }
  if (notifications.length > 3) notifications = notifications.slice(-3);
  lastEvents = [];
}

// ─────────────────────────────────────────────────────────────── frame loop
function simStepOnce(bits) {
  for (const r of state.racers) { r._px = r.x; r._pz = r.z; r._ph = r.heading; r._py = r.y; }
  const inputs = bits || inputsFor();
  step(state, inputs);
  lastEvents = lastEvents.concat(state.events);
  state.events.length = 0;
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.25, (now - prev) / 1000) || 0; prev = now;
  fpsAcc += dt; fpsN++;
  if (fpsAcc >= 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }

  if (state) {
    const racing = appPhase === 'countdown' || appPhase === 'racing' || appPhase === 'results';
    if (racing && appPhase !== 'results') {
      acc += dt;
      let guard = 0;
      while (acc >= SIM.STEP && guard++ < SIM.MAX_STEPS_PER_FRAME) {
        simStepOnce();
        if (state.phase === 'finished' && appPhase === 'racing') { acc = 0; break; }
        acc -= SIM.STEP;
      }
      if (state.phase === 'countdown') appPhase = 'countdown';
      if (state.phase === 'racing') appPhase = 'racing';
      if (state.phase === 'finished') showResults();
    }
    // countdown digits are driven by the sim, not by a timer, so they cannot drift
    if (appPhase === 'countdown') {
      const n = Math.ceil(state.countdownTicks / 60);
      const label = n <= 0 ? 'GO!' : String(n);
      if (cdEl.textContent !== label) { cdEl.textContent = label; cdEl.classList.remove('on'); void cdEl.offsetWidth; cdEl.classList.add('on'); }
    } else if (cdEl.classList.contains('on')) { cdEl.classList.remove('on'); }

    consumeEvents();
    renderer.draw(state, state.phase === 'countdown' ? 0 : acc / SIM.STEP, {
      playerIndex, camera: cameraMode, dt, events: lastEvents, notifications,
    });
    if (appPhase !== 'results') {
      hud.update(state, {
        camera: renderer.camera, renderer, playerIndex, track,
        speedKmh: speedKmh(state.racers[playerIndex]), notifications,
        order: raceOrder(state),
      });
    }
    audio.engine(state, playerIndex);
    notifications = notifications.filter(n => performance.now() - n.at < 1900);
  } else {
    renderer.draw ? null : null;
  }
}

// ─────────────────────────────────────────────────────────────── keyboard app controls
addEventListener('keydown', (e) => {
  if (e.code === 'KeyR') { newRace({ track: trackIndex }); }
  else if (e.code === 'KeyM') { audio.setMuted(!audio.muted); }
  else if (e.code === 'Digit1') cameraMode = 'chase';
  else if (e.code === 'Digit2') cameraMode = 'far';
  else if (e.code === 'Digit3') cameraMode = 'orbit';
  else if (e.code === 'Escape') { if (appPhase === 'racing' || appPhase === 'countdown') toTitle(); }
});
if (matchMedia('(pointer:coarse)').matches) document.body.classList.add('touch');
addEventListener('resize', () => renderer.onResize(canvas.clientWidth, canvas.clientHeight));

// ─────────────────────────────────────────────────────────────── boot
input.attach(window);
renderer.onResize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);
loadingEl.classList.add('hidden');
buildMenu({});
cdEl.textContent = '';
newRace({ track: trackIndex });
if (flag('autostart')) appPhase = 'countdown'; else toTitle();

requestAnimationFrame(frame);

// ─────────────────────────────────────────────────────────────── test hook (CONTRACTS §9)
window.__game = {
  get state() { return state; },
  get track() { return track; },
  hash: () => hashState(state),
  info() {
    const r = state?.racers[playerIndex];
    if (state) renderer.syncCamera(state, 0, { playerIndex, camera: cameraMode, dt: SIM.STEP });
    const onScreen = state ? state.racers.filter(k => {
      const p = project(k.x, (k.y || 0) + 1, k.z);
      return p.visible && p.x > -40 && p.x < innerWidth + 40 && p.y > -40 && p.y < innerHeight + 40;
    }).length : 0;
    return {
      tick: state?.tick ?? 0,
      phase: state?.phase ?? 'none',
      appPhase,
      lap: r?.lap ?? 0,
      laps: state?.laps ?? 0,
      playerIndex,
      place: r?.place ?? 0,
      speedKmh: r ? speedKmh(r) : 0,
      item: r?.item ?? null,
      coins: r?.coins ?? 0,
      track: { id: track?.id, name: track?.name, length: track?.length },
      racers: state ? state.racers.map(k => ({
        id: k.id, place: k.place, lap: k.lap, s: +k.s.toFixed(2), speed: +k.speed.toFixed(2),
        x: +k.x.toFixed(2), z: +k.z.toFixed(2), item: k.item, drifring: k.driftTier,
      })) : [],
      finishedOrder: state?.finishedOrder ?? [],
      drawCalls: renderer.info?.calls ?? 0,
      triangles: renderer.info?.triangles ?? 0,
      fps: +fps.toFixed(1),
      charactersOnScreen: onScreen,
      renderer: canvas.getContext ? (renderer.info?.calls > 0 ? 'webgl' : 'none') : 'none',
      notifications: notifications.map(n => n.text),
      quality: QUALITY,
    };
  },
  hashState: () => hashState(state),
  newRace: (i, opts) => { newRace({ track: i ?? trackIndex, ...(opts || {}) }); return true; },
  start: () => { startRace(); return true; },
  step(n = 1, bits = null) {
    const arr = Array.isArray(bits) ? bits : null;
    for (let i = 0; i < n; i++) simStepOnce(arr ?? (bits == null ? null : Array.from({ length: state.racerCount }, () => bits)));
    consumeEvents();
    return state.tick;
  },
  setInput(bits) { STATE_FROZEN = bits != null; FROZEN_BITS = bits ?? NO_INPUT; return FROZEN_BITS; },
  press(action, ticks = 6) {
    const bit = BIT[String(action).toUpperCase()] ?? 0;
    STATE_FROZEN = true;
    FROZEN_BITS = bit;
    setTimeout(() => { STATE_FROZEN = false; }, Math.max(60, (ticks / 60) * 1000));
    return bit;
  },
  camera(m) { cameraMode = m; return cameraMode; },
  hud() { return hudRoot.innerText.replace(/\s+/g, ' ').trim(); },
  hudVisible: () => !hudRoot.classList.contains('hidden'),
  overlayText: () => overlay.innerText.replace(/\s+/g, ' ').trim(),
  audio: () => ({ muted: audio.muted, ctx: typeof AudioContext !== 'undefined' }),
  screenPos(id) {
    if (!state) return null;
    // sync the camera first: a headless driver may have stepped thousands of ticks without
    // drawing a frame, and the camera only moves inside draw()
    renderer.syncCamera(state, 0, { playerIndex, camera: cameraMode, dt: SIM.STEP });
    const r = state.racers[id];
    return project(r.x, (r.y || 0) + 1, r.z);
  },
  cameraMode: () => cameraMode,
  quality(q) { renderer.setQuality(q); return q; },
  palette: PALETTE,
};
window.__game.info.hash = hashState(state);

function project(x, y, z) {
  const v = new THREE.Vector3(x, y, z).project(renderer.camera);
  return {
    x: (v.x * 0.5 + 0.5) * innerWidth,
    y: (-v.y * 0.5 + 0.5) * innerHeight,
    visible: v.z > -1 && v.z < 1,
  };
}
