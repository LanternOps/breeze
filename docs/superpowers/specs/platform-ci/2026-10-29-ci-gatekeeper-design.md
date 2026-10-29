# CI gatekeeper: size each merge's checks to the change; full suite moves to main and release

**Status:** draft for Todd's review
**Date:** 2026-10-29
**Domain:** platform-ci

## Why

Todd waits on CI "all the time, all day." Measured over 2026-10-21 → 10-28 (raw data and
scripts kept outside the repo; numbers carry their sample sizes):

- **Integration is the bottleneck.** 16 shards = 51% of merge-queue runner-minutes and the
  last job to finish in 66% of green merge-queue runs (n=500). Shard imbalance: fastest
  10.8 min vs slowest 22.1 min per run (p50).
- **The queue runs integration regardless of the change.** `classify-pr-paths.sh` only
  path-gates integration on `pull_request`; on `merge_group` it is deliberately always on
  (`classify-pr-paths.sh:89`: "the queue is the real gate"; same rationale at
  `ci.yml:80-82, 155-156`). 26 of 74 sampled merged PRs (35%:
  every web-only, every agent-only) ran all 16 shards although the PR-mode classifier says
  they cannot affect them — ~19% of merge-queue runner-minutes (estimate).
- **`agent/**` is unclassified**, so an agent-only PR sets every area flag and runs api,
  web, add-in, M365, Rust and smoke jobs too (~85% of its queue minutes unrelated).
- **31% of merge-queue runner-hours went to runs that never went green**, mostly cancelled
  rebuilds after another entry failed. Of a 15-run failure sample, 73% were flake/infra,
  13% real; the Tauri apt step alone is 28% of merge-queue failures (n=71).
- **Runners are contended.** 23% of Linux jobs wait >5 min to start; waits climb steeply
  past ~15 concurrent CI runs. All runners are GitHub-hosted.

Time to green: merge_group p50 24.8 / p90 44.1 min; pull_request p50 26.3 / p90 60.4 min.

Todd's framing: the full suite only matters for a release, and a release is a tag, not a
merge. Customers only receive code through a tag.

## Goals

1. Each PR and merge-queue entry runs the suites its change can affect, not everything.
2. The full suite still runs — on main after merge, and as a hard gate on every release tag.
3. A semantic layer (Claude) can refine the selection, **on Todd's subscription, never on
   API billing**. No Anthropic API key in CI.
4. A cron'd Claude session ("the shepherd") owns PR flow: plans, flake triage, culprit
   finding after a red main.
