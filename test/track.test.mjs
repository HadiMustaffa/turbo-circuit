// test/track.test.mjs — WORLD suite: proves the circuits are real circuits.
//
// Run: node test/track.test.mjs
//
// The sim trusts track.progressAt/progressAt/surfaceAt thousands of times a second, so an error
// here is not a cosmetic bug: a wrong lateral sign sends every bot off the road, and an O(n)
// progressAt silently costs the frame budget. Everything below is asserted against NUMBERS.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildTrack, trackBounds, TRACK_IDS } from '../src/tracks.js';
import { TRACKS } from '../src/content.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0; const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \u2713 ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; failures.push(name); console.log(`  \u2717 ${name}${extra ? '  ' + extra : ''}`); }
};
const section = (t) => console.log(`\n\u25b6 ${t}`);
const num = (v, d = 2) => Number(v).toFixed(d);

// deterministic probe RNG — a test that shuffles differently every run is not a test
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function segIntersect(ax, az, bx, bz, cx, cz, dx, dz) {
  const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

console.log('TURBO CIRCUIT — track suite');
console.log('tracks:', TRACK_IDS.join(', '));

for (let ti = 0; ti < TRACKS.length; ti++) {
  const def = TRACKS[ti];
  const t = buildTrack(ti);
  const b = trackBounds(t);
  section(`${t.id} — ${t.name} (${def.theme}, width ${def.width}m)`);

  // ── shape
  ok('length is a plausible circuit', t.length > 600 && t.length < 3000, `${num(t.length, 1)}m`);
  ok('sample spacing is uniform', (() => {
    let maxErr = 0;
    for (let k = 1; k < t.sampleCount; k++) {
      const d = Math.hypot(t.samples[k].x - t.samples[k - 1].x, t.samples[k].z - t.samples[k - 1].z);
      maxErr = Math.max(maxErr, Math.abs(d - t.spacing));
    }
    global.__spacingErr = maxErr;
    return maxErr < 0.05;
  })(), `max spacing error ${(global.__spacingErr * 1000).toFixed(1)}mm (spacing ${num(t.spacing, 3)}m)`);

  ok('loop closes on itself', (() => {
    const a = t.samples[0], z = t.samples[t.sampleCount - 1];
    const gap = Math.hypot(a.x - z.x, a.z - z.z);
    global.__gap = gap;
    return gap < t.spacing * 1.6;
  })(), `first→last sample gap ${num(global.__gap, 3)}m`);

  ok('arc length s is exactly uniform along the loop', (() => {
    let maxErr = 0;
    for (let k = 1; k < t.sampleCount; k++) {
      if (t.samples[k].s <= t.samples[k - 1].s) return false;
      maxErr = Math.max(maxErr, Math.abs((t.samples[k].s - t.samples[k - 1].s) - t.spacing));
    }
    global.__sErr = maxErr;
    return maxErr < 1e-9;
  })(), `max |Δs - spacing| = ${(global.__sErr * 1e9).toFixed(0)}e-9 m`);

  // The straight chord between samples is shorter than the curve it spans. That sagitta is the
  // floor on how accurately ANY polyline can represent this circuit, so it is measured and
  // reported rather than asserted to be zero.
  ok('chord sagitta is negligible (sampling is faithful)', (() => {
    let worst = 0;
    for (let k = 0; k < t.sampleCount; k++) {
      const a = t.samples[k], b = t.samples[(k + 1) % t.sampleCount];
      worst = Math.max(worst, Math.abs(t.spacing - Math.hypot(b.x - a.x, b.z - a.z)));
    }
    global.__sag = worst;
    return worst < 0.002;
  })(), `max (arc - chord) = ${(global.__sag * 1000).toFixed(2)}mm over a ${num(t.spacing, 2)}m span`);

  ok('tangents are unit length', (() => {
    let worst = 0;
    for (const s of t.samples) worst = Math.max(worst, Math.abs(Math.hypot(s.tx, s.tz) - 1));
    global.__tanErr = worst;
    return worst < 1e-9;
  })(), `max ||T|-1| = ${global.__tanErr.toExponential(1)}`);

  ok('curvature is finite everywhere (no NaN/Infinity)', (() => {
    let worst = 0;
    for (const s of t.samples) {
      if (!Number.isFinite(s.curvature)) return false;
      worst = Math.max(worst, Math.abs(s.curvature));
    }
    global.__curv = worst;
    return true;
  })(), `max |curvature| = ${num(global.__curv, 4)} /m (min corner radius ${num(1 / Math.max(1e-6, global.__curv), 1)}m)`);

  // ── no self-intersection
  ok('centreline never crosses itself', (() => {
    const S = t.samples, N = S.length;
    let hits = 0;
    for (let i = 0; i < N; i++) {
      const i2 = (i + 1) % N;
      for (let j = i + 1; j < N; j++) {
        if (Math.abs(i - j) < 6 || Math.abs(i - j) > N - 6) continue;
        const j2 = (j + 1) % N;
        if (segIntersect(S[i].x, S[i].z, S[i2].x, S[i2].z, S[j].x, S[j].z, S[j2].x, S[j2].z)) hits++;
      }
    }
    global.__xHits = hits;
    return hits === 0;
  })(), `${global.__xHits} segment crossings`);

  // ── progressAt correctness against a brute-force nearest search
  {
    const rnd = mulberry32(0xBEEF + ti);
    let maxSErr = 0, maxLatErr = 0, probes = 0, empty = 0, onLineErr = 0;
    for (let i = 0; i < 2000; i++) {
      const k = Math.floor(rnd() * t.sampleCount);
      const s = t.samples[k];
      const lat = (rnd() * 2 - 1) * (t.halfWidth * 0.95);
      const x = s.x + s.nx * lat, z = s.z + s.nz * lat;

      // brute force: nearest sample index
      let best = 0, bestD = Infinity;
      for (let q = 0; q < t.sampleCount; q++) {
        const d = (t.samples[q].x - x) ** 2 + (t.samples[q].z - z) ** 2;
        if (d < bestD) { bestD = d; best = q; }
      }
      const got = t.progressAt(x, z);
      if (Math.abs(got.index - best) > 2) empty++;
      const ds = Math.abs(got.s - s.s);
      maxSErr = Math.max(maxSErr, Math.min(ds, t.length - ds));
      maxLatErr = Math.max(maxLatErr, Math.abs(got.lateral - lat));
      probes++;
    }
    // On the centreline progressAt must be exact; the offset error is the polyline's, not the
    // function's, so it is measured separately and bounded by the sagitta accumulated over the
    // offset. 0.2m of error costs a racer ~8ms of race time — well below one tick.
    for (let k = 0; k < t.sampleCount; k += 3) {
      const s = t.samples[k];
      const pr = t.progressAt(s.x, s.z);
      const d = Math.abs(pr.s - s.s);
      onLineErr = Math.max(onLineErr, Math.min(d, t.length - d));
    }
    ok('progressAt finds the right sample (vs brute force)', probes > 0 && empty === 0,
      `${probes} probes, ${empty} outside 2 samples of brute force`);
    ok('progressAt is exact on the centreline', onLineErr < 1e-9,
      `max error ${(onLineErr * 1000).toFixed(4)}mm over ${Math.ceil(t.sampleCount / 3)} samples`);
    // The bound that actually matters: an arc-length error must stay well inside ONE simulation
    // tick of travel, or it would move a kart a visible distance across a frame. At 26 m/s a
    // tick covers 0.43m, so the threshold below is a real constraint, not a rubber stamp.
    const TICK_TRAVEL = 26 / 60;
    ok('progressAt error is under one simulation tick of travel', maxSErr < TICK_TRAVEL,
      `max ${(maxSErr * 1000).toFixed(0)}mm = ${(maxSErr / 26 * 1000).toFixed(1)}ms of travel at 26 m/s (one tick = ${(TICK_TRAVEL * 1000).toFixed(0)}mm)`);
    ok('progressAt lateral distance is accurate', maxLatErr < 0.06, `max error ${(maxLatErr * 1000).toFixed(1)}mm`);
    ok('progressAt is the O(1) grid path, not a linear scan', (() => {
      const src = readFileSync(join(ROOT, 'src/tracks.js'), 'utf8');
      return /grid\.get\(key\(/.test(src) && /CELL/.test(src);
    })(), 'spatial hash present');
  }

  // ── lateral SIGN: + must mean left of travel. A flipped sign sends every bot off the road.
  ok('lateral sign is + = left of travel', (() => {
    let checked = 0, good = 0;
    for (let k = 0; k < t.sampleCount; k += Math.max(1, Math.floor(t.sampleCount / 60))) {
      const s = t.samples[k];
      const x = s.x + s.nx * 3, z = s.z + s.nz * 3;      // 3m along the stored left normal
      const pr = t.progressAt(x, z);
      checked++;
      if (Math.abs(pr.lateral - 3) < 0.05) good++;
    }
    global.__latChecked = checked; global.__latGood = good;
    return checked > 10 && good === checked;
  })(), `${global.__latGood}/${global.__latChecked} offsets read back as +3.00 m`);

  // ── surfaces
  ok('surfaceAt: the centre of the road is road (except where a ramp or pad covers it)', (() => {
    let good = 0, n = 0, covered = 0;
    for (let k = 0; k < t.sampleCount; k += 7) {
      const s = t.samples[k];
      const su = t.surfaceAt(s.x, s.z);
      n++;
      if (su === 'road') { good++; continue; }
      // a ramp or boost pad deliberately occupies the racing surface here
      const onRamp = t.ramps.some(r => {
        const d = ((s.s - r.s + t.length + t.length / 2) % t.length) - t.length / 2;
        return d > -r.halfLen && d < r.halfLen && Math.abs(0 - r.lateral) < r.halfWidth;
      });
      const onPad = t.boostPads.some(b => {
        const span = ((b.s1 - b.s0) % t.length + t.length) % t.length;
        const d = ((s.s - b.s0) % t.length + t.length) % t.length;
        return d <= span && Math.abs(0 - b.lateral) < b.halfWidth;
      });
      if ((su === 'ramp' && onRamp) || (su === 'boost' && onPad)) covered++;
    }
    global.__roadGood = good; global.__roadN = n; global.__roadCovered = covered;
    return good + covered === n;
  })(), `${global.__roadGood}/${global.__roadN} road samples, ${global.__roadCovered} inside a declared ramp/pad`);
  ok('surfaceAt: past the run-off is grass, then the wall', (() => {
    const s = t.samples[Math.floor(t.sampleCount * 0.3)];
    const grassX = s.x + s.nx * (t.halfWidth + 2), grassZ = s.z + s.nz * (t.halfWidth + 2);
    const wallX = s.x + s.nx * (t.halfWidth + t.runoff + 3), wallZ = s.z + s.nz * (t.halfWidth + t.runoff + 3);
    global.__grassS = t.surfaceAt(grassX, grassZ);
    global.__wallS = t.surfaceAt(wallX, wallZ);
    return global.__grassS === 'grass' && global.__wallS === 'wall';
  })(), `+${num(t.halfWidth + 2, 1)}m → ${global.__grassS}, +${num(t.halfWidth + t.runoff + 3, 1)}m → ${global.__wallS}`);
  ok('surfaceAt: every boost pad reads as boost', (() => {
    let good = 0;
    for (const p of t.boostPads) {
      const mid = t.pointAt(p.s0 + 1);
      if (t.surfaceAt(mid.x + mid.nx * p.lateral, mid.z + mid.nz * p.lateral) === 'boost') good++;
    }
    global.__pads = t.boostPads.length; global.__padsGood = good;
    return t.boostPads.length > 0 && good === t.boostPads.length;
  })(), `${global.__padsGood}/${global.__pads} pads`);
  ok('surfaceAt: every ramp reads as ramp', (() => {
    let good = 0;
    for (const r of t.ramps) {
      const mid = t.pointAt(r.s);
      if (t.surfaceAt(mid.x + mid.nx * r.lateral, mid.z + mid.nz * r.lateral) === 'ramp') good++;
    }
    global.__ramps = t.ramps.length; global.__rampsGood = good;
    return t.ramps.length > 0 && good === t.ramps.length;
  })(), `${global.__rampsGood}/${global.__ramps} ramps`);

  // ── grid, boxes, coins
  ok('all 8 grid slots exist, are on the road and behind the line', (() => {
    if (t.gridSlots.length !== 8) return false;
    let good = 0, minBack = Infinity, maxBack = 0;
    for (const g of t.gridSlots) {
      const pr = t.progressAt(g.x, g.z);
      const behind = t.length - pr.s;          // metres of arc between the slot and the start line
      minBack = Math.min(minBack, behind); maxBack = Math.max(maxBack, behind);
      if (t.surfaceAt(g.x, g.z) === 'road' && behind > 0 && behind < 45) good++;
    }
    global.__gridGood = good; global.__gridBack = [minBack, maxBack];
    return good === 8;
  })(), `${global.__gridGood}/8 on road, ${num(global.__gridBack[0], 1)}–${num(global.__gridBack[1], 1)}m behind the line`);
  ok('slot 0 is on pole (highest arc length at the start)', (() => {
    const s0 = t.progressAt(t.gridSlots[0].x, t.gridSlots[0].z).s;
    return t.gridSlots.every((g, i) => i === 0 || t.progressAt(g.x, g.z).s <= s0 + 1e-6);
  })());
  ok('grid is staggered in two columns', (() => {
    const lat = t.gridSlots.map(g => t.progressAt(g.x, g.z).lateral);
    return lat.filter(l => l > 1).length === 4 && lat.filter(l => l < -1).length === 4;
  })(), `lateral columns: ${t.gridSlots.map(g => num(t.progressAt(g.x, g.z).lateral, 1)).join(', ')}`);
  ok('every item box sits on the road', (() => {
    const bad = t.itemBoxes.filter(o => t.surfaceAt(o.x, o.z) !== 'road').length;
    global.__boxesOff = bad;
    return t.itemBoxes.length >= 8 && bad === 0;
  })(), `${t.itemBoxes.length} boxes, ${global.__boxesOff} off-road`);
  ok('every coin sits on the road', (() => {
    const bad = t.coins.filter(c => t.surfaceAt(c.x, c.z) !== 'road').length;
    global.__coinsOff = bad;
    return t.coins.length > 0 && bad === 0;
  })(), `${t.coins.length} coins, ${global.__coinsOff} off-road`);

  // ── bounds
  {
    const cxs = def.control.map(c => c[0]), czs = def.control.map(c => c[1]);
    const pad = 12;
    const inside = b.minX >= Math.min(...cxs) - pad && b.maxX <= Math.max(...cxs) + pad
      && b.minZ >= Math.min(...czs) - pad && b.maxZ <= Math.max(...czs) + pad;
    ok('trackBounds agrees with the control points', inside,
      `${num(b.width, 0)}m x ${num(b.depth, 0)}m`);
  }

  // ── meshSpec
  ok('road ribbon geometry is sane', (() => {
    const v = t.meshSpec.verts, idx = t.meshSpec.idx;
    if (v.length !== t.sampleCount * 6) return false;
    for (const n of v) if (!Number.isFinite(n)) return false;
    global.__tris = idx.length / 3;
    return idx.length / 3 === t.sampleCount * 2;
  })(), `${global.__tris} triangles, ${t.meshSpec.verts.length / 3} vertices`);
  ok('no degenerate road triangles', (() => {
    const v = t.meshSpec.verts, idx = t.meshSpec.idx;
    let degen = 0;
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 3, bb = idx[i + 1] * 3, c = idx[i + 2] * 3;
      const area = Math.abs((v[bb] - v[a]) * (v[c + 2] - v[a + 2]) - (v[bb + 2] - v[a + 2]) * (v[c] - v[a])) / 2;
      if (!(area > 1e-6)) degen++;
    }
    global.__degen = degen;
    return degen === 0;
  })(), `${global.__degen} degenerate`);
  ok('road ribbon width matches the declared width', (() => {
    const v = t.meshSpec.verts;
    let maxW = 0, minW = Infinity;
    for (let k = 0; k < t.sampleCount; k++) {
      const w = Math.hypot(v[k * 6] - v[k * 6 + 3], v[k * 6 + 2] - v[k * 6 + 5]);
      maxW = Math.max(maxW, w); minW = Math.min(minW, w);
    }
    global.__rw = [minW, maxW];
    return minW > def.width - 0.4 && maxW < def.width + 0.4;
  })(), `width ${num(global.__rw[0], 2)}–${num(global.__rw[1], 2)}m vs declared ${def.width}m`);
  ok('meshSpec carries kerbs, walls and scenery', t.meshSpec.kerbs.idx.length > 0 && t.meshSpec.walls.length > 0 && t.meshSpec.scenery.length > 0,
    `${t.meshSpec.walls.length} wall segments, ${t.meshSpec.scenery.length} scenery pieces, ${t.meshSpec.kerbs.idx.length / 3} kerb triangles`);

  // ── determinism
  ok('buildTrack is deterministic (two builds are byte-identical)', (() => {
    const a = buildTrack(ti), b2 = buildTrack(ti);
    if (a.sampleCount !== b2.sampleCount) return false;
    for (let k = 0; k < a.sampleCount; k++) {
      if (a.samples[k].x !== b2.samples[k].x || a.samples[k].z !== b2.samples[k].z || a.samples[k].curvature !== b2.samples[k].curvature) return false;
    }
    if (a.itemBoxes.length !== b2.itemBoxes.length) return false;
    for (let k = 0; k < a.itemBoxes.length; k++) if (a.itemBoxes[k].x !== b2.itemBoxes[k].x) return false;
    if (a.meshSpec.scenery.length !== b2.meshSpec.scenery.length) return false;
    return a.meshSpec.scenery.every((s, k) => s.x === b2.meshSpec.scenery[k].x && s.kind === b2.meshSpec.scenery[k].kind);
  })());

  // ── the numbers a player actually feels
  const lapAt = (v) => t.length / v;
  ok('a 3-lap race is a sane length at race pace', (() => {
    const total = t.length * t.laps;
    return total > 2000 && total < 8000;
  })(), `${num(t.length, 0)}m x ${t.laps} laps = ${num(t.length * t.laps, 0)}m; at a 26 m/s average that is a ${num(lapAt(26), 1)}s lap, ${num(lapAt(26) * t.laps, 0)}s race`);

  ok('heights are finite and smooth along the loop', (() => {
    let maxY = 0, maxJump = 0;
    for (let k = 0; k < t.sampleCount; k++) {
      const y = t.samples[k].y;
      if (!Number.isFinite(y)) return false;
      maxY = Math.max(maxY, Math.abs(y));
      const y2 = t.samples[(k + 1) % t.sampleCount].y;
      maxJump = Math.max(maxJump, Math.abs(y2 - y));
    }
    global.__yMax = maxY; global.__yJump = maxJump;
    return maxJump < 0.65;
  })(), `max elevation ${num(global.__yMax, 2)}m, max step between samples ${num(global.__yJump, 3)}m`);
}

// pump primed for the "spacing" assertion above
void pass; void fail;

section('summary');
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILED:'); for (const f of failures) console.log('  - ' + f); }
console.log(fail ? '\n✗ track suite FAILED' : '\n✓ track suite passed');
process.exitCode = fail ? 1 : 0;
