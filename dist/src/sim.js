// src/sim.js — TURBO CIRCUIT: the deterministic simulation core.
//
// ─── THE THREE RULES OF THIS FILE, DO NOT BREAK THEM ──────────────────────────────
//   1. FIXED TIMESTEP ONLY. step(state, inputs) advances exactly SIM.STEP seconds.
//   2. NO CLOCK, NO Math.random(). All randomness comes from state.rng (seeded, in-state).
//   3. NO DOM. No document, no window, no canvas. This file runs in Node, in the browser,
//      and — unchanged — as an authoritative multiplayer server.
// Those three rules are why the tests can prove the game is fair, and why client-side
// prediction for online play is an extension rather than a rewrite.
//
// Units are SI: metres, m/s, seconds. Y is up. heading 0 points along +Z, and increasing
// heading turns LEFT (forward = (sin h, cos h); left of travel = (cos h, -sin h)).
import {
  SIM, PHYSICS, RACE, CHARS, KARTS, ITEMS, AI, rollItem,
} from './content.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
function wrapAngle(a) { a %= TAU; if (a > Math.PI) a -= TAU; if (a < -Math.PI) a += TAU; return a; }
function approachAngle(a, b, maxStep) {
  const d = wrapAngle(b - a);
  if (Math.abs(d) <= maxStep) return b;
  return wrapAngle(a + Math.sign(d) * maxStep);
}
const dist2 = (ax, az, bx, bz) => (ax - bx) * (ax - bx) + (az - bz) * (az - bz);

// Kart bodies are not just paint: the silhouette changes the handling, which is what makes
// picking a character + kart a real decision rather than a colour swap.
const SHAPE_MOD = {
  wedge:    { speed: +0.05, handling: -0.07, weight: 0.00 },
  teardrop: { speed: -0.01, handling: +0.07, weight: -0.02 },
  boxy:     { speed: -0.02, handling: -0.02, weight: +0.09 },
};

// stat slider (1..5) → multiplier
const statMul = (v, lo, hi) => lo + ((clamp(v, 1, 5) - 1) / 4) * (hi - lo);

function makeRng(seed) {
  const o = {
    s: (seed >>> 0) || 0x9E3779B9,
    next() {
      let x = o.s;
      x ^= (x << 13); x >>>= 0;
      x ^= (x >>> 17);
      x ^= (x << 5); x >>>= 0;
      o.s = x || 0x9E3779B9;
      return o.s / 4294967296;
    },
  };
  return o;
}

export const makeInputs = (n) => new Array(n).fill(0);
export const speedKmh = (racer) => racer.speed * 3.6;

// How fast THIS kart can hold THIS corner before its tyres give up. The AI needs it to brake
// like a real driver (down to its own grip limit, not to a fixed number), and the sim needs it
// to police the corner. Exported so there is exactly one definition of it.
export function cornerLimitFor(state, racer, atS) {
  const n = state.track.sampleCount;
  const idx = ((Math.round((atS ?? racer.s) / state.track.spacing) % n) + n) % n;
  const curv = Math.abs(state.track.samples[idx].curvature);
  const mul = statMul(racer.stats.handling, PHYSICS.corner.gripMul[0], PHYSICS.corner.gripMul[1]) * racer.stats.massTurn;
  let lim = curv > 1e-5 ? Math.sqrt(PHYSICS.corner.grip * mul / curv) : Infinity;
  if (racer.driftActive) lim *= PHYSICS.corner.driftBonus;
  return Math.max(PHYSICS.corner.minLimit, lim);
}

