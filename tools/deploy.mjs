// tools/deploy.mjs — publish an update to GitHub Pages, then prove it's live.
//
//   node tools/deploy.mjs "tuned the drift charge"
//   node tools/deploy.mjs "..." --tests      (run the full suite before shipping anything)
//
// What it does, in order, and it stops on the first real failure:
//   1. pack the build (dist/ + turbo-circuit.zip) and fail if any relative import wouldn't resolve
//   2. commit whatever changed
//   3. push main (the source source of truth) and re-cut gh-pages (the built game)
//   4. wait for GitHub's Pages build to finish
//   5. boot the LIVE url in a real browser and assert it plays
//
// Step 5 is the point: a Pages deploy that "succeeded" but serves a broken bundle looks
// exactly like a good one from the git side.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const message = args.join(' ') || 'update';
const RUN_TESTS = process.argv.includes('--tests');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// This project's home, used as a fallback and as a sanity check on the git remote.
const EXPECTED = { owner: 'HadiMustaffa', repo: 'turbo-circuit', live: 'https://hadimustaffa.github.io/turbo-circuit/' };

// `gh` was installed for this project but a shell open since then may not know that yet.
const GH = ['gh', 'C:/Program Files/GitHub CLI/gh.exe', 'C:/Program Files (x86)/GitHub CLI/gh.exe']
  .find(p => p === 'gh' ? spawnSync('gh', ['--version'], { shell: true }).status === 0 : existsSync(p));
if (!GH) { console.error('gh CLI not found — install with: winget install --id GitHub.cli -e'); process.exit(1); }

const run = (cmd, argv, opts = {}) => {
  const r = spawnSync(cmd, argv, { cwd: ROOT, stdio: 'inherit', shell: false, ...opts });
  if (r.status !== 0 && !opts.allowFail) { console.error(`\n\u2717 ${cmd} ${argv.join(' ')} failed (${r.status})`); process.exit(1); }
  return r;
};
const capture = (cmd, argv) => (spawnSync(cmd, argv, { cwd: ROOT, encoding: 'utf8' }).stdout || '').trim();

// ── 0. where are we pointing?
const remote = capture('git', ['remote', 'get-url', 'origin']);
const m = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
if (!m) { console.error(`origin is not a GitHub repo: ${remote || '(none)'}`); process.exit(1); }
const [, owner, repo] = m;
const liveUrl = `https://${owner.toLowerCase()}.github.io/${repo}/`;
if (owner !== EXPECTED.owner || repo !== EXPECTED.repo) {
  console.error(`origin is ${owner}/${repo}, expected ${EXPECTED.owner}/${EXPECTED.repo} — refusing to deploy to the wrong place.`);
  process.exit(1);
}
if (liveUrl !== EXPECTED.live) console.log(`note: live url is ${liveUrl} (documented: ${EXPECTED.live})`);
console.log(`deploying to ${owner}/${repo}\n  live: ${liveUrl}\n`);

// ── 1. pack  (pack.mjs fails the build if any relative import in dist/ would not resolve)
console.log('\u25b6 1/5 packing the build');
run(process.execPath, ['tools/pack.mjs']);

if (RUN_TESTS) {
  console.log('\n\u25b6 1b/5 running every suite before shipping (--tests)');
  run(process.execPath, ['test/run-all.mjs']);
}

// ── 2. commit
console.log('\n\u25b6 2/5 committing');
const dirty = capture('git', ['status', '--porcelain']);
if (!dirty) console.log('  (nothing changed)');
else {
  console.log(dirty.split('\n').slice(0, 12).join('\n') + (dirty.split('\n').length > 12 ? '\n  …' : ''));
  run('git', ['add', '-A']);
  run('git', ['commit', '-q', '-m', message]);
  console.log(`  committed: ${message}`);
}

// ── 3. push source, then re-cut the built branch
console.log('\n\u25b6 3/5 pushing source + build');
run('git', ['push', '-q', 'origin', 'main']);

// `git subtree push` refuses to force-update, which is correct but gets in the way after a
// rebase or an amended commit. Fall back to an explicit force push of the split subtree.
const sub = spawnSync('git', ['subtree', 'push', '--prefix', 'dist', 'origin', 'gh-pages'], { cwd: ROOT, encoding: 'utf8' });
if (sub.status !== 0) {
  console.log('  subtree push rejected — splitting and force-updating gh-pages');
  run('git', ['branch', '-D', '__pages'], { allowFail: true });
  run('git', ['subtree', 'split', '--prefix', 'dist', '-b', '__pages']);
  run('git', ['push', '-q', '--force', 'origin', '__pages:gh-pages']);
  run('git', ['branch', '-q', '-D', '__pages']);
} else {
  const line = (sub.stdout || sub.stderr || '').trim().split('\n').pop();
  console.log('  ' + line);
}

// ── 4. wait for GitHub to build it
console.log('\n\u25b6 4/5 waiting for GitHub Pages');
let status = '', waited = 0;
for (let i = 0; i < 30; i++) {
  await sleep(6000); waited += 6;
  status = capture(GH, ['api', `repos/${owner}/${repo}/pages`, '--jq', '.status']);
  process.stdout.write(`  ${status || '(pending)'} after ${waited}s\r`);
  if (status === 'built') break;
  if (status === 'errored') { console.error('\n\u2717 GitHub Pages reported: errored — check the repo Actions tab'); process.exit(1); }
}
console.log(`  status: ${status || 'unknown'} after ${waited}s`);

// ── 5. prove the live site actually runs
console.log('\n\u25b6 5/5 verifying the live deploy in a real browser');
run(process.execPath, ['tools/verify-dist.mjs', '--live', liveUrl]);

console.log(`\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`);
console.log(`live:  ${liveUrl}`);
console.log(`repo:  https://github.com/${owner}/${repo}`);
console.log('itch:  upload turbo-circuit.zip (built in step 1)');
