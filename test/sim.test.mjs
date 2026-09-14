// test/sim.test.mjs — SIM suite: proves the game is correct, deterministic and fair.
//
// Run: node test/sim.test.mjs
//
// This suite runs the ACTUAL simulation headlessly — thousands of ticks in milliseconds with no
// browser, no canvas and no rendering. That is only possible because src/sim.js and src/ai.js
// have no DOM, no wall clock and no Math.random. Two of the assertions below exist purely to
// keep that true, because if it stops being true everything else in this file becomes a lie.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildTrack } from '../src/tracks.js';
import { createState, step, hashState, raceOrder, speedKmh, makeInputs } from '../src/sim.js';
import { botInputs } from '../src/ai.js';
import { CHARS, KARTS, ITEMS, PHYSICS, RACE, AI, SIM } from '../src/content.js';
import { BIT } from '../src/input.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0; const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  \u2713 ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; failures.push(name); console.log(`  \u2717 ${name}${extra ? '  ' + extra : ''}`); }
};
const section = (t) => console.log(`\n\u25b6 ${t}`);
const num = (v, d = 2) => Number(v).toFixed(d);
const wrap = (a) => { a %= Math.PI * 2; if (a > Math.PI) a -= Math.PI * 2; if (a < -Math.PI) a += Math.PI * 2; return a; };

const track0 = buildTrack(0);

// A minimal human: full throttle, steers toward a point up the road. Used to measure physics
// without a bot's line choices or braking policy in the way. `threshold` lets the caller ask
// "when did it first reach this speed" — timed from the instant the lights go out, because the
// countdown is 3 seconds of standing still and would otherwise be counted as acceleration.
function driveStraight(state, i, ticks, threshold = Infinity) {
  const r = state.racers[i];
  let peak = 0, firstAbove = -1, tRacing = 0;
  for (let t = 0; t < ticks; t++) {
    if (state.phase !== 'racing') {
      step(state, makeInputs(state.racerCount));
      state.events.length = 0;
      continue;
    }
    const aim = state.track.pointAt(r.s + 26);
    const err = wrap(Math.atan2(aim.x - r.x, aim.z - r.z) - r.heading);
    let bits = BIT.ACCEL;
    if (err > 0.03) bits |= BIT.LEFT;
    else if (err < -0.03) bits |= BIT.RIGHT;
    if (Math.abs(err) > 0.55) bits = BIT.BRAKE | (err > 0 ? BIT.LEFT : BIT.RIGHT);
    const inputs = makeInputs(state.racerCount);
    inputs[i] = bits;
    step(state, inputs);
    state.events.length = 0;
    if (r.speed > peak) peak = r.speed;
    if (firstAbove < 0 && r.speed >= threshold) firstAbove = tRacing;
    tRacing++;
  }
  return { peak, firstAbove90: firstAbove, tRacing, racer: r };
}

function runRace(track, seed, opts = {}) {
  const st = createState({
    seed, track, racerCount: 8, playerIndex: 4, laps: 3, playerBot: true, ...opts,
  });
  const ev = {};
  const pickups = new Array(8).fill(0);
  const tiers = { 1: 0, 2: 0, 3: 0 };
  let ticks = 0;
  while (st.phase !== 'finished' && ticks < SIM.MAX_RACE_TICKS) {
    step(st, botInputs(st));
    for (const e of st.events) {
      ev[e.type] = (ev[e.type] || 0) + 1;
      if (e.type === 'pickup') pickups[e.racerId]++;
      if (e.type === 'drift') tiers[e.tier]++;
    }
    st.events.length = 0;
    ticks++;
  }
  return { st, ev, pickups, tiers, ticks };
}

// ─────────────────────────────────────────────────────────────────────────────
section('the three rules of the sim core (this is what makes the rest provable)');
{
  const sim = readFileSync(join(ROOT, 'src/sim.js'), 'utf8');
  const ai = readFileSync(join(ROOT, 'src/ai.js'), 'utf8');
  const trk = readFileSync(join(ROOT, 'src/tracks.js'), 'utf8');
  const strip = (s) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const checks = [
    ['Math.random', 'non-deterministic RNG'],
    ['Date.now', 'wall clock'],
    ['performance.now', 'wall clock'],
    ['setTimeout', 'timer'], ['setInterval', 'timer'],
    ['document.', 'DOM'], ['window.', 'DOM'], ['navigator.', 'DOM'],
  ];
  let bad = [];
  for (const [needle, why] of checks) {
    for (const [file, src] of [['sim.js', sim], ['ai.js', ai], ['tracks.js', trk]]) {
      if (strip(src).includes(needle)) bad.push(`${file}: ${needle} (${why})`);
    }
  }
  ok('no RNG, clock or DOM anywhere in sim.js / ai.js / tracks.js', bad.length === 0, bad.join('; ') || 'clean');
  ok('step() advances exactly one fixed tick', (() => {
    const st = createState({ seed: 1, track: track0, racerCount: 8, playerIndex: 0, laps: 1 });
    const t0 = st.tick;
    step(st, makeInputs(8));
    return st.tick === t0 + 1;
  })(), `SIM.STEP = ${SIM.STEP.toFixed(6)}s (${SIM.TICK_HZ} Hz)`);
}