// ─────────────────────────────────────────────────────────── create
export function createState(opts = {}) {
  const track = opts.track;
  if (!track) throw new Error('createState needs a built track (see tracks.js buildTrack)');
  const racerCount = clamp(opts.racerCount || RACE.racerCount, 2, 8);
  const laps = opts.laps || track.laps || RACE.laps;
  const playerIndex = clamp(opts.playerIndex ?? 0, 0, racerCount - 1);
  const chars = opts.chars || CHARS.slice(0, racerCount).map(c => c.id);
  const karts = opts.karts || KARTS.slice(0, racerCount).map(k => k.id);
  const seed = (opts.seed ?? 1) >>> 0;

  const state = {
    tick: 0,
    phase: 'countdown',
    countdownTicks: RACE.countdownTicks,
    _cdSecond: Math.ceil(RACE.countdownTicks / 60) + 1,
    seed,
    rng: makeRng(seed),
    track, trackIndex: track.index, length: track.length,
    racerCount, laps,
    playerIndex, mode: opts.mode || 'cup',
    playerBot: !!opts.playerBot,          // headless races drive the player's slot with the bot brain
    hazardScale: opts.hazardScale ?? 1,   // tests use this to widen or narrow item lethality
    racers: [],
    items: [],
    pickups: [],
    coins: [],
    events: [],
    finishedOrder: [],
    raceTicks: 0,
    _nextItemId: 1,
  };

  for (let i = 0; i < racerCount; i++) {
    const charDef = CHARS.find(c => c.id === chars[i]) || CHARS[i % CHARS.length];
    const kartDef = KARTS.find(k => k.id === karts[i]) || KARTS[i % KARTS.length];
    const shape = SHAPE_MOD[kartDef.shape] || SHAPE_MOD.wedge;
    const cs = charDef.stats;
    // Mass is a real trade, not a free bonus: a heavy kart shoves others aside but pays for it
    // in acceleration and cornering grip.
    const massAccel = 1 - (cs.weight - 3) * 0.028;
    const R = PHYSICS.statRange;
    const stats = {
      topSpeed: PHYSICS.topSpeed * statMul(cs.speed, R.topSpeed[0], R.topSpeed[1]) * (1 + shape.speed),
      accel: PHYSICS.accel * statMul(cs.accel, R.accel[0], R.accel[1]) * (1 + shape.speed * 0.5) * massAccel,
      steerRate: PHYSICS.steerRate * statMul(cs.handling, R.steerRate[0], R.steerRate[1]) * (1 + shape.handling),
      weight: cs.weight + shape.weight * 5,
      handling: cs.handling,
      massTurn: 1 - (cs.weight - 3) * 0.04,
      speedStat: cs.speed,
      accelStat: cs.accel,
    };
    const slot = track.gridSlots[i % track.gridSlots.length];
    const pr = track.progressAt(slot.x, slot.z);
    state.racers.push({
      id: i, name: charDef.name, charId: charDef.id, kartId: kartDef.id, isPlayer: i === playerIndex,
      cpu: i !== playerIndex,
      x: slot.x, y: slot.y, z: slot.z, heading: slot.heading,
      speed: 0, vx: 0, vz: 0,
      s: pr.s, lateral: pr.lateral, lap: 1, place: i + 1,
      progress: pr.s, prevProgress: pr.s, prevS: pr.s,
      progressBase: -track.length,        // progress 0 is the start line; the grid is behind it
      _preStart: true,                    // the first crossing starts the race, it does not end a lap
      _armed: true,
      surface: 'road', offTrack: false,
      stats,
      driftDir: 0, driftActive: false, driftCharge: 0, driftTier: 0, hopTicks: 0,
      boostTicks: 0, boostKind: null, boostAdd: 0, miniTurboTicks: 0,
      spinTicks: 0, squashTicks: 0, respawnTicks: 0, inkTicks: 0, pulseTicks: 0, overdriveTicks: 0,
      bogTicks: 0,
      item: null, itemRollTicks: 0, itemUses: 0,
      coins: 0, slipstreamTicks: 0, slipstreamAdd: 0,
      airborne: false, vy: 0, groundY: slot.y,
      rocketStart: null, finished: false, finishTick: 0, totalTicks: 0,
      prevBits: 0, steerInput: 0, wheelSpin: 0,
      stuckTicks: 0, stuckRef: pr.s, wrongWayTicks: 0,
      _px: slot.x, _py: slot.y, _pz: slot.z, _ph: slot.heading,
      ai: {
        line: ((i * 0.37) % 1), skill: AI.skill[i % AI.skill.length],
        aggression: AI.aggression[i % AI.aggression.length],
        jitterPhase: i * 1.7, itemHold: 0, stuckTicks: 0, avoid: 0,
      },
    });
  }

  // item boxes with a PER-RACER cooldown. A single global cooldown starves the field:
  // the leader reaches every box first (measured 31 pickups vs 4 in a previous project).
  for (let b = 0; b < track.itemBoxes.length; b++) {
    const box = track.itemBoxes[b];
    const cd = new Int32Array(racerCount);
    state.pickups.push({ id: b, x: box.x, y: box.y, z: box.z, s: box.s, cooldowns: cd, spin: 0 });
  }
  for (let c = 0; c < track.coins.length; c++) {
    const coin = track.coins[c];
    state.coins.push({ id: c, x: coin.x, y: coin.y, z: coin.z, taken: new Int32Array(racerCount), spin: 0 });
  }

  // places from the grid
  recomputePlaces(state);
  return state;
}

// ─────────────────────────────────────────────────────────── helpers
function emit(state, type, racerId, extra) {
  state.events.push(Object.assign({ type, racerId, tick: state.tick }, extra || {}));
}

function surfaceInfo(state, racer) {
  const pr = state.track.progressAt(racer.x, racer.z);
  const surface = state.track.surfaceOf(pr);
  return { pr, surface };
}

function applyBoost(state, racer, add, ticks, kind) {
  if (add >= racer.boostAdd || racer.boostTicks <= 0) racer.boostAdd = add;
  racer.boostTicks = Math.max(racer.boostTicks, ticks);
  racer.boostKind = kind;
  emit(state, 'boost', racer.id, { kind, x: racer.x, z: racer.z, add });
}

function spinOut(state, racer, item, byId) {
  if (racer.overdriveTicks > 0) return false;          // invincible
  racer.spinTicks = Math.max(racer.spinTicks, (item && item.hit && item.hit.spinTicks) || PHYSICS.spinOut.ticks);
  racer.speed *= (item && item.hit && item.hit.speedMul) || PHYSICS.spinOut.speedMul;
  racer.boostTicks = 0; racer.boostAdd = 0;
  racer.driftActive = false; racer.driftDir = 0; racer.driftCharge = 0; racer.driftTier = 0;
  if (racer.coins > 0) racer.coins = Math.max(0, racer.coins - RACE.coins.loseOnHit);
  emit(state, 'hit', racer.id, { byId: byId ?? null, item: item ? item.kind : null, x: racer.x, z: racer.z });
  emit(state, 'spinout', racer.id, { x: racer.x, z: racer.z });
  return true;
}

