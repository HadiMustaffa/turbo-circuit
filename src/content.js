// src/content.js — TURBO CIRCUIT: every tunable number in the game lives here.
//
// Rule (contract §1): the simulation, the renderer and the tests all read THIS file.
// Nothing hardcodes a physics value anywhere else. Balance is a data edit, not a code change.
//
// Units are SI: metres, m/s, seconds, radians. Y is up. Karts drive on the XZ plane.
// Values tagged [measured] were asserted by a test; [estimate] are tuned by feel and can be
// dialled in without touching code.

// ─────────────────────────────────────────────────────────────── simulation
export const SIM = {
  TICK_HZ: 60,
  STEP: 1 / 60,              // seconds per tick — fixed, never variable
  MAX_STEPS_PER_FRAME: 8,    // spiral-of-death guard in main.js
  MAX_RACE_TICKS: 60 * 60 * 12, // hard stop at 12 real minutes
};

// ─────────────────────────────────────────────────────────────── physics
// Arcade scale, not a simulator: a neutral kart does ~94 km/h and a lap of Sunset Bay ~48 s.
export const PHYSICS = {
  topSpeed: 26.0,            // [estimate] m/s before kart stats, coins, boosts
  accel: 17.0,               // [estimate] m/s^2 at zero speed (0→90% of top speed in ~3s)
  coastDrag: 0.55,           // [estimate] 1/s exponential decay when off throttle
  brakeDecel: 18.0,          // [estimate] m/s^2
  reverseSpeed: 7.0,         // [estimate] m/s
  speedCurve: 1.65,          // >1 = stronger pull to top speed at low speed (arcade punch)

  // Cornering grip. Without this, the speed stat decides every race and handling is decorative:
  // measured, speed-5 karts won 23 of 32 races and handling-5 karts finished last. A kart now
  // has a lateral-grip ceiling, so a tight corner caps your speed by your HANDLING, not your
  // engine — the classic speed-versus-grip trade that makes a kart roster a real choice.
  corner: {
    grip: 5.4,               // [estimate] m/s^2 of lateral grip at handling 3
    gripMul: [0.86, 1.14],   // handling 1 → 5
    driftBonus: 1.30,        // a kart that is already sliding can carry more speed through it
    scrub: 3.2,              // [estimate] 1/s — how fast speed above the limit is shed
    minLimit: 9.0,           // never scrub lower than this, so no corner can trap a kart
  },

  // How far each 1..5 stat slider moves the actual physics. These two ranges are the whole
  // balance of the roster: topSpeedRange buys straight-line speed, gripMulRange buys corner
  // speed. Measured point-spread across 8 characters x 8 grid slots is printed by the sim
  // suite's balance section — widen one range and re-run it rather than guessing.
  statRange: {
    topSpeed: [0.86, 1.14],
    accel: [0.85, 1.16],
    steerRate: [0.86, 1.14],
  },

  steerRate: 2.05,           // [estimate] rad/s at low speed
  steerRateHighSpeed: 0.92,  // [estimate] rad/s at top speed (speed-sensitive steering)
  steerReturn: 3.4,          // [estimate] how fast steering recentres

  // surface multipliers on top speed (grass is a real punishment, not a wall)
  surface: {
    road:     { topSpeedMul: 1.00, accelMul: 1.00 },
    shortcut: { topSpeedMul: 0.84, accelMul: 0.82 },   // drivable cut: a real line, but slower
    grass:    { topSpeedMul: 0.52, accelMul: 0.55 },
    boost:    { topSpeedMul: 1.00, accelMul: 1.00 },
    ramp:     { topSpeedMul: 0.94, accelMul: 0.80 },
    wall:     { topSpeedMul: 0.30, accelMul: 0.20 },
  },

  wall: {
    bounce: 0.38,            // [estimate] fraction of normal velocity reflected
    scrapeCost: 0.35,        // [estimate] speed lost per second scraping a wall
    minBounceSpeed: 0.4,     // below this a wall touch is a scrape, not a bounce
  },

  // off-road recovery: a kart pinned outside the track for this long is respawned
  offTrack: { graceTicks: 150, slowMul: 0.55 },

  // a racer that has made almost no forward progress for this long is respawned
  stuck: { ticks: 200, minProgressMetres: 1.5, moveEps: 0.35 },

  // DRIFT: hop in, slide, charge, release for a mini-turbo. Tiers are the whole point.
  drift: {
    minSpeed: 8.0,           // [estimate] m/s needed to start a drift
    turnRateMul: 1.62,       // [estimate] turn rate while drifting
    outwardSlip: 0.26,       // [estimate] how far the nose points off the velocity
    hopTicks: 13, hopSpeed: 3.2,   // [estimate] the little hop that starts a drift
    chargePerTick: 1 / 60,   // charge accrues in seconds
    tiers: [
      { name: 'blue',   at: 0.55, boostTicks: 30, speedAdd: 5.0, colour: '#3ad2ff' },
      { name: 'orange', at: 1.10, boostTicks: 46, speedAdd: 6.5, colour: '#ff9a2e' },
      { name: 'purple', at: 1.75, boostTicks: 62, speedAdd: 8.0, colour: '#c06bff' },
    ],
    chargeCap: 2.4,
  },

  air: {
    gravity: 22.0,           // [estimate] m/s^2 while airborne
    launchFromRamp: 8.5,     // [estimate] vertical m/s from a ramp
    airSteer: 0.55,          // [estimate] fraction of ground steering authority in the air
    landSquashTicks: 22,
  },

  spinOut: {
    ticks: 62,               // [estimate] how long a hit takes a kart out of the race
    spinRate: 9.5,           // [estimate] rad/s while spinning
    speedMul: 0.22,          // [estimate] speed retained when the spin ends
  },

  respawn: { ticks: 72, dropHeight: 2.2 },

  squashTicks: 24,

  rocketStart: {
    countdown: 3.0,          // seconds of "3 2 1"
    perfectFrom: 0.42,       // [estimate] s before GO that a held ACCEL is a perfect start
    perfectBoostTicks: 52,
    earlyHoldPenaltyFrom: 1.6, // [estimate] holding ACCEL from before this = bogged engine
    bogTicks: 55,
    bogSpeedMul: 0.35,
  },
};