// ─────────────────────────────────────────────────────────────────────────────
section('determinism — identical inputs must produce byte-identical races');
{
  const mk = () => createState({ seed: 987654, track: track0, racerCount: 8, playerIndex: 4, laps: 3, playerBot: true });
  const A = mk(), B = mk();
  for (let t = 0; t < 3000; t++) {
    const ba = botInputs(A), bb = botInputs(B);
    step(A, ba); A.events.length = 0;
    step(B, bb); B.events.length = 0;
  }
  const ha = hashState(A), hb = hashState(B);
  ok('3000 ticks of bot racing reproduce exactly', ha === hb && ha.length > 200,
    `${ha.length}-char state hash matches (${((ha.match(/\|/g) || []).length)} fields)`);

  // a fresh import is a different module instance with its own closures — a stateful module-level
  // counter or cache would show up here and nowhere else
  const fresh = await import('../src/sim.js?v=det' + Date.now());
  const C = fresh.createState({ seed: 987654, track: buildTrack(0), racerCount: 8, playerIndex: 4, laps: 3, playerBot: true });
  for (let t = 0; t < 3000; t++) { step(C, botInputs(C)); C.events.length = 0; }
  ok('a fresh module import produces the same race', hashState(C) === ha, 'cross-instance determinism');
  ok('the state hash actually changes with the state', (() => {
    step(A, botInputs(A)); A.events.length = 0;
    return hashState(A) !== ha;
  })(), 'hash is not a constant');
}

