# Breeze RMM - Claude Context

## Project Overview

Breeze is a fast, modern Remote Monitoring and Management (RMM) platform for MSPs and internal IT teams. Target: 10,000+ agents with enterprise features.

## Tech Stack

- **Frontend**: Astro + React Islands
- **API**: Hono (TypeScript)
- **Database**: PostgreSQL + Drizzle ORM
- **Queue**: BullMQ + Redis
- **Agent**: Go (cross-platform)
- **Real-time**: HTTP polling + WebSocket
- **Remote Access**: WebRTC

## Key Patterns

### Multi-Tenant Hierarchy
```
Partner (MSP) → Organization (Customer) → Site (Location) → Device Group → Device
```

### Tenant Isolation / RLS (READ BEFORE ADDING TABLES)
The API connects to Postgres as the unprivileged `breeze_app` role. Every tenant-scoped table MUST have RLS enabled + forced + policies — there is no app-layer-only fallback. Migration `0008-tenant-rls.sql` only auto-loops tables existing at that moment; every table added since must opt in explicitly.

**Five tenancy shapes** (see `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` — the contract test enforces all of them):
1. **Direct `org_id` column** — standard 4 policies calling `breeze_has_org_access(org_id)`. Auto-discovered by the contract test; no allowlist needed.
2. **Id-keyed (`organizations`)** — the row's own `id` is the tenant; policy calls `breeze_has_org_access(id)`. Add to `ORG_ID_KEYED_TENANT_TABLES`.
3. **Partner-axis (`partners`, `partner_users`)** — uses `breeze_has_partner_access(partner_id)` + `breeze.accessible_partner_ids` GUC. Flat membership check, never a tree traversal. Add to `PARTNER_TENANT_TABLES`.
4. **Dual-axis (`users`)** — partner OR org OR self-read via `breeze_current_user_id()`. Composite FK `(org_id, partner_id) → organizations(id, partner_id)` enforces structural integrity so a user row cannot point at an org from another MSP even through a policy bug.
5. **Device-id scoped** — for tables joined to `devices`. **Heuristic:** hot agent-write-path tables get a denormalized `org_id` column (Phase 1-4 shape, faster); admin/cold tables use a `EXISTS (SELECT 1 FROM devices d WHERE d.id = t.device_id AND breeze_has_org_access(d.org_id))` join policy (Phase 5 shape, no schema churn). Add join-policy tables to `DEVICE_ID_JOIN_POLICY_TABLES`.
6. **User-id-scoped** — `push_notifications`, `mobile_devices`, etc. Reference `breeze_current_user_id()`. Add to `USER_ID_SCOPED_TABLES`.

**DB context helpers** (`apps/api/src/db/index.ts`):
- `withDbAccessContext(ctx, fn)` — sets `breeze.scope`, `breeze.org_id`, `breeze.accessible_org_ids`, `breeze.accessible_partner_ids`, `breeze.user_id` GUCs inside a transaction. Standard request path.
- `withSystemDbAccessContext(fn)` — system scope (`*` on all axes). Use ONLY for legitimate system-scope work (background workers, seeds, audit log writes, cross-tenant catalog reads).
- `runOutsideDbContext(fn)` — exits AsyncLocalStorage so the next `db` access uses the bare pool. Required before calling `withSystemDbAccessContext` from inside a request to escape the request-scoped transaction.

**Intentionally system-scoped (do not add RLS):** `device_commands` (agent WS path reads/writes from system scope). Anything else flagged "INTENTIONAL_UNSCOPED" in a plan doc.

**Workflow when adding a new tenant-scoped table:**
1. Pick the shape from the six above. Add policies in the same migration that creates the table — never defer.
2. Use `IF NOT EXISTS` / `DO $$` blocks like every other migration. Never edit a shipped migration.
3. If the new table needs an entry in any of the contract test's allowlists (shapes 2-6), add it to `rls-coverage.integration.test.ts` in the same PR.
4. Run the contract test locally — it uses `pg_catalog` and needs a real DB.
5. Verify locally as `breeze_app`: `docker exec -it breeze-postgres psql -U breeze_app -d breeze` and try a forged cross-tenant insert — it should fail with `new row violates row-level security policy`.

**Production rollout for backfilling `org_id` columns on hot tables:** batch with `UPDATE ... WHERE ctid IN (SELECT ctid ... LIMIT N)` loops. The `SET NOT NULL` after backfill takes a brief ACCESS EXCLUSIVE lock — check `pg_stat_user_tables.n_live_tup` on the prod replica first. Tables > 1M rows must use the batched path. JOIN_POLICY shape (Phase 5) is policy-only and safe to apply in one shot regardless of row count.

**Reference doc:** `docs/superpowers/plans/2026-04-11-rls-coverage-gaps.md` — source-of-truth narrative covering Buckets A/B/C (64 tables across 13 commits as of 2026-04-11) and the rationale for each shape choice.

### Database Schema Location
- `apps/api/src/db/schema/` - All Drizzle schema definitions
- Key tables: devices, users, organizations, sites, alerts, scripts, automations

