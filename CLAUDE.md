# Breeze RMM - Claude Context

Breeze is a Remote Monitoring and Management (RMM) platform for MSPs and internal IT teams, targeting 10,000+ agents. Stack: Astro + React islands (web), Hono/TypeScript (API), PostgreSQL + Drizzle (queries only), BullMQ + Redis, Go agent, WebSocket + HTTP polling, WebRTC remote access.

This file holds rules and pointers. **The pointed-to docs are mandatory reading when their trigger applies** — the detail lives there, not here.

| Trigger | Read first |
|---|---|
| Adding a table, adding a column to an org-cascade table, or any config/policy table | `docs/agents/tenancy-rls.md` |
| Writing or renaming a migration | `apps/api/migrations/README.md` |
| Running a scoped test or a contract/integration suite; deciding which CI job catches what | `docs/agents/testing.md` (conventions: `breeze-testing` skill) |
| Touching `pages/settings/**` or a `*Settings*` component | `docs/agents/settings.md` |
| Merging a PR, or deploying to the EU/US droplets | `docs/agents/merge-and-deploy.md` |
| Bringing up / tearing down a local Docker stack | `docs/agents/local-stacks.md` (per-worktree: `worktree-stack` skill) |
| Choosing a model or delegating to Codex/Laguna | `docs/agents/model-routing.md` (`delegating-to-codex` skill) |

## Monorepo Layout

- `apps/`: api, web, portal, mobile, viewer, helper, docs, Office add-ins, m365-graph-{read,actions}-executor
- `packages/`: shared (`types/`, `validators/` (Zod), `utils/`), office-addin-core, extension-{sdk,web-sdk,testkit}
- `ee/`: first-party extensions compiled into the API image; each loads only when its enable flag is set (`BREEZE_WORKSPACE_ENABLED`)
- `agent/`: Go agent (own Makefile; `make run`)
- Schema: `apps/api/src/db/schema/`. Routes: `apps/api/src/routes/`, each exports `xxxRoutes`, mounted in `index.ts`.

## Key Patterns

### Multi-Tenant Hierarchy
```
Partner (MSP) → Organization (Customer) → Site (Location) → Device Group → Device
```

### Tenant Isolation / RLS (READ BEFORE ADDING TABLES)
Full contract, the six tenancy shapes, and the cascade/export registration table: **`docs/agents/tenancy-rls.md`**. The rules that bite:

- API connects as unprivileged `breeze_app`. Every tenant-scoped table has RLS enabled + forced + policies **in the same migration that creates it**. No app-layer-only fallback.
- **DB context helpers** (`apps/api/src/db/index.ts`): `withDbAccessContext` on the request path; `withSystemDbAccessContext` for background/seeds (call `runOutsideDbContext` first if inside a request). Bare pool in request code is forbidden.
- Every composite FK referencing an `org_id` column is `DEFERRABLE INITIALLY IMMEDIATE` (org merge defers constraints).
- **A new `org_id` table is not done until it is registered** in `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts`, and `CORE_TENANT_EXPORT_POLICY` — plus the device/ticket lists when it has those columns. RLS coverage does not imply cascade coverage. Code review caught this 0/5 times; contract tests 5/5. Grep, don't judge.
- **Adding a column** to an org-cascade table needs an export-policy classification; any `json`/`jsonb`/`bytea` column is `excludedOpen`.
- The org-cascade and export-policy suites fail only under **Integration Tests**, never Test API. A stacked PR (base ≠ main) runs no CI: `gh workflow run CI --ref <branch>`.

