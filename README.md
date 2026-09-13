# Poi contributor data

This repo holds statistical data of all contributors to poi project and community.

## Repositories included

All repositories under poooi organization, plus:

| repo | comment |
|------|---------|
| magicae/poi-nwjs | Antecedent of poi, ~~Sacred Relic~~ |
| ruiii/plugin-Hairstrength | Plugin |
| dkwingsmt/plugin-wheres-my-fuel-gone | Plugin |
| ruiii/poi_theme_paper_dark | Theme |
| Artoria-0x04/poi-theme-lumendark | Theme |
| govizlora/theme-papercyan | Theme |
| Artoria-0x04/paperblack | Theme |
| kcwikizh/poi-plugin-subtitle | Plugin |
| kcwikizh/poi-statistics | Plugin |
| Javran/poi-plugin-mo2 | Plugin |

## Architecture

```
Cloudflare Cron Worker (worker/, GitHub App installation token)
        │  daily schedule, REST workflow_dispatch
        ▼
GitHub Actions: .github/workflows/update-contributors.yml
        │  yarn install --frozen-lockfile → npm test → lint → npm run build
        ▼
npm run build → cache/*.json + cache/opencollective/supporters.json + cache/avatars/*.webp
              → dist/contributors.json + dist/graph.svg + dist/avatars/manifest.json + dist/avatars/*.webp
        │  git add cache dist; commit + push only when the diff is non-empty
        ▼
dist/ is intended for website-kai consumption; that integration is planned
separately and is not part of this repository.
```

- The **archive** (`cache/`) is a version-controlled per-repo snapshot of GitHub's
  contributor stats. It is the fallback whenever the GitHub API is unavailable.
- **dist** holds the legacy `contributors.json`/`graph.svg` pair plus the
  generated `dist/avatars/` artifact. The legacy pair is only rewritten after
  the complete JSON *and* SVG have been generated, so a failed SVG render keeps
  the last-good `contributors.json`/`graph.svg`; the avatar sheets/manifest are
  published earlier in the run and are not rolled back.
- There is no R2/KV/queue storage and no custom locking. The workflow's YAML
  `concurrency` block (`cancel-in-progress: false`) is the only serialization.

## Credits and avatars

`npm run build` (and the standalone `npm run build:avatars`) additionally:

- collects **public** OpenCollective donors for the `poi` collective from
  `https://rest.opencollective.com/poi/members/all.json` (unauthenticated, no
  `/v2`), keeping positive `totalAmountDonated` of every role in source order and
  deduping on the normalized profile URL (trimmed, trailing slashes stripped)
  with `MemberId` as fallback;
- archives normalized 96×96 WebP avatars at `cache/avatars/<sha256(id)>.webp` and
  only public display fields at `cache/opencollective/supporters.json` (never the
  raw export, email or amounts);
- publishes sprite sheets and a deterministic manifest under `dist/avatars/`.

Cached avatars and sprite sheets are both **lossless** WebP (effort 6), so no
generation is lost to recompression. Choice of format is measured, not assumed:
for the real 169-person / 141-image sheet, `optipng -o7 -strip all` produced
2,173,999 bytes while lossless WebP produced 1,453,930 bytes (33.12% smaller), so
lossless WebP is used. Both preserve every visible pixel and the full alpha
channel; WebP may rewrite RGB underneath fully transparent pixels (alpha 0),
which is not a visible or RGBA-visible-pixel difference.

### Artifact contract (`dist/avatars/manifest.json`)

| field | value |
|-------|-------|
| `schemaVersion` | `1` |
| `version` | content digest of the manifest body excluding `version` (no timestamps) |
| `cellSize` / `displaySize` / `pixelRatio` | `96` / `48` / `2` |
| `sheets` | `{ url, width, height }`; `url` is a bare content-hashed filename relative to the manifest |
| `avatars` | `{ [id]: { sheet, x, y, width, height } }`; people without a first-time image are omitted |
| `contributors` | `{ id: "github:<lowercase login>", login, name, profile }`; blank name falls back to `login` |
| `supporters` | `{ id, memberId, name, profile }` in source order; `id` is `oc:<normalized profile>` or `oc:member:<MemberId>`; blank name is `""` |

Slots are assigned by sorting the combined contributor/supporter IDs
lexicographically (display arrays keep their own order), 16 columns, at most 256
cells per sheet. Cells are plain 96px squares with no border or radius, so the
consumer clips them. Sheets are written first and the manifest atomically last;
sheet filenames are content hashes, so sheets referenced by cached manifests are
retained. Identical input produces byte-identical sheets and manifest.

