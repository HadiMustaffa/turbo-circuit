// src/tracks.js — TURBO CIRCUIT: track geometry. Pure, deterministic, DOM-free, NO THREE import.
//
// Everything here is arithmetic on the control points in content.js → TRACKS. Because it has no
// DOM and no clock it runs identically in the browser, in Node and (later) on a server, which is
// what lets the sim and the tests share one definition of where the road is.
//
// Coordinate convention: XZ ground plane, Y up. travel direction T = (tx, tz).
// LEFT of travel is N = (tz, -tx)  (up × T), so a positive `lateral` means left of the centreline.
// That sign is asserted in test/track.test.mjs — a flipped lateral makes bots steer off the road.
import { TRACKS, RACE } from './content.js';

export const TRACK_IDS = TRACKS.map(t => t.id);

const SPACING = 1.5;        // metres between exported samples (drives progressAt accuracy)
const SUBDIV = 40;          // dense points per control-point segment
const RUNOFF = 4.0;         // metres of grass between the road edge and the wall

// ── small maths helpers (no deps, no allocation in hot paths) ──────────────
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
function smoothstep(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }

// deterministic RNG so scenery and coins are identical on every machine and every reload
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Uniform Catmull-Rom through 4 points, evaluated at t in [0,1] between p1 and p2.
function crPoint(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  const x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
  const z = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
  return [x, z];
}

// A smooth, exactly-periodic profile of arc length, so hills close the loop perfectly.
function heightProfile(theme, s, L) {
  const u = (s / L) * Math.PI * 2;
  if (theme === 'alpine') {
    return 3.2 * Math.sin(u * 1) + 1.4 * Math.sin(u * 3 + 1.0) + 0.5 * Math.sin(u * 5 + 2.2);
  }
  if (theme === 'city') {
    return 0.35 * Math.sin(u * 2 + 0.4);   // a flat dock with a slight camber change
  }
  return 0.9 * Math.sin(u * 1 + 0.7) + 0.4 * Math.sin(u * 3);  // coast: gentle dunes
}

