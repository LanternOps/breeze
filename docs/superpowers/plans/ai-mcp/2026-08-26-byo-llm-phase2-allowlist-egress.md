---
tracking_issue: LanternOps/breeze#3922
---

# Hosted BYO-LLM Phase 2: Approved-Provider Allowlist + Egress Controls — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let hosted partners route their AI traffic to platform-vetted third-party LLM endpoints (OpenRouter, LiteLLM, vLLM — Anthropic-compatible `/v1/messages` surfaces) selected from a platform-maintained allowlist, with mandatory SSRF/egress controls, per-partner egress audit, and correct cost tracking.

**Architecture:** Phase 2 extends only the Anthropic-dialect path (Agent SDK subprocess via `ANTHROPIC_BASE_URL`; one-shot `Anthropic` clients via `baseURL`) — the chat-only `openaiCompatibleProvider` stays self-host-only dead code. Endpoints live in an immutable-revision catalog (`llm_provider_catalog` → `llm_provider_catalog_revisions` → `llm_provider_verifications`); partners reference a catalog entry by FK and never store or supply a URL. The SDK subprocess's egress is forced through a local allowlisting CONNECT proxy that dials only pre-validated pinned IPs; one-shot clients use a guarded fetch built on `urlSafety.ts`. Waves are ordered so all egress enforcement exists **before** any partner can select an endpoint.

**Tech Stack:** Hono, Drizzle, Postgres (hand-written SQL migrations), `@anthropic-ai/sdk`, `@anthropic-ai/claude-agent-sdk`, Node `http`/`net` (CONNECT proxy), existing `services/urlSafety.ts`.

