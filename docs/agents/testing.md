# Testing — agent reference

Moved verbatim from `CLAUDE.md` (2026-10-07). Read before running a scoped test, a contract suite, or reasoning about which CI job catches what.

## Frameworks & Configuration
- **API**: Vitest — `apps/api/vitest.config.ts` (unit), `vitest.config.rls.ts` (RLS session-context contract, `test:rls`), `vitest.config.rls-coverage.ts` (RLS coverage contract, `test:rls-coverage`), `vitest.integration.config.ts` (integration)
- **Web**: Vitest + jsdom — `apps/web/vitest.config.ts`
- **Agent**: Go standard `testing` package — `go test -race ./...`
- **Shared**: Vitest — `packages/shared/vitest.config.ts`
- **E2E**: Playwright Test (TypeScript), `data-testid` based — `e2e-tests/playwright.config.ts`, specs under `e2e-tests/tests/*.spec.ts`, Page Objects under `e2e-tests/pages/`. Tests query DOM via `data-testid` attributes only (not text/role/CSS) — see `e2e-tests/README.md` for the convention.

## Test File Placement
- Place test files **alongside source files**, not in separate directories
- API: `routes/devices.ts` → `routes/devices.test.ts`
- Go: `internal/discovery/scanner.go` → `internal/discovery/scanner_test.go`
- Shared: `validators/filters.ts` → `validators/filters.test.ts`

## Writing Tests
For test-writing conventions (Drizzle mock patterns, table-driven Go tests, validator coverage, and the required coverage checklist), use the **`breeze-testing`** skill.

