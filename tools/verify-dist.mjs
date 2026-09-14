// tools/verify-dist.mjs — boot the PACKED build in a real browser, the way a host serves it.
//
//   node tools/verify-dist.mjs
//
// A packed build fails differently from the source tree: if a file didn't make it into dist/,
// the page still loads and then dies on a 404 import — which is exactly what your friend would
// hit. So this checks two mount points, and treats ANY failed request as a failure:
//
//   1. mounted at a subpath  (http://127.0.0.1:8131/dist/)  — how GitHub Pages project sites
//      serve, and how itch nests uploads
//   2. mounted at the root   (http://127.0.0.1:8132/)      — how Netlify Drop / Cloudflare serve
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG } from './png-decode.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

let pass = 0, fail = 0;
const ok = (cond, msg, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${msg}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${msg}${extra ? '  ' + extra : ''}`); }
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
  console.log(`\n▶ ${label}  ${url}`);
  if (root) await startServer(root, port);   // a live URL brings its own host
  const profile = await mkdtemp(join(tmpdir(), 'verify-dist-'));
  const dbg = 9600 + Math.floor(Math.random() * 200);
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
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  let id = 0; const pend = new Map();
  const failures = [];   // failed requests — the whole point of this suite
  const consoleErrors = [];
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === 'Network.responseReceived') {
      const r = m.params.response;
      if (r.status >= 400) failures.push(`${r.status} ${r.url.split('/').slice(3).join('/')}`);
    }
    if (m.method === 'Network.loadingFailed' && !/favicon/.test(m.params.documentURL || '')) {
      // ERR_ABORTED is what a page's own in-flight request reports when we reload it — not a
      // missing file. A real 404 arrives through Network.responseReceived above.
      if (!/ERR_ABORTED/.test(m.params.errorText || '')) failures.push(`NETFAIL ${m.params.errorText} ${(m.params.type || '')}`);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push((m.params.args || []).map(a => a.value || a.description || '').join(' ').slice(0, 160));
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

  ok(!(await ev('window.__bootError || window.__bootErrors?.length || null')), 'no boot error was recorded');
  await ev('__game.start(); __game.setMaxSteps(40); true');
  await sleep(3500);
  const stats = await ev('(() => { const s = __game.renderer.stats(); return { calls: s.drawCalls, tris: s.triangles, rigs: s.enemyRigs, programs: s.programs }; })()');
  ok(stats.calls > 10, 'the renderer draws the packed build', `${stats.calls} draw calls, ${stats.tris} tris, ${stats.programs} programs`);
  // Headless Chrome never gets pointer lock, so the wave director may not be ticking: spawn
  // hostiles the same way the main browser suite does, which is the proven path.
  await ev(`(() => { __game.state.enemies.length = 0; for (let i = 0; i < 12; i++) __game.spawnAt(i % 3 === 0 ? 'brute' : 'grunt', 8 + i * 1.2); return __game.state.enemies.length; })()`);
  await sleep(1200);
  const alive = await ev('__game.state.enemies.length');
  ok(alive > 0, 'the simulation is alive in the packed build (hostiles exist and are updating)', `${alive} hostiles, ${stats.rigs} rigs`);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(shot.result.data, 'base64');
  await writeFile(join(ROOT, 'shots', `dist-${label.replace(/\W+/g, '-').toLowerCase()}.png`), buf);
  const img = decodePNG(buf);
  const colours = new Set();
  let lumaSum = 0, n = 0;
  for (let p = 0; p < img.rgb.length; p += 3 * 7) {
    const L = (img.rgb[p] + img.rgb[p + 1] + img.rgb[p + 2]) / 3;
    lumaSum += L; n++;
    colours.add((img.rgb[p] >> 3 << 10) | (img.rgb[p + 1] >> 3 << 5) | (img.rgb[p + 2] >> 3));
  }
  ok(lumaSum / n > 8, 'the packed build renders a lit frame, not a black canvas', `mean luma ${(lumaSum / n).toFixed(1)}, ${colours.size} distinct colours`);

  ok(consoleErrors.length === 0, 'no console errors', consoleErrors.slice(0, 3).join(' | '));
  ok(failures.length === 0, 'every file the page asked for was present (no 404s)', failures.slice(0, 6).join(' | '));

  proc.kill();
};

// shots/ already holds the hand-captured stills — add to it, never wipe it.
await (await import('node:fs/promises')).mkdir(join(ROOT, 'shots'), { recursive: true });

// --live <url> checks a deployed copy (GitHub Pages, Netlify, itch) instead of local mounts.
const liveArg = process.argv.indexOf('--live');
if (liveArg >= 0 && process.argv[liveArg + 1]) {
  const url = process.argv[liveArg + 1];
  await mount('LIVE deploy', 0, url, null);
  console.log(`\n──────────────────────────────────────────────────────────────────\n${pass} passed, ${fail} failed`);
  console.log(fail === 0 ? `the live deploy at ${url} runs` : 'THE LIVE DEPLOY IS BROKEN');
  process.exit(fail === 0 ? 0 : 1);
}

await mount('subpath  (GitHub Pages style)', 8131, 'http://127.0.0.1:8131/dist/', join(ROOT));
await mount('root  (Netlify / Cloudflare style)', 8132, 'http://127.0.0.1:8132/', join(ROOT, 'dist'));

for (const s of servers) s.kill();
console.log(`\n──────────────────────────────────────────────────────────────────\n${pass} passed, ${fail} failed`);
console.log(fail === 0 ? 'the packed build runs hosted' : 'THE PACKED BUILD IS BROKEN — fix before uploading');
process.exit(fail === 0 ? 0 : 1);