**Advisor quorum (2026-08-26, codex gpt-5.6-sol xhigh, read-only):** agreed Anthropic-dialect-only vehicle and DB-backed catalog; required (all folded in): immutable catalog *revisions* carrying `base_url`/`auth_mode`/model-map/pricing; session-rotation snapshots must include revision id and resolved model; SDK-child egress must be a resolve-and-pin CONNECT proxy (per-turn DNS preflight alone does not meet the issue's rebinding-pinning requirement); egress events per request/CONNECT (not per session) with `org_id` + full cascade registration; catalog pricing must ignore SDK-reported `total_cost_usd`; fidelity gate = verification records keyed by (revision, model, harness version), not a writable timestamp; waves reordered egress-before-selection; metered capability shape.

## Global Constraints

- **Owner decisions (2026-08-23, #3922 — do not re-litigate):** approved-provider ALLOWLIST, never free-form URLs; private-network blocking, DNS-rebinding pinning, redirect discipline, and per-partner egress audit are REQUIRED; the #1412 hosted `ANTHROPIC_BASE_URL` fail-closed guard for the *platform* path stays intact (`apps/api/src/config/validate.ts:932-967`, `streamingSessionManager.ts:131-147`).
- **Partners never supply or store a URL.** `partner_llm_configs.base_url` keeps its `CHECK (base_url IS NULL)` permanently; endpoint URLs are joined from the catalog's active revision at resolve time.
- **Fail loud, never fall back to the platform key** (phase-1 invariant, unchanged). Delisted entry / missing verified revision / proxy failure → `ai_unavailable`, never platform-key traffic.
- **Migration naming:** the repo's shipped migrations are named ahead of real time (newest committed as of planning: `2026-09-11-d-webhook-delivery-recovery.sql`). Name every new migration to sort AFTER the newest committed migration **at execution time** — re-check `ls apps/api/migrations | tail` before creating each file. Names below assume the `2026-09-11-d` ceiling; bump them if the ceiling moved. Never touch the closed `2026-08-06` block. Idempotent SQL only; no inner `BEGIN/COMMIT`.
- **Registration contracts:** platform-global tables (`llm_provider_catalog`, `llm_provider_catalog_revisions`, `llm_provider_verifications`) → `INTENTIONAL_UNSCOPED` in `rls-coverage.integration.test.ts` with a justification comment (precedent: `third_party_package_catalog`, line ~90). `llm_egress_events` has `org_id` → RLS shape 1 (auto-discovered) + `CORE_ORG_CASCADE_DELETE_ORDER` (alphabetical, children before parents) + every column classified in `CORE_TENANT_EXPORT_POLICY`. New columns on `ai_sessions` → export-policy classification in the same PR.
- **Tests:** unit suites run in **Test API**; RLS/cascade/export suites only run under **Integration Tests** and need a live DB — run `vitest.config.rls.ts` + `vitest.integration.config.ts` locally before each wave's PR. Scoped runs: `cd apps/api && npx vitest run <path>` (never `pnpm --filter @breeze/api test -- --run <path>` — the `--` breaks scoping).
- **Stacked-PR trap:** each wave PR must target `main` (a PR based on a sibling branch runs NO CI).
- All Web mutations via `runAction`; admin UI text through the i18n locale files like the surrounding code.

## Wave map (each independently shippable; partner-facing surface only in W3/W4)

| Wave | Contents | Partner-visible? |
|---|---|---|
| 1 | Catalog schema trio + immutability trigger + platform-admin CRUD + fidelity harness + admin UI | No |
| 2 | Egress layer: guarded one-shot fetch, CONNECT proxy, `llm_egress_events` + registrations, catalog pricing plumbing | No (dead code until W3) |
| 3 | Resolver + `partner_llm_configs.catalog_entry_id` + selection API (MFA + probe + consent) + rotation snapshot + fail-closed delisting + `LLM_PROVIDER_CATALOG_ENABLED` flag | API only |
| 4 | Partner UI (endpoint selector, data-note consent, provenance), docs, release notes | Yes |

Track via feature-lifecycle: parent #3922, one wave sub-issue per row; branch `feature/3922-<slug>/wave-<subissue#>`; PR bodies `Closes #<sub-issue>`.

---

## Wave 1 — Catalog foundations (platform-admin only)

### Task 1.1: Migration + Drizzle schema for the catalog trio

**Files:**
- Create: `apps/api/migrations/2026-09-12-llm-provider-catalog.sql`
- Create: `apps/api/src/db/schema/llmProviderCatalog.ts`
- Modify: `apps/api/src/db/schema/index.ts` (add `export * from './llmProviderCatalog'`)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (`INTENTIONAL_UNSCOPED` + comments)

**Interfaces (produces):** Drizzle tables `llmProviderCatalog`, `llmProviderCatalogRevisions`, `llmProviderVerifications`; TS types `LlmProviderModelMapEntry`, `LlmProviderModelMap`.

- [ ] **Step 1: Write the migration**

```sql
-- Phase 2 of per-partner LLM BYOK (#3922): platform-maintained catalog of
-- vetted Anthropic-compatible endpoints. Revisions are IMMUTABLE — routing a
-- partner's key to a new URL always means a new revision + fresh verification.

CREATE TABLE IF NOT EXISTS llm_provider_catalog (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               text NOT NULL,
  name               text NOT NULL,
  status             text NOT NULL DEFAULT 'draft',
  active_revision_id uuid,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT llm_provider_catalog_slug_uq UNIQUE (slug),
  CONSTRAINT llm_provider_catalog_status_chk CHECK (status IN ('draft', 'listed', 'delisted'))
);

CREATE TABLE IF NOT EXISTS llm_provider_catalog_revisions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_entry_id uuid NOT NULL REFERENCES llm_provider_catalog(id) ON DELETE CASCADE,
  revision         integer NOT NULL,
  base_url         text NOT NULL,
  auth_mode        text NOT NULL,
  model_map        jsonb NOT NULL,
  data_note        text,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT llm_provider_catalog_revisions_uq UNIQUE (catalog_entry_id, revision),
  CONSTRAINT llm_provider_catalog_revisions_auth_chk CHECK (auth_mode IN ('x-api-key', 'bearer')),
  CONSTRAINT llm_provider_catalog_revisions_url_chk CHECK (base_url ~ '^https://')
);

DO $$ BEGIN
  ALTER TABLE llm_provider_catalog
    ADD CONSTRAINT llm_provider_catalog_active_rev_fk
    FOREIGN KEY (active_revision_id) REFERENCES llm_provider_catalog_revisions(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS llm_provider_verifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id     uuid NOT NULL REFERENCES llm_provider_catalog_revisions(id) ON DELETE CASCADE,
  model_id        text NOT NULL,
  harness_version text NOT NULL,
  passed          boolean NOT NULL,
  detail          jsonb,
  verified_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS llm_provider_verifications_rev_idx
  ON llm_provider_verifications(revision_id, model_id, created_at DESC);

-- Immutability: revisions can be inserted and cascade-deleted, never updated.
CREATE OR REPLACE FUNCTION llm_provider_catalog_revisions_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'llm_provider_catalog_revisions rows are immutable — create a new revision';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS llm_provider_catalog_revisions_no_update ON llm_provider_catalog_revisions;
CREATE TRIGGER llm_provider_catalog_revisions_no_update
  BEFORE UPDATE ON llm_provider_catalog_revisions
  FOR EACH ROW EXECUTE FUNCTION llm_provider_catalog_revisions_immutable();

-- Platform-global tables: RLS enabled+forced with a system-only policy so an
-- org/partner-scoped context can read them only through system-context service
-- code, mirroring third_party_package_catalog's posture. Check how
-- third_party_package_catalog's migration does this and mirror it EXACTLY
-- (policy shape + grants); if it instead relies on route-layer gating with
-- permissive RLS, mirror that and say so in the PR body.
```

Before finalizing the RLS block: `grep -n 'third_party_package_catalog' apps/api/migrations/*.sql` and copy that table's exact RLS/grant posture for all three tables.

- [ ] **Step 2: Drizzle schema**

```ts
// apps/api/src/db/schema/llmProviderCatalog.ts
import { boolean, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, index } from 'drizzle-orm/pg-core';
import { users } from './users';

/** Prices are integer cents per million tokens, matching MODEL_PRICING units. */
export interface LlmProviderModelMapEntry {
  providerModel: string;          // the id sent to the endpoint (e.g. 'anthropic/claude-sonnet-4-6' on OpenRouter)
  inputCentsPerM: number;
  outputCentsPerM: number;
  cacheReadCentsPerM: number;
  cacheWriteCentsPerM: number;
}
/** Keyed by OFFERABLE_AI_MODELS logical ids. Only mapped models are selectable. */
export type LlmProviderModelMap = Record<string, LlmProviderModelMapEntry>;

export const llmProviderCatalog = pgTable('llm_provider_catalog', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  status: text('status', { enum: ['draft', 'listed', 'delisted'] }).notNull().default('draft'),
  activeRevisionId: uuid('active_revision_id'),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('llm_provider_catalog_slug_uq').on(t.slug)]);

export const llmProviderCatalogRevisions = pgTable('llm_provider_catalog_revisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  catalogEntryId: uuid('catalog_entry_id').notNull().references(() => llmProviderCatalog.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  baseUrl: text('base_url').notNull(),
  authMode: text('auth_mode', { enum: ['x-api-key', 'bearer'] }).notNull(),
  modelMap: jsonb('model_map').$type<LlmProviderModelMap>().notNull(),
  dataNote: text('data_note'),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('llm_provider_catalog_revisions_uq').on(t.catalogEntryId, t.revision)]);

export const llmProviderVerifications = pgTable('llm_provider_verifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  revisionId: uuid('revision_id').notNull().references(() => llmProviderCatalogRevisions.id, { onDelete: 'cascade' }),
  modelId: text('model_id').notNull(),
  harnessVersion: text('harness_version').notNull(),
  passed: boolean('passed').notNull(),
  detail: jsonb('detail').$type<Record<string, unknown>>(),
  verifiedBy: uuid('verified_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('llm_provider_verifications_rev_idx').on(t.revisionId, t.modelId, t.createdAt)]);
```

- [ ] **Step 3:** Add all three table names to `INTENTIONAL_UNSCOPED` in `rls-coverage.integration.test.ts`, each with a one-line comment mirroring the `third_party_package_catalog` entry ("System-wide curated catalog of vetted LLM endpoints; writes gated by platform-admin role + MFA at the route layer").
- [ ] **Step 4:** `pnpm db:migrate && pnpm db:check-drift` — both clean. Run the RLS coverage suite (`cd apps/api && npx vitest run --config vitest.config.rls.ts src/__tests__/integration/rls-coverage`) against the local DB — green.
- [ ] **Step 5:** Commit `feat(api): llm provider catalog schema (immutable revisions + verifications) (#3922 W1)`.

### Task 1.2: Catalog service with cached reads

**Files:**
- Create: `apps/api/src/services/llmProviderCatalog.ts`
- Test: `apps/api/src/services/llmProviderCatalog.test.ts`

**Interfaces (produces):**

```ts
export interface ListedProvider {
  entryId: string; slug: string; name: string;
  revisionId: string; revision: number; baseUrl: string;
  authMode: 'x-api-key' | 'bearer';
  modelMap: LlmProviderModelMap; dataNote: string | null;
  verifiedModels: string[];       // model ids with a passing record for THIS revision at CURRENT_HARNESS_VERSION
}
export const CURRENT_HARNESS_VERSION = '1';
export async function getListedProviders(): Promise<ListedProvider[]>;          // cached, listed + active revision only
export async function getListedProviderByEntryId(entryId: string): Promise<ListedProvider | null>;
export function invalidateLlmProviderCatalogCache(): void;
export async function createCatalogEntry(input: { slug: string; name: string; notes?: string }): Promise<{ id: string }>;
export async function createRevision(input: { entryId: string; baseUrl: string; authMode: 'x-api-key'|'bearer'; modelMap: LlmProviderModelMap; dataNote?: string; createdBy: string }): Promise<{ id: string; revision: number }>;
export async function activateRevision(input: { entryId: string; revisionId: string }): Promise<void>; // throws unless every modelMap model has a passing verification at CURRENT_HARNESS_VERSION for that revision
export async function setEntryStatus(input: { entryId: string; status: 'draft'|'listed'|'delisted' }): Promise<void>; // 'listed' requires an active verified revision
export async function recordVerification(input: { revisionId: string; modelId: string; passed: boolean; detail?: Record<string, unknown>; verifiedBy: string }): Promise<void>;
```

Rules enforced in the service (each is a test): a revision's `revision` number = max(existing)+1 per entry; `activateRevision` refuses when any `modelMap` key lacks a passing `llm_provider_verifications` row for `(revisionId, modelId, CURRENT_HARNESS_VERSION)`; `setEntryStatus('listed')` refuses when `active_revision_id IS NULL`; every mutation calls `invalidateLlmProviderCatalogCache()`; `modelMap` keys must be a subset of `OFFERABLE_AI_MODELS` (import from `aiCostTracker`); `baseUrl` must parse as `https:` URL with no path beyond an optional prefix, no query, no fragment, no embedded credentials. All reads/writes run under system DB context via the established pattern in `services/` (copy how `thirdPartyCatalog`'s service does it).

- [ ] **Step 1:** Write failing tests first (Drizzle mock pattern per the `breeze-testing` skill; assert compiled SQL via PgDialect where a WHERE clause matters — see the vacuous-assertion trap). Cover: activation blocked without verification; activation succeeds with passing records; listing blocked without active revision; cache invalidated on mutation (spy); modelMap key outside `OFFERABLE_AI_MODELS` rejected; `http://` baseUrl rejected; baseUrl with `?query`, `#fragment`, or `user:pass@` rejected.
- [ ] **Step 2:** Run to verify failure, implement, run to green: `cd apps/api && npx vitest run src/services/llmProviderCatalog.test.ts`.
- [ ] **Step 3:** Commit `feat(api): llm provider catalog service with verification-gated activation`.

### Task 1.3: Platform-admin CRUD routes

**Files:**
- Create: `apps/api/src/routes/admin/llmProviderCatalog.ts`
- Modify: `apps/api/src/routes/admin/index.ts` (mount under the existing `adminRoutes.use('*', platformAdminMiddleware)` umbrella)
- Test: `apps/api/src/routes/admin/llmProviderCatalog.test.ts`

Model on `routes/thirdPartyCatalog/operations.ts`: reads under `platformAdminMiddleware` (inherited from `admin/index.ts`); a mutations sub-router additionally `use('*', requireMfa())`. Routes: `GET /` (all entries + revisions + verification summaries), `POST /` (createCatalogEntry), `POST /:entryId/revisions` (createRevision), `POST /:entryId/activate` (activateRevision), `PATCH /:entryId/status` (setEntryStatus), `POST /revisions/:revisionId/verify` (runs the Task 1.4 harness against the revision and records the result — accepts `{ modelId, apiKey }` where `apiKey` is a platform-supplied test key for that endpoint, used transiently, never stored). Zod-validate everything; `modelMap` via a zod record schema mirroring `LlmProviderModelMapEntry` (all four prices `z.number().int().min(0)`).

- [ ] **Step 1:** Failing route tests (Hono test client + mocked service): MFA enforced on every mutation; non-platform-admin 403; happy paths call the service with parsed input; verify route never echoes `apiKey`.
- [ ] **Step 2:** Implement, green, commit `feat(api): platform-admin CRUD for llm provider catalog`.

### Task 1.4: Tool-call fidelity harness

**Files:**
- Create: `apps/api/src/services/llm/providerFidelityHarness.ts`
- Create: `apps/api/src/services/llm/__scripts__/provider-fidelity-smoke.ts` (CLI wrapper, pattern: `__scripts__/openai-smoke.ts`)
- Test: `apps/api/src/services/llm/providerFidelityHarness.test.ts`

**Interfaces (produces):**

```ts
export interface FidelityCheckInput { baseUrl: string; authMode: 'x-api-key'|'bearer'; providerModel: string; apiKey: string; }
export interface FidelityCheckResult { passed: boolean; steps: Array<{ name: string; ok: boolean; detail?: string }>; harnessVersion: string; }
export async function runFidelityCheck(input: FidelityCheckInput): Promise<FidelityCheckResult>;
```

Two stages, both must pass (quorum P7: exercise BOTH the direct SDK and the real subprocess loop):
1. **Direct SDK round-trip:** construct `new Anthropic({ baseURL, apiKey | authToken per authMode })` (guarded fetch from Task 2.1 once it exists; plain fetch acceptable inside W1 since the harness targets operator-supplied vetted endpoints and runs only from the MFA-gated admin route/CLI) and drive a full `tool_use → tool_result → end_turn` exchange: define one tool `get_weather(city: string)`, send "What's the weather in Berlin? Use the tool.", assert the response contains a `tool_use` block with parseable input, submit a `tool_result`, assert a final text response referencing the result and `stop_reason === 'end_turn'`.
2. **Agent SDK subprocess round-trip:** spawn a minimal `@anthropic-ai/claude-agent-sdk` `query()` session whose child env is built by `buildClaudeSdkChildEnv` with a synthetic catalog-partner `UsableLlmConfig` (W3 extends the builder; until then set `ANTHROPIC_BASE_URL`/key directly in the harness) exposing one MCP-less local tool, and assert the tool executes and a final answer arrives. Skip this stage with `steps: [{name:'sdk_subprocess', ok:false, detail:'skipped'}]` and `passed:false` if the SDK binary is unavailable in the environment — a skipped stage must never produce a passing verification.

The unit test mocks the Anthropic client (stage 1) and asserts: a model that answers without `tool_use` → `passed:false` with the failing step named; malformed tool input JSON → failed step; both stages ok → `passed:true`, `harnessVersion === CURRENT_HARNESS_VERSION`.

- [ ] **Step 1:** Failing tests → implement → green.
- [ ] **Step 2:** Wire `POST /revisions/:revisionId/verify` (Task 1.3) to call `runFidelityCheck` per model and `recordVerification` with the result + `detail: result.steps`.
- [ ] **Step 3:** Commit `feat(api): provider tool-call fidelity harness gating catalog verification`.

### Task 1.5: Admin UI

**Files:**
- Create: `apps/web/src/components/admin/LlmProviderCatalog.tsx` (pattern: `admin/ThirdPartyCatalog.tsx` + `ThirdPartyCatalogEditor.tsx`)
- Modify: the admin page/router that mounts `ThirdPartyCatalog` (find via `grep -rn 'ThirdPartyCatalog' apps/web/src/pages apps/web/src/components`) to add the new panel/nav item
- Modify: `apps/web/src/locales/en/*.json` (namespace the strings where the admin strings live; run the locale-parity check for all locales — tr-TR parity reds any missed key)

Surface: entry list with status badges; create entry; create revision (form: baseUrl, authMode select, per-model pricing/mapping grid seeded from `OFFERABLE_AI_MODELS`, dataNote textarea); "Run verification" per revision-model (prompts for a transient test key, never persisted client-side beyond the request); activate revision (disabled until all mapped models show a passing badge); list/delist. All mutations via `runAction`; `data-testid` attributes on every interactive element (`llm-catalog-*` prefix) for E2E.

- [ ] **Step 1:** Implement; verify in the worktree stack (`worktree-stack` skill) as a platform admin.
- [ ] **Step 2:** Commit `feat(web): platform-admin llm provider catalog UI`, open PR `feat: llm provider catalog foundations (#3922 W1)` with `Closes #<wave-sub-issue>`.

---

## Wave 2 — Egress enforcement layer (dead code until W3 wires it)

### Task 2.1: Guarded fetch adapter for one-shot Anthropic clients

**Files:**
- Create: `apps/api/src/services/llm/guardedLlmFetch.ts`
- Test: `apps/api/src/services/llm/guardedLlmFetch.test.ts`

**Interfaces (produces):**

```ts
/**
 * A fetch implementation for @anthropic-ai/sdk `fetch` option that:
 *  - refuses any URL whose origin !== the pinned allowed origin,
 *  - resolves DNS once via urlSafety and dials only validated public IPs
 *    (connect-time pinning — delegates to safeFetch),
 *  - never follows redirects (3xx is returned to the SDK, which treats it as an error),
 *  - emits one llm_egress_events row per request via the recorder callback.
 */
export function buildGuardedLlmFetch(opts: {
  allowedOrigin: string;                       // e.g. 'https://openrouter.ai'
  recordEgress: (e: { host: string; resolvedIp: string | null }) => void;  // fire-and-forget; must not throw into the call path
}): (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
```

Implementation: normalize the input URL; `new URL(url).origin !== allowedOrigin` → throw `LlmEgressViolationError` (new error class in this file, `{ status: 502, code: 'llm_egress_blocked' }`); otherwise delegate to `safeFetch(urlString, { ...init, redirect: 'error' })` from `services/urlSafety.ts` and invoke `recordEgress` with the host + the resolved IP if `safeFetch` exposes it (check its return/diagnostics; if it doesn't expose the pinned IP, extend `urlSafety.ts` with an optional `onConnect?: (ip: string) => void` hook in `safeFetch`'s options — small, backward-compatible, unit-tested there).

- [ ] **Step 1:** Failing tests: cross-origin URL rejected without any network call (spy on safeFetch); same-origin delegates with `redirect:'error'` preserved even when caller passes `redirect:'follow'`; recorder called with host; recorder throwing does not fail the request.
- [ ] **Step 2:** Implement → green → commit `feat(api): guarded fetch adapter for catalog llm clients`.

### Task 2.2: Local allowlisting CONNECT proxy for the SDK subprocess

**Files:**
- Create: `apps/api/src/services/llm/llmEgressProxy.ts`
- Test: `apps/api/src/services/llm/llmEgressProxy.test.ts` (real sockets on 127.0.0.1, no mocks — this is the security boundary)

**Interfaces (produces):**

```ts
export interface EgressGrant { host: string; port: 443; }  // exactly one host per session
export interface LlmEgressProxy {
  /** Registers a session-scoped grant; returns the proxy URL to place in HTTPS_PROXY, embedding a single-use bearer token. */
  grant(sessionId: string, allowed: EgressGrant, recordEgress: (e: { host: string; resolvedIp: string }) => void): { proxyUrl: string };
  revoke(sessionId: string): void;
  port(): number;
  close(): Promise<void>;
}
export async function startLlmEgressProxy(): Promise<LlmEgressProxy>;   // binds 127.0.0.1:0
export function getLlmEgressProxy(): Promise<LlmEgressProxy>;           // lazy singleton for the API process
```

Behavior (each line is a test):
- Only the `CONNECT` method is served; anything else → 405 and socket destroy.
- `Proxy-Authorization: Basic <token>` must match a live grant; unknown/absent token → 407 + destroy. Token: 32 random bytes base64url, generated per `grant()`, constant-time compared.
- CONNECT target `host:port` must exactly equal the grant's `host:443` (case-insensitive host); anything else → 403 + destroy, and the attempt is recorded: the recorder callback signature is `(e: { host: string; resolvedIp: string | null; blocked: boolean })` — blocked attempts pass `{ host: <attempted>, resolvedIp: null, blocked: true }`.
- On an allowed CONNECT: resolve via `resolveSafeRecords` (import from `urlSafety.ts` — export it there if not already exported; it is module-internal today), pick the first safe record, `net.connect({ host: ip, port: 443 })` (dial the IP, never the hostname — this IS the rebinding pin), reply `200 Connection Established`, pipe both directions, record `{ host, resolvedIp: ip }`. No safe records → 502 + destroy + blocked event.
- `revoke(sessionId)` invalidates the token immediately; an in-flight tunnel is destroyed on revoke.
- The proxy never reads tunneled bytes beyond the CONNECT header (TLS passes through opaque; the child's own TLS validation against the real hostname still applies because the child speaks TLS with SNI/hostname over the tunnel).

Tests use a local TLS echo server on 127.0.0.1 as the "provider", a grant whose host resolves to it via a test-injected resolver (add `__setResolverForTests` mirroring `urlSafety.ts`'s `__setLookupForTests`), and raw `http.request({ method:'CONNECT' })` clients. Cover: wrong token 407; wrong host 403 + blocked event; allowed host tunnels bytes end-to-end; revoke kills the tunnel; private-IP-only resolution → 502.

- [ ] **Step 1:** Failing tests → implement → green (`npx vitest run src/services/llm/llmEgressProxy.test.ts`).
- [ ] **Step 2:** Commit `feat(api): allowlisting resolve-and-pin CONNECT proxy for sdk llm egress`.

### Task 2.3: `llm_egress_events` table + recorder + registrations

**Files:**
- Create: `apps/api/migrations/2026-09-12-b-llm-egress-events.sql` (same-date `-b-` infix orders it after Task 1.1's file if both land the same day; re-check the ceiling)
- Create: `apps/api/src/db/schema/llmEgressEvents.ts`
- Create: `apps/api/src/services/llm/llmEgressRecorder.ts`
- Modify: `apps/api/src/db/schema/index.ts`, `apps/api/src/services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER`, alphabetical), `apps/api/src/services/tenantExportPolicyRegistry.ts` (`CORE_TENANT_EXPORT_POLICY`)
- Test: `apps/api/src/services/llm/llmEgressRecorder.test.ts` + the existing contract suites

Migration:

```sql
CREATE TABLE IF NOT EXISTS llm_egress_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL,
  partner_id       uuid NOT NULL,
  catalog_entry_id uuid REFERENCES llm_provider_catalog(id) ON DELETE SET NULL,
  revision_id      uuid REFERENCES llm_provider_catalog_revisions(id) ON DELETE SET NULL,
  ai_session_id    uuid,
  surface          text NOT NULL,
  host             text NOT NULL,
  resolved_ip      text,
  blocked          boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT llm_egress_events_surface_chk CHECK (surface IN (
    'sdk_session_create', 'sdk_proxy_connect',
    'one_shot_ticket_draft', 'one_shot_email_draft', 'one_shot_catalog_enrichment',
    'one_shot_probe', 'workspace_enrichment'
  )),
  CONSTRAINT llm_egress_events_org_partner_fk
    FOREIGN KEY (org_id, partner_id) REFERENCES organizations(id, partner_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS llm_egress_events_org_idx ON llm_egress_events(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS llm_egress_events_partner_idx ON llm_egress_events(partner_id, created_at DESC);
-- RLS shape 1: enable + force + policy 'system OR breeze_has_org_access(org_id)'
-- (copy the exact policy SQL shape from a recent shape-1 migration).
```

The composite `(org_id, partner_id)` FK is the dual-axis integrity pattern from `users` (quorum P5). Recorder service: `recordLlmEgressEvent(input): void` — fire-and-forget insert under system DB context, errors logged + Sentry'd, never thrown to the caller; a bounded in-process queue (drop-oldest above 1000 pending, warn once) so a DB stall can't back-pressure the LLM call path.

Registrations (the step that gets missed — treat as mechanical):
- [ ] `CORE_ORG_CASCADE_DELETE_ORDER`: insert `'llm_egress_events'` alphabetically; verify FK direction (references `organizations` → must precede it; alphabetical satisfies this — verify, don't assume).
- [ ] `CORE_TENANT_EXPORT_POLICY`: classify every column — `id/org_id/partner_id/catalog_entry_id/revision_id/ai_session_id/surface/host/resolved_ip/blocked/created_at` → `included`. No jsonb/bytea columns → no `excludedOpen`.
- [ ] Run BOTH integration contract suites locally (`tenantCascade.integration.test.ts`, `tenant-export-policy` + roundtrip) — green.
- [ ] Commit `feat(api): per-partner llm egress audit events + cascade/export registration`.

### Task 2.4: Catalog pricing in the cost tracker

**Files:**
- Modify: `apps/api/src/services/aiCostTracker.ts`
- Test: `apps/api/src/services/aiCostTracker.test.ts` (extend the existing suite file if one exists — check first)

**Interfaces (produces):**

```ts
export interface CatalogPricingSnapshot {
  catalogEntryId: string; revisionId: string;
  inputCentsPerM: number; outputCentsPerM: number;
  cacheReadCentsPerM: number; cacheWriteCentsPerM: number;
}
```

Changes:
- `recordUsage` / `recordUsageFromSdkResult` gain an optional `catalogPricing?: CatalogPricingSnapshot`. When present: cost = tokens × snapshot rates (including cache read/write token counts where the SDK result carries them, mirroring the existing cache-rate math at `aiCostTracker.ts:218`), and **the SDK-reported `total_cost_usd` is ignored** even when nonzero (`aiCostTracker.ts:499` currently prefers it — that preference must be bypassed for catalog traffic; the SDK's number reflects Anthropic list pricing, not the provider's).
- `ai_sessions` gains nullable `catalog_entry_id` + `catalog_revision_id` columns (small `ADD COLUMN IF NOT EXISTS` migration `2026-09-12-c-ai-sessions-catalog-provenance.sql`; classify both `included` in the export policy — **new columns on a registered table trip the export-policy contract**).
- `billing_source` semantics unchanged (`partner_key` covers both direct and catalog BYOK; provenance columns distinguish them).

- [ ] **Step 1:** Failing tests: catalog snapshot present + SDK `total_cost_usd: 3.5` → cost computed from snapshot, SDK figure ignored (assert exact cents from a fixed token count); cache tokens priced at snapshot cache rates; no snapshot → existing behavior byte-for-byte (regression assertions on the current path).
- [ ] **Step 2:** Implement → green → run export-policy roundtrip suite → commit `feat(api): catalog pricing snapshots override sdk-reported cost`.
- [ ] **Step 3:** Open PR `feat: llm egress enforcement layer (#3922 W2)`.

---

## Wave 3 — Resolver, selection API, rotation (partner-reachable via API only, behind flag)

### Task 3.1: Config flag + partner schema column

**Files:**
- Create: `apps/api/migrations/2026-09-12-d-partner-llm-catalog-selection.sql`
- Modify: `apps/api/src/db/schema/partnerLlmConfigs.ts`, `apps/api/src/config/validate.ts`

Migration: `ALTER TABLE partner_llm_configs ADD COLUMN IF NOT EXISTS catalog_entry_id uuid REFERENCES llm_provider_catalog(id);` — **no** `ON DELETE CASCADE`/`SET NULL`: deleting a catalog entry with partners attached must FAIL (fail-loud; delisting is the supported path). `base_url` CHECK untouched (stays `IS NULL`); `provider` CHECK untouched (`'anthropic'` = dialect marker for both direct and catalog).

`validate.ts`: add `LLM_PROVIDER_CATALOG_ENABLED: z.enum(['true','false']).default('false')` (follow the exact boolean-env idiom used by neighboring flags — grep for an existing `z.enum(['true','false'])` or coerced boolean and mirror it). All selection-write routes and catalog resolution check it; `false` → catalog selection 404s and existing catalog configs resolve as `unavailable` with reason `'catalog_disabled'` (fail-loud, never silent-fallback to direct Anthropic).

- [ ] Migration + schema + drift check + commit.

### Task 3.2: Resolver extension

**Files:**
- Modify: `apps/api/src/services/llm/llmConfigResolver.ts`
- Test: extend `apps/api/src/services/llm/llmConfigResolver.test.ts`

**Interfaces (produces — later tasks consume exactly these):**

```ts
export type ResolvedLlmEndpoint =
  | { kind: 'anthropic' }   // direct api.anthropic.com (phase-1 behavior)
  | { kind: 'catalog'; catalogEntryId: string; revisionId: string; baseUrl: string;
      authMode: 'x-api-key' | 'bearer'; providerModel: string;
      pricing: CatalogPricingSnapshot };

// 'partner' variant gains: endpoint: ResolvedLlmEndpoint
// 'unavailable' reason union gains: 'provider_delisted' | 'catalog_disabled' | 'model_unverified'
```

Resolution for a row with `catalog_entry_id`: flag off → `unavailable('catalog_disabled')`; entry missing/not `listed`/no active revision → `unavailable('provider_delisted')`; partner's effective model (default_model ?? platform default) not in the revision's `modelMap` or lacking a passing verification → `unavailable('model_unverified')`; else `endpoint: { kind:'catalog', ..., providerModel: modelMap[model].providerModel, pricing: <snapshot from modelMap entry> }`. `getAnthropicClientForPartner` builds the catalog client as:

```ts
new Anthropic({
  baseURL: endpoint.baseUrl,
  ...(endpoint.authMode === 'x-api-key'
    ? { apiKey: resolved.apiKey, authToken: null }
    : { authToken: resolved.apiKey, apiKey: null }),
  fetch: buildGuardedLlmFetch({ allowedOrigin: new URL(endpoint.baseUrl).origin, recordEgress }),
})
```

with `recordEgress` wired to `recordLlmEgressEvent` carrying the caller-supplied `surface` (extend `getAnthropicClientForPartner` with a required `surface` parameter; update its three existing call sites — `aiTicketDraft.ts`, `officeAddin/aiEmailDraft.ts`, `catalogEnrichmentService.ts` — plus the probe).

- [ ] **Step 1:** Failing resolver tests for every branch above (Drizzle mocks; the delisting/verification joins asserted via compiled SQL). Regression: rows WITHOUT `catalog_entry_id` resolve byte-identically to today (same pinned `baseURL`, `authToken:null`).
- [ ] **Step 2:** Implement → green → commit `feat(api): resolver support for catalog endpoints (fail-closed on delist/unverified)`.

### Task 3.3: SDK child env + session rotation + proxy wiring

**Files:**
- Modify: `apps/api/src/services/streamingSessionManager.ts`
- Test: extend its existing test file

Changes:
1. `buildClaudeSdkChildEnv(resolved, source)` — for `source==='partner' && endpoint.kind==='catalog'`: set `ANTHROPIC_BASE_URL = endpoint.baseUrl`; set the credential var per `authMode` (`ANTHROPIC_API_KEY` for x-api-key, `ANTHROPIC_AUTH_TOKEN` for bearer — scrub the other); set `HTTPS_PROXY`/`HTTP_PROXY` to the proxy URL passed in (new options argument `{ egressProxyUrl?: string }`), set `NO_PROXY=''` explicitly, and **drop the parent's proxy vars from the allowlist copy for catalog sessions** (`HTTPS_PROXY, HTTP_PROXY, NO_PROXY` + lowercase forms — today's allowlist forwards them, which would let a parent `NO_PROXY=*` bypass the proxy; quorum P4). Direct-Anthropic partner sessions and platform sessions: behavior unchanged (assert byte-identical env in tests).
2. Session create for a catalog endpoint: `getLlmEgressProxy()` → `grant(sessionId, { host: new URL(baseUrl).hostname, port: 443 }, recorder)` → pass `proxyUrl` into the env builder; record one `sdk_session_create` egress event. `remove()`/session teardown → `revoke(sessionId)`.
3. `LlmConfigSnapshot` gains `revisionId?: string` and `providerModel?: string`; `llmConfigSnapshotsMatch` compares them; the per-turn preflight therefore rotates idle sessions on catalog revision change or delisting exactly as it does on key rotation today (delisting resolves to `unavailable` → the turn 503s — assert this path).

- [ ] **Step 1:** Failing env-builder tests: catalog session env contains proxy vars + base URL + correct credential var and NOT the parent's `NO_PROXY`; bearer mode sets `ANTHROPIC_AUTH_TOKEN` and scrubs `ANTHROPIC_API_KEY`; platform/direct-partner env unchanged (snapshot equality against pre-change fixtures).
- [ ] **Step 2:** Rotation tests: idle session + bumped revision → rotated (mirror the existing config_version rotation test); processing session → deferred.
- [ ] **Step 3:** Implement → green → commit `feat(api): catalog sdk sessions egress via pinned proxy + revision-aware rotation`.

### Task 3.4: Selection API + probe

**Files:**
- Modify: `apps/api/src/routes/aiProvider.ts`, `apps/api/src/services/partnerLlmConfig.ts`
- Test: extend both test files

Routes:
- `GET /` additionally returns `catalog: Array<{ entryId, slug, name, dataNote, models: string[] }>` (from `getListedProviders()`, models = verified ∩ modelMap keys; empty array when flag off) and the current `catalogEntryId`.
- `POST /endpoint` — `BILLING_MANAGE` + `canManagePartnerWidePolicies` + `requireMfa()` + flag on. Body `{ catalogEntryId: string | null, acknowledgeDataNote?: boolean }`. `null` → back to direct Anthropic. Non-null requires `acknowledgeDataNote === true` when the active revision has a `dataNote` (consent — quorum risk 3), a listed entry, and a **probe against the selected endpoint through the guarded client** (`probeAnthropicKey` gains an `endpoint: ResolvedLlmEndpoint` parameter; probe surface `'one_shot_probe'`). Probe failure → typed 4xx/503 per phase-1 semantics, nothing persisted. Success → set `catalog_entry_id`, bump `config_version` (drives next-turn session rotation), audit `ai_provider.endpoint_changed` with entry slug + revision (never the key).
- `POST /key` unchanged except the probe now targets the currently-selected endpoint.

- [ ] **Step 1:** Failing tests: MFA on `/endpoint`; consent required when dataNote present; delisted entry 409; probe failure persists nothing; version bumped on success; flag off → 404; org-scoped token 403.
- [ ] **Step 2:** Implement → green.
- [ ] **Step 3:** New integration suite `apps/api/src/__tests__/integration/llmCatalogSelection.integration.test.ts` (runs in the Integration Tests job — verify it RUNS in the shard log, placement trap): real Postgres; forge cross-partner selection (expect 42501 via RLS on `partner_llm_configs`); delist-after-select → resolver returns `unavailable('provider_delisted')`; catalog tables reject `breeze_app` writes without system context per their W1 posture.
- [ ] **Step 4:** Commit + PR `feat: partner catalog endpoint selection (#3922 W3)`.

---

## Wave 4 — Partner UI + docs

### Task 4.1: Partner-facing UI

**Files:**
- Modify: `apps/web/src/components/settings/PartnerAiProviderTab.tsx`, `apps/web/src/locales/en/settings.json` (+ locale parity)

When the GET payload carries a non-empty `catalog`: an "Endpoint" card above the key card — radio list: "Anthropic (direct)" + one row per catalog entry (name + verified models + expandable dataNote). Selecting a non-direct entry opens a confirm dialog quoting the dataNote verbatim with an explicit checkbox ("I understand my AI traffic and content will be processed by <name>") that drives `acknowledgeDataNote`; submit via `runAction` → `POST /ai/provider/endpoint`. Error banner already handles `status='error'`; extend the unavailable-reason display for `provider_delisted` ("This endpoint was delisted by Breeze — AI is paused until you choose another") and `model_unverified`. `AiUsagePage`: when session provenance carries a catalog entry, the existing "billed to your key" note names the endpoint.

- [ ] Implement; E2E via worktree stack: list entry as admin → select as partner (consent flow) → chat turn goes through proxy (assert an `sdk_proxy_connect` egress row) → delist as admin → next turn 503s with the delisted banner → select direct → restored. Use `data-testid` selectors only.
- [ ] Commit `feat(web): partner endpoint selection with consent + delist surfacing`.

### Task 4.2: Docs + release notes

- Extend the "Bringing your own LLM" docs page (`update-breeze-docs` skill): hosted endpoint selection, the allowlist model ("Breeze vets endpoints; you choose from the list"), consent/data-note meaning, delisting behavior, and the self-host env matrix cross-reference. Release-notes entry via `update-breeze-release-notes` when the release ships.
- [ ] PR `feat: byo-llm phase 2 partner UI + docs (#3922 W4)`.

---

## Deferred / follow-ups (file as issues at W4, do not build now)

1. **Two-person activation approval** for catalog revisions (quorum risk 1). Blocked on reality: production currently has zero platform admins (see ops memory) — a four-eyes rule would make the catalog unusable. Immutable revisions + MFA + audit + verification-gated activation are the phase-2 mitigation; file the four-eyes upgrade as `status:considering`.
2. **Egress-event aggregation/retention** if volume becomes material (per-CONNECT rows).
3. **Guarded fetch for `openaiCompatibleProvider.ts`** (raw `fetch` today) — bundled cleanup, can ride any wave: swap `fetch(` at `openaiCompatibleProvider.ts:86` for `safeFetch` with `redirect:'error'`. It's self-host-only dead code on hosted, so it is not a phase-2 blocker.
4. **Atomic budget reservation** for concurrent turns (quorum risk 2) — today's check-then-spend overshoot window predates phase 2 and is bounded by org budgets; not expanded by this work.

## Self-review notes

- Spec coverage: allowlist (W1), private-network blocking + DNS pinning (W2 proxy + guarded fetch), redirect discipline (guarded fetch `redirect:'error'`; proxy tunnels TLS so the child's SDK sees 3xx as errors — the fidelity harness proves behavior per provider), egress audit (W2 events, per-request/per-CONNECT), #1412 untouched (asserted by W3 env-builder regression tests), fidelity matrix (W1 harness + verification records), pricing overrides (W2), schema-ready relaxation (W3 column, CHECKs untouched).
- Fail-loud parity with phase 1 held at every new failure mode: `catalog_disabled`, `provider_delisted`, `model_unverified`, proxy grant failure.
- Types consistent: `ResolvedLlmEndpoint`/`CatalogPricingSnapshot`/`ListedProvider` defined once (Tasks 3.2 / 2.4 / 1.2) and consumed by name elsewhere.