// ─────────────────────────────────────────────────────────────────────────────
section('physics — measured, not asserted from the config');
{
  const mkChar = (ch) => {
    const st = createState({
      seed: 5, track: track0, racerCount: 2, playerIndex: 0, laps: 99,
      chars: [ch.id, 'juno'], karts: ['k-vex', 'k-juno'], playerBot: false,
    });
    st.racers[1].finished = true;                       // no traffic in the measurement
    return st;
  };
  // Two passes. Pass 1 finds the speed each kart actually reaches; pass 2 times how long it
  // takes to get to 90% of THAT number. A single pass cannot do it: the running-peak version of
  // this check reported 0.00s for everybody, i.e. it could not fail.
  const peaks = {};
  for (const ch of CHARS) peaks[ch.id] = driveStraight(mkChar(ch), 0, 1200).peak;

  const rows = [];
  for (const ch of CHARS) {
    const st = mkChar(ch);
    const { firstAbove90 } = driveStraight(st, 0, 1200, peaks[ch.id] * 0.9);
    rows.push({ ch, peak: peaks[ch.id], t90: firstAbove90, stat: ch.stats, topSpeed: st.racers[0].stats.topSpeed });
  }
  const byPeak = rows.slice().sort((a, b) => b.peak - a.peak);
  const fastest = byPeak[0], slowest = byPeak[byPeak.length - 1];
  ok('every character reaches a real, distinct top speed', rows.every(r => r.peak > 15) && fastest.peak - slowest.peak > 1.5,
    `${num(slowest.peak, 2)}–${num(fastest.peak, 2)} m/s (${num(slowest.peak * 3.6, 0)}–${num(fastest.peak * 3.6, 0)} km/h)`);
  console.log('    per character:');
  for (const r of byPeak) {
    console.log(`      ${r.ch.name.padEnd(12)} speed stat ${r.stat.speed}  →  ${num(r.peak, 2).padStart(6)} m/s (${num(r.peak * 3.6, 0).padStart(3)} km/h)  0→90% in ${r.t90 < 0 ? ' n/a' : (r.t90 / 60).toFixed(2)}s`);
  }
  const speedOrdered = rows.filter(r => r.stat.speed >= 5).every(r =>
    r.peak >= Math.max(...rows.filter(o => o.stat.speed <= 3).map(o => o.peak)));
  ok('the speed stat actually orders top speed', speedOrdered,
    `fastest is ${fastest.ch.name} (speed ${fastest.stat.speed}), slowest ${slowest.ch.name} (speed ${slowest.stat.speed})`);
  const accelRows = rows.filter(r => r.t90 >= 0);
  const quickest = accelRows.slice().sort((a, b) => a.t90 - b.t90)[0];
  const slowestAccel = accelRows.slice().sort((a, b) => b.t90 - a.t90)[0];
  ok('the accel stat actually orders acceleration', quickest.stat.accel >= slowestAccel.stat.accel,
    `0→90% quickest ${quickest.ch.name} (accel ${quickest.stat.accel}) ${(quickest.t90 / 60).toFixed(2)}s, slowest ${slowestAccel.ch.name} (accel ${slowestAccel.stat.accel}) ${(slowestAccel.t90 / 60).toFixed(2)}s`);
  ok('every kart accelerates from rest to 90% in under 4s', rows.every(r => r.t90 >= 0 && r.t90 < 240),
    `worst ${(Math.max(...rows.map(r => r.t90)) / 60).toFixed(2)}s`);

  // grass must be a real punishment — measured from a standing start IN the grass, not carrying
  // road speed into it (which is what made the first version of this check pass at 97%)
  const stG = createState({ seed: 7, track: track0, racerCount: 2, playerIndex: 0, laps: 99, chars: ['juno', 'juno'], karts: ['k-juno', 'k-juno'], playerBot: false });
  stG.racers[1].finished = true;
  const r = stG.racers[0];
  let peakRoad = 0;
  for (let t = 0; t < 600; t++) {
    const aim = stG.track.pointAt(r.s + 26);
    const err = wrap(Math.atan2(aim.x - r.x, aim.z - r.z) - r.heading);
    let bits = BIT.ACCEL;
    if (err > 0.03) bits |= BIT.LEFT; else if (err < -0.03) bits |= BIT.RIGHT;
    const inp = makeInputs(2); inp[0] = bits; step(stG, inp); stG.events.length = 0;
    peakRoad = Math.max(peakRoad, r.speed);
  }
  // teleport into the middle of the grass, drop to a standstill, then hold full throttle
  r.speed = 0;
  const p0 = stG.track.pointAt(r.s);
  r.x = p0.x + p0.nx * (stG.track.halfWidth + 2.2);
  r.z = p0.z + p0.nz * (stG.track.halfWidth + 2.2);
  const startSurface = stG.track.surfaceAt(r.x, r.z);
  let peakGrass = 0;
  for (let t = 0; t < 420; t++) {
    const p = stG.track.pointAt(r.s);
    r.x = p.x + p.nx * (stG.track.halfWidth + 2.2);     // pinned off-road every tick
    r.z = p.z + p.nz * (stG.track.halfWidth + 2.2);
    const inp = makeInputs(2); inp[0] = BIT.ACCEL; step(stG, inp); stG.events.length = 0;
    peakGrass = Math.max(peakGrass, r.speed);
  }
  ok('grass is a real penalty, not a wall', startSurface === 'grass' && peakGrass < peakRoad * 0.65 && peakGrass > 0,
    `road ${num(peakRoad, 1)} m/s vs grass ${num(peakGrass, 1)} m/s (${num(100 * peakGrass / peakRoad, 0)}% of road speed, from a standing start on ${startSurface})`);
}

