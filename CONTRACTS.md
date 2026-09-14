# TURBO CIRCUIT — frozen interfaces (READ THIS FULLY BEFORE WRITING CODE)

An 8-kart arcade racing game in Three.js. Mario-Kart-class feel, **no Nintendo IP**:
original characters, original items, original tracks. "AAA" here means: it loads, it looks
like a real game, 8 karts race 3 laps on a real circuit, items and drift-boost work, the AI
is competitive, there is a full race flow (title → cup → results), and the whole thing is
verified by three independent test suites plus a live GitHub Pages deploy.

This file is the contract. **Every team writes to it. Do not change a signature.** If you
believe a signature is wrong, implement it as written and report the problem in your summary.

Units are SI (metres, m/s, seconds). Y is up. The karts drive on the XZ plane.

---

## 0. Glossary

| term | meaning |
|---|---|
| tick | one fixed simulation step, exactly `1/60 s` (see `content.js` → `SIM`) |
| bitmask | a racer's input, one integer, bits defined in `src/input.js` |
| progress `s` | arc length in metres from the start line along the track centreline |
| lateral | signed distance from the centreline, `+` = left of travel direction |
| racer | one kart on track, `state.racers[i]`, index is also its slot id |

---

## 1. Ownership map — only touch your own files

| team | owns | also owns |
|---|---|---|
| **SIM** | `src/sim.js`, `src/ai.js` | `test/sim.test.mjs` |
| **WORLD** | `src/tracks.js`, `src/render.js` | `test/track.test.mjs` |
| **KARTS** | `src/karts.js` | `test/render.test.mjs` |
| **PRESENTATION** | `src/fx.js`, `src/hud.js`, `src/audio.js`, `src/item-visuals.js` | — |
| **HARNESS** | `test/browser-check.mjs`, `tools/*`, `serve.mjs`, `README.md`, `PUBLISH.md` | `test/run-all.mjs` |
| **PARENT (already written, do not edit)** | `src/content.js`, `src/input.js`, `src/main.js`, `index.html`, `CONTRACTS.md`, `package.json`, `.gitignore` | — |

`src/content.js` is the **single source of every tunable number**. Read it; do not hardcode
physics values anywhere else. If you need a new constant, add it to `content.js`, do not
inline it. (Coordinate edits to `content.js` through your summary — the parent applies them.)

Never use `Math.random()` or `Date.now()` / `performance.now()` inside `src/sim.js`,
`src/tracks.js`, `src/ai.js` — those three must be deterministic and DOM-free so they run in
Node. Randomness comes from the seeded RNG in `state.rng`.

No `node_modules`. No bundler. Plain ES modules with relative imports only (`./x.js`).

---

## 2. `content.js` — the shape you will be reading

```js
import { SIM, PHYSICS, CHARS, KARTS, ITEMS, ITEM_DROP, TRACKS, RACE, PALETTE, AI } from './content.js';
SIM.STEP            // 1/60
PHYSICS             // topSpeed, accel, grip, drift{...}, boost{...}, wallBounce, ...
CHARS               // 8 characters: { id, name, colour, accent, weight, personality, stats{} }
KARTS               // 8 karts: { id, name, body, accent, shape, stats{ speed, accel, handling, weight } }
ITEMS               // { nitro, oil, cannonball, seeker, mine, pulse, overdrive, ink }
ITEM_DROP           // rollItem(place, racerCount, rand01) -> item id
TRACKS              // 3 track definitions: { id, name, width, laps, theme, control[], itemBoxes[], boostPads[], ramps[], shortcuts[], scenery[] }
RACE                // racerCount, laps, countdown, rocketStart, pointsTable, slipstream, coins
PALETTE             // named colours — use these, do not invent hex codes
AI                  // bot tuning: lookahead, skill bands, rubberband, itemLogic
```

`TRACKS[i].control` is a list of `[x, z]` control points for a **closed** Catmull-Rom loop.

---

## 3. `src/input.js` (written — import, do not edit)

