// src/ai.js — TURBO CIRCUIT: the bot brains.
//
// Deterministic and DOM-free like sim.js (same three rules — no clock, no Math.random,
// no DOM). Bots read the state and return one input bitmask per racer.
//
// THE RULE THAT MATTERS MOST: movement is a PERSISTENT HOLD. ACCEL is set on every tick the
// bot wants throttle. Only DISCRETE actions (using an item, starting a drift) may be queued
// or delayed. A previous project fed movement through a one-shot delayed queue and logged
// 8,005 re-latches and zero completed climbs.
import { BIT } from './input.js';
import { AI, PHYSICS, ITEMS, RACE } from './content.js';
import { cornerLimitFor } from './sim.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrapAngle = (a) => { a %= (Math.PI * 2); if (a > Math.PI) a -= Math.PI * 2; if (a < -Math.PI) a += Math.PI * 2; return a; };

export function botInputs(state) {
  const out = new Array(state.racerCount).fill(0);
  const track = state.track;
  const L = state.length;
  // A headless race (tests, replays) drives the player's slot with the same brain. In the
  // browser state.playerBot is false, and the human's bitmask is written over this slot.
  const drive = (r) => r.cpu || !!state.playerBot;

  // a shared ordering so bots can reason about who is where without allocating per bot
  const field = state.racers;

  for (let i = 0; i < state.racers.length; i++) {
    const r = state.racers[i];
    if (!drive(r) || r.finished) { out[i] = 0; continue; }
    if (state.phase !== 'racing') {
      // during the countdown a bot taps the throttle inside the perfect-start window
      const left = state.countdownTicks / 60;
      out[i] = (left <= PHYSICS.rocketStart.perfectFrom && left > 0.05) ? BIT.ACCEL : 0;
      continue;
    }

    let bits = 0;
    const ai = r.ai;

    // ── where to aim: a point on the racing line `lookahead` metres up the road, pulled
    //    toward the inside of the corner so the bot takes a real line rather than the centre
    const speedFrac = clamp(r.speed / Math.max(1, r.stats.topSpeed), 0, 1.2);
    const look = AI.lookahead * (0.55 + speedFrac * 0.8);

    // scan forward for the tightest curvature in the braking zone
    let worstCurv = 0, curvAt = 0;
    const scan = Math.max(12, Math.round(look * 1.6 / track.spacing));
    for (let d = 2; d < scan; d++) {
      const k = (Math.round(r.s / track.spacing) + d) % track.sampleCount;
      const c = Math.abs(track.samples[k].curvature);
      if (c > worstCurv) { worstCurv = c; curvAt = d; }
    }
    const cornerSide = (() => {
      const k = (Math.round(r.s / track.spacing) + Math.max(2, curvAt)) % track.sampleCount;
      return Math.sign(track.samples[k].curvature);
    })();

    // bot personality adds a slow wander so two bots on the same line are not the same driver
    ai.jitterPhase += 0.013;
    const wander = Math.sin(ai.jitterPhase) * AI.jitter * (1 - ai.skill);

    // target lateral offset: inside line on corner entry, drifts back to centre on the straight
    let wantLat = -cornerSide * (track.halfWidth * 0.55) * clamp(worstCurv / 0.03, 0, 1);
    wantLat += wander * 2.0;

    // chase item boxes and boost pads when they are nearly on the way
    if (!r.item) {
      const box = nearestFeature(state.pickups, r, 42);
      if (box) wantLat = clamp(box.lateral, -track.halfWidth * 0.85, track.halfWidth * 0.85);
    }
    if (r.item && (r.item === 'nitro' || r.item === 'nitro3') && r.place <= 3) {
      const pad = nearestFeature(track.boostPads.map(b => ({ x: b.x, z: b.z })), r, 30, track);
      if (pad) wantLat = clamp(pad.lateral, -track.halfWidth * 0.8, track.halfWidth * 0.8);
    }

    // steer toward the aim point (world-space proportional control, with a lateral correction)
    const aimS = r.s + look;
    const aim = track.pointAt(aimS);
    const aimX = aim.x + aim.nx * clamp(wantLat, -track.halfWidth * 0.9, track.halfWidth * 0.9);
    const aimZ = aim.z + aim.nz * clamp(wantLat, -track.halfWidth * 0.9, track.halfWidth * 0.9);
    let desired = Math.atan2(aimX - r.x, aimZ - r.z);

    // avoid other karts: nudge the aim point aside rather than braking, which reads as racing
    for (const o of field) {
      if (o.id === r.id || o.finished) continue;
      const dx = o.x - r.x, dz = o.z - r.z;
      const d = Math.hypot(dx, dz);
      if (d < AI.avoidRadius * 2 && d > 0.01) {
        const ahead = ((o.s - r.s + L + L / 2) % L) - L / 2;
        if (ahead > 0 && ahead < AI.avoidRadius * 3) {
          const side = Math.sign(r.lateral - o.lateral) || (r.id % 2 ? 1 : -1);
          desired += side * 0.22 * (1 - d / (AI.avoidRadius * 2)) * (1.4 - ai.aggression);
        }
      }
    }

    const err = wrapAngle(desired - r.heading);
    const dead = 0.02 + (1 - ai.skill) * 0.05;
    if (err > dead) bits |= BIT.LEFT;
    else if (err < -dead) bits |= BIT.RIGHT;

    // ── throttle and brake: a bot brakes to ITS OWN grip limit for the tightest corner in the
    //    braking zone. Braking to a fixed curvature threshold made every kart corner at the same
    //    speed no matter its handling, which is why handling used to be worth nothing.
    let cap = Infinity;
    for (let d = 2; d < scan; d++) {
      const k = (Math.round(r.s / track.spacing) + d) % track.sampleCount;
      cap = Math.min(cap, cornerLimitFor(state, r, k * track.spacing));
    }
    const turningHard = Math.abs(err) > 0.35;
    if (r.speed > cap * 1.04) bits |= BIT.BRAKE;
    else if (turningHard && speedFrac > 1.05) bits |= BIT.BRAKE;

    if (!(bits & BIT.BRAKE) || r.speed < r.stats.topSpeed * 0.4) bits |= BIT.ACCEL;
    // the slowest bots lift slightly on the very fastest part of a long straight
    if (ai.skill < 0.7 && speedFrac > 0.98 && simHash01(state.tick + r.id * 977) < 0.02) bits &= ~BIT.ACCEL;

    // ── drift on corners worth drifting.
    // The trigger is CORNER TIGHTNESS plus SPEED, deliberately not heading error: a bot that
    // tracks the line well has a near-zero error and would never earn a mini-turbo.
    const drifting = r.driftDir !== 0 || r.hopTicks > 0;
    if (drifting) {
      // hold it while the corner lasts and there is charge left to earn
      if (worstCurv > AI.driftMinCurvature * 0.55 && r.driftCharge < PHYSICS.drift.chargeCap) bits |= BIT.DRIFT;
    } else if (worstCurv > AI.driftMinCurvature && speedFrac > 0.5 && (bits & (BIT.LEFT | BIT.RIGHT))) {
      bits |= BIT.DRIFT;
      ai.driftSide = (bits & BIT.LEFT) ? 1 : -1;
    }

    // ── items: position-aware, and delayed rather than instant (a bot that fires a shell the
    //    instant it picks it up never hits anyone). The delay is a QUEUE, not a movement hold.
    if (r.item) {
      ai.itemHold++;
      const want = wantsItem(r, state, worstCurv, ai);
      const impatient = ai.itemHold > AI.itemHoldTicks;
      const immediate = r.item === 'nitro' || r.item === 'nitro3' || r.item === 'overdrive';
      if (immediate ? r.itemRollTicks === 0 : (want || impatient)) {
        bits |= BIT.ITEM;
        ai.itemHold = 0;
      }
    } else ai.itemHold = 0;

    out[i] = bits;
  }
  return out;
}

