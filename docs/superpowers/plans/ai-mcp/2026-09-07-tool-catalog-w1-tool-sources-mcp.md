---
tracking_issue: LanternOps/breeze#5215
wave: W01 (#5216) — Tool sources (MCP): tables, discovery, catalog resolver, chat + MCP bridge, Tier-3 via intents, Tool Sources UI (PR A API core, PR B external Tier 3, PR C web)
---

# Tool Catalog — Wave 1: Tool Sources (MCP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A partner (or org) registers an external MCP server with a credential; Breeze discovers its tools, proposes tiers, lets a tech enable them, and the enabled tools appear in AI chat and Breeze's own MCP server with the same tier, permission, rate-limit and approval gating as core tools.

**Architecture:** Two new dual-owned tables (`tool_sources`, `tool_source_tools`) hold registrations and discovered tools; a BullMQ discovery job talks to the MCP server over streamable HTTP through the existing SSRF-guarded `safeFetch`; a **per-auth resolver** (`resolveTenantTools(auth)`) returns immutable **descriptors** (definition + compiled Ajv validator + tier + revision + executor) and is the ONLY way tenant tools enter any surface — they are never registered into the process-global `aiTools` map, `TOOL_TIERS`, or `TOOL_PERMISSIONS`, because the same qualified name can mean different tools for different tenants. Chat gets them via `createBreezeMcpServer(..., extraTools)` (built with the Agent SDK `tool()` from a Zod shape produced by `z.fromJSONSchema`); the HTTP MCP server appends them in `tools/list` and routes dotted-name calls to `executeTenantTool`. Tier 3 external calls in chat go through `createActionIntent` with a new `externalTool` binding (two new `action_intents` columns) so release-time revalidation can detect drift.

**Tech Stack:** TypeScript, Hono, Drizzle, Postgres (forced RLS), BullMQ, Ajv 8, Zod 4.4 (`z.fromJSONSchema`), `@anthropic-ai/claude-agent-sdk` 0.3.x `tool()`/`createSdkMcpServer`, Vitest, React + Astro + react-i18next (8 locales).

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-07-tool-catalog-and-flows-design.md` §5 (tool sources), §8 (obligations), §9 (testing), §10 W1 row. **This plan amends the spec (Task A0)** with four as-built findings: (1) the qualified-name separator is `__` (double underscore), not `.` — the Anthropic tool-name grammar `^[a-zA-Z0-9_-]{1,64}$` rejects dots and `mcp__<server>__<tool>` is already the ecosystem's namespacing idiom; (2) chat's tool list is NOT built from `getToolDefinitions()` — it is the hand-written `tool()` array in `aiAgentSdkTools.ts:createBreezeMcpServer`, so tenant tools enter chat via that function's existing `extraTools` parameter and a session-held descriptor map, and the four "closed-set" seams in spec §5.6 reduce to two (chat `createSessionPreToolUse` and `mcpServer.ts` list/call); `aiGuardrails.ts` and `mcpExecutionOrg.ts` are untouched because tenant tools never reach their name-global lookups; (3) org-scoped RLS contexts cannot read partner-wide rows through the dual-axis policy alone (`breeze_has_partner_access` is false for org tokens), and main's Partner-Wide First step 3 now forbids the system-context escalation for plain org-XOR-partner config tables — so both tables carry the sanctioned additive `FOR SELECT`-only policy `<table>_partner_wide_select USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id())` (template `apps/api/migrations/2026-10-05-110000-config-policy-partner-wide-select.sql`), the resolver runs inside the caller's own RLS context, and org admins see inherited partner-wide sources read-only in the management UI (writes stay gated by `canManagePartnerWidePolicies` and the unchanged `FOR ALL` policy); (4) v1 has no descriptor cache — one indexed query per session start / per MCP call is cheaper than a cross-replica invalidation story (the extension registry made the same call, `aiTools.ts:498-507`).

## Global Constraints

- Tests: `cd apps/api && npx vitest run <path>`; shared: `cd packages/shared && npx vitest run <path>`; web: `cd apps/web && npx vitest run <path>` plus `src/lib/i18n/localeParity.test.ts`, `src/lib/i18n/translationCoverage.test.ts`, `src/lib/__tests__/no-silent-mutations.test.ts`. Add `--pool=threads --maxWorkers=2` when a dev stack is running; a 0-test run is a stall, not green. Typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`; web `cd apps/web && npx astro check`. `pnpm lint` in every touched package. Integration suites: `cd apps/api && pnpm test:integration -- <no paths>` runs everything (a path filter after `--` runs the WHOLE suite anyway — see memory); to scope, run `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/toolSourcesPartnerRls.integration.test.ts` with `DATABASE_URL` set to a real Postgres.
- **Migrations (two, dependent):** `apps/api/migrations/2026-10-14-100000-tool-sources.sql` (PR A) and `apps/api/migrations/2026-10-14-100100-action-intents-external-tool.sql` (PR B). Both must sort after the newest committed file on **origin/main** — `2026-10-13-110000-scripts-security-acknowledgement.sql` as of 2026-09-07 (the naming ratchet is ~5 weeks ahead of real time; a worktree forked from a stale local main shows an older ceiling — always check `git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -1`). If something newer landed, bump the date and keep the `HHMMSS` ordering. Idempotent (`IF NOT EXISTS`, `DO $$`, `DROP POLICY IF EXISTS` + `CREATE POLICY`); no inner `BEGIN;`/`COMMIT;`; explicit `ON DELETE` on every FK; DML (the permissions inserts) preceded by `SELECT set_config('breeze.scope', 'system', true);` so `migrationRlsScope.test.ts` passes; never edit a shipped migration.
- **Registries (contract tests fail only under Integration Tests):** `tool_sources`, `tool_source_tools` → `DUAL_AXIS_TENANT_TABLES` (`rls-coverage.integration.test.ts:302`) AND `XOR_OWNERSHIP_DUAL_AXIS_TABLES` (same file; its assertion 'every org_id-XOR-partner_id dual-axis table has a breeze_current_partner_id() partner-wide SELECT branch' requires the `_partner_wide_select` policy — never add either table to `PARTNER_WIDE_SELECT_BRANCH_EXEMPT`, which is a shrink-only ratchet), `CORE_ORG_CASCADE_DELETE_ORDER` (`tenantCascade.ts`, between `time_series_metrics` and `topology_layout`, children first: `tool_source_tools` then `tool_sources`), `CORE_TENANT_EXPORT_POLICY` (`tenantExportPolicyRegistry.ts`, every column classified), `orgMergeRegistry.ts` `SPECIAL` (custom executor, Task A3), `encryptedColumnRegistry.ts` (`tool_sources.auth_config_encrypted`, row-bound). PR B adds two columns to `action_intents` → its export-policy entry must list them.
- **Names:** source slug `^[a-z][a-z0-9]{1,23}$` (no underscore, no hyphen — so the first `__` in a qualified name is always the split point); source tool name must match `^[a-zA-Z0-9_-]{1,64}$`; qualified name `<slug>__<name>` ≤ 64 chars; tools violating either are recorded with `enabled=false`, `review_needed=true`, `last_error='name_not_addressable'` and never resolved. Reserved slugs: `mcp`, `breeze`, `core`, `flow`, `ext`, plus every extension id in `extensionContributionRegistry`. Core tool names never contain `__` (assert in Task A6's test).
- **Feature flag:** `TOOL_SOURCES_ENABLED` (boolean env, default false). Off ⇒ routes return 404, chat and MCP resolve zero tenant tools, `/api/v1/config` reports `features.toolSources: false`, the web hides the nav item. Validated at boot in `config/validate.ts` like `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED` (line ~1751).
- **Egress:** every outbound call goes through `services/urlSafety.ts` `safeFetch` (never bare `fetch`); `allowPrivateNetwork` is `envFlag('TOOL_SOURCES_ALLOW_PRIVATE_EGRESS')` and `validate.ts` refuses that flag when `IS_HOSTED=true`. Credentials are attached only when `new URL(target).origin === source.credentialOrigin`.
- **Branches / PRs:** branch `feature/5215-tool-catalog-flows/wave-5216` off `main`. PR A (API core, Tasks A0–A11) targets main → normal CI. PR B (external Tier 3, Tasks B1–B4) and PR C (web, Tasks C1–C6) stack on PR A and get NO CI — dispatch `gh workflow run CI --ref <branch>` before merging each. PR A/B bodies `Part of #5216`; PR C body `Closes #5216`. Merge with bare `gh pr merge <N> --squash` (merge queue on main since 2026-09-07; never `--admin`).
- **Rigor:** high blast radius throughout (tenancy, credentials, auth, approvals). Red test first for every task; the RLS forge suites (Task A11) and `intentService`/`revalidateRelease` tests (PR B) are mandatory before their PRs open.

---

## File Structure

**packages/shared**
- Create `src/types/toolSources.ts` — DTO types (`ToolSourceKind`, `ToolSourceAuthKind`, `ToolSourceStatus`, `ToolSourceDto`, `ToolSourceToolDto`, `ToolTier`).
- Create `src/validators/toolSources.ts` (+ `.test.ts`) — Zod schemas for create/update source, patch tool, bulk enable; slug/name regexes; `qualifiedToolName()`, `splitQualifiedToolName()`.
- Modify `src/constants/permissions.ts` — four new grants.
- Modify `src/types/index.ts` / `src/validators/index.ts` barrels.

**apps/api — data**
- Create `migrations/2026-10-14-100000-tool-sources.sql` — tables, XOR checks, owner-guard trigger, RLS, grants, permissions rows + role grants.
- Create `src/db/schema/toolSources.ts`; modify `src/db/schema/index.ts`.
- Modify `src/services/encryptedColumnRegistry.ts`, `src/services/tenantCascade.ts`, `src/services/tenantExportPolicyRegistry.ts`, `src/services/orgMergeRegistry.ts`, `src/services/orgMergeCustomExecutors.ts`, `src/db/seed.ts`, `src/__tests__/integration/rls-coverage.integration.test.ts`.

**apps/api — services/toolSources/** (one responsibility per file)
- `secrets.ts` — encrypt/decrypt auth config (row-bound AAD), `credentialOriginFor()`, `authHeadersFor()`, `redactSecrets()`.
- `mcpClient.ts` — streamable-HTTP MCP JSON-RPC client over `safeFetch` (`initialize`, `tools/list`, `tools/call`), injectable `fetchImpl`.
- `discovery.ts` — `discoverSource(sourceId)`: list → propose tiers → upsert `tool_source_tools` → revision/removal/review flags → source status.
- `resolver.ts` — `resolveTenantTools(auth)`, `TenantToolDescriptor`, owner predicates, Ajv compile, name rules.
- `execute.ts` — `executeTenantTool(descriptor, input, auth, opts)`: validate → rate limit → MCP call → redact → cap → audit.
- `sdkBridge.ts` — `buildTenantSdkTools(descriptors, getAuth)` and `zodShapeFromJsonSchema()`.
- `guardrails.ts` — `guardrailCheckForTenantTool(descriptor)`, `tenantToolPermissionRequirement(tier)`, `checkTenantToolRateLimit()`.
- `service.ts` — CRUD used by routes (create/update/delete/list/get, `enqueueDiscovery`), owner resolution.
- `jobs/toolSourceDiscoveryWorker.ts` — queue + worker; register in `services/workerRegistry.ts`.

**apps/api — seams modified**
- `src/config/env.ts` (`toolSourcesEnabled()`, `toolSourcesAllowPrivateEgress()`), `src/config/validate.ts`, `src/routes/config.ts`.
- `src/services/streamingSessionManager.ts` (resolve descriptors, `session.tenantTools`, `extraTools`, `allowedTools`).
- `src/services/aiAgentSdk.ts` (`createSessionPreToolUse` tenant branch; `ActiveSession.tenantTools`).
- `src/routes/mcpServer.ts` (`handleToolsList`, `handleToolsCall` tenant branch).
- `src/routes/toolSources.ts` (+ `.test.ts`), `src/index.ts` mount, `src/middleware/selfManagedDbContextRoutes.ts` (test-call route).
- PR B: `migrations/2026-10-14-100100-action-intents-external-tool.sql`, `src/db/schema/actionIntents.ts`, `src/services/actionIntents/intentService.ts`, `src/services/actionIntents/revalidateRelease.ts`, `src/services/aiAgentSdk.ts` (Tier 3 tenant branch), export policy.

**apps/web**
- `src/pages/settings/tool-sources.astro`, `src/pages/settings/tool-sources/[id].astro`.
- `src/components/toolSources/ToolSourcesPage.tsx`, `ToolSourceForm.tsx`, `ToolSourceDetail.tsx`, `DiscoveredToolsTable.tsx`, `ToolTestDrawer.tsx`, `api.ts` (typed fetchers), tests.
- `src/locales/<8 locales>/toolSources.json`; `src/components/layout/Sidebar.tsx` (nav + flag).

**apps/docs**
- `src/content/docs/features/tool-sources.mdx`.

---

## PR A — API core

### Task A0: Spec amendments and roadmap frontmatter

**Files:**
- Modify: `docs/superpowers/specs/ai-mcp/2026-09-07-tool-catalog-and-flows-design.md` §5.2 (slug regex), §5.4 (name rule, resolver visibility, no cache in v1), §5.5 (descriptor never global), §5.6 (two seams, not four), §11 (add "Plan amendments (W1)" row).

- [ ] **Step 1: Apply the four amendments** as **Amendment (W1 plan, 2026-09-07)** call-outs, each one paragraph, verbatim intent from this plan's "This plan amends the spec" paragraph. In §5.4 replace "Dots in a name mark a tenant tool" with "`__` marks a tenant tool: qualified name `<slug>__<name>`, slug `^[a-z][a-z0-9]{1,23}$`". In §5.4 replace the cache bullet with "v1: no cache; one indexed query per resolve". In §5.4 add: "Both tables carry the additive `FOR SELECT`-only policy `<table>_partner_wide_select USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id())` (main's Partner-Wide First step 3; template `2026-10-05-110000-config-policy-partner-wide-select.sql`), so resolution runs inside the caller's own RLS context with the app-layer predicate `org_id = :org OR (org_id IS NULL AND partner_id = :partner)`; no system-context escalation. Org admins see inherited partner-wide sources read-only." Also replace the §8 sentence "plus the read clause allowing an org token to see its partner's partner-wide rows, exactly as `automations` and `ai_agents` do" with the `_partner_wide_select` policy wording. In §5.6 replace the four-item list with the two seams (chat `createSessionPreToolUse`; `mcpServer.ts` list/call) and state why `aiGuardrails.ts` and `mcpExecutionOrg.ts` are untouched.
- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/ai-mcp/2026-09-07-tool-catalog-and-flows-design.md
git commit -m "docs(specs): W1 as-built amendments — __ separator, extraTools chat seam, system-ctx resolver, no v1 cache"
```

### Task A1: Shared types, validators, permission grants

**Files:**
- Create: `packages/shared/src/types/toolSources.ts`
- Create: `packages/shared/src/validators/toolSources.ts`, `packages/shared/src/validators/toolSources.test.ts`
- Modify: `packages/shared/src/constants/permissions.ts`, `packages/shared/src/types/index.ts`, `packages/shared/src/validators/index.ts`

**Interfaces (Produces):**
```ts
// types/toolSources.ts
export type ToolSourceKind = 'mcp' | 'openapi';            // 'openapi' arrives in W2; schema rejects it in W1
export type ToolSourceAuthKind = 'none' | 'bearer' | 'api_key_header' | 'basic' | 'oauth2_client_credentials';
export type ToolSourceStatus = 'active' | 'error' | 'disabled';
export type ToolTier = 1 | 2 | 3;
export interface ToolSourceDto {
  id: string; orgId: string | null; partnerId: string | null; slug: string; name: string; kind: ToolSourceKind;
  endpointUrl: string; credentialOrigin: string; authKind: ToolSourceAuthKind; hasCredential: boolean;
  status: ToolSourceStatus; lastDiscoveredAt: string | null; lastError: string | null;
  rateLimitPerMinute: number; toolCount: number; enabledToolCount: number; createdAt: string; updatedAt: string;
}
export interface ToolSourceToolDto {
  id: string; sourceId: string; name: string; qualifiedName: string; description: string;
  inputSchema: Record<string, unknown>; annotations: Record<string, unknown>;
  proposedTier: ToolTier; tier: ToolTier; enabled: boolean; reviewNeeded: boolean; revision: string;
  discoveredAt: string; removedAt: string | null; lastError: string | null;
}
// validators/toolSources.ts
export const TOOL_SOURCE_SLUG_RE = /^[a-z][a-z0-9]{1,23}$/;
export const SOURCE_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
export const QUALIFIED_TOOL_NAME_MAX = 64;
export const RESERVED_TOOL_SOURCE_SLUGS: ReadonlySet<string>;          // 'mcp','breeze','core','flow','ext'
export function qualifiedToolName(slug: string, name: string): string; // `${slug}__${name}`
export function splitQualifiedToolName(q: string): { slug: string; name: string } | null; // split at FIRST '__'
export function isTenantToolName(q: string): boolean;                   // contains '__' and splits cleanly
export const toolSourceAuthConfigSchema: z.ZodType<...>;               // discriminated on authKind (see below)
export const createToolSourceSchema, updateToolSourceSchema, patchToolSourceToolSchema, bulkEnableToolsSchema;
export type CreateToolSourceInput = z.infer<typeof createToolSourceSchema>; // etc.
```

- [ ] **Step 1: Write the failing validator tests** (`packages/shared/src/validators/toolSources.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import {
  createToolSourceSchema, patchToolSourceToolSchema, qualifiedToolName, splitQualifiedToolName,
  isTenantToolName, TOOL_SOURCE_SLUG_RE, RESERVED_TOOL_SOURCE_SLUGS,
} from './toolSources';

const base = { name: 'Hudu', slug: 'hudu', kind: 'mcp', endpointUrl: 'https://mcp.hudu.example/mcp', authKind: 'bearer', authConfig: { token: 'abc' } };

describe('toolSources validators', () => {
  it('accepts a minimal MCP source with bearer auth', () => {
    expect(createToolSourceSchema.safeParse(base).success).toBe(true);
  });
  it('rejects openapi kind in W1', () => {
    expect(createToolSourceSchema.safeParse({ ...base, kind: 'openapi' }).success).toBe(false);
  });
  it('rejects http endpoints, reserved slugs, slugs with underscores or hyphens', () => {
    expect(createToolSourceSchema.safeParse({ ...base, endpointUrl: 'http://x.example/mcp' }).success).toBe(false);
    for (const slug of RESERVED_TOOL_SOURCE_SLUGS) expect(createToolSourceSchema.safeParse({ ...base, slug }).success).toBe(false);
    expect(TOOL_SOURCE_SLUG_RE.test('hu_du')).toBe(false);
    expect(TOOL_SOURCE_SLUG_RE.test('hu-du')).toBe(false);
    expect(TOOL_SOURCE_SLUG_RE.test('h')).toBe(false);
  });
  it('requires authConfig fields matching authKind', () => {
    expect(createToolSourceSchema.safeParse({ ...base, authKind: 'basic', authConfig: { token: 'x' } }).success).toBe(false);
    expect(createToolSourceSchema.safeParse({ ...base, authKind: 'basic', authConfig: { username: 'u', password: 'p' } }).success).toBe(true);
    expect(createToolSourceSchema.safeParse({ ...base, authKind: 'api_key_header', authConfig: { headerName: 'X-Api-Key', value: 'k' } }).success).toBe(true);
    expect(createToolSourceSchema.safeParse({ ...base, authKind: 'oauth2_client_credentials', authConfig: { tokenUrl: 'https://id.example/token', clientId: 'a', clientSecret: 'b', scope: 'read' } }).success).toBe(true);
    expect(createToolSourceSchema.safeParse({ ...base, authKind: 'none', authConfig: undefined }).success).toBe(true);
  });
  it('rejects a header name that is not a token and a tokenUrl over http', () => {
    expect(createToolSourceSchema.safeParse({ ...base, authKind: 'api_key_header', authConfig: { headerName: 'X Api', value: 'k' } }).success).toBe(false);
    expect(createToolSourceSchema.safeParse({ ...base, authKind: 'oauth2_client_credentials', authConfig: { tokenUrl: 'http://id.example/token', clientId: 'a', clientSecret: 'b' } }).success).toBe(false);
  });
  it('patch tool schema allows tier 1-3 and enabled only', () => {
    expect(patchToolSourceToolSchema.safeParse({ tier: 2 }).success).toBe(true);
    expect(patchToolSourceToolSchema.safeParse({ tier: 4 }).success).toBe(false);
    expect(patchToolSourceToolSchema.safeParse({ name: 'x' }).success).toBe(false);
  });
  it('qualified names split at the first __ and reject core-shaped names', () => {
    expect(qualifiedToolName('hudu', 'get_asset')).toBe('hudu__get_asset');
    expect(splitQualifiedToolName('hudu__get__asset')).toEqual({ slug: 'hudu', name: 'get__asset' });
    expect(splitQualifiedToolName('get_device_details')).toBeNull();
    expect(isTenantToolName('hudu__get_asset')).toBe(true);
    expect(isTenantToolName('__x')).toBe(false);
    expect(isTenantToolName('hu-du__x')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/shared && npx vitest run src/validators/toolSources.test.ts`
Expected: FAIL — cannot resolve `./toolSources`.

- [ ] **Step 3: Implement types, validators, grants**

`packages/shared/src/validators/toolSources.ts`:
```ts
import { z } from 'zod';

export const TOOL_SOURCE_SLUG_RE = /^[a-z][a-z0-9]{1,23}$/;
export const SOURCE_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
export const QUALIFIED_TOOL_NAME_MAX = 64;
export const RESERVED_TOOL_SOURCE_SLUGS: ReadonlySet<string> = new Set(['mcp', 'breeze', 'core', 'flow', 'ext']);

const httpsUrl = z.string().url().refine((u) => u.startsWith('https://'), 'must be an https URL');
const headerToken = z.string().regex(/^[A-Za-z0-9-]{1,64}$/, 'invalid header name');

export const toolSourceAuthConfigSchema = z.discriminatedUnion('authKind', [
  z.object({ authKind: z.literal('none') }),
  z.object({ authKind: z.literal('bearer'), authConfig: z.object({ token: z.string().min(1).max(4096) }) }),
  z.object({ authKind: z.literal('api_key_header'), authConfig: z.object({ headerName: headerToken, value: z.string().min(1).max(4096) }) }),
  z.object({ authKind: z.literal('basic'), authConfig: z.object({ username: z.string().min(1).max(256), password: z.string().min(1).max(4096) }) }),
  z.object({ authKind: z.literal('oauth2_client_credentials'), authConfig: z.object({
    tokenUrl: httpsUrl, clientId: z.string().min(1).max(512), clientSecret: z.string().min(1).max(4096), scope: z.string().max(1024).optional(),
  }) }),
]);

const sourceCore = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().regex(TOOL_SOURCE_SLUG_RE).refine((s) => !RESERVED_TOOL_SOURCE_SLUGS.has(s), 'reserved slug'),
  kind: z.literal('mcp'), // W2 widens to z.enum(['mcp', 'openapi'])
  endpointUrl: httpsUrl,
  rateLimitPerMinute: z.number().int().min(1).max(6000).default(120),
  ownerScope: z.enum(['organization', 'partner']).optional(),
  orgId: z.string().uuid().optional(),
});
export const createToolSourceSchema = z.intersection(sourceCore, toolSourceAuthConfigSchema);
// slug/kind/ownerScope are create-only; auth may be replaced wholesale.
export const updateToolSourceSchema = z.intersection(
  sourceCore.omit({ slug: true, kind: true, ownerScope: true, orgId: true }).partial(),
  z.union([toolSourceAuthConfigSchema, z.object({})]),
);
export const patchToolSourceToolSchema = z.object({
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  enabled: z.boolean().optional(),
}).strict().refine((v) => v.tier !== undefined || v.enabled !== undefined, 'nothing to patch');
export const bulkEnableToolsSchema = z.object({ mode: z.enum(['enable_reads', 'disable_all']) });
export const testToolCallSchema = z.object({ input: z.record(z.string(), z.unknown()).default({}) });

export function qualifiedToolName(slug: string, name: string): string { return `${slug}__${name}`; }
export function splitQualifiedToolName(q: string): { slug: string; name: string } | null {
  const i = q.indexOf('__');
  if (i <= 0) return null;
  const slug = q.slice(0, i); const name = q.slice(i + 2);
  if (!TOOL_SOURCE_SLUG_RE.test(slug) || !SOURCE_TOOL_NAME_RE.test(name)) return null;
  return { slug, name };
}
export function isTenantToolName(q: string): boolean { return splitQualifiedToolName(q) !== null; }
export type CreateToolSourceInput = z.infer<typeof createToolSourceSchema>;
export type UpdateToolSourceInput = z.infer<typeof updateToolSourceSchema>;
export type PatchToolSourceToolInput = z.infer<typeof patchToolSourceToolSchema>;
```
`packages/shared/src/types/toolSources.ts`: the DTO interfaces from **Interfaces** above, verbatim. Export both from the barrels (`export * from './toolSources';`).

`packages/shared/src/constants/permissions.ts` — add inside `PERMISSION_GRANTS` next to `AI_AGENTS_WRITE`:
```ts
  // Tool sources (BYO MCP/OpenAPI, spec 2026-09-07 §5): manage registrations…
  TOOL_SOURCES_READ: { resource: 'tool_sources', action: 'read' },
  TOOL_SOURCES_WRITE: { resource: 'tool_sources', action: 'write' },
  // …and call the tools they expose. `use` gates Tier 1, `write` gates Tier 2/3.
  EXTERNAL_TOOLS_USE: { resource: 'external_tools', action: 'use' },
  EXTERNAL_TOOLS_WRITE: { resource: 'external_tools', action: 'write' },
```

- [ ] **Step 4: Run tests** — `cd packages/shared && npx vitest run src/validators/toolSources.test.ts` → PASS; `npx tsc --noEmit -p tsconfig.json` clean.
- [ ] **Step 5: Commit** — `git add packages/shared && git commit -m "feat(shared): tool source DTOs, validators, permission grants"`

### Task A2: Migration + Drizzle schema + encrypted-column registration

**Files:**
- Create: `apps/api/migrations/2026-10-14-100000-tool-sources.sql`
- Create: `apps/api/src/db/schema/toolSources.ts`; Modify: `apps/api/src/db/schema/index.ts`
- Modify: `apps/api/src/services/encryptedColumnRegistry.ts`, `apps/api/src/db/seed.ts`
- Test: `apps/api/src/db/schema/toolSources.test.ts` (static shape), `apps/api/src/db/autoMigrate.test.ts` (already asserts ordering)

**Interfaces (Produces):** Drizzle tables `toolSources`, `toolSourceTools` with the columns below; TS enums `toolSourceKindEnum`, `toolSourceAuthKindEnum`, `toolSourceStatusEnum`.

- [ ] **Step 1: Write the failing schema test**

```ts
// apps/api/src/db/schema/toolSources.test.ts
import { describe, expect, it } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { toolSources, toolSourceTools } from './toolSources';

describe('toolSources schema', () => {
  it('declares the dual-owner columns and the encrypted auth column on tool_sources', () => {
    expect(getTableName(toolSources)).toBe('tool_sources');
    const cols = Object.keys(getTableColumns(toolSources));
    for (const c of ['id','orgId','partnerId','slug','name','kind','endpointUrl','credentialOrigin','authKind','authConfigEncrypted','authFingerprint','status','lastDiscoveredAt','lastError','rateLimitPerMinute','createdByUserId','createdAt','updatedAt']) expect(cols).toContain(c);
  });
  it('denormalises owner ids onto tool_source_tools and carries revision/review flags', () => {
    expect(getTableName(toolSourceTools)).toBe('tool_source_tools');
    const cols = Object.keys(getTableColumns(toolSourceTools));
    for (const c of ['id','sourceId','orgId','partnerId','name','qualifiedName','description','inputSchema','outputSchema','annotations','proposedTier','tier','enabled','reviewNeeded','revision','lastError','discoveredAt','removedAt','updatedAt']) expect(cols).toContain(c);
  });
});
```
Run: `cd apps/api && npx vitest run src/db/schema/toolSources.test.ts` → FAIL (module missing).

- [ ] **Step 2: Write the migration** `apps/api/migrations/2026-10-14-100000-tool-sources.sql`

```sql
-- Tool sources (BYO MCP/OpenAPI) — spec docs/superpowers/specs/ai-mcp/2026-09-07-tool-catalog-and-flows-design.md §5.
-- Dual-owned (org XOR partner) per Partner-Wide First; child table denormalises the owner so it stays direct dual-axis.
SELECT set_config('breeze.scope', 'system', true);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tool_source_kind') THEN
    CREATE TYPE tool_source_kind AS ENUM ('mcp', 'openapi');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tool_source_auth_kind') THEN
    CREATE TYPE tool_source_auth_kind AS ENUM ('none', 'bearer', 'api_key_header', 'basic', 'oauth2_client_credentials');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tool_source_status') THEN
    CREATE TYPE tool_source_status AS ENUM ('active', 'error', 'disabled');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS tool_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  partner_id uuid REFERENCES partners(id) ON DELETE CASCADE,
  slug varchar(24) NOT NULL,
  name varchar(120) NOT NULL,
  kind tool_source_kind NOT NULL,
  endpoint_url text NOT NULL,
  credential_origin text NOT NULL,
  auth_kind tool_source_auth_kind NOT NULL DEFAULT 'none',
  auth_config_encrypted text,
  auth_fingerprint text,
  status tool_source_status NOT NULL DEFAULT 'active',
  last_discovered_at timestamptz,
  last_error text,
  rate_limit_per_minute integer NOT NULL DEFAULT 120,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_sources_one_owner_chk' AND conrelid = 'tool_sources'::regclass) THEN
    ALTER TABLE tool_sources ADD CONSTRAINT tool_sources_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_sources_slug_chk' AND conrelid = 'tool_sources'::regclass) THEN
    ALTER TABLE tool_sources ADD CONSTRAINT tool_sources_slug_chk CHECK (slug ~ '^[a-z][a-z0-9]{1,23}$');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS tool_sources_org_slug_uq ON tool_sources (org_id, slug) WHERE org_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tool_sources_partner_slug_uq ON tool_sources (partner_id, slug) WHERE partner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tool_sources_org_id_idx ON tool_sources (org_id);
CREATE INDEX IF NOT EXISTS tool_sources_partner_id_idx ON tool_sources (partner_id);

CREATE TABLE IF NOT EXISTS tool_source_tools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES tool_sources(id) ON DELETE CASCADE,
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  partner_id uuid REFERENCES partners(id) ON DELETE CASCADE,
  name varchar(64) NOT NULL,
  qualified_name varchar(64) NOT NULL,
  description text NOT NULL DEFAULT '',
  input_schema jsonb NOT NULL DEFAULT '{"type":"object"}'::jsonb,
  output_schema jsonb,
  annotations jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposed_tier smallint NOT NULL,
  tier smallint NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  review_needed boolean NOT NULL DEFAULT false,
  revision text NOT NULL,
  last_error text,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_source_tools_one_owner_chk' AND conrelid = 'tool_source_tools'::regclass) THEN
    ALTER TABLE tool_source_tools ADD CONSTRAINT tool_source_tools_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_source_tools_tier_chk' AND conrelid = 'tool_source_tools'::regclass) THEN
    ALTER TABLE tool_source_tools ADD CONSTRAINT tool_source_tools_tier_chk CHECK (tier BETWEEN 1 AND 3 AND proposed_tier IN (1, 3));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS tool_source_tools_source_name_uq ON tool_source_tools (source_id, name);
CREATE INDEX IF NOT EXISTS tool_source_tools_org_enabled_idx ON tool_source_tools (org_id) WHERE enabled AND removed_at IS NULL;
CREATE INDEX IF NOT EXISTS tool_source_tools_partner_enabled_idx ON tool_source_tools (partner_id) WHERE enabled AND removed_at IS NULL;

-- Child owner must equal parent owner (pattern: 2026-09-25-a-automation-resource-bindings.sql owner_guard_trg).
CREATE OR REPLACE FUNCTION tool_source_tools_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p_org uuid; p_partner uuid;
BEGIN
  SELECT org_id, partner_id INTO p_org, p_partner FROM tool_sources WHERE id = NEW.source_id;
  IF p_org IS DISTINCT FROM NEW.org_id OR p_partner IS DISTINCT FROM NEW.partner_id THEN
    RAISE EXCEPTION 'tool_source_tools owner must match tool_sources owner' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tool_source_tools_owner_guard_trg ON tool_source_tools;
CREATE CONSTRAINT TRIGGER tool_source_tools_owner_guard_trg AFTER INSERT OR UPDATE OF source_id, org_id, partner_id ON tool_source_tools
  DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION tool_source_tools_owner_guard();

-- RLS: ONE dual-axis policy per table (system OR org access OR partner access).
ALTER TABLE tool_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_sources FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tool_sources_isolation ON tool_sources;
CREATE POLICY tool_sources_isolation ON tool_sources
  USING (public.breeze_current_scope() = 'system' OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id)) OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id)))
  WITH CHECK (public.breeze_current_scope() = 'system' OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id)) OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id)));
GRANT SELECT, INSERT, UPDATE, DELETE ON tool_sources TO breeze_app;

ALTER TABLE tool_source_tools ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_source_tools FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tool_source_tools_isolation ON tool_source_tools;
CREATE POLICY tool_source_tools_isolation ON tool_source_tools
  USING (public.breeze_current_scope() = 'system' OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id)) OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id)))
  WITH CHECK (public.breeze_current_scope() = 'system' OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id)) OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id)));
GRANT SELECT, INSERT, UPDATE, DELETE ON tool_source_tools TO breeze_app;

-- Partner-wide READ branch (CLAUDE.md Partner-Wide First step 3; template 2026-10-05-110000-config-policy-partner-wide-select.sql).
-- Separate SELECT-only policies so an org token can read its own partner's partner-wide rows without widening UPDATE/DELETE.
-- breeze_current_partner_id() ships in 2026-06-13-catalog-partner-read-branch.sql — not recreated here.
DROP POLICY IF EXISTS tool_sources_partner_wide_select ON public.tool_sources;
CREATE POLICY tool_sources_partner_wide_select ON public.tool_sources FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());
DROP POLICY IF EXISTS tool_source_tools_partner_wide_select ON public.tool_source_tools;
CREATE POLICY tool_source_tools_partner_wide_select ON public.tool_source_tools FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

-- Permissions for existing databases (seed.ts covers fresh ones). Pattern: 2026-09-25-b-cross-site-restore-permission.sql.
DO $$
DECLARE r record; v_permission_id uuid; n integer;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('tool_sources', 'read', 'View external tool sources', ARRAY['Org Admin']),
    ('tool_sources', 'write', 'Manage external tool sources', ARRAY['Org Admin']),
    ('external_tools', 'use', 'Call Tier 1 (read-only) external tools from AI', ARRAY['Org Admin', 'Org Technician', 'Partner Technician']),
    ('external_tools', 'write', 'Call Tier 2/3 (mutating) external tools from AI', ARRAY['Org Admin'])
  ) AS t(resource, action, description, roles) LOOP
    SELECT id INTO v_permission_id FROM permissions WHERE resource = r.resource AND action = r.action;
    IF v_permission_id IS NULL THEN
      INSERT INTO permissions (resource, action, description) VALUES (r.resource, r.action, r.description) RETURNING id INTO v_permission_id;
      GET DIAGNOSTICS n = ROW_COUNT;
      RAISE NOTICE 'inserted permission %:% (% rows)', r.resource, r.action, n;
    END IF;
    INSERT INTO role_permissions (role_id, permission_id)
      SELECT ro.id, v_permission_id FROM roles ro WHERE ro.name = ANY (r.roles) AND ro.is_system = true
      ON CONFLICT DO NOTHING;
  END LOOP;
END $$;
```
Before committing, open `2026-09-25-b-cross-site-restore-permission.sql` and mirror its exact `roles` predicate (it may filter on a column other than `is_system`, e.g. `partner_id IS NULL`); keep the semantic "system roles named X".

- [ ] **Step 3: Write the Drizzle schema** `apps/api/src/db/schema/toolSources.ts` (imports as `automations.ts:1-2`; FKs and `check()` as `automationResourceBindings`):

```ts
import { sql } from 'drizzle-orm';
import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, pgEnum, integer, smallint, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { partners } from './partners';
import { users } from './users';

export const toolSourceKindEnum = pgEnum('tool_source_kind', ['mcp', 'openapi']);
export const toolSourceAuthKindEnum = pgEnum('tool_source_auth_kind', ['none', 'bearer', 'api_key_header', 'basic', 'oauth2_client_credentials']);
export const toolSourceStatusEnum = pgEnum('tool_source_status', ['active', 'error', 'disabled']);

export const toolSources = pgTable('tool_sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
  slug: varchar('slug', { length: 24 }).notNull(),
  name: varchar('name', { length: 120 }).notNull(),
  kind: toolSourceKindEnum('kind').notNull(),
  endpointUrl: text('endpoint_url').notNull(),
  credentialOrigin: text('credential_origin').notNull(),
  authKind: toolSourceAuthKindEnum('auth_kind').notNull().default('none'),
  authConfigEncrypted: text('auth_config_encrypted'),
  authFingerprint: text('auth_fingerprint'),
  status: toolSourceStatusEnum('status').notNull().default('active'),
  lastDiscoveredAt: timestamp('last_discovered_at', { withTimezone: true }),
  lastError: text('last_error'),
  rateLimitPerMinute: integer('rate_limit_per_minute').notNull().default(120),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  oneOwnerCheck: check('tool_sources_one_owner_chk', sql`(${t.orgId} IS NULL) <> (${t.partnerId} IS NULL)`),
  orgSlugUq: uniqueIndex('tool_sources_org_slug_uq').on(t.orgId, t.slug).where(sql`${t.orgId} IS NOT NULL`),
  partnerSlugUq: uniqueIndex('tool_sources_partner_slug_uq').on(t.partnerId, t.slug).where(sql`${t.partnerId} IS NOT NULL`),
  orgIdx: index('tool_sources_org_id_idx').on(t.orgId),
  partnerIdx: index('tool_sources_partner_id_idx').on(t.partnerId),
}));

export const toolSourceTools = pgTable('tool_source_tools', {
  id: uuid('id').primaryKey().defaultRandom(),
  sourceId: uuid('source_id').notNull().references(() => toolSources.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
  partnerId: uuid('partner_id').references(() => partners.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 64 }).notNull(),
  qualifiedName: varchar('qualified_name', { length: 64 }).notNull(),
  description: text('description').notNull().default(''),
  inputSchema: jsonb('input_schema').$type<Record<string, unknown>>().notNull().default({ type: 'object' }),
  outputSchema: jsonb('output_schema').$type<Record<string, unknown> | null>(),
  annotations: jsonb('annotations').$type<Record<string, unknown>>().notNull().default({}),
  proposedTier: smallint('proposed_tier').notNull(),
  tier: smallint('tier').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  reviewNeeded: boolean('review_needed').notNull().default(false),
  revision: text('revision').notNull(),
  lastError: text('last_error'),
  discoveredAt: timestamp('discovered_at', { withTimezone: true }).defaultNow().notNull(),
  removedAt: timestamp('removed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  oneOwnerCheck: check('tool_source_tools_one_owner_chk', sql`(${t.orgId} IS NULL) <> (${t.partnerId} IS NULL)`),
  sourceNameUq: uniqueIndex('tool_source_tools_source_name_uq').on(t.sourceId, t.name),
  orgEnabledIdx: index('tool_source_tools_org_enabled_idx').on(t.orgId).where(sql`${t.enabled} AND ${t.removedAt} IS NULL`),
  partnerEnabledIdx: index('tool_source_tools_partner_enabled_idx').on(t.partnerId).where(sql`${t.enabled} AND ${t.removedAt} IS NULL`),
}));
export type ToolSourceRow = typeof toolSources.$inferSelect;
export type ToolSourceToolRow = typeof toolSourceTools.$inferSelect;
```
Add `export * from './toolSources';` to `apps/api/src/db/schema/index.ts`.

- [ ] **Step 4: Register the encrypted column** in `encryptedColumnRegistry.ts` next to the `tenant_variables` entry:
```ts
{ table: 'tool_sources', column: 'auth_config_encrypted', kind: 'text', aadBinding: 'row', description: 'External tool source credential JSON (spec 2026-09-07 §5.2) — AAD bound to the row id' },
```
- [ ] **Step 5: Seed permissions** in `apps/api/src/db/seed.ts`: add the four rows to `DEFAULT_PERMISSIONS` (mirror `ai_agents` rows at ~145); add `'tool_sources:read', 'tool_sources:write', 'external_tools:use', 'external_tools:write'` to `Org Admin` (~299), and `'external_tools:use'` to `Org Technician` (~329) and `Partner Technician` (~241).
- [ ] **Step 6: Run** `cd apps/api && npx vitest run src/db/schema/toolSources.test.ts src/db/autoMigrate.test.ts src/services/encryptedColumnRegistry.test.ts src/services/migrationRlsScope.test.ts` → PASS; `pnpm db:check-drift` against a local DB after `pnpm db:migrate` → no drift.
- [ ] **Step 7: Commit** — `git add apps/api/migrations/2026-10-14-100000-tool-sources.sql apps/api/src/db apps/api/src/services/encryptedColumnRegistry.ts && git commit -m "feat(api): tool_sources + tool_source_tools tables, RLS, permissions"`

### Task A3: Cascade, export-policy, org-merge, RLS-coverage registrations

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER`), `apps/api/src/services/tenantExportPolicyRegistry.ts`, `apps/api/src/services/orgMergeRegistry.ts`, `apps/api/src/services/orgMergeCustomExecutors.ts`, `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`
- Test: `apps/api/src/services/orgMergeExecutors.test.ts` (extend), the four contract suites (integration).

- [ ] **Step 1: Write the failing unit test for the merge executor** in `orgMergeExecutors.test.ts`, following the file's existing pattern for a custom executor: a loser org has source slug `hudu`, survivor has `hudu` too → after merge the loser's source is repointed with slug `hudu_m1` and its tools' `org_id` repointed, and no row was deleted. Run → FAIL (no executor).
- [ ] **Step 2: Register**
  - `tenantCascade.ts`: insert `'tool_source_tools',` then `'tool_sources',` between `'time_series_metrics'` and `'topology_layout'` (children first; verify with the test's FK-order assertion).
  - `tenantExportPolicyRegistry.ts` (alphabetical position):
    ```ts
    "tool_source_tools": tablePolicy("org_id", {"included":["id","source_id","org_id","partner_id","name","qualified_name","description","proposed_tier","tier","enabled","review_needed","last_error","discovered_at","removed_at","updated_at"],"reviewedIncluded":["revision"],"excludedSensitive":[],"excludedOpen":["input_schema","output_schema","annotations"]}),
    "tool_sources": tablePolicy("org_id", {"included":["id","org_id","partner_id","slug","name","kind","endpoint_url","credential_origin","auth_kind","status","last_discovered_at","last_error","rate_limit_per_minute","created_by_user_id","created_at","updated_at"],"reviewedIncluded":["auth_fingerprint"],"excludedSensitive":["auth_config_encrypted"],"excludedOpen":[]}),
    ```
  - `orgMergeRegistry.ts` `SPECIAL`: `tool_sources: { kind: 'custom', note: 'repoint org_id; a loser source whose slug collides with a survivor source is renamed <slug>_m<n> first so no registration is silently dropped' }`, `tool_source_tools: { kind: 'custom', note: 'repoint org_id with the parent source (owner-guard trigger requires parent and child to move in one statement order: parent first)' }`. Implement both in `orgMergeCustomExecutors.ts` (parent rename+repoint, then child repoint) following the `automation_resource_bindings` executor.
  - `rls-coverage.integration.test.ts`: add `'tool_sources', 'tool_source_tools'` to `DUAL_AXIS_TENANT_TABLES` AND to `XOR_OWNERSHIP_DUAL_AXIS_TABLES` with a one-line comment citing the spec; the partner-wide SELECT-branch assertion then covers both (the migration's `_partner_wide_select` policies satisfy it).
- [ ] **Step 3: Run** `cd apps/api && npx vitest run src/services/orgMergeExecutors.test.ts src/services/tenantCascade.test.ts` (unit parts) → PASS. Against a real DB: `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts` → PASS (confirm each file reports >0 tests).
- [ ] **Step 4: Commit** — `git commit -am "feat(api): register tool source tables in cascade, export, merge, RLS coverage"`

### Task A4: Secrets, credential origin, redaction

**Files:**
- Create: `apps/api/src/services/toolSources/secrets.ts`, `apps/api/src/services/toolSources/secrets.test.ts`

**Interfaces (Produces):**
```ts
export type ToolSourceAuthConfig =
  | { authKind: 'none' } | { authKind: 'bearer'; token: string } | { authKind: 'api_key_header'; headerName: string; value: string }
  | { authKind: 'basic'; username: string; password: string }
  | { authKind: 'oauth2_client_credentials'; tokenUrl: string; clientId: string; clientSecret: string; scope?: string };
export function encryptToolSourceAuth(rowId: string, cfg: ToolSourceAuthConfig): { encrypted: string | null; fingerprint: string | null };
export function decryptToolSourceAuth(row: { id: string; authKind: string; authConfigEncrypted: string | null }): ToolSourceAuthConfig;
export function credentialOriginFor(endpointUrl: string): string;                 // new URL(u).origin
export function secretValuesOf(cfg: ToolSourceAuthConfig): string[];              // every secret string, for redaction
export function redactSecrets(text: string, secrets: readonly string[]): string;  // literal replace + generic Bearer/JWT/sk- patterns → '[REDACTED]'
```

- [ ] **Step 1: Failing tests** — round-trip encrypt/decrypt for each authKind; decrypt with a different rowId throws (AAD binding); `credentialOriginFor('https://a.example:8443/mcp?x=1') === 'https://a.example:8443'`; `redactSecrets('Bearer abc.def.ghi token=K1', ['K1'])` contains neither `K1` nor the JWT-shaped token; `redactSecrets` leaves ordinary text untouched. Tests set the secret-crypto env the way `partnerLlmConfig.test.ts` does (copy its `beforeAll`).
- [ ] **Step 2: Implement** using `encryptSecret`/`decryptSecret` from `../secretCrypto` with `{ aad: columnAad(TOOL_SOURCE_AUTH_SPEC, rowId) }` where `TOOL_SOURCE_AUTH_SPEC` is looked up from `encryptedColumnRegistry` exactly as `partnerLlmConfig.ts:29-36` does; fingerprint via `hmacFingerprint(JSON.stringify(cfg))` from `secretCrypto`. Generic patterns: `/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g`, `/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g`, `/\bsk-[A-Za-z0-9_-]{16,}\b/g`.
- [ ] **Step 3: Run** → PASS. **Step 4: Commit** — `git commit -m "feat(api): tool source credential encryption, origin pinning, redaction"`

### Task A5: Streamable-HTTP MCP client

**Files:**
- Create: `apps/api/src/services/toolSources/mcpClient.ts`, `apps/api/src/services/toolSources/mcpClient.test.ts`

**Interfaces (Produces):**
```ts
export interface McpClientOptions {
  endpointUrl: string; credentialOrigin: string; auth: ToolSourceAuthConfig;
  fetchImpl?: (url: string, init: SafeFetchInit) => Promise<Response>;   // default: safeFetch from '../urlSafety'
  timeoutMs?: number;      // default 30_000
  maxResponseBytes?: number; // default 1_048_576
  allowPrivateNetwork?: boolean;
  clientVersion?: string;
}
export interface McpToolListing { name: string; description?: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> }
export interface McpCallResult { content: Array<{ type: string; text?: string; [k: string]: unknown }>; structuredContent?: unknown; isError?: boolean }
export class McpClientError extends Error { constructor(message: string, readonly code: 'transport' | 'protocol' | 'auth' | 'timeout' | 'too_large' | 'origin_mismatch') }
export class McpClient {
  constructor(opts: McpClientOptions);
  initialize(): Promise<{ protocolVersion: string; serverInfo?: { name?: string; version?: string } }>;
  listTools(): Promise<McpToolListing[]>;      // follows nextCursor until exhausted, max 50 pages
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
}
export async function getOAuth2ClientCredentialsToken(cfg, fetchImpl): Promise<{ accessToken: string; expiresAt: number }>; // cached per (tokenUrl, clientId) in a module Map
```
Protocol: JSON-RPC 2.0 POSTs to `endpointUrl` with `Content-Type: application/json`, `Accept: application/json, text/event-stream`, `MCP-Protocol-Version: 2025-06-18` on every request after `initialize`, and `Mcp-Session-Id` echoed when the server returned one. `initialize` params `{ protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'breeze-rmm', version } }`; then POST `notifications/initialized` (accept 202/200/204). Responses may be `application/json` (one JSON-RPC message) or `text/event-stream` (parse `data:` lines; take the message whose `id` matches). Auth header from `auth` only when `new URL(endpointUrl).origin === credentialOrigin` else throw `origin_mismatch`. Never follow redirects (safeFetch default); a 3xx is a `transport` error.

- [ ] **Step 1: Failing tests with a fake fetch** (no sockets): a scripted `fetchImpl` returning `Response` objects: (a) initialize → session id captured and echoed on the next call; (b) tools/list with two pages via `nextCursor`; (c) tools/call returns `structuredContent` and `isError`; (d) SSE-framed response parsed; (e) `Authorization: Bearer` present for bearer auth, `X-Api-Key` for api_key_header, `Basic base64` for basic; (f) credential NOT attached when `credentialOrigin` differs → `origin_mismatch`; (g) JSON-RPC error object → `protocol` error with the server message; (h) 401 → `auth`; (i) body over `maxResponseBytes` → `too_large` (fake returns a huge string); (j) more than 50 pages → stops with `protocol` error.
- [ ] **Step 2: Implement** as specified; use `safeFetch(url, { method: 'POST', headers, body, timeoutMs, maxBytes: maxResponseBytes, allowPrivateNetwork })` as the default `fetchImpl`.
- [ ] **Step 3: Run** → PASS. **Step 4: Commit** — `git commit -m "feat(api): streamable-HTTP MCP client over safeFetch"`

### Task A6: Discovery service + BullMQ worker

**Files:**
- Create: `apps/api/src/services/toolSources/discovery.ts`, `discovery.test.ts`, `apps/api/src/jobs/toolSourceDiscoveryWorker.ts`, `toolSourceDiscoveryWorker.test.ts`
- Modify: `apps/api/src/services/workerRegistry.ts`

**Interfaces (Produces):**
```ts
// discovery.ts
export function proposeTier(annotations: Record<string, unknown> | undefined): 1 | 3;     // readOnlyHint===true && destructiveHint!==true → 1 else 3
export function computeToolRevision(t: { name: string; description: string; inputSchema: unknown; tier: number }): string; // sha256 hex of canonical JSON
export interface DiscoveryOutcome { added: number; updated: number; removed: number; skipped: Array<{ name: string; reason: string }>; status: 'active' | 'error'; error?: string }
export async function discoverSource(sourceId: string, deps?: { clientFactory?: (opts: McpClientOptions) => McpClient }): Promise<DiscoveryOutcome>;
// toolSourceDiscoveryWorker.ts
export function getToolSourceDiscoveryQueue(): Queue<{ sourceId: string }>;
export async function enqueueToolSourceDiscovery(sourceId: string): Promise<void>;   // jobId `discover:${sourceId}` (dedupes)
export function createToolSourceDiscoveryWorker(): Worker<{ sourceId: string }>;
export async function initializeToolSourceDiscoveryWorkers(): Promise<void>; export async function shutdownToolSourceDiscoveryWorkers(): Promise<void>;
```
Rules (spec §5.3 + amendment): all new tools `enabled=false`; `proposedTier` from annotations; on re-discovery keep `tier` unless proposed rises to 3 (then set `tier=3`, `reviewNeeded=true`); proposed drop ⇒ `reviewNeeded=true`, tier unchanged; changed `inputSchema`/description/name ⇒ new `revision`; tools missing from the listing ⇒ `removedAt=now()`, `enabled=false`; if any removed tool was enabled ⇒ source `status='error'`, `lastError='enabled tools removed by re-discovery: <names>'`; tool names failing `SOURCE_TOOL_NAME_RE` or qualified length ⇒ upsert with `enabled=false`, `reviewNeeded=true`, `lastError='name_not_addressable'`; transport/auth errors ⇒ source `status='error'`, `lastError=redactSecrets(message)`. Runs in `withSystemDbAccessContext` (background job); external I/O outside any transaction.

- [ ] **Step 1: Failing tests** for `proposeTier`, `computeToolRevision` (stable across key order), and `discoverSource` with a fake `clientFactory` and the Drizzle mock pattern from `softwarePolicies.test.ts`: first discovery inserts N disabled tools with proposed tiers; second discovery with a changed schema bumps revision and leaves `tier`; a tool whose annotations flip to destructive raises tier to 3 + reviewNeeded; a listing missing an enabled tool sets source error; a bad name is recorded as not addressable; an `auth` error sets `status='error'` with a redacted message.
- [ ] **Step 2: Implement** discovery and the worker (queue name `tool-source-discovery`, concurrency 2, `attempts: 3`, exponential backoff 5 s); register in `workerRegistry.ts` as `{ name: 'toolSourceDiscoveryWorker', placement: 'global', load: async () => { const m = await import('../jobs/toolSourceDiscoveryWorker'); return { init: m.initializeToolSourceDiscoveryWorkers, shutdown: m.shutdownToolSourceDiscoveryWorkers }; } }`; the worker no-ops when `toolSourcesEnabled()` is false.
- [ ] **Step 3: Run** → PASS. **Step 4: Commit** — `git commit -m "feat(api): tool source discovery job (tier proposal, revisions, removals)"`

### Task A7: Feature flags and `/config`

**Files:**
- Modify: `apps/api/src/config/env.ts`, `apps/api/src/config/validate.ts`, `apps/api/src/routes/config.ts`, `apps/api/src/routes/config.test.ts`

- [ ] **Step 1: Failing test** in `config.test.ts`: with `TOOL_SOURCES_ENABLED=true` the body has `features.toolSources === true`; unset → `false`. Failing test in `validate.test.ts` (find the sibling test for `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED` and copy): `TOOL_SOURCES_ENABLED=maybe` fails validation; `TOOL_SOURCES_ALLOW_PRIVATE_EGRESS=true` with `IS_HOSTED=true` fails validation with message containing `hosted`.
- [ ] **Step 2: Implement**: `env.ts` — `export function toolSourcesEnabled(): boolean { return envFlag('TOOL_SOURCES_ENABLED', false); }` and `toolSourcesAllowPrivateEgress()`; `validate.ts` — boolean checks mirroring lines ~1751-1760, plus the hosted refusal; `config.ts` — `features.toolSources: toolSourcesEnabled()`.
- [ ] **Step 3: Run** the two test files → PASS. **Step 4: Commit** — `git commit -m "feat(api): TOOL_SOURCES_ENABLED flag + /config feature bit"`

### Task A8: Resolver, descriptors, executor, guardrail adapters

**Files:**
- Create: `apps/api/src/services/toolSources/resolver.ts`, `resolver.test.ts`, `execute.ts`, `execute.test.ts`, `guardrails.ts`, `guardrails.test.ts`

**Interfaces (Produces):**
```ts
// resolver.ts
export interface TenantToolDescriptor {
  id: string; sourceId: string; sourceName: string; sourceKind: 'mcp';
  ownerRef: { orgId: string | null; partnerId: string | null };
  qualifiedName: string; name: string; description: string;
  inputSchema: Record<string, unknown>; tier: 1 | 2 | 3; revision: string; rateLimitPerMinute: number;
  validate: (input: Record<string, unknown>) => { success: true } | { success: false; error: string };   // Ajv, compiled once per resolve
  definition: { name: string; description: string; input_schema: Record<string, unknown> };            // Anthropic.Tool shape
}
export async function resolveTenantTools(auth: AuthContext): Promise<TenantToolDescriptor[]>;
export async function resolveTenantToolByName(auth: AuthContext, qualifiedName: string): Promise<TenantToolDescriptor | null>;
export async function loadTenantToolForExecution(toolId: string): Promise<{ descriptor: TenantToolDescriptor; source: ToolSourceRow } | null>; // system ctx; enabled && active && !removed
// execute.ts
export interface ExecuteTenantToolOptions { orgId?: string | null; actor?: { kind: 'user' | 'api_key' | 'flow'; id: string }; surface: 'chat' | 'mcp' | 'test' }
export async function executeTenantTool(d: TenantToolDescriptor, input: Record<string, unknown>, auth: AuthContext, opts: ExecuteTenantToolOptions): Promise<string>; // JSON string
// guardrails.ts
export function guardrailCheckForTenantTool(d: TenantToolDescriptor): GuardrailCheck;             // tier 1: allowed, readOnly; tier 2: requiresApproval; tier 3: approvalScope 'supervised'
export function tenantToolPermissionRequirement(tier: 1 | 2 | 3): { resource: 'external_tools'; action: 'use' | 'write' };
export async function checkTenantToolRateLimit(d: TenantToolDescriptor, principalId: string): Promise<string | null>; // rateLimiter(getRedis(), `ai:exttool:${d.sourceId}:${principalId}`, d.rateLimitPerMinute, 60)
```
Resolution (amendment 3): when `toolSourcesEnabled()` is false return `[]`. Otherwise run **inside the caller's own RLS context** — in a request handler that is the ambient `withDbAccessContext` transaction; from chat/background paths use `runOutsideDbContext(() => withDbAccessContext(dbAccessContextFromAuth(auth), …))` (`dbAccessContextFromAuth` from `middleware/auth`). Never `withSystemDbAccessContext` here. App-layer predicate mirrors `softwarePolicyAccessCondition`: org scope: `org_id = auth.orgId OR (org_id IS NULL AND partner_id = auth.partnerId)` (the `_partner_wide_select` policy makes the second arm readable for an org token); partner scope: `org_id IN accessible OR (org_id IS NULL AND partner_id = auth.partnerId)`, narrowed to `auth.orgId` when set; system scope: `[]` (system callers get no tenant tools). Query `tool_source_tools` JOIN `tool_sources` where `enabled AND removed_at IS NULL AND status = 'active' AND ((tst.org_id = :org) OR (tst.org_id IS NULL AND tst.partner_id = :partner))`, ordered `qualified_name`. Compile each `inputSchema` with `new Ajv({ allErrors: true, strict: false })` + `addFormats` (strict:false because foreign schemas use vendor keywords) — a schema that fails to compile is skipped and logged once per revision. Two owners cannot yield the same qualified name (org slug may not shadow a partner slug: enforced in Task A9 create), but defensively prefer the org-owned descriptor and log.

Execution: `d.validate(input)` → error JSON; `checkTenantToolRateLimit` → error JSON; load source + decrypt auth via `loadTenantToolForExecution(d.id)` (fresh read: revocation is rechecked at dispatch); `new McpClient({...}).callTool(d.name, input)` outside any DB context; build the result string: `structuredContent` if present else concatenated `text` parts; `redactSecrets(result, secretValuesOf(auth))`; truncate to 262,144 chars with `\n…[truncated]`; if `isError` return `{ error: <text> }`. Audit: `writeAuditEvent(requestLike, { orgId: opts.orgId ?? auth.orgId, action: 'ai.external_tool.call', resourceType: 'tool_source_tool', resourceId: d.id, resourceName: d.qualifiedName, details: { sourceId: d.sourceId, tier: d.tier, revision: d.revision, surface: opts.surface, inputKeys: Object.keys(input), isError }, actorId: opts.actor?.id ?? auth.user.id, actorEmail: auth.user.email })` — never the input values or output.

- [ ] **Step 1: Failing tests**: resolver — org-scoped auth sees its org's enabled tools AND its partner's partner-wide enabled tools, not another org's, not disabled/removed/inactive-source tools, and `[]` when the flag is off; partner-scoped auth sees partner-wide tools; a tool with an uncompilable schema is skipped; `validate` rejects a missing required field. execute — validation error path; rate-limit path (mock `rateLimiter`); success path with `structuredContent`; `isError` path; redaction of the bearer token in output; truncation; audit event called with no input values. guardrails — the three `GuardrailCheck` shapes satisfy the type (compile-time) and `tenantToolPermissionRequirement(1).action === 'use'`.
- [ ] **Step 2: Implement.** For `GuardrailCheck` construction read `aiGuardrails.ts:1170-1210` (`GuardrailCheckCommon`) and fill: `{ tier, allowed: true, requiresApproval: tier >= 2, readOnly: tier === 1, description: `${d.qualifiedName} — external tool from ${d.sourceName}`, approvalScope: tier === 3 ? 'supervised' : undefined }` (only the fields the type declares).
- [ ] **Step 3: Run** → PASS. **Step 4: Commit** — `git commit -m "feat(api): tenant tool resolver, descriptors, executor, guardrail adapters"`

### Task A9: Routes `/api/v1/tool-sources`

**Files:**
- Create: `apps/api/src/services/toolSources/service.ts`, `apps/api/src/routes/toolSources.ts`, `apps/api/src/routes/toolSources.test.ts`
- Modify: `apps/api/src/index.ts` (import + `api.route('/tool-sources', toolSourcesRoutes)`), `apps/api/src/middleware/selfManagedDbContextRoutes.ts` (add `{ method: 'POST', pattern: /^\/api\/v1\/tool-sources\/[^/]+\/tools\/[^/]+\/test\/?$/ }`)

Routes (all behind `authMiddleware`, `requireScope('organization','partner','system')`, and 404 when `!toolSourcesEnabled()` via a first `use('*')`):

| method path | permission | behaviour |
|---|---|---|
| `GET /` | `tool_sources:read` | dual-axis list (copy `softwarePolicyAccessCondition`, but do NOT gate the partner-wide arm on `auth.scope === 'partner'` — the `_partner_wide_select` policy lets org tokens read inherited rows, and the DTO marks them `readOnly: true` when `auth.scope === 'organization' && row.orgId === null`), `{ data: ToolSourceDto[], pagination }`; DTO adds `toolCount`, `enabledToolCount` via a grouped subquery; never returns auth config |
| `POST /` | `tool_sources:write` + `requireMfa()` | `createToolSourceSchema`; owner resolution copied from `softwarePolicies.ts:290-325`; org-owned create rejects a slug that a visible partner-wide source already uses (409 `slug_shadows_partner_source`); computes `credentialOrigin`; encrypts auth; inserts; `enqueueToolSourceDiscovery(id)`; `writeRouteAudit` `tool_source.created`; 201 `{ data }` |
| `GET /:id` | read | 404 if not visible; `{ data }` |
| `PATCH /:id` | write + MFA | `updateToolSourceSchema`; partner-wide rows require `canManagePartnerWidePolicies`; a changed endpoint or auth re-derives origin, re-encrypts, re-enqueues discovery |
| `DELETE /:id` | write + MFA | partner-wide gate; cascade deletes tools; audit |
| `POST /:id/discover` | write | enqueue; 202 `{ data: { queued: true } }` |
| `GET /:id/tools` | read | `{ data: ToolSourceToolDto[] }` ordered by `qualifiedName`, `?includeRemoved=true` optional |
| `PATCH /:id/tools/:toolId` | write + MFA | `patchToolSourceToolSchema`; sets `tier`/`enabled`, clears `reviewNeeded` when a human sets tier; refuses `enabled=true` on a `name_not_addressable` or removed tool (422); audit `tool_source_tool.updated` with old/new tier |
| `POST /:id/tools/bulk` | write + MFA | `enable_reads` (enable every tier-1, addressable, non-removed tool) or `disable_all` |
| `POST /:id/tools/:toolId/test` | read + `external_tools:use` | Tier 1 only (403 otherwise); `testToolCallSchema`; self-managed DB context; `executeTenantTool(descriptor, input, auth, { surface: 'test' })`; `{ data: { result: string, durationMs } }` |

- [ ] **Step 1: Failing route tests** (mock pattern from `softwarePolicies.test.ts`): 404 when flag off; partner admin creates partner-wide source (insert called with `orgId: null, partnerId`), `selected` access → 403; org create with a slug that collides with a visible partner-wide slug → 409; create response omits `authConfigEncrypted` and has `hasCredential: true`; PATCH tool `tier: 4` → 400; enabling a removed tool → 422; test route on a tier-3 tool → 403; test route calls `executeTenantTool` and returns its result; DELETE on partner-wide row without full access → 403.
- [ ] **Step 2: Implement** `service.ts` (pure functions taking `auth` + db) and the route file; mount; self-managed route entry.
- [ ] **Step 3: Run** `npx vitest run src/routes/toolSources.test.ts src/middleware/selfManagedDbContextRoutes.test.ts` → PASS; tsc clean. **Step 4: Commit** — `git commit -m "feat(api): /tool-sources routes (CRUD, discover, tool tiers, test call)"`

### Task A10: Chat bridge (Agent SDK `extraTools`) and MCP server surfaces

**Files:**
- Create: `apps/api/src/services/toolSources/sdkBridge.ts`, `sdkBridge.test.ts`
- Modify: `apps/api/src/services/streamingSessionManager.ts` (~743-810, ~951), `apps/api/src/services/aiAgentSdk.ts` (`ActiveSession` type; `createSessionPreToolUse` ~487-560), `apps/api/src/routes/mcpServer.ts` (`handleToolsList` ~1050, `handleToolsCall` ~1122)
- Test: `sdkBridge.test.ts`, `aiAgentSdk.test.ts` (extend), `mcpServer.test.ts` (extend)

**Interfaces (Produces):**
```ts
// sdkBridge.ts
export function zodShapeFromJsonSchema(schema: Record<string, unknown>): z.ZodRawShape;   // z.fromJSONSchema(schema, { defaultTarget: 'draft-2020-12' }); if result is a ZodObject return .shape; else { input: z.record(z.string(), z.unknown()) }
export function buildTenantSdkTools(descriptors: TenantToolDescriptor[], getAuth: () => AuthContext, getOrgId: () => string): SdkTool[];
// each: tool(d.qualifiedName, `[External: ${d.sourceName}] ${d.description}`, zodShapeFromJsonSchema(d.inputSchema), async (args) => ({ content: [{ type: 'text', text: compactToolResultForChat(d.qualifiedName, await executeTenantTool(d, args, getAuth(), { surface: 'chat', orgId: getOrgId() })) }] }))
export function tenantMcpToolNames(descriptors: TenantToolDescriptor[]): string[];   // `mcp__breeze__${qualifiedName}`
```
`ActiveSession` gains `tenantTools: ReadonlyMap<string, TenantToolDescriptor>` (empty map by default).

Chat wiring in `streamingSessionManager.getOrCreate` after `toolAuth` is computed: `const tenantDescriptors = mcpServerFactory ? [] : await resolveTenantTools(toolAuth);` (script-builder sessions keep their own server); `session.tenantTools = new Map(tenantDescriptors.map(d => [d.qualifiedName, d]))`; pass `buildTenantSdkTools(tenantDescriptors, () => session.toolAuth, () => session.orgId)` as the 5th argument of `createBreezeMcpServer` (the hooks are applied by `wrapExtraToolWithHooks`, so the bridge handler must NOT call the hooks itself); `allowedTools: allowedTools ?? [...BREEZE_MCP_TOOL_NAMES, ...tenantMcpToolNames(tenantDescriptors)]` (an explicit `allowedTools`, e.g. from agents, is left untouched).

`createSessionPreToolUse` tenant branch (replace the `if (!TOOL_TIERS[toolName])` gate):
```ts
const tenant = session.tenantTools.get(toolName);
if (!TOOL_TIERS[toolName] && !tenant) return { allowed: false, error: `Unknown tool: ${toolName}` };
if (session.allowedTools && !isAllowedForSession(toolName, session.allowedTools)) { /* unchanged */ }
const guardrailCheck = tenant ? guardrailCheckForTenantTool(tenant) : checkGuardrails(toolName, input);
if (!guardrailCheck.allowed) { /* unchanged */ }
// RBAC
const permError = tenant
  ? await checkPermissionRequirements(session.auth, [tenantToolPermissionRequirement(tenant.tier)])
  : await checkToolPermission(toolName, input, session.auth);
