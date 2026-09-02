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

## Monorepo Layout

- `apps/`: api, web, portal, mobile, viewer, helper, docs, excel/outlook/powerpoint/word add-ins, m365-graph-{read,actions}-executor
- `packages/`: shared, office-addin-core, extension-{sdk,web-sdk,testkit}
- `ee/`: first-party built-in extensions compiled into the API image (`workspace`); each loads at boot only when its enable flag is set (`BREEZE_WORKSPACE_ENABLED`)
- `agent/`: Go agent (own Makefile; `make run`)

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
   - **Every composite FK that references an `org_id` column (`(x, org_id) → parent(id, org_id)`) MUST be `DEFERRABLE INITIALLY IMMEDIATE`.** Org merge runs `SET CONSTRAINTS ALL DEFERRED` and re-points parent and child `org_id` in separate statements; a non-deferrable one aborts the merge with 23503. Enforced by `orgLifecycleFoundations.integration.test.ts` ("merge contract"), which only runs under **Integration Tests** (shard 2) — a unit-green PR still goes red there (#4585 did).
2. Migration must be idempotent (`IF NOT EXISTS` / `DO $$`). Never edit a shipped migration.
3. Add to the relevant allowlist in `rls-coverage.integration.test.ts` in the same PR (shapes 2-6).
4. **Register the table in every cascade list that applies (see below). RLS coverage does NOT imply cascade coverage — they are separate contracts, and this step is the one that gets missed.** Adding a **column** to an already-registered table is not exempt: see the export-policy row.
5. Run the contract tests locally (needs real DB).
6. Verify as `breeze_app`: `docker exec -it breeze-postgres psql -U breeze_app -d breeze` and forge a cross-tenant insert — must fail with `new row violates row-level security policy`.

**Cascade registration (step 4) — a new `org_id` table is NOT done until it's in these:**

| If the table… | Add it to | Enforced by (CI job) |
|---|---|---|
| has an `org_id` column (**always**) | `CORE_ORG_CASCADE_DELETE_ORDER` in `services/tenantCascade.ts` — alphabetical, `organizations` last | `tenantCascade.integration.test.ts` (**Integration Tests**) |
| has a `device_id` column | `CORE_DEVICE_CASCADE_DELETE_TABLES` in `routes/devices/core.ts` | `cascadeDelete.test.ts` (**Test API**) |
| has `device_id` **and** a denormalized `org_id` | also `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (same file) | `moveOrg.coverage.test.ts` (**Test API**) |
| is append-only (REVOKE DELETE + immutability trigger) | also `AUDIT_ADMIN_REQUIRED_TABLES` in `tenantCascade.ts` | runtime `permission denied` during erasure |
| is in `CORE_ORG_CASCADE_DELETE_ORDER` — **including when you only add a COLUMN to one** | `CORE_TENANT_EXPORT_POLICY` in `services/tenantExportPolicyRegistry.ts` | `tenant-export-policy.integration.test.ts` + `tenantExportErasureRoundtrip.integration.test.ts` (**Integration Tests**) |

**The export-policy row is the only one that fires on a new column, not just a new table.** Every column of every org-cascade table must be classified, so `ADD COLUMN` on a long-registered table breaks it. Buckets, via `tablePolicy(orgKey, groups)`:

- `included` — ordinary customer data and tenant identifiers (`tenant_id`, `user_id`, monotonic counters).
- `reviewedIncluded` — the name matches `SUSPICIOUS_NAME_PARTS` (password, hash, token, secret, credential, refresh, …) but is reviewed non-secret.
- `excludedSensitive` — credential, private-key, or verifier material.
- `excludedOpen` — **any `json`/`jsonb`/`bytea` column.** Open containers may embed credentials or capabilities, so a jsonb column cannot go in `included` even when its contents look harmless. A scope or grant list *is* a capability list (`m365_connections.observed_grants`, `observed_delegated_scopes`).

A table with no `org_id` needs no entry. Both suites need a live database, so neither can fail in **Test API** — same blind spot as the org cascade list below.

Why this list exists: missing a cascade list is a **latent GDPR org-erasure bug** — the org delete either strands rows under a dead tenant or aborts on an FK violation. It has shipped or blocked CI five times (#1359, #1351, #1365, #2179, #2514). Code review has caught it **0/5**; the contract tests caught it **5/5**. Treat it as a mechanical grep (`grep -rn '<table>' apps/api/src/services/tenantCascade.ts`), not a judgement call.

**Check the FK direction, not just membership.** Ordering is children-before-parents. An FK declared without an explicit `ON DELETE` defaults to `NO ACTION`, so a referencing table must be deleted *first* or the cascade raises an FK violation. Alphabetical order often satisfies this by luck (`api_keys` < `service_principals`) — verify, don't assume. `tenantCascade.integration.test.ts` asserts five properties: alphabetised by `localeCompare` with `organizations` last; every `org_id` table present; no entry naming a non-existent table; every cascade table exactly once; FK children before parents.

Only the device-side lists fail in the **Test API** unit job (they read the Drizzle schema statically). The org cascade list and both export-policy suites only fail under **Integration Tests**, so a PR on a stale base can go green and then red main after merge. Worse for a **stacked** PR: `ci.yml` triggers on `pull_request: branches: [main]`, so a PR based on a sibling branch runs *no* CI at all — only the two `smoke-binary-source-*` workflows, which makes `gh pr checks` read as green. Dispatch it per branch before merging: `gh workflow run CI --ref <branch>`.

For production backfills of `org_id` on hot tables (>1M rows), batch via `UPDATE ... WHERE ctid IN (... LIMIT N)` loops before `SET NOT NULL`. Full narrative and rationale: `docs/superpowers/plans/tenancy-rls/2026-04-11-rls-coverage-gaps.md`.

### Partner-Wide First (config/policy tables) — epic #2135

Breeze is an MSP tool: techs define one policy and apply it to ALL their orgs. **Every new config-ish table (policies, templates, rules, windows, baselines) defaults to dual-ownership: `org_id` XOR `partner_id`, both nullable, exactly one set.** `org_id NOT NULL` on a new config table needs an explicit justification in the PR (e.g. `backup_configs` — org-owned storage credentials). Org-first designs have required painful retrofits every time (#1724, #2126–#2129).

The playbook (copy a `2026-07-01-*-partner-ownership.sql` migration as the reference):
1. **Migration**: `partner_id` FK + `org_id` nullable + `<table>_one_owner_chk` CHECK `((org_id IS NULL) <> (partner_id IS NULL))` + partner index + ONE dual-axis RLS policy (`system OR org-access OR partner-access`), replacing any per-command org-only policies.
2. **Writes**: gate partner-wide create/update/delete on `canManagePartnerWidePolicies(auth)` (`services/partnerWideAccess.ts` — the single source of truth). Create routes take an `ownerScope: 'organization' | 'partner'` field; update schemas derived via `.partial()` must `.omit({ ownerScope: true })`.
3. **Reads**: app-layer dual-axis conditions (`orgCondition OR (org_id IS NULL AND partner_id = auth.partnerId)`) must be gated on `auth.scope === 'partner'` — org tokens carry a partnerId but never pass `breeze_has_partner_access`; RLS is stricter than the app layer, never claim parity. Readers running inside an org-scoped RLS context (agent paths!) cannot see partner-wide rows at all — move them to a system context (see the heartbeat probe-config pattern, #1105).
4. **Config-policy linkage**: add the feature type to `PARTNER_LINKABLE_FEATURE_TYPES` and the dual-axis branch of `validateFeaturePolicyExists` (`services/configurationPolicy.ts`); remove it from the org-only `FEATURE_TABLE_MAP`.
5. **Evaluation/enforcement**: if a worker/scheduler evaluates the table against devices, partner-wide rows MUST fan out by the device org's partner (never `eq(table.orgId, device.orgId)` alone — that silently no-ops on `org_id NULL`). Worker-created child rows (results, alerts, findings) always take the DEVICE's org. One integration test must prove the fan-out fires against real Postgres.
6. **Tests + UI**: register in `DUAL_AXIS_TENANT_TABLES` (`rls-coverage.integration.test.ts`), add a `<table>PartnerRls.integration.test.ts` suite (cross-partner forge 42501, XOR 23514, org isolation, fan-out), create-only ownerScope selector + "All orgs" badge in the web UI (pattern: `apps/web/src/components/software/PolicyForm.tsx`).
7. **Sweep ALL `<table>.orgId` call sites repo-wide** before calling it done — hidden second routes/readers (agent config delivery, AI tools, alert bridges, stats endpoints) are how features get missed.

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

### Web Mutation Handlers — `runAction`

**Mutation handlers must surface outcome via `runAction`.** Web action handlers that POST/PUT/PATCH/DELETE should wrap the request in `runAction` (`apps/web/src/lib/runAction.ts`) so success/failure is always shown to the user. `runAction` also treats HTTP-200 `{success:false}` / `{testResult:{success:false}}` response bodies as failures (not silent no-ops).

Catch pattern for callers:
```ts
if (err instanceof ActionError && err.status === 401) return; // let auth redirect handle it
if (!(err instanceof ActionError)) showToast({ type: 'error', ... }); // non-401 ActionError already toasted by runAction
```

The `no-silent-mutations` test (`apps/web/src/lib/__tests__/no-silent-mutations.test.ts`) guards the adopted set. Legitimate exceptions (typed service layers, aggregate/partial-success handlers with inline error UI) are recorded in `apps/web/src/lib/runActionAllowlist.ts`. Spec: `docs/superpowers/specs/web-ui/2026-05-15-ws-a-action-feedback-design.md`.

---

## Working Style (discretion, verbosity, delegation)

### Design decisions — optimize for the long term
- When multiple viable designs exist, choose the one that is best long-term
  (maintainability, extensibility, consistency with existing repo contracts) —
  never the one that is merely fastest to implement. "Works now, retrofit later"
  has repeatedly cost more than doing it right (org-first config tables, #1724,
  #2126–#2129).
- **For consequential design choices, convene an advisor quorum before
  implementing**: form your own position (Fable), then get an independent opinion
  from Codex (`codex exec`, read-only, `xhigh` — see Codex Delegation). If the two
  agree, proceed. If they disagree, weigh the arguments on the merits and either
  resolve it with a tie-breaking analysis or surface the disagreement to the user
  with a recommendation — don't silently pick one.
- "Consequential" means: new tables/tenancy shapes, cross-module contracts, public
  API surface, anything hard to reverse once shipped. Local naming/structure
  choices don't need a quorum.

### When to ask vs. proceed
- **Proceed without asking**: any reversible decision inside the task's stated
  scope — naming, file layout, test structure, refactor mechanics, choosing among
  established repo patterns. Pick the sensible default and note it in one line.
- **Ask first**: destructive or hard-to-reverse actions (data deletion, force-push,
  prod changes, closing issues/PRs, external comms), genuine scope changes, and
  product/UX decisions with no repo precedent. Design *quality* questions go to the
  advisor quorum above, not to the user.
- **Never block long-running work on a question.** If a decision point appears
  mid-task, take the conservative default, keep going, and flag it in the final
  summary. Batch open questions into one message at the end — don't serialize them.
- **When you do ask, ask directly — make it scannable.** Lead with the question
  itself in one sentence (bolded), not buried after background. Present the options
  as short labeled bullets with direct pros/cons — no hedging prose. End with your
  recommendation and the one-line reason. Format:

  **Question: Should X use approach A or B?**
  - **A — <name>**: pro …; con …
  - **B — <name>**: pro …; con …

  **Recommend A** — <one-line why>.

### Verbosity
- Decide, don't report. Lead with the outcome ("Fixed X — root cause was Y"), not
  a narrative of steps taken.
- Detail belongs in the PR description and commit messages, not chat. Chat gets:
  what changed, what's risky, what needs user input.
- No plan recitals before small tasks; no "Shall I proceed?" after a plan the user
  asked for.
- During long work: one status line per milestone or direction change, not per file.

### Efficient coding & review
- Match rigor to blast radius. Low-risk mechanical work (CRUD, copy, renames,
  config): implement, typecheck, run the affected tests — done. Full ceremony is
  reserved for tenancy/RLS, auth, migrations, billing, and agent-shipped code.
- Run targeted tests while developing; the full suite and the separate contract
  suites (RLS/integration) only before PR — and always then if tenancy/cascade
  code was touched.
- At most one independent review round per change. Act only on confirmed,
  consequential findings; don't loop on nitpicks, and only re-review a fix if the
  fix itself touched a high-blast-radius surface.

### Subagents & main-context preservation
- Delegate to subagents: codebase exploration, file reading/analysis, build-log and
  test-output inspection, PR reviews, doc sweeps — anything whose raw output is
  large. Keep the main context for decisions, coordination, and user interaction.
- Subagent prompts must be self-contained: exact file paths, the specific question
  or change, and the expected return shape (conclusions, not file dumps).
- **Never take a subagent's "done" at face value.** Verify the commit exists, the
  tests actually ran, and the change is on the right branch — subagents have
  reported success with uncommitted, off-branch, or vacuous work.
- Don't paste large files or logs into the main conversation; summarize or delegate
  the read.
- On long autonomous runs, make checkpoint commits at each working state so context
  loss is cheap to recover from.

---

## Feature Lifecycle Tracking (multi-wave features)

Features implemented in multiple waves/PRs are tracked on GitHub via the
**`feature-lifecycle` MCP server** (parent issue labeled `feature`, one `wave`
sub-issue per wave). Use the **`feature-lifecycle`** skill; state on GitHub is
the source of truth — never trust the plan doc for current status.

- **When `writing-plans` finishes a multi-wave plan:** call `register_feature`
  and add `tracking_issue: LanternOps/breeze#<parent>` to the plan doc's
  frontmatter. This is part of finishing the plan, not optional.
- **When starting a wave:** `get_feature_status` first, branch
  `feature/<parent#>-<slug>/wave-<subissue#>`, then `start_wave`.
- **PR bodies:** include `Closes #<sub-issue>` so the wave auto-closes on merge.
- **Resuming in any session:** `get_feature_status` before reading the plan.

Single-PR fixes and small features don't need this — it's for work with waves.

---

## Testing Standards

### Frameworks & Configuration
- **API**: Vitest — `apps/api/vitest.config.ts` (unit), `vitest.config.rls.ts` (RLS), `vitest.integration.config.ts` (integration)
- **Web**: Vitest + jsdom — `apps/web/vitest.config.ts`
- **Agent**: Go standard `testing` package — `go test -race ./...`
- **Shared**: Vitest — `packages/shared/vitest.config.ts`
- **E2E**: Playwright Test (TypeScript), `data-testid` based — `e2e-tests/playwright.config.ts`, specs under `e2e-tests/tests/*.spec.ts`, Page Objects under `e2e-tests/pages/`. Tests query DOM via `data-testid` attributes only (not text/role/CSS) — see `e2e-tests/README.md` for the convention.

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
- Integration tests run in the **`integration-test`** job (4 shards), which **blocks PRs**: it carries no `continue-on-error`, and `ci-success` hard-fails on `needs.integration-test.result`. Do not hand-dispatch CI to get an integration run on a PR that targets `main` — it already ran. The `continue-on-error: ${{ github.event_name == 'pull_request' }}` in `ci.yml` belongs to the separate **`smoke-test`** job (Docker image build + stack boot + endpoint smoke), which is non-blocking on PRs and required on main. A green PR can still redden main, but through a stale base or a stacked branch (see the tenancy section above), not through a skipped integration run

### Running Tests Locally
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
# (separate vitest configs: vitest.config.rls.ts, vitest.integration.config.ts).
# Local green ≠ CI green — run those explicitly when touching tenancy/cascade code.

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

## Model Routing (cost/speed strategy — benchmarked 2026-09-01)

**Expensive models write contracts and verify claims; cheap models do everything in between; mechanical checks replace expensive review wherever the work is gradeable.** Basis: two head-to-head benchmarks (blind bug-hunt + blind spec→codegen) across Laguna, Codex gpt-5.6-sol med/high, Haiku, Sonnet, Opus — see memory `model-benchmark-codex-claude-laguna-2026-09-01`.

1. **Spec-down (Fable/Opus in-session).** Spend top-tier tokens only on: resolving spec ambiguity, choosing contracts (tenancy shape, cascade lists, API surface), and cross-file reachability judgment. All six models aced a fully-resolved spec (39/39 each); 2 of 3 Claude PRIMARY bug claims died on a file the blind reviewer couldn't see. The orchestrator's value is the contract, not the typing.
2. **Generate cheap — route by access needs, not quality.** Laguna (free, local, ~10× faster): any paste-in-shaped work — spec'd modules, co-located tests, migration drafts from a stated contract. Codex `medium` (flat sub, ~0 marginal): well-scoped repo-touching edits and single-file bug-hunts. Haiku subagents: mechanical repo chores needing tools, with explicit file lists.
3. **Verify mechanically first.** tsc/tests/grep-the-contract before any model review — the cascade-list history is contract tests 5/5 vs human review 0/5. A hidden acceptance suite converts "needs expensive review" into "needs a script."
4. **Review sized by blast radius.** Default: Laguna + Codex `medium` in parallel (~free, ~1 min), orchestrator arbitrates — disagreement is signal; Laguna's hallucinations die at verification (it misread code 2× in the bench — never trust its line-level claims unre-read). Reserve Sonnet (precision: 4/4 real findings, 0 hallucinations) or Opus (depth: found the billing bug nobody else saw) for tenancy/auth/billing/agent-shipped code.
5. **Advisor quorum unchanged** — Fable + codex `xhigh` only for consequential, hard-to-reverse design (see Working Style).

## Codex Delegation

This project uses OpenAI Codex CLI for **read-only analysis (bug-hunting, security review, design-from-plan — its strongest uses) and well-scoped single-file edits** (utilities, co-located tests, CRUD endpoints, mechanical renames). Keep with Claude: repo-wide sweeps/enumeration, cross-module refactors (codex misses existing canonical code), UI work, and the *architecture* of multi-tenant/auth changes — though codex may *execute* an RLS migration once Claude hands it the tenancy contract. Default to `medium` (2026-09-01 bench: `medium` beat `high` on bug-hunts and tied on codegen); escalate to `high` only when medium comes back thin; reserve `xhigh` for open-ended design. Model is `gpt-5.6-sol`. For commands, reasoning levels, and the benchmarked delegation matrix, use the **`delegating-to-codex`** skill.

---

## Development Commands

```bash
# Install dependencies
pnpm install

# Start development servers
pnpm dev

# Database operations
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate      # Apply migrations
pnpm db:seed         # Seed dev data
pnpm db:check-drift  # Verify schema matches migrations (no drift)
pnpm db:studio       # Open Drizzle Studio

# Node is pinned to 22.23.2 (.nvmrc / .node-version; package.json engines requires >=22.22.2).
# Other root scripts: pnpm lint, pnpm build, pnpm wt-stack
# (no root typecheck script — typecheck runs via turbo/CI only)

# Agent development
cd agent && make run
```

### Schema Migration Workflow
1. Edit schema files in `apps/api/src/db/schema/`
2. Write a hand-written SQL migration in `apps/api/migrations/`. The runner accepts any filename matching `^\d{4}-.*\.sql$` and applies them in `localeCompare` (lexicographic) order, so the prefix has to sort correctly.
   - **Naming:** prefer `YYYY-MM-DD-HHMMSS-<slug>.sql` for new work. The time component orders same-day migrations natively, so it removes the need for the hand-assigned `-a-`/`-b-` infix below — whose letters are what produced the closed-block confusion. Plain `YYYY-MM-DD-<slug>.sql` remains valid. The legacy `NNNN-<slug>.sql` 4-digit form is still accepted but only for files predating the date-prefix switch — don't introduce new ones. **A Unix-epoch prefix does not work here**: `1787000000-…` sorts *before* every `2026-…` file under `localeCompare`, so it would replay ahead of the entire history.
   - **Same-day ordering:** if two migrations on the same date depend on each other (e.g. one creates a table, the other adds constraints or policies on it), insert an explicit `-a-`/`-b-` infix between the date and the slug: `2026-04-19-a-installer-bootstrap-tokens.sql`, `2026-04-19-b-installer-bootstrap-tokens-constraints.sql`. Don't rely on the slug to sort the files for you — `-` (0x2D) < `.` (0x2E), so `foo-bar.sql` sorts *after* `foo-bar-extra.sql`, which has bitten us before (issue #506). The infix letters are **per-date and local to that date** — not a global sequence, and never continued across dates. The `apps/api/src/db/autoMigrate.test.ts` regression test will catch most ordering bugs.
   - **`2026-08-06` is a CLOSED date block — never add `2026-08-06-g-` (or `-h-`, `-i-`, …).** Its eight shipped files fill slots `-a-`…`-f-` (mostly the security-remediation waves, plus two same-day migrations from unrelated work); they are content-hash immutable and carry ordering dependencies on each other, so a file wedged into the block replays in the wrong order on a fresh DB. Three separate authors independently reached for `-g-` (#2995 merged and reddened main; #3008 caught on the PR; a plan doc instructed a third) because the same-day rule above reads as "take the next free letter" — correct in general, just not on a closed date. **If you need to sort after everything shipped, name the file to sort after the newest COMMITTED migration** — check it, do not assume today's date does the job. It does not: shipped filenames ran ahead of real time in a compounding ratchet (each author picked one day past the highest existing name to guarantee sort-last, raising the ceiling for the next), so 169 of 466 dated migrations are named ahead of the day they landed, the furthest by 16 days. As of 2026-08-26 the newest is `2026-09-10-…`, i.e. **more than two weeks ahead of today**, and a file named for today would replay before it. Shipped migrations are content-hash immutable so they cannot be renamed back; the ceiling stands until real time catches up. Enforced at commit time by rule 3 of the guard. Enforced by `scripts/check-migration-naming.sh` (pre-commit hook + CI) and `autoMigrate.test.ts`; full authoring reference in `apps/api/migrations/README.md`.
   - **Idempotent:** `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` then re-add, `DO $$ BEGIN ... EXCEPTION`, `pg_policies` existence checks for policies. Re-applying must be a no-op.
   - **No inner `BEGIN;`/`COMMIT;`:** `autoMigrate` wraps each file in `client.begin(...)`. Adding your own transaction blocks emits `NOTICE: there is already a transaction in progress` and serves no purpose.
   - **Cleanup statements must report row counts:** a migration that UPDATEs/DELETEs suspect rows (e.g. before adding a constraint) should wrap the statement in `DO $$ ... GET DIAGNOSTICS n = ROW_COUNT; IF n > 0 THEN RAISE WARNING 'cleaned % <what>', n; END IF; END $$;` so the count lands in Postgres logs. Silently fixing bad data destroys the forensic trail — if those rows could evidence a tenant-isolation breach, you want a recorded count even when it's 0 (lesson from `2026-06-10-c`).
   - **Never edit a shipped migration** — fix forward with a new migration. (Renaming is also editing for tracking purposes: `breeze_migrations` keys on filename, so a rename causes already-migrated DBs to re-apply under the new name. Only acceptable when the file is fully idempotent and re-application is a true no-op.) A rename must also **sweep every reference to the old path**: integration suites replay migrations by path (`readFileSync('../../../migrations/<file>.sql')`), so a missed one is an `ENOENT` minutes into Integration Tests, not a compile error. `autoMigrate.test.ts` asserts every such reference resolves, moving that failure into the unit job.
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

**Deleting a config file? Sweep the Compose mounts in the same PR.** Docker creates a missing bind-mount source as an empty **directory** on the host, which then gets `COPY`d into dev images where Vite/PostCSS discovery dies on it (`EISDIR`) — `breeze-web` comes up permanently unhealthy on a fresh clone. `apps/api/src/config/composeBindMounts.test.ts` (required **Test API** job) parses every tracked compose file and fails when a file-shaped, repo-relative bind-mount source doesn't exist — or has already become a phantom directory. Extensionless sources (`./agent/bin`) are exempt as intended build outputs; out-of-repo sources (`../breeze-billing/…`) can't be asserted and are skipped. Shipped three times before the guard existed: #1999 (postcss), #2208 (partial tailwind), #2012 (the mounts #2208 missed).

### PR Merge Process
- Branch protection requires status checks, but the repo owner uses `--admin` to bypass when CI is green
- Use `gh pr merge --squash --admin` (merge commits are disabled on this repo)
- This is the normal workflow — do not wait for branch protection rules to be satisfied

### Production Deploy (EU + US droplets)

Droplets pull from `/opt/breeze` and use mutable image tags driven by `BREEZE_VERSION` in `/opt/breeze/.env`. The flow is:

```bash
ssh root@<droplet> "cd /opt/breeze && \
  cp .env .env.bak-pre-<new-version> && \
  sed -i 's/^BREEZE_VERSION=.*/BREEZE_VERSION=<new-version>/' .env && \
  docker compose pull api web portal && \
  docker compose up -d binaries-init api web portal"
```

Then `curl -sf https://<region>.2breeze.app/health` to verify (200 = healthy).

**The service list is hand-maintained and WILL go stale — always assert version parity after deploying.** The line names services explicitly (not a bare `docker compose pull && up -d`) because `billing` builds from a local `breeze-billing:local` image with no registry to pull from, and a bare `up -d` would needlessly bounce `caddy`/`redis`/`tunnel`. The cost is that adding a new first-party service silently breaks the rollout: `portal` was added in v0.94.0, never made it into the deploy line, and sat on `0.94.0` through five releases while `/health` reported `0.98.1` — a portal fix from v0.97.0 was invisible in production for 11 days (2026-07-20). Watchtower is not a backstop: it runs `WATCHTOWER_LABEL_ENABLE=true` and no service carries the label, so it updates nothing.

`/health` is served by the API and cannot detect this, so enumerate what is actually running instead of trusting the list:

```bash
ssh root@<droplet> "cd /opt/breeze && set -a && . ./.env && set +a && \
  docker ps -a --format '{{.Names}}\t{{.Image}}' | grep 'ghcr.io/lanternops/breeze/' | \
  while IFS=\$'\t' read -r n i; do t=\${i##*:}; \
    [ \"\$t\" = \"\$BREEZE_VERSION\" ] && echo \"OK    \$n \$t\" || echo \"SKEW  \$n \$t (expected \$BREEZE_VERSION)\"; done"
# every line must be OK; any SKEW means that service was never rolled.
```

**Required env vars added by v0.65+ — droplets without these refuse to start:**

- `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS` — base64 SPKI of the Ed25519 release manifest signing key. Source: `internal/release-keys/release-manifest.ed25519.pub` (the base64 between `-----BEGIN PUBLIC KEY-----` and `-----END PUBLIC KEY-----`, single line). The API config validator refuses to boot in production without it when `BINARY_SOURCE=github`.
- `IS_HOSTED` — must be explicitly set to `true` (hosted SaaS) or `false` (self-hosted) in production. Without this, a misconfigured deploy (e.g. `.env` value not mapped through compose) silently drops new partners straight to `status='active'`, bypassing the email-verification gate in `/auth/register-partner` (issue #570).

When introducing a new required env var: add it to `/opt/breeze/.env` AND map it explicitly in the `api`/`web` service `environment:` block of `/opt/breeze/docker-compose.yml`. Compose interpolation only happens for vars listed there — having a value in `.env` is necessary but not sufficient.

**Watchtower policy (#603):** repo-tracked compose files never include Watchtower (enforced by `check-supply-chain-hardening.sh`). On droplets, Watchtower is acceptable for sidecars (caddy, redis, postgres-exporter, cloudflared) but **must not** auto-update `breeze-api` or `breeze-web`. Concretely, the `com.centurylinklabs.watchtower.enable: "true"` label is forbidden on those two services. The hardening check additionally rejects that label string in any tracked compose file as defense-in-depth.

**Known drift:** the deployed `/opt/breeze/docker-compose.yml` uses Watchtower + mutable tags, while `deploy/docker-compose.prod.yml` in the repo uses digest-pinning + no Watchtower. The `check-supply-chain-hardening.sh` rule scans repo files only, so the droplet drift isn't fully enforced. Reconciling this is tracked separately.
