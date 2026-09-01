---
name: pre-release-sweep
description: >-
  Use before cutting a Breeze release, or whenever asked to "test everything
  since the last release", "check what's changed on main in the browser",
  "boot the stack and verify the merged PRs", or "pre-release QA". Covers the
  gate on in-flight CI, standing up a stack at current main, walking every
  merged-since-tag change through Playwright, tracking results in a dated doc,
  logging UI/UX paper cuts, and fixing small defects on the way. For a
  whole-app sweep unrelated to a release window use `ui-qa-sweep`; for one
  just-built feature use `feature-testing`.
---

# Pre-Release Sweep

Verify every change merged since the last release tag actually works in the
browser, on a stack built from **current `origin/main`**, and leave a tracking
doc a release cut can cite. The tracking doc is the deliverable; the browser
work exists to fill it.

Tracking doc: `docs/testing/release-sweeps/<YYYY-MM-DD>-<from-tag>-to-<to>.md`
(copy `TEMPLATE.md` in that directory). Write to it **as you go** — a sweep
outlives a context window.

## Phase 0 — Gate on in-flight work

1. `gh pr list --state open` — non-draft PRs against `main` with CI running are
   the "waiting" set. Draft/stacked PRs are not.
2. `gh pr checks <n> --watch` in the background (never poll by hand).
3. Merge only on **head-SHA** green (`gh pr merge --squash --admin`). Ignore
   only known-noise checks and say which: Trivy on `CVE-2026-14456`
   (base-image openssl) is the current one — confirm the CVE id in the log
   before dismissing it.
4. Record the final `origin/main` SHA in the doc header. That SHA is the base
   of the sweep; anything merged after it is a follow-up entry, not silently
   absorbed.

## Phase 1 — Stack at main (not the feature branch)

`pnpm wt-stack up` builds from the **worktree's checkout**. A sweep on a
feature branch verifies the wrong code (bit us 2026-08-24, 47 commits stale).

```bash
git fetch --deepen=200 origin main            # herdr worktrees are shallow
git checkout -b qa/sweep-post-<from-tag> origin/main   # fixes land here
sed -i '' 's|^BREEZE_DOCKER_SUBNET=.*|BREEZE_DOCKER_SUBNET=<fresh /24>|; s|^BREEZE_CADDY_IP=.*|BREEZE_CADDY_IP=<same /24>.10|' .env
source ~/.nvm/nvm.sh && nvm use               # .nvmrc pin, not host node
pnpm install --frozen-lockfile                # code-mounted node_modules — stale tree = Astro NoMatchingRenderer
pnpm wt-stack up                              # read .breeze-stack.json for baseUrl + creds
```

Pick the `/24` from `docker network ls -q | xargs docker network inspect --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}'` — an existing network with the same subnet fails compose with "Pool overlaps", running or not.

Boot with every feature flag the inventory (Phase 2) names, or the surface is
invisible and the check reads as a false FAIL. If the API is unhealthy with a
`does not provide an export named …` error, the dev image is stale — `pnpm
wt-stack up --rebuild`. The seed has one org and a non-platform-admin; promote
it for `/admin/*` rows (`update users set is_platform_admin=true where
email='admin@breeze.local'`) and let a sweep agent create sibling orgs. Then
**log in yourself once** before dispatching any browser agent; a blocked sweep
agent is 15 wasted minutes.

## Phase 2 — Change inventory (sonnet, no browser)

Dispatch one Explore agent (model: sonnet) to produce the inventory table:
merged PRs since the tag, surface (`web` / `portal` / `api-only` /
`agent-only` / `docs-chore`), a **concrete click-path read from source**
(real route from `apps/web/src/pages`, real button labels), the visible
outcome that proves the change, and prereqs (flag, role, live agent) that make
it BLOCKED locally. It must also list every `BREEZE_*`/`*_ENABLED` env var in
the diffs and cluster the click-paths into 4–6 area groups.

Paste the table into the doc with a `Status` column = `TODO`. Every row ends
the sweep as `PASS | PARTIAL | FAIL | BLOCKED | N/A` — never left `TODO`.

