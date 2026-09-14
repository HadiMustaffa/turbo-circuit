// tools/capture.mjs — capture representative, human-viewable screenshots of the game.
// (The browser suite's shots are for verification at ?quality=low; these are the ones you
// actually want to look at, framed on the action at full internal resolution.)
//
//   node tools/capture.mjs [--quality high|low]
//
// Each shot is decoded afterwards with tools/png-decode.mjs and printed as numbers, so a
// text-only reader (or a CI job) can tell a rendered frame from a black one.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG } from './png-decode.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = Number(process.env.PORT || 8130);
const SHOTS = join(ROOT, 'shots');
const QUALITY = process.argv.includes('--quality') ? process.argv[process.argv.indexOf('--quality') + 1] : 'high';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

// The page-side driver: pure-pursuit steering at the centreline the sim itself reports, so the
// karts actually race the circuit while the camera is captured.
const DRIVER = `(() => {
  const cl = (v, a, b) => (v < a ? a : v > b ? b : v);
  const ang = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  const p = () => __game.state.racers[__game.state.playerIndex];
  window.__D = {
    fresh() { __game.setInput(0); __game.newRace(0); __game.step(240); return __game.info().phase; },
    kmh() { return __game.info().speedKmh; },
    drive(n, o) {
      o = o || {};
      const look = o.look || 26;
      let last = __game.info().speedKmh;
      for (let i = 0; i < n; i++) {
        const q = p(), tr = __game.state.track;
        const onRoad = q.surface !== 'grass' && q.surface !== 'wall';
        const pt = tr.pointAt(q.s + (onRoad ? cl(10 + q.speed * 0.9, 10, 30) : 5));
        const err = ang(Math.atan2(pt.x - q.x, pt.z - q.z) - q.heading);
        let bits = 1;
        if (Math.abs(err) > 0.55) bits &= ~1;
        if (err > 0.03) bits |= 4; else if (err < -0.03) bits |= 8;
        if (o.drift && onRoad && q.speed > 10 && Math.abs(err) > 0.06 && Math.abs(err) < 1.2) bits |= 16;
        if (o.item && i > 20) bits |= 32;
        __game.setInput(bits); __game.step(1);
        last = __game.info().speedKmh;
      }
      return last;
    },
  };
  return true;
})()`;

let server = null;
try { await fetch(`http://127.0.0.1:${PORT}/index.html`); } catch {
  server = spawn(process.execPath, ['serve.mjs'], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${PORT}/index.html`); break; } catch { await sleep(150); } }
}
await mkdir(SHOTS, { recursive: true });

const profile = await mkdtemp(join(tmpdir(), 'turbo-caps-'));
const DBG = 9400 + Math.floor(Math.random() * 90);   // 9400-9489
const proc = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--hide-scrollbars', '--mute-audio',
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--use-gl=angle',
  '--force-device-scale-factor=1', '--window-size=1600,900',
  `http://127.0.0.1:${PORT}/index.html?quality=${QUALITY}&player=7`,
], { stdio: 'ignore' });

let target = null;
for (let i = 0; i < 90 && !target; i++) {
  await sleep(250);
  try {
    const l = await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json();
    target = l.find(t => t.type === 'page' && t.webSocketDebuggerUrl && /index/.test(t.url));
  } catch { /* retry */ }
}
if (!target) { console.error('chrome never exposed a page target'); proc.kill(); if (server) server.kill(); process.exit(2); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pend = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (m, p = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error('page: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text).split('\n')[0]);
  return r.result?.result?.value;
};
await send('Runtime.enable');
for (let i = 0; i < 80; i++) { if (await ev('!!window.__game')) break; await sleep(300); }
await ev(DRIVER);
console.log(`TURBO CIRCUIT stills · quality=${QUALITY}\n`);

const shot = async (name, label) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(s.result.data, 'base64');
  await writeFile(join(SHOTS, name), buf);
  const { rgb, width, height } = decodePNG(buf);
  let sum = 0, n = 0; const colours = new Set();
  for (let i = 0; i < rgb.length; i += 3 * 7) {
    sum += (rgb[i] + rgb[i + 1] + rgb[i + 2]) / 3; n++;
    colours.add((rgb[i] >> 3 << 10) | (rgb[i + 1] >> 3 << 5) | (rgb[i + 2] >> 3));
  }
  console.log(`  saved ${name} (${(buf.length / 1024).toFixed(0)} kB) — ${width}x${height}, avg luma ${(sum / n).toFixed(1)}, ${colours.size} distinct colours${label ? '  ·  ' + label : ''}`);
};

// ── 1. title screen / menu (the state the page boots into)
await sleep(900);
await shot('title-screen.png', 'title, character strip, race buttons');

// ── 2. the start grid, mid-countdown, chase camera
await ev('__game.setInput(0); __game.newRace(0); __game.camera("chase"); true');
await sleep(900);
await shot('start-grid.png', `${await ev('document.getElementById("countdown").textContent')} on the countdown, 8 karts on the grid`);

// ── 3. mid-race with the HUD live
await ev('__D.fresh(); true');
await ev('__D.drive(700, { drift: true }); true');
await ev('__game.setInput(1); true');   // keep the throttle pinned so the captured frame is a real mid-race moment
await sleep(700);
await shot('race-hud.png', `${Number(await ev('__D.kmh()')).toFixed(0)} km/h, lap ${(await ev('__game.info().lap'))}/${await ev('__game.info().laps')}, HUD + minimap + standings`);

// ── 4. the far camera, which shows more of the pack
await ev('__game.camera("far"); __D.drive(120, { drift: true }); true');
await sleep(500);
await shot('race-far.png', 'far camera');
await ev('__game.camera("chase"); true');

// ── 5. the results screen, after driving a whole race
console.log('\n  driving a full race for the results screen …');
let fin = null;
for (let i = 0; i < 24; i++) {
  await ev('__D.drive(900, { drift: true, item: true }); true');
  fin = await ev('({ phase: __game.info().phase, fin: __game.info().finishedOrder.length, tick: __game.info().tick })');
  process.stdout.write(`    ...${fin.tick} ticks, phase ${fin.phase}, ${fin.fin} finished\r`);
  if (fin.phase === 'finished') break;
}
console.log();
await sleep(1200);
await shot('results.png', `results table after ${fin.tick} ticks (${fin.fin} finishers)`);

await writeFile(join(SHOTS, 'README.txt'),
  `TURBO CIRCUIT stills — captured by tools/capture.mjs at ?quality=${QUALITY}\n` +
  `   title-screen.png  the menu: character strip, GRAND PRIX / TIME TRIAL / circuit buttons\n` +
  `   start-grid.png    the 8-kart grid on the countdown\n` +
  `   race-hud.png      mid-race: HUD, minimap, standings, drift meter\n` +
  `   race-far.png      the far camera\n` +
  `   results.png       the results table after a finished race\n`);
console.log(`\n  wrote ${SHOTS}/README.txt`);
console.log('  tools/png-inspect.mjs shots/race-hud.png   — prints any shot as a luminance map');

proc.kill(); if (server) server.kill();
process.exit(0);