// ─────────────────────────────────────────────────────────────── items
// IP-safe originals. `spawn` describes how the item leaves the kart.
export const ITEMS = {
  nitro: {
    name: 'Nitro Cell', icon: 'nitro', rare: 1,
    boostTicks: 72, speedAdd: 9.0, stack: 1,
  },
  nitro3: {
    name: 'Triple Nitro', icon: 'nitro3', rare: 2,
    boostTicks: 58, speedAdd: 8.0, uses: 3, stack: 3,
  },
  oil: {
    name: 'Oil Slick', icon: 'oil', rare: 1,
    dropBehind: 3.0, lifeTicks: 60 * 40, radius: 1.5,
    hit: { spinTicks: 55, speedMul: 0.35 }, uses: 1,
  },
  cannonball: {
    name: 'Cannonball', icon: 'cannonball', rare: 2,
    spawn: 'forward', speed: 34.0, lifeTicks: 60 * 6, radius: 1.7,
    homing: 0, bounces: 3, wallBounce: 0.85,
    hit: { spinTicks: 60, speedMul: 0.20 },
  },
  seeker: {
    name: 'Seeker', icon: 'seeker', rare: 3,
    spawn: 'forward', speed: 30.0, lifeTicks: 60 * 8, radius: 1.9,
    homing: 3.1, turnRate: 2.6, hit: { spinTicks: 66, speedMul: 0.18 },
  },
  mine: {
    name: 'Mine', icon: 'mine', rare: 3,
    spawn: 'behind', lifeTicks: 60 * 30, radius: 3.1, fuseTicks: 0,
    hit: { spinTicks: 70, speedMul: 0.15, launch: 4.2, splash: 6.5 },
  },
  pulse: {
    name: 'Pulse Wave', icon: 'pulse', rare: 4,
    delayTicks: 34, radius: 999, // hits every other racer
    hit: { spinTicks: 40, speedMul: 0.45, applyToAll: true, notOwner: true },
    effectTicks: 60 * 5,
  },
  overdrive: {
    name: 'Overdrive', icon: 'overdrive', rare: 4,
    selfTicks: 60 * 6.5, speedAdd: 6.5, invincible: true, contactKnock: true,
  },
  ink: {
    name: 'Ink Burst', icon: 'ink', rare: 2,
    targetsAhead: 5, inkTicks: 60 * 4, appliesTo: 'ahead',
  },
};