## Phase 3 — Browser sweep (opus, one group at a time)

One agent owns the Playwright MCP browser at a time; groups run
**sequentially**. Each agent gets: the stack descriptor, its group's rows
verbatim, the doc path, and the rules below. It appends its rows' results plus
a "Paper cuts" sub-list before returning. Read `ui-qa-sweep` Phase 3/4 for the
everyday-workflow checks to fold in when a group is thin.

Rules every sweep agent must follow (they are the recurring false-positive
sources):
- Toast host is custom: `[data-testid="toast"]`, auto-dismiss 5 s. Click and
  poll for the toast **inside one `browser_evaluate`**, or install a
  MutationObserver recorder before clicking. A "no toast" reading is a
  measurement, not a finding, until `grep -n runAction <component>` shows no
  `successMessage`.
- Scope element lookups to `main` or the drawer — tab labels collide with
  sidebar links by text.
- Modals are `fixed inset-0` divs with no `role=dialog`; assert on title text
  or `data-testid`, and on the outcome, not the container.
- A 2xx with no visible confirmation is a FAIL, not a PASS.
- Known noise, note once: `428` on the first `POST /auth/login` (session-binding
  handshake, the retry succeeds); non-platform-admin 403s on `/admin/*`.
- The API limiter is 300 req / 60 s per client. A fast nav crawl trips it and
  every page then "fails" with 429 — pace the crawl; a burst of 429s is the
  agent's own doing, not a finding.
- Fix agents run concurrently with the sweep on a code-mounted stack: a web
  edit hot-reloads one page; an `apps/api/src` edit restarts the API for
  ~40 s. Tell the sweep agent which files are being edited and to treat a
  Vite overlay / 502 burst there as "wait 20 s and reload"; run API-side fixes
  in an isolated worktree (`isolation: "worktree"`) and cherry-pick after the
  sweep group finishes.

## Phase 4 — Fix small, file the rest

"Small" = one file or one component, no tenancy/auth/migration/billing/agent
surface, reproducible in a unit test. Fix on the `qa/sweep-*` branch, red
test first, then `npx vitest run <file>` (no `--` before the flag; never a
trailing-slash path). Dispatch a sonnet agent per fix with the exact
repro + file. Tell it: lint/typecheck **in the foreground** with `timeout 240`
(a backgrounded run stalls the agent with the fix uncommitted — `SendMessage`
it to finish if that happens); `--pool=threads --maxWorkers=2` if vitest can't
start workers under the running stack; never an `eslint-disable` for a rule
not in the package's eslint config (the comment itself is the lint error).
Verify its commit exists, skim the diff, and run eslint on the changed files
yourself before recording it. Run the heavy web `tsc --noEmit` once from the
main session, not per agent.
Anything larger → GitHub issue via `github-issues`, dedupe first, cite the doc.

Both go in the doc: `Fixes applied` (commit SHA) and `Issues filed` (#).

## Phase 5 — Close

Summary table (group → PASS/PARTIAL/FAIL/BLOCKED counts), "Top findings"
(systemic patterns beat single bugs), the oldest PR reached, and what a
release cut still needs (flags to enable, BLOCKED rows needing a live agent).
Open one PR: the fixes + the tracking doc. `pnpm wt-stack down` when done.

## Model tiering

| Work | Agent |
|---|---|
| Inventory, env-var grep, mechanical single-file fixes | sonnet |
| Browser sweep (judgement on paper cuts, false-positive traps) | opus |
| Review of a fix that touched auth/tenancy | opus, one round |

## Red flags

- Sweeping on the branch you happened to be on → wrong base, re-do Phase 1.
- A row marked FAIL with no API status+body captured → not a finding yet.
- "Merged, didn't check head-SHA CI" → the sweep merged red (#4159).
- Tracking doc written at the end → context loss ate the middle of the sweep.
- A "no toast → silent failure" finding whose click and poll were in separate
  tool calls → re-measure in one `browser_evaluate` before filing.
- A row marked PASS on a stack whose flags were off for that surface → the
  surface never rendered; check the flag list in the doc header.