function respawn(state, racer, reason) {
  const p = state.track.pointAt(racer.s - RACE.respawnAheadMetres);
  racer.x = p.x; racer.z = p.z; racer.y = state.track.y(p.x, p.z) + PHYSICS.respawn.dropHeight;
  racer.groundY = state.track.y(p.x, p.z);
  racer.heading = Math.atan2(p.tx, p.tz);
  racer.speed = 0; racer.spinTicks = 0; racer.airborne = false; racer.vy = 0;
  racer.respawnTicks = PHYSICS.respawn.ticks;
  racer.driftActive = false; racer.driftDir = 0; racer.driftCharge = 0; racer.driftTier = 0;
  racer.stuckTicks = 0; racer.stuckRef = racer.s; racer.wrongWayTicks = 0;
  emit(state, 'respawn', racer.id, { reason: reason || 'stuck', x: racer.x, z: racer.z });
}

function spawnItem(state, owner, kind) {
  const def = ITEMS[kind] || {};
  const fwdX = Math.sin(owner.heading), fwdZ = Math.cos(owner.heading);
  const leftX = Math.cos(owner.heading), leftZ = -Math.sin(owner.heading);
  let x = owner.x, z = owner.z, vx = 0, vz = 0, targetId = null;
  if (def.spawn === 'forward') {
    x += fwdX * 2.6; z += fwdZ * 2.6;
    vx = fwdX * def.speed; vz = fwdZ * def.speed;
    if (def.homing) {
      // home on the nearest racer ahead of the owner; no target = straight shot
      let best = null, bestD = Infinity;
      for (const r of state.racers) {
        if (r.id === owner.id) continue;
        const ahead = r.progress - owner.progress;
        if (ahead <= 0 || ahead > 260) continue;
        const d = dist2(owner.x, owner.z, r.x, r.z);
        if (d < bestD) { bestD = d; best = r; }
      }
      targetId = best ? best.id : null;
    }
  } else if (def.spawn === 'behind') {
    x -= fwdX * 3.2; z -= fwdZ * 3.2;
  } else if (def.dropBehind) {
    x -= fwdX * def.dropBehind; z -= fwdZ * def.dropBehind;
  }
  const item = {
    id: state._nextItemId++, kind, x, y: state.track.y(x, z) + 0.5, z, vx, vz,
    ownerId: owner.id, targetId, spin: 0,
    ticksLeft: def.lifeTicks || def.selfTicks || def.inkTicks || 120,
    state: 'active', armed: 0,
  };
  state.items.push(item);
  emit(state, 'throw', owner.id, { item: kind, x, z });
  return item;
}

function useItem(state, racer) {
  const kind = racer.item;
  if (!kind) return;
  const def = ITEMS[kind] || {};
  if (def.schedule) { /* reserved */ }
  if (kind === 'pulse') {
    // a delayed global wave: everyone else spins
    state.items.push({
      id: state._nextItemId++, kind, x: racer.x, y: racer.y, z: racer.z, vx: 0, vz: 0,
      ownerId: racer.id, targetId: null, spin: 0, ticksLeft: def.delayTicks,
      state: 'pending', armed: 1,
    });
    emit(state, 'throw', racer.id, { item: kind, x: racer.x, z: racer.z });
  } else if (kind === 'overdrive') {
    racer.overdriveTicks = def.selfTicks;
    racer.boostAdd = def.speedAdd; racer.boostTicks = def.selfTicks; racer.boostKind = 'overdrive';
    emit(state, 'throw', racer.id, { item: kind, x: racer.x, z: racer.z });
    emit(state, 'boost', racer.id, { kind: 'overdrive', x: racer.x, z: racer.z, add: def.speedAdd });
  } else if (kind === 'ink') {
    const ahead = state.racers
      .filter(r => r.id !== racer.id && r.progress > racer.progress && !r.finished)
      .sort((a, b) => a.progress - b.progress)
      .slice(0, def.targetsAhead);
    for (const r of ahead) r.inkTicks = Math.max(r.inkTicks, def.inkTicks);
    emit(state, 'throw', racer.id, { item: kind, x: racer.x, z: racer.z, targets: ahead.length });
  } else if (kind === 'nitro' || kind === 'nitro3') {
    applyBoost(state, racer, def.speedAdd, def.boostTicks, kind);
    emit(state, 'throw', racer.id, { item: kind, x: racer.x, z: racer.z });
  } else {
    spawnItem(state, racer, kind);
  }
  // triple nitro keeps the item until its uses run out
  const uses = def.uses || 1;
  if (uses > 1) {
    racer.itemUses -= 1;
    if (racer.itemUses <= 0) { racer.item = null; racer.itemUses = 0; }
  } else {
    racer.item = null; racer.itemUses = 0;
  }
}