### API Routes
- `apps/api/src/routes/` - Hono route handlers
- Pattern: Export `xxxRoutes` from each file, mount in `index.ts`

### File Size Guideline
- **Aim to keep files under 500 lines** as a soft guideline, not a hard rule. Use judgment — if a file is cohesive and readable at 600 lines, that's fine. Split when a file becomes hard to navigate or mixes unrelated concerns, not just because it crossed a line count.
- **Declarative files** (e.g. `aiTools*.ts`, schema definitions) can naturally run longer since they're mostly self-contained registration blocks.
- Follow the `aiTools*.ts` pattern: one thin hub file for registry/exports, per-domain files for implementations (e.g. `aiToolsDevice.ts`, `aiToolsNetwork.ts`).
- For route files, split by resource. For service files, split by domain. Helpers used by multiple files can be duplicated locally or extracted to a shared utils file.
- **Do not proactively split files** that are working well just to meet a line count target. Only split when it improves clarity or maintainability.

### Context Preservation
- **Prefer subagents (Agent tool) for research, exploration, and isolated tasks** to keep the main conversation context lean and avoid hitting context limits during long sessions.
- Use subagents for: codebase searches, file reading/analysis, PR reviews, build log inspection, and any work that produces large output.
- Keep the main context for: decision-making, coordinating work, and user interaction.

### URL State in Components
- Use `window.location.hash` (`#value`) for client-side UI state like selected tabs, selected items in lists, etc. See `DeviceDetails.tsx` and `OrganizationsPage.tsx` for examples.
- Do **not** use query params (`?key=value`) for transient UI state — keep the pattern consistent.

### Shared Code
- `packages/shared/src/types/` - TypeScript interfaces
- `packages/shared/src/validators/` - Zod schemas
- `packages/shared/src/utils/` - Utility functions

---

## Testing Standards

### Frameworks & Configuration
- **API**: Vitest — `apps/api/vitest.config.ts` (unit), `vitest.config.rls.ts` (RLS), `vitest.integration.config.ts` (integration)
- **Web**: Vitest + jsdom — `apps/web/vitest.config.ts`
- **Agent**: Go standard `testing` package — `go test -race ./...`
- **Shared**: Vitest — `packages/shared/vitest.config.ts`
- **E2E**: YAML-driven runner — `e2e-tests/run.ts` with `e2e-tests/tests/*.yaml`

### Test File Placement
- Place test files **alongside source files**, not in separate directories
- API: `routes/devices.ts` → `routes/devices.test.ts`
- Go: `internal/discovery/scanner.go` → `internal/discovery/scanner_test.go`
- Shared: `validators/filters.ts` → `validators/filters.test.ts`

### Writing API Route Tests (Vitest)
- Mock Drizzle ORM query chains matching the exact chain pattern in the source (e.g., `select().from().where()`)
- Always test **multi-tenant isolation** — verify org-scoped data can't be accessed cross-org
- Test all HTTP methods, auth/authz, Zod validation failures, not-found, and error cases
- Use proper UUIDs in mock data — Zod validates UUID format and will reject `'other-org'`
- Avoid trailing slashes in test URLs — Hono sub-routers return 404 for trailing slashes
- `vi.mock` factories are hoisted — don't reference module-level `const` values inside them; use literal values instead
- Read 2-3 existing test files in the same directory before writing new ones to match patterns

### Writing Go Agent Tests
- Use **table-driven tests** for functions with multiple input/output combinations
- Always run with `-race` flag to catch data races
- Mock external dependencies (network, OS, filesystem) — never make real network calls
- Use build tags for platform-specific tests: `//go:build !windows` or `//go:build darwin`
- Test nil/empty inputs, error paths, and concurrency safety (spawn goroutines in tests)
- Place test helpers in the same package, not in a separate `_test` package

### Writing Shared Validator Tests
- Test valid inputs, invalid inputs, boundary values, and Zod defaults/coercion
- For discriminated unions, test each variant separately
- Test `omitempty`/optional fields with both present and absent values
- For schemas with `superRefine`, test all validation branches

### What Every New Feature Must Test
1. **Happy path** — basic success case
2. **Auth/authz** — unauthenticated, wrong role, wrong org
3. **Validation** — missing required fields, invalid types, boundary values
4. **Multi-tenant isolation** — cross-org access denied
5. **Error cases** — not found, conflict, server error
6. **Edge cases** — empty arrays, nil inputs, concurrent access

### CI Integration
- All tests run automatically in CI (`.github/workflows/ci.yml`)
- `test-api`, `test-web`, `test-agent` are **required** jobs on PRs
- New test files are auto-discovered — no CI config changes needed
- Go coverage is uploaded as artifact; no threshold enforced yet
- Integration tests run in `smoke-test` job with `continue-on-error: true`

