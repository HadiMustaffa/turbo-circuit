// test/run-all.mjs — the definition of done, in one command.
//
//   npm run verify            →  node test/run-all.mjs
//
// Runs every suite, in order, in its own Node process:
//
//   test/sim.test.mjs      the deterministic core (SIM)
//   test/track.test.mjs    the circuit geometry (WORLD)
//   test/render.test.mjs   the kart rigs via headless three.js (KARTS)
//   test/browser-check.mjs the real page in real Chrome over CDP (HARNESS)
//
// It does NOT stop at the first failure: when something is broken you want the whole picture,
// not the first crash. A suite whose file does not exist yet is reported as SKIPPED (missing)
// rather than blowing up the run. The exit code is non-zero if anything actually failed.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SUITES = [
  { name: 'SIM      ', file: 'test/sim.test.mjs', label: 'npm test', timeout: 300 },
  { name: 'WORLD    ', file: 'test/track.test.mjs', label: 'npm run test:track', timeout: 300 },
  { name: 'KARTS    ', file: 'test/render.test.mjs', label: 'npm run test:render', timeout: 300 },
  { name: 'BROWSER  ', file: 'test/browser-check.mjs', label: 'npm run test:browser', timeout: Number(process.env.BROWSER_TIMEOUT || 900) },
];

// The suites each print their own accounting in their own dialect — "128 passed, 0 failed"
// (sim, browser), "PASS 148  FAIL 0" (karts), "✓ / ✗" or "ok / not ok" per assertion (track).
// All four are read here, and a suite that prints none of them is called out rather than
// silently counted as zero.
function countOutput(text) {
  let marks = 0, crosses = 0;
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (/^[\u2713\u2714]/.test(t) || /^ok[\s:]/.test(t) || /^PASS[\s:]/.test(t)) marks++;
    else if (/^[\u2717\u2718]/.test(t) || /^not ok[\s:]/.test(t) || /^FAIL[\s:]/.test(t)) crosses++;
  }
  const trailer = text.match(/PASS\s+(\d+)\s+FAIL\s+(\d+)/i)
    || text.match(/(\d+)\s+passed[,\s]+(\d+)\s+failed/i);
  return {
    pass: trailer ? Number(trailer[1]) : marks,
    fail: trailer ? Number(trailer[2]) : crosses,
    reported: !!trailer,
    marks, crosses,
  };
}

const runSuite = (suite) => new Promise((resolve) => {
  const abs = join(ROOT, suite.file);
  if (!existsSync(abs)) {
    resolve({ ...suite, status: 'SKIPPED', pass: null, fail: null, ms: 0, code: null, tail: [] });
    return;
  }
  const t0 = Date.now();
  const child = spawn(process.execPath, [suite.file], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const onData = (b) => { const s = b.toString(); out += s; process.stdout.write(s); };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* gone */ } }, suite.timeout * 1000);
  child.on('error', (e) => {
    clearTimeout(timer);
    resolve({ ...suite, status: 'FAIL', pass: 0, fail: 1, code: null, ms: Date.now() - t0, tail: [String(e.message)], out });
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    const c = countOutput(out);
    const pass = (code === 0 && c.pass === 0 && c.fail === 0) ? 0 : c.pass;
    resolve({
      ...suite, code, ms: Date.now() - t0,
      status: timedOut ? 'FAIL' : code === 0 ? 'PASS' : 'FAIL',
      pass: c.fail === 0 && c.pass === 0 ? 0 : pass,
      fail: c.fail + (timedOut ? 1 : 0),
      reported: c.reported,
      tail: out.trim().split(/\r?\n/).slice(-8),
      note: timedOut ? `TIMED OUT after ${suite.timeout}s` : (c.pass + c.fail === 0 ? 'no assertions were printed' : ''),
    });
  });
});

console.log(`TURBO CIRCUIT — full verification (${SUITES.length} suites, in order)\n`);
const results = [];
for (const suite of SUITES) {
  console.log(`\n${'═'.repeat(72)}\n▶ ${suite.file}   (${suite.label})`);
  if (!existsSync(join(ROOT, suite.file))) {
    console.log(`  SKIPPED — ${suite.file} does not exist yet (not written by its team)`);
    results.push({ ...suite, status: 'SKIPPED', pass: null, fail: null, ms: 0, code: null, tail: [] });
    continue;
  }
  const r = await runSuite(suite);
  results.push(r);
  console.log(`\n  → ${r.status}${r.note ? ' (' + r.note + ')' : ''}`);
}

// ── the table
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const width = 80;
console.log(`\n${'\u2550'.repeat(width)}`);
console.log(` ${pad('SUITE', 24)}${pad('RESULT', 10)}${padL('PASS', 7)}${padL('FAIL', 7)}${padL('TIME', 10)}${padL('EXIT', 7)}`);
console.log(` ${'\u2500'.repeat(width - 2)}`);
for (const r of results) {
  const time = r.ms ? `${(r.ms / 1000).toFixed(1)}s` : '\u2014';
  console.log(` ${pad(r.file, 24)}${pad(r.status, 10)}${padL(r.pass == null ? '\u2014' : r.pass, 7)}${padL(r.fail == null ? '\u2014' : r.fail, 7)}${padL(time, 10)}${padL(r.code == null ? '\u2014' : r.code, 7)}`);
}
console.log(` ${'\u2500'.repeat(width - 2)}`);

const failed = results.filter(r => r.status === 'FAIL');
const skipped = results.filter(r => r.status === 'SKIPPED');
const passedSuites = results.filter(r => r.status === 'PASS');
const totalPass = results.reduce((a, r) => a + (r.pass || 0), 0);
const totalFail = results.reduce((a, r) => a + (r.fail || 0), 0);
console.log(` ${passedSuites.length} passed · ${failed.length} failed · ${skipped.length} skipped   (${totalPass} checks passed, ${totalFail} checks failed)`);

if (skipped.length) {
  console.log(`\nSKIPPED (not written yet):`);
  for (const r of skipped) console.log(`  - ${r.file}`);
}
if (failed.length) {
  console.log(`\nFAILED SUITES:`);
  for (const r of failed) {
    console.log(`  - ${r.file}${r.note ? ' — ' + r.note : ''} (exit ${r.code})`);
    for (const line of (r.tail || []).slice(-6)) console.log(`      ${line}`);
  }
  console.log('\nTURBO CIRCUIT is NOT verified.');
  process.exit(1);
}
if (skipped.length === results.length) {
  console.log('\nNothing ran — every suite is still missing.');
  process.exit(1);
}
console.log(skipped.length
  ? '\nEvery suite that exists passed.'
  : '\nTURBO CIRCUIT is verified end to end: sim, track, karts and the real page in real Chrome.');