```js
export const BIT = { ACCEL:1, BRAKE:2, LEFT:4, RIGHT:8, DRIFT:16, ITEM:32, LOOK:64 };
export const NO_INPUT = 0;
export function createInput()  // -> { bits(), attach(el), detach(), setTouch(action, down) }
```

---

## 4. `src/tracks.js` (WORLD)

```js
export const TRACK_IDS = ['sunset-bay', 'neon-docks', 'alpine-rush'];   // matches TRACKS order

// Pure, deterministic, DOM-free. Call once at race start.
export function buildTrack(trackIndex) -> BuiltTrack

BuiltTrack = {
  index, id, name, theme, laps, halfWidth,      // halfWidth = TRACKS[i].width / 2
  length,                                        // total centreline length, metres
  samples,                                       // [{ x, z, tx, tz, nx, nz, curvature, s }] ~1 per 2 m
  y(x, z),                                       // ground height at a world point (ramps/hills)
  pointAt(s),                                    // -> { x, z, y, tx, tz, nx, nz, curvature }
  progressAt(x, z),                              // -> { s, lateral, index, dist }  O(1) via a spatial hash
  surfaceAt(x, z),                               // -> 'road'|'grass'|'boost'|'ramp'|'wall'
  gridSlots,                                     // 8 x { x, z, heading } staggered start slots, slot 0 = pole
  itemBoxes,                                     // [{ x, z, y }]  (from TRACKS[i].itemBoxes)
  boostPads,                                     // [{ x, z, y, s, lateral }]
  meshSpec,                                      // plain data the renderer turns into geometry
}

// Deterministic geometry only — safe in Node, no THREE import.
export function trackBounds(track) -> { minX, maxX, minZ, maxZ }
```

`progressAt` must be **O(1)** (spatial hash of sample index by grid cell), because the sim
calls it for 8 racers every tick.

## 5. `src/render.js` (WORLD)

Uses Three.js from `../vendor/three.module.js` (`import * as THREE from '../vendor/three.module.js'`).

```js
export function createRenderer(canvas, opts = {}) -> Renderer

Renderer = {
  init(track, roster),        // (re)build the scene for a BuiltTrack + the 8 CHARS/KARTS
  draw(state, alpha, opts),   // alpha = interpolation 0..1 between the last two ticks
                              // opts = { playerIndex, camera:'chase'|'far'|'orbit', dt }
  onResize(w, h),
  setQuality('low'|'high'),
  dispose(),
  info,                       // { calls, triangles, fps }  (from renderer.info.render)
  scene, camera,              // exposed so tests can measure the scene graph
}
```

Requirements: a real circuit (road surface with kerbs, banked curves, walls, grandstands,
trees/pylons, start gate, distance markers), a sky, fog, directional + ambient light, shadows
on the karts, and a chase camera that leads the player's kart slightly. `draw` must be
stateless with respect to simulation: it reads `state` and never writes to it.

`render.js` must call `karts.js` for the karts and `item-visuals.js` for items — it does not
build those itself:
```js
import { createKart, updateKartVisual } from './karts.js';
import { createItemVisuals } from './item-visuals.js';
```

## 6. `src/karts.js` (KARTS)

```js
export function createKart(kartDef, charDef) -> THREE.Group
// Group.userData = { rig, wheels[], body, charRig, kartDef, charDef }
export function updateKartVisual(group, racer, state, t, opts)
// racer = state.racers[i]; t = elapsed seconds (render time, may be fractional);
// opts = { dt, place, offTrack }
export function solveLegIK(hip, foot, thigh, shin) -> { knee, angle, reachable }  // exported so test/render.test.mjs can measure it
export function kartDimensions(kartDef) -> { wheelBase, track, wheelR, bodyLen, bodyH, charH }
```