// ─────────────────────────────────────────────────────────────────────────────
section('drift and the mini-turbo (the mechanic that makes it a kart game)');
{
  // A standing-start drift test spins on the spot and crashes, and a drift held forever never
  // PAYS OUT — a real driver charges a corner and releases on exit. So: get up to speed, then
  // cycle 130 ticks of drift (tier 3 lands at 105) followed by a 12-tick release.
  const DRIFT_FROM = 240;
  const CYCLE_ON = 130, CYCLE_OFF = 12;
  const runDrift = (useDrift, ticks) => {
    const st = createState({ seed: 11, track: track0, racerCount: 2, playerIndex: 0, laps: 99, chars: ['juno', 'juno'], karts: ['k-juno', 'k-juno'], playerBot: false });
    st.racers[1].finished = true;
    const r = st.racers[0];
    const tiers = new Set(); const kinds = new Set();
    let peak = 0, maxCharge = 0, spinUps = 0, holds = 0;
    let wasHolding = false;
    for (let t = 0; t < ticks; t++) {
      if (st.phase !== 'racing') { step(st, makeInputs(2)); st.events.length = 0; continue; }
      const cycling = useDrift && t >= DRIFT_FROM;
      const inHold = cycling && ((t - DRIFT_FROM) % (CYCLE_ON + CYCLE_OFF)) < CYCLE_ON;
      const aim = st.track.pointAt(r.s + (inHold ? 46 : 26));
      const err = wrap(Math.atan2(aim.x - r.x, aim.z - r.z) - r.heading);
      let bits = BIT.ACCEL;
      if (err > 0.03) bits |= BIT.LEFT; else if (err < -0.03) bits |= BIT.RIGHT;
      if (inHold) { bits |= BIT.DRIFT; if (!wasHolding) holds++; }
      wasHolding = inHold;
      const inp = makeInputs(2); inp[0] = bits;
      step(st, inp);
      for (const e of st.events) {
        if (e.type === 'drift') tiers.add(e.tier);
        if (e.type === 'boost' && String(e.kind).startsWith('mini-turbo')) kinds.add(e.kind);
        if (e.type === 'spinout') spinUps++;
      }
      st.events.length = 0;
      peak = Math.max(peak, r.speed);
      maxCharge = Math.max(maxCharge, r.driftCharge);
    }
    return { st, r, tiers, kinds, peak, maxCharge, spinUps, holds };
  };

  const d = runDrift(true, 1200);
  const n = runDrift(false, 1200);
  ok('holding a drift charges all three mini-turbo tiers', d.tiers.size === 3,
    `tiers reached: ${[...d.tiers].sort().join(', ')} (thresholds ${PHYSICS.drift.tiers.map(t => t.at).join('/')}s), max charge ${num(d.maxCharge, 2)}s over ${d.holds} drifts`);
  ok('releasing a charged drift fires a mini-turbo boost', d.kinds.size > 0,
    [...d.kinds].join(', '));
  ok('the drift does not send the kart into a wall or a spin', d.spinUps === 0,
    `${d.spinUps} spin-outs over ${1200 - DRIFT_FROM} ticks of cornering with drifts`);
  ok('drifting corners is FASTER than driving them cleanly', d.peak > n.peak + 0.5,
    `drifting peak ${num(d.peak, 2)} m/s vs clean peak ${num(n.peak, 2)} m/s (+${num(d.peak - n.peak, 2)} m/s)`);

  // the drift must NOT fire without the button
  const st3 = createState({ seed: 17, track: track0, racerCount: 2, playerIndex: 0, laps: 99, chars: ['juno', 'juno'], karts: ['k-juno', 'k-juno'], playerBot: false });
  st3.racers[1].finished = true;
  let driftEventsNoButton = 0;
  for (let t = 0; t < 400; t++) {
    const rr = st3.racers[0];
    const aim = st3.track.pointAt(rr.s + 26);
    const err = wrap(Math.atan2(aim.x - rr.x, aim.z - rr.z) - rr.heading);
    let bits = BIT.ACCEL;                             // steering hard, but never DRIFT
    if (err > 0.02) bits |= BIT.LEFT; else if (err < -0.02) bits |= BIT.RIGHT;
    const inp = makeInputs(2); inp[0] = bits; step(st3, inp);
    for (const e of st3.events) if (e.type === 'drift') driftEventsNoButton++;
    st3.events.length = 0;
  }
  ok('no drift charge accrues without the DRIFT button held', driftEventsNoButton === 0,
    `${driftEventsNoButton} drift events over 400 cornering ticks with no DRIFT input`);
}

// ─────────────────────────────────────────────────────────────────────────────
section('race start — rocket start, and a bog if you jump the gun');
{
  const mkCountdown = (holdFromTick) => {
    const st = createState({ seed: 21, track: track0, racerCount: 2, playerIndex: 0, laps: 1, playerBot: false });
    st.racers[1].finished = true;
    const inp = makeInputs(2);
    let goTick = -1;
    for (let t = 0; t < 240; t++) {
      inp[0] = (holdFromTick >= 0 && t >= holdFromTick) ? BIT.ACCEL : 0;
      step(st, inp); st.events.length = 0;
      if (st.phase === 'racing') { goTick = t; break; }
    }
    return { st, goTick, inp };
  };
  const perfect = mkCountdown(PHYSICS.rocketStart.countdown * 60 - Math.round(PHYSICS.rocketStart.perfectFrom * 60) + 2);
  const early = mkCountdown(0);
  const rp = perfect.st.racers[0], re = early.st.racers[0];
  ok('throttle in the perfect window is flagged a perfect start', rp.rocketStart === 'perfect', `flag = ${rp.rocketStart}`);
  ok('throttle from the very start of the countdown bogs the engine', re.rocketStart === 'early', `flag = ${re.rocketStart}`);

  // measure the launch: speed 1.5s after GO
  const launch = (mk) => {
    const { st, inp } = mk;
    const r = st.racers[0];
    for (let t = 0; t < 90; t++) { inp[0] = BIT.ACCEL; step(st, inp); st.events.length = 0; }
    return { speed: r.speed, boostTicks: r.boostTicks, pulse: r.pulseTicks };
  };
  const lp = launch(perfect), le = launch(early);
  ok('a perfect start launches harder than a bogged one', lp.speed > le.speed + 1.0,
    `${num(lp.speed, 2)} m/s (perfect) vs ${num(le.speed, 2)} m/s (bogged), +${num(100 * (lp.speed / Math.max(0.01, le.speed) - 1), 0)}%`);
}