// Weighted drop table by FIELD POSITION, Mario-Kart style: the back of the field gets the
// race-changing items, the leader gets oil and cannonballs. `places` is 1-indexed.
export const ITEM_DROP = {
  buckets: [
    { places: [1, 2], weights: { oil: 34, cannonball: 30, nitro: 20, ink: 10, mine: 6 } },
    { places: [3, 4], weights: { oil: 22, cannonball: 22, nitro: 20, seeker: 16, mine: 12, ink: 8 } },
    { places: [5, 6], weights: { seeker: 24, nitro: 20, nitro3: 16, mine: 16, pulse: 14, oil: 10 } },
    { places: [7, 8], weights: { pulse: 26, overdrive: 22, nitro3: 20, seeker: 16, mine: 16 } },
  ],
  // A racer well behind the leader gets one bucket's worth of extra help.
  catchUpThreshold: 0.55,   // fraction of a lap behind the leader
  catchUpBonus: { overdrive: 12, pulse: 12, nitro3: 16 },
};

// `rand01` is a seeded value in [0,1) supplied by the caller — this function is pure.
export function rollItem(place, racerCount, rand01) {
  const b = ITEM_DROP.buckets.find(x => place >= x.places[0] && place <= x.places[1])
    || ITEM_DROP.buckets[ITEM_DROP.buckets.length - 1];
  const entries = Object.entries(b.weights);
  const total = entries.reduce((a, [, w]) => a + w, 0);
  let r = Math.min(0.999999, Math.max(0, rand01)) * total;
  for (const [id, w] of entries) { if ((r -= w) < 0) return id; }
  return entries[0][0];
}

// ─────────────────────────────────────────────────────────────── characters
// Eight originals. `stats` are 1..5 sliders that the sim turns into physics.
// speed -> topSpeed, accel -> accel, handling -> cornering grip AND steer rate,
// weight -> shoving power in a collision, but it COSTS acceleration and grip.
// Every character's four stats total 15, so no roster entry is simply "better": you are always
// trading something away. (Measured before this rule: the one character with a total of 16 won
// 42% of races and the two with the worst lines never won at all.)
export const CHARS = [
  { id: 'vex',    name: 'Bolt Vexx',  colour: '#e8443a', accent: '#ffd166', skin: '#f0b98a', weight: 4, personality: 'reckless',
    blurb: 'Top speed merchant. Brakes late, leans on you in the corners, apologises never.', stats: { speed: 5, accel: 3, handling: 3, weight: 4 } },
  { id: 'nami',   name: 'Nami Isla',  colour: '#2fb8d6', accent: '#eafcff', skin: '#e8b183', weight: 3, personality: 'precise',
    blurb: 'Races the apex, not the kart. Corners like it is on rails.', stats: { speed: 3, accel: 4, handling: 5, weight: 3 } },
  { id: 'bruno',  name: 'Bruno Kask', colour: '#f28b1f', accent: '#4a2a12', skin: '#d79a63', weight: 5, personality: 'bully',
    blurb: 'Heavyweight. Bumps you off the line and calls it racing.', stats: { speed: 4, accel: 2, handling: 4, weight: 5 } },
  { id: 'pixel',  name: 'Pixel-9',    colour: '#e255c8', accent: '#7cf9ff', skin: '#c9c9d6', weight: 3, personality: 'quirky',
    blurb: 'A drifting machine with a processor for a heart.', stats: { speed: 3, accel: 5, handling: 4, weight: 3 } },
  { id: 'sable',  name: 'Sable Ravn', colour: '#6b4bc4', accent: '#c9a6ff', skin: '#c98f6a', weight: 3, personality: 'cold',
    blurb: 'Never speaks on the radio. Fast and tidy, but slow off the line.', stats: { speed: 5, accel: 3, handling: 4, weight: 3 } },
  { id: 'juno',   name: 'Juno Sky',   colour: '#f5d13c', accent: '#1f3b8f', skin: '#f2c39b', weight: 3, personality: 'cheerful',
    blurb: 'The all-rounder. Good at everything, smug about it.', stats: { speed: 4, accel: 4, handling: 4, weight: 3 } },
  { id: 'fang',   name: 'Fang Rusk',  colour: '#39b06a', accent: '#0f2f1c', skin: '#8fc9a3', weight: 4, personality: 'aggressive',
    blurb: 'Drives with teeth. Items are for people behind him.', stats: { speed: 4, accel: 3, handling: 4, weight: 4 } },
  { id: 'ola',    name: 'Ola Mint',   colour: '#3ed6a4', accent: '#0b2b26', skin: '#a9754f', weight: 2, personality: 'nervous',
    blurb: 'Fastest off the line and the lightest through a corner, then prays down the straight.', stats: { speed: 3, accel: 5, handling: 5, weight: 2 } },
];

