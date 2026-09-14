// tools/capture.mjs — capture representative, human-viewable screenshots of the game.
// (The browser suite's shots are for verification at ?quality=low; these are the ones you
// actually want to look at, framed on the action at full internal resolution.)
//
//   node tools/capture.mjs [--quality high|ultra]
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PORT = Number(process.env.PORT || 8123);
const SHOTS = join(ROOT, 'shots');
const QUALITY = process.argv.includes('--quality') ? process.argv[process.argv.indexOf('--quality') + 1] : 'high';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

let server = null;
try { await fetch(`http://127.0.0.1:${PORT}/index.html`); } catch {
  server = spawn(process.execPath, ['serve.mjs'], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) { try { await fetch(`http://127.0.0.1:${PORT}/index.html`); break; } catch { await sleep(150); } }
}
await mkdir(SHOTS, { recursive: true });

const profile = await mkdtemp(join(tmpdir(), 'arena-caps-'));
const DBG = 9500 + Math.floor(Math.random() * 200);
const proc = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--hide-scrollbars', '--mute-audio',
  '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--use-gl=angle',
  '--force-device-scale-factor=1', '--window-size=1600,900',
  `http://127.0.0.1:${PORT}/index.html?quality=${QUALITY}`,
], { stdio: 'ignore' });

let target = null;
for (let i = 0; i < 90 && !target; i++) {
  await sleep(250);
  try {
    const l = await (await fetch(`http://127.0.0.1:${DBG}/json/list`)).json();
    target = l.find(t => t.type === 'page' && t.webSocketDebuggerUrl && /index/.test(t.url));
  } catch { /* retry */ }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 0; const pend = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const send = (m, p = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error('page: ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text));
  return r.result?.result?.value;
};
await send('Runtime.enable');
for (let i = 0; i < 80; i++) { if (await ev('!!window.__game')) break; await sleep(300); }
await ev('__game.start(); __game.setMaxSteps(40); true');
await sleep(1500);
console.log('deployed, quality =', JSON.stringify(await ev('__game.renderer.quality')));

const shot = async (name, label) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  const file = join(SHOTS, name);
  await writeFile(file, Buffer.from(s.result.data, 'base64'));
  const kb = (s.result.data.length / 1024).toFixed(0);
  console.log(`  saved ${name} (${kb} kB)${label ? ' — ' + label : ''}`);
};

// ── 1. the arena with a horde bearing down, seen from the platform
await ev(`(() => {
  const st = __game.state;
  st.wave.state = 'cleared'; st.wave.timer = 9999; st.enemies.length = 0;
  st.player.pos.x = 0; st.player.pos.y = 1.9; st.player.pos.z = 6; st.player.yaw = 0; st.player.pitch = -0.06;
  st.weapon.idx = 0; st.weapon.ammo[0] = 30; st.weapon.reserve[0] = 210;
  const types = ['runner','grunt','spitter','brute','runner','grunt','warden'];
  for (let i = 0; i < 22; i++) {
    const a = (i / 22) * Math.PI * 1.5 - Math.PI * 0.75;
    const d = 7 + (i % 7) * 2.2;
    const id2 = __game.spawnAt(types[i % types.length], d);
    const e = st.enemies.find(x => x.id === id2);
    if (e) { e.pos.x = Math.sin(a) * d; e.pos.z = 6 - Math.cos(a) * d; e.pos.y = 0; }
  }
  return st.enemies.length;
})()`);
await sleep(4500);
await shot('arena-horde.png', 'horde at full internal resolution');

// ── 2. red-dot ADS on a target
await ev(`(() => {
  const st = __game.state;
  st.enemies.length = 0;
  __game.spawnAt('grunt', 12); __game.spawnAt('grunt', 15); __game.spawnAt('brute', 19);
  st.player.pos.y = 0; st.player.pitch = 0;
  __game.hold(512);
  return true;
})()`);
await sleep(2600);
await shot('arena-ads-reddot.png', 'red dot sight on target');
await ev('__game.release(); true');
await sleep(600);

// ── 3. firing: keep the frame with the brightest muzzle flash out of three tries
let best = null, bestBright = -1;
for (let i = 0; i < 3; i++) {
  await ev(`__game.state.weapon.ammo[0] = 30; __game.hold(256 | 512); true`);
  await sleep(1400);
  const s = await send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(s.result.data, 'base64');
  await writeFile(join(tmpdir(), `firing-${i}.png`), buf);
  const { decodePNG } = await import('./png-decode.mjs');
  const img = decodePNG(buf);
  let bright = 0;
  for (let p = 0; p < img.rgb.length; p += 3 * 5) if (img.rgb[p] + img.rgb[p + 1] + img.rgb[p + 2] > 560) bright++;
  if (bright > bestBright) { bestBright = bright; best = buf; }
  await ev('__game.release(); true');
  await sleep(900);
}
await writeFile(join(SHOTS, 'arena-firing.png'), best);
console.log(`  saved arena-firing.png — brightest of 3 frames (${bestBright} hot pixels)`);

// ── 4. shotgun hipfire, wide view of the arena
await ev(`(() => {
  const st = __game.state;
  st.enemies.length = 0;
  st.player.yaw = Math.PI * 0.75; st.player.pitch = -0.02;
  for (let i = 0; i < 10; i++) __game.spawnAt(i % 3 === 0 ? 'runner' : 'grunt', 6 + i * 1.4);
  st.weapon.idx = 2; st.weapon.ammo[2] = 7;
  return true;
})()`);
await sleep(3000);
await ev('__game.hold(256); true');
await sleep(260);
await shot('arena-shotgun.png', 'shotgun hipfire');
await ev('__game.release(); true');
await sleep(500);

// ── 5. marksman iron sights, long lane
await ev(`(() => {
  const st = __game.state;
  st.enemies.length = 0;
  st.player.pos.x = -40; st.player.pos.z = 8; st.player.yaw = 3 * Math.PI / 2; st.player.pitch = 0;
  st.weapon.idx = 3; st.weapon.ammo[3] = 12;
  __game.spawnAt('brute', 24); __game.spawnAt('grunt', 30); __game.spawnAt('spitter', 20);
  __game.hold(512);
  return true;
})()`);
await sleep(2600);
await shot('arena-marksman-iron.png', 'iron sights, 22 degree ADS zoom');
await ev('__game.release(); true');

// ── 6. title screen
await ev('__game.setOverlay("title"); true');
await sleep(900);
await shot('title-screen.png', 'title / controls / loadout');

proc.kill(); if (server) server.kill();
process.exit(0);