### Running Tests Locally
```bash
# All tests
pnpm test

# API only
pnpm test --filter=@breeze/api

# Go agent (with race detection)
cd agent && go test -race ./...

# Specific Go package
cd agent && go test -race ./internal/discovery/...

# E2E
cd e2e-tests && npx tsx run.ts --mode live
```

---

## Codex Delegation

This project uses OpenAI Codex CLI for task delegation. Claude orchestrates complex work while Codex handles isolated tasks.

### Quick Commands

```bash
# Standard task
codex exec "<task>" --full-auto -C "/Users/toddhebebrand/breeze"

# With reasoning level (low/medium/high/xhigh)
codex exec "<task>" --full-auto -c 'model_reasoning_effort="xhigh"'

# Resume previous session
codex exec resume --last "<follow-up>"
```

### Delegation Guidelines

#### Delegate to Codex
| Task | Reasoning | Example |
|------|-----------|---------|
| File operations | low | "Find all files importing X" |
| Utility functions | medium | "Create a slugify utility" |
| CRUD endpoints | medium | "Add DELETE /api/devices/:id" |
| Test generation | medium | "Write tests for formatBytes" |
| Lint/type fixes | medium | "Fix TypeScript errors in auth.ts" |
| Code analysis | high | "Review this for security issues" |
| Architecture | xhigh | "Design the caching strategy" |

#### Keep with Claude
- Multi-tenant data isolation
- Authentication/authorization logic
- Cross-module refactoring
- Business logic implementation
- Coordinating multiple Codex tasks
- Final code review and integration

### Reasoning Effort Findings

| Level | Behavior | Use When |
|-------|----------|----------|
| `low` | Verbose, more tokens | Simple mechanical tasks |
| `medium` | Balanced (default) | Standard code generation |
| `high` | Thoughtful analysis | Code review, debugging |
| `xhigh` | Strategic, concise, fewer tokens | Architecture decisions |

### Token Costs (Tested)

| Task Type | Approximate Tokens |
|-----------|-------------------|
| File search | ~1.3k |
| Code comprehension | ~2.9k |
| Utility generation | ~3.5k |
| Security analysis | ~2.4-4.7k |
| Architecture design | ~1.6-4.7k |

### Codex Strengths (Observed)

- Uses `rg` efficiently for searches
- Proactively creates directories and updates exports
- Follows existing project conventions
- Good at isolated, well-scoped tasks
- Excellent security analysis capabilities

---

## Development Commands

```bash
# Install dependencies
pnpm install

# Start development servers
pnpm dev

# Database operations
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:check-drift  # Verify schema matches migrations (no drift)
pnpm db:studio       # Open Drizzle Studio

# Agent development
cd agent && make run
```

### Schema Migration Workflow
1. Edit schema files in `apps/api/src/db/schema/`
2. Write a hand-written SQL migration in `apps/api/migrations/NNNN-<slug>.sql`
   - Use the next available 4-digit number (check existing files)
   - Must be fully idempotent: `IF NOT EXISTS`, `IF EXISTS`, `DO $$ BEGIN ... EXCEPTION`
   - Never edit a shipped migration — fix forward with a new migration
3. Run `pnpm db:check-drift` to verify schema matches migrations
4. Commit the migration file

**Drizzle usage:** Drizzle ORM is used for type-safe queries only. `drizzle-kit` is retained for schema drift detection (`db:check-drift`) and Drizzle Studio (`db:studio`). **Do not use `drizzle-kit generate` or `drizzle-kit push` for migrations.**

For optional TimescaleDB setup, see `apps/api/migrations/optional/`.

### Docker Compose Modes

Three named override files exist — no auto-applied `docker-compose.override.yml` by default.

| File | Purpose |
|---|---|
| `docker-compose.override.yml.dev` | Code-mounted hot-reload (builds from `Dockerfile.api.dev` / `Dockerfile.web.dev`) |
| `docker-compose.override.yml.ghcr` | Pre-built GHCR images (linux/amd64) |
| `docker-compose.override.yml.local-build` | Native arm64 local build from production Dockerfiles |

```bash
# Dev mode (code-mounted, hot-reload)
docker compose -f docker-compose.yml -f docker-compose.override.yml.dev up --build -d

# GHCR mode (pre-built images)
docker compose -f docker-compose.yml -f docker-compose.override.yml.ghcr up -d

# Local build mode (native arm64)
docker compose -f docker-compose.yml -f docker-compose.override.yml.local-build up --build -d

# Or symlink whichever mode you want as default:
ln -sf docker-compose.override.yml.dev docker-compose.override.yml
docker compose up --build -d
```

### PR Merge Process
- Branch protection requires status checks, but the repo owner uses `--admin` to bypass when CI is green
- Use `gh pr merge --squash --admin` (merge commits are disabled on this repo)
- This is the normal workflow — do not wait for branch protection rules to be satisfied

## Current Status

See `docs/PROJECT_STATUS.md` for implementation status and next steps.

### Priority: Authentication System
- Login/logout with JWT
- MFA (TOTP)
- Password reset flow
- SSO integration
- Rate limiting (Redis-backed sliding window)