// rate limit
const rateLimitErr = tenant ? await checkTenantToolRateLimit(tenant, session.auth.user.id) : await checkToolRateLimit(toolName, session.auth.user.id);
// Tier 3 external: PR B. Until then:
if (tenant && guardrailCheck.tier === 3) return { allowed: false, error: 'This external tool requires approval; approval support for external tools ships in the next release.' };
```
Everything after (Tier 2 auto-approve/per-step branches, plan matching) runs unchanged on the constructed `guardrailCheck`.

MCP HTTP server: `handleToolsList` — after `scopedTools`, `const tenant = await resolveTenantTools(auth)`; append `tenant.filter(d => d.tier <= 1 || (d.tier === 2 && hasWrite) || (d.tier === 3 && hasExecute && (!requireExecuteAdmin || hasExecuteAdmin))).map(d => d.definition)`. `handleToolsCall` — first line: `if (isTenantToolName(toolName)) return handleTenantToolCall(...)` where the tenant handler mirrors the core path in order: resolve descriptor via `resolveTenantToolByName(auth, toolName)` (404 `-32602` if null); `tier = d.tier`; `isMcpApprovalRequired(toolName, tier)` deny (Tier 3 external is denied over MCP, same as core); scope gates identical to core (`ai:write` for tier 2); `checkPermissionRequirements(auth, [tenantToolPermissionRequirement(tier)])`; `checkTenantToolRateLimit(d, auth.user.id)`; `resolveMcpExecutionContext({ auth, apiKey, toolName, toolInput, deviceArgsForTool: async () => undefined })`; `executeTenantTool(d, toolInput, auth, { surface: 'mcp', orgId, actor: apiKey ? { kind: 'api_key', id: apiKey.id } : undefined })`; `writeMcpToolAuditEvent` as core does; return `{ content: [{ type: 'text', text }] }`.

- [ ] **Step 1: Failing tests**: `sdkBridge.test.ts` — `zodShapeFromJsonSchema({type:'object',properties:{id:{type:'string'}},required:['id']})` yields a shape whose `z.object(shape).safeParse({})` fails and `({id:'x'})` passes; non-object schema falls back to `{ input }`; `buildTenantSdkTools` returns tools named by qualified name whose handler calls `executeTenantTool` (mocked) and wraps the text. `aiAgentSdk.test.ts` — with `session.tenantTools` holding a tier-1 descriptor, preToolUse allows it after `checkPermissionRequirements` resolves null; denies when permission returns a string; tier-3 tenant → the "next release" denial; a non-registered non-tenant name → Unknown tool. `mcpServer.test.ts` — tools/list includes `hudu__get_asset` for an `ai:read` key; tools/call on it with `ai:read` executes via mocked `executeTenantTool`; a tier-2 tenant tool without `ai:write` → insufficient scope; a tier-3 tenant tool → `MCP_APPROVAL_REQUIRED_ERROR`. Also `aiToolsRegistryParity.test.ts`: add an assertion that no name in `TOOL_TIERS` or `getToolDefinitions()` contains `__`.
- [ ] **Step 2: Implement** as specified. `SdkTool` is `import type { SdkTool } from '../aiAgents/outcomeTools'`; `tool` from `@anthropic-ai/claude-agent-sdk`; cast `as SdkTool` at the construction site as `outcomeTools.ts:356-364` does.
- [ ] **Step 3: Run** the four test files + `src/services/aiToolsRegistryParity.test.ts` → PASS; tsc clean. **Step 4: Commit** — `git commit -m "feat(api): tenant tools in chat (extraTools bridge) and MCP server list/call"`

### Task A11: Integration RLS suite and PR A wrap-up

**Files:**
- Create: `apps/api/src/__tests__/integration/toolSourcesPartnerRls.integration.test.ts`
- Modify: `CLAUDE.md`? No. `apps/api/migrations/README.md`? No.

- [ ] **Step 1: Write the suite** copying `tenantVariablesPartnerRls.integration.test.ts` verbatim for setup, with these cases: partner B forging partner A's `partner_id` on `tool_sources` → 42501; org B forging org A's `org_id` → 42501; both/neither owner → 23514 (both tables); child owner ≠ parent owner → 23514 (the trigger); an org token CAN SELECT its own partner's partner-wide source and tools (1 row each, via `_partner_wide_select`) but its UPDATE/DELETE of that row affects 0 rows and its INSERT forging `partner_id` fails 42501; an org token under partner B sees 0 partner-A rows; `resolveTenantTools(orgAuth)` run inside `withDbAccessContext(orgContext(...))` returns the partner's enabled partner-wide tool plus the org's own, never another org's (build a minimal `AuthContext`: `scope:'organization', orgId, partnerId, user:{id}`); the rls-coverage SELECT-branch assertion passes with both tables registered.
- [ ] **Step 2: Run against a real DB** (`pnpm db:migrate` first): `npx vitest run --config vitest.integration.config.ts src/__tests__/integration/toolSourcesPartnerRls.integration.test.ts` → PASS with the expected test count; re-run the four contract suites from Task A3.
- [ ] **Step 3: Full checks**: `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`; `pnpm lint` in `apps/api` and `packages/shared`; `npx vitest run src/services/toolSources src/routes/toolSources.test.ts src/routes/mcpServer.test.ts src/services/aiAgentSdk.test.ts src/db/autoMigrate.test.ts src/services/migrationRlsScope.test.ts`.
- [ ] **Step 4: Commit and open PR A** — body: summary, `Part of #5216`, the spec path, the verify-as-`breeze_app` forge output from step 2, and the standard footer. Run `pr-review-toolkit:review-pr` once; fix confirmed findings inline.

