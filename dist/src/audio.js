// src/audio.js — TURBO CIRCUIT: every sound is synthesised at runtime. No files, no fetches.
// PRESENTATION team owns this file (CONTRACTS §1, §7, §11).
//
//   export function createAudio() -> { unlock, setMuted, muted, engine, play, music, dispose }
//
// Hard requirements this file is built around
//   * safe before unlock(), with no AudioContext, or with a suspended/blocked one;
//   * it NEVER throws and never leaves an unhandled promise rejection (headless Chrome with
//     --mute-audio is a real test target, so every WebAudio call is guarded);
//   * while muted it starts ZERO voices and creates no graph — provable through
//     stats().voices (see resetVoiceCounters());
//   * engine() is called 60x/s: it only assigns AudioParam .value, it never schedules events
//     and never allocates.
import { PHYSICS } from './content.js';

const TOP_KMH = ((PHYSICS && PHYSICS.topSpeed) || 26) * 3.6;
const REDLINE_KMH = Math.max(60, TOP_KMH * 1.5);

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const NOTE = (semi) => Math.pow(2, semi / 12);

const MUSIC = {
  bpm: 118,
  root: 110,                       // A2
  bass: [0, -5, 3, -2],            // one root per bar (minor-ish movement)
  arp: [0, 7, 12, 15, 12, 7, 3, 10],
};

// every event name in CONTRACTS §8, plus coin and explosion
const EVENT_NAMES = [
  'boost', 'drift', 'hop', 'pickup', 'roll', 'throw', 'hit', 'spinout', 'respawn',
  'pad', 'land', 'lap', 'finish', 'countdown', 'go', 'offroad', 'coin', 'explosion',
];

