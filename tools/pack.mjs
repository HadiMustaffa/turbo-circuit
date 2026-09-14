// tools/pack.mjs — build the folder you upload, so you never ship the tests.
//
//   node tools/pack.mjs
//
// Produces:
//   dist/                        index.html + src/ + vendor/  (everything the game fetches)
//   dist/../arena-breach.zip     the same files, zipped for itch.io (index.html at the root)
//
// The game is fully static with no build step: this copies, it does not compile. If a file
// is missing from this list the game will 404 on the host, so `tools/verify-dist.mjs` boots
// the packed copy in a real browser afterwards.
import { cp, mkdir, rm, stat, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DIST = join(ROOT, 'dist');
const ZIP = join(ROOT, 'arena-breach.zip');

// Only what the browser actually fetches.
const INCLUDE = ['index.html', 'src', 'vendor'];

const walk = async (dir, base = dir) => {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p, base));
    else out.push(relative(base, p).replaceAll('\\', '/'));
  }
  return out;
};

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

const missing = INCLUDE.filter(f => !existsSync(join(ROOT, f)));
if (missing.length) { console.error('missing required files:', missing.join(', ')); process.exit(1); }

for (const item of INCLUDE) await cp(join(ROOT, item), join(DIST, item), { recursive: true });
// GitHub Pages runs Jekyll over branch deploys; .nojekyll switches that off so no file is rewritten.
await writeFile(join(DIST, '.nojekyll'), '');

const files = (await walk(DIST)).sort();
let bytes = 0;
for (const f of files) bytes += (await stat(join(DIST, f))).size;

// Fail loudly rather than shipping a broken build: every relative import in dist/ must resolve.
const broken = [];
for (const f of files.filter(f => /\.(js|mjs|html)$/.test(f))) {
  const text = await readFile(join(DIST, f), 'utf8');
  const rewrites = [...text.matchAll(/(?:import|export)[^'"\n]*from\s*['"]([^'"]+)['"]/g)]
    .concat([...text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)])
    .concat([...text.matchAll(/<script[^>]+src=['"]([^'"]+)['"]/g)]);
  for (const m of rewrites) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    if (!existsSync(join(DIST, dirname(f), spec)) && !existsSync(join(DIST, dirname(f), spec + '.js'))) {
      broken.push(`${f} → ${spec}`);
    }
  }
}
// and the browser's top-level entry must be the real one
if (!files.includes('index.html')) broken.push('index.html is not at the root of dist/');
if (!existsSync(join(DIST, '.nojekyll'))) broken.push('.nojekyll missing (GitHub Pages would run Jekyll over the build)');

if (broken.length) {
  console.error('packed build has unresolvable imports:');
  for (const b of broken) console.error('  ' + b);
  process.exit(1);
}

console.log(`dist/  ${files.length} files, ${(bytes / 1024).toFixed(0)} kB`);
for (const f of files) console.log('  ' + f);

// itch.io wants a zip whose *root* contains index.html.
const { execFileSync } = await import('node:child_process');
await rm(ZIP, { force: true });
let zipped = false;
for (const py of ['python', 'python3', 'py']) {
  try {
    execFileSync(py, ['-c',
      `import shutil,sys; shutil.make_archive(sys.argv[1], 'zip', sys.argv[2])`,
      ZIP.replace(/\.zip$/, ''), DIST], { stdio: 'inherit' });
    zipped = true; break;
  } catch { /* try the next interpreter */ }
}
const zipKb = zipped && existsSync(ZIP) ? ((await stat(ZIP)).size / 1024).toFixed(0) : null;
console.log(zipKb ? `\n${relative(ROOT, ZIP)}  ${zipKb} kB  (upload this to itch.io)` : '\n(zip skipped — python not found)');
console.log('\nnext:  node tools/verify-dist.mjs   — boots the packed copy in a real browser');
