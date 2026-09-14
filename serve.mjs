// serve.mjs — zero-dependency static file server.
// ES modules must be fetched over http:// (file:// is blocked by CORS), so the game needs a
// server; this one needs no install.
//
//   node serve.mjs              → http://127.0.0.1:8123      (this machine only)
//   node serve.mjs --lan        → http://192.168.x.x:8123    (everyone on your wifi)
//   node serve.mjs --root dist  → serve a packed build instead of the source tree
//   PORT=9000 node serve.mjs    → pick a port
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { networkInterfaces } from 'node:os';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const LAN = argv.includes('--lan');
const ROOT = resolve(process.cwd(), flag('root', '.'));
const PORT = Number(process.env.PORT || flag('port', 8123));
const HOST = LAN ? '0.0.0.0' : '127.0.0.1';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';   // directory index
    const full = resolve(join(ROOT, pathname));
    // never serve outside the served root
    if (!full.startsWith(ROOT + sep) && full !== ROOT) {
      res.writeHead(403, { 'Content-Type': 'text/plain' }).end('forbidden');
      return;
    }
    const st = await stat(full);
    if (st.isDirectory()) { res.writeHead(403).end('directory'); return; }
    const body = await readFile(full);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Length': body.length,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404 ' + (e && e.code ? e.code : ''));
  }
});

const lanIps = () => Object.values(networkInterfaces()).flat()
  .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);

server.listen(PORT, HOST, () => {
  console.log(`arena live on http://127.0.0.1:${PORT}`);
  if (LAN) {
    const ips = lanIps();
    if (!ips.length) console.log('  (no LAN address found — are you on wifi?)');
    for (const ip of ips) console.log(`  friends on your wifi:  http://${ip}:${PORT}`);
  } else {
    console.log('  (this machine only — add --lan to let other devices on your wifi connect)');
  }
  console.log(`  serving: ${ROOT}`);
});
