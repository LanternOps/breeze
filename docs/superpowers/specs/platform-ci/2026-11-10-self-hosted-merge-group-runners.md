# Self-hosted runner group for merge-group integration shards

**Status:** draft for Todd's review (Gate A)
**Date:** 2026-11-10
**Domain:** platform-ci
**Feature:** #10744 (CI throughput)

Claims are marked **verified** (seen in run data, the repo, or GitHub's documentation),
**inferred**, or **not checked**. All numbers come from the Actions API. The window is the 72 h
from 2026-11-07 04:40Z to 2026-11-10 04:40Z: 837 `ci.yml` runs and 36,977 jobs that got a
runner. Scripts and raw data were kept outside the repo. The security model went through an
independent advisor review (Codex, read-only, xhigh). Its disagreements and how each was
resolved are recorded under Open Decisions.

## Problem

### Hosted concurrency is the ceiling

On 11-08 and 11-09 the repo hit a hard limit on concurrent GitHub-hosted jobs (**verified**):

| Measure (72 h, 1-min samples) | Value |
|---|---|
| `ci.yml` jobs in progress, p50 / p90 / max | 46 / 164 / 180 |
| `ci.yml` jobs queued for a runner, p90 / p99 / max | 141 / 538 / 925 |
| Minutes with ≥20 `ci.yml` jobs queued | 1,135 (26% of the window) |
| In-progress jobs, **all workflows**, while ≥20 were queued (11-08 19:30–22:30Z) | min 144, p50 178, **max 180** |
| Runs with at least one job waiting for a runner, p90 / max | 9 / 38 |
| Worst hour (11-08 21Z) | 36,275 queued job-minutes, about 600 jobs waiting on average |

All workflows combined reach 180 jobs in progress, never more, while hundreds of jobs wait. That
flat top is evidence of a cap. **Not checked:** what the 180 limit actually is, whether it can be
raised, and whether other repos in the org count against it (OD-1, probe P4).

### What waiting costs the merge queue

| Measure | merge_group | pull_request |
|---|---|---|
| Integration-shard job wait (created → started), p50 / p90 / p99 / max (min) | 2.5 / 14.8 / 25.5 / 29.8 | 4.1 / 23.0 / 46.6 / 55.6 |
| Share of integration shards waiting > 5 min / > 15 min | 40% / 10% | 45% / 18% |
| Other jobs' wait, p90 (min) | 9.0 | 17.2 |

- From run creation until all 16 integration shards have started, a merge-group run takes p50
  4.8 min, p90 21.6 min and max 53.9 min (n=285). The brief's "queue head waiting 40–60 min" is
  the tail: one run took over 40 min to get every shard started. The typical tail is about 20 min.
- 5,681 jobs were cancelled before they ever got a runner, 1,749 of them merge-group jobs (mostly
  superseded rebuilds). Of 382 merge-group runs, 150 were cancelled, 38 failed and 194 succeeded.
  A successful merge-group run took p50 28.6 min and p90 45.2 min of wall time.
- Queue entries were silently dropped while runners were backlogged (**verified**, #11468). The
  ruleset's check timeout went from 150 to 240 min on 11-09 as a result.

### Integration shards are the biggest single consumer

| Runner-hours in 72 h | Hours | Share |
|---|---|---|
| merge_group integration shards | 1,442 | 28.7% |
| merge_group, everything else | 987 | 19.6% |
| pull_request integration shards | 1,400 | 27.8% |
| pull_request, everything else | 1,124 | 22.3% |

- Merge-group integration shards average **20 jobs running at once** (11% of the cap). The worst
  case is 8 groups × 16 shards = 128.
- Integration shards account for 35% of all queued job-minutes.
- A shard takes p50 19.4 min and p90 25.8 min.
- Each shard runs one test file at a time (`fileParallelism: false`,
  `apps/api/vitest.integration.config.ts:492`). It may need far less than a hosted runner's
  4 vCPU, but that is **inferred** and must be benchmarked: install, migrations and Postgres
  add load (probe P7).

### Why these jobs and not others

They are the largest block of runner time and they are self-contained:

- Docker Postgres and Redis run on localhost.
- No repository secrets are used, only the hard-coded test credentials already public in
  `ci.yml`.
- They are Linux-only.
- They already retry a whole shard once inside the job (`retry-shard.mjs`).

## Users & scope

- **Who benefits:** whoever lands PRs through the merge queue (Todd, and the orchestrator and
  fixer sessions). External contributors are affected only through queue latency.
- **Who operates it:** the host's owner. The runner group setup needs an org admin once.
- **Scope:** the `integration-test` matrix (16 shards) on `merge_group` events in
  `LanternOps/breeze`. Nothing else moves.
- **`push: main` does not exist.** `ci.yml` runs on `pull_request`, `merge_group` and
  `workflow_dispatch` only (`ci.yml:3–28`, **verified**). Main is never re-tested on push. The only
  CI run on main is the manual emergency lane, 8 runs in the window. OD-6 recommends keeping it
  hosted.
- **Host:** the brief assumes a self-hosted macOS host (18 cores, 128 GB, Apple silicon) shared
  with developer agent sessions. This spec recommends dedicated compute instead, for shadow as
  well as enforce (OD-2). The design is the same on either: a Linux host just swaps the VM
  manager.

## Proposed design

### 1. Shape

```
ci.yml (candidate)                       pinned on main (candidate cannot edit)
──────────────────                       ──────────────────────────────────────
integration-test:                        .github/workflows/integration-shards.yml
  needs: [changes]                         on: workflow_call   (inputs: none that steer routing)
  if: <today's gate incl. thin_skip>       jobs:
  uses: LanternOps/breeze/.github/           route:  ubuntu-latest, read-only token, no checkout of
    workflows/integration-shards.yml                 candidate code → per-shard target
    @refs/heads/main                         shard:  matrix 1..16, needs route (if: always())
                                               runs-on: hosted unless route succeeded AND said
                                                        self-hosted for this shard, in which case
                                                        {group: breeze-integration, labels: [...]}
                                               guard:   self-hosted only if event == merge_group
                                                        && repository == LanternOps/breeze
                                               steps:   checkout candidate → run the candidate's
                                                        shard script (same suite as today)
```

The shard job moves into a **reusable workflow called at `@refs/heads/main`**. Its event guard,
routing, permissions and secrets policy live in a file the change under test cannot edit. This
is the same principle as the pinned CI Gate (W02). The test steps stay in the candidate: the
reusable workflow runs a candidate-tree script (for example
`.github/scripts/run-integration-shard.sh`, extracted from today's steps), so a PR that changes
how shards run still tests its own steps.

`@refs/heads/main` is protected-source selection, not an immutable pin. A later change to main
changes the guard, but only through a merged, gated PR. The choice of a SHA pin instead is
covered in OD-3.

**A failed `route` means hosted.** The `shard` job runs with `if: always()` on `route`. Any route
failure, skip or malformed output resolves to `ubuntu-latest`. `route` runs after `changes` (the
caller's `needs`). That adds one short serial hosted hop, measured in shadow, accepted
(**inferred**: about 15 s plus a hosted queue wait).

### 2. Routing: eligibility, then capacity

`route` derives everything from GitHub's context and the Actions API, never from caller inputs.
It never executes candidate code: it reads git objects as data only, as `ci-gate.mjs` does.

**Eligible for self-hosted only if all of these hold.** Anything else routes hosted:

1. `github.event_name == 'merge_group'` and `github.repository == 'LanternOps/breeze'`.
2. The kill switch, repository variable `CI_SELF_HOSTED`, is `on`. `shadow` is a separate path
   (§Rollout). Unset or `off` means hosted.
3. **Every PR in the merge group** passes the author filter, not just the entry's own PR. A
   group's checkout includes the entries queued ahead of it (**verified**, GitHub merge-queue
   docs). Each commit in `merge_group.base_sha..head_sha` maps to a PR, and no PR may be from an
   outside contributor (`author_association` not MEMBER, OWNER or COLLABORATOR) or a
   dependency-update bot.
4. No PR in the group touches **higher-risk install and launch inputs**:
   - `pnpm-lock.yaml`, any `package.json` / `.npmrc`, `pnpm-workspace.yaml`, `.pnpmfile.cjs`,
     `patches/**`;
   - `docker-compose.test.yml`;
   - local actions (`.github/actions/**`);
   - the shard launch script.

   Ordinary test code can run anything, so this list narrows exposure but is not a boundary.

**Capacity** comes from a heartbeat the host publishes every 60 s through a channel whose write
credential can do nothing else. The broker writes `<unix-ts>,<free_slots>,<version>` (OD-7,
OD-8). `route` treats a heartbeat older than 180 s as zero capacity.

The free-slot count is the heartbeat value minus the self-hosted-labelled jobs already queued or
running repo-wide. `route` reads those with `actions: read`. It assigns at most
`min(free, per_run_cap)` shards to self-hosted, lowest shard numbers first. A run can therefore
be split, and the split does not change the result.

**The allocation race is real.** In a rebuild storm, eight `route` jobs can read the same free
count at once, so optimistic counting can oversubscribe by up to 8 × `per_run_cap`. The excess
shards wait for the next free VM. That is a delay, not a failure, but it can exceed the hosted
wait. v1 bounds it with `per_run_cap` (default 2) and the progress watchdog (§5). An atomic
allocator is OD-8.

**Re-runs after a watchdog cancel go hosted.** If the entry's PR had a merge-group run cancelled
by the watchdog in the last 6 h, `route` sends all of its shards hosted. `route` finds this
through the Actions API, by the janitor's marker in the run's cancel annotation (builder picks
the mechanism). This bounds retries against an unhealthy host.

### 3. The host

- **Compute:** dedicated, with no developer credentials, no administrative sessions, and no
  route to private networks (OD-2). The shared developer host is an option only with Todd's
  explicit acceptance of residual risk 1.
- **Supervisor:** a launchd (macOS) or systemd (Linux) service running as a dedicated
  unprivileged OS user. It keeps up to `N` idle ephemeral runners. For each one it:
  1. clones a read-only base VM image (copy-on-write);
  2. gets a single-use just-in-time runner config for group `breeze-integration` with labels
     `self-hosted, linux, breeze-integration` (from the broker, OD-7);
  3. boots the VM;
  4. destroys the clone when the VM exits or a deadline passes.

  The supervisor enforces teardown from outside the VM. Nothing done inside the guest is
  trusted to clean up.
- **VMs:** Linux guests with 2 vCPU, 6 GB RAM, a disk quota, and process and connection limits.
  On Apple silicon they are arm64 (OD-5). Each VM has its own Docker daemon. Docker inside the
  VM is guest root, not host root. There are no shared folders, no host Docker socket, no
  SSH-agent or clipboard forwarding, and no host mounts.
- **Two deadlines.** An idle runner is recycled after 15 min. A job that has started is killed
  65 min after it started, which is 10 min past the job's 55-min timeout. A long idle wait never
  eats into a job's time.
- **Base image:** built from `main` on a schedule by a **disposable, credential-free builder
  VM**, never by the supervisor itself. The image holds pinned Node and pnpm, a pnpm store warmed
  from main's lockfile, and the `pgvector/pgvector:pg16` and `redis:8-alpine` images pinned by
  digest. It is promoted to read-only after a smoke test. Jobs never write into it, and nothing
  a guest writes is ever promoted.
- **Caches:** the shard job declares no cache saves today. The restore-only composite
  (`.github/actions/restore-pnpm-cache`) describes behaviour, not what hostile code can do,
  because the job's runtime token can still write to the Actions cache under the queue ref's
  scope. The advisor cites a server-enforced read-only cache mode in GitHub's current docs
  (**not checked**, probe P5). If it exists, the pinned shard job sets it. GitHub does not let
  `main` or other branches restore caches saved under a child ref like the queue ref (**verified**,
  GitHub caching docs), so cache poisoning cannot reach `main`. Same-ref poisoning and cache
  storage exhaustion remain, and they are not new: hosted runners have them too.

### 4. Capacity math

| Host | VMs (2 vCPU / 6 GB) | Shard-jobs/hour at ~20 min | Share of merge-group shard demand (67/h) | Share of the 180 cap |
|---|---|---|---|---|
| Shared 18-core / 128 GB, agents active | 4 | ~12 | ~18% | 2.2% |
| Shared, agents idle | 6 | ~18 | ~27% | 3.3% |
| Dedicated 32-core (example) | 14 | ~42 | ~63% | 7.8% |

The 67 shard-jobs/hour of demand was itself throttled by the cap, so it is a floor (**inferred**).
Every row is a hypothesis until probe P7 benchmarks a full job at that density. The real numbers
also depend on provisioning time, failures, eligibility exclusions and yield periods.

**Yield rule (shared host only).** The supervisor registers a new runner only when the 5-min load
average is under 10, free memory is over 24 GB, and fewer than `N` VMs are alive. It never
preempts a running job: killing a shard ejects the queue entry, which costs more than finishing
it. Under agent load, capacity drains within one shard length and the heartbeat reports 0 free.
This matches the host CPU budget used for fixer sessions (vitest `maxForks=4`, one `tsc` at a
time).

**What this buys, plainly:**

- **No run gets faster directly.** A run with 2 of its 16 shards on the host still waits on its
  slowest hosted shard. The benefit is aggregate: fewer hosted jobs means a shorter hosted queue
  for every run.
- **The shared host is a small lever.** It frees 2–3% of the cap while peak demand runs 3–5×
  capacity.
- **A dedicated host is a medium lever.** It frees about 8%.
- **The demand side is larger.** W05 (thin queue, enforced) and W07b (named suites) cut more
  shard-jobs than either host.

This is why OD-1 puts the support question about the 180 cap (H0) first.

### 5. Fallback when the host is down, full or broken

| Situation | What happens |
|---|---|
| Kill switch `off` / unset | `route` sends everything hosted. Already-assigned jobs are not moved, and they run or hit the watchdog. |
| Heartbeat stale (>180 s) | Zero capacity, so everything new goes hosted. |
| `route` fails | `shard` falls back to `ubuntu-latest` (§1). |
| Job queued on self-hosted labels for more than 25 min, **for any reason** (host down, registration broken, labels wrong, oversubscribed) | **Progress watchdog.** The Merge Queue Janitor (hosted, from `main`, already holds `actions: write`) cancels the merge-group run with a marker. The entry is ejected loudly, the W06 shepherd re-enqueues it as `infra`, and `route` sends that PR's re-run hosted (§2). This does not depend on the heartbeat: a fresh heartbeat proves the supervisor is alive, not that jobs are progressing. |
| The janitor's cron is late (gaps of hours are documented) | **Backstop: the pinned CI Gate.** `verify` gives up 140 min after it starts (`ci-gate.mjs:696`, job timeout 145) and fails the entry with a stated reason, well before the queue's 240-min check timeout. So a stuck shard ends in a **visible** gate failure at worst, never a silent drop. The watchdog only makes that faster. |
| Host dies mid-job | GitHub fails the job once the runner stops responding. The entry is ejected and the shepherd re-enqueues it. Same as a hosted infra failure. |
| Host full | `free = 0`, so everything new goes hosted. |

**Cost of a failure:** an ejection per affected in-flight entry, plus the rebuild of entries
behind it. That is the same blast radius as a hosted infra flake.

### 6. Interaction with the CI Gate, thin queue and W07

- **Pinned CI Gate (W02).** `rollup()` expands job names from the **candidate's** `ci.yml`
  (`ci-gate.mjs:243`, **verified**). A reusable-workflow call turns them into
  `<caller> / <callee>` names (for example `Integration Tests (shard 3/16) / shard`), so the gate
  has to learn that shape first. The rollout follows the documented gate-change rules
  (`docs/agents/merge-and-deploy.md`, "Changing the gate"):
  1. Ship the gate change in its own PR. Required jobs are judged by the base revision, which is
     the two-PR rule.
  2. Bump the ruleset pin.
  3. Get a green `ci-gate-replay` run.
- **Gate misuse check (detective).** Display names are written by the candidate, so they prove
  nothing. `verify` instead reads each job's server-reported `runner_group_id` and `runner_id`.
  Today the API adapter drops those fields (`ci-gate.mjs:531`). It checks them against the
  broker's issuance record, which lists the runner ids it minted and for which run. The verdict
  is `fail reason=self_hosted_misuse` when:
  - a job in the self-hosted group is not one of this run's routed shards;
  - a job ran there on an event other than `merge_group`;
  - a runner id is unknown to the broker.

  **Limits:** this check runs after the code has already run, and `verify` stops looking once
  `CI Success` completes (`ci-gate.mjs:719`). Group-wide, run-complete auditing is the broker's
  job: it logs every job its runners took (run id, workflow path, event) and alerts on any job
  that is not `integration-shards.yml` on `merge_group`.
- **Thin queue (W05).** Nothing changes. The caller's `if:` keeps
  `!contains(thin_skip, ',integration-test,')`. A thinned entry routes nothing.
- **W07a timing sequencer.** Shard membership comes from the committed timing table, not runner
  speed, so a mixed run partitions identically. But `test-timings.mjs` must **tag the runner
  class** on every timing it records, and it must fit the table from hosted timings only.
  Otherwise faster or slower guests skew the partition for everyone.
- **W07b named suites.** Fewer shards with work means fewer shards to route. No conflict.
- **Merge Queue Janitor.** It keeps cancelling runs whose queue ref is gone. It gains the
  watchdog rule from §5, and it must leave shadow runs (§Rollout) alone until they finish.

## Security model

### The rule, stated exactly

> Self-hosted runners execute **only** jobs from `integration-shards.yml@refs/heads/main`,
> **only** on `merge_group` events of this repository. They **never** execute `pull_request`,
> `pull_request_target`, `workflow_run`, `issue_comment`, branch `push` or branch
> `workflow_dispatch` code, from forks or from branches.

`merge_group` code **is** PR code, including fork PR code once enqueued and code from the
entries queued ahead. So the honest rule is "only code that a write-capable principal has
enqueued". The next section says what that is worth.

### What a merge-queue entry's trust actually implies

- **What it takes.** An entry reaches the queue when a principal with write access (in practice
  the owner's account, or an agent session acting for it) enqueues it. Reviewer approval is not
  required by the ruleset (`docs/agents/merge-and-deploy.md:8`, **verified**). Review is expected
  operationally and is usually automated: agent code review, plus a hostile-intent screen for
  external PRs. Todd does not hand-review diffs.
- **What it means.** Someone accountable chose to merge this group, and an obvious hostile
  payload in a reviewed diff would probably have been flagged.
- **What it does not mean.** It does not mean the code is safe to run with any privilege.
  Payloads that get past review include:
  - an obfuscated payload in a fixture or a generated file;
  - a dependency bump to a compromised version. pnpm's `onlyBuiltDependencies`
    (`pnpm-workspace.yaml:9`) limits install scripts, but allowlisted packages and all imported
    code still run;
  - an upstream compromise with no diff in this repo at all. Every entry runs `pnpm install`.
- **Therefore: reviewed, not trusted.** The runner is built as if every job is hostile. Queue
  admission and the eligibility filters (§2, rules 3–4) lower the rate of hostile jobs. They are
  not boundaries.

### Layers

| # | Control | Enforced by | Can the candidate change it? |
|---|---|---|---|
| 1 | **Runner group `breeze-integration`:**<br>• *selected repositories*: this repo only<br>• *allow public repositories*: on (a public repo requires it; GitHub warns)<br>• *selected workflows*: `LanternOps/breeze/.github/workflows/integration-shards.yml@refs/heads/main` only<br>GitHub matches selected workflows on the called reusable workflow's path and ref, and admits only jobs defined directly in it (**verified**, GitHub runner-group docs). This layer does **not** tell callers apart by event: a fork PR or a branch run calling the same file also matches (**verified**). | GitHub org settings | No. Only an org admin can change it. |
| 2 | **Event/repo guard, eligibility and routing in the pinned reusable workflow.** This is the layer that stops a fork `pull_request` caller or a branch caller: the guard sends them hosted. A candidate job naming the labels directly fails layer 1, never gets a runner, and is cancelled by the watchdog. Jobs set `runs-on.group` explicitly, so the target is not matched on labels alone. | `integration-shards.yml` on `main` | No. It is read from `main`. |
| 3 | **Main's branch ruleset plus the pinned CI Gate ruleset.** Changing layer 2 takes a merged, gated PR. | GitHub rulesets | No. |
| 4 | **Ephemeral VM per job:** single-use JIT runner, copy-on-write clone, teardown by the supervisor from outside the VM, read-only base image built by a credential-free builder | host | No. |
| 5 | **Minimal credentials in the VM.** Explicit `permissions: contents: read` and no `id-token`. `persist-credentials: false`. No secrets (no `secrets: inherit`, none declared). Read-only cache mode if available (P5). | pinned workflow plus host | No. |
| 6 | **Detective:** the gate's `self_hosted_misuse` verdict plus the broker's group-wide job log and alerts (§6) | pinned gate plus broker | No. |
| 7 | **Network policy** (below) | host firewall, outside the VM | No. |
| 8 | **Host separation:** a dedicated host (OD-2), the supervisor as its own OS user, per-VM resource caps | host | No. |

**`if:` guards in `ci.yml` are not on this list.** The candidate edits `ci.yml`, so a guard there
is a convenience, not a control. That is why the guard lives in the pinned file.

### What hostile code inside the VM *can* do

- **Read the job's short-lived credentials.** These are `GITHUB_TOKEN` (contents read),
  `ACTIONS_RUNTIME_TOKEN` (artifact and cache upload for this run) and the JIT runner session.
  Hostile code can use them against the allowed GitHub endpoints until the job ends.
  - **What they grant:** reading public code, and writing artifacts and caches scoped to this run
    or ref.
  - **What they do not grant:** variables, checks or contents write. The design does not claim
    the VM holds "nothing secret". It claims that nothing in it outlives the job or grants more
    than this run's scope.
- **Upload artifacts into its own run.** Downstream jobs in the same run can pick these up.
  `load-smoke-images` merges every `ci-smoke-image-*` artifact by wildcard
  (`.github/actions/load-smoke-images/action.yml:6–10`, **verified**). This is **not new to
  self-hosting**: every job in a merge-group run is already candidate-authored, and a hosted shard
  holds the same token. Binding smoke downloads to their producer's exact artifact is worth doing
  as general hygiene, tracked as a follow-up and not gating this spec.
- **Burn CPU, disk or bandwidth for up to 65 min.** This is bounded by per-VM quotas, the job
  deadline and the kill switch. On a shared host it steals capacity from agents, which is one
  reason for OD-2.
- **Attack the hypervisor, virtual devices or the VM network backend.** This is residual risk 1.

### The registration credential

Minting JIT runner configs needs the org permission **self-hosted runners: write**. That
permission also allows editing runner groups, including their repository and workflow
restrictions (**verified**, GitHub REST docs). Repository **variables: write** would cover every
variable, including `CI_THIN_QUEUE` and `CI_SELF_HOSTED`.

**If either leaked:**

- The attacker could weaken layer 1.
- They could register rogue runners that report fake green shards.
- They could flip the thin queue on and so lower testing.

A runner-name pattern does not authenticate anything. The draft's earlier "narrow App on the
host" therefore understated the blast radius.

**Design:** a **broker** holds the App key, outside the worker host. The worker gets an identity
that can only:

- request a bounded number of JIT configs for the fixed group and labels;
- report its own health.

The broker writes the heartbeat and keeps the issuance record (§6). The heartbeat goes to a
channel whose credential can do nothing else, not to a repo variable that shares
`variables: write` with the thin-queue switch. Placement and form are decided in OD-7.

No Actions secret is added. `route` and the watchdog use only `GITHUB_TOKEN`
(`actions: read` / `actions: write`), because any repository secret readable by a `merge_group`
run is readable by the candidate's own jobs in that run.

### Network policy

Enforced on the host, outside the VM. The VM's own firewall is not trusted.

- **Ingress and east-west:** default deny. VMs cannot reach each other (including L2), the host's
  listeners, or the host's management services.
- **Always denied egress (IPv4 and IPv6):**
  - RFC 1918, CGNAT/mesh-VPN ranges (`100.64.0.0/10`), link-local and metadata
    (`169.254.0.0/16`, `fe80::/10`), ULA (`fc00::/7`), multicast;
  - the host's own addresses;
  - any management or VPN endpoint the host uses, **even if publicly addressed**.

  Or disable IPv6 in the guest network entirely.
- **Allowed egress:** HTTPS through a host-side forward proxy that enforces **hostnames** (SNI or
  CONNECT host), not DNS-derived IP lists. The list is GitHub (`github.com`, `api.github.com`,
  `*.actions.githubusercontent.com`, `objects.githubusercontent.com`, `codeload.github.com`), the
  blob storage Actions artifacts and caches use, `registry.npmjs.org`, Docker Hub's registry and
  CDN, and the Node download origin. With the base image pre-pulled, most jobs should need only
  GitHub plus npm.
- **DNS:** only the host's resolver, which answers only for allowlisted names. That limits DNS
  tunnelling.
- **Quotas:** per-VM bytes out, connection count and CPU. An egress list alone does not stop CPU
  mining.
- **Accepted exposure:** the allowed services (GitHub, npm, blob storage) can carry exfiltration
  or command-and-control traffic. What can leave is public code, run metadata and the job-scoped
  tokens above. Learning the allowlist from shadow logs is a compatibility exercise, not proof of
  containment.

### Residual risks

1. **Hypervisor or VM escape.** On a shared developer host this would expose developer
   credentials, administrative sessions and private-network reach. On a dedicated host it
   exposes the CI box and the worker identity's narrow scope. This drives OD-2.
2. **Broker or App-key compromise:** runner-group tampering, rogue runners, fake results. Kept
   off the worker host (OD-7). The gate's runner-id check against the issuance record catches
   rogue runners only if the broker itself is intact.
3. **Capacity abuse** by a hostile entry: availability only, bounded by quotas, deadlines and
   the kill switch.
4. **GitHub's own guidance** is to use self-hosted runners with private repositories. Layers 1,
   2 and 4 are what make a public repo acceptable. If layer 1 cannot be configured as specified
   (P1), the design does not ship. It does **not** fall back to a weaker routing scheme.

## Out of scope

- Moving anything other than the 16 integration shards, including unit tests, builds, e2e,
  agent jobs, and macOS or Windows jobs.
- PR integration (1,400 h, the other half of shard demand). It stays hosted by design, so
  unreviewed code never reaches the host.
- Buying larger hosted runners or changing the plan (compared below, decided in OD-1).
- Autoscaling cloud runner controllers.
- Changing what the integration suite tests, its shard count, or `retry-shard`.
- The smoke-artifact binding hygiene fix (a follow-up issue).

## Cost / benefit versus larger hosted runners

| Option | Capacity effect | Money | Ops / risk |
|---|---|---|---|
| **H0: confirm and raise the 180 cap** | Possibly large | Possibly $0 | A support request. Unknown answer. |
| **H1: larger hosted runners for merge-group shards** (own runner group) | Takes ~20 average and 128 peak jobs off the standard pool, if larger runners have a separate limit (**not checked**) | Billed per minute even on public repos. 1,442 h per 72 h ≈ 14,400 h/month: about $6.9k/month at a 2-core list rate of about $0.008/min, about $13.8k/month at 4-core (about $0.016). List prices from memory, **not checked** against current pricing or the org's agreement. W05 thinning shrinks this. | None new. Hosted isolation. |
| **H2: pack shards** (fewer, larger jobs) | 16 → 4 jobs per run on 8-core larger runners | Same minutes × cores as H1 | Needs several databases inside one job. A test-infra change. |
| **S1: this spec, shared host** | 2–3% of the cap | ~$0 marginal | Medium ops. Residual risk 1 at its worst. |
| **S2: this spec, dedicated host or cloud VM** | ~8% of the cap at 14 VMs; more with a larger box | A one-time box, or a monthly VM likely well under H1 (**inferred**) | Medium ops. Residual risk 1 contained to the CI box. |

## Open Decisions

**OD-1. Build now, or demand side first?**
- (a) Build W1 (hosted-only refactor) and stand up dedicated shadow compute now. Decide enforce
  after W05 has been enforced for a week. *Pro:* the security controls and arm64 parity are
  proven in parallel. *Con:* operator time and a box, for a lever measured at 3–8% of the cap.
- (b) Defer the whole spec until W05 and W07b are enforced, then re-measure. *Pro:* no work if
  demand falls under the cap. *Con:* the cap stays the ceiling meanwhile.
- (c) Skip self-hosting and buy H1. *Pro:* no new risk. *Con:* about $7–14k/month at list
  (**not checked**).
- **Recommend: H0 today, then (b).** Re-measure with this spec's metrics a week after W05 is
  enforced. Proceed to (a) if merge-group shard wait p90 is still above 10 min. The measured
  benefit is too small to justify new attack surface before the demand-side work lands.

**OD-2. Where the runners live (for shadow *and* enforce).**
- (a) The shared developer host. *Pro:* exists, free. *Con:* shadow runs the same hostile code as
  enforce, so a VM escape reaches developer credentials, administrative sessions and private
  networks. Only 4–6 slots.
- (b) A dedicated box with no private-network reach. *Pro:* containment, 14+ slots. *Con:*
  hardware.
- (c) A dedicated cloud VM, Linux x64. *Pro:* containment, x64 parity, no LAN. *Con:* a monthly
  bill, and nested-virtualisation support must be checked.
- **Recommend (b) or (c) before any candidate code runs, including shadow.** Use (a) only on
  Todd's explicit risk acceptance, with OD-4 filters on.
- *Quorum record:* Claude's first draft recommended (a) for shadow. The advisor disagreed
  (high): non-required results do not reduce exposure. Claude agrees on the merits and revised
  the recommendation.

**OD-3. Where the routing guard lives, and how it is pinned.**
- (a) A pinned reusable workflow at `@refs/heads/main` (this design). *Pro:* the candidate cannot
  edit the guard. Runner-group matching on reusable workflows is documented. *Con:* the gate must
  learn caller/callee names (two-PR rollout plus pin bump). Reusable-workflow changes take effect
  only after they merge. `main` is mutable through gated merges.
- (a′) The same, but pinned to a full SHA in both the caller and the runner group. *Pro:*
  immutable. *Con:* every change needs an org-admin edit of the runner group plus a caller bump.
- (b) A `runs-on` expression in `ci.yml`, with the group allowing the queue refs. *Con:* the
  candidate can rewrite its own routing. Eligibility becomes advisory.
- **Recommend (a).** Main is reachable only through the gated queue, which is the same trust the
  pinned CI Gate already relies on. Reject (b) outright: if (a) fails P1, stay hosted.
- *Quorum record:* the advisor prefers (a′) (low-medium) and agrees (b) is out. This is left to
  Todd. Claude recommends (a) on operational cost.

**OD-4. Eligibility filters: outside authors, install and launch inputs, dependency bots.**
- (a) On, applied to **every PR in the merge group**. *Pro:* the likeliest hostile carriers stay
  on hosted isolation. *Con:* fewer eligible entries (dependency-bot PRs are a large share of
  lockfile changes). Groups behind an external PR route hosted too.
- (b) Off. *Pro:* full capacity use. *Con:* the host runs the riskiest entries.
- **Recommend (a).** Measure the excluded share in shadow. These filters reduce exposure; they
  are not a boundary.
- *Quorum record:* the advisor agreed and found that the first draft checked only the entry's own
  PR. Fixed.

**OD-5. arm64 guests (Apple silicon) versus hosted x64.**
- (a) Accept arm64, gated on zero outcome disagreements across at least 150 shadow shard pairs.
  *Con:* arch-only failures (native modules, image variants) can diverge.
- (b) Require x64 (OD-2c).
- **Recommend (a) if OD-2 picks (a) or (b). This resolves itself under (c).**

**OD-6. The `workflow_dispatch` emergency lane on main.**
- (a) Exclude it: hosted only. *Pro:* one event type on the host, and the emergency lane depends
  on nothing local.
- (b) Include it when `github.ref == 'refs/heads/main'`.
- **Recommend (a).** It was 8 runs in 72 h.

**OD-7. Where the registration authority lives.**
- (a) The App key on the worker host. *Con:* a host compromise gives runner-group admin plus
  variables write. That is broad, not the narrow scope the first draft claimed.
- (b) A broker on a separate small always-on trusted machine or VM that runs no jobs. It holds
  the App key, issues bounded JIT configs to the worker's narrow identity, writes the heartbeat
  to a single-purpose channel, and keeps the issuance record.
- (c) A hosted scheduled workflow as broker (key as an environment secret restricted to `main`).
  *Con:* scheduled runs are delayed or dropped under load, so it cannot serve JIT on demand.
- **Recommend (b).**
- *Quorum record:* the advisor disagreed (high) with the first draft's (a) and its "narrow App"
  claim. Claude agrees.

**OD-8. Slot allocation.**
- (a) Optimistic count plus `per_run_cap` (v1 above). *Pro:* no credential in CI. *Con:* rebuild
  storms oversubscribe. Excess shards wait (a delay, caught by the watchdog at 25 min).
- (b) Atomic leases from the broker. The `route` job proves its identity with a GitHub OIDC token
  whose `job_workflow_ref` must equal `integration-shards.yml@refs/heads/main` and whose event
  must be `merge_group`. Only `route` gets `id-token: write`. A candidate job asking for a token
  would carry `ci.yml`'s ref and be refused. *Pro:* exact capacity, and the heartbeat becomes
  unnecessary. *Con:* the broker becomes an internet-facing endpoint.
- **Recommend (a) for shadow. Decide (b) before enforce** if shadow logs show oversubscription
  waits above the hosted p90.
- *Quorum record:* the advisor flagged (a)'s race as high. Claude agrees it is real and treats it
  as a latency risk, not a safety risk.

**Quorum points not adopted:** the advisor rated smoke-artifact poisoning high. Claude classes it
as general CI hygiene, not a self-hosting risk: every job in a merge-group run is already
candidate-authored, on hosted runners too. It is tracked as a follow-up.

## Probes before building (W0)

| # | Probe | Pass condition |
|---|---|---|
| P1a | Runner group restricted to `…/integration-shards.yml@refs/heads/main`. Try a job defined in it, then a job in another workflow file, the same file at another ref, a nested call, and a `ci.yml` job naming the labels directly. | Only the first is admitted. |
| P1b | Call the pinned reusable workflow from a fork-style `pull_request` run and from a branch `workflow_dispatch`. | The guard routes both hosted. |
| P2 | Does the jobs API report `runner_group_id`, `runner_id` and labels for a self-hosted job? | Present, so the gate's misuse check is possible. |
| P3 | Does a job queued on an offline label block until the 24 h limit? | Confirms the watchdog and gate backstop are needed. |
| P4 | What is the 180 cap? (H0 support request) | A number, and whether it can be raised. |
| P5 | Is a server-enforced read-only cache mode available for a job, and is it honoured by the runner version? | Yes, so the shard job sets it. Otherwise this is an accepted, non-new risk. |
| P6 | Does GitHub's OIDC token for a reusable-workflow job carry `job_workflow_ref` with the callee's ref? (needed only for OD-8b) | Yes. |
| P7 | Benchmark one full shard job (install, compose, migrate, suite) at the proposed density on the chosen host. | p90 ≤ 1.2 × hosted p90 at `N` concurrent VMs. |

## Test & rollout notes

**Waves.** Each is shippable alone, and nothing routes to the host until W3:

1. **W1 Pinned reusable workflow, hosted only.**
   - Extract the shard steps into a candidate script.
   - Add `integration-shards.yml`, with `route` always returning hosted.
   - Change the gate to understand caller/callee names and to read runner-group ids. Ship the gate
     change first (two-PR rule), then bump the pin and run `ci-gate-replay`.
   - Contract tests:
     - `ci-gate.test.mjs` covers name mapping and the `self_hosted_misuse` verdict, including a
       candidate-named job that pretends to be a shard.
     - `check-workflow-security.mjs` gains three rules: no workflow except
       `integration-shards.yml` references the self-hosted group or labels; that workflow
       declares no secrets and no `id-token` outside `route`; its guard expression and the
       hosted-on-route-failure fallback are present.
   - Runner-class tagging in `test-timings.mjs`.
2. **W2 Host, broker and shadow** (on OD-2 compute).
   - Supervisor, builder, base image, network policy, broker and runner group. An org admin
     does the group setup and runs P1–P3.
   - Set `CI_SELF_HOSTED=shadow`. For sampled eligible entries, a separate non-required
     `merge_group` workflow, `integration-shadow.yml`, calls the same pinned reusable workflow
     with shadow routing.
   - Results are logged and compared offline with the entry's hosted shards. The real shards
     stay hosted, and the janitor leaves shadow runs alone.
3. **W3 Enforce.** `CI_SELF_HOSTED=on`. The watchdog is live, and the shepherd classifies its
   cancels as `infra`.

**Graduation from shadow to on (all must hold):**
- At least 2 weeks and at least 150 shadow shard pairs, with zero outcome disagreements other
  than ledgered flakes (covers OD-5).
- P7 holds in production traffic: self-hosted shard p90 ≤ 1.2 × hosted p90.
- The proxy log shows only allowlisted hostnames, and the allowlist is frozen. No quota alarms
  went unexplained.
- **Drills pass:**
  - Pull the host mid-shard: the entry fails loudly and is re-enqueued, and its re-run goes
    hosted.
  - Stale heartbeat: the next run routes hosted.
  - Healthy heartbeat but registration broken: the watchdog fires at 25 min, or the gate fires
    at 140 min if cron is late.
  - Kill switch `off`: takes effect on the next route.
  - Yield (shared host only): under load above 10, no new runner registers.
- A deliberate negative test re-runs P1a and P1b on the final configuration.
- OD-1, OD-2 and OD-7 are resolved. OD-8 is resolved if oversubscription showed up.

**Success metrics** (baseline from the window above; re-baseline after W05 is enforced):

| Metric | Baseline | Target |
|---|---|---|
| merge_group integration-shard wait, p90 | 14.8 min | < 5 min |
| merge_group run: created → all shards started, p90 | 21.6 min | < 10 min |
| Minutes with ≥20 jobs queued | 26% | lower (this spec alone will not remove it) |
| Silent queue drops | ≥1 (#11468) | 0 |
| Misuse verdicts, egress or quota alarms | — | 0 unexplained |

Targets are proposals.

**Rollback:** `gh variable set CI_SELF_HOSTED --body off -R LanternOps/breeze`. New routes go
hosted at once, and already-assigned jobs finish or hit the watchdog. Stopping the broker makes
the heartbeat stale within 3 min, which does the same.