5. Fail safe everywhere: any missing, stale, untrusted or invalid input means the
   conservative path (today's behaviour on the merge path, full suite on main/release).

## Non-goals

- Replacing GitHub's merge queue or the single required `CI Success` check.
- Human review lanes. Todd reviews nothing manually; review automation is out of scope.
- Self-hosted or larger runners (may be worth it later; not part of this design).

## Anti-goals (failure even if it "works")

- A release tag ships a commit that never passed the full suite.
- A migration, schema, RLS or tenancy-registry change merges without the integration
  suites that cover it. Once a migration is on main it is shipped (immutable name and
  content), so post-merge detection is too late for these.
- CI behaviour that a PR author, a label, or a prompt-injected agent can steer.
- The shepherd being down makes CI unsafe (it may only make CI slower).
- Main red for long stretches unnoticed (June 2026 precedent: 8 days).

## Design

### Three tiers

| Tier | When | What runs |
|---|---|---|
| **Merge path** | `pull_request`, `merge_group` | Path-classifier minimum + protected-area floor + (optionally) the shepherd's plan |
| **Main verification** | Scheduled, on main | Full suite (any `workflow_dispatch` run of CI — the `changes` job's `full_suite` branch, `ci.yml:145, 162-164`, sets every flag) on the newest unverified main SHA |
| **Release gate** | `v*` tag push | Publishing blocked until the tagged SHA has a green full-suite run |

### Tier 0 — a trusted policy boundary (prerequisite for everything below)

Today CI checks out the PR's own `classify-pr-paths.sh` and runs it (`ci.yml:116, 177`).
A PR can therefore edit the classifier to emit `code=false` and skip the tests that would
police that edit — "rule edits run everything" is only true if the rules being enforced
are not the rules being proposed. With selection about to skip more, this must close
first:

- The `changes` job runs the classifier, floor list and suite catalog **from the base
  revision** (`merge_group.base_sha` / the PR's base), never from the head.
- Any diff touching those policy files, `ci.yml`, or `.github/scripts/**` forces the full
  suite on the merge path (computed by the base-revision policy, so it can't be edited away).
- `ci.yml`/policy-file changes stay subject to the existing contract tests
  (`ci-area-gating.test.mjs`, `classify-pr-paths.test.mjs`), which then run under the
  full suite.

*(Raised by the independent Codex review; adopted.)*

### Tier 1 — the merge path

**Deterministic minimum (no AI).** `classify-pr-paths.sh` stays the source of truth.
Changes:

1. **`agent/**` becomes its own area**, both directions:
   - agent-only PRs stop running api/web/add-in/M365/Rust/smoke jobs, after a sweep for
     tests elsewhere that read `agent/` files;
   - non-agent PRs stop running agent jobs (`build-agent`, `lint-agent`, `test-agent`,
     `test-agent-windows`, `windows-runtime-smoke`; today `if: code && app`,
     `ci.yml:1750, 1930, 1990, 2870, 3018`), after a reverse sweep — agent tests read
     `apps/api/` files (e.g. `agent/internal/websocket/limits_test.go`,
     `server_error_frame_test.go`, `agent/cmd/breeze-backup/*_test.go`), so those API
     paths join the agent reader map.

   This is agent-shipped code: full rigor, its own wave.
2. On `merge_group`, integration becomes path-gated like on `pull_request`. This is the
   main W2 change. Note the PR-mode rules already set `integration=true` for every API,
   DB, registry, package, lockfile and `.github/` path (`classify-pr-paths.sh:245-252`
   excludes only agent, web, portal, viewer, helper, mobile, add-ins, M365 and `Cargo.*`).
3. **Install/setup inputs count as "read".** Integration does a root workspace install
   (`ci.yml:3447`), so any `package.json`, `.npmrc`, `.nvmrc`, engines field or
   workspace-manifest change in an excluded app still turns integration on. "Reads"
   means install, codegen, subprocesses and dynamically resolved inputs, not just
   imports. *(Codex counterexample: a web manifest with an incompatible engine breaks
   integration setup.)*
4. **Protected floor** — one file with a contract test (like `qemu-gate-paths.txt`)
   listing paths that can never lose integration coverage: `apps/api/migrations/**`,
   `apps/api/src/db/**`, the tenancy registries (`tenantCascade.ts`,
   `orgMergeRegistry.ts`, `tenantExportPolicyRegistry.ts`), RLS/tenancy test helpers,
   `vitest.integration.config.ts`, all shared inputs. In W2 it changes nothing (the
   PR-mode rules already cover it). It starts to matter in W4/W6, where named suites and
   plan drops could otherwise trim these.

The existing `CI Success` aggregation already enforces "flag true → job must succeed,
flag false → job must be skipped", so selection changes don't need a new required check.
`ci-area-gating.test.mjs` / `classify-pr-paths.test.mjs` get cases for every new rule.

**Why skipping integration in the queue is safe enough.** Each queue entry is tested on a
ref containing every entry ahead of it. If entry N doesn't touch anything integration
reads (in the broad sense above), N cannot newly break integration; entries ahead that
did touch it ran integration themselves. This depends on the reader map being complete,
which is unproven — so classifier misses are expected and are caught by Tier 2, never
reach a release (Tier 3), and each one becomes a rule fix.

**Savings caveat.** If `merge_group.base_sha` is main's tip rather than the entry ahead,
the queue diff (`ci.yml:170`) includes every entry ahead, and a web-only PR behind an API
PR still runs integration. Safe, but it cuts into the ~19% estimate. W2 measures which
it is before claiming savings. Plan lookup parses the PR number from the queue ref
(`gh-readonly-queue/main/pr-<N>-…`).

**Named integration suites (later wave).** Split the hand-maintained include list in
`vitest.integration.config.ts` into named suites (e.g. `tenancy-contract`, `billing`,
`wisp`, `m365`, …) mapped to areas, so selection is not all-16-or-none. Rebalance shards by
recorded timing instead of `--shard` file count. Shard 1's extra contract suites
(`rls-coverage`, `request-db-role`, ee workspace) become their own named suite.

### The shepherd's plan (semantic layer, subscription-billed)

A local scheduled job (launchd, same pattern as `com.lanternops.breeze-inbox-watch`)
runs headless `claude -p` every ~5 minutes on a dispatch account (never the
API-billing account):

1. List open PRs whose head SHA has no plan.
2. For each, read the diff + PR body and produce a plan:
   ```json
   { "schema": 1, "sha": "<head sha>", "add": ["auth-e2e"], "drop": ["integration:wisp"],
     "risk": "low|medium|high", "confidence": 0.0-1.0, "reason": "…" }
   ```
   `add`/`drop` name entries from a fixed **suite catalog** file in the repo; anything not
   in the catalog is invalid.
3. Post it as a check run named `CI Plan` on that exact SHA, as a dedicated GitHub App
   (check runs can only be created by apps; CI verifies the app id, not a login or label).

At merge-queue time the `changes` job looks up `CI Plan` for the entry's PR head SHA and
applies it only if: created by the expected app id, SHA matches the PR head being merged,
schema valid, every name in the catalog, confidence ≥ threshold. Any failure → ignore the
plan (deterministic selection only).

**What `drop` can remove.** The path rules select *areas*; once W4 splits integration into
named suites, an area turns on all of its suites. A `drop` may remove a named suite inside
a selected area (e.g. a web+api PR that only touches webhook code drops `integration:wisp`)
— but never a suite the protected floor requires, never a whole area's only suite, and
never anything when the diff touches a Tier 0 policy file. `add` is always honoured.
**Before W4 the plan is add-only** (areas have nothing smaller to trim), so W5 delivers
escalation and shadow data, and the AI's speed contribution starts at W6.

App identity + SHA binding authenticates the plan; it does not make it correct. An
injected or mistaken plan is bounded by the rules above, which are computed from the
base revision (Tier 0) and can't be changed by the PR.

Timing: PR CI takes ~25–60 min, so a 5-minute cadence posts the plan long before a PR
is enqueued. The plan never sits on the critical path; no plan = no change in latency.

Rollout: **shadow first** — CI records "plan would have run X, rules ran Y" in the job
summary and Tier 2 compares against what actually broke. Enforcement only after a shadow
period shows zero would-have-missed failures.

### Tier 2 — main verification

A scheduled trigger (hourly; builder may tune) dispatches a full CI run on main **only if
main's head SHA has no green full run yet**. `main-red-alert` already fires on
dispatch-on-main and maintains the single `ci-red` issue (`ci.yml:4934`); it covers this
lane with little change (it was written for the admin-bypass emergency lane).

**Concurrency:** `ci.yml:33-35` cancels in-progress runs on the same ref, so a scheduled
run and an emergency dispatch on main would cancel each other. The verification lane gets
its own non-cancelling concurrency group; a new verification waits for, rather than
kills, a running one.

Verifying only the newest SHA skips intermediate commits by design. That's acceptable:
a red result triggers the culprit search below, which walks the intermediate SHAs.
Detection time is "next run + run length" (~1.5 h worst case), not a guarantee.

**What counts as a green full run** (read by Tier 3): a run of the CI workflow from the
default-branch workflow file, `workflow_dispatch` event, on that exact SHA, with every
area flag `true`, `CI Success` green, and **no waiver applied** (the #6943 Test Agent
Windows waiver, `ci.yml:4913-4918`, doesn't count). Merge-queue runs don't count, even
with every flag true. Record it as a commit status from the verification job.

**When main goes red** (shepherd duty):

1. Re-run the failing jobs once. Green → flake: label/track it, main stays verified.
2. Still red → candidates = PRs merged since the last green full run whose queue run
   *skipped* the failing suite (stored plan/classifier outputs say which).
3. Exactly one candidate, and the failure reproduces on its merge commit and not on its
   parent → **open a revert PR through the queue automatically** and comment on the
   original PR. Otherwise → `ci-red` issue with the candidate list + dispatch a fixer.
   *(Todd's call pending — see Open questions; this is the default until he decides.)*
4. Every confirmed classifier miss becomes a rule change (reader map / floor) so it can't
   recur — the miss is a bug in the rules, not just in the PR.

Reverts go through the merge queue like any PR. Nothing pushes to main directly.

### Tier 3 — release gate

`release.yml` today does not check CI on the tagged SHA (it relied on every merge having
run everything). Add a `verify-full-suite` job:

- If the tagged SHA already has a green full run (definition above), pass.
- Otherwise dispatch CI on the **tag ref** itself (`gh workflow run CI --ref <tag>`; a tag
  is a valid ref, a bare SHA isn't) and poll until it finishes (cap ~150 min, matching
  the queue timeout). So nobody deletes and re-pushes a tag.
- The same path covers `candidate` prerelease tags that aren't on main
  (`scripts/release/check-release-lineage.sh`, `.github/release-provenance/candidate-tags.tsv`)
  — they reach canary customers and get the gate too.
- **Builds may run in parallel; publishing may not.** `create-release`
  (`release.yml:2603`) and every job that publishes artifacts or images gets
  `needs: verify-full-suite` with an explicit success condition. A first job alone
  doesn't block anything.

The release skill's checklist gets a step: tag an already-verified SHA when possible
(fast path).

### Trust model

- No AI output is trusted directly: the deterministic minimum and protected floor are
  computed in CI from the diff and can't be lowered by anything outside the repo's
  committed rules.
- The plan is accepted only from one app identity, bound to one SHA. Labels, comments and
  PR-body fields never change CI.
- Fork PRs: the shepherd may plan them, but plans for fork PRs are ignored until the
  hostile-intent screen has passed (builder: decide whether to skip forks entirely in v1).
- Rule files (`classify-pr-paths.sh`, floor list, suite catalog, `ci.yml`) run from the
  base revision, and editing them forces the full suite (Tier 0).

## Metrics (tracked by the shepherd, weekly)

| Metric | Baseline (7d) | Target |
|---|---|---|
| merge_group time-to-green p50 / p90 | 24.8 / 44.1 min | < 15 / < 25 min |
| merge-queue runner-hours / week | 5,485 h | −50% |
| Linux jobs waiting > 5 min | 22.9% | < 5% |
| merge-queue runs never green (share of runner-hours) | 31% | < 15% |
| Classifier/plan misses caught by Tier 2 | n/a | 0 reaching a release; each → rule fix |
| Hours main red per week | baseline needed | ≤ 2 |

Targets are proposals, not claims.

## Wave sketch (ordering matters)

The safety net lands **before** any coverage is removed from the merge path.

1. **W1 Safety net + policy boundary:** Tier 0 (base-revision policy, policy edits force
   full), scheduled main verification lane with its own concurrency group, verified-SHA
   status, `main-red-alert` coverage, release `verify-full-suite` gate on publishing jobs.
2. **W2 Queue targeting:** merge-queue integration path-gating, install/setup inputs as
   readers, protected floor file + contract test; measure the `base_sha` behaviour.
3. **W3 Agent area** (both directions, reader sweeps; full rigor).
4. **W4 Flake/infra:** Tauri apt failure (#9847) fix; integration shard rebalancing by timing.
5. **W5 Named integration suites + suite catalog.**
6. **W6 Shepherd v1:** GitHub App, launchd job, `CI Plan` check runs (add-only, shadow
   for drops); red-main triage + revert/issue flow.
7. **W7 Plan drops enforced** in the queue after the shadow period.

W1–W4 deliver most of the measured savings with no AI. W6–W7 refine it.

## Left to the builder

- Main-verification cadence and how it coalesces with in-flight runs.
- How bisect dispatches CI on intermediate SHAs (temporary branch per SHA is fine).
- Confidence threshold and shadow-period length (suggest 2 weeks, ≥200 entries).
- App naming and permissions (minimum: checks:write, contents/pull_requests read).
- Exact suite names in the catalog.

## Open questions for Todd

1. **Red-main policy:** auto-revert the culprit (default above, only when exactly one
   candidate reproduces) or always leave main red and dispatch a fix?
