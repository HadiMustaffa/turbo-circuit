# Publishing TURBO CIRCUIT — free hosting, no server, no domain

> **It is live already:** **https://hadimustaffa.github.io/turbo-circuit/** — GitHub Pages, free.
> Repo: https://github.com/HadiMustaffa/turbo-circuit (`main` = the source, `gh-pages` = the build).
>
> **To ship an update after any change:**
> ```bash
> npm run deploy            # or: node tools/deploy.mjs "tuned the drift charge"
> ```
> That packs the build, commits, pushes both branches, waits for GitHub's build, and then boots
> the **live URL** in a real browser to prove it plays. `npm run verify:live` re-checks the
> deployment on its own.

The game is a **fully static site**: HTML, CSS and JavaScript files. No backend, no database, no
build step, no API keys, no environment variables. Any host that can serve files can serve this,
and the free tiers are more than enough — the whole build is **1537 kB (342 kB zipped)**, so it
loads in one round trip. The heaviest file is the vendored `three.module.js`.

```bash
npm run pack     # builds dist/ + turbo-circuit.zip and fails on any unresolvable import
npm run verify   # every test suite, in order, with a PASS/FAIL table
```

Run both before you upload anything.

---

## How the GitHub Pages deploy works

Two branches, one repository:

| Branch | Contents | Purpose |
|---|---|---|
| `main` | the real source: `src/`, `test/`, `tools/`, `index.html`, docs | where you work |
| `gh-pages` | **only** the contents of `dist/`, i.e. what the browser fetches | what Pages serves |

`gh-pages` is not pushed by hand: `tools/deploy.mjs` cuts it out of `dist/` with
`git subtree push --prefix dist origin gh-pages`. That keeps one copy of the source of truth and
makes it impossible to ship a file the packer didn't include (a file that isn't copied into
`dist/` can't reach the built branch). If the subtree push is rejected because `gh-pages` has
diverged (after an amended commit or a rebase) the tool falls back to an explicit
`git subtree split` + `git push --force origin __pages:gh-pages`, and says so in the output.

### The exact commands, in order

```bash
node tools/pack.mjs                     # 1. build dist/ + turbo-circuit.zip; fails if any
                                        #    relative import in dist/ would not resolve
git add -A && git commit -m "…"         # 2. commit the source change
git push origin main                    # 3.
git subtree push --prefix dist origin gh-pages   # 4. re-cut the built branch
gh api repos/HadiMustaffa/turbo-circuit/pages --jq .status   # 5. wait for "built"
node tools/verify-dist.mjs --live https://hadimustaffa.github.io/turbo-circuit/   # 6. prove it
```

`npm run deploy` runs exactly those six steps, and stops on the first real failure:

```
▶ 1/5 packing the build            (node tools/pack.mjs)
▶ 2/5 committing
▶ 3/5 pushing source + build       (main, then gh-pages via subtree split)
▶ 4/5 waiting for GitHub Pages     (polls gh api …/pages until status: built)
▶ 5/5 verifying the live deploy in a real browser
```

Step 5 is the point of the whole tool: a Pages deploy that "succeeded" but serves a broken
bundle looks identical to a good one from the git side. It boots the live URL in headless Chrome
over the DevTools Protocol and asserts that the page boots, the renderer reports WebGL with real
draw calls, the sim reaches `racing`, the 8-kart field is moving on screen, and the frame is
painted (decoded and measured — not eyeballed).

`deploy.mjs` refuses to run if `origin` is not `HadiMustaffa/turbo-circuit`, so a stray remote
cannot publish this game somewhere else.

## Verifying the live site

```bash
npm run verify:live
# = node tools/verify-dist.mjs --live https://hadimustaffa.github.io/turbo-circuit/
```

It checks the deployed copy over the network, and it fails on **any** request the page makes that
does not come back 200 (a 404 module looks exactly like a working page until it doesn't run).
Chrome's own `/favicon.ico` probe is reported and ignored, because the game has no icon and that
is not a missing game file.

The same tool with no arguments checks a locally packed build hosted two ways — mounted at a
subpath (`http://127.0.0.1:8141/dist/`, how project Pages sites serve) and at a domain root
(`http://127.0.0.1:8142/`, how Netlify/Cloudflare serve) — because those fail differently:

```bash
npm run pack     # pack + verify-dist, both styles
node tools/verify-dist.mjs
```

## Updating

```bash
# change something in src/, then:
npm run verify                    # 4 suites; the browser one drives real Chrome
npm run deploy "made the hairpin kinder"
```

Pages redeploys automatically on the new `gh-pages` commit; the deploy tool waits for
`status: built` before it verifies, so you are never looking at the previous build.

Rolling back is a revert on `main` followed by another `npm run deploy` — `gh-pages` is
regenerated from `dist/` every time, so it can never drift from the source.

## Where the itch.io zip comes from

`node tools/pack.mjs` (and `npm run pack`) writes **`turbo-circuit.zip`** in the project root:
the same files as `dist/`, zipped so that `index.html` sits at the **root of the zip** — which is
what itch.io requires. Nothing else builds that zip; if you want an itch page, upload this file.

1. **https://itch.io/game/new**
2. Title *TURBO CIRCUIT*, **Kind of project: HTML**.
3. **Uploads → Upload files**: pick `turbo-circuit.zip`.
4. Tick **"This file will be played in the browser"**, set the viewport to about **1280 × 720**,
   and **Embed in page**.
5. Visibility **Public** → Save.

itch runs a 2-hour review queue for a first-time HTML upload, and a project only counts as
playable once the zip is uploaded — so upload the file, don't just create the page. Keyboard
input works inside itch's iframe; if a browser ever refuses fullscreen there, itch's own
**Fullscreen** button plays it top-level.

## Other hosts

| You want | Use |
|---|---|
| A link in the next two minutes, no account | **Netlify Drop** — drag the `dist` folder onto https://app.netlify.com/drop |
| A permanent URL you own, automatic updates | **GitHub Pages** — what this project already does |
| Friends to find it, comments, a game page | **itch.io** — upload `turbo-circuit.zip` |
| To play with friends in the same room, nothing public | `npm run lan` (LAN party over your wifi) |
| Fast in Asia, free tier | **Cloudflare Pages** — upload `dist`, or connect the repo for auto-deploys |

## Things that are true about this build (so you don't get surprised)

- **No server-side anything.** No Node process runs on the host, no env vars, no database. If a
  host asks for a "build command" or a "runtime", the answer is *none* — it's files.
- **Relative paths only.** Pages serves project sites from a subpath (`/turbo-circuit/`), which
  breaks absolute paths like `/src/main.js`. Everything here is `./src/main.js`, so it works at a
  root and at a subpath — which is exactly what `verify-dist.mjs` checks.
- **`.nojekyll` ships in `dist/`.** GitHub Pages runs Jekyll over branch deploys by default; the
  packer writes `.nojekyll` so nothing is rewritten or dropped.
- **Correct MIME types matter.** ES modules will not load as `text/plain`; every host above
  serves `.js` correctly out of the box. `serve.mjs` does too, which is why local testing is
  meaningful.
- **Nothing is secret.** No keys or tokens in this codebase; it is all client-side. Sharing the
  link shares the whole game, which is why it can be public.
- **Framerate is the player's GPU.** `?quality=low|high` overrides the default (auto: low on a
  coarse pointer, high otherwise). The headless verification runs on SwiftShader (software GL) at
  ~12 fps; that number says nothing about real hardware.