// ─────────────────────────────────────────────────────────────── karts
// `shape` picks the body silhouette in karts.js. `body`/`accent` override the character colour.
export const KARTS = [
  { id: 'k-vex',    name: 'Vortex GT',    shape: 'wedge',    body: '#e8443a', accent: '#241014' },
  { id: 'k-nami',   name: 'Apex Nine',    shape: 'teardrop', body: '#2fb8d6', accent: '#0b2830' },
  { id: 'k-bruno',  name: 'Ironhog',      shape: 'boxy',     body: '#f28b1f', accent: '#3a2109' },
  { id: 'k-pixel',  name: 'Glitch Kart',  shape: 'wedge',    body: '#e255c8', accent: '#2a0a24' },
  { id: 'k-sable',  name: 'Nightshade',   shape: 'teardrop', body: '#6b4bc4', accent: '#170d33' },
  { id: 'k-juno',   name: 'Sunspot',      shape: 'boxy',     body: '#f5d13c', accent: '#3a3208' },
  { id: 'k-fang',   name: 'Riptide',      shape: 'wedge',    body: '#39b06a', accent: '#0d2a17' },
  { id: 'k-ola',    name: 'Featherweight', shape: 'teardrop', body: '#3ed6a4', accent: '#0a2b25' },
];

// ─────────────────────────────────────────────────────────────── tracks
// `control` is a CLOSED Catmull-Rom loop of [x, z] in metres. Tracks are hand-laid, then
// tracks.js arc-length-parameterises them. sFrac values below are fractions of lap length,
// so they survive any tweak to the control points.
export const TRACKS = [
  {
    id: 'sunset-bay', name: 'Sunset Bay', theme: 'coast', width: 14, laps: 3,
    blurb: 'A fast seaside loop. One long right, one hard hairpin, sea breeze down the back straight.',
    difficulty: 1,
    control: [
      [   0, -180], [ 120, -170], [ 200, -120], [ 215,  -30], [ 180,   40],
      [ 120,   80], [  40,   70], [ -30,  100], [-110,  110], [-180,   70],
      [-215,  -10], [-200,  -90], [-140, -150], [ -70, -180],
    ],
    itemBoxGroups: [
      { sFrac: 0.14, lateral: 0,   count: 5, spread: 8 },
      { sFrac: 0.52, lateral: 0,   count: 5, spread: 8 },
      { sFrac: 0.86, lateral: -3,  count: 3, spread: 6 },
    ],
    boostPads: [ { sFrac: 0.36, lateral: 4.4, length: 4 } ],
    ramps: [ { sFrac: 0.70, lateral: 0, width: 8, height: 1.1 } ],
    shortcuts: [ { sFrac: 0.655, lateral: -11, width: 5, surface: 'grass', note: 'beach cut, needs the ramp' } ],
    scenery: { theme: 'coast', density: 1.0, kinds: ['palm', 'rock', 'buoy', 'grandstand', 'lighthouse'] },
  },
  {
    id: 'neon-docks', name: 'Neon Docks', theme: 'city', width: 12, laps: 3,
    blurb: 'Wet concrete, tight chicanes, containers everywhere. A handling track that punishes greed.',
    difficulty: 3,
    control: [
      [   0, -200], [ 110, -195], [ 170, -140], [ 165,  -60], [ 110,  -20],
      [  40,  -30], [ -12,  -76], [ -78, -106], [-112,  -40], [ -66,   18],
      [   0,   60], [  90,   90], [ 150,  140], [ 140,  195], [  40,  215],
      [ -80,  205], [-170,  160], [-200,   80], [-190,  -30], [-140, -140],
      [ -60, -195],
    ],
    itemBoxGroups: [
      { sFrac: 0.10, lateral: 0,   count: 6, spread: 7 },
      { sFrac: 0.40, lateral: 2.5, count: 4, spread: 6 },
      { sFrac: 0.68, lateral: 0,   count: 6, spread: 7 },
    ],
    boostPads: [ { sFrac: 0.30, lateral: -3.8, length: 4 }, { sFrac: 0.90, lateral: 3.6, length: 4 } ],
    ramps: [ { sFrac: 0.575, lateral: 0, width: 7, height: 1.3 } ],
    shortcuts: [ { sFrac: 0.83, lateral: 10, width: 4.5, surface: 'grass', note: 'gap between containers' } ],
    scenery: { theme: 'city', density: 1.25, kinds: ['crane', 'container', 'neon', 'grandstand', 'pylon'] },
  },
  {
    id: 'alpine-rush', name: 'Alpine Rush', theme: 'alpine', width: 15, laps: 3,
    blurb: 'Wide, fast and downhill. Four flat-out corners, and the long jump at the summit.',
    difficulty: 2,
    control: [
      [   0, -230], [ 140, -215], [ 230, -150], [ 250,  -40], [ 210,   60],
      [ 120,  120], [  20,  110], [ -60,  150], [-160,  190], [-250,  140],
      [-280,   20], [-240, -110], [-160, -200], [ -70, -235],
    ],
    itemBoxGroups: [
      { sFrac: 0.18, lateral: 0, count: 6, spread: 9 },
      { sFrac: 0.60, lateral: 0, count: 6, spread: 9 },
    ],
    boostPads: [ { sFrac: 0.27, lateral: 5.0, length: 5 }, { sFrac: 0.795, lateral: -5.0, length: 5 } ],
    ramps: [ { sFrac: 0.47, lateral: 0, width: 11, height: 1.6 } ],
    shortcuts: [ { sFrac: 0.44, lateral: 13, width: 6, surface: 'grass', note: 'snow bank cut, huge air' } ],
    scenery: { theme: 'alpine', density: 1.35, kinds: ['pine', 'chalet', 'banner', 'grandstand', 'cablecar'] },
  },
];