function giveItem(state, racer) {
  const roll = rollItem(racer.place, state.racerCount, state.rng.next());
  racer.item = roll;
  racer.itemUses = (ITEMS[roll] && ITEMS[roll].uses) || 1;
  racer.itemRollTicks = 42;
  emit(state, 'pickup', racer.id, { item: roll, x: racer.x, z: racer.z });
}

function recomputePlaces(state) {
  const order = state.racers.slice().sort((a, b) => {
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    if (a.finished && b.finished) return a.finishTick - b.finishTick;
    return b.progress - a.progress;
  });
  for (let i = 0; i < order.length; i++) {
    const r = order[i];
    if (r.place !== i + 1) emit(state, 'place', r.id, { place: i + 1, was: r.place });
    r.place = i + 1;
  }
  return order;
}

export function raceOrder(state) {
  return state.racers.slice().sort((a, b) => a.place - b.place).map(r => ({
    id: r.id, name: r.name, place: r.place, lap: r.lap, s: r.s,
    finished: r.finished, totalTicks: r.totalTicks, place_: r.place,
    charId: r.charId, coins: r.coins, finishedAt: r.finishTick,
  }));
}

export function standingsPoints(state) {
  return raceOrder(state).map(r => ({ id: r.id, place: r.place, points: RACE.pointsTable[r.place - 1] ?? 0 }));
}

// ─────────────────────────────────────────────────────────── the tick
export function step(state, inputs) {
  state.tick++;
  if (state.phase === 'countdown') { stepCountdown(state, inputs); return; }
  if (state.phase === 'finished') { state.events.length = state.events.length; return; }
  state.raceTicks++;

  stepRacers(state, inputs);
  stepPickups(state);
  stepCoins(state);
  stepItems(state);
  stepCollisions(state);
  stepPlacesAndFinish(state);
}

function stepCountdown(state, inputs) {
  const cdt = state.countdownTicks - 1;
  state.countdownTicks = cdt;
  for (const r of state.racers) {
    const bits = inputs[r.id] | 0;
    const held = (bits & 1) !== 0;                       // ACCEL
    // Perfect start: throttle pressed inside the last PHYSICS.rocketStart.perfectFrom seconds.
    // Holding it from the very beginning bogs the engine — a real (and funny) penalty.
    if (held) {
      const secondsLeft = cdt / 60;
      if (state.rocketWindow === undefined) state.rocketWindow = PHYSICS.rocketStart.countdown - PHYSICS.rocketStart.perfectFrom;
      if (secondsLeft <= PHYSICS.rocketStart.countdown && r.rocketStart === null) {
        r.rocketStart = secondsLeft <= PHYSICS.rocketStart.perfectFrom ? 'perfect' : 'early';
      }
    }
    r.prevBits = bits;
  }
  const sec = Math.ceil(cdt / 60);
  if (sec !== state._cdSecond) {
    state._cdSecond = sec;
    if (sec > 0) emit(state, 'countdown', null, { n: sec });
  }
  if (cdt <= 0) {
    state.phase = 'racing';
    emit(state, 'go', null, {});
    for (const r of state.racers) {
      if (r.rocketStart === 'perfect') applyBoost(state, r, 9.0, PHYSICS.rocketStart.perfectBoostTicks, 'rocket');
      else if (r.rocketStart === 'early') r.bogTicks = PHYSICS.rocketStart.bogTicks;
      r.rocketStart = r.rocketStart || 'none';
    }
  }
}

