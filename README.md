# TURBO CIRCUIT

An 8-kart arcade racer in the browser, built on **Three.js** — drift-boost, rocket starts,
slipstream, 9 items, 3 circuits, a 60Hz simulation that is deterministic and DOM-free, and a
full race flow (title → countdown → 3 laps → results). No bundler, no `node_modules`, no
build step: plain ES modules and a static server.

**Play it: https://hadimustaffa.github.io/turbo-circuit/** — live, free, no install.

```
npm start                 # → http://127.0.0.1:8130   (this machine)
npm run lan               # → http://192.168.x.x:8130 (everyone on your wifi)
npm run verify            # every test suite, in order, with a PASS/FAIL table
```

---

## How to play

### On your own machine

You need [Node.js](https://nodejs.org) (18 or newer). Then, in this folder:

```bash
npm start
```

and open **http://127.0.0.1:8130**. That's it — the game is static files; the tiny server
in `serve.mjs` exists only because browsers refuse to load ES modules over `file://`.

### With friends on the same wifi

```bash
npm run lan
```

It prints your address on the network, something like:

```
TURBO CIRCUIT live on http://127.0.0.1:8130
  friends on your wifi:  http://192.168.1.37:8130
```

Anyone on the same wifi opens that second link and plays. Windows Firewall will ask the first
time — choose **Allow** on *Private* networks. Nothing is uploaded and nothing is installed.
(There is no network multiplayer yet: it is a one-player-vs-seven-bots game, everyone races
their own race.)

## Controls

| Key | What it does |
|---|---|
| `↑` / `W` | throttle |
| `↓` / `S` | brake, then reverse |
| `←` `→` / `A` `D` | steer |
| `Shift` / `Space` | **drift** — hold it through a corner and charge a mini-turbo |
| `E` | use the item you're holding |
| `C` | look back |
| `R` | restart the race |
| `M` | mute |
| `1` `2` `3` | camera: chase · far · orbit |
| `Esc` | back to the menu |

Touch controls appear by themselves on a phone or tablet.

**Two things worth knowing:**

- **Rocket start.** Hold the throttle *as the countdown hits zero* and you launch with a boost.
  Hold it from the very beginning of the countdown and you bog the engine instead — you'll hear it.
- **Drift tiers.** Drift into a corner, hold it, and the meter charges blue → orange → purple.
  Release at purple and the mini-turbo is worth a second per corner. This is the whole game.

## The eight characters

Each one is a real rig (torso, head, arms, legs, helmet, blinking eyes) with 1–5 stats for
speed, acceleration, handling and weight. Stats are not cosmetic: they feed the kart's top
speed, its acceleration, its steering rate and how much a hit costs it.

| Character | Kart | Feel |
|---|---|---|
| **Bolt Vexx** | Vortex GT | Top speed merchant. Brakes late, apologises never. |
| **Nami Isla** | Apex Nine | Races the apex, not the kart. Corners like it's on rails. |
| **Bruno Kask** | Ironhog | Heavyweight. Bumps you off the line and calls it racing. |
| **Pixel-9** | Glitch Kart | A drifting machine with a processor for a heart. |
| **Sable Ravn** | Nightshade | Never speaks on the radio. Never out of the top three. |
| **Juno Sky** | Sunspot | The all-rounder. Good at everything, smug about it. |
| **Fang Rusk** | Riptide | Drives with teeth. Items are for people behind him. |
| **Ola Mint** | Featherweight | Fastest off the line, then prays through every corner. |

## The three circuits

| Circuit | Theme | Lap | Character |
|---|---|---|---|
| **Sunset Bay** | coast | 1187 m | One long right, one hard hairpin, a beach shortcut that needs the ramp. The friendly one. |
| **Neon Docks** | city | ~1500 m | Wet concrete, tight chicanes, containers everywhere. Punishes greed. |
| **Alpine Rush** | alpine | ~1700 m | Wide, fast, downhill, with a long jump at the summit. |

Each has kerbs, banked corners, walls, grandstands, scenery, a start gate, 13–16 item boxes,
boost pads, at least one ramp and a shortcut.

## The nine items

Items come from the drop table by **position**, exactly like the genre does it: the leader gets
oils and cannonballs, the back of the field gets the race-changers.

| Item | What it does |
|---|---|
| **Nitro Cell** | a straight-line boost |
| **Triple Nitro** | three boosts, use them one at a time |
| **Oil Slick** | dropped behind you; whoever hits it spins |
| **Cannonball** | fired forward, bounces off walls |
| **Seeker** | fired forward, **homes** on the kart ahead |
| **Mine** | dropped behind, explodes with splash on contact |
| **Pulse Wave** | hits every other kart on the track |
| **Overdrive** | invincible, faster, knocks rivals aside on contact |
| **Ink Burst** | inks the screens of the five karts ahead |

## Architecture

```
index.html          shell + HUD markup/CSS
serve.mjs           zero-dependency static server (ES modules need http://)
src/content.js      EVERY tunable number: physics, characters, karts, tracks, items, AI
src/input.js        keyboard / touch → one input bitmask
src/sim.js          the deterministic core — no DOM, no THREE, no clock, no Math.random
src/ai.js           the seven bots: racing line, braking, drifting, item logic, rubber-band
src/tracks.js       circuit geometry: arc-length parameterised centreline, O(1) progressAt
src/render.js       scene, sky, fog, lights, shadows, chase camera, quality presets
src/karts.js        procedural kart + rider rigs, two-bone IK limbs, wheels that steer
src/fx.js           pooled particles: boost flames, drift sparks, debris, dust, spray
src/hud.js          lap, position, speed, item roulette, minimap, drift meter, results
src/audio.js        every sound synthesised live with WebAudio (no audio files at all)
src/item-visuals.js item boxes, boost pads and every thrown item, reconciled to the sim
src/main.js         fixed-timestep loop, race flow, and the window.__game test hook
```

The simulation is **DOM-free and deterministic on purpose**: fixed 1/60 s steps, all randomness
from a seeded RNG that lives *inside* the state, no `Math.random()` and no `Date.now()` anywhere
in `sim.js` / `ai.js` / `tracks.js`. Same seed plus same inputs gives the same race, on any
machine — which is what makes the whole thing testable in Node, and what would make
server-authoritative multiplayer a transport change rather than a rewrite. Rendering reads the
state and never writes to it; everything visual is published as events (`pickup`, `drift`,
`boost`, `hit`, `lap`, `finish`, …).

**Four suites, and why that matters.** The Node suites and the browser suite are blind to each
other's bugs:

| Suite | Proves |
|---|---|
| `npm test` — `test/sim.test.mjs` | determinism, the physics numbers, laps, items, AI, balance |
| `npm run test:track` — `test/track.test.mjs` | the circuit closes, no self-intersection, grid slots on-road, O(1) progressAt |
| `npm run test:render` — `test/render.test.mjs` | kart rigs via Three.js **in Node**: IK, wheel contact, no hyperextension |
| `npm run test:browser` — `test/browser-check.mjs` | the real page in real Chrome over CDP: it boots, it draws, it races |
| `npm run verify` | all four, in order, with a per-suite PASS/FAIL table |

The browser suite is the one that catches what a unit test cannot: it drives a real Chrome over
the DevTools Protocol with **no puppeteer and no playwright** (just `node:http` and the global
`WebSocket`), samples the WebGL framebuffer, drives the player kart around a lap with a real
controller, and asserts that **at least 6 of the 8 karts project inside the viewport** — because
an off-screen camera once shipped a working simulation in which no racer was ever visible.

`window.__game` is the hook it all runs through: `info()`, `newRace()`, `step(n, bits)`,
`setInput(bits)`, `camera(mode)`, `hud()`, `screenPos(id)` and friends.

## Verification — the numbers actually measured

Measured on Windows 11, Chrome headless with **SwiftShader** (software GL) — so the frame rate
is a floor, not what your GPU will do.

```
npm run verify        # every suite, in order
┌────────────────────────────────────────────────────────────────────────────┐
│ SUITE                   RESULT       PASS   FAIL      TIME   EXIT          │
│ test/sim.test.mjs       PASS           50      0     68.7s      0          │
│ test/track.test.mjs     PASS           93      0      0.5s      0          │
│ test/render.test.mjs    PASS          148      0      0.9s      0          │
│ test/browser-check.mjs  PASS           70      0    120.4s      0          │
└────────────────────────────────────────────────────────────────────────────┘
4 passed · 0 failed · 0 skipped   (361 checks passed, 0 checks failed)
```

| What | Measured |
|---|---|
| browser suite | **70 assertions, 0 failed** against the real page |
| draw calls | **1100** (1100–1105 across runs) |
| triangles | **90,492** (~90k) |
| frame rate, headless SwiftShader | **8.3–12.4 fps** (software rasteriser) |
| karts on screen | **8 / 8** projected inside the viewport |
| player speed at full throttle | **96.5 km/h** (26.8 m/s; matches the sim's own record × 3.6) |
| top speed reached in a race | **120.8 km/h** (draft + boost pads + drift boosts) |
| circuit, Sunset Bay | **1187 m** centreline, 3 laps, 8 karts, 13 item boxes |
| lap driven by the harness | lap 1 → lap 2, **800/800 ticks on road/boost/ramp**, 0 respawns, +1222 m of progress |
| rocket start | bogged start: heading swept **0.000 rad**, kart moved 6.2 m (a stall, not a spin); perfect start: **32 boost ticks** |
| drift | turns **1.41× harder** than the same steer, charge **0.53 s** in a 0.75 s hold, tier 1 reached on a real lap, **2 mini-turbo boosts** paid out |
| item flow | box → item (`seeker`), roulette ran, used it → slot emptied and **+1 owned entity**; a granted `cannonball` spawned with `ownerId 7` (the kart's own id) |
| race completion | phase `finished` at tick **10,259**, **8 of 8** classified, `#results` table rendered with 8 colour swatches and the player row marked |
| packed build, hosted | `verify-dist` **16 checks, 0 failed** at both a subpath and a domain root, no 404s |
| stills | `shots/title-screen.png`, `start-grid.png`, `race-hud.png`, `race-far.png`, `results.png` |

### Bugs this caught

| Symptom | How it was caught |
|---|---|
| **A bogged rocket start spun the kart off the grid** — holding the throttle from the first tick of the countdown swept the heading **3.117 rad** and left the kart 0.1 m from its slot pointing the wrong way, where the contract says a *brief stall* — so the "failed start" was worse than not trying | an assertion on the heading swept while `pulseTicks > 0`. Fixed in `src/sim.js`: it now measures **0.000 rad** and 6.2 m of roll |
| The item system looked fine until the roulette gave a **Triple Nitro** — a 3-use item whose slot does not empty on the first press. A naive test would have called that "the item wasn't consumed" | measuring `itemUses` before/after the press as well as the slot, and exercising the throw path separately |
| A camera that had just been handed a fresh race **transiently projects 0 of 8 karts** (it eases toward the kart), which reads exactly like the off-screen-camera bug it is meant to detect | sampling the viewport four times over ~1.4 s and asserting on the settled frame — a real player never sees a 5-second stall between frames |
| Chrome's own `/favicon.ico` request counted as "console error on a page with no icon" | naming the ignored requests instead of loosening the assertion |

### Honest limits

- **I cannot see the screenshots.** Pixel statistics (mean luma, distinct colours, band
  contrast, frame-to-frame difference) prove the frame is painted and changes with the race;
  they cannot judge whether it looks *good*. The PNGs are in `shots/` for you to judge, and
  `node tools/png-inspect.mjs shots/results.png` prints any of them as a luminance map.
- The headless frame rate (8–12 fps) is SwiftShader, a software rasteriser. On real hardware
  this is a 60 fps game; `?quality=low` helps a slow laptop.
- The harness drives the player with a pure-pursuit controller of its own, not a human: it
  holds the racing line and drifts the corners, but it is not a *good* player. Lap times under
  the bots' control are whatever the bots do; only the item/drift/lap mechanics are asserted.
- The four suites were written by four teams in parallel and were still changing while these
  numbers were taken. Re-run `npm run verify` after any change — that is the point of it.