---

## PR B — External Tier 3 tools via action intents

### Task B1: `action_intents` external-tool binding (migration + schema + export policy)

**Files:**
- Create: `apps/api/migrations/2026-10-14-100100-action-intents-external-tool.sql`
- Modify: `apps/api/src/db/schema/actionIntents.ts`, `apps/api/src/services/tenantExportPolicyRegistry.ts` (`action_intents` entry: add `tool_source_tool_id`, `tool_revision` to `included`)

- [ ] **Step 1: Failing schema test** (`actionIntents.test.ts` or a new sibling): columns `toolSourceToolId`, `toolRevision` exist. Run → FAIL.
- [ ] **Step 2: Migration**
```sql
-- External (tenant tool-source) binding for Tier-3 intents — spec 2026-09-07 §6.5/§8, W1 PR B.
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS tool_source_tool_id uuid REFERENCES tool_source_tools(id) ON DELETE SET NULL;
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS tool_revision text;
CREATE INDEX IF NOT EXISTS action_intents_tool_source_tool_id_idx ON action_intents (tool_source_tool_id) WHERE tool_source_tool_id IS NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'action_intents_external_tool_chk' AND conrelid = 'action_intents'::regclass) THEN
    ALTER TABLE action_intents ADD CONSTRAINT action_intents_external_tool_chk CHECK ((tool_source_tool_id IS NULL) = (tool_revision IS NULL));
  END IF;
END $$;
```
Drizzle: `toolSourceToolId: uuid('tool_source_tool_id').references(() => toolSourceTools.id, { onDelete: 'set null' }), toolRevision: text('tool_revision'),` (import from `./toolSources`). Export policy: both columns → `included`.
- [ ] **Step 3: Run** schema test + `autoMigrate.test.ts` + (real DB) `tenant-export-policy.integration.test.ts` → PASS. **Step 4: Commit.**

