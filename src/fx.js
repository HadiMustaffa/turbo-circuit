// src/fx.js — TURBO CIRCUIT: pooled particle effects (PRESENTATION team).
//
// Contract §7: createFX(scene) -> { emit(events, state, opacity), update(dt, state), dispose() }
// render.js owns the lifecycle (§11.2): it creates this in init(), calls emit() and update()
// inside draw(), and disposes it on re-init. main.js never touches fx.
//
// Everything is PRE-ALLOCATED. Two THREE.Points systems (additive + soft) with fixed capacity,
// plus fixed pools of shockwave rings and overdrive auras. Nothing is constructed per frame;
// there is no per-frame allocation growth, so particle counts are bounded and assertable.
// Particle counts are driven from BOTH the discrete event stream (emit) and the continuous
// racer state (boost flames / drift sparks / off-road dust / overdrive aura in update).

import * as THREE from '../vendor/three.module.js';
import { PHYSICS, PALETTE } from './content.js';

const TAU = Math.PI * 2;

// ── fixed pool capacities (assertable via fx.stats / fx.poolStats()) ─────────
const ADD_CAP = 320;   // additive: flames, sparks, stars, bursts, aura, water spray
const SOFT_CAP = 256;  // soft: dust, debris, smoke, landing puffs
const RING_CAP = 8;    // pulse shockwaves
const AURA_CAP = 8;    // overdrive auras (one per racer at most)

// ── colours (parsed once, never per particle) ────────────────────────────────
function C(hex) { return new THREE.Color(hex); }
const COL = {
  boost: C(PALETTE.boost),
  boostHot: C('#fff0c0'),
  ok: C(PALETTE.ok),
  edge: C(PALETTE.hudEdge),
  warm: C(PALETTE.hudWarm),
  warn: C(PALETTE.warn),
  road: C(PALETTE.road),
  wall: C(PALETTE.wall),
  sand: C(PALETTE.sand),
  grass: C(PALETTE.grass),
  grassNight: C(PALETTE.grassNight),
  grassSnow: C(PALETTE.grassSnow),
  spray: C('#d8f4ff'),
  smoke: C('#c9c9d4'),
  black: C('#120c1e'),
  tier1: C(PHYSICS.drift.tiers[0].colour),
  tier2: C(PHYSICS.drift.tiers[1].colour),
  tier3: C(PHYSICS.drift.tiers[2].colour),
};

function tierColour(tier) {
  const t = tier | 0;
  if (t >= 3) return COL.tier3;
  if (t === 2) return COL.tier2;
  return COL.tier1;
}

// Points are sized in metres and projected with the standard three.js point-size formula.
// The renderer is not given to us by the frozen signature, so the projection scale is taken
// from the window (a 60° vertical FOV assumption) and refreshed periodically.
function viewportScale() {
  if (typeof window === 'undefined') return 935;
  const h = (window.innerHeight || 1080) * (window.devicePixelRatio || 1);
  return h / (2 * Math.tan(THREE.MathUtils.degToRad(60) / 2));
}

const VERT = `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
uniform float uScale;
uniform float uOpacity;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = aColor;
  vAlpha = aAlpha * uOpacity;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = max(1.0, aSize * uScale / max(0.05, -mv.z));
}`;

const FRAG = `
varying vec3 vColor;
varying float vAlpha;
uniform float uSoft;
void main() {
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = length(d) * 2.0;
  float a = smoothstep(1.0, uSoft, r);
  if (a <= 0.004 || vAlpha <= 0.004) discard;
  gl_FragColor = vec4(vColor, a * vAlpha);
}`;