### Partner-Wide First (config/policy tables) — epic #2135
New config-ish tables (policies, templates, rules, windows, baselines) default to `org_id` XOR `partner_id`; `org_id NOT NULL` needs a stated justification in the PR. Org-first designs have needed painful retrofits every time (#1724, #2126–#2129). The 7-step playbook (migration, write gate `canManagePartnerWidePolicies`, SELECT-only partner read branch, config-policy linkage, worker fan-out by device org's partner, tests + UI, repo-wide `<table>.orgId` sweep) is in `docs/agents/tenancy-rls.md`.

### File Size Guideline
Aim for files under ~500 lines, by judgment, not as a hard rule. Declarative files (`aiTools*.ts`, schemas) can run longer. Follow the `aiTools*.ts` pattern: a thin hub file plus per-domain files. Split route files by resource and services by domain. Do not proactively split working files just to meet a count.

### URL State in Components
Use `window.location.hash` for transient UI state (selected tab, selected list item) — see `DeviceDetails.tsx`, `OrganizationsPage.tsx`. Not query params.

### No Internal Infrastructure Details in Public Code
Never commit IPs, hostnames, regions, droplet addresses, or internal domain mappings. Real values go in gitignored `.env`; `.env.example` uses generic placeholders. `internal/` is gitignored and safe for infra notes.

### Web Mutation Handlers — `runAction`
POST/PUT/PATCH/DELETE handlers wrap the request in `runAction` (`apps/web/src/lib/runAction.ts`), which toasts outcomes and treats HTTP-200 `{success:false}` bodies as failures. Caller catch pattern:
```ts
if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
if (!(err instanceof ActionError)) showToast({ type: 'error', ... }); // ActionError already toasted
```
Guarded by `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`; exceptions live in `runActionAllowlist.ts`.

### Settings — one concept, one home
A setting is edited in one place per level, lives with its domain, and resolves partner default → org override → snapshot on the document. Full nine rules: `docs/agents/settings.md`. **Rule 9:** a PR that adds a setting states its home, level, resolver, and the count of places the concept is configured before and after (PR template checkbox). Nav registration enforced by `settingsPageRegistry.test.ts`.

### Schema Migration Workflow
Hand-written SQL in `apps/api/migrations/` — never `drizzle-kit generate`/`push`. **Read `apps/api/migrations/README.md` before writing one.** The rules that bite:
- Name it to sort **after the newest committed migration** — check, don't assume today's date (shipped names run ahead of real time). Prefer `YYYY-MM-DD-HHMMSS-<slug>.sql`. `2026-08-06` is a closed block.
- Idempotent; no inner `BEGIN;`/`COMMIT;`; never edit or rename a shipped migration.
- Any file that writes rows elects system scope first: `SELECT set_config('breeze.scope', 'system', true);` — otherwise writes silently match zero rows under forced RLS (`migrationRlsScope.test.ts`).
- Then `pnpm db:check-drift`.

---

## Working Style

### Design decisions
- Choose the design that is best long-term, not fastest to implement.
- For consequential, hard-to-reverse choices (new tables/tenancy shapes, cross-module contracts, public API surface), convene an advisor quorum: form your own position, get an independent `codex exec` opinion at `xhigh` (read-only). Agree → proceed. Disagree → resolve on the merits or surface it to the user with a recommendation.

### When to ask vs. proceed
- **Proceed** on reversible decisions inside the task's scope (naming, layout, test structure, choosing among repo patterns); note the default in one line.
- **Ask first** for destructive or hard-to-reverse actions (data deletion, force-push, prod changes, closing issues/PRs, external comms), real scope changes, and product/UX calls with no precedent. Design-*quality* questions go to the advisor quorum, not the user.
- Never block long-running work on a question: take the conservative default, keep going, batch open questions at the end.
- When asking: bold one-sentence question first, options as short labeled bullets with pros/cons, then **Recommend X** — one-line why.

### Verbosity
Lead with the outcome. Detail belongs in PR descriptions and commits; chat gets what changed, what's risky, what needs input. One status line per milestone during long work.

### Efficient coding & review
Match rigor to blast radius: full ceremony for tenancy/RLS, auth, migrations, billing, agent-shipped code; implement + typecheck + targeted tests for mechanical work. Run targeted tests while developing, full + contract suites before PR (always when tenancy/cascade code was touched). At most one independent review round.

### Subagents & main-context preservation
Delegate exploration, large reads, log/test-output inspection, and reviews; keep the main context for decisions. Subagent prompts are self-contained (paths, question, return shape). **Never take a subagent's "done" at face value** — verify the commit exists, the tests ran, and it's on the right branch. Checkpoint-commit on long runs.

## Feature Lifecycle Tracking (multi-wave features)
Multi-wave features are tracked on GitHub (parent issue labeled `feature`, `wave` sub-issues) via the `feature-lifecycle` MCP server and skill; GitHub state is the source of truth, not the plan doc. After `writing-plans` finishes a multi-wave plan: `register_feature` and add `tracking_issue:` to its frontmatter. Starting a wave: `get_feature_status`, branch `feature/<parent#>-<slug>/wave-<subissue#>`, `start_wave`. PR bodies carry `Closes #<sub-issue>`.

## Testing
Vitest (API, web, shared), Go `testing` (`go test -race ./...`), Playwright E2E (`data-testid` only). Tests sit alongside source. CI jobs `test-api`, `test-web`, `test-agent` and the 8-shard `integration-test` all block PRs. `pnpm test` does **not** run the RLS/integration contract suites. Scoped-run traps (never `pnpm --filter <pkg> test -- --run <path>`; vitest path filters are substring matches), contract-suite commands and CI job map: **`docs/agents/testing.md`**.

## Development Commands
```bash
pnpm install && pnpm dev
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
pnpm db:migrate | db:seed | db:check-drift | db:studio
cd agent && make run
```
Node is pinned to 22.23.2 (`.nvmrc`). No root typecheck script — typecheck runs via turbo/CI.

**Tear down what you bring up** (`pnpm wt-stack down`, `pnpm test-stack down`, compose `down -v`) and say what you left running — see `docs/agents/local-stacks.md`. Deleting a config file? Sweep compose bind mounts in the same PR (`composeBindMounts.test.ts`).

## PR Merge & Deploy
- Merge with `gh pr merge <N>` — the merge queue owns strategy. **Never `--admin`** except a declared emergency, followed by `gh workflow run CI --ref main`.
- A production deploy updates `BREEZE_VERSION`, pulls/ups the named services, prunes images, then **asserts version parity across every running service** (the service list goes stale). Required env vars and the full runbook: `docs/agents/merge-and-deploy.md`.
- Watchtower must never auto-update `breeze-api`/`breeze-web` (`scripts/security/check-supply-chain-hardening.sh`).