### Task B2: `createActionIntent` accepts an external tool binding

**Files:**
- Modify: `apps/api/src/services/actionIntents/intentService.ts` (`CreateActionIntentInput` ~113; guardrail block ~768-800; insert values)
- Test: `apps/api/src/services/actionIntents/intentService.test.ts` (extend)

**Interfaces (Produces):** `CreateActionIntentInput.externalTool?: { toolSourceToolId: string; revision: string; sourceName: string }`. When set: skip `checkGuardrails`; require `source !== 'ai_agent'` (agents cannot mint external intents in W1 → `ActionIntentError('external_tool_not_allowed_for_agent')`); tier is 3, `approvalScope = 'supervised'`, `classificationVersion` as the existing Tier-3 supervised branch sets it; `targetSummary = `${toolName} (external tool from ${sourceName})``; `impactSummary` = the input keys; write `toolSourceToolId`/`toolRevision`; `policyDecisionState` must resolve to human-required (the existing resolver keys on `isPolicyDecidableKey(toolName)`, which never matches a `__` name — assert it in the test rather than trusting it).

- [ ] **Step 1: Failing tests**: external intent is created with tier 3/supervised and the two columns; agent principal + externalTool → error; `checkGuardrails` not called for external intents (spy); policy decision state is human-required.
- [ ] **Step 2: Implement. Step 3: Run → PASS. Step 4: Commit.**