export function createAudio() {
  // ── state
  const voices = { total: 0, oneShot: 0, music: 0, bed: 0 };
  let ctx = null, master = null, comp = null, musicBus = null, noiseBuf = null;
  let graphReady = false, muted = false, disposed = false;
  let unlockWanted = false, lastError = null;
  let engineCalls = 0, playCalls = 0, mutedSkips = 0;
  let bed = null, screech = null, wind = null;
  let musicWanted = false, musicTimer = null, musicStep = 0, musicNext = 0;
  const smooth = { rev: 0, boost: 0, off: 0, screech: 0, wind: 0 };

  // ── primitives (all increments of voices.total represent one started source node)
  function now() { return ctx ? ctx.currentTime + 0.012 : 0; }

  function env(param, t0, attack, peak, dur) {
    const p = Math.max(0.0001, peak);
    try {
      param.setValueAtTime(0.0001, t0);
      param.exponentialRampToValueAtTime(p, t0 + Math.max(0.002, attack));
      param.exponentialRampToValueAtTime(0.0001, t0 + Math.max(attack + 0.01, dur));
    } catch (e) { try { param.value = p; } catch (e2) { /* ignore */ } }
  }

  function tone(dest, type, f0, t0, dur, peak, f1) {
    const o = ctx.createOscillator();
    o.type = type;
    try { o.frequency.setValueAtTime(Math.max(8, f0), t0); } catch (e) { /* ignore */ }
    if (f1 && f1 > 0 && f1 !== f0) {
      try { o.frequency.exponentialRampToValueAtTime(Math.max(8, f1), t0 + Math.max(0.02, dur)); } catch (e) { /* ignore */ }
    }
    const g = ctx.createGain();
    env(g.gain, t0, Math.min(0.012, dur * 0.25), peak, dur);
    o.connect(g); g.connect(dest);
    o.start(t0); o.stop(t0 + dur + 0.04);
    return o;
  }

  function hiss(dest, t0, dur, peak, type, f0, f1, q) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type || 'bandpass';
    try { f.frequency.setValueAtTime(Math.max(20, f0), t0); } catch (e) { /* ignore */ }
    try {
      if (f1 && f1 > 0 && f1 !== f0) f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + Math.max(0.02, dur));
    } catch (e) { /* ignore */ }
    try { f.Q.value = q || 1; } catch (e) { /* ignore */ }
    const g = ctx.createGain();
    env(g.gain, t0, Math.min(0.01, dur * 0.3), peak, dur);
    src.connect(f); f.connect(g); g.connect(dest);
    src.start(t0); src.stop(t0 + dur + 0.04);
    return src;
  }

  function sfx(type, f0, t0, dur, peak, f1) {
    voices.total++; voices.oneShot++;
    return tone(master, type, f0, t0, dur, peak, f1);
  }
  function sfxHiss(t0, dur, peak, type, f0, f1, q) {
    voices.total++; voices.oneShot++;
    return hiss(master, t0, dur, peak, type, f0, f1, q);
  }
  function musicTone(type, f0, t0, dur, peak, f1) {
    voices.total++; voices.music++;
    return tone(musicBus, type, f0, t0, dur, peak, f1);
  }
  function musicHiss(t0, dur, peak, type, f0, f1, q) {
    voices.total++; voices.music++;
    return hiss(musicBus, t0, dur, peak, type, f0, f1, q);
  }

  // ── graph construction (only ever runs when NOT muted)
  function buildNoise() {
    const sr = ctx.sampleRate || 44100;
    const len = Math.max(1024, Math.floor(sr * 2));
    noiseBuf = ctx.createBuffer(1, len, sr);
    const d = noiseBuf.getChannelData(0);
    let seed = 0x9e3779b9 >>> 0;                    // deterministic noise, no Math.random
    for (let i = 0; i < len; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      d[i] = (seed / 4294967296) * 2 - 1;
    }
  }

  function buildBeds() {
    // ── engine: two detuned oscillators + a sub, through a lowpass, plus intake grit
    const eGain = ctx.createGain(); eGain.gain.value = 0;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
    try { lp.Q.value = 3.4; } catch (e) { /* ignore */ }
    const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 42;
    const o2 = ctx.createOscillator(); o2.type = 'square'; o2.frequency.value = 63; o2.detune.value = 7;
    const o3 = ctx.createOscillator(); o3.type = 'sine'; o3.frequency.value = 21;
    const mix = ctx.createGain(); mix.gain.value = 0.32;
    o1.connect(mix); o2.connect(mix); o3.connect(mix);
    mix.connect(lp); lp.connect(eGain); eGain.connect(master);

    const grit = ctx.createGain(); grit.gain.value = 0;
    const gsrc = ctx.createBufferSource(); gsrc.buffer = noiseBuf; gsrc.loop = true;
    const hp = ctx.createBiquadFilter(); hp.type = 'bandpass'; hp.frequency.value = 1100;
    try { hp.Q.value = 0.9; } catch (e) { /* ignore */ }
    gsrc.connect(hp); hp.connect(grit); grit.connect(master);

    o1.start(); o2.start(); o3.start(); gsrc.start();
    voices.total += 4; voices.bed += 4;
    bed = { o1, o2, o3, gsrc, gain: eGain, lp, grit, hp };

    // ── tyre screech: looping noise through a narrow bandpass, gain follows the drift tier
    const sGain = ctx.createGain(); sGain.gain.value = 0;
    const sFilter = ctx.createBiquadFilter(); sFilter.type = 'bandpass';
    sFilter.frequency.value = 2400;
    try { sFilter.Q.value = 7.5; } catch (e) { /* ignore */ }
    const sSrc = ctx.createBufferSource(); sSrc.buffer = noiseBuf; sSrc.loop = true;
    sSrc.connect(sFilter); sFilter.connect(sGain); sGain.connect(master);
    sSrc.start();
    voices.total++; voices.bed++;
    screech = { src: sSrc, filter: sFilter, gain: sGain };

    // ── wind bed
    const wGain = ctx.createGain(); wGain.gain.value = 0.01;
    const wLp = ctx.createBiquadFilter(); wLp.type = 'lowpass'; wLp.frequency.value = 900;
    const wSrc = ctx.createBufferSource(); wSrc.buffer = noiseBuf; wSrc.loop = true;
    wSrc.connect(wLp); wLp.connect(wGain); wGain.connect(master);
    wSrc.start();
    voices.total++; voices.bed++;
    wind = { src: wSrc, filter: wLp, gain: wGain };
  }

  function ensure() {
    if (disposed) return false;
    if (graphReady) return true;
    if (muted) { unlockWanted = true; return false; }   // muted ⇒ build nothing, start nothing
    const AC = (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext))
      || (typeof AudioContext !== 'undefined' ? AudioContext : null)
      || (typeof globalThis !== 'undefined' && (globalThis.AudioContext || globalThis.webkitAudioContext))
      || null;
    if (!AC) { lastError = 'no AudioContext in this environment'; return false; }
    try {
      ctx = new AC({ latencyHint: 'interactive' });
      master = ctx.createGain();
      master.gain.value = 1;
      if (ctx.createDynamicsCompressor) {
        comp = ctx.createDynamicsCompressor();
        try {
          comp.threshold.value = -8; comp.knee.value = 12; comp.ratio.value = 6;
          comp.attack.value = 0.004; comp.release.value = 0.2;
        } catch (e) { /* ignore */ }
        master.connect(comp); comp.connect(ctx.destination);
      } else {
        master.connect(ctx.destination);
      }
      musicBus = ctx.createGain();
      musicBus.gain.value = 0.5;
      musicBus.connect(master);
      buildNoise();
      buildBeds();
      graphReady = true;
      lastError = null;
      return true;
    } catch (e) {
      lastError = String((e && e.message) || e);
      try { if (ctx && ctx.close) { const p = ctx.close(); if (p && p.catch) p.catch(() => {}); } } catch (e2) { /* ignore */ }
      ctx = null; master = null; comp = null; musicBus = null; noiseBuf = null;
      bed = null; screech = null; wind = null; graphReady = false;
      return false;
    }
  }

  // ── the one-shot table
  const ONESHOT = {
    boost: () => { const t = now(); sfx('sawtooth', 180, t, 0.5, 0.16, 900); sfxHiss(t, 0.45, 0.10, 'highpass', 600, 4200, 0.7); },
    drift: (o) => {
      const t = now();
      const tier = Math.max(1, Math.min(3, ((o && o.tier) | 0) || 1));
      sfxHiss(t, 0.18, 0.05 + tier * 0.02, 'bandpass', 2400 + tier * 500, 1500, 6);
      sfx('square', 300 + tier * 120, t, 0.07, 0.05);
    },
    hop: () => { const t = now(); sfx('sine', 380, t, 0.1, 0.08, 720); },
    pickup: () => { const t = now(); sfx('square', 660, t, 0.07, 0.07); sfx('square', 990, t + 0.07, 0.09, 0.07); },
    roll: () => { const t = now(); for (let i = 0; i < 3; i++) sfx('square', 700 + i * 90, t + i * 0.045, 0.03, 0.05); },
    throw: () => { const t = now(); sfx('triangle', 320, t, 0.26, 0.10, 120); sfxHiss(t, 0.3, 0.07, 'bandpass', 1600, 400, 1.2); },
    hit: () => { const t = now(); sfxHiss(t, 0.22, 0.16, 'lowpass', 2600, 300, 0.8); sfx('sine', 150, t, 0.24, 0.16, 60); },
    spinout: () => { const t = now(); sfx('sawtooth', 700, t, 0.6, 0.11, 90); sfxHiss(t, 0.6, 0.06, 'bandpass', 900, 260, 2); },
    respawn: () => { const t = now(); sfx('sine', 220, t, 0.34, 0.11, 880); sfx('triangle', 440, t + 0.05, 0.3, 0.06, 1200); },
    pad: () => { const t = now(); sfx('square', 320, t, 0.24, 0.10, 1250); sfxHiss(t, 0.22, 0.06, 'highpass', 900, 3600, 0.7); },
    land: () => { const t = now(); sfx('sine', 110, t, 0.16, 0.14, 55); sfxHiss(t, 0.1, 0.06, 'lowpass', 900, 200, 0.8); },
    lap: () => { const t = now(); sfx('sine', 880, t, 0.12, 0.11); sfx('sine', 1320, t + 0.12, 0.22, 0.10); },
    finish: () => {
      const t = now();
      const seq = [0, 4, 7, 12];
      for (let i = 0; i < seq.length; i++) sfx('triangle', 440 * NOTE(seq[i]), t + i * 0.13, 0.32, 0.10);
    },
    countdown: (o) => { const t = now(); const n = (o && o.n) | 0; sfx('square', 380 + Math.max(0, 3 - n) * 40, t, 0.16, 0.11); },
    go: () => { const t = now(); sfx('square', 880, t, 0.36, 0.13); sfx('sine', 1760, t + 0.02, 0.3, 0.07); },
    offroad: () => { const t = now(); sfxHiss(t, 0.18, 0.05, 'lowpass', 700, 260, 1.2); },
    coin: () => { const t = now(); sfx('sine', 988, t, 0.06, 0.10); sfx('sine', 1319, t + 0.06, 0.2, 0.09); },
    explosion: () => { const t = now(); sfxHiss(t, 0.7, 0.2, 'lowpass', 1800, 90, 0.6); sfx('sine', 90, t, 0.6, 0.18, 40); },
  };

  // ── procedural music: bass on the beat, arpeggio on the off-8ths, hat on the up-beats
  function scheduleStep(i, t) {
    const bar = (i >> 3) & 3;
    const stepDur = 60 / MUSIC.bpm / 2;
    if (i % 4 === 0) musicTone('triangle', MUSIC.root * NOTE(MUSIC.bass[bar]), t, 0.5, 0.13);
    musicTone('square', MUSIC.root * 4 * NOTE(MUSIC.arp[i & 7]), t, stepDur * 0.7, 0.042);
    if (i % 2 === 1) musicHiss(t, 0.06, 0.03, 'highpass', 6500, 6500, 0.8);
  }
  function musicPump() {
    if (disposed || muted || !graphReady) return;
    try {
      const stepDur = 60 / MUSIC.bpm / 2;
      let guard = 0;
      while (musicNext < ctx.currentTime + 0.25 && guard++ < 16) {
        scheduleStep(musicStep++, musicNext);
        musicNext += stepDur;
      }
    } catch (e) { lastError = String((e && e.message) || e); }
  }
  function startMusic() {
    musicWanted = true;
    if (disposed || muted) return false;
    if (!ensure()) return false;
    if (musicTimer) return true;
    musicStep = 0;
    musicNext = ctx.currentTime + 0.06;
    musicTimer = setInterval(musicPump, 40);
    if (musicTimer && musicTimer.unref) musicTimer.unref();   // never hold a Node process open
    return true;
  }
  function stopMusic() {
    if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
  }

  // ── public API
  function unlock() {
    if (disposed) return false;
    unlockWanted = true;
    if (muted) return false;                    // muted: nothing is built, nothing starts
    if (!ensure()) return false;
    try {
      if (ctx.state !== 'running' && ctx.resume) {
        const p = ctx.resume();
        if (p && p.catch) p.catch(() => { /* autoplay policy / headless: silent, never unhandled */ });
      }
    } catch (e) { lastError = String((e && e.message) || e); }
    if (musicWanted) startMusic();
    return true;
  }

  function setMuted(b) {
    muted = !!b;
    if (disposed) return muted;
    if (muted) {
      stopMusic();
      if (master && ctx) {
        try {
          const t = ctx.currentTime;
          master.gain.cancelScheduledValues(t);
          master.gain.setTargetAtTime(0, t, 0.02);
        } catch (e) { lastError = String((e && e.message) || e); }
      }
    } else {
      if (master && ctx && master.gain && master.gain.setTargetAtTime) {
        try { master.gain.setTargetAtTime(1, ctx.currentTime, 0.02); } catch (e) { /* ignore */ }
      }
      if (unlockWanted) unlock();
      if (musicWanted) startMusic();
    }
    return muted;
  }

  function engine(state, playerIndex) {
    engineCalls++;
    if (disposed || muted || !graphReady || !bed) return false;
    // A context that boots before any user gesture stays 'suspended' until something calls
    // resume() from a task after the gesture. main.js only unlocks on newRace(), so a player who
    // only ever presses the arrow keys would stay silent — retry here, at most once every 30
    // frames, and swallow the (often never-settling) promise.
    if (ctx.state !== 'running' && ctx.resume && (engineCalls % 30) === 1) {
      try {
        const p = ctx.resume();
        if (p && p.catch) p.catch(() => { /* autoplay policy: stay silent, never unhandled */ });
      } catch (e) { /* ignore */ }
    }
    const r = (state && state.racers) ? state.racers[playerIndex | 0] : null;
    const kmh = r ? Math.abs(r.speed || 0) * 3.6 : 0;
    const revTarget = clamp01(kmh / REDLINE_KMH);
    const boostTarget = (r && (r.boostTicks | 0) > 0) ? 1 : 0;
    const offTarget = (r && r.offTrack) ? 1 : 0;

    smooth.rev += (revTarget - smooth.rev) * 0.18;
    smooth.boost += (boostTarget - smooth.boost) * 0.25;
    smooth.off += (offTarget - smooth.off) * 0.08;
    const rev = smooth.rev, bst = smooth.boost, off = smooth.off;

    try {
      const rpm = 34 + rev * 152 + bst * 26;
      bed.o1.frequency.value = rpm;
      bed.o2.frequency.value = rpm * 1.5;
      bed.o3.frequency.value = rpm * 0.5;
      bed.lp.frequency.value = Math.max(160, 260 + rev * 2600 + bst * 1200 - off * 200);
      bed.gain.gain.value = (0.030 + rev * 0.075 + bst * 0.050) * (1 - off * 0.45);
      bed.grit.gain.value = (0.004 + rev * 0.030 + bst * 0.045) * (1 - off * 0.5);

      const tier = r ? Math.max(0, Math.min(3, r.driftTier | 0)) : 0;
      const screechTarget = tier > 0 ? (0.030 + (tier - 1) * 0.035) : 0;
      smooth.screech += (screechTarget - smooth.screech) * 0.2;
      screech.gain.gain.value = smooth.screech;
      screech.filter.frequency.value = 1700 + clamp01(r && r.driftCharge ? r.driftCharge / 2.4 : 0) * 1500;

      const windTarget = 0.008 + rev * 0.045 + bst * 0.020;
      smooth.wind += (windTarget - smooth.wind) * 0.08;
      wind.gain.gain.value = smooth.wind;
    } catch (e) { lastError = String((e && e.message) || e); return false; }
    return true;
  }

  function play(name, opts) {
    playCalls++;
    if (disposed || muted) { mutedSkips++; return false; }
    const fn = ONESHOT[name];
    if (!fn) return false;
    if (!ensure()) return false;
    try {
      if (ctx.state === 'closed') return false;
      if (ctx.state !== 'running' && ctx.resume) {
        const p = ctx.resume();
        if (p && p.catch) p.catch(() => { /* ignore */ });
      }
      fn(opts || {});
      return true;
    } catch (e) {
      lastError = String((e && e.message) || e);
      return false;
    }
  }

  function music(on) {
    if (disposed) return false;
    on = !!on;
    musicWanted = on;
    if (!on) { stopMusic(); return false; }
    return startMusic();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    stopMusic();
    try {
      const srcs = [];
      if (bed) { srcs.push(bed.o1, bed.o2, bed.o3, bed.gsrc); }
      if (screech) srcs.push(screech.src);
      if (wind) srcs.push(wind.src);
      for (const s of srcs) if (s && s.stop) s.stop();
    } catch (e) { /* ignore */ }
    try {
      if (ctx && ctx.close) {
        const p = ctx.close();
        if (p && p.catch) p.catch(() => { /* ignore */ });
      }
    } catch (e) { /* ignore */ }
    ctx = null; master = null; comp = null; musicBus = null; noiseBuf = null;
    bed = null; screech = null; wind = null; graphReady = false;
  }

  const api = {
    // `muted` is a real property on the returned object (a getter/setter pair)
    get muted() { return muted; },
    set muted(v) { setMuted(v); },
    unlock,
    setMuted,
    engine,
    play,
    music,
    dispose,
    // ── extras beyond the frozen signature: test hooks + introspection. They add nothing to
    //    the API surface the game uses, they just make the mute guarantee measurable.
    stats() {
      return {
        voices: { total: voices.total, oneShot: voices.oneShot, music: voices.music, bed: voices.bed },
        muted, disposed, graphReady,
        ctxState: ctx ? ctx.state : 'none',
        engineCalls, playCalls, mutedSkips,
        eventNames: EVENT_NAMES.slice(),
        lastError,
      };
    },
    resetVoiceCounters() {
      voices.total = voices.oneShot = voices.music = voices.bed = 0;
      engineCalls = 0; playCalls = 0; mutedSkips = 0;
      return voices.total;
    },
  };
  return api;
}