function stepRacers(state, inputs) {
  const track = state.track;
  const leader = state.racers.reduce((a, b) => (b.progress > a.progress ? b : a), state.racers[0]);

  for (const r of state.racers) {
    const bits = inputs[r.id] | 0;
    const go = (bits & 1) !== 0, brake = (bits & 2) !== 0;
    const left = (bits & 4) !== 0, right = (bits & 8) !== 0;
    const driftHeld = (bits & 16) !== 0, itemPressed = (bits & 32) !== 0;
    const steer = (left ? 1 : 0) - (right ? 1 : 0);       // +1 = left (heading increases)

    // ── timers
    if (r.spinTicks > 0) r.spinTicks--;
    if (r.squashTicks > 0) r.squashTicks--;
    if (r.respawnTicks > 0) { r.respawnTicks--; r.speed = 0; }
    if (r.inkTicks > 0) r.inkTicks--;
    if (r.pulseTicks > 0) r.pulseTicks--;
    if (r.overdriveTicks > 0) r.overdriveTicks--;
    if (r.hopTicks > 0) r.hopTicks--;
    if (r.itemRollTicks > 0) {
      r.itemRollTicks--;
      if (r.itemRollTicks === 0) emit(state, 'roll', r.id, { item: r.item });
    }
    const boosting = r.boostTicks > 0;
    if (boosting) { r.boostTicks--; if (r.boostTicks === 0) { r.boostAdd = 0; r.boostKind = null; } }

    const frozen = r.spinTicks > 0 || r.respawnTicks > 0 || r.pulseTicks > 0;

    // ── surface + progress
    const { pr, surface } = surfaceInfo(state, r);
    const prevS = r.s;
    r.s = pr.s; r.lateral = pr.lateral; r.surface = surface;
    r.offTrack = surface === 'grass';

    const surf = PHYSICS.surface[surface] || PHYSICS.surface.road;

    // ── lap counting. Crossing the line FORWARD is the only thing that counts, and the very
    //    first crossing is the start of lap 1 (the grid sits behind the line, so counting it
    //    would silently shorten the race by a whole lap). `_armed` additionally stops a kart
    //    farming laps by reversing back over the line. `progressBase` keeps `progress`
    //    continuous across a wrap — without it, place order snaps backwards at the line.
    const L = state.length;
    if (prevS > L * 0.75 && r.s < L * 0.25) {
      r.progressBase += L;
      if (r._preStart) {
        r._preStart = false;
        emit(state, 'lap', r.id, { lap: 1 });
      } else if (r._armed) {
        r.lap++;
        emit(state, 'lap', r.id, { lap: r.lap });
        if (r.lap > state.laps && !r.finished) {
          r.finished = true; r.finishTick = state.tick; r.totalTicks = state.raceTicks;
          state.finishedOrder.push(r.id);
          emit(state, 'finish', r.id, { place: state.finishedOrder.length });
        }
      }
    } else if (prevS < L * 0.25 && r.s > L * 0.75) {
      r._armed = false;                       // reversed over the line: disarmed until they come back
    } else if (r.s > L * 0.5) {
      r._armed = true;                        // half a lap done: armed for the next crossing
    }
    r.prevS = prevS;
    r.progress = r.progressBase + r.s;

    if (r.finished) {
      // coast to a stop after the flag, but keep them driving so the field can finish
      r.speed *= Math.exp(-1.2 * SIM.STEP);
      integrate(state, r, steer, PHYSICS.STEP);
      continue;
    }

    // ── steering
    if (frozen) {
      r.speed *= Math.exp(-1.6 * SIM.STEP);
      r.heading = wrapAngle(r.heading + PHYSICS.spinOut.spinRate * SIM.STEP * sign(r.spinTicks || 1));
      integrate(state, r, 0, SIM.STEP);
      continue;
    }

    const speedFrac = clamp(r.speed / Math.max(1, r.stats.topSpeed), 0, 1);
    let steerRate = r.stats.steerRate * (1 - speedFrac * (1 - PHYSICS.steerRateHighSpeed / PHYSICS.steerRate));
    if (r.airborne) steerRate *= PHYSICS.air.airSteer;

    // ── DRIFT. Three states, evaluated in this order, which is the whole fix: an existing
    //    drift is CONTINUED before a new one may start. Checking "start" first restarted the
    //    hop forever and never assigned a drift direction — 2,623 hops, zero charge, an inert
    //    mechanic. Steering is required to *enter* a drift; the DRIFT button alone sustains it.
    const holding = driftHeld && r.speed > PHYSICS.drift.minSpeed;

    if (!r.driftActive && holding && steer !== 0 && !r.airborne && r.respawnTicks === 0) {
      r.driftActive = true;
      r.driftDir = steer;
      r.hopTicks = PHYSICS.drift.hopTicks;
      r.driftCharge = 0; r.driftTier = 0;
      emit(state, 'hop', r.id, {});
    }

    if (r.driftActive) {
      if (holding) {
        if (r.hopTicks === 0) {
          r.driftCharge = Math.min(PHYSICS.drift.chargeCap, r.driftCharge + SIM.STEP);
          let tier = 0;
          for (let t = 0; t < PHYSICS.drift.tiers.length; t++) if (r.driftCharge >= PHYSICS.drift.tiers[t].at) tier = t + 1;
          if (tier > r.driftTier) {
            r.driftTier = tier;
            emit(state, 'drift', r.id, { tier, x: r.x, z: r.z });
          }
          steerRate *= PHYSICS.drift.turnRateMul;
        }
      } else {
        // released: pay out the mini-turbo the charge earned
        if (r.driftTier > 0) {
          const t = PHYSICS.drift.tiers[r.driftTier - 1];
          applyBoost(state, r, t.speedAdd, t.boostTicks, 'mini-turbo-' + t.name);
        }
        r.driftActive = false; r.driftDir = 0; r.driftCharge = 0; r.driftTier = 0;
      }
    }

    r.steerInput = steer;
    r.heading = wrapAngle(r.heading + steer * steerRate * SIM.STEP);

    // ── slipstream: sit in someone's tow and you get a slingshot
    const sl = RACE.slipstream;
    let inTow = false;
    for (const o of state.racers) {
      if (o.id === r.id || o.finished) continue;
      const gap = o.progress - r.progress;
      if (gap > 0.5 && gap < sl.dist) {
        const lat = Math.abs(o.lateral - r.lateral);
        if (lat < sl.lateral) { inTow = true; break; }
      }
    }
    if (inTow && r.speed > r.stats.topSpeed * 0.6) {
      r.slipstreamTicks++;
      if (r.slipstreamTicks >= sl.ticks && r.slipstreamAdd === 0) {
        r.slipstreamAdd = sl.speedAdd;
        applyBoost(state, r, sl.speedAdd, sl.boostTicks, 'slipstream');
        r.slipstreamTicks = 0;
      }
    } else { r.slipstreamTicks = 0; r.slipstreamAdd = 0; }

    // ── boost pads (a racer may retrigger a pad at most once per second)
    if (surface === 'boost' && state.tick - (r._padCd ?? -999) > 60) {
      r._padCd = state.tick;
      applyBoost(state, r, 7.0, 42, 'pad');
      emit(state, 'pad', r.id, { x: r.x, z: r.z });
    }

    // ── ramps: launch
    if (surface === 'ramp' && !r.airborne && r.speed > 12) {
      const rp = state.track.ramps.find(rm => {
        const d = ((r.s - rm.s + L + L / 2) % L) - L / 2;
        return d > -rm.halfLen && d < rm.halfLen * 0.4 && Math.abs(r.lateral - rm.lateral) < rm.halfWidth;
      });
      if (rp) {
        r.airborne = true;
        r.vy = PHYSICS.air.launchFromRamp * clamp(r.speed / r.stats.topSpeed, 0.6, 1.4);
      }
    }

    // ── cornering grip ceiling: tight corners cap your speed by your HANDLING, not your engine
    const cornerLimit = cornerLimitFor(state, r, r.s);

    // ── longitudinal
    const coinBonus = r.coins * RACE.coins.speedPerCoin;
    let target = Math.min(r.stats.topSpeed * surf.topSpeedMul + coinBonus, cornerLimit);
    // A bogged engine is a POWER penalty, not a stun: the kart still drives, it just has nothing.
    // (Freezing it made the bog indistinguishable from a Pulse Wave hit and spun the kart on the
    // spot, which is not what "bogged the engine" means.)
    if (r.bogTicks > 0) { r.bogTicks--; target *= PHYSICS.rocketStart.bogSpeedMul; }
    if (boosting) target += r.boostAdd;
    if (r.overdriveTicks > 0) target = Math.max(target, r.stats.topSpeed + (ITEMS.overdrive.speedAdd));
    // rubber band: helps the back of the field, holds the leader back a hair
    const behind = leader.progress - r.progress;
    if (behind > RACE.rubberband.maxBehindMetres) target += RACE.rubberband.behindSpeedAdd;
    if (-behind > RACE.rubberband.leaderSlowMetres) target -= RACE.rubberband.leaderSpeedSub;

    if (go) {
      const a = r.stats.accel * surf.accelMul;
      const frac = clamp(1 - r.speed / Math.max(1, target), 0, 1);
      r.speed += a * Math.pow(frac, 1 / PHYSICS.speedCurve) * SIM.STEP;
      if (r.speed > target) r.speed += (target - r.speed) * 3.2 * SIM.STEP;
    } else {
      r.speed *= Math.exp(-PHYSICS.coastDrag * SIM.STEP);
    }
    if (brake) r.speed = Math.max(-PHYSICS.reverseSpeed, r.speed - PHYSICS.brakeDecel * SIM.STEP);
    // a boost fired INTO a corner still has to respect the corner — this is what stops a
    // mini-turbo from being a win button that ignores the circuit
    if (r.speed > cornerLimit && r.boostTicks > 0) {
      r.speed += (Math.max(cornerLimit, r.stats.topSpeed * 0.9) - r.speed) * PHYSICS.corner.scrub * SIM.STEP;
    }
    if (!go && !brake && Math.abs(r.speed) < 0.35) r.speed = 0;

    // ── item use (edge-triggered: a press, not a hold)
    if (itemPressed && !(r.prevBits & 32) && r.item) useItem(state, r);
    r.prevBits = bits;

    // ── integrate
    integrate(state, r, steer, SIM.STEP);

    // ── walls, stuck detection, wrong way
    afterMove(state, r, surface);
  }
}