// ─────────────────────────────────────────────────────────────── race rules
export const RACE = {
  racerCount: 8,
  laps: 3,
  countdownTicks: 60 * 3,
  lapsToShow: true,
  pointsTable: [15, 12, 10, 8, 6, 4, 2, 1],   // cup points, 1st → 8th
  finishGraceTicks: 60 * 90,                  // after the winner: let the rest come home
  slipstream: { dist: 6.5, lateral: 3.0, ticks: 84, boostTicks: 45, speedAdd: 4.0 },
  coins: { max: 10, speedPerCoin: 0.24, loseOnHit: 2, radius: 2.2, perTrack: 14 },
  // Rubber-band: the sim may nudge a kart that is a long way behind, and slow the leader a hair.
  rubberband: { maxBehindMetres: 90, behindSpeedAdd: 2.2, leaderSlowMetres: 140, leaderSpeedSub: 0.7 },
  respawnAheadMetres: 12,
};

// ─────────────────────────────────────────────────────────────── AI
export const AI = {
  lookahead: 22,             // metres ahead on the racing line to aim at
  skill: [0.62, 0.72, 0.80, 0.86, 0.91, 0.95, 0.98, 1.0],  // per grid slot, slot 0 = hardest
  rubberbandMax: 1.10,       // never let a bot exceed this fraction above its skill
  itemHoldTicks: 90,         // a bot waits this long for a better moment to fire
  aggression: [0.9, 0.55, 0.95, 0.6, 0.75, 0.5, 0.9, 0.45],
  jitter: 0.22,              // radians of wander, so bots are not identical
  driftMinCurvature: 0.008,  // 1/m — corner tight enough to be worth a drift
  avoidRadius: 4.2,
  lookBackTicks: 40,
};

// ─────────────────────────────────────────────────────────────── palette
export const PALETTE = {
  sky:        ['#ffb26b', '#ff7a59', '#2a4a8f'],   // horizon → zenith (coast)
  skyNight:   ['#141a3a', '#0a0e26', '#05060f'],
  skyAlpine:  ['#cfe8ff', '#8fd0ff', '#2a6dd6'],
  sun:        '#fff3c4',
  fog:        '#f0a878',
  road:       '#4a4a52',
  roadWet:    '#3a3a46',
  kerbA:      '#e8e8ee',
  kerbB:      '#d63a3a',
  grass:      '#3f7a3a',
  grassNight: '#1b2e21',
  grassSnow:  '#e8f2f8',
  sand:       '#e2c98f',
  wall:       '#8c8c96',
  startGate:  '#1a1a22',
  grandstand: '#c9c9d4',
  hudBack:    'rgba(8,10,20,0.55)',
  hudEdge:    '#7cf9ff',
  hudText:    '#ffffff',
  hudWarm:    '#ffd166',
  boost:      '#ff9a2e',
  warn:       '#ff4d6d',
  ok:         '#5efc8d',
};

export default { SIM, PHYSICS, ITEMS, ITEM_DROP, CHARS, KARTS, TRACKS, RACE, AI, PALETTE, rollItem };