// ─────────────────────────────────────────────────────────────── particle system
// Struct-of-arrays, fixed capacity, free-list recycling, front-compaction each frame.
function createSystem(capacity, soft) {
  const cap = capacity;
  const pos = new Float32Array(cap * 3);
  const col = new Float32Array(cap * 3);
  const siz = new Float32Array(cap);
  const alp = new Float32Array(cap);

  const vel = new Float32Array(cap * 3);
  const life = new Float32Array(cap);      // seconds remaining
  const total = new Float32Array(cap);     // seconds at spawn
  const grav = new Float32Array(cap);
  const drag = new Float32Array(cap);
  const s0 = new Float32Array(cap);
  const s1 = new Float32Array(cap);
  const a0 = new Float32Array(cap);

  const active = new Int32Array(cap);
  const free = new Int32Array(cap);
  const mark = new Int32Array(cap);
  let activeCount = 0;
  let freeCount = cap;
  let epoch = 0;
  for (let i = 0; i < cap; i++) free[i] = cap - 1 - i; // pop from the tail

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geom.setAttribute('aSize', new THREE.BufferAttribute(siz, 1));
  geom.setAttribute('aAlpha', new THREE.BufferAttribute(alp, 1));
  geom.setDrawRange(0, 0);
  geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const material = new THREE.ShaderMaterial({
    uniforms: { uScale: { value: viewportScale() }, uOpacity: { value: 1 }, uSoft: { value: soft ? 0.05 : 0.45 } },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: soft ? THREE.NormalBlending : THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geom, material);
  points.frustumCulled = false;
  points.renderOrder = 12;

  const sys = {
    cap, soft, points, material, geom,
    spawned: 0, dropped: 0,
    get live() { return activeCount; },
    get freeCount() { return freeCount; },

    spawn(x, y, z, vx, vy, vz, c, size0, size1, lifeSec, alpha, gravity, dragK) {
      if (freeCount === 0) { sys.dropped++; return -1; }
      const i = free[--freeCount];
      const p3 = i * 3;
      pos[p3] = x; pos[p3 + 1] = y; pos[p3 + 2] = z;
      vel[p3] = vx; vel[p3 + 1] = vy; vel[p3 + 2] = vz;
      col[p3] = c.r; col[p3 + 1] = c.g; col[p3 + 2] = c.b;
      life[i] = lifeSec; total[i] = lifeSec;
      grav[i] = gravity; drag[i] = dragK;
      s0[i] = size0; s1[i] = size1; a0[i] = alpha;
      siz[i] = size0; alp[i] = alpha;
      active[activeCount++] = i;
      sys.spawned++;
      return i;
    },

    update(dt) {
      let w = 0;
      const n = activeCount;
      for (let k = 0; k < n; k++) {
        const i = active[k];
        let l = life[i] - dt;
        if (l <= 0) continue; // died: dropped from the active list
        const p3 = i * 3;
        const d = Math.max(0, 1 - drag[i] * dt);
        let vx = vel[p3] * d;
        let vy = (vel[p3 + 1] + grav[i] * dt) * d;
        let vz = vel[p3 + 2] * d;
        // cheap air brake for vertical motion (dust settles, debris lands)
        if (soft && grav[i] < 0 && vy > -1.2) vy *= 0.92;
        vel[p3] = vx; vel[p3 + 1] = vy; vel[p3 + 2] = vz;
        const x = pos[p3] + vx * dt;
        const y = pos[p3 + 1] + vy * dt;
        const z = pos[p3 + 2] + vz * dt;
        life[i] = l;
        const u = 1 - l / total[i];              // 0 at spawn → 1 at death
        const size = s0[i] + (s1[i] - s0[i]) * u;
        const a = a0[i] * (1 - u) * (u < 0.12 ? u / 0.12 : 1);
        if (w !== k) {
          const q3 = w * 3;
          pos[q3] = x; pos[q3 + 1] = y; pos[q3 + 2] = z;
          vel[q3] = vx; vel[q3 + 1] = vy; vel[q3 + 2] = vz;
          col[q3] = col[p3]; col[q3 + 1] = col[p3 + 1]; col[q3 + 2] = col[p3 + 2];
          life[w] = l; total[w] = total[i]; grav[w] = grav[i]; drag[w] = drag[i];
          s0[w] = s0[i]; s1[w] = s1[i]; a0[w] = a0[i];
          active[w] = i;
        }
        siz[w] = size; alp[w] = a;
        w++;
      }
      activeCount = w;

      // rebuild the free list for the next spawn batch
      epoch++;
      for (let k = 0; k < activeCount; k++) mark[active[k]] = epoch;
      freeCount = 0;
      for (let i = 0; i < cap; i++) if (mark[i] !== epoch) free[freeCount++] = i;

      geom.setDrawRange(0, activeCount);
      geom.attributes.position.needsUpdate = true;
      geom.attributes.aColor.needsUpdate = true;
      geom.attributes.aSize.needsUpdate = true;
      geom.attributes.aAlpha.needsUpdate = true;
    },

    clear() {
      activeCount = 0;
      freeCount = cap;
      for (let i = 0; i < cap; i++) free[i] = cap - 1 - i;
      geom.setDrawRange(0, 0);
      geom.attributes.aAlpha.needsUpdate = true;
    },

    dispose() {
      geom.dispose();
      material.dispose();
    },
  };
  return sys;
}

// ─────────────────────────────────────────────────────────────── createFX
export function createFX(scene) {
  const canScene = scene && typeof scene.add === 'function';
  const add = canScene ? (o) => scene.add(o) : () => {};
  const remove = canScene && typeof scene.remove === 'function' ? (o) => scene.remove(o) : () => {};

  const addSys = createSystem(ADD_CAP, false);
  const softSys = createSystem(SOFT_CAP, true);
  add(addSys.points);
  add(softSys.points);

  // shockwave rings
  const ringGeom = new THREE.RingGeometry(0.72, 1.0, 48);
  const rings = [];
  for (let i = 0; i < RING_CAP; i++) {
    const m = new THREE.Mesh(ringGeom, new THREE.MeshBasicMaterial({
      color: PALETTE.hudEdge, transparent: true, opacity: 0, side: THREE.DoubleSide,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    m.rotation.x = -Math.PI / 2;
    m.visible = false;
    m.frustumCulled = false;
    m.renderOrder = 11;
    m.position.set(0, 0, 0);
    add(m);
    rings.push({ mesh: m, life: 0, dur: 1, radius: 12 });
  }

  // overdrive auras
  const auraGeom = new THREE.RingGeometry(0.85, 1.35, 40);
  const auras = [];
  for (let i = 0; i < AURA_CAP; i++) {
    const m = new THREE.Mesh(auraGeom, new THREE.MeshBasicMaterial({
      color: PALETTE.ok, transparent: true, opacity: 0, side: THREE.DoubleSide,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    m.rotation.x = -Math.PI / 2;
    m.visible = false;
    m.frustumCulled = false;
    m.renderOrder = 11;
    add(m);
    auras.push({ mesh: m, on: false });
  }

  // per-racer continuous-emitter accumulators (fixed, indexed by racer slot)
  const emitAcc = new Float32Array(16);
  const pulsePrev = new Int32Array(16);
  const overPrev = new Int32Array(16);

  let globalOpacity = 1;
  let scaleTimer = 0;
  let time = 0;
  let racerSlots = 0;

  const stats = {
    pool: ADD_CAP + SOFT_CAP, poolAdditive: ADD_CAP, poolSoft: SOFT_CAP,
    live: 0, liveAdditive: 0, liveSoft: 0,
    spawned: 0, recycled: 0, dropped: 0,
    rings: RING_CAP, auras: AURA_CAP, frames: 0,
  };

  function poolStats() {
    return {
      pool: ADD_CAP + SOFT_CAP, poolAdditive: ADD_CAP, poolSoft: SOFT_CAP,
      live: addSys.live + softSys.live, liveAdditive: addSys.live, liveSoft: softSys.live,
      spawned: addSys.spawned + softSys.spawned, dropped: addSys.dropped + softSys.dropped,
      rings: RING_CAP, auras: AURA_CAP, ringGeom: 1, pointsObjects: 2,
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  function racerOf(state, id) {
    if (!state || !state.racers) return null;
    const r = state.racers[id | 0];
    return r || null;
  }

  function racerPos(state, id, ex, exz) {
    const r = racerOf(state, id);
    if (Number.isFinite(ex) && Number.isFinite(exz)) return { x: ex, z: exz, r };
    if (r && Number.isFinite(r.x)) return { x: r.x, z: r.z, r };
    return null;
  }

  function forwardOf(r) {
    if (!r) return { fx: 0, fz: 1, vx: 0, vz: 0 };
    let vx = Number.isFinite(r.vx) ? r.vx : 0;
    let vz = Number.isFinite(r.vz) ? r.vz : 0;
    if (!vx && !vz && Number.isFinite(r.speed) && r.speed > 0.2 && Number.isFinite(r.heading)) {
      vx = Math.sin(r.heading) * r.speed; vz = Math.cos(r.heading) * r.speed;
    }
    const sp = Math.hypot(vx, vz) || 1;
    return { fx: vx / sp, fz: vz / sp, vx, vz, speed: Math.hypot(vx, vz) };
  }

  function groundY(state, x, z) {
    const t = state && state.track;
    if (t && typeof t.y === 'function') {
      const y = t.y(x, z);
      if (Number.isFinite(y)) return y;
    }
    return 0;
  }

  function dustColour(state) {
    const t = state && state.track;
    const th = t && (t.theme || t.id);
    if (th === 'alpine') return COL.grassSnow;
    if (th === 'city' || th === 'neon-docks') return COL.grassNight;
    if (th === 'coast' || th === 'sunset-bay') return COL.sand;
    return COL.grass;
  }

  function sprayTrack(state) {
    const t = state && state.track;
    const th = t && (t.theme || t.id);
    return th === 'coast' || th === 'sunset-bay' || th === 'alpine';
  }

  // ── spawn presets ──────────────────────────────────────────────────────────
  function flames(x, y, z, fx, fz, strength) {
    const n = 3 + (strength > 1 ? 3 : 0);
    for (let i = 0; i < n; i++) {
      const j = 0.6 + Math.random() * 0.8;
      const s = 0.10 + Math.random() * 0.14;
      const c = Math.random() < 0.45 ? COL.boostHot : COL.boost;
      addSys.spawn(
        x - fx * (0.55 + Math.random() * 0.5) + (Math.random() - 0.5) * 0.35,
        y + 0.28 + Math.random() * 0.3,
        z - fz * (0.55 + Math.random() * 0.5) + (Math.random() - 0.5) * 0.35,
        -fx * (2.2 + Math.random() * 3) * j + (Math.random() - 0.5) * 1.1,
        0.7 + Math.random() * 1.4,
        -fz * (2.2 + Math.random() * 3) * j + (Math.random() - 0.5) * 1.1,
        c, s, s * 3.4, 0.22 + Math.random() * 0.3, 0.95, 2.2, 2.6,
      );
    }
  }

  function sparks(x, y, z, dirx, dirz, tier, n) {
    const c = tierColour(tier);
    const count = n || 10;
    for (let i = 0; i < count; i++) {
      const side = Math.random() < 0.5 ? 1 : -1;
      addSys.spawn(
        x + (Math.random() - 0.5) * 0.5,
        y + 0.09,
        z + (Math.random() - 0.5) * 0.5,
        side * (1.6 + Math.random() * 4.4) + dirx * 2.2,
        1.6 + Math.random() * 3.4,
        side * (1.6 + Math.random() * 4.4) + dirz * 2.2,
        c, 0.05 + Math.random() * 0.08, 0.03, 0.26 + Math.random() * 0.30, 1, -13.5, 0.6,
      );
    }
  }

  function debris(x, y, z, c, n) {
    for (let i = 0; i < (n || 14); i++) {
      const a = Math.random() * TAU;
      const sp = 2.0 + Math.random() * 6.0;
      softSys.spawn(
        x + (Math.random() - 0.5) * 0.4, y + 0.3 + Math.random() * 0.5, z + (Math.random() - 0.5) * 0.4,
        Math.cos(a) * sp, 2.0 + Math.random() * 5.0, Math.sin(a) * sp,
        c, 0.07 + Math.random() * 0.10, 0.05, 0.45 + Math.random() * 0.5, 1, -16, 0.25,
      );
    }
  }

  function dust(x, y, z, c, n, spread) {
    for (let i = 0; i < (n || 5); i++) {
      const a = Math.random() * TAU;
      const sp = 0.4 + Math.random() * 1.5;
      softSys.spawn(
        x + (Math.random() - 0.5) * (spread || 0.9), y + 0.12 + Math.random() * 0.2, z + (Math.random() - 0.5) * (spread || 0.9),
        Math.cos(a) * sp, 0.5 + Math.random() * 1.1, Math.sin(a) * sp,
        c, 0.30 + Math.random() * 0.45, 1.0 + Math.random() * 0.9, 0.5 + Math.random() * 0.45, 0.5, 0.5, 1.5,
      );
    }
  }

  function stars(x, y, z, c, n) {
    for (let i = 0; i < (n || 10); i++) {
      const a = Math.random() * TAU;
      const el = 0.2 + Math.random() * 0.9;
      const sp = 2.5 + Math.random() * 5.5;
      addSys.spawn(
        x, y + 0.9 + Math.random() * 0.4, z,
        Math.cos(a) * sp, el * sp * 0.7, Math.sin(a) * sp,
        c, 0.14 + Math.random() * 0.12, 0.05, 0.4 + Math.random() * 0.4, 1, -7.0, 0.5,
      );
    }
  }

  function burst(x, y, z, c, n) {
    for (let i = 0; i < (n || 16); i++) {
      const a = Math.random() * TAU;
      const el = Math.random() * 0.9;
      const sp = 2.5 + Math.random() * 6.5;
      addSys.spawn(
        x, y + 1.0, z,
        Math.cos(a) * sp, el * sp, Math.sin(a) * sp,
        c, 0.10 + Math.random() * 0.16, 0.04, 0.35 + Math.random() * 0.45, 1, -6.0, 0.45,
      );
    }
  }

  function spray(x, y, z, n) {
    for (let i = 0; i < (n || 12); i++) {
      const a = Math.random() * TAU;
      const sp = 1.2 + Math.random() * 3.4;
      softSys.spawn(
        x, y + 0.15, z,
        Math.cos(a) * sp, 1.8 + Math.random() * 3.2, Math.sin(a) * sp,
        COL.spray, 0.10 + Math.random() * 0.14, 0.16, 0.40 + Math.random() * 0.4, 0.75, -11, 0.5,
      );
      addSys.spawn(
        x, y + 0.15, z,
        Math.cos(a) * sp * 0.6, 1.0 + Math.random() * 2.0, Math.sin(a) * sp * 0.6,
        COL.spray, 0.05 + Math.random() * 0.07, 0.02, 0.25 + Math.random() * 0.25, 0.7, -9, 0.6,
      );
    }
  }

  function puff(x, y, z, n) {
    for (let i = 0; i < (n || 12); i++) {
      const a = Math.random() * TAU;
      const sp = 1.4 + Math.random() * 2.8;
      softSys.spawn(
        x, y + 0.1, z,
        Math.cos(a) * sp, 0.7 + Math.random() * 1.4, Math.sin(a) * sp,
        COL.smoke, 0.28 + Math.random() * 0.35, 1.1 + Math.random() * 0.9, 0.35 + Math.random() * 0.35, 0.55, 0.4, 2.2,
      );
    }
  }

  function auraBurst(x, y, z) {
    for (let i = 0; i < 4; i++) {
      const a = Math.random() * TAU;
      addSys.spawn(
        x + Math.cos(a) * 1.1, y + 0.25, z + Math.sin(a) * 1.1,
        Math.cos(a) * 0.35, 1.1 + Math.random() * 1.4, Math.sin(a) * 0.35,
        Math.random() < 0.5 ? COL.ok : COL.warm, 0.10 + Math.random() * 0.10, 0.02, 0.35, 0.9, 1.2, 1.2,
      );
    }
  }

  function shockwave(x, y, z, radius, colour) {
    let slot = null;
    for (let i = 0; i < rings.length; i++) if (rings[i].life <= 0) { slot = rings[i]; break; }
    if (!slot) slot = rings[0];
    slot.life = 0.85;
    slot.dur = 0.85;
    slot.radius = radius || 14;
    slot.mesh.position.set(x, y + 0.35, z);
    slot.mesh.material.color.copy(colour || COL.edge);
    slot.mesh.visible = true;
    slot.mesh.scale.setScalar(0.4);
  }

  // ── emit: discrete event stream (CONTRACTS §8 event types) ─────────────────
  function emit(events, state, opacity) {
    if (Number.isFinite(opacity)) globalOpacity = Math.max(0, Math.min(1, opacity));
    if (!events || !events.length) return;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      if (!e || !e.type) continue;
      const id = e.racerId | 0;
      const p = racerPos(state, id, e.x, e.z);
      const r = p ? p.r : null;
      const f = forwardOf(r);
      const x = p ? p.x : (Number.isFinite(e.x) ? e.x : 0);
      const z = p ? p.z : (Number.isFinite(e.z) ? e.z : 0);
      const y = groundY(state, x, z) + (r && Number.isFinite(r.y) ? Math.max(0, r.y - groundY(state, x, z)) : 0);

      switch (e.type) {
        case 'boost':
        case 'pad':
          flames(x, y, z, f.fx, f.fz, e.kind === 'pad' || e.kind === 'rocket' ? 2 : 1);
          if (e.kind === 'pad') burst(x, y, z, COL.ok, 8);
          break;
        case 'drift':
          sparks(x, y, z, f.fz, -f.fx, e.tier || r?.driftTier || 1, 14);
          break;
        case 'hop':
          puff(x, y, z, 8);
          break;
        case 'land':
          puff(x, y, z, Number.isFinite(e.air) && e.air > 0.5 ? 20 : 12);
          dust(x, y, z, dustColour(state), 14, 1.3);
          if (Number.isFinite(e.air) && e.air > 0.35 && sprayTrack(state)) spray(x, y, z, 12);
          break;
        case 'hit':
          debris(x, y, z, COL.wall, 14);
          debris(x, y, z, COL.road, 8);
          stars(x, y, z, COL.warm, 12);
          if (e.item === 'pulse') shockwave(x, y, z, 16, COL.edge);
          break;
        case 'spinout':
          stars(x, y, z, COL.warn, 16);
          dust(x, y, z, COL.smoke, 8, 1.2);
          break;
        case 'respawn':
          burst(x, y, z, COL.edge, 18);
          spray(x, y, z, 14);
          break;
        case 'pickup':
          burst(x, y + 0.5, z, e.item === 'ink' ? COL.black : COL.edge, 18);
          break;
        case 'throw':
          burst(x, y, z, COL.warm, 10);
          if (e.item === 'pulse') shockwave(x, y, z, 18, COL.warm);
          if (e.item === 'mine' || e.item === 'cannonball') debris(x, y, z, COL.wall, 6);
          break;
        case 'offroad':
          if (e.state) dust(x, y, z, dustColour(state), 3, 1.0);
          break;
        case 'go':
          burst(x, y + 0.4, z, COL.ok, 12);
          break;
        default:
          break; // lap / finish / roll / place / countdown are HUD+audio concerns
      }
    }
  }

  // ── update: advance particles + drive continuous emitters ──────────────────
  function update(dt, state) {
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(0.1, dt) : 1 / 60;
    time += step;

    scaleTimer += step;
    if (scaleTimer > 0.5) {
      scaleTimer = 0;
      const s = viewportScale();
      addSys.material.uniforms.uScale.value = s;
      softSys.material.uniforms.uScale.value = s;
    }
    addSys.material.uniforms.uOpacity.value = globalOpacity;
    softSys.material.uniforms.uOpacity.value = globalOpacity;

    // continuous emitters from racer state
    const racers = state && state.racers ? state.racers : null;
    if (racers) {
      if (racers.length > emitAcc.length) racerSlots = emitAcc.length; else racerSlots = racers.length;
      for (let i = 0; i < racers.length && i < emitAcc.length; i++) {
        const r = racers[i];
        if (!r) continue;
        const f = forwardOf(r);
        const gy = groundY(state, r.x, r.z);
        const y = Number.isFinite(r.y) ? Math.max(r.y, gy) : gy;

        // boost flames
        const boosting = (r.boostTicks | 0) > 0 || (r.miniTurboTicks | 0) > 0;
        // drift sparks while sliding with charge
        const drifting = (r.driftDir | 0) !== 0 && (r.driftCharge || 0) > 0.05;
        // off-road dust
        const off = r.offTrack === true || (typeof r.offTrack === 'number' && r.offTrack > 0) || r.surface === 'grass';
        // overdrive aura
        const over = (r.overdriveTicks | 0) > 0;

        emitAcc[i] += step;
        if (emitAcc[i] >= 0.016) {
          emitAcc[i] = 0;
          if (boosting) flames(r.x, y, r.z, f.fx, f.fz, (r.boostKind === 'nitro' || (r.miniTurboTicks | 0) > 0) ? 2 : 1);
          if (drifting) sparks(r.x, y, r.z, f.fz, -f.fx, r.driftTier || 1, 3);
          if (off && f.speed > 3) dust(r.x, y, r.z, dustColour(state), 2, 1.1);
          if (over) {
            auraBurst(r.x, y, r.z);
            const slot = auras[i % AURA_CAP];
            slot.on = true;
            slot.mesh.position.set(r.x, y + 0.16, r.z);
            slot.mesh.scale.setScalar(1.05 + Math.sin(time * 9) * 0.13);
            slot.mesh.material.opacity = 0.42 + Math.sin(time * 12) * 0.14;
            slot.mesh.rotation.z += step * 2.4;
            slot.mesh.visible = true;
          }
          // pulse shockwave fires once per pulse window per racer
          const pulse = (r.pulseTicks | 0) > 0 ? 1 : 0;
          if (pulse && pulsePrev[i] === 0) shockwave(r.x, y, r.z, 20, COL.edge);
          pulsePrev[i] = pulse;
          overPrev[i] = over ? 1 : 0;
        }
      }
      // auras for racers whose overdrive just ended, or beyond the aura pool
      for (let i = 0; i < auras.length; i++) {
        const slot = auras[i];
        if (!slot.on) continue;
        const r = racers[i];
        const alive = r && (r.overdriveTicks | 0) > 0;
        if (!alive) { slot.on = false; slot.mesh.visible = false; slot.mesh.material.opacity = 0; }
      }
    } else {
      for (let i = 0; i < auras.length; i++) { auras[i].on = false; auras[i].mesh.visible = false; }
    }

    addSys.update(step);
    softSys.update(step);

    // rings
    for (let i = 0; i < rings.length; i++) {
      const r = rings[i];
      if (r.life <= 0) { if (r.mesh.visible) { r.mesh.visible = false; r.mesh.material.opacity = 0; } continue; }
      r.life -= step;
      const u = 1 - Math.max(0, r.life) / r.dur;
      r.mesh.scale.setScalar(0.4 + u * r.radius);
      r.mesh.material.opacity = (1 - u) * 0.55;
      if (r.life <= 0) { r.mesh.visible = false; r.mesh.material.opacity = 0; }
    }

    stats.live = addSys.live + softSys.live;
    stats.liveAdditive = addSys.live;
    stats.liveSoft = softSys.live;
    stats.spawned = addSys.spawned + softSys.spawned;
    stats.dropped = addSys.dropped + softSys.dropped;
    stats.frames++;
  }

  function dispose() {
    addSys.clear(); softSys.clear();
    remove(addSys.points); remove(softSys.points);
    addSys.dispose(); softSys.dispose();
    for (const r of rings) { remove(r.mesh); r.mesh.material.dispose(); r.mesh.visible = false; }
    for (const a of auras) { remove(a.mesh); a.mesh.material.dispose(); a.mesh.visible = false; }
    ringGeom.dispose(); auraGeom.dispose();
    rings.length = 0; auras.length = 0;
  }

  return {
    emit, update, dispose,
    stats, poolStats,
    systems: { additive: addSys, soft: softSys },
    get liveCount() { return addSys.live + softSys.live; },
    get poolSize() { return ADD_CAP + SOFT_CAP; },
  };
}