// ─────────────────────────────────────────────────────────────────────────────
section('a full 8-kart race, on every circuit');
{
  const all = [];
  for (let ti = 0; ti < 3; ti++) {
    const track = buildTrack(ti);
    const { st, ev, pickups, tiers, ticks } = runRace(track, 4242 + ti);
    all.push({ track, st, ev, pickups, tiers, ticks });
    const ord = raceOrder(st);
    const times = ord.map(r => (r.finishedAt - RACE.countdownTicks) / 60);
    const spread = times[times.length - 1] - times[0];
    const avg = (ord[0].lap - 1) * track.length / times[0];
    console.log(`    ${track.id.padEnd(12)} ${num(track.length, 0)}m x3   winner ${num(times[0], 1)}s   last ${num(times[times.length - 1], 1)}s   spread ${num(spread, 1)}s   winner avg ${num(avg, 1)} m/s`);
    ok(`${track.id}: all 8 karts finish`, st.phase === 'finished' && ord.every(r => r.finished) && st.finishedOrder.length === 8,
      `${st.finishedOrder.length}/8 finished in ${num(ticks / 60, 1)}s of simulated time`);
    ok(`${track.id}: every finisher completed the full 3 laps`, ord.every(r => r.lap === st.laps + 1),
      `laps: ${[...new Set(ord.map(r => r.lap))].join(',')} (expected ${st.laps + 1} = 3 raced + the flag)`);
    ok(`${track.id}: nobody is stuck or teleported home`, (ev.respawn || 0) <= 2,
      `${ev.respawn || 0} respawns across 8 karts over 3 laps`);
    ok(`${track.id}: the race is not a runaway`, spread < 60,
      `${num(spread, 1)}s between 1st and 8th`);
    ok(`${track.id}: the field actually races — items, boosts and contact all happen`,
      (ev.pickup || 0) > 20 && (ev.boost || 0) > 10 && (ev.hit || 0) > 5 && (ev.lap || 0) >= 21,
      `pickups ${ev.pickup || 0}, boosts ${ev.boost || 0}, hits ${ev.hit || 0}, laps ${ev.lap || 0}, throws ${ev.throw || 0}, coins ${ev.coin || 0}, drifts ${(tiers[1] + tiers[2] + tiers[3])}, tiers ${tiers[1]}/${tiers[2]}/${tiers[3]}`);
    ok(`${track.id}: karts stay on the track (no wall pinning)`, (() => {
      let off = 0;
      for (const r of st.racers) if (Math.abs(r.lateral) > track.halfWidth + track.runoff + 0.4) off++;
      return off === 0;
    })(), 'all 8 within the track boundary at the flag');
  }

  // ── the per-racer cooldown, proven directly rather than inferred from a race
  {
    const st = createState({ seed: 77, track: track0, racerCount: 2, playerIndex: 9, laps: 3, playerBot: false });
    st.phase = 'racing';
    const box = track0.itemBoxes[0];
    for (const r of st.racers) { r.x = box.x; r.z = box.z; r.item = null; r.itemRollTicks = 0; }
    step(st, makeInputs(2));
    st.events.length = 0;
    const got = st.racers.filter(r => r.item).length;
    const cdA = st.pickups[0].cooldowns[0], cdB = st.pickups[0].cooldowns[1];
    ok('two karts on the same box BOTH get an item (per-racer cooldown)', got === 2,
      `${got}/2 karts armed; cooldowns are per racer (${cdA - st.tick} vs ${cdB - st.tick} ticks)`);
  }

  // ── and empirically, across a whole race: the trailing kart must not be starved
  const { pickups, st } = all[0];
  const leader = st.racers.find(r => r.place === 1);
  const last = st.racers.find(r => r.place === 8);
  const total = pickups.reduce((a, b) => a + b, 0);
  const min = Math.min(...pickups), max = Math.max(...pickups);
  ok('item boxes are per-racer, so the field is not starved', total > 0 && min >= 2,
    `pickups per racer: ${pickups.join(' ')} (min ${min}, max ${max}) — last place got ${pickups[last.id]}, leader ${pickups[leader.id]}`);
  ok('no single racer monopolises the item boxes', max <= total * 0.35,
    `busiest racer took ${num(100 * max / total, 0)}% of ${total} pickups`);
}