## CI Integration
- Test suites run in CI (`.github/workflows/ci.yml`), each in its own job: `test-api`, `test-web`, `test-portal`, `test-viewer`, `test-shared` (`packages/shared` vitest, #8373), `test-agent`, the add-in/M365 suites and `integration-test`. Anything without a job there is not run in CI — check before assuming a suite is covered
- `test-api`, `test-web`, `test-agent` are **required** jobs on PRs
- New test files are auto-discovered — no CI config changes needed
- Go coverage is uploaded as artifact; no threshold enforced yet
- Integration tests run in the **`integration-test`** job (16 shards), which **blocks PRs**: it carries no `continue-on-error`, and `ci-success` hard-fails on `needs.integration-test.result`. Do not hand-dispatch CI to get an integration run on a PR that targets `main` — it already ran. The `continue-on-error: ${{ github.event_name == 'pull_request' }}` in `ci.yml` belongs to the separate **`smoke-test`** job (Docker image build + stack boot + endpoint smoke), which is non-blocking on PRs and required on main. A green PR can still redden main, but through a stale base or a stacked branch (see `docs/agents/tenancy-rls.md`, last paragraph of the cascade section), not through a skipped integration run
- **`CI Gate` (#10746)** is a separate workflow (`ci-gate.yml`), run only by an org ruleset and never by a dispatch. It judges queue entries from the base revision's policy and proves selection, not that tests ran honestly. Its tests are `.github/scripts/ci-gate.test.mjs`, registered in `lint`, plus the `pinned-ci-gate-invariants` rule in `check-workflow-security.mjs`. What can be checked before a real queue run: `gh workflow run CI --ref <branch>`, whose `ci-gate-replay` job runs the verdict code against recent real queue runs. The map, reasons and rollback order are in `docs/agents/merge-and-deploy.md`
- **Thin merge-queue run (W05, #10749).** A queue entry may skip some of the 27 build, unit, integration and reader jobs that its PR run already proved. The pinned `CI Gate` decides which ones at the start of its run, logs `ci-gate-selection:` and publishes the list as an artifact. The `changes` job reads it into the `thin_skip` output, which each of those jobs checks for its own id, and `CI Success` counts a listed job that was skipped as satisfied. The gate judges the entry against its own copy of the list, so a skip it did not publish fails the gate as `thin_skip_unjustified`. Smoke, migration, lint, typecheck and security jobs are never thinned. Each queue run's `changes` job logs one `queue-thin: mode=… reason=… gate_run=… waited_s=… thin_skip=…` line. `mode=thin` means jobs were skipped. Every other line ran everything, and its reason says why: `thin_disabled` (the kill switch is off), `no_gate_run` (no pinned gate run within 60 s), `no_gate_selection` (no published list within 180 s), `gate_selection_invalid` (a file for another entry, run or attempt), `gate_shadow` (shadow mode: the log line carries `would_skip=`), `gate:<reason>` (the gate itself chose full) and `error`. The kill switch is the repository variable `CI_THIN_QUEUE`: unset or `off` runs everything, `shadow` publishes the real list but still runs everything, and only `enforce` skips. `gh variable set CI_THIN_QUEUE --body off` takes effect from the next entry. Rollback order and the gate's own reasons are in `docs/agents/merge-and-deploy.md`. The daily full run on `main` that the plan calls the backstop is not wired yet; until it is, the audit sample (one thin-eligible entry in five runs full) is the only ongoing check for misses.
- **Actions cache budget (#10744, #10762, #11119).** The repo has a 10 GB cache limit, and past it GitHub evicts least-recently-used entries of any kind (that is how the Tauri apt closure was lost, sending Rust Check down the slow network path). Two rules keep it under. First, only `ci-cache-seed.yml` on main saves: every other workflow is restore-only (the `restore-*` composites, setup-go `cache: false`, no setup-node `cache:`, trivy-action `cache: 'false'`, no buildkit `cache-to: type=gha`). `release.yml` is the one exception, since it runs on tags only. `.github/scripts/ci-cache-policy.test.mjs` checks every workflow. Second, main may hold one entry per seed family per OS (`go-*`, `pnpm-*`, `golangci-lint-*`, `osv-scanner-*`, `cache-trivy-*`, plus the newest two `tauri-apt-*` closures), CodeQL's TRAP caches, and the seed's buildkit layers. The seed's last job keeps the total under **8.5 GB**, which leaves at least 1.5 GB of headroom for one seed run's exports. It deletes superseded keys (keeping each family's newest entry) and, on main, retired families (`node-cache-`, `setup-go-`, `trivy-binary-`), then evicts other refs' entries and main's least-recently-used buildkit blobs. It never evicts a seed key. A red `Enforce the cache budget` run means the seed keys alone no longer fit, and someone must decide what may live on main. Check usage with `gh api repos/LanternOps/breeze/actions/cache/usage`
- **Postgres compatibility (#11416).** Every PR runs on Postgres 16 (the shipped default). Two more majors are tested. **18, blocking on every PR:** `check-migrations` and `check-migrations-nonsuperuser` each carry a second service (`postgres-newest`, `pgvector/pgvector:pg18`, `:5434`) and steps suffixed `(Postgres 18)`: a server-major assertion, the migration replay, drift, and the RLS coverage contract. These are steps inside existing jobs, so the CI Gate's job set and `CI Success` do not change. **17 and 18, scheduled:** `postgres-compat.yml` runs the full 16-shard integration suite plus both migration checks, 18 daily and 17 weekly. That run does not feed `CI Success`. A red scheduled run opens or comments on one issue per major, labelled `postgres-compat`, and the next green run of that major closes it. The tested majors and crons live in `.github/scripts/postgres-versions.json`. `.github/scripts/postgres-compat.test.mjs` (in `lint`) checks every workflow against that file, and fails if `postgres-compat.yml`'s integration job drifts from `ci.yml` `integration-test` step by step. Change `ci.yml` first, then mirror the change. **Triage a red by class:**
  - **A test that assumes one version** (for example a catalog query that does not filter `pg_constraint.contype` and so sees 18's stored `NOT NULL` rows, or an exact error-text or `EXPLAIN` match): fix it to be version-agnostic.
  - **A product or migration incompatibility:** stop, file an issue, and add a wave to #11416.
  - **A flake** (passes on the whole-shard retry): note it.
  - **To reproduce locally:** `BREEZE_TEST_PG_IMAGE=pgvector/pgvector:pg18 pnpm test-stack up`, then run the suite as usual. `PGDATA` is pinned to the tmpfs, so 18's moved default data directory cannot escape it.

## Running Tests Locally
```bash
# All tests
pnpm test

# API only
pnpm --filter @breeze/api test

# Run ONE test file while developing (do NOT insert `--` before the flag — see trap below)
pnpm --filter @breeze/api test --run src/routes/auth.test.ts
# equivalent, and avoids the pnpm passthrough entirely:
cd apps/api && npx vitest run src/routes/auth.test.ts

# NOTE: `pnpm test` does NOT run the RLS/integration contract suites
# (separate vitest configs: vitest.config.rls.ts, vitest.config.rls-coverage.ts,
# vitest.integration.config.ts).
# Local green ≠ CI green — run those explicitly when touching tenancy/cascade code.
# They need real Postgres+Redis. Per-worktree copy (safe alongside other sessions):
pnpm test-stack up       # private pg+redis for this worktree (docker-compose.test.yml under -p)
pnpm test-stack down     # tear it down when finished — nothing does this for you

# The RLS COVERAGE contract (rls-coverage.integration.test.ts) has its OWN config and is
# EXCLUDED from both of the others — pointing either at it prints "No test files found"
# and exits 1, which reads like a failure but means it never ran. Run it the way CI does:
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
# `test:rls` (vitest.config.rls.ts) is a different suite: the session-context contract.

# Go agent (with race detection)
cd agent && go test -race ./...

# Specific Go package
cd agent && go test -race ./internal/discovery/...

# E2E
cd e2e-tests && pnpm test
```

API unit runs (`vitest.config.ts`) never read the root `.env`: under vitest, `db/index.ts` skips its dotenv load (#9344), so values kept in your local `.env` (such as `DATABASE_URL`, `REDIS_URL` or `IS_HOSTED`) no longer reach unit tests. Variables you export in the shell still apply. The integration and RLS-coverage configs load `.env.test` themselves.

**Two traps when scoping a run to one file.** The `--` trap below reproduces on every workspace package regardless of its script shape — confirmed against both `apps/api` (`"test": "vitest"`, bare/watch-mode) and `apps/portal` (`"test": "vitest run"`, already run-once): both ran their FULL suite (1,470 and 26 files respectively) instead of the one targeted file. The only difference is that the bare-`"vitest"` packages (`apps/api`, `apps/web`, `packages/shared`, most others) then sit in watch mode afterward and never exit, while the `"vitest run"` packages (`apps/portal`, `apps/helper`, `apps/mobile`, `packages/extension-sdk`, `packages/extension-web-sdk`, `packages/extension-testkit`) at least exit once the full run finishes — either way, the file you asked for is not what got scoped.

- **Never write `pnpm --filter <pkg> test -- --run <path>`.** Confirmed by direct repro against `apps/api` (bare `"vitest"` script): this ran the *entire* suite (1,470 files / 25,380 tests) instead of the one file, and hung well past 2 minutes. Root cause: pnpm forwards the literal `--` token into the script's argv (verified via `NODE_OPTIONS=--require` argv logging: vitest actually receives `["--", "--run", "<path>"]`), and vitest's CLI parser stops parsing recognized flags at that `--`, so `--run` is swallowed as a raw positional filter string instead of the flag that disables watch mode — vitest stays in watch mode and falls back to scanning the whole project. **Drop the `--`**: `pnpm --filter <pkg> test --run <path>` works correctly (verified: 1 file, exits in seconds) and is exactly what `ci.yml`'s `compatibility.test.ts` step already does. `cd apps/api && npx vitest run <path>` (the `run` subcommand, no `--filter` involved) is the simplest way to sidestep this entirely, regardless of which shape the package's own `test` script is.
- **Vitest's path filter is a plain substring match, not a glob and not a directory prefix.** `vitest run src/routes/auth/` (trailing slash) matches only files physically inside the `auth/` directory and will **silently skip** sibling files `src/routes/auth.test.ts` and `src/routes/auth.passkeys.test.ts` — a targeted run can read green while both siblings are red and never executed. An asterisk does **not** help either — `vitest run src/routes/auth*` matches zero files (confirmed: "No test files found"); vitest does not glob-expand CLI filters. To cover a file and its dotted siblings, either list them explicitly (`vitest run src/routes/auth.test.ts src/routes/auth.passkeys.test.ts`) or drop the trailing slash and rely on substring matching (`vitest run src/routes/auth`) — but check the reported file count, since a bare substring can pull in unrelated matches too (e.g. `src/routes/auth` also matches `authenticator.test.ts`).

---