### Task B3: Release-time revalidation for external tools

**Files:**
- Modify: `apps/api/src/services/actionIntents/revalidateRelease.ts` (~208 `getToolTier(intent.actionName)`)
- Test: `revalidateRelease.test.ts` (extend)

- [ ] **Step 1: Failing tests**: an intent with `toolSourceToolId` whose current row is enabled, source active, revision equal → ok; revision differs → `{ ok: false, errorCode: 'external_tool_drift' }`; tool disabled or removed → `external_tool_disabled`; source status `error`/`disabled` → `external_tool_source_unavailable`; a core intent path unchanged (existing tests still pass).
- [ ] **Step 2: Implement**: before the `getToolTier` line, `if (intent.toolSourceToolId) { const live = await loadTenantToolForExecution(intent.toolSourceToolId); … }` returning the codes above; on success continue with `currentTier = 3`.
- [ ] **Step 3: Run → PASS. Step 4: Commit.**

### Task B4: Chat Tier 3 for external tools

**Files:**
- Modify: `apps/api/src/services/aiAgentSdk.ts` (remove the "next release" denial; in the Tier-3 `createActionIntent` call pass `externalTool` when `tenant` is set), `apps/api/src/services/toolSources/sdkBridge.ts` (no change expected — after approval the wrapped handler executes `executeTenantTool`)
- Test: `aiAgentSdk.test.ts` (extend), `sdkBridge.test.ts`