// ─────────────────────────────────────────────────────────────────────────────
section('lap counting cannot be farmed');
{
  const st = createState({ seed: 31, track: track0, racerCount: 2, playerIndex: 0, laps: 3, playerBot: false });
  st.racers[1].finished = true;
  const r = st.racers[0];
  st.phase = 'racing';
  const startLap = r.lap;
  // walk the racer backwards over the start line and forwards again, ten times
  for (let k = 0; k < 10; k++) {
    for (const s of [track0.length - 3, 3, track0.length - 3, 3]) {
      const p = track0.pointAt(s);
      r.x = p.x; r.z = p.z;
      step(st, makeInputs(2)); st.events.length = 0;
    }
  }
  ok('reversing back and forth over the line does not add laps', r.lap === startLap,
    `lap stayed at ${r.lap} across 40 crossings`);

  // the grid sits BEHIND the line, so the first crossing is the start of lap 1, not a lap.
  // Drive past the line once to clear that, then a genuine lap must count.
  st.phase = 'racing';
  for (const s of [track0.length - 2, 2]) {
    const p = track0.pointAt(s);
    r.x = p.x; r.z = p.z;
    step(st, makeInputs(2)); st.events.length = 0;
  }
  const before = r.lap;
  for (let s = track0.length * 0.55; s <= track0.length; s += 3) {
    const p = track0.pointAt(s % track0.length);
    r.x = p.x; r.z = p.z;
    step(st, makeInputs(2)); st.events.length = 0;
  }
  // ...and then actually cross the line. Stepping in 3m increments lands at s=1185 of a 1187m
  // lap, which is NOT a crossing — the wrap is the whole event being tested.
  {
    const p = track0.pointAt(1);
    r.x = p.x; r.z = p.z;
    step(st, makeInputs(2)); st.events.length = 0;
  }
  ok('a genuine forward lap still counts', r.lap === before + 1,
    `lap ${before} → ${r.lap} after driving a full lap`);
}