function integrate(state, r, steer, dt) {
  const fwdX = Math.sin(r.heading), fwdZ = Math.cos(r.heading);
  const leftX = Math.cos(r.heading), leftZ = -Math.sin(r.heading);
  // a drift slides the kart outward from the turn; the heading points inside, the motion outside
  const slide = r.driftDir !== 0 ? -r.driftDir * PHYSICS.drift.outwardSlip * clamp(r.speed / 20, 0, 1.2) : 0;
  r.vx = fwdX * r.speed + leftX * slide * Math.abs(r.speed);
  r.vz = fwdZ * r.speed + leftZ * slide * Math.abs(r.speed);
  r.x += r.vx * dt;
  r.z += r.vz * dt;
  r.wheelSpin = (r.wheelSpin || 0) + r.speed * dt;

  // vertical: airborne karts follow a parabola, grounded karts follow the road
  const ground = state.track.y(r.x, r.z);
  r.groundY = ground;
  if (r.airborne) {
    r.vy -= PHYSICS.air.gravity * dt;
    r.y += r.vy * dt;
    if (r.y <= ground) {
      r.y = ground; r.airborne = false;
      const impact = Math.abs(r.vy);
      r.vy = 0;
      r.squashTicks = PHYSICS.air.landSquashTicks;
      emit(state, 'land', r.id, { x: r.x, z: r.z, air: impact });
      if (impact > 9) r.speed *= 0.72;
      else if (impact > 4) r.speed *= 0.9;
    }
  } else {
    r.y = ground;
  }
}