// ── the builder ───────────────────────────────────────────────────────────
export function buildTrack(trackIndex) {
  const def = TRACKS[((trackIndex % TRACKS.length) + TRACKS.length) % TRACKS.length];
  const ctrl = def.control;
  const n = ctrl.length;

  // 1. dense sample of the closed spline, with cumulative arc length
  const dx = [], dz = [], ds = [0];
  for (let i = 0; i < n; i++) {
    const p0 = ctrl[(i - 1 + n) % n], p1 = ctrl[i], p2 = ctrl[(i + 1) % n], p3 = ctrl[(i + 2) % n];
    for (let j = 0; j < SUBDIV; j++) {
      const p = crPoint(p0, p1, p2, p3, j / SUBDIV);
      dx.push(p[0]); dz.push(p[1]);
    }
  }
  for (let i = 1; i <= dx.length; i++) {
    const a = i - 1, b = i % dx.length;
    ds.push(ds[a] + Math.hypot(dx[b] - dx[a], dz[b] - dz[a]));
  }
  const L = ds[ds.length - 1];

  // 2. resample at exactly equal spacing along arc length
  const M = Math.max(96, Math.round(L / SPACING));
  const step = L / M;
  const px = new Float64Array(M), pz = new Float64Array(M);
  let cursor = 0;
  for (let k = 0; k < M; k++) {
    const target = k * step;
    while (cursor < ds.length - 2 && ds[cursor + 1] < target) cursor++;
    const a = cursor, b = (cursor + 1) % dx.length;
    const seg = ds[a + 1] - ds[a] || 1e-9;
    const t = clamp((target - ds[a]) / seg, 0, 1);
    px[k] = lerp(dx[a], dx[b], t);
    pz[k] = lerp(dz[a], dz[b], t);
  }

  // 3. tangent, left normal, curvature (central differences: smooth and closed-form)
  const tx = new Float64Array(M), tz = new Float64Array(M);
  const nx = new Float64Array(M), nz = new Float64Array(M);
  const curv = new Float64Array(M);
  for (let k = 0; k < M; k++) {
    const a = (k - 1 + M) % M, b = (k + 1) % M;
    let vx = px[b] - px[a], vz = pz[b] - pz[a];
    const len = Math.hypot(vx, vz) || 1e-9;
    vx /= len; vz /= len;
    tx[k] = vx; tz[k] = vz;
    nx[k] = vz; nz[k] = -vx;                       // left of travel (up × T)
  }
  for (let k = 0; k < M; k++) {
    const a = (k - 1 + M) % M, b = (k + 1) % M;
    const cross = tx[a] * tz[b] - tz[a] * tx[b];
    const dot = tx[a] * tx[b] + tz[a] * tz[b];
    let dTheta = Math.atan2(cross, dot);
    while (dTheta > Math.PI) dTheta -= 2 * Math.PI;
    while (dTheta < -Math.PI) dTheta += 2 * Math.PI;
    curv[k] = dTheta / (2 * step);                 // 1/m, + = turning left
  }

  // 4. heights along the loop
  const hy = new Float64Array(M);
  for (let k = 0; k < M; k++) hy[k] = heightProfile(def.theme, k * step, L);

  // 5. resolved features (sFrac groups → world features)
  const half = def.width / 2;
  const at = (s, lateral) => {
    const k = ((Math.round(s / step) % M) + M) % M;
    return {
      x: px[k] + nx[k] * lateral, y: hy[k], z: pz[k] + nz[k] * lateral,
      tx: tx[k], tz: tz[k], nx: nx[k], nz: nz[k], s, index: k,
    };
  };
  const wrap = (s) => ((s % L) + L) % L;

  const itemBoxes = [];
  for (const g of def.itemBoxGroups || []) {
    const s0 = wrap(g.sFrac * L);
    for (let i = 0; i < g.count; i++) {
      const s = wrap(s0 + (i - (g.count - 1) / 2) * (g.spread || 7));
      const p = at(s, g.lateral || 0);
      itemBoxes.push({ x: p.x, y: p.y + 1.05, z: p.z, s });
    }
  }

  const boostPads = [];
  for (const b of def.boostPads || []) {
    const s0 = wrap(b.sFrac * L);
    boostPads.push({
      s0, s1: wrap(s0 + (b.length || 4)),
      lateral: b.lateral || 0, halfWidth: 1.7,
      x: at(s0 + (b.length || 4) / 2, b.lateral || 0).x,
      y: at(s0, b.lateral || 0).y,
      z: at(s0 + (b.length || 4) / 2, b.lateral || 0).z,
    });
  }

  const ramps = (def.ramps || []).map(r => {
    const s = wrap(r.sFrac * L);
    return { s, halfLen: 3.4, lateral: r.lateral || 0, halfWidth: (r.width || 8) / 2, height: r.height || 1.2 };
  });

  const shortcuts = (def.shortcuts || []).map(sc => {
    const s = wrap(sc.sFrac * L);
    return { s0: s, s1: wrap(s + 0.13 * L), lateral: sc.lateral || 0, halfWidth: (sc.width || 5) / 2, note: sc.note };
  });

  // coins: deterministic, alternating side, away from the item box clusters
  const coins = [];
  {
    const rnd = mulberry32((0xC0150 + trackIndex * 7919) >>> 0);
    for (let i = 0; i < RACE.coins.perTrack; i++) {
      const s = wrap((i + 0.5) * (L / RACE.coins.perTrack) + rnd() * 12 - 6);
      const lat = (i % 2 ? 1 : -1) * (half - 2.2) * (0.4 + rnd() * 0.6);
      const p = at(s, lat);
      coins.push({ x: p.x, y: p.y + 0.85, z: p.z, s, lateral: lat });
    }
  }

  // 6. start grid: 2 columns x 4 rows, staggered, all behind the line, slot 0 on pole
  const gridSlots = [];
  for (let i = 0; i < 8; i++) {
    const row = Math.floor(i / 2), col = i % 2;
    const s = wrap(L - 7 - row * 6.5 - (col ? 3.2 : 0));
    const lat = col ? 3.0 : -3.0;
    const p = at(s, lat);
    gridSlots.push({ x: p.x, y: p.y, z: p.z, heading: Math.atan2(p.tx, p.tz) });
  }

  // 7. surface + progress queries
  const CELL = 10;
  const grid = new Map();
  const key = (cx, cz) => cx * 100003 + cz;
  const RADIUS = half + RUNOFF + 8;                 // largest offset we ever need to resolve
  for (let k = 0; k < M; k++) {
    const c0x = Math.floor((px[k] - RADIUS) / CELL), c1x = Math.floor((px[k] + RADIUS) / CELL);
    const c0z = Math.floor((pz[k] - RADIUS) / CELL), c1z = Math.floor((pz[k] + RADIUS) / CELL);
    for (let cx = c0x; cx <= c1x; cx++) for (let cz = c0z; cz <= c1z; cz++) {
      const kk = key(cx, cz);
      let arr = grid.get(kk);
      if (!arr) { arr = []; grid.set(kk, arr); }
      arr.push(k);
    }
  }

  function nearestIndex(x, z) {
    const arr = grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    let best = -1, bestD = Infinity;
    if (arr) {
      for (let i = 0; i < arr.length; i++) {
        const k = arr[i];
        const d = (px[k] - x) * (px[k] - x) + (pz[k] - z) * (pz[k] - z);
        if (d < bestD) { bestD = d; best = k; }
      }
    }
    if (best < 0) {
      // off in the weeds: coarse sweep then a local refine (still O(M/16), and rare)
      let coarse = 0;
      for (let k = 0; k < M; k += 16) {
        const d = (px[k] - x) * (px[k] - x) + (pz[k] - z) * (pz[k] - z);
        if (d < bestD) { bestD = d; coarse = k; }
      }
      for (let o = -24; o <= 24; o++) {
        const k = ((coarse + o) % M + M) % M;
        const d = (px[k] - x) * (px[k] - x) + (pz[k] - z) * (pz[k] - z);
        if (d < bestD) { bestD = d; best = k; }
      }
    }
    return best;
  }

  // Sub-sample-accurate projection onto the two segments touching the nearest sample.
  function progressAt(x, z) {
    const k = nearestIndex(x, z);
    let bestS = k * step, bestD = Infinity, bestLat = 0;
    for (const o of [-1, 0]) {
      const a = ((k + o) % M + M) % M, b = (a + 1) % M;
      const ax = px[a], az = pz[a];
      const bx = px[b], bz = pz[b];
      const ex = bx - ax, ez = bz - az;
      const segLen2 = ex * ex + ez * ez || 1e-9;
      let t = ((x - ax) * ex + (z - az) * ez) / segLen2;
      t = clamp(t, 0, 1);
      const cx = ax + ex * t, cz = az + ez * t;
      const d = (x - cx) * (x - cx) + (z - cz) * (z - cz);
      if (d < bestD) {
        bestD = d;
        const segLen = Math.sqrt(segLen2);
        bestS = (a + t) * step;
        const ux = ex / segLen, uz = ez / segLen;
        bestLat = (x - cx) * uz + (z - cz) * -ux;   // dot with left normal (uz, -ux)
      }
    }
    return { s: wrap(bestS), lateral: bestLat, index: k, dist: Math.sqrt(bestD) };
  }

  function pointAt(s) {
    const ss = wrap(s);
    const f = ss / step;
    const k = Math.floor(f) % M, k2 = (k + 1) % M, t = f - Math.floor(f);
    // shortest-path lerp of the tangent across the wrap
    let tx1 = tx[k], tz1 = tz[k];
    if (tx[k] * tx[k2] + tz[k] * tz[k2] < 0) { tx1 = -tx1; tz1 = -tz1; }
    let vx = lerp(tx1, tx[k2], t), vz = lerp(tz1, tz[k2], t);
    const len = Math.hypot(vx, vz) || 1e-9; vx /= len; vz /= len;
    return {
      x: lerp(px[k], px[k2], t), y: lerp(hy[k], hy[k2], t), z: lerp(pz[k], pz[k2], t),
      tx: vx, tz: vz, nx: vz, nz: -vx,
      curvature: lerp(curv[k], curv[k2], t), s: ss,
    };
  }

  function baseHeightAt(s) {
    const f = wrap(s) / step;
    const k = Math.floor(f) % M, k2 = (k + 1) % M, t = f - Math.floor(f);
    return lerp(hy[k], hy[k2], t);
  }

  function rampRise(s, lateral) {
    for (const r of ramps) {
      const d = ((s - r.s + L + L / 2) % L) - L / 2;     // signed shortest distance
      if (d > -r.halfLen && d < r.halfLen && Math.abs(lateral - r.lateral) < r.halfWidth) {
        const t = (d + r.halfLen) / (2 * r.halfLen);
        return r.height * Math.pow(clamp(t, 0, 1), 1.5);
      }
    }
    return 0;
  }

  const surfaceAt = (x, z) => surfaceOf(progressAt(x, z));

  function surfaceOf(pr) {
    const s = pr.s, lat = pr.lateral;
    for (const r of ramps) {
      const d = ((s - r.s + L + L / 2) % L) - L / 2;
      if (d > -r.halfLen && d < r.halfLen && Math.abs(lat - r.lateral) < r.halfWidth) return 'ramp';
    }
    for (const b of boostPads) {
      const span = ((b.s1 - b.s0) % L + L) % L;
      const d = ((s - b.s0) % L + L) % L;
      if (d <= span && Math.abs(lat - b.lateral) < b.halfWidth) return 'boost';
    }
    if (Math.abs(lat) <= half) return 'road';
    for (const sc of shortcuts) {
      const span = ((sc.s1 - sc.s0) % L + L) % L;
      const d = ((s - sc.s0) % L + L) % L;
      if (d <= span && Math.abs(lat - sc.lateral) < sc.halfWidth) return 'shortcut';
    }
    if (Math.abs(lat) <= half + RUNOFF) return 'grass';
    return 'wall';
  }

  const y = (x, z) => {
    const pr = progressAt(x, z);
    return baseHeightAt(pr.s) + rampRise(pr.s, pr.lateral);
  };

  // 8. meshSpec — plain numbers the renderer turns into BufferGeometry. No THREE here.
  const verts = [], idx = [];
  for (let k = 0; k < M; k++) {
    const lx = px[k] + nx[k] * half, lz = pz[k] + nz[k] * half;
    const rx = px[k] - nx[k] * half, rz = pz[k] - nz[k] * half;
    const yy = hy[k];
    let yl = yy, yr = yy;
    for (const r of ramps) {
      const d = ((k * step - r.s + L + L / 2) % L) - L / 2;
      if (d > -r.halfLen && d < r.halfLen) {
        const t = (d + r.halfLen) / (2 * r.halfLen);
        const rise = r.height * Math.pow(clamp(t, 0, 1), 1.5);
        if (Math.abs(half - r.lateral) < r.halfWidth) yl = yy + rise;
        if (Math.abs(-half - r.lateral) < r.halfWidth) yr = yy + rise;
      }
    }
    verts.push(lx, yl, lz, rx, yr, rz);
  }
  // road surface (two triangles per sample-to-sample span, wrapping the loop)
  for (let k = 0; k < M; k++) {
    const k2 = (k + 1) % M;
    const a = k * 2, b = k * 2 + 1, c = k2 * 2, d = k2 * 2 + 1;
    idx.push(a, c, b, b, c, d);
  }
  // kerbs: a raised strip just outside each road edge
  const kverts = [], kidx = [];
  const KW = 0.85, KH = 0.08;
  for (let k = 0; k < M; k++) {
    const yy = hy[k];
    kverts.push(px[k] + nx[k] * half, yy, pz[k] + nz[k] * half,
      px[k] + nx[k] * (half + KW), yy + KH, pz[k] + nz[k] * (half + KW),
      px[k] - nx[k] * half, yy, pz[k] - nz[k] * half,
      px[k] - nx[k] * (half + KW), yy + KH, pz[k] - nz[k] * (half + KW));
  }
  for (let k = 0; k < M; k++) {
    const k2 = (k + 1) % M;
    kidx.push(k * 4, k2 * 4, k * 4 + 1, k * 4 + 1, k2 * 4, k2 * 4 + 1);
    kidx.push(k * 4 + 2, k * 4 + 3, k2 * 4 + 2, k * 4 + 3, k2 * 4 + 3, k2 * 4 + 2);
  }
  // walls: one segment every 4th sample, so the renderer can instance them cheaply
  const walls = [];
  for (let k = 0; k < M; k += 4) {
    const k2 = (k + 4) % M;
    const wl = half + RUNOFF;
    for (const side of [1, -1]) {
      const ax = px[k] + nx[k] * wl * side, az = pz[k] + nz[k] * wl * side;
      const bx = px[k2] + nx[k2] * wl * side, bz = pz[k2] + nz[k2] * wl * side;
      walls.push({
        x: (ax + bx) / 2, y: hy[k], z: (az + bz) / 2,
        len: Math.hypot(bx - ax, bz - az) + 0.2,
        rot: Math.atan2(bx - ax, bz - az), side,
      });
    }
  }
  // scenery: deterministic, both sides, kept clear of the racing surface
  const scenery = [];
  {
    const rnd = mulberry32((trackIndex + 1) * 262147);
    const kinds = (def.scenery && def.scenery.kinds) || ['pine'];
    const density = (def.scenery && def.scenery.density) || 1;
    const count = Math.round(M * 0.5 * density);
    for (let i = 0; i < count; i++) {
      const s = (i / count) * L + rnd() * 6;
      const side = rnd() < 0.5 ? 1 : -1;
      const lat = side * (half + RUNOFF + 2.5 + rnd() * 26);
      const p = at(s, lat);
      scenery.push({
        kind: kinds[Math.floor(rnd() * kinds.length)],
        x: p.x, y: p.y, z: p.z,
        rot: rnd() * Math.PI * 2,
        scale: 0.75 + rnd() * 0.7,
        side,
      });
    }
  }

  const gate = (() => {
    const p = at(0, 0);
    return { x: p.x, y: p.y, z: p.z, rot: Math.atan2(p.tx, p.tz), width: def.width };
  })();

  return {
    index: trackIndex, id: def.id, name: def.name, theme: def.theme,
    laps: def.laps, halfWidth: half, width: def.width,
    length: L, sampleCount: M, spacing: step,
    samples: Array.from({ length: M }, (_, k) => ({
      x: px[k], z: pz[k], y: hy[k], tx: tx[k], tz: tz[k], nx: nx[k], nz: nz[k],
      curvature: curv[k], s: k * step,
    })),
    y, pointAt, progressAt, surfaceAt, surfaceOf, baseHeightAt, rampRise,
    gridSlots, itemBoxes, boostPads, ramps, shortcuts, coins,
    meshSpec: { verts, idx, kerbs: { verts: kverts, idx: kidx }, walls, scenery, gate, halfWidth: half },
    runoff: RUNOFF,
  };
}

export function trackBounds(track) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const s of track.samples) {
    if (s.x < minX) minX = s.x;
    if (s.x > maxX) maxX = s.x;
    if (s.z < minZ) minZ = s.z;
    if (s.z > maxZ) maxZ = s.z;
  }
  return { minX, maxX, minZ, maxZ, width: maxX - minX, depth: maxZ - minZ };
}

export default buildTrack;