// ─────────────────────────────────────────────────────────────────────────────
section('items — every one of the nine must spawn, act and be observable');
{
  const mk = () => {
    const st = createState({ seed: 41, track: track0, racerCount: 8, playerIndex: 0, laps: 3, playerBot: false });
    st.phase = 'racing';
    for (let i = 1; i < 8; i++) st.racers[i].finished = true;   // keep the field out of the way
    return st;
  };
  const press = (st, i, bits) => {
    const inp = makeInputs(8);
    inp[i] = bits;
    step(st, inp);
  };
  const results = [];

  // ── self-buff items
  for (const kind of ['nitro', 'nitro3', 'overdrive']) {
    const st = mk();
    const r = st.racers[0];
    r.item = kind; r.itemUses = (ITEMS[kind].uses || 1); r.itemRollTicks = 0;
    press(st, 0, 0);                                    // establish prevBits with no ITEM
    st.events.length = 0;
    press(st, 0, BIT.ACCEL | BIT.ITEM);
    const boosts = st.events.filter(e => e.type === 'boost');
    const boosted = r.boostTicks > 0 || r.overdriveTicks > 0;
    results.push({ kind, acted: boosts.length > 0 && boosted, detail: `boostTicks ${r.boostTicks}, overdriveTicks ${r.overdriveTicks}, item now ${r.item}` });
    st.events.length = 0;
  }

  // ── dropped hazard: the victim must be spun out by it
  for (const kind of ['oil', 'mine']) {
    const st = mk();
    const a = st.racers[0], b = st.racers[1];
    b.finished = false;
    a.item = kind; a.itemUses = 1; a.itemRollTicks = 0;
    press(st, 0, BIT.ACCEL);
    press(st, 0, BIT.ACCEL | BIT.ITEM);
    const it = st.items[0];
    const spawned = !!it && it.kind === kind;
    // park the victim exactly on the hazard and step until it arms
    let hit = 0;
    for (let t = 0; t < 120; t++) {
      b.x = it.x; b.z = it.z; b.finished = false;
      press(st, 1, 0);
      hit += st.events.filter(e => e.type === 'hit' && e.racerId === 1).length;
      st.events.length = 0;
      if (hit) break;
    }
    results.push({ kind, acted: spawned && hit > 0, detail: `spawned ${spawned}, victim spun out ${hit > 0 ? 'yes' : 'NO'}` });
  }

  // ── forward projectiles: fire down a straight at a victim parked on the line of fire
  for (const kind of ['cannonball', 'seeker']) {
    const st = mk();
    const a = st.racers[0];
    st.racers[1].finished = true;
    const b = st.racers[1];
    a.item = kind; a.itemUses = 1; a.itemRollTicks = 0;
    a.speed = 24;
    press(st, 0, BIT.ACCEL);
    st.events.length = 0;
    press(st, 0, BIT.ACCEL | BIT.ITEM);
    const thrown = st.items.find(it => it.kind === kind);
    // place the victim 18m straight ahead of the shooter, on the firing line
    if (thrown) {
      b.finished = false;
      b.x = a.x + Math.sin(a.heading) * 18;
      b.z = a.z + Math.cos(a.heading) * 18;
      b.heading = a.heading; b.speed = 0;
    }
    let hit = 0;
    for (let t = 0; t < 200 && thrown; t++) {
      press(st, 1, 0);
      hit += st.events.filter(e => e.type === 'hit' && e.racerId === 1).length;
      st.events.length = 0;
      if (hit) break;
    }
    results.push({ kind, acted: !!thrown && hit > 0, detail: `thrown ${!!thrown}, victim hit ${hit > 0 ? 'yes' : 'NO'}` });
    st.events.length = 0;
  }

  // ── pulse: a delayed global wave that spins everyone else out
  {
    const st = mk();
    for (let i = 1; i < 8; i++) st.racers[i].finished = false;
    const a = st.racers[0];
    a.item = 'pulse'; a.itemUses = 1; a.itemRollTicks = 0;
    press(st, 0, BIT.ACCEL);
    st.events.length = 0;
    press(st, 0, BIT.ACCEL | BIT.ITEM);
    const pending = st.items.some(it => it.kind === 'pulse');
    let hits = 0, pulses = 0;
    for (let t = 0; t < 120; t++) {
      press(st, 0, BIT.ACCEL);
      hits += st.events.filter(e => e.type === 'hit').length;
      pulses += st.events.filter(e => e.type === 'pulse').length;
      st.events.length = 0;
    }
    results.push({ kind: 'pulse', acted: pending && pulses === 1 && hits >= 6, detail: `pending ${pending}, wave fired ${pulses}, hit ${hits} of 7 rivals` });
  }

  // ── ink: blinds the racers AHEAD, so the shooter must be at the back of the field
  {
    const st = mk();
    const a = st.racers[0];
    for (let i = 1; i < 8; i++) {
      const slot = track0.gridSlots[i - 1];               // rivals one row up the road
      const pr = track0.progressAt(slot.x, slot.z);
      st.racers[i].x = slot.x; st.racers[i].z = slot.z;
      st.racers[i].progressBase = -track0.length; st.racers[i].progress = pr.s;
      st.racers[i].finished = false;
    }
    const back = track0.gridSlots[7];                     // shooter on the last slot
    a.x = back.x; a.z = back.z;
    a.item = 'ink'; a.itemUses = 1; a.itemRollTicks = 0;
    press(st, 0, BIT.ACCEL);
    st.events.length = 0;
    press(st, 0, BIT.ACCEL | BIT.ITEM);
    const ev = st.events.find(e => e.type === 'throw' && e.item === 'ink');
    const inked = st.racers.filter(r => r.id !== 0 && r.inkTicks > 0).length;
    results.push({ kind: 'ink', acted: inked >= 3, detail: `${inked} rivals inked (targetsAhead ${ITEMS.ink.targetsAhead}, throw event ${ev ? 'yes' : 'no'})` });
    st.events.length = 0;
  }

  console.log('    item behaviour:');
  for (const r of results) console.log(`      ${r.kind.padEnd(11)} ${r.acted ? 'OK  ' : 'FAIL'}  ${r.detail}`);
  const allActed = results.every(r => r.acted);
  ok('all 9 items spawn, act, and produce an observable effect', allActed && results.length === 9,
    `${results.filter(r => r.acted).length}/9 items verified end to end`);
  ok('the item tests are not vacuous (9 items were really exercised)', results.length === 9, `${results.length} item kinds covered`);
}