function afterMove(state, r, surface) {
  const track = state.track;
  const lim = track.halfWidth + track.runoff;

  const pr = track.progressAt(r.x, r.z);
  if (Math.abs(pr.lateral) > lim) {
    // Wall: clamp ONLY when actually penetrating, and steer the kart back along the road rather
    // than teleporting it. A kart that is blocked and also has its position reset every tick can
    // never build the forward position it needs to escape — so this runs once, not destructively.
    const p = track.pointAt(pr.s);
    const push = Math.sign(pr.lateral) * lim;
    r.x = p.x + p.nx * push;
    r.z = p.z + p.nz * push;
    const th = Math.atan2(p.tx, p.tz);
    r.heading = approachAngle(r.heading, th, 1.2);
    r.speed *= (1 - PHYSICS.wall.bounce);
    r.lateral = push;
  }

  // wrong way: progress going backwards for a sustained window
  if (r.progress < r.prevProgress - 0.02) r.wrongWayTicks++; else r.wrongWayTicks = 0;
  r.prevProgress = r.progress;

  if (r.speed > 3) r._lastMovingTick = state.tick;

  // Stuck detector: a racer that has made no real progress for PHYSICS.stuck.ticks is put back
  // on the road. It is gated on having MOVED recently — otherwise a racer parked on the grid
  // (an idle player, or a test that holds no input) would be teleported around forever, which
  // looks like a physics bug and hides real ones. "Zero speed" is not "stuck".
  if (Math.abs(r.progress - r.stuckRef) > PHYSICS.stuck.minProgressMetres) {
    r.stuckRef = r.progress; r.stuckTicks = 0;
  } else {
    r.stuckTicks++;
    const movedRecently = state.tick - (r._lastMovingTick ?? -9999) < 120;
    if (r.stuckTicks > PHYSICS.stuck.ticks && !r.finished && movedRecently) respawn(state, r, 'stuck');
  }
  void surface;
}

function stepPickups(state) {
  const t = state.tick;
  for (const p of state.pickups) {
    p.spin += 0.04;
    for (const r of state.racers) {
      if (r.item && r.itemRollTicks === 0) continue;      // already holding one
      if (r.finished) continue;
      if (t < p.cooldowns[r.id]) continue;                // per-racer cooldown: the back of the
      if (dist2(r.x, r.z, p.x, p.z) < 2.9 * 2.9) {        // a kart is 2m wide; 2.4m was too tight
        giveItem(state, r);
        p.cooldowns[r.id] = t + 150;                       // 2.5 s before THIS racer may reuse it
      }
    }
  }
}

function stepCoins(state) {
  const t = state.tick;
  for (const c of state.coins) {
    c.spin += 0.06;
    for (const r of state.racers) {
      if (r.finished || r.coins >= RACE.coins.max) continue;
      if (t < c.taken[r.id]) continue;
      if (dist2(r.x, r.z, c.x, c.z) < RACE.coins.radius * RACE.coins.radius) {
        r.coins = Math.min(RACE.coins.max, r.coins + 1);
        c.taken[r.id] = t + 60 * 9;
        emit(state, 'coin', r.id, { x: c.x, z: c.z, coins: r.coins });
      }
    }
  }
}

function stepItems(state) {
  const track = state.track;
  const keep = [];
  for (const it of state.items) {
    const def = ITEMS[it.kind] || {};
    it.spin += 0.15;
    it.armed = (it.armed || 0) + 1;

    if (it.state === 'pending') {
      it.ticksLeft--;
      if (it.ticksLeft <= 0) {
        it.state = 'fired';
        const owner = state.racers[it.ownerId];
        for (const r of state.racers) {
          if (r.id === it.ownerId || r.finished) continue;
          spinOut(state, r, def, it.ownerId);
        }
        emit(state, 'pulse', it.ownerId, { x: owner.x, z: owner.z, radius: def.radius });
        continue;
      }
      keep.push(it); continue;
    }

    if (it.state === 'dead') continue;

    // move
    if (it.vx || it.vz) {
      if (def.homing && it.targetId !== null) {
        const tgt = state.racers[it.targetId];
        if (tgt && tgt.finished) it.targetId = null;
        if (tgt) {
          const want = Math.atan2(tgt.x - it.x, tgt.z - it.z);
          const cur = Math.atan2(it.vx, it.vz);
          const next = approachAngle(cur, want, (def.turnRate || 2) * SIM.STEP);
          const sp = Math.hypot(it.vx, it.vz);
          it.vx = Math.sin(next) * sp; it.vz = Math.cos(next) * sp;
        }
      }
      it.x += it.vx * SIM.STEP;
      it.z += it.vz * SIM.STEP;
      it.y = track.y(it.x, it.z) + 0.5;
      if (track.surfaceAt(it.x, it.z) === 'wall') {
        if (def.bounces) {
          it.vx = -it.vx * (def.wallBounce || 0.8);
          it.vz = -it.vz * (def.wallBounce || 0.8);
          const pr = track.progressAt(it.x, it.z);
          const p = track.pointAt(pr.s);
          const push = Math.sign(pr.lateral) * (track.halfWidth + track.runoff - 0.4);
          it.x = p.x + p.nx * push; it.z = p.z + p.nz * push;
        } else { it.state = 'dead'; continue; }
      }
    }

    // hit test
    let consumed = false;
    for (const r of state.racers) {
      if (r.finished) continue;
      if (r.id === it.ownerId && it.armed < 22) continue;
      if (r.overdriveTicks > 0 && r.id !== it.ownerId) continue;
      const rad = (def.radius || 1.6);
      if (dist2(r.x, r.z, it.x, it.z) < rad * rad) {
        if (def.splash) {
          for (const o of state.racers) {
            if (o.finished) continue;
            if (dist2(o.x, o.z, it.x, it.z) < def.splash * def.splash) spinOut(state, o, def, it.ownerId);
          }
          emit(state, 'explode', it.ownerId, { x: it.x, z: it.z, radius: def.splash });
        } else {
          spinOut(state, r, def, it.ownerId);
        }
        consumed = true; break;
      }
    }
    if (consumed) { it.state = 'dead'; emit(state, 'item-dead', it.id, { x: it.x, z: it.z }); continue; }

    it.ticksLeft--;
    if (it.ticksLeft <= 0) { it.state = 'dead'; continue; }
    keep.push(it);
  }
  state.items = keep;
}