- [ ] **Step 1: Failing test**: tier-3 tenant tool → `createActionIntent` called with `{ toolName: 'hudu__create_asset', source: 'chat', externalTool: { toolSourceToolId, revision, sourceName } }`; after the mocked decision resolves `approved` the callback returns `{ allowed: true }`; `rejected` → denied.
- [ ] **Step 2: Implement**; the description passed as `reason` is `guardrailCheck.description`. **Step 3: Run → PASS; tsc; lint. Step 4: Commit; open PR B** (`Part of #5216`, stacked on PR A; `gh workflow run CI --ref <branch>`; one review round).

---

## PR C — Web: Tool Sources pages

### Task C1: i18n namespace and typed API client

**Files:**
- Create: `apps/web/src/locales/en/toolSources.json` and the same file (English copy) in `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`
- Create: `apps/web/src/components/toolSources/api.ts`, `api.test.ts`

Keys (all under `toolSources`): `nav`, `title`, `subtitle`, `empty.title`, `empty.body`, `list.name`, `list.kind`, `list.status`, `list.tools`, `list.lastDiscovered`, `list.allOrgs`, `form.create`, `form.edit`, `form.name`, `form.slug`, `form.slugHelp`, `form.kind`, `form.kindOpenapiSoon`, `form.endpoint`, `form.authKind`, `form.auth.none`, `form.auth.bearer`, `form.auth.apiKeyHeader`, `form.auth.basic`, `form.auth.oauth2`, `form.auth.token`, `form.auth.headerName`, `form.auth.value`, `form.auth.username`, `form.auth.password`, `form.auth.tokenUrl`, `form.auth.clientId`, `form.auth.clientSecret`, `form.auth.scope`, `form.rateLimit`, `form.scope`, `form.allOrganizations`, `form.thisOrganizationOnly`, `form.partnerWideWarning` ("A partner-wide source exposes everything this credential can reach in {{vendor}} to every organisation's AI chat and flows. Use an organisation-owned source when the vendor issues per-customer credentials."), `form.save`, `form.cancel`, `detail.rediscover`, `detail.delete`, `detail.deleteConfirm`, `detail.status.active`, `detail.status.error`, `detail.status.disabled`, `tools.name`, `tools.description`, `tools.proposedTier`, `tools.tier`, `tools.enabled`, `tools.reviewNeeded`, `tools.removed`, `tools.notAddressable`, `tools.enableReads`, `tools.disableAll`, `tools.test`, `tools.tier1`, `tools.tier2`, `tools.tier3`, `test.title`, `test.input`, `test.run`, `test.result`, `toasts.created`, `toasts.saved`, `toasts.deleted`, `toasts.discoveryQueued`, `toasts.toolUpdated`, `toasts.saveFailed`, `toasts.loadFailed`, `toasts.testFailed`.