The character must be **a real character**: torso, head, two arms (solved with `solveLegIK`'s
twin — reuse the same two-bone solver), two legs, gloves, a helmet, and a face with eyes that
blink. Legs/arms are solved with two-bone IK against a body-relative path, **never** authored
as raw joint angles. Wheels must rotate with distance travelled and steer with input. The kart
leans into corners, squashes on landing, and spins when hit. This is the "no placeholder
geometry" rule: an abstract capsule is a failed deliverable.

## 7. `src/fx.js`, `src/hud.js`, `src/audio.js`, `src/item-visuals.js` (PRESENTATION)

```js
// fx.js
export function createFX(scene) -> { emit(events, state, opacity), update(dt, state), dispose() }
// particle systems: boost flames, drift sparks (3 tiers by colour), impact debris, dust,
// hit stars, item-box burst, water spray. Pooled — no per-frame allocation growth.

// hud.js  (DOM, not canvas)
export function createHUD(rootEl) -> { update(state, opts), showTitle(data), hide(), showResults(data), setLap(data), dispose() }
// opts = { camera, renderer, playerIndex, speedKmh, itemId, itemRollTicks, notifications }
// Must include: lap counter, position, speed readout, item slot with a rolling icon animation,
// a live MINIMAP of the track drawn from track.samples with 8 dots, drift-charge meter,
// slipstream indicator, race notifications ("LAP 2/3", "FINAL LAP", "3rd PLACE!").

// audio.js  (WebAudio, nothing pre-baked — synthesise everything)
export function createAudio() -> { unlock(), setMuted(b), muted, engine(state, playerIndex), play(name, opts), music(on), dispose() }

// item-visuals.js (Three.js)
export function createItemVisuals(scene) -> { sync(state, dt), dispose() }
// item boxes, boost pads, thrown items (nitro canister, oil slick, cannonball, seeker missile,
// mine, pulse ring, overdrive aura, ink blob), all pooled and reconciled to state.items each frame.
```

## 8. `src/sim.js` (SIM) — the heart

```js
export function createState(opts) -> State
// opts = { seed, track: BuiltTrack, racerCount, playerIndex, laps, mode, chars }
export function step(state, inputs)     // advances EXACTLY one tick
export function hashState(state)        // -> string, must change iff gameplay state changed
export function makeInputs(n)           // -> [0,0,...] length n
export function speedKmh(racer)         // -> number
export function raceOrder(state)        // -> [{ id, place, lap, s, finished, totalTime }] sorted
export function standingsPoints(state)  // -> [{ id, place, points }] using RACE.pointsTable
```

`State`:
```js
{
  tick, phase: 'countdown'|'racing'|'finished', countdownTicks,
  seed, rng,                        // rng = { next() -> [0,1), state }  seeded, in-state
  track, racerCount, laps, playerIndex, mode,
  racers: [Racer x 8],
  items:    [ { id, kind, x, y, z, vx, vz, ownerId, targetId, ticksLeft, state:'idle'|'active'|'dead', spin } ],
  pickups:  [ { id, x, z, cooldowns: [per-racer tick when they may take it again] } ],
  particles: [],                    // sim-side logical particles only (fx.js draws them)
  events:   [ { type, racerId, x, z, ... } ],   // cleared by the caller each tick
  finishedOrder: [racerId, ...],
  raceTicks,                        // ticks since GO
}

Racer = {
  id, name, charId, kartId, isPlayer, cpu,
  x, y, z, heading,                 // radians, 0 = +Z
  speed, vx, vz,                    // m/s, world frame
  s, lateral, lap, place, progress, // progress = lap*length + s
  driftDir: -1|0|1, driftCharge, driftTier, hopTicks,
  boostTicks, boostKind, miniTurboTicks,
  spinTicks, squashTicks, respawnTicks, inkTicks, pulseTicks, overdriveTicks,
  item, itemTicks, itemRollTicks,   // item = id from ITEMS or null; itemRollTicks = roulette
  coins, slipstreamTicks, offTrack, surface,
  rocketStart, finished, finishTick, totalTicks,
  ai: { line, targetS, aggression, skill, jitter, itemHoldTicks },
  _px, _pz, _ph,                    // previous-tick position, for render interpolation
}

Event types (exact strings):
  'countdown' { n }        'go' {}              'lap' { racerId, lap }
  'finish' { racerId, place }                    'boost' { racerId, kind, x, z }
  'drift' { racerId, tier, x, z }                'hop' { racerId }
  'pickup' { racerId, item, x, z }               'roll' { racerId, item }
  'throw' { racerId, item, x, z }                'hit' { racerId, byId, item, x, z }
  'spinout' { racerId, x, z }                    'respawn' { racerId, x, z }
  'pad' { racerId, x, z }                        'land' { racerId, x, z, air }
  'offroad' { racerId, state }                   'place' { racerId, place }
```

