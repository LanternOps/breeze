---
anchor_issue: 10977
tracking_issue: 11416
related: [10744, 10746]
baseline_commit: bef484ca8b
track: plan
---

# PostgreSQL 17/18 Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Breeze states a tested PostgreSQL range (16, 17, 18) backed by CI. Self-hosters can run 18 on the shipped compose file without a data-directory trap and have a verified 16 → 18 runbook. The default pin moves off 16 only through an owner-gated decision.

**Architecture:** No product code and no migrations. W1 adds a cheap PR-time check on the newest version: a second Postgres 18 service container in the two existing migration jobs. It also adds a scheduled workflow that runs the full integration and RLS contract suites on 17 and 18, kept in step with `ci.yml` by a parity contract test. W2 makes the compose data directory version-agnostic and writes the docs and runbook. W3 is a gate (owner decision plus ops), not a dispatchable wave.

**Tech Stack:** GitHub Actions YAML, Node 22 `node:test` contract tests under `.github/scripts/`, Vitest compose-render tests (`docker compose config --format json`), Docker Compose, Astro/MDX docs.

**No separate spec:** the issue was triaged `track:plan`. Design choices are made inline below. The contested ones are listed under Open Decisions.

## Inputs (verified on `origin/main` @ bef484ca8b unless marked)

- **Pins are all 16.** `.env.example:1720` `POSTGRES_IMAGE_REF=pgvector/pgvector:pg16`; `docker-compose.dev.yml:18`, `docker-compose.test.yml:24`; `ci.yml` `check-migrations` (`postgres:16`, line 772), `check-migrations-nonsuperuser` (`postgres:16`, line 873), `test-m365-communications-executor` (`postgres:16-alpine`, line 721), smoke-test / auth-browser / portal-dev-e2e (`pgvector/pgvector:pg16`, lines 4117, 4498, 4845); `tenant-isolation-e2e.yml:100`; `ci-smoke-binary-source-{github,local}.yml`; `scripts/ops/restore-test.sh:55` (`postgres:16`). `.github/scripts/fixtures/ci-gate/*.yml` are frozen replay fixtures. **Never edit them.**
- **Docs pin 16** in `introduction.mdx:52`, `architecture.mdx:70`, `quickstart.mdx:317`, `deploy/production.mdx:24,28,41`, `features/extensions.mdx:69`, `deploy/environment.mdx:854-856`. Comments in `.env.example` (1499, 1702-1720) and `deploy/.env.example:95-96` also mention 16. `apps/api/src/data/docsIndex.json` is generated from the docs by `npx tsx scripts/build-docs-index.ts`.
- **Extensions:** `pg_trgm` (core, `0001-baseline.sql` and others); `vector` only from `ee/workspace/migrations/2026-07-19-content-chunks.sql`, applied at API boot when `BREEZE_WORKSPACE_ENABLED=true`; `timescaledb` only in `migrations/optional/` (not applied). The `pgvector/pgvector:pg17|pg18` images ship both `pg_trgm` and `vector`.
- **The compose data directory is version-sensitive.** `docker-compose.yml:1100` mounts `postgres_data:/var/lib/postgresql/data` with no `PGDATA`. The `postgres:18` / `pgvector:pg18` images moved `PGDATA` to `/var/lib/postgresql/18/docker` and declare `VOLUME /var/lib/postgresql`. Consequences on today's compose file:
  - **[verified]** The shipped `docker-compose.yml` mounts at `/data` with no `PGDATA`.
  - **[inferred from upstream image behaviour, W2 T1 confirms]** A pg18 image over an existing 16 volume refuses to start, which is safe. A **fresh** install on pg18 writes into an *anonymous* volume, and `docker compose down` + `up` then loses the database. The comment on the issue that "new installations are okay to go ahead on v18" is not safe until W2 lands.
  - **[verified]** `docker-compose.test.yml` puts a `tmpfs` on `/var/lib/postgresql/data`. On pg18 that `tmpfs` would be bypassed silently.