`api.ts` exports typed wrappers over `fetchWithAuth` + `runAction`: `listToolSources()`, `getToolSource(id)`, `createToolSource(body)`, `updateToolSource(id, body)`, `deleteToolSource(id)`, `discoverToolSource(id)`, `listSourceTools(id)`, `patchSourceTool(id, toolId, body)`, `bulkTools(id, mode)`, `testSourceTool(id, toolId, input)`; every mutation goes through `runAction` with `successMessage`/`errorFallback` from the namespace.

- [ ] **Step 1: Failing test** `api.test.ts`: `createToolSource` posts `ownerScope` and `orgId` only for organisation scope (mock `fetchWithAuth` as `AddPackageModal.ownerScope.test.tsx` does); `patchSourceTool` PATCHes `/tool-sources/:id/tools/:toolId`. Run `localeParity.test.ts` → FAIL until all 8 files exist.
- [ ] **Step 2: Implement; Step 3: Run** `npx vitest run src/components/toolSources src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts` → PASS. **Step 4: Commit.**

### Task C2: Nav entry, pages, feature gate

**Files:**
- Create: `apps/web/src/pages/settings/tool-sources.astro`, `apps/web/src/pages/settings/tool-sources/[id].astro` (9-line Astro shells like `pages/integrations/index.astro`, `client:load` islands `ToolSourcesPage` / `ToolSourceDetail` with `sourceId={Astro.params.id}`)
- Modify: `apps/web/src/components/layout/Sidebar.tsx` (Settings array: `{ name: 'Tool Sources', labelKey: 'nav.toolSources', href: '/settings/tool-sources', icon: Plug, requiresToolSources: true }`; filter on a `toolSourcesEnabled` state read from `GET /config` `features.toolSources` — reuse the component that already fetches `/config` for `registration.enabled` (grep `registration.enabled` under `apps/web/src`) and expose a `useServerFeatures()` hook from `apps/web/src/hooks/useServerFeatures.ts` if none exists)
- Modify: `apps/web/src/locales/*/common.json` (or wherever `nav.*` lives) — `nav.toolSources`.

