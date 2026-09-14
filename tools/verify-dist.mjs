// tools/verify-dist.mjs — boot the PACKED build in a real browser, the way a host serves it.
//
//   node tools/verify-dist.mjs
//   node tools/verify-dist.mjs --live https://hadimustaffa.github.io/turbo-circuit/
//
// A packed build fails differently from the source tree: if a file didn't make it into dist/,
// the page still loads and then dies on a 404 import — which is exactly what your friend would
// hit. So this checks two mount points, and treats ANY failed request as a failure:
//
//   1. mounted at a subpath  (http://127.0.0.1:8141/dist/)  — how GitHub Pages project sites
//      serve, and how itch nests uploads
//   2. mounted at the root   (http://127.0.0.1:8142/)      — how Netlify Drop / Cloudflare serve
//   3. --live <url>          — the real deployed copy, over the network
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, access, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG } from './png-decode.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DEBUG_BASE = 9500;   // 9500-9599 (browser-check uses 9300+, capture 9400+)

let pass = 0, fail = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) { pass++; console.log(`  \u2713 ${msg}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  \u2717 ${msg}${extra ? '  ' + extra : ''}`); }
};

try { await access(join(ROOT, 'dist', 'index.html')); }
catch { console.error('no dist/ — run:  node tools/pack.mjs'); process.exit(1); }

const servers = [];
const startServer = async (root, port) => {
  const s = spawn(process.execPath, ['serve.mjs', '--root', root], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, PORT: String(port) } });
  servers.push(s);
  for (let i = 0; i < 60; i++) {
    try { await fetch(`http://127.0.0.1:${port}/`, { method: 'HEAD' }); return s; } catch { await sleep(150); }
  }
  throw new Error('server did not come up on ' + port);
};