### Physics requirements (all values from `content.js`, tagged when uncertain)

- Acceleration curve to a per-kart `topSpeed`; grass halves top speed and adds drag; walls
  bounce with `PHYSICS.wallBounce` and cost speed.
- **Drift**: hold DRIFT while steering → hop, then a controlled slide that increases the turn
  rate; charge builds while drifting, at each tier threshold emit `drift` and grant a mini-turbo
  boost on release (3 tiers: blue → orange → purple, `PHYSICS.drift.tiers`).
- **Rocket start**: holding ACCEL in the last ~0.5 s of the countdown grants a launch boost;
  holding it from the very beginning of the countdown gives a *failed* start (brief stall).
- **Slipstream**: within `RACE.slipstream.dist` behind another kart for
  `RACE.slipstream.ticks` → +speed and a `boost` event.
- **Coins**: up to `RACE.coins.max`; each coin adds top speed; losing a coin (hit) costs it.
- **Off-road**: leaving the road triggers off-road speed penalty; touching a wall that faces
  the wrong way is a wall hit, not a teleport.
- **Stuck detection + respawn**: a racer with virtually no progress for
  `PHYSICS.stuck.ticks` is respawned at the last good centreline point, with a `respawn` event.
- **Lap counting**: crossing `s = 0` with decreasing... no — increment on crossing the start
  line **forwards** only, and only when the racer has sampled progress at least once past
  `length/2`, so a kart that reverses over the line cannot farm laps.
- **Race end**: when the first kart finishes, the rest get `RACE.finishGraceTicks` to finish;
  anyone not finished is placed by progress. Then `phase = 'finished'`.
- **Determinism**: same `createState` opts + same inputs ⇒ identical `hashState` after N ticks,
  on any machine. Test this.

### `src/ai.js`

```js
export function botInputs(state) -> Int32Array | number[]   // length racerCount, player slot ignored
```
Bots must: follow a racing line, brake for corners according to `curvature` and their `skill`,
aim at item boxes and boost pads, use items sensibly by place, drift on long corners, avoid
other karts, and rubber-band within `AI.rubberband` limits. **Movement is a persistent hold**:
`ACCEL` stays set on every tick — only discrete actions (ITEM) may be delayed/queued.

## 9. `src/main.js` + `index.html` (PARENT — written)

`window.__game` is the test hook. The browser suite drives the game through it. It exposes:
```js
window.__game = {
  state,                 // live sim state
  info(),                // { tick, phase, racers:[{id,place,lap,s,speedKmh,x,z}], item, lap, playerIndex, track, fps, drawCalls, charactersOnScreen, renderer:'webgl'|'none' }
  newRace(trackIndex, opts),
  step(n, bits),         // advance n ticks with a fixed bitmask (or array of bitmasks)
  setInput(bits),        // hold a bitmask for the player from now on
  press(action, ticks),  // queue a discrete action ('item','drift','accel','left','right','brake')
  camera(mode),          // 'chase'|'far'|'orbit'
  hud(),                 // innerText of the HUD root (for DOM assertions)
  audio(),               // { muted, ctx }
  screenPos(racerId),    // -> { x, y, visible } projected to CSS pixels — used to prove a kart is really on screen
  quality(q),
}
```