A failure to reach or validate OpenCollective keeps the previous manifest
untouched byte-for-byte; a first run with no previous manifest fails rather than
publish an empty donor list. `npm run build:avatars` regenerates supporters and
sprites from the existing `dist/contributors.json` without re-collecting GitHub
stats, which is useful while iterating on the website artifact.

Network calls use the platform `fetch` and never forward GitHub credentials. To
use a proxy, set `NODE_USE_ENV_PROXY=1` together with `HTTP_PROXY`/`HTTPS_PROXY`
(native Node support; no proxy is hardcoded).

## Development

### Prerequisites

- **Node.js** — current LTS (see `.node-version`).
- **GitHub CLI (`gh`)** — authenticated (`gh auth login`). Only used as a local
  fallback when neither `GH_TOKEN` nor `GITHUB_TOKEN` is set.
- **Vite+ (`vp`)** — lint/format/test runner, installed locally via yarn.

### Commands

| command | description |
|---------|-------------|
| `npm run build` | Refresh contributor data plus OpenCollective donors and avatar sprites; writes `dist/contributors.json`, `dist/graph.svg` and `dist/avatars/`. |
| `npm run build:avatars` | Regenerate supporters and avatar sprites from the existing `dist/contributors.json` without re-collecting GitHub stats. |
| `npm test` | Run the unit test suite (`vp test run`). |
| `npm run lint` | Lint + type-aware checks (`vp lint`). |
| `npm run check` | Format, lint and type-check in one pass (`vp check`). |
| `npm run deploy` | Publish `dist/` to GitHub Pages (`gh-pages`). |

### Tests and CI

`.github/workflows/test.yml` runs on pull requests and pushes to `master`
(`workflow_dispatch` optional): with `contents: read` it installs via
`yarn install --frozen-lockfile`, then runs `npm test`, `npm run lint` and
`npx tsc --noEmit`. It never runs the data build and the tests never call the
upstream GitHub/OpenCollective APIs (dependency installation is the only
network use).

Alongside the unit suites, `build.integration.test.ts` drives the real
`runBuild → refreshAvatars → sharp sprites/manifest → graph.svg` pipeline on a
temporary filesystem, injecting only GitHub/OpenCollective/image inputs and
directories through `createBuildDeps`. It covers a full round-trip (public
names, missing avatars, content hashes, sheet dimensions, lossless visible
pixels), byte-stable reruns, retention of previous sheets and last-good images
by id across avatar URL change/failure, last-good preservation on OC failure,
and a first-run OC failure publishing nothing.

### Local build behavior

- **Fresh stats every run.** `getContributors` always hits the GitHub API, then
  validates the payload at the API boundary. The archive is a fallback, not a
  cache that suppresses refreshes.
- **Bounded retries.** HTTP 202 ("stats being computed"), 403/429 rate limits,
  5xx and network errors are retried a small number of times, honoring
  `Retry-After` / `X-RateLimit-Reset`, within a per-request timeout and a total
  per-repo time budget. Malformed payloads are not retried.
- **Prefer last-good data.** When a previous archive exists, a failed, empty,
  malformed, or identity-hiding (null-author) response keeps that archived
  snapshot for the repo instead of replacing it. A failed profile lookup keeps
  the contributor using data from the previous `dist/contributors.json`. Missing
  repos during a failed org discovery do not mean deletion — the
  archived/manifest repo list is used instead.
- **Fatal persistence.** Archive writes go through a same-directory temp file
  and are write-if-changed, so a partial write cannot leave a truncated archive
  and a write failure fails the build instead of silently pretending success.
  Identical inputs produce byte-identical outputs, so no-op runs create no
  commit.
- **Token resolution is lazy.** `GH_TOKEN` → `GITHUB_TOKEN` → `gh auth token`.
  Tests inject a fake API client and never shell out to `gh`.

## Workflow

`.github/workflows/update-contributors.yml`:

- Triggered by `workflow_dispatch` **only** (no `schedule`); Cron lives in the Worker.
- `permissions: contents: write`; runs on the current Node LTS from
  `.node-version` with `yarn install --frozen-lockfile`.
- Runs `npm test`, `npm run lint`, then `npm run build` with `GH_TOKEN` set to the
  Actions-provided `GITHUB_TOKEN`.
- Stages **only** `cache` and `dist`, checks `git diff --cached`, and commits/pushes
  with the bot identity only when something changed. A push conflict fails the run;
  there is no force push and no success is faked.

## Scheduler Worker

`worker/` is a tiny, separately deployable Cloudflare Worker with a single daily
Cron Trigger (`17 3 * * *`, evaluated in **UTC**). On schedule it authenticates
as a **personal GitHub App**: it mints a short-lived RS256 JWT with native
WebCrypto, exchanges it for an installation token restricted to the
`contributors` repository with the `actions: write` permission, then `POST`s to
the fixed `poooi/contributors` → `update-contributors.yml` workflow dispatch
endpoint on `master`. Both GitHub requests are bounded by a 10s abort timeout;
non-2xx responses raise an error containing the status and GitHub request id
(never the token or response body). Its `fetch` handler always returns `404`, so
it exposes no unauthenticated HTTP trigger.

