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
API connects to Postgres as unprivileged `breeze_app`. Every tenant-scoped table MUST have RLS enabled + forced + policies — no app-layer-only fallback. Contract test: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`.

**Six tenancy shapes:**

| # | Shape | Policy helper | Allowlist |
|---|---|---|---|
| 1 | Direct `org_id` column | `breeze_has_org_access(org_id)` | auto-discovered |
| 2 | Id-keyed (`organizations`) | `breeze_has_org_access(id)` | `ORG_ID_KEYED_TENANT_TABLES` |
| 3 | Partner-axis | `breeze_has_partner_access(partner_id)` (flat, never tree traversal) | `PARTNER_TENANT_TABLES` |
| 4 | Dual-axis (`users`) | partner OR org OR `breeze_current_user_id()`; enforced by composite FK `(org_id, partner_id) → organizations(id, partner_id)` | — |
| 5 | Device-id scoped | hot agent-write tables denormalize `org_id` (Phase 1-4); cold tables use `EXISTS` join policy (Phase 5) | `DEVICE_ID_JOIN_POLICY_TABLES` |
| 6 | User-id scoped | `breeze_current_user_id()` | `USER_ID_SCOPED_TABLES` |

**DB context helpers** (`apps/api/src/db/index.ts`): `withDbAccessContext` (request path), `withSystemDbAccessContext` (background/seeds — call `runOutsideDbContext` first if inside a request), bare pool is forbidden in request code.

**Intentionally system-scoped:** `device_commands` (agent WS path). Anything else flagged `INTENTIONAL_UNSCOPED` in a plan doc.

**Workflow for a new tenant-scoped table:**
1. Pick a shape; add policies in the same migration that creates the table — never defer.
2. Migration must be idempotent (`IF NOT EXISTS` / `DO $$`). Never edit a shipped migration.
3. Add to the relevant allowlist in `rls-coverage.integration.test.ts` in the same PR (shapes 2-6).
4. Run the contract test locally (needs real DB).
5. Verify as `breeze_app`: `docker exec -it breeze-postgres psql -U breeze_app -d breeze` and forge a cross-tenant insert — must fail with `new row violates row-level security policy`.

For production backfills of `org_id` on hot tables (>1M rows), batch via `UPDATE ... WHERE ctid IN (... LIMIT N)` loops before `SET NOT NULL`. Full narrative and rationale: `docs/superpowers/plans/2026-04-11-rls-coverage-gaps.md`.

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

### No Internal Infrastructure Details in Public Code
- **Never commit** IP addresses, server hostnames, datacenter regions, droplet IPs, or internal domain mappings to the public repo.
- Region-specific values belong in `.env` files (gitignored), not in code or config templates.
- `.env.example` files should use generic placeholders (`host`, `password`, `your-domain.example.com`), not real values.
- The `internal/` directory is gitignored and safe for strategy docs, internal notes, and infra-specific details.

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

### Writing Tests
For test-writing conventions (Drizzle mock patterns, table-driven Go tests, validator coverage, and the required coverage checklist), use the **`breeze-testing`** skill.

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

This project uses OpenAI Codex CLI for isolated, well-scoped tasks (file operations, utility generation, CRUD endpoints, code analysis). Keep with Claude: multi-tenant isolation, auth/authz, cross-module refactoring, and task coordination. For commands, reasoning levels, and the full delegation matrix, use the **`delegating-to-codex`** skill.

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
2. Write a hand-written SQL migration in `apps/api/migrations/`. The runner accepts any filename matching `^\d{4}-.*\.sql$` and applies them in `localeCompare` (lexicographic) order, so the prefix has to sort correctly.
   - **Naming:** use `YYYY-MM-DD-<slug>.sql` (the current convention). The legacy `NNNN-<slug>.sql` 4-digit form is still accepted but only for files predating the date-prefix switch — don't introduce new ones.
   - **Same-day ordering:** if two migrations on the same date depend on each other (e.g. one creates a table, the other adds constraints or policies on it), insert an explicit `-a-`/`-b-` infix between the date and the slug: `2026-04-19-a-installer-bootstrap-tokens.sql`, `2026-04-19-b-installer-bootstrap-tokens-constraints.sql`. Don't rely on the slug to sort the files for you — `-` (0x2D) < `.` (0x2E), so `foo-bar.sql` sorts *after* `foo-bar-extra.sql`, which has bitten us before (issue #506). The `apps/api/src/db/autoMigrate.test.ts` regression test will catch most ordering bugs.
   - **Idempotent:** `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` then re-add, `DO $$ BEGIN ... EXCEPTION`, `pg_policies` existence checks for policies. Re-applying must be a no-op.
   - **No inner `BEGIN;`/`COMMIT;`:** `autoMigrate` wraps each file in `client.begin(...)`. Adding your own transaction blocks emits `NOTICE: there is already a transaction in progress` and serves no purpose.
   - **Never edit a shipped migration** — fix forward with a new migration. (Renaming is also editing for tracking purposes: `breeze_migrations` keys on filename, so a rename causes already-migrated DBs to re-apply under the new name. Only acceptable when the file is fully idempotent and re-application is a true no-op.)
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