// A tiny deterministic hash used only for bot "personality" randomness. It is a pure
// function of the tick and the racer id, so it never breaks determinism.
function simHash01(n) {
  let x = (n * 2654435761) >>> 0;
  x ^= x >>> 15; x = Math.imul(x, 2246822519) >>> 0;
  x ^= x >>> 13; x = Math.imul(x, 3266489917) >>> 0;
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

function nearestFeature(list, r, maxAhead, track) {
  let best = null, bestGap = maxAhead;
  for (const f of list) {
    if (!f) continue;
    let lat, gap;
    if (track) {
      const pr = track.progressAt(f.x, f.z);
      gap = ((pr.s - r.s + track.length + track.length / 2) % track.length) - track.length / 2;
      if (gap < 0 || gap > bestGap) continue;
      lat = pr.lateral;
    } else {
      const dx = f.x - r.x, dz = f.z - r.z;
      gap = dx * Math.sin(r.heading) + dz * Math.cos(r.heading);
      if (gap < 0 || gap > bestGap) continue;
      lat = dx * Math.cos(r.heading) - dz * Math.sin(r.heading);
    }
    if (gap < bestGap) { bestGap = gap; best = { lateral: lat, gap }; }
  }
  return best;
}

function wantsItem(r, state, worstCurv, ai) {
  const ahead = state.racers
    .filter(o => o.id !== r.id && o.progress > r.progress && !o.finished)
    .sort((a, b) => a.progress - b.progress);
  const gap = ahead.length ? Math.hypot(ahead[0].x - r.x, ahead[0].z - r.z) : Infinity;
  const id = r.item;
  const def = ITEMS[id] || {};
  switch (id) {
    case 'seeker':
      return ahead.length > 0 && gap < 55;
    case 'cannonball':
      // straight shot: only fire when someone is genuinely in front and roughly lined up
      if (!ahead.length) return false;
      {
        const o = ahead[0];
        const rel = wrapAngle(Math.atan2(o.x - r.x, o.z - r.z) - r.heading);
        return gap < 65 && Math.abs(rel) < 0.16;
      }
    case 'oil':
    case 'mine':
      // behind you is only useful when someone is actually there
      return state.racers.some(o => o.id !== r.id && !o.finished &&
        ((o.progress - r.progress + state.length) % state.length) < 34 && Math.abs(o.progress - r.progress) < 40);
    case 'pulse':
      // hold it until the field is bunched, or until the leader is far enough ahead to hurt
      return r.place > 3 || ahead.length > 0 && gap < 40 || ai.itemHold > AI.itemHoldTicks * 2;
    case 'ink':
      return ahead.length > 0 && gap < 45;
    case 'nitro':
    case 'nitro3':
      return true;
    case 'overdrive':
      return worstCurv < 0.02;
    default:
      return def.spawn === 'forward' ? gap < 60 : true;
  }
}

export default botInputs;
