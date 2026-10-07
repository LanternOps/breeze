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
- All tests run automatically in CI (`.github/workflows/ci.yml`)
- `test-api`, `test-web`, `test-agent` are **required** jobs on PRs
- New test files are auto-discovered — no CI config changes needed
- Go coverage is uploaded as artifact; no threshold enforced yet
- Integration tests run in the **`integration-test`** job (8 shards), which **blocks PRs**: it carries no `continue-on-error`, and `ci-success` hard-fails on `needs.integration-test.result`. Do not hand-dispatch CI to get an integration run on a PR that targets `main` — it already ran. The `continue-on-error: ${{ github.event_name == 'pull_request' }}` in `ci.yml` belongs to the separate **`smoke-test`** job (Docker image build + stack boot + endpoint smoke), which is non-blocking on PRs and required on main. A green PR can still redden main, but through a stale base or a stacked branch (see `docs/agents/tenancy-rls.md`, last paragraph of the cascade section), not through a skipped integration run

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

**Two traps when scoping a run to one file.** The `--` trap below reproduces on every workspace package regardless of its script shape — confirmed against both `apps/api` (`"test": "vitest"`, bare/watch-mode) and `apps/portal` (`"test": "vitest run"`, already run-once): both ran their FULL suite (1,470 and 26 files respectively) instead of the one targeted file. The only difference is that the bare-`"vitest"` packages (`apps/api`, `apps/web`, `packages/shared`, most others) then sit in watch mode afterward and never exit, while the `"vitest run"` packages (`apps/portal`, `apps/helper`, `apps/mobile`, `packages/extension-sdk`, `packages/extension-web-sdk`, `packages/extension-testkit`) at least exit once the full run finishes — either way, the file you asked for is not what got scoped.

- **Never write `pnpm --filter <pkg> test -- --run <path>`.** Confirmed by direct repro against `apps/api` (bare `"vitest"` script): this ran the *entire* suite (1,470 files / 25,380 tests) instead of the one file, and hung well past 2 minutes. Root cause: pnpm forwards the literal `--` token into the script's argv (verified via `NODE_OPTIONS=--require` argv logging: vitest actually receives `["--", "--run", "<path>"]`), and vitest's CLI parser stops parsing recognized flags at that `--`, so `--run` is swallowed as a raw positional filter string instead of the flag that disables watch mode — vitest stays in watch mode and falls back to scanning the whole project. **Drop the `--`**: `pnpm --filter <pkg> test --run <path>` works correctly (verified: 1 file, exits in seconds) and is exactly what `ci.yml`'s `compatibility.test.ts` step already does. `cd apps/api && npx vitest run <path>` (the `run` subcommand, no `--filter` involved) is the simplest way to sidestep this entirely, regardless of which shape the package's own `test` script is.
- **Vitest's path filter is a plain substring match, not a glob and not a directory prefix.** `vitest run src/routes/auth/` (trailing slash) matches only files physically inside the `auth/` directory and will **silently skip** sibling files `src/routes/auth.test.ts` and `src/routes/auth.passkeys.test.ts` — a targeted run can read green while both siblings are red and never executed. An asterisk does **not** help either — `vitest run src/routes/auth*` matches zero files (confirmed: "No test files found"); vitest does not glob-expand CLI filters. To cover a file and its dotted siblings, either list them explicitly (`vitest run src/routes/auth.test.ts src/routes/auth.passkeys.test.ts`) or drop the trailing slash and rely on substring matching (`vitest run src/routes/auth`) — but check the reported file count, since a bare substring can pull in unrelated matches too (e.g. `src/routes/auth` also matches `authenticator.test.ts`).

---