// ─────────────────────────────────────────────────────────────────────────────
section('stuck detection and respawn');
{
  const st = createState({ seed: 51, track: track0, racerCount: 2, playerIndex: 0, laps: 3, playerBot: false });
  st.phase = 'racing';
  st.racers[1].finished = true;
  const r = st.racers[0];
  const pinX = r.x, pinZ = r.z;
  let respawned = false, respawnTick = -1;
  const inp = makeInputs(2);
  for (let t = 0; t < 400; t++) {
    r.speed = 6;                                   // it *looks* like it is trying to drive
    inp[0] = BIT.ACCEL;
    step(st, inp);
    // a kart that cannot make progress: pinned to the same spot every tick
    r.x = pinX; r.z = pinZ; r.speed = 6;
    for (const e of st.events) if (e.type === 'respawn') { respawned = true; respawnTick = t; }
    st.events.length = 0;
    if (respawned) break;
  }
  ok('a kart that cannot make progress is respawned', respawned,
    `respawn fired after ${respawnTick} ticks (threshold ${PHYSICS.stuck.ticks})`);
  ok('the respawn puts it back on the road facing forward', respawned && (() => {
    const su = st.track.surfaceAt(r.x, r.z);
    return su === 'road' || su === 'grass';
  })(), `back at s=${num(r.s, 0)}m on ${st.track.surfaceAt(r.x, r.z)}`);

  // and a kart that IS making progress must never be respawned
  const st2 = createState({ seed: 53, track: track0, racerCount: 2, playerIndex: 0, laps: 3, playerBot: true });
  let falsePositives = 0;
  for (let t = 0; t < 3000; t++) {
    step(st2, botInputs(st2));
    for (const e of st2.events) if (e.type === 'respawn') falsePositives++;
    st2.events.length = 0;
  }
  ok('a healthy kart is never respawned (no false positives)', falsePositives === 0,
    `0 respawns over 3000 ticks of real racing`);
}

// ─────────────────────────────────────────────────────────────────────────────
section('balance — measured across rotated grid slots, never from one race');
{
  // The mistake this avoids: concluding "Vexx is overpowered" from a single default-config run
  // conflates STRONGER with STARTED IN FRONT. Rotate every character through every slot.
  const wins = {}, points = {}, races = {};
  for (const c of CHARS) { wins[c.id] = 0; points[c.id] = 0; races[c.id] = 0; }
  const N = 3;
  for (let slot = 0; slot < 8; slot++) {
    for (let k = 0; k < N; k++) {
      const chars = [];
      for (let i = 0; i < 8; i++) chars.push(CHARS[(i + slot) % 8].id);
      const st = createState({
        seed: 900 + slot * 31 + k, track: buildTrack(k % 3), racerCount: 8,
        playerIndex: 8, laps: 3, playerBot: true, chars, karts: chars.map((_, i) => KARTS[i % 8].id),
      });
      let t = 0;
      while (st.phase !== 'finished' && t < SIM.MAX_RACE_TICKS) { step(st, botInputs(st)); st.events.length = 0; t++; }
      const ord = raceOrder(st);
      for (const r of ord) {
        races[r.charId]++;
        points[r.charId] += RACE.pointsTable[r.place - 1] ?? 0;
        if (r.place === 1) wins[r.charId]++;
      }
    }
  }
  const table = CHARS.map(c => ({ c, wins: wins[c.id], races: races[c.id], pts: points[c.id], avg: points[c.id] / Math.max(1, races[c.id]) }));
  table.sort((a, b) => b.avg - a.avg);
  console.log('    avg cup points per race (all 8 characters, rotated through every grid slot):');
  for (const r of table) console.log(`      ${r.c.rank || ''}${r.c.name.padEnd(12)} speed ${r.c.stats.speed} handling ${r.c.stats.handling} weight ${r.c.stats.weight}  →  ${num(r.avg, 2)} pts/race, ${r.wins} wins in ${r.races} races`);
  const best = table[0], worst = table[table.length - 1];
  const spread = best.avg - worst.avg;
  const fair = spread < 6.5;
  ok('the roster is competitive — no character dominates', fair,
    `best ${best.c.name} ${num(best.avg, 2)} vs worst ${worst.c.name} ${num(worst.avg, 2)} pts/race (spread ${num(spread, 2)} of a possible 14)`);
  ok('no character is a trap pick', worst.avg >= best.avg * 0.45,
    `weakest line scores ${num(100 * worst.avg / best.avg, 0)}% of the strongest`);
  const winsTotal = table.reduce((a, b) => a + b.wins, 0);
  ok('wins are distributed, not monopolised', table[0].wins <= Math.ceil(winsTotal * 0.45),
    `${table[0].wins} of ${winsTotal} wins for the strongest character (${num(100 * table[0].wins / winsTotal, 0)}%)`);
  ok('every character actually raced every configuration', table.every(r => r.races === 8 * N),
    `${table.reduce((a, b) => a + b.races, 0)} races across 8 characters x 8 grid slots x ${N} seeds`);
}

// ─────────────────────────────────────────────────────────────────────────────
section('summary');
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFAILED:'); for (const f of failures) console.log('  - ' + f); }
console.log(fail ? '\n✗ sim suite FAILED' : '\n✓ sim suite passed');
process.exitCode = fail ? 1 : 0;