### GitHub App

Create a **personal GitHub App** (there is no PAT) and install it on **only
`poooi/contributors`**. Grant it the repository permission **Actions: write**,
which is what allows it to dispatch `update-contributors.yml`; do not grant any
other repository permissions. GitHub adds the mandatory **Metadata: read**
permission automatically to every App request, so it is always present and does
not need to be (and cannot be) selected explicitly.

The App is **`poi-contributors-scheduler`** —
https://github.com/apps/poi-contributors-scheduler (App ID `4930626`,
installation ID `161375742`). In the App settings, *Where can this GitHub App be
installed?* must allow **Any account**, because the target is the `poooi`
organization rather than a personal account; keep exactly one installation, on
the single repository `poooi/contributors`.

The Worker reads three settings:

- `GITHUB_APP_ID` — the App's numeric ID (or client ID), used as the JWT `iss`.
- `GITHUB_INSTALLATION_ID` — the installation on `poooi/contributors`.
- `GITHUB_APP_PRIVATE_KEY` — the App private key as a **PKCS#8 PEM** secret.

The App ID and installation ID are not secrets; they live in `worker/wrangler.toml`
under `[vars]`. The private key is a secret and is only ever set with
`wrangler secret put`. GitHub downloads the key in PKCS#1 format
(`BEGIN RSA PRIVATE KEY`), so convert it to PKCS#8 before storing it, e.g.
`openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.pkcs8.pem`. Each run mints a
fresh JWT (`iat` now−60s, `exp` now+9min) and exchanges it for an installation
token scoped to `repositories: [contributors]` and
`permissions: { actions: write }`. No token is cached and there is no PAT
fallback.

### Initial setup

1. Ensure `update-contributors.yml` is on the default branch (`master`).
2. Create and install the personal GitHub App described above, restricted to
   `poooi/contributors`.
3. `GITHUB_APP_ID` and `GITHUB_INSTALLATION_ID` are already set in
   `worker/wrangler.toml` (nonsecret). Install and deploy the Worker:
   ```sh
   cd worker
   npm ci                                          # uses the committed package-lock.json
   npx wrangler secret put GITHUB_APP_PRIVATE_KEY  # paste the PKCS#8 PEM key
   npm run deploy
   ```
4. Let the Cron fire, or trigger a manual test with
   `npx wrangler dev --test-scheduled` and `curl "http://localhost:8787/__scheduled"`.
   `wrangler secret put` stores the key in Cloudflare only; it is **not**
   available locally automatically, so for local dev/testing create a gitignored
   `worker/.dev.vars` containing `GITHUB_APP_PRIVATE_KEY="<PKCS#8 PEM>"` (the
   nonsecret ID values come from `[vars]`).
5. To validate the Worker build locally without deploying, run `npm run dry-run`.
   If it appears to hang after printing `--dry-run: exiting now.`, that is
   Wrangler's optional update check; `WRANGLER_HIDE_BANNER=true
   WRANGLER_SEND_METRICS=false npm run dry-run` disables it. This is a local
   workaround only and is intentionally not baked into the npm scripts.

### How to verify dispatch vs run success

- **Dispatch succeeded** means the Worker's REST call returned 2xx and the run was
  only *queued*. Check `npx wrangler tail` for `Outcome: Ok`, or call the API
  directly and look for HTTP 204.
- **Run succeeded** means the Actions run finished green. Check:
  ```sh
  gh run list --workflow update-contributors.yml
  gh run view <run-id>
  ```
  A green run either committed updated `cache`/`dist` or logged
  "No contributor data changes to commit."
- If a dispatch returns 2xx but no run appears, verify the App's Actions:write
  permission, its installation/repository scope, and that the workflow
  filename/branch match the Worker constants.

## Questions

### Why this project is created
With poooi/poi#1542 we introduced a contributor graph on readme, but this graph is not complete since the contribution data only go from poooi/poi repo, and we are missing:
- contributors that do not directly send commit to the project
- contributors from other repo, e.g. plugins

### How are the contributors ordered
Season千 is the creator for poi project icon, and edwardaaaa contributed the vector art icons. Following are contributors for code, art works and themes, sorted by first commit day

### Is this data complete?
Please contact us if there're still efforts and contributions that have not been accounted in the data

### I find something wrong / I want to modify my data
Contributors always have right to customize name, avatar and homepage in this data, please tell us if you like to do so.

## Contact us
Feel free to contact us if you have any questions or suggestions.