Query params on `index.html`: `?quality=low|high`, `?track=0|1|2`, `?laps=N`, `?autostart=1`,
`?bots=N`, `?seed=N`, `?mute=1`, `?camera=chase|far|orbit`.

---

## 10. Test suites — the definition of done

| command | what it proves |
|---|---|
| `npm test` → `test/sim.test.mjs` | SIM: determinism, physics numbers, laps, items, AI, balance over rotated slots |
| `npm run test:track` → `test/track.test.mjs` | WORLD: loop closes, no self-intersection, grid slots on-road, O(1) progress, meshSpec sane |
| `npm run test:render` → `test/render.test.mjs` | KARTS: rig geometry via Three.js **in Node**, IK, wheel contact, no hyperextension |
| `npm run test:browser` → `test/browser-check.mjs` | HARNESS: the real page in real Chrome over CDP — loads, renders, a race actually happens |
| `npm run verify` | all four, in order |
| `npm run deploy` | pack, push, wait for Pages, then boot the LIVE url and assert it plays |

Rules for every suite: assert **numbers**, print them, and never write an assertion that cannot
fail. Guard every aggregate against empty samples (a zero-sample average must fail, not pass).
Each team runs its own suite before reporting and pastes the real output.

---

## 11. Clarifications the parent froze after writing `main.js` / `index.html`

These are binding. They exist because `main.js` and `index.html` are already written.

1. **DOM ownership.** `main.js` owns `#overlay` *visibility* and `#menu` buttons, plus
   `#countdown` and `#loading`. `hud.js` owns everything inside `#hud` (the markup skeleton and
   ids are already in `index.html` — use them, do not rebuild them) and it also *writes into*
   `#results` when `showResults()` is called; `main.js` handles the overlay visibility.
   `hud.showTitle(data)` may write `#title-logo`/`#title-sub`; it must not toggle `#overlay`.
2. **`fx.js` lifecycle belongs to `render.js`.** `render.js` creates it in `init()`, calls
   `fx.emit(events, state, opacity)` inside `draw()` and disposes it on re-init. `main.js` never
   touches `fx`.
3. **Events reach the renderer through `draw()`**: `draw(state, alpha, opts)` where
   `opts = { playerIndex, camera, dt, events, notifications }`. `render.js` must treat
   `opts.events` as read-only and must not clear `state.events` (main clears it after `draw`).
4. **`createState` `opts` also carries `karts`** (array of `KARTS[i].id` per slot), alongside
   `chars`. Slot order = grid order; `opts.chars[playerIndex]` is the player's chosen character.
5. **`TRACKS[i].itemBoxGroups`** (not `itemBoxes`) is the data field: each group is
   `{ sFrac, lateral, count, spread }` and `tracks.js` expands it into world positions for
   `BuiltTrack.itemBoxes` as `[{ x, y, z }]`. Same pattern for `boostPads`, `ramps`, `shortcuts`.
6. **`hud.update(state, opts)`** receives
   `opts = { camera, renderer, playerIndex, track, speedKmh, notifications, order }`.
   `notifications` is `[{ text, cls }]`; `order` is the output of `raceOrder(state)`.
7. **`hud.showResults(data)`** receives
   `{ order, playerIndex, racers, laps, trackName, chars, points }` and fills `#results`
   (a `<table>`), one row per finisher, `.me` on the player's row, a colour swatch per racer.
8. **`render.js` must work before `init()`** is called (main calls `onResize` first) — guard it.
9. **`track.y(x, z)`** is the ground height; the sim keeps racers on the ground plane except
   while airborne. Ramps launch via `PHYSICS.air.launchFromRamp`.
10. **`main.js` calls `renderer.info`** for `{ calls, triangles }` only. Anything else the
    browser suite needs on `__game.info()` is already wired.

---

## 12. Reporting

Report, in this order: files written (with line counts) · test command + real output summary ·
measured numbers (m/s, lap times, counts) · what you could not do and why · anything the parent
must change in `content.js` or `main.js` to make your part work. No adjectives, no "should work".