- [ ] **Step 1: Failing Sidebar test** (extend the existing Sidebar test file): with `/config` returning `features.toolSources: true` the item renders; `false` hides it. **Step 2: Implement. Step 3: Run + locale parity → PASS. Step 4: Commit.**

### Task C3: List page and create/edit form

**Files:**
- Create: `apps/web/src/components/toolSources/ToolSourcesPage.tsx`, `ToolSourceForm.tsx`, `ToolSourceForm.test.tsx`

Behaviour: list in a `ResponsiveTable` (name, kind badge, status chip, `enabledToolCount/toolCount`, last discovered, `ScopeBadge` for partner-wide); empty state; "Add source" opens `Dialog` with `ToolSourceForm`. Form: name; slug auto-derived from name (`lowercase, strip non [a-z0-9], max 24`) and editable; kind select with `openapi` disabled + "coming next release"; endpoint; authKind select driving conditional fields; rate limit; ownerScope radios (create only) via `useDefaultOwnerScope`, defaulting per that hook; when `partner` is chosen show `form.partnerWideWarning` with the source name interpolated as `{{vendor}}`; submit via `createToolSource`/`updateToolSource`; `data-testid` prefix `tool-source-`.

- [ ] **Step 1: Failing tests**: renders owner radios for partner scope defaulted to partner and shows the warning; submitting posts `ownerScope: 'partner'`, `authKind: 'bearer'`, `authConfig.token`; org scope posts `orgId`; slug auto-derivation from "Hudu Docs" → `hududocs`; kind select offers `openapi` disabled. **Step 2: Implement. Step 3: Run + `no-silent-mutations.test.ts` → PASS. Step 4: Commit.**

### Task C4: Detail page, discovered tools table, test drawer

**Files:**
- Create: `apps/web/src/components/toolSources/ToolSourceDetail.tsx`, `DiscoveredToolsTable.tsx`, `DiscoveredToolsTable.test.tsx`, `ToolTestDrawer.tsx`

Behaviour: header (name, slug, endpoint, status chip with `lastError`, last discovered, Re-discover button, Edit, Delete via `ConfirmDialog`); tools table: name, description (truncated with title), proposed tier `RiskTierBadge`-style chip, tier `<select>` (1/2/3), enabled `Switch`, flags (review needed / removed / not addressable) as small chips; row actions: Test (Tier 1 only) opens `ToolTestDrawer` (JSON textarea seeded with `{}` and the schema's required keys, Run, result `<pre>`); toolbar: Enable all reads, Disable all; polling: after Re-discover, refetch tools every 3 s for up to 60 s until `lastDiscoveredAt` changes. All mutations through the `api.ts` wrappers (`runAction`).

- [ ] **Step 1: Failing tests**: toggling the switch calls `patchSourceTool` with `{ enabled: true }`; changing tier select calls with `{ tier: 2 }`; Test button hidden for tier 3; removed tool's switch is disabled; "Enable all reads" calls `bulkTools(id, 'enable_reads')`. **Step 2: Implement. Step 3: Run + `astro check` + `no-silent-mutations` → PASS. Step 4: Commit.**

### Task C5: Docs page

**Files:**
- Create: `apps/docs/src/content/docs/features/tool-sources.mdx` (frontmatter like `psa-integrations.mdx`; sections: what it is, adding an MCP source, tiers and what each means for approvals, enabling tools, partner-wide vs organisation-owned and the cross-customer credential caveat, testing a tool, troubleshooting `error` status, the `TOOL_SOURCES_ENABLED` flag for self-hosters). Link from the AI docs page's tool section.

- [ ] **Step 1: Write; Step 2: `cd apps/docs && pnpm build` (or `astro check`) → clean; Step 3: Commit.**

### Task C6: PR C wrap-up

- [ ] Run `cd apps/web && npx vitest run src/components/toolSources src/components/layout src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts && npx astro check && pnpm lint`.
- [ ] Boot the worktree stack (`worktree-stack` skill) with `TOOL_SOURCES_ENABLED=true`, register a source pointing at a public test MCP server if one is available to the stack's egress (otherwise verify the `error` status path renders), enable a tool, confirm it appears in AI chat's tool list and the Tool Sources UI round-trips tier/enabled. Record screenshots in the PR.
- [ ] Open PR C (`Closes #5216`, stacked; `gh workflow run CI --ref <branch>`), one review round, merge PR A → B → C in order with bare `gh pr merge --squash`.

---

## Self-review (done at authoring)

- **Spec coverage (W1 row + §5, §8):** tables/RLS/cascade/export/merge (A2, A3); discovery + tier proposal + untrusted annotations + never-lower (A6); resolver/descriptor + per-auth visibility (A8); executor with egress guard, origin pinning, redaction, caps, audit (A4, A5, A8); permissions generic policy (A1, A8, A10); chat + MCP surfaces (A10); Tier 3 via intents with drift (B1–B4); routes + UI + docs (A9, C1–C5); flag (A7); integration RLS suite (A11). Not in W1 by design: OpenAPI kind (W2), caching (amendment 4), agents calling tenant tools (agents' `toolAllowlist` validation against the resolver — W5 with flows-as-tools).
- **Main drift check (2026-09-07):** anchors re-verified against origin/main after the worktree turned out to be ~300 commits behind (`extraTools` param, `TOOL_TIERS` gate, `handleToolsList`, `intentService` guardrail call, `revalidateRelease` tier read, `softwarePolicyAccessCondition`, `canManagePartnerWidePolicies`, export/encrypted-column entries all present); the two rules main added since the fork (partner-wide SELECT branch; migration ceiling `2026-10-13-110000`) are folded in above.
- **Placeholders:** none — every task has test content and code or exact anchors. Two judgment points are named, not deferred: the `roles` predicate in the permissions migration (mirror the 2026-09-25-b file) and where the web reads `/config` (grep `registration.enabled`).
- **Type consistency:** `TenantToolDescriptor`, `resolveTenantTools`, `resolveTenantToolByName`, `loadTenantToolForExecution`, `executeTenantTool`, `guardrailCheckForTenantTool`, `tenantToolPermissionRequirement`, `checkTenantToolRateLimit`, `buildTenantSdkTools`, `tenantMcpToolNames`, `enqueueToolSourceDiscovery`, `isTenantToolName`, `qualifiedToolName` are used with the same names and shapes in A8, A9, A10, B2–B4.