function stepCollisions(state) {
  const n = state.racers.length;
  for (let i = 0; i < n; i++) {
    const a = state.racers[i];
    if (a.finished) continue;
    for (let j = i + 1; j < n; j++) {
      const b = state.racers[j];
      if (b.finished) continue;
      const dx = b.x - a.x, dz = b.z - a.z;
      const d2 = dx * dx + dz * dz;
      const R = 2.0;
      if (d2 > R * R || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d, nz = dz / d;
      const overlap = (R - d) * 0.5;
      // heavier kart shoves the lighter one
      const wa = a.stats.weight, wb = b.stats.weight;
      const shareA = wb / (wa + wb), shareB = wa / (wa + wb);
      a.x -= nx * overlap * 2 * shareA; a.z -= nz * overlap * 2 * shareA;
      b.x += nx * overlap * 2 * shareB; b.z += nz * overlap * 2 * shareB;
      if (a.overdriveTicks > 0) spinOut(state, b, ITEMS.overdrive, a.id);
      else if (b.overdriveTicks > 0) spinOut(state, a, ITEMS.overdrive, b.id);
      else if (a.boostTicks > 0 || b.boostTicks > 0) {
        a.speed *= 1 - 0.02 * shareA; b.speed *= 1 - 0.02 * shareB;
      } else {
        // Barging is asymmetric: the lighter kart pays for the contact. Without this, low weight
        // was strictly better (it already bought acceleration and grip) and heavy characters were
        // simply bad picks — the measured roster spread was 7.9 points of 14 with the heavy lines
        // at the bottom. Weight now has to be worth something.
        a.speed *= 1 - 0.10 * shareA;
        b.speed *= 1 - 0.10 * shareB;
      }
    }
  }
}

function stepPlacesAndFinish(state) {
  recomputePlaces(state);
  if (state.mode === 'trial') {
    // time trial: the flag falls the moment the player completes the distance
    const p = state.racers[state.playerIndex];
    if (p.finished && state.finishedOrder.length >= 1) finishRace(state);
    return;
  }
  if (state.finishedOrder.length > 0) {
    const allDone = state.finishedOrder.length >= state.racers.length;
    const graceExpired = state.tick - (state.racers[state.finishedOrder[0]].finishTick) > RACE.finishGraceTicks;
    if (allDone || graceExpired) finishRace(state);
  }
}

function finishRace(state) {
  // anyone still running is placed by progress
  const rest = state.racers.filter(r => !r.finished).sort((a, b) => b.progress - a.progress);
  for (const r of rest) {
    r.finished = true; r.finishTick = state.tick; r.totalTicks = state.raceTicks;
    state.finishedOrder.push(r.id);
  }
  recomputePlaces(state);
  state.phase = 'finished';
  emit(state, 'race-over', null, { order: state.finishedOrder.slice() });
}

// ─────────────────────────────────────────────────────────── determinism
export function hashState(state) {
  const parts = [state.tick, state.phase, state.countdownTicks, state.rng.s, state.finishedOrder.join(',')];
  for (const r of state.racers) {
    parts.push(
      r.id, r.x.toFixed(5), r.y.toFixed(5), r.z.toFixed(5), r.heading.toFixed(5),
      r.speed.toFixed(5), r.lap, r.s.toFixed(5), r.progress.toFixed(5), r.place,
      r.item || '-', r.itemUses, r.coins, r.driftTier, r.driftCharge.toFixed(4),
      r.boostTicks, r.spinTicks, r.overdriveTicks, r.bogTicks, r.finished ? 1 : 0, r.finishTick,
      r.airborne ? 1 : 0, r.surface.slice(0, 4), r._armed ? 1 : 0,
    );
  }
  for (const it of state.items) {
    parts.push(it.id, it.kind, it.x.toFixed(4), it.z.toFixed(4), it.state, it.ticksLeft);
  }
  for (const p of state.pickups) parts.push(p.spin.toFixed(3), Array.from(p.cooldowns).join('.'));
  return parts.join('|');
}

export { clamp, wrapAngle, approachAngle };
export default { createState, step, hashState, makeInputs, speedKmh, raceOrder, standingsPoints };