- **Hosted production uses managed Postgres** (`deploy/docker-compose.prod.yml:911` has no local postgres service). `check-migrations-nonsuperuser` already mirrors a managed admin role.
- **Backups use host client tools.** `scripts/backup.sh` / `restore.sh` call `pg_dump` / `pg_restore`. Their client major version must be ≥ the server's after any bump.
- **CI cost context (#10744).** The throughput spec measured the integration step at 17.6 min median / 24.3 max per shard (n = 6 runs). One 16-shard pass is therefore roughly 300–430 runner-minutes *(estimate)*, against ~500 runner-minutes for one whole green PR run. Contention (concurrent jobs), not raw minutes, is what #10744 is fighting. The pinned CI Gate (#10746) judges `ci.yml` job results by job name. Adding jobs to `ci.yml` or renaming them touches that gate. Adding steps or services inside an existing job does not.
- **Community runbook.** @TheMoroney posted a working 16 → 18.6 dump/restore runbook on the issue (4 comments): 1313 migrations, 0 pending, health 200, pgvector 0.8.7 HNSW indexes valid *(reported, not reproduced here)*. W2 folds it in with credit.

## Waves

| Wave | Title | Migration | Tier | Merged first |
|---|---|---|---|---|
| W1 | CI: Postgres 18 migration smoke on every PR + scheduled 17/18 integration matrix | no | Opus (workflow + parity test); T1 Sonnet | none |
| W2 | Self-hoster support: version-agnostic `PGDATA`, supported-range docs, 16 → 18 runbook | no | Opus (compose + runbook); T3 Sonnet | W1, plus ≥3 green nightly 18 runs and 1 green 17 run |
| W3 | **GATE (owner + ops, not dispatchable):** default bump to 18, hosted-region database upgrade | n/a | Owner | W2, plus the gate preconditions below |

**Value checkpoints:** W1 alone answers "does Breeze work on 17/18" with evidence and blocks migration regressions on 18. W2 meets the issue's "docs list the supported versions" and makes 18 safe for self-hosters. W3 records the default-bump decision (the issue's third done-when). "Defer" is a valid outcome.

## Execution split and parallelism

Each wave branches from fresh `origin/main` as `feature/<parent#>-postgres-17-18-support/wave-<subissue#>` and targets `main`. Never stack: a stacked PR runs no CI. "Merged first" means wait for the merge, then rebase.

| Within W1 | Parallel? |
|---|---|
| T1 (test compose) ∥ T2 (PR smoke in `ci.yml`) | Yes, file-disjoint |
| T3 (nightly workflow) + T4 (parity test) | One group: T4 is written first, red, then T3 turns it green |
| T5 (first run + triage) | After T1–T4, serial |

| Within W2 | Parallel? |
|---|---|
| T1 (compose `PGDATA`) | First, alone. It ships to self-hosters, full rigor |
| T2 (runbook) ∥ T3 (doc sweep) | After T1. T2 owns `upgrades.mdx`; T3 owns every other doc file. `docsIndex.json` is regenerated once, last, by whoever commits |

Concurrent subagents never `git commit`. The wave owner commits once per group after all members pass.

**File ownership.** W1: `docker-compose.test.yml`, `scripts/dev/test-stack/**`, `.github/workflows/ci.yml` (only the `check-migrations*` jobs and one Lint step), `.github/workflows/postgres-compat.yml` (new), `.github/scripts/postgres-compat.test.mjs` (new), `.github/scripts/postgres-versions.json` (new), `docs/agents/testing.md`. W2: `docker-compose.yml`, `docker-compose.dev.yml`, `apps/api/src/config/postgresDataDirCompose.test.ts` (new), `apps/docs/**`, `.env.example` and `deploy/.env.example` (comments only), `apps/api/src/data/docsIndex.json`, and one entry in the upgrade notes.

## Global Constraints