const mount = async (label, port, url, root) => {
  console.log(`\n\u25b6 ${label}  ${url}`);
  if (root) await startServer(root, port);   // a live URL brings its own host
  const profile = await mkdtemp(join(tmpdir(), 'verify-dist-'));
  const dbg = DEBUG_BASE + Math.floor(Math.random() * 90);
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--mute-audio',
    '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--use-gl=angle',
    '--window-size=1200,700', url,
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 90 && !target; i++) {
    await sleep(250);
    try {
      const l = await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json();
      target = l.find(t => t.type === 'page' && t.webSocketDebuggerUrl && t.url.includes(new URL(url).pathname.split('/')[1] || 'index'));
      if (!target) target = l.find(t => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('devtools'));
    } catch { /* retry */ }
  }
  if (!target) { ok(false, 'the browser exposed a page target'); proc.kill(); return; }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0; const pend = new Map();
  const failures = [];   // failed requests — the whole point of this suite
  const consoleErrors = [];
  const faviconErrors = [];
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === 'Network.responseReceived') {
      const r = m.params.response;
      if (r.status >= 400) (/(favicon)/i.test(r.url) ? faviconErrors : failures).push(`${r.status} ${r.url.split('/').slice(3).join('/')}`);
    }
    if (m.method === 'Network.loadingFailed' && !/favicon/.test(m.params.documentURL || '')) {
      // ERR_ABORTED is what a page's own in-flight request reports when we reload it — not a
      // missing file. A real 404 arrives through Network.responseReceived above.
      if (!/ERR_ABORTED/.test(m.params.errorText || '')) failures.push(`NETFAIL ${m.params.errorText} ${(m.params.type || '')}`);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      const text = (m.params.args || []).map(a => a.value || a.description || '').join(' ').slice(0, 160);
      if (!/favicon/i.test(text)) consoleErrors.push(text);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('uncaught: ' + (m.params.exceptionDetails?.exception?.description || '').slice(0, 160));
    }
  });
  const send = (m, p = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed');
    return r.result?.result?.value;
  };
  await send('Runtime.enable'); await send('Network.enable'); await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });

  let booted = false;
  for (let i = 0; i < 90; i++) { if (await ev('!!window.__game').catch(() => false)) { booted = true; break; } await sleep(300); }
  ok(booted, 'the packed page boots (window.__game exists)');
  if (!booted) { proc.kill(); return; }

  // no input during the countdown: holding the throttle through "3 2 1" bogs the start by design
  await ev('__game.setInput(0); __game.newRace(0); __game.step(240); __game.setInput(1); true');
  await sleep(3500);
  const stats = await ev(`(() => { const i = __game.info();
    return { calls: i.drawCalls, tris: i.triangles, phase: i.phase, kmh: i.speedKmh, track: i.track.name, lap: i.lap, laps: i.laps,
             onScreen: i.charactersOnScreen, renderer: i.renderer }; })()`);
  ok(stats.renderer === 'webgl' && stats.calls > 10, 'the renderer draws the packed build',
    `renderer=${stats.renderer}, ${stats.calls} draw calls, ${stats.tris} triangles`);
  ok(stats.phase === 'racing' && stats.kmh > 20, 'the simulation is racing in the packed build',
    `${stats.track}, phase=${stats.phase}, lap ${stats.lap}/${stats.laps}, ${Number(stats.kmh).toFixed(0)} km/h`);
  const sim = await ev(`(() => { const s = __game.state; return { racers: s.racers.length, moving: s.racers.filter(r => r.speed > 1).length, pickups: s.pickups.length }; })()`);
  ok(sim.racers === 8 && sim.moving >= 6, 'the 8-kart field is alive and moving in the packed build',
    `${sim.racers} karts, ${sim.moving} moving, ${sim.pickups} item boxes`);
  ok(stats.onScreen >= 4, 'karts are actually on screen in the packed build', `${stats.onScreen}/8 projected inside the viewport`);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(shot.result.data, 'base64');
  await writeFile(join(ROOT, 'shots', `dist-${label.replace(/\W+/g, '-').toLowerCase()}.png`), buf);
  const img = decodePNG(buf);
  let lumaSum = 0, n = 0;
  const colours = new Set();
  for (let p = 0; p < img.rgb.length; p += 3 * 7) {
    const L = (img.rgb[p] + img.rgb[p + 1] + img.rgb[p + 2]) / 3;
    lumaSum += L; n++;
    colours.add((img.rgb[p] >> 3 << 10) | (img.rgb[p + 1] >> 3 << 5) | (img.rgb[p + 2] >> 3));
  }
  ok(lumaSum / n > 8 && colours.size > 100, 'the packed build renders a lit, varied frame, not a black canvas',
    `mean luma ${(lumaSum / n).toFixed(1)}, ${colours.size} distinct colours, shot saved to shots/dist-*.png`);

  ok(consoleErrors.length === 0, 'no console errors', consoleErrors.slice(0, 3).join(' | '));
  ok(failures.length === 0, 'every file the page asked for was present (no 404s)', failures.slice(0, 6).join(' | ') || 'clean');
  if (faviconErrors.length) console.log(`   (ignored: ${faviconErrors.length} favicon requests Chrome makes itself)`);

  proc.kill();
};

// shots/ already holds the hand-captured stills — add to it, never wipe it.
await mkdir(join(ROOT, 'shots'), { recursive: true });

// --live <url> checks a deployed copy (GitHub Pages, Netlify, itch) instead of local mounts.
const liveArg = process.argv.indexOf('--live');
if (liveArg >= 0 && process.argv[liveArg + 1]) {
  const url = process.argv[liveArg + 1];
  await mount('LIVE deploy', 0, url, null);
  console.log(`\n${'\u2500'.repeat(66)}\n${pass} passed, ${fail} failed`);
  console.log(fail === 0 ? `the live deploy at ${url} runs` : 'THE LIVE DEPLOY IS BROKEN');
  process.exit(fail === 0 ? 0 : 1);
}

await mount('subpath  (GitHub Pages style)', 8141, 'http://127.0.0.1:8141/dist/', join(ROOT));
await mount('root  (Netlify / Cloudflare style)', 8142, 'http://127.0.0.1:8142/', join(ROOT, 'dist'));

for (const s of servers) s.kill();
console.log(`\n${'\u2500'.repeat(66)}\n${pass} passed, ${fail} failed`);
console.log(fail === 0 ? 'the packed build runs hosted' : 'THE PACKED BUILD IS BROKEN — fix before uploading');
process.exit(fail === 0 ? 0 : 1);