- **No migrations, no tables, no tenancy changes.** The tenancy/RLS registration contracts are untouched. If W1 triage shows that a migration or product SQL needs a version-specific change, **stop**: file an issue and add a wave (W1b) via `feature-lifecycle` `add_wave`. Do not fold product fixes into a CI wave.
- **`CI Success` aggregation and the job set judged by the CI Gate (#10746) do not change in W1.** The PR smoke adds *services and steps inside* `check-migrations` and `check-migrations-nonsuperuser`. Job names and `needs:` stay the same. The nightly is a separate workflow and never feeds `CI Success`.
- **Single source of truth for versions:** `.github/scripts/postgres-versions.json` (`{ "default": "16", "prSmoke": "18", "scheduled": { "18": "daily", "17": "weekly" } }`). Workflow YAML keeps static image strings. The parity test asserts that they match this file (W1), and that the docs' supported-range table matches it (W2).
- **Images:** new CI legs use `pgvector/pgvector:pg17` / `:pg18` (the shipped default's family, a superset of stock). Mutable tags are acceptable for ephemeral CI containers, as `ci.yml` already does. Docs tell self-hosters to pin a reviewed digest.
- **Every leg proves its version.** Each job asserts `SHOW server_version_num` major == expected before running tests, so a tag drift can never silently test 16.
- New workflow: every `uses:` pinned to a full SHA with a version comment (`scripts/security/pin-github-actions.mjs`). Minimal `permissions` (`contents: read`; `issues: write` only on the notifier job). `if: github.repository == 'LanternOps/breeze'` on scheduled jobs. Restore-only caches (`./.github/actions/restore-pnpm-cache`, per #10744 W1 cache policy). It must pass `.github/scripts/check-workflow-security.mjs`.
- **Cron slots** stay off the hour and clear of existing ones (02:41, 03:17, 05:17, 05:23, 06:00, 07:41). Proposed: `53 3 * * *` (18 daily), `53 4 * * 0` (17 weekly, Sunday).
- **Contention cap:** the nightly matrix uses `max-parallel: 8` so it never holds more than 8 runners.
- **CI traps:** `pnpm test` does not run the integration or RLS contract suites. Scoped vitest runs: `cd apps/api && npx vitest run <path>`, never `pnpm --filter … test -- --run`. A workflow can only be `workflow_dispatch`ed once it exists on `main`, which is why the nightly also triggers on `pull_request` for its own files (W1 T3). Docs-only W2 commits still run `docs-check` (customer-PII guard included). Use example values only.
- Public repo: no hostnames, IPs, provider region names, customer names or production sizes in any file, PR or comment. The community runbook's site-specific paths (`/opt/docker/...`) and image digests are generalized, not copied.
- Compose changes ship to customer machines: **full rigor** (red-first render test, lab boot on 16 and 18, one review round).

## Review Focus

Failure modes the issue implies but does not spell out, each with a test in its owning task:

1. **A leg silently runs the wrong major.** Tag drift, or a compose default overriding the env var. Each leg asserts its server version (W1 T2, T3).
2. **pg18 `tmpfs` bypass in the test stack.** The suite still passes but runs on the container filesystem: slower, and not what the test stack claims. `PGDATA` is pinned to the `tmpfs` target and the render test asserts it (W1 T1).
3. **Fresh pg18 install on the shipped compose file loses its database on `down`/`up`.** `PGDATA` is pinned to the named-volume mount and checked in a lab (W2 T1).
4. **The `PGDATA` pin itself must be a no-op on an existing 16 install.** Same path as the image default, data intact after recreate (W2 T1 lab step).
5. **Parity drift.** Someone changes the integration env or command in `ci.yml` and the nightly keeps testing the old shape. The parity contract test fails (W1 T4).
6. **Backups break after an upgrade.** A host `pg_dump` older than the server refuses to dump. The runbook and the W3 checklist require client ≥ server (W2 T2, W3).

---

## W1: CI on Postgres 17 and 18

**Shape (Decisions 1–3):** a blocking PR-time smoke on the newest version, plus scheduled full suites. Cheapest shape that still *blocks*:

| What | Where | Blocks a PR? | Added cost (estimate) |
|---|---|---|---|
| All migrations on an empty DB + multi-tenant replay fixture + drift check, on 18 | 2nd service in `check-migrations` | Yes | ~1–2 min step time in an existing job; 0 new jobs; off the critical path (integration ~27 min dominates) |
| All migrations as a non-superuser (managed-admin mirror), on 18 | 2nd service in `check-migrations-nonsuperuser` | Yes | ~1 min, 0 new jobs |
| Full integration (16 shards) + shard-1 extras (ee workspace boot + suite, request-db-role, rls-coverage) + migration checks | `postgres-compat.yml`, 18 daily | No (rolling issue) | ~300–430 runner-min/day, ≤8 concurrent, off-peak |
| Same | `postgres-compat.yml`, 17 weekly | No | ~300–430 runner-min/week |

The rest of `ci.yml` (smoke, e2e, auth-browser, portal-dev, tenant-isolation-e2e) stays on 16 until W3.

### T1: Parameterize the test-stack image and pin its data directory (Sonnet-eligible)

**Files:** `docker-compose.test.yml`, `scripts/dev/test-stack/project.ts`, `scripts/dev/test-stack/project.test.ts`, plus a new render test `scripts/dev/test-stack/composePostgres.test.ts` (or a sibling of `project.test.ts`, following its runner).

- [ ] **Red:** render test runs `docker compose -f docker-compose.test.yml config --format json` (pattern: `apps/api/src/db/requestDatabaseCompose.test.ts`, including its 60 s docker-spawn timeout) and asserts:
  1. With no env, `services.postgres-test.image === 'pgvector/pgvector:pg16'`.
  2. With `BREEZE_TEST_PG_IMAGE=pgvector/pgvector:pg18`, the image is that value.
  3. `environment.PGDATA` equals a `tmpfs` entry of the same service (today: absent, so the test fails).
- [ ] Watch it fail.
- [ ] **Implement:** `image: ${BREEZE_TEST_PG_IMAGE:-pgvector/pgvector:pg16}`; `environment.PGDATA: /var/lib/postgresql/data`; keep the `tmpfs` on that path. Update the header comment ("drop-in superset of postgres:16" → version-neutral).
- [ ] `stackEnv()` passes `BREEZE_TEST_PG_IMAGE` through from `process.env` when set (test in `project.test.ts`), so `BREEZE_TEST_PG_IMAGE=pgvector/pgvector:pg18 pnpm test-stack up` works locally.
- [ ] **Local check:** bring that stack up, then `SHOW server_version` (18.x) and `SHOW data_directory` (`/var/lib/postgresql/data`); `pnpm test-stack down`.

### T2: Postgres 18 smoke inside the existing migration jobs

**Files:** `.github/workflows/ci.yml` (`check-migrations`, `check-migrations-nonsuperuser` only).

- [ ] **Red:** T4's parity test includes assertions on both jobs. Each declares a second service whose image is `pgvector/pgvector:pg<prSmoke>` on a distinct host port (5434). Each has a step that applies migrations against that port, and a version-assertion step. These assertions fail until this task lands.
- [ ] `check-migrations`: add service `postgres-newest` (`pgvector/pgvector:pg18`, `POSTGRES_USER/PASSWORD/DB=breeze`, port `5434:5432`, the same health options). After the existing drift step, add:
  - **Assert the server major on :5434 is 18**, through the API's own DB client (`pnpm --filter @breeze/api exec tsx -e …`), with no host `psql` dependency.
  - **Apply migrations against empty Postgres 18:** `DATABASE_URL=postgresql://breeze:breeze@localhost:5434/breeze pnpm --filter @breeze/api run check:migrations`.
  - **Check for schema drift (Postgres 18):** same override, `db:check-drift`.
  - **Optional, measured:** `test:rls-coverage` against :5434 if it needs no setup beyond the env this job already has and runs in < 2 min. Otherwise it stays nightly-only. Record which in the PR body.
- [ ] `check-migrations-nonsuperuser`: add `postgres-newest` (superuser `postgres`, port 5434), plus a version-assertion step and a second `check:migrations:nonsuperuser` run with `SUPERUSER_DATABASE_URL`, `DATABASE_URL` and `DATABASE_URL_APP` re-pointed at :5434.
- [ ] Step names say "(Postgres 18)" so a red is self-explanatory. No change to job `name:`, `needs:`, `if:` or `CI Success`.
- [ ] The existing 16 legs stay **exactly** as they are (stock `postgres:16`).

### T3: Scheduled Postgres compatibility workflow

**Files:** `.github/workflows/postgres-compat.yml` (new), `.github/scripts/postgres-versions.json` (new).

- [ ] Triggers:
  - `schedule` (`53 3 * * *` → versions `["18"]`; `53 4 * * 0` → `["17"]`).
  - `workflow_dispatch` with input `versions` (choice: `17`, `18`, `17,18`).
  - `pull_request` with `paths: [.github/workflows/postgres-compat.yml, .github/scripts/postgres-versions.json]`, so a PR that edits the workflow proves it, and so the first run works before the file is on `main`.
- [ ] `plan` job: emits the version list from `github.event.schedule` / the input as JSON (default for `pull_request`: `["17","18"]`).
- [ ] `migrations` job (matrix: version): service `pgvector/pgvector:pg${{ matrix.pg }}`. Runs the version assertion, `check:migrations`, `db:check-drift`, and a second service plus `check:migrations:nonsuperuser`. Same env as the `ci.yml` jobs.
- [ ] `integration` job (matrix: `pg × shard 1..16`, `fail-fast: false`, `max-parallel: 8`, `timeout-minutes: 55`). It copies `ci.yml` `integration-test`'s steps (checkout, pnpm/node setup, restore-only cache, install, test-stack pull-with-retry and up, the retry-shard run line, flake-report upload, the shard-1 ee boot + `@breeze/ext-workspace test:integration` + `test:request-db-role` + `test:rls-coverage`, logs on failure, teardown) with `BREEZE_TEST_PG_IMAGE=pgvector/pgvector:pg${{ matrix.pg }}`. A version-assertion step uses `docker exec breeze-postgres-test psql -tAc 'SHOW server_version_num'`. `CI_BASE_SHA` is empty here, so nothing is quarantined. That is intentional: the nightly reports everything.
- [ ] `notify` job (`if: always() && github.event_name == 'schedule' && github.repository == 'LanternOps/breeze'`, `issues: write`). Follows the `perf.yml` rolling-issue pattern and the `main-red-alert` notifier discipline: no `set -e`, retries on reads only, never on writes.
  - On failure: open, or comment on, the single open issue labelled `postgres-compat`, naming the version and failed jobs.
  - On a green run of every version that has an open issue: comment and close it.
- [ ] One-time: `gh label create postgres-compat -R LanternOps/breeze --description "Scheduled Postgres 17/18 compatibility run failed"` (note it in the PR body).

### T4: Parity and version contract test (write first; red until T2/T3)

**Files:** `.github/scripts/postgres-compat.test.mjs` (new), `ci.yml` Lint job (one `node --test` step next to the existing ones at ~`ci.yml:334-347`).

- [ ] Text/YAML-structure assertions in the style of `ci-cache-policy.test.mjs` (no new npm dependencies):
  1. The nightly integration job's "Run integration tests" `run:` line, its `env:` keys and values, and the shard count/list match `ci.yml` `integration-test`, except `BREEZE_TEST_PG_IMAGE`. Same for the four shard-1 extra steps' `run:` and `env:`.
  2. The nightly `timeout-minutes` ≥ `ci.yml`'s.
  3. Images: the `ci.yml` smoke services use `pg<prSmoke>`; the nightly's version lists equal `Object.keys(scheduled)`; cron strings map to the cadences in `postgres-versions.json`.
  4. Every job that runs tests on a non-default version has a version-assertion step.
- [ ] Watch it fail (files missing). Then T2 and T3 turn it green.
- [ ] **Mutation control:** temporarily change one env value in the nightly copy, confirm the test goes red, then revert. Note it in the PR body.

### T5: First run and triage

- [ ] Push the branch and open the PR. The `pull_request` trigger runs the full 17 + 18 matrix once, and `ci.yml`'s smoke runs on 18.
- [ ] Triage every red by class:
  - **Test-side version assumption** (fix in W1, version-agnostic, one commit per class). Examples: a catalog query on `pg_constraint` without a `contype` filter that now sees Postgres 18's stored `NOT NULL` constraints (`contype = 'n'`); an exact server error-message or `EXPLAIN`-text match; a `pg_stat_*` view renamed in 17 (`pg_stat_bgwriter` → `pg_stat_checkpointer` split).
  - **Product or migration incompatibility.** Examples: a function used in an expression index or materialized view that relies on `search_path` (17 runs maintenance commands with a safe `search_path`); a migration statement rejected on 17/18. **Stop.** File an issue, `add_wave` W1b, and land W1 with that version's schedule entry commented out and the gap stated in the PR body. Never merge a nightly that is known red.
  - **Flake** (passes on the whole-shard retry): leave it, note it.
- [ ] Re-run until both versions are green (or W1b is filed), then merge.
- [ ] `docs/agents/testing.md` CI section: one paragraph on `postgres-compat.yml` (what it runs, cadence, the rolling `postgres-compat` issue, the local `BREEZE_TEST_PG_IMAGE=… pnpm test-stack up` recipe). Sonnet-eligible.

**W1 done when:** PR CI green including both 18 smoke steps; the PR-triggered compat run green on 17 and 18 (or W1b filed); parity test mutation control recorded.

---

## W2: Self-hoster support on 17/18

**Precondition:** W1 merged, plus ≥3 consecutive green scheduled 18 runs and 1 green 17 run (links in the PR body). Docs claim only what CI proves.

### T1: Version-agnostic data directory in the shipped compose files (Opus, full rigor)

**Files:** `docker-compose.yml`, `docker-compose.dev.yml`, `apps/api/src/config/postgresDataDirCompose.test.ts` (new). Grep for any other compose file with a postgres service (`rg -l "postgres" -g 'docker-compose*.yml' -g 'compose*.y*ml'`). `deploy/docker-compose.prod.yml` has none.

- [ ] **Red:** render each compose file (pattern `requestDatabaseCompose.test.ts`; `POSTGRES_IMAGE_REF` set to `pgvector/pgvector:pg18`, then to `pgvector/pgvector:pg16`). For the postgres service, assert `environment.PGDATA` is set and equals the `target` of a named-volume mount. Today it is absent, so the test fails.
- [ ] **Implement:** `PGDATA: /var/lib/postgresql/data` in the postgres service `environment` of both files. The mount is unchanged. Comment: why (Postgres 18 images moved the default; pinning keeps one layout for every major and leaves existing volumes where they are).
- [ ] **Lab, 16 (no-op proof):** start a throwaway stack from the *current* compose file on pg16 (seeded via `worktree-stack` or a local compose project). Record `SELECT count(*)` for 3 tables. Apply the change, `docker compose up -d postgres` (it recreates), re-count: identical; `SHOW data_directory` unchanged.
- [ ] **Lab, 18 (the trap is closed):** fresh project with `POSTGRES_IMAGE_REF=pgvector/pgvector:pg18`. Boot, migrate, write a row. `docker compose down` (no `-v`), `up -d`: the row is still there. `docker volume ls` shows no anonymous postgres volume holding data. Also run the control on the *old* compose file and confirm the row is lost, so the inferred trap in Inputs becomes verified (or is corrected in the docs if it does not reproduce).
- [ ] **Lab, 18 over a 16 volume:** confirm the server refuses to start with a clear error. Quote the error text in the runbook.
- [ ] **Upgrade guide "Compose file changes" entry** for the release: the postgres container is recreated once on the next `up -d` (a few seconds of database restart). No action needed.
- [ ] Tear down every lab stack and say so in the PR body.

### T2: 16 → 18 runbook (Opus; runbook executed end-to-end before merge)

**Files:** `apps/docs/src/content/docs/deploy/upgrades.mdx` (new `## PostgreSQL 16 to 18` section beside `## Redis 7 to 8`).

- [ ] Credit line: *"Adapted from a runbook contributed by @TheMoroney in #10977, tested on a long-lived production install."*
- [ ] Content, generalized from the community runbook. No site paths, no specific digests.
  - **Why dump/restore, not `pg_upgrade`:**
    - The 18 image's base OS ships a newer glibc, so collations change, and a restore rebuilds every index.
    - Postgres 18 `initdb` enables data checksums by default, while a 16 cluster usually has none.
    - The old volume stays untouched as the rollback.
  - **Prerequisites:**
    - Free disk ≥ 1.5 × the database.
    - Copies of the compose file and `.env` kept off the host.
    - Long jobs under `nohup`.
    - The host `pg_dump`/`pg_restore` used by `scripts/backup.sh` must be **≥ the server major** afterwards.
  - **Procedure:**
    1. Stop `api` and `worker`, and leave `postgres` and `redis` up.
    2. Take a `pg_dump -Fc` and record per-table row counts at that moment (the `query_to_xml` count idiom).
    3. `pg_dumpall --globals-only`: roles are not in a single-database dump. **The file holds password hashes. Keep it private and delete it after.**
    4. Point postgres at a **new** volume (Decision 5) and set `POSTGRES_IMAGE_REF` to a reviewed `pgvector/pgvector:pg18` digest.
    5. `up -d postgres` and confirm 18.x.
    6. Load the globals ("already exists" notices are expected).
    7. Run `pg_restore -v` and **check the exit status and read the log**: an empty error file is not proof.
    8. Run `ANALYZE`.
    9. Verify: version, extensions (`pg_trgm`, `vector` if Workspace is on), HNSW indexes valid, and row counts **identical** to the counts taken with writers stopped. Any difference is a failed restore, not "high churn".
    10. Start `redis` → `api` (watch for the migration summary and the `breeze_app` role check) → `worker` → `web`/`portal`/`caddy`. Check `/health`.
  - **Rollback:** point back at the old volume and image. Valid only until the new database has taken writes that matter. After that, the way back is a dump from 18 restored into a fresh 16.
  - **Cleanup:** the old volume, after a fresh 18 backup exists; dump files; the globals file at once.
  - **Already on 18 via the upstream layout** (volume at `/var/lib/postgresql`): keep that mount in your override. Do not let a compose upgrade revert it, or the server comes up on an empty data directory.
  - Keep the musl/glibc image-swap caution and link it.
- [ ] **Execute the runbook verbatim** on a lab stack: 16 with seeded data → 18. Paste the command transcript summary (versions, restore exit code, row-count diff empty, `/health` 200) into the PR body. Any step that needed a change is fixed in the doc first.

### T3: Supported-range doc sweep (Sonnet-eligible)

**Files:** `introduction.mdx`, `architecture.mdx`, `quickstart.mdx`, `deploy/production.mdx`, `features/extensions.mdx`, `deploy/environment.mdx`, `.env.example` (comments only), `deploy/.env.example` (comments only), `apps/api/src/data/docsIndex.json` (regenerated).

- [ ] **Red:** extend `.github/scripts/postgres-compat.test.mjs`. `production.mdx` must contain a supported-versions table whose rows equal `postgres-versions.json`: default 16; tested 16 (every PR), 17 (weekly full suite), 18 (every PR migration smoke + nightly full suite). It fails until written.
- [ ] `production.mdx`:
  - Replace "tested against PostgreSQL 16" with that table.
  - Generalize "any Postgres 16 image works" to "any supported Postgres image".
  - Add a short "Running 17 or 18" note: new installs may set `POSTGRES_IMAGE_REF` to a reviewed pg17/pg18 digest before first boot. Existing installs follow the runbook link, and must never change the image tag over an existing volume.
- [ ] Bare "PostgreSQL 16" in the intro, architecture and quickstart becomes "PostgreSQL (16 by default; 17 and 18 supported)".
- [ ] `extensions.mdx` / `environment.mdx`: "the default (`pgvector/pgvector:pg16`)" stays factual, plus "and its pg17/pg18 variants".
- [ ] `.env.example` / `deploy/.env.example` comments: make the musl/glibc caveat version-neutral and point at the runbook. **Do not change the `POSTGRES_IMAGE_REF` value** (W3).
- [ ] `npx tsx scripts/build-docs-index.ts`; commit the regenerated `docsIndex.json`.
- [ ] `pnpm --filter @breeze/docs check && pnpm --filter @breeze/docs build`; `bash scripts/security/check-customer-pii.sh`.
- [ ] Release-notes entry: `docs/release-notes/next-release-draft.md` is a merge-queue conflict hot spot. Add the entry last, rebase right before enqueue, and keep it to two lines ("PostgreSQL 17 and 18 are now tested and supported; default stays 16. Upgrade runbook: …").

**W2 done when:** render test green on both images; three lab proofs recorded; runbook executed verbatim; docs build green; the docs↔versions contract green.

---

## W3: GATE: default bump to 18 and hosted-region upgrade (owner + ops)

Not a dispatchable wave. It becomes a registered wave only when the owner opens the gate. The bump PR below is then small and mechanical.

**Gate preconditions (all required):**
- [ ] 18 scheduled run green for 14 consecutive days, and 17 green on the last 2 weekly runs.
- [ ] W2 merged, with its runbook executed in a lab.
- [ ] A reviewed `pgvector/pgvector:pg18` digest chosen.
- [ ] Owner decision recorded on #10977: target major, release, and the hosted window (Decision 7).

**Owner/ops checklist (hosted regions, managed Postgres; details stay in `internal/`, never in this repo):**
- [ ] Confirm the provider offers the target major, and the `pg_trgm` / `vector` versions on it. Confirm `check-migrations-nonsuperuser` semantics still mirror the provider's admin role on the target major.
- [ ] Provider backup or fork before the upgrade. Rollback = restore that fork. Data written after cutover is lost on rollback, so set a go/no-go point.
- [ ] Upgrade one region first. Run `ANALYZE` if the provider path does not keep statistics. Verify API boot, migration summary, `/health`, a workspace search if enabled, and version parity across services.
- [ ] **Backups:** whatever runs `pg_dump` for that region must be on client ≥ target major. Check it by taking a real backup the same day.
- [ ] Second region after a soak period the owner chooses.

**Bump PR contents (once the gate opens):**
- `.env.example` `POSTGRES_IMAGE_REF` → the reviewed pg18 digest. This affects **new installs only**: existing installs keep their `.env`, so it is non-breaking. Release notes state that plainly, plus the runbook link for anyone who wants 18.
- `docker-compose.dev.yml` → pg18 **with a renamed dev volume** (`postgres_dev_data_pg18`). Without the rename, every existing dev/worktree volume (16 data) would fail to start on 18; with it, they are simply ignored. Tell developers to `docker volume prune` old ones.
- `docker-compose.test.yml` default and every `ci.yml` / smoke / e2e / `tenant-isolation-e2e.yml` / `ci-smoke-binary-source-*.yml` pin → 18. The old `check-migrations` 16 leg becomes the oldest-supported smoke (swap roles in `postgres-versions.json`). The nightly covers 16 + 17. `scripts/ops/restore-test.sh` default image follows.
- Docs: "default 18" in the table and the bare mentions.

---

## Decisions surfaced while planning

Quorum: **codex not consulted.** The CI shape adds no job to the gate-judged set, changes no `CI Success` semantics and adds no migration or tenancy surface. Under the brief ("skip unless the CI shape is contentious") it did not meet the bar. Conservative defaults apply until the owner answers. None is resolved silently.

1. **How the nightly reuses the integration job.**
   - (a) Copy the steps into `postgres-compat.yml`, kept in step by the T4 parity contract test.
   - (b) Extract `integration-test` into a reusable `workflow_call` workflow used by both. Less duplication, but it renames the check and edits the job the CI Gate (#10746) judges, while #10744 W3–W5 are reworking selection.

   **Recommend (a) now**, and revisit (b) after #10744 closes.
2. **Scheduled cadence.**
   - (a) 18 daily + 17 weekly (~300–430 runner-min/day + ~same/week, ≤8 concurrent).
   - (b) Both daily (double).
   - (c) Both weekly (a regression can sit up to 7 days).

   **Recommend (a).** 18 is the bump target and the PR smoke already covers its migrations. 17 is an intermediate major where a regression that spares both 16 and 18 is unlikely.
3. **PR-time blocking check.**
   - (a) A second 18 service container inside the two existing migration jobs: blocks, adds 0 jobs, ~2–3 min of non-critical-path step time.
   - (b) A new `check-migrations-pg18` job: a cleaner log, but a new job in the gate-judged set and another runner per PR.
   - (c) No PR check, nightly only: cheapest, but blocks nothing, so a migration that breaks 18 merges and is found the next morning.

   **Recommend (a).**
4. **Data-directory layout for 18.**
   - (a) Pin `PGDATA=/var/lib/postgresql/data` for every major. One layout, no mount change, existing volumes untouched.
   - (b) Adopt the upstream 18 layout (mount at `/var/lib/postgresql`). Matches the upstream docs, but changing the mount on an existing 16 install points `PGDATA` at an empty subdirectory and boots an **empty** database. It needs a new volume name and per-install branching in one compose file.

   **Recommend (a).**
5. **How the runbook switches to a new volume without editing the shipped compose file** (edits are lost on the next Breeze upgrade).
   - (a) A documented `docker-compose.override.yml` naming the new volume.
   - (b) An env-parameterized volume name in `docker-compose.yml`. Compose cannot default it to the project-scoped name, so every existing install would need the variable.

   **Recommend (a)**, after W2 T2 confirms the documented upgrade command (`docker compose pull && up -d` / the upgrade script) loads the override file. If it does not, fall back to (b) with a required-variable migration note.
6. **Postgres 19** (GA planned 2026-11-19; the commenter offered to test it).
   - (a) A separate issue: add `19` to `postgres-versions.json` as a non-blocking scheduled leg once a `pgvector/pgvector:pg19` image exists. The PR smoke tracks the newest *supported* major, not the newest GA.
   - (b) Fold it into W1 now. No pgvector image yet, so W1 would carry a dead leg.

   **Recommend (a).**
7. **Default bump (W3 gate).**
   - (a) 18, new installs only, after the gate preconditions, in a release the owner picks, with the hosted regions upgraded in a planned window.
   - (b) 17 (smaller step, shorter remaining support).
   - (c) Defer and record "16 default until upstream EOL planning (Nov 2028)".

   **Recommend (a).** It is non-breaking for existing self-hosters because their `.env` keeps 16.

## Test & rollout notes

- W1 rollout = merge. The nightly starts the next day. The first week of nightly results is the evidence W2 waits for.
- W2 compose change reaches self-hosters in the next release. It is a no-op on 16 (lab-proven), and the release note says the postgres container restarts once.
- Nothing in W1/W2 changes the default, any migration, or production. W3 alone does, behind the owner gate.
