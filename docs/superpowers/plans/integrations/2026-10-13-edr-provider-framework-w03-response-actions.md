---
tracking_issue: LanternOps/breeze#8164
---
# EDR W03 — Response Actions + AI + Push Hints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an MSP technician (and, through approval-gated AI tools, the assistant) isolate, release and scan a GravityZone-managed endpoint from Breeze, with one audited `edr_actions` row per target. Also add vendor push events as "sync now" hints.

**Architecture:** Every action goes through one service, `dispatchEdrAction` (`services/edrProviders/actions.ts`). It runs in this order:
1. Resolve the target under the caller's RLS context, with org reach and site restriction.
2. Check every gate: kill switches, connection state, capability, rate limit.
3. Insert the `queued` row and the audit row, then commit.
4. Call the vendor outside any DB context, with no retry.
5. Write the outcome.

A new `sync-action-status` job type completes async vendor tasks. It also reconciles rows whose outcome is unknown, and it never re-sends. AI tools are thin wrappers keyed by normalized action. Tier-3 actions are reached only through the existing action-intent release paths (`createActionIntent` → `IntentReleaseWorker` / inline chat release). Push events are hints only: the webhook records "this connection has news" and enqueues the existing detection sync. The webhook never writes vendor content.

**Tech Stack:** Hono, Drizzle (queries only), PostgreSQL RLS, BullMQ, Redis, Vitest, Astro + React islands, `runAction`.

**Spec:** `docs/superpowers/specs/integrations/2026-09-30-edr-provider-framework-spec.md` §4.3, §4.4, §4.8, §4.10, §4.11, D6, D7. **Read the index first** (`2026-10-01-edr-provider-framework-index.md`: W03 section, corrections 1, 5, 11). W01 (#8220, #8259) and W02 (#8653, #8666) are merged; this plan was written against `origin/main` at `e477a323f1` (2026-10-13).

Epic: #8164 · Wave sub-issue: #8167. PR bodies say `Refs #8167` / `Part of #8164`; only the last PR of the wave carries `Closes #8167`. Branches: `feature/8164-edr-provider-framework/wave-8167` (PR-A) and `…/wave-8167-push-web` (PR-B, branched from main after PR-A merges; if stacked, see the index's stacked-PR CI trap).

## PR split (deviation from the requested split — Open Decision 1)

The ask was **PR-A = API** (action model, adapter methods, routes, audit, intent gating) and **PR-B = web + AI tools + push hints**. One CI contract forces a change. `__tests__/mcp-coverage.test.ts` fails for a new route file that has neither a tool nor a real exemption, and it freezes `gap` entries ("gaps may only be burned down"). So `routes/edr/actions.ts` can only ship with its tools. A fake exemption would be dishonest: the index's correction 5 rejected this exact shortcut for the detection route.

- **PR-A — API, actions and action AI tools** (high blast radius, full rigor): migration 1, adapter action contract, GravityZone action methods, `dispatchEdrAction`, status/reconcile job, `/edr/actions` routes, the per-connection actions switch, the two action AI tools (`edr_endpoint_action`, `edr_detection_action`) with every guardrail/intent registration, contract tests, and the #8658 fix.
- **PR-B — push hints, `sync_edr_data`, web**: migration 2, GravityZone `verifyWebhook` and push-settings methods, durable hint marker plus job coordination, public webhook route, push opt-in routes, the `sync_edr_data` Tier-2 tool, and the web action buttons and connection toggles.

This matches the index's own W03 split ("(1) Actions + AI, (2) Webhook / push").

## Global Constraints

- **No action without all five gates:** (1) env kill switch `BREEZE_EDR_ACTIONS_ENABLED` is true; (2) `edr_connections.actions_enabled` is true; (3) the connection is `is_active` and `status <> 'reauth_required'`; (4) the adapter declares the action and `supportsAction` returns `{ ok: true }`; (5) the caller passes `devices.execute` + `requireMfa()` and the site/org reach checks. Each gate gets its own negative test.
- **The vendor is never called twice for one `edr_actions` row.** The vendor call is not retried in-process (GravityZone client write calls use `retry: false`). The reconciler never re-sends. An ambiguous outcome stays `queued` with `error = 'dispatch_outcome_unknown'` until it is reconciled or failed.
- **No pooled DB connection is held across vendor HTTP** (#1105 / #1896). Every vendor call runs under `runOutsideDbContext`, and every enqueue from a request path does too.
- **`edr_actions` has one INSERT site:** `services/edrProviders/actions.ts`. A contract test pins this, in the same way as `aiDispatch.contract.test.ts` `INSERT_CHOKEPOINTS`.
- **`requested_by` is always a real `users.id` or NULL, never an AI-agent id.** AI rows carry `requested_via='ai'`, `ai_session_id = auth.aiOrigin.sessionId ?? null` and `approval_id = context.actionIntentId ?? null`. Tier-3 AI handlers refuse when `context.actionIntentId` is absent.
- **The portal never exposes actions.** No `apps/portal/**` or `routes/portal/**` file imports `edrProviders/actions` or names `/edr/actions` (contract test). Portal tokens cannot reach `/edr/*`.
- **The webhook payload is a hint, not data.** Nothing from a push body is persisted except the connection's `pending_hint_at` timestamp and the bounded Redis hint set. A forged-but-authenticated push can at worst cause an extra poll.
- **Tier tables are literals.** `aiTools.userOwnedRelease.contract.test.ts` and the tier-parity suites parse `aiGuardrails.ts` as source text, so a spread or derived entry is invisible to them. Write each `edr_*_action` entry out by hand.
- **No `z.undefined()`** in any AI tool schema. Description budget 300/160 (`aiTools.descriptionBudget.contract.test.ts`, shrink-only).
- **Line-keyed contract trap:** `ACTION_GUARD_ALIASES` / `SAFE_WRITE_SITES` in `aiTools.userOwnedRelease.contract.test.ts` are keyed by `file:line`. Re-key them after any edit above the dispatch line in `aiToolsEdr.ts`.
- **Web:** every mutation goes through `runAction` (`no-silent-mutations.test.ts`). New `en` keys go into all **8** locale dirs (`en, de-DE, es-419, fr-CA, fr-FR, it-IT, pt-BR, tr-TR`). `localeParity` lives in `src/lib/i18n`.
- **Public repo:** no customer names, hostnames, IPs, API keys, session ids, or GravityZone account names in code, fixtures or PR text. Fixtures are synthetic.
- **Tests:** API `cd apps/api && npx vitest run <files>` (no `--` before flags); web `cd apps/web && npx vitest run <files>`. Typecheck `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p .` and check the exit code; never pipe it to `tail`.

## Migration & tenancy statement

Two migrations, one per PR. Both are DDL only, so neither has a `set_config('breeze.scope','system',true)` preamble and neither goes into the `migrationRlsScope.test.ts` baseline. Both are idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE UNIQUE INDEX IF NOT EXISTS`) with no `BEGIN`/`COMMIT`. **No new table**, so there is no new RLS policy and no `rls-coverage` / `CORE_ORG_CASCADE_DELETE_ORDER` / `orgMergeRegistry` / device-list change: `edr_actions`, `edr_tenants` and `edr_connections` are already registered by W01a.

**Slot — re-check at dispatch time.** At plan time the newest committed migration on `origin/main` is `2026-12-27-000000-topology-presence-days-and-confirmation.sql`, so PR-A uses `2026-12-28-100000-edr-actions-controls.sql`. Before committing and again before pushing, run `git fetch -q origin main && git ls-tree --name-only origin/main apps/api/migrations/ | grep '\.sql$' | sort | tail -3` and rename to sort after the newest. Never use `2026-08-06-g-`. PR-B takes the next free slot after whatever is newest when PR-B is cut (indicatively `2026-12-28-110000-edr-push-hints.sql`).

**Migration 1 (PR-A) — `edr-actions-controls`:**

| Change | Table | Cascade / export obligation |
|---|---|---|
| `actions_enabled boolean NOT NULL DEFAULT false` | `edr_connections` (shape 3, **no `org_id`**) | none — the table is not in `CORE_ORG_CASCADE_DELETE_ORDER`, so it has no export-policy entry (`tenantExportPolicyRegistry.ts:467-469` comment) |
| `unsupported_actions text[] NOT NULL DEFAULT '{}'`, `unsupported_actions_at timestamptz` | `edr_tenants` (org-cascade table) | **`CORE_TENANT_EXPORT_POLICY` `edr_tenants` row: add both to `included`** (`tenantExportPolicyRegistry.ts:470`). Neither name hits `SUSPICIOUS_NAME_PARTS`; text[] and timestamptz are not open containers. |
| `CREATE UNIQUE INDEX edr_actions_inflight_endpoint_uniq ON edr_actions (endpoint_id, action) WHERE status IN ('queued','submitted') AND endpoint_id IS NOT NULL` | `edr_actions` | index only — no column, so no export-policy change |
| `CREATE UNIQUE INDEX edr_actions_inflight_detection_uniq ON edr_actions (detection_id, action) WHERE status IN ('queued','submitted') AND detection_id IS NOT NULL` | `edr_actions` | index only |

Pre-index cleanup: W01/W02 never write `edr_actions`, so no in-flight duplicates can exist. The migration still runs a `DO $$ … GET DIAGNOSTICS … RAISE WARNING` count of `(endpoint_id, action)` duplicates among in-flight rows and **fails** (RAISE EXCEPTION) if any are found, instead of silently deleting evidence. This follows the migration README's row-count rule.

`approval_id` / `ai_session_id` **stay plain uuids with no FK** (the W01 migration header deferred this to W03). `action_intents` and `ai_sessions` are retained and erased on their own schedules. An FK would need `DEFERRABLE` plus cascade ordering against `edr_actions` for no audit gain: the ledger row must outlive a pruned intent.

**Migration 2 (PR-B) — `edr-push-hints`:** `edr_connections.push_enabled boolean NOT NULL DEFAULT false`, `push_registered_at timestamptz`, `pending_hint_at timestamptz`. All three are on the no-`org_id` table, so there is **no export-policy row** (Open Decision 3: the index planned `edr_tenants.pending_hint_at`).

**Verification (both PRs):** `pnpm db:check-drift` clean; on `pnpm test-stack up` run `tenant-export-policy.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts`, `tenantCascade.integration.test.ts`, `edrProviderRls.integration.test.ts`, `pnpm --filter @breeze/api test:rls-coverage`, then `pnpm test-stack down`. These suites only fail under **Integration Tests**, not Test API.

## Review Focus

1. **Double submit / two technicians / human + AI at once** on the same endpoint and action. Expected: one vendor task; the second request gets 409 `action_in_progress`, not a second isolate. Pinned in A6 (unique-violation mapping) and A13 (real Postgres 23505).
2. **The vendor accepted the isolate but the response was lost** (timeout, socket reset, 5xx after send). Expected: the row stays `queued`/`dispatch_outcome_unknown`, the UI says "outcome unknown — checking", the reconciler settles it from `isIsolated`, and **nothing re-sends**. Pinned in A3 (no-retry client) and A8 (reconciler).
3. **A site-restricted or selected-org technician acting on an endpoint they cannot see**, including through the AI tool's `deviceId` and through an endpoint whose device link was cleared by an org move. Expected: 403/404 with no row and no vendor call. Pinned in A6 and A11.
4. **An autonomous agent's Tier-2 `scan`** (the agent Tier-2 lane mints a supervised intent). Expected: the release runs as the approving human, `requested_by` is that human, and `approval_id` is the intent. It is never the agent id (23503) and never a NULL-with-no-provenance row. Pinned in A11.
5. **A customer company without the incidents/EDR licence.** Expected: the first attempt fails cleanly (`licence`) and records the denial; later attempts and the UI show the action disabled with a reason and make no vendor call, until the denial expires (24 h) or an inventory run clears it. Pinned in A4 and A6.

---

# PR-A — API, actions, action AI tools

## File Structure (PR-A)

| File | Change |
|---|---|
| `apps/api/migrations/2026-12-28-100000-edr-actions-controls.sql` | Create (slot: re-check) |
| `apps/api/src/db/schema/edrProviders.ts` | `actionsEnabled`, `unsupportedActions`, `unsupportedActionsAt`, two partial unique indexes |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | `edr_tenants` included += 2 columns |
| `packages/shared/src/types/edr.ts` | `EDR_ENDPOINT_ACTIONS`, `EDR_DETECTION_ACTIONS`, `EdrActionDto`, `EdrEndpointActionAvailability` |
| `apps/api/src/services/edrProviders/types.ts` | Typed `EdrActionRequest`, `EdrActionResult`, `EdrActionSupport`, `performAction` / `supportsAction` / `getActionStatus` / `reconcileAction` signatures |
| `apps/api/src/services/edrProviders/context.ts` | `buildEdrAdapterContext(..., { maxWaitMs })` |
| `apps/api/src/services/edrProviders/bitdefender/client.ts` | `CallOptions.retry` / `requestId`; `createIsolateEndpointTask`, `createRestoreEndpointFromIsolationTask`, `createScanTask`, `getScanTaskStatus` |
| `apps/api/src/services/edrProviders/bitdefender/adapter.ts` | `actions`, `operationBudgets.actions`, `supportsAction`, `performAction`, `getActionStatus`, `reconcileAction` |
| `apps/api/src/services/edrProviders/bitdefender/__fixtures__/action-*.json` | Create (synthetic; `[U]` branches) |
| `apps/api/src/services/edrProviders/actionGates.ts` | Create — kill switches, `edrActionsEnabled()`, Breeze-side rate limits |
| `apps/api/src/services/edrProviders/actionErrors.ts` | Create — vendor error → action outcome / HTTP mapping |
| `apps/api/src/services/edrProviders/actions.ts` | Create — `resolveEdrActionTargets`, `dispatchEdrAction` (the only `edr_actions` INSERT) |
| `apps/api/src/services/edrProviders/actionStatus.ts` | Create — `pollEdrActionStatus` (async completion + reconcile) |
| `apps/api/src/jobs/edrProviderSync.ts` | `sync-action-status` job type; `sync-all` enqueues it for connections with open actions; inventory run clears expired tenant denials |
| `apps/api/src/config/env.ts` (+ compose files per `envComposeParity.test.ts`) | `edrActionsEnabled()` reads `BREEZE_EDR_ACTIONS_ENABLED` at call time |
| `apps/api/src/routes/edr/actions.ts` | Create — `POST /edr/actions`, `GET /edr/actions` |
| `apps/api/src/routes/edr/connections.ts` | PATCH accepts `actionsEnabled` (partner admin + MFA, audited) |
| `apps/api/src/routes/edr/endpoints.ts` | Endpoint rows carry `actions: EdrEndpointActionAvailability[]` |
| `apps/api/src/routes/edr/index.ts` | Mount actions |
| `apps/api/src/services/edrProviders/read.ts` | #8658 selected-org coverage fix |
| `apps/api/src/services/aiToolsEdr.ts` | `edr_endpoint_action`, `edr_detection_action` |
| `aiTools.ts` (deviceArgs map), `aiToolSchemas.ts`, `aiGuardrails.ts`, `aiToolRateLimits.ts`, `aiAgentSdkTools.ts`, `aiToolOutput.ts`, `aiAgents/agentToolCatalog.ts`, `mcpCoverage.ts`, `llm/toolEval/agentGoldenTasks.ts`, `jobs/intentReleaseWorker.ts` | Register (Task A11) |
| `apps/api/src/services/edrProviders/edrActions.chokepoint.contract.test.ts` | Create |
| `apps/api/src/__tests__/integration/edrActions.integration.test.ts` | Create |

---
### Task A1: Migration 1 + schema + export policy

**Files:**
- Create: `apps/api/migrations/2026-12-28-100000-edr-actions-controls.sql` (slot: re-check)
- Modify: `apps/api/src/db/schema/edrProviders.ts`, `apps/api/src/services/tenantExportPolicyRegistry.ts:470`
- Test: `apps/api/src/db/schema/edrProviders.test.ts`, `apps/api/src/__tests__/integration/edrActions.integration.test.ts` (created here, extended in A14)

**Interfaces:**
- Produces: `edrConnections.actionsEnabled: boolean`, `edrTenants.unsupportedActions: EdrActionKey[]`, `edrTenants.unsupportedActionsAt: Date | null`; index names `edr_actions_inflight_endpoint_uniq`, `edr_actions_inflight_detection_uniq` (A6 maps 23505 on these to 409).

- [ ] **Step 1: Write the failing schema test** (append to `edrProviders.test.ts`)

```ts
it('W03: connection actions switch defaults off; tenant denial columns exist', () => {
  const c = getTableColumns(edrConnections).actionsEnabled;
  expect(c.notNull).toBe(true);
  expect(c.default).toBe(false);
  expect(getTableColumns(edrTenants).unsupportedActions.notNull).toBe(true);
  expect(getTableColumns(edrTenants).unsupportedActionsAt.notNull).toBe(false);
});

it('W03: in-flight action identity is unique per target + action (partial)', () => {
  const names = getTableConfig(edrActions).indexes.filter((i) => i.config.unique).map((i) => i.config.name);
  expect(names).toEqual(expect.arrayContaining(['edr_actions_inflight_endpoint_uniq', 'edr_actions_inflight_detection_uniq']));
  for (const i of getTableConfig(edrActions).indexes.filter((x) => x.config.name?.startsWith('edr_actions_inflight_'))) {
    expect(i.config.where, i.config.name).toBeDefined();
  }
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `cd apps/api && npx vitest run src/db/schema/edrProviders.test.ts`
Expected: FAIL (`actionsEnabled` undefined).

- [ ] **Step 3: Write the migration**

```sql
-- EDR W03 (#8167 / epic #8164): response-action controls.
--   * edr_connections.actions_enabled — per-connection opt-in (defaults OFF). An
--     MSP must explicitly turn actions on for a vendor console; partner-admin +
--     MFA write (routes/edr/connections.ts). No org_id on this table, so no
--     tenant-export-policy entry.
--   * edr_tenants.unsupported_actions / unsupported_actions_at — the last vendor
--     licence/API denial per customer company, so the UI renders the action
--     disabled-with-reason and dispatch refuses pre-insert. Expires after 24 h
--     and is cleared by a successful inventory run. Classified `included` in
--     CORE_TENANT_EXPORT_POLICY in the same PR.
--   * In-flight uniqueness on edr_actions: one queued/submitted row per
--     (target, action), so a double click / two techs / AI + human produce one
--     vendor task and one 409.
-- DDL only: no breeze.scope preamble, not in the migrationRlsScope baseline.
-- approval_id / ai_session_id deliberately stay FK-less (plan W03, migration section).

ALTER TABLE edr_connections ADD COLUMN IF NOT EXISTS actions_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE edr_tenants ADD COLUMN IF NOT EXISTS unsupported_actions text[] NOT NULL DEFAULT '{}';
ALTER TABLE edr_tenants ADD COLUMN IF NOT EXISTS unsupported_actions_at timestamptz;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM (
    SELECT endpoint_id, action FROM edr_actions
     WHERE status IN ('queued', 'submitted') AND endpoint_id IS NOT NULL
     GROUP BY endpoint_id, action HAVING count(*) > 1
    UNION ALL
    SELECT detection_id, action FROM edr_actions
     WHERE status IN ('queued', 'submitted') AND detection_id IS NOT NULL
     GROUP BY detection_id, action HAVING count(*) > 1
  ) d;
  RAISE WARNING 'edr_actions in-flight duplicate groups before unique index: %', n;
  IF n > 0 THEN
    RAISE EXCEPTION 'edr_actions has % in-flight duplicate groups; resolve by hand (evidence rows) before re-running', n;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS edr_actions_inflight_endpoint_uniq
  ON edr_actions (endpoint_id, action)
  WHERE status IN ('queued', 'submitted') AND endpoint_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS edr_actions_inflight_detection_uniq
  ON edr_actions (detection_id, action)
  WHERE status IN ('queued', 'submitted') AND detection_id IS NOT NULL;

COMMENT ON COLUMN edr_connections.actions_enabled IS 'W03: response actions allowed through this vendor console (opt-in, default off)';
COMMENT ON COLUMN edr_tenants.unsupported_actions IS 'W03: actions the vendor refused for this company (licence/API); expires after 24h';
```

- [ ] **Step 4: Schema**

```ts
// edrConnections
actionsEnabled: boolean('actions_enabled').notNull().default(false),
// edrTenants
unsupportedActions: text('unsupported_actions').array().notNull().default(sql`'{}'::text[]`).$type<EdrActionKey[]>(),
unsupportedActionsAt: timestamp('unsupported_actions_at', { withTimezone: true }),
// edrActions table callback
inflightEndpointUniq: uniqueIndex('edr_actions_inflight_endpoint_uniq')
  .on(table.endpointId, table.action)
  .where(sql`${table.status} IN ('queued', 'submitted') AND ${table.endpointId} IS NOT NULL`),
inflightDetectionUniq: uniqueIndex('edr_actions_inflight_detection_uniq')
  .on(table.detectionId, table.action)
  .where(sql`${table.status} IN ('queued', 'submitted') AND ${table.detectionId} IS NOT NULL`),
```

Export policy, `edr_tenants` `included`: append `"unsupported_actions","unsupported_actions_at"`.

- [ ] **Step 5: Integration test (red first on the test stack)** in `edrActions.integration.test.ts`: replay the migration twice (idempotent), insert two `queued` rows for the same `(endpoint_id,'isolate')` as system and expect `23505` on the second, then expect the same pair with the first row `failed` to succeed.

- [ ] **Step 6: Run**

`cd apps/api && npx vitest run src/db/schema/edrProviders.test.ts` → PASS; `pnpm db:check-drift` → clean; on test stack: `npx vitest run -c vitest.integration.config.ts src/__tests__/integration/edrActions.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts` → PASS.

- [ ] **Step 7: Commit** `feat(edr): W03 migration — actions switch, tenant denials, in-flight uniqueness (#8167)`

---

### Task A2: Typed action contract (shared + adapter interface)

**Files:**
- Modify: `packages/shared/src/types/edr.ts`, `apps/api/src/services/edrProviders/types.ts`, `apps/api/src/services/edrProviders/context.ts`
- Test: `packages/shared/src/types/edr.test.ts` (create if absent), `apps/api/src/services/edrProviders/context.test.ts`

**Interfaces:**
- Produces (shared):
  ```ts
  export const EDR_ENDPOINT_ACTIONS = ['isolate', 'unisolate', 'scan', 'update_agent', 'kill_process'] as const;
  export const EDR_DETECTION_ACTIONS = ['rollback', 'resolve_detection', 'mark_false_positive', 'quarantine_restore', 'quarantine_delete'] as const;
  export type EdrEndpointActionKey = (typeof EDR_ENDPOINT_ACTIONS)[number];
  export type EdrDetectionActionKey = (typeof EDR_DETECTION_ACTIONS)[number];
  export interface EdrEndpointActionAvailability { action: EdrActionKey; available: boolean; reason: string | null }
  export interface EdrActionDto {
    id: string; orgId: string; provider: string; action: EdrActionKey; status: EdrActionStatus;
    requestedVia: EdrActionRequestedVia; requestedBy: string | null; aiSessionId: string | null; approvalId: string | null;
    endpointId: string | null; detectionId: string | null; breezeDeviceId: string | null;
    error: string | null; outcomeUnknown: boolean; requestedAt: string; submittedAt: string | null; completedAt: string | null;
  }
  ```
- Produces (API `types.ts`):
  ```ts
  export type EdrActionRequest =
    | { action: 'isolate' | 'unisolate' | 'scan' | 'update_agent'; target: { kind: 'endpoint'; vendorEndpointId: string } }
    | { action: 'kill_process'; target: { kind: 'process'; vendorEndpointId: string; pid: number } }
    | { action: 'rollback' | 'resolve_detection' | 'mark_false_positive'; target: { kind: 'detection'; vendorDetectionId: string; vendorKind: EdrVendorKind } }
    | { action: 'quarantine_restore' | 'quarantine_delete'; target: { kind: 'quarantine_item'; vendorItemId: string } };
  export type EdrActionResult =
    | { status: 'succeeded' }
    | { status: 'submitted'; vendorActionId: string }
    | { status: 'failed'; code: string; message: string };   // terminal vendor verdict (getActionStatus only)
  export type EdrActionSupport = { ok: true } | { ok: false; reason: string };
  export interface EdrActionTargetFacts {
    vendorEndpointId: string | null; osPlatform: EdrOsPlatform | null; isolationState: EdrIsolationState | null;
    online: boolean | null; tenantUnsupportedActions: readonly EdrActionKey[]; connectionCapabilityNotes: readonly string[];
  }
  export type EdrReconcileVerdict = 'applied' | 'not_applied' | 'unknown';
  // on EdrProviderAdapter (replacing the W01 `...a: unknown[]` placeholders):
  performAction?(ctx: EdrAdapterContext, tenant: VendorEdrTenantRef, req: EdrActionRequest, idempotencyKey: string): Promise<Exclude<EdrActionResult, { status: 'failed' }>>;
  supportsAction?(facts: EdrActionTargetFacts, action: EdrActionKey): EdrActionSupport;
  getActionStatus?(ctx: EdrAdapterContext, tenant: VendorEdrTenantRef, vendorActionId: string): Promise<EdrActionResult | { status: 'submitted' }>;
  /** Crash/ambiguity reconciliation: did a sent-but-unconfirmed request take effect? Read-only vendor calls ONLY. */
  reconcileAction?(ctx: EdrAdapterContext, tenant: VendorEdrTenantRef, req: EdrActionRequest): Promise<EdrReconcileVerdict>;
  ```
  `buildEdrAdapterContext(adapter, { ..., maxWaitMs?: number })` passes `maxWaitMs` to `createEdrRateLimiter`.

- [ ] **Step 1: Failing tests**

```ts
// packages/shared/src/types/edr.test.ts
import { EDR_ACTIONS, EDR_DETECTION_ACTIONS, EDR_ENDPOINT_ACTIONS } from './edr';
it('endpoint + detection action sets partition EDR_ACTIONS exactly', () => {
  const union = [...EDR_ENDPOINT_ACTIONS, ...EDR_DETECTION_ACTIONS];
  expect(new Set(union).size).toBe(union.length);
  expect([...union].sort()).toEqual([...EDR_ACTIONS].sort());
});
```

```ts
// context.test.ts
it('passes maxWaitMs through to the limiter (request-path actions must not wait 60 s)', async () => {
  const redis = fakeRedisAlwaysLimited();               // existing helper pattern in rateLimiter.test.ts
  const ctx = buildEdrAdapterContext(bitdefenderAdapter, { creds: { apiKey: 'k'.repeat(20) }, baseUrl: null, region: null, redis, maxWaitMs: 0 });
  await expect(ctx.limiter.acquire('actions')).rejects.toMatchObject({ code: 'rate_budget_exhausted' });
});
```

- [ ] **Step 2: Run** `cd packages/shared && npx vitest run src/types/edr.test.ts` and `cd apps/api && npx vitest run src/services/edrProviders/context.test.ts` → FAIL.
- [ ] **Step 3: Implement** the tuples, types and `maxWaitMs` option as above. Export them from the shared barrel.
- [ ] **Step 4: Run** both suites plus `npx tsc --noEmit -p .` in `apps/api` and `packages/shared` → PASS / exit 0.
- [ ] **Step 5: Commit** `feat(edr): typed response-action adapter contract (#8167)`

---

### Task A3: GravityZone client write calls (no retry, traceable request id)

**Files:**
- Modify: `apps/api/src/services/edrProviders/bitdefender/client.ts`
- Create: `bitdefender/__fixtures__/action-isolate-ok.json`, `action-restore-ok.json`, `action-scan-ok.json`, `action-scan-task-status.json`, `error-licence-isolate.json`
- Test: `apps/api/src/services/edrProviders/bitdefender/client.test.ts`

**Interfaces:**
- Consumes: `GuardedFetch`, `EdrRateLimiter`.
- Produces:
  ```ts
  interface CallOptions { /* existing */ retry?: boolean /* default true */; requestId?: string }
  type GzOperationClass = 'default' | 'inventory' | 'companies' | 'incidents' | 'actions';
  createIsolateEndpointTask(endpointId: string, requestId: string): Promise<GzTaskResult>;
  createRestoreEndpointFromIsolationTask(endpointId: string, requestId: string): Promise<GzTaskResult>;
  createScanTask(endpointId: string, requestId: string): Promise<GzTaskResult>;
  getScanTaskStatus(taskId: string): Promise<'pending' | 'in_progress' | 'finished' | 'failed' | 'unknown'>;
  type GzTaskResult = { kind: 'accepted' } | { kind: 'task'; taskId: string };
  ```

**`[U]` vendor shapes — the lab gate decides them.** The public docs (`…-135330-createisolateendpointtask`, `createRestoreEndpointFromIsolationTask`, `network.createScanTask`) are read as: isolate/restore return `true`, and scan returns `true` (v1.0) or a task id list (newer versions). The client normalizes **both** shapes into `GzTaskResult`, and each branch gets its own fixture. The adapter (A4) maps `accepted` → `succeeded` for isolate/restore. Isolation *completion* is confirmed by the next inventory `isIsolated` and by `reconcileAction`. A `task` maps to `submitted` with polling. If the sandbox shows a third shape, the lab run updates the fixture and this mapping before PR-A merges. Do not guess further.

- [ ] **Step 1: Failing tests**

```ts
describe('write calls', () => {
  it('never retries a write on 5xx / network / non-JSON 2xx (the vendor may have accepted it)', async () => {
    const fetch = vi.fn().mockResolvedValue(httpResponse(502, 'bad gateway'));
    const c = client({ fetch });
    await expect(c.createIsolateEndpointTask('ep1', 'act-1')).rejects.toMatchObject({ code: 'outcome_unknown' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('uses the edr_actions id as the JSON-RPC id (vendor-side traceability)', async () => {
    const fetch = vi.fn().mockResolvedValue(httpResponse(200, fixture('action-isolate-ok.json')));
    await client({ fetch }).createIsolateEndpointTask('ep1', '7f0c…-act');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ id: '7f0c…-act', method: 'createIsolateEndpointTask', params: { endpointId: 'ep1' } });
  });
  it('acquires the actions operation class', async () => { /* limiter.acquire called with 'actions' */ });
  it('a licence error on isolate is code licence, scope operation, not reauth', async () => {
    const fetch = vi.fn().mockResolvedValue(httpResponse(200, fixture('error-licence-isolate.json')));
    await expect(client({ fetch }).createIsolateEndpointTask('ep1', 'a')).rejects.toMatchObject({ code: 'licence', scope: 'operation', reauth: false });
  });
  it('429 on a write is surfaced as rate_limited without sleeping (nothing was accepted)', async () => { /* fetch 429 → rejects code rate_limited, fetch called once, sleep not called */ });
  it('normalizes boolean true and task-id-array scan results', async () => { /* both fixtures → { kind: 'accepted' } / { kind: 'task', taskId } */ });
});
```

- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/edrProviders/bitdefender/client.test.ts` → FAIL.
- [ ] **Step 3: Implement.** In `call()`, a `retry: false` call does three things. (a) A network error, 5xx, or unparseable 2xx throws `this.fail('<label>: outcome unknown', { code: 'outcome_unknown', scope: 'operation' })` immediately, with no sleep and no loop. (b) A 429 / `-32003` throws `rate_limited` without `handleRateLimit` sleeping. A 429 means the request was rejected, so it is safe to report as "not sent". (c) Every other classification is unchanged. `requestId` replaces `randomUUID()` in the envelope when given. Add the three write methods with `{ operationClass: 'actions', retry: false, requestId, scope: 'tenant' }`. Add `getScanTaskStatus` as a normal retrying read (`network`, `getScanTasksList` filtered by id; `[U]` status codes map to `unknown`).
- [ ] **Step 4: Run** → PASS. Also run the whole `bitdefender/` directory to prove the read paths are unchanged.
- [ ] **Step 5: Commit** `feat(edr): GravityZone write calls — no retry, request id = action id (#8167)`

---

### Task A4: GravityZone adapter actions + `supportsAction`

**Files:**
- Modify: `apps/api/src/services/edrProviders/bitdefender/adapter.ts`
- Test: `apps/api/src/services/edrProviders/bitdefender/adapter.test.ts`

**Interfaces:**
- Consumes: A2 types, A3 client methods.
- Produces: `bitdefenderAdapter.capabilities.actions = ['isolate', 'unisolate', 'scan']`; `operationBudgets.actions = { perMinute: 30 }` (vendor scan/quarantine task cap 30/min); `supportsAction`, `performAction`, `getActionStatus`, `reconcileAction`. `quarantine_restore` / `quarantine_delete` are **not** added here (Task A4b, conditional).

`supportsAction(facts, action)` rules, evaluated in order (pure; no I/O):
1. `action` not in `capabilities.actions` → `{ ok:false, reason:'Not supported by Bitdefender GravityZone' }`.
2. `facts.vendorEndpointId === null` → `'Endpoint not linked to this vendor'`.
3. isolate/unisolate when `connectionCapabilityNotes` contains `note:incidents: API not enabled on key` → `'The API key lacks the Incidents API (needed for isolation)'`.
4. `facts.tenantUnsupportedActions.includes(action)` → `'This company's GravityZone licence does not include this action'`.
5. isolate when `isolationState === 'isolated'` → `'Already isolated'`; unisolate when `isolationState === 'not_isolated'` → `'Not isolated'`. `pending`/`unknown` allow both, because the vendor is authoritative.
6. otherwise `{ ok: true }`.

`performAction` maps isolate → `createIsolateEndpointTask`, unisolate → `createRestoreEndpointFromIsolationTask`, scan → `createScanTask`. Result mapping: `accepted` → `{status:'succeeded'}` (for isolate/unisolate, "the vendor accepted the task"; the UI copy says "requested", and the inventory `isolationState` shows completion); `task` → `{status:'submitted', vendorActionId: taskId}`. `reconcileAction`: isolate/unisolate read `getEndpointDetails(vendorEndpointId).isIsolated` (isolate: `true` → `applied`, `false` → `not_applied`; inverse for unisolate; absent → `unknown`). Scan → always `unknown`, because a scan's effect is not observable and its reconcile ends in `failed` for a human to re-issue.

- [ ] **Step 1: Failing tests** — a table-driven `supportsAction` test covering each of the six rules, plus a case proving the rule order (an already-isolated endpoint on a licence-denied tenant reports the licence reason). Also: a `performAction` mapping test per action and per `GzTaskResult` branch; an unsupported action handed to `performAction` throws `EdrProviderRequestError{code:'unsupported_action'}` (a defensive guard, never reached through dispatch); a `reconcileAction` table (true/false/undefined × isolate/unisolate, scan → unknown); and `capabilities.actions` deep-equals `['isolate','unisolate','scan']`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/edrProviders/bitdefender/adapter.test.ts` → FAIL.
- [ ] **Step 3: Implement** as specified. `detectionDelivery` stays `'poll'` until PR-B.
- [ ] **Step 4: Run** → PASS; `src/services/edrProviders/capabilities.test.ts` still passes (`capabilitySnapshot` now emits `action:isolate` etc. — update its expectation deliberately).
- [ ] **Step 5: Commit** `feat(edr): GravityZone isolate / restore / scan adapter actions (#8167)`

### Task A4b (conditional): GravityZone quarantine restore / delete

**Run only if the W03 lab gate (Task A15) proves** the trial key can call `quarantine/computers` `createRestoreQuarantineItemTask` / `createRemoveQuarantineItemTask` (names `[U]`; confirm against the vendor reference during the lab run). If it does not, skip this task, leave `edr_detection_action` unregistered (A11 note), and record the result in the PR body. If it runs, the shape matches A4: the target kind is `quarantine_item` (`vendorItemId` = the quarantine detection's `vendor_detection_id`, `vendor_kind = 'quarantine_item'`), operation class `actions`, `retry:false`, results `accepted` → `succeeded`, and `reconcileAction` → `unknown`. Tests: the mapping, plus refusal of a detection whose `vendorKind !== 'quarantine_item'`. Commit `feat(edr): GravityZone quarantine restore/delete actions (#8167)`.

---
### Task A5: Kill switches, Breeze-side rate limits, vendor error mapping

**Files:**
- Create: `apps/api/src/services/edrProviders/actionGates.ts`, `apps/api/src/services/edrProviders/actionErrors.ts`
- Modify: `apps/api/src/services/edrProviders/rateLimiter.ts` (action reserve), `apps/api/src/config/env.ts`; compose files / `.env.example` as `envComposeParity.test.ts` demands
- Test: `actionGates.test.ts`, `actionErrors.test.ts`, `apps/api/src/config/env.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // env.ts — read at CALL time (flip + restart, and tests can stub). Default true; '0'/'false'/'off' disable.
  export function edrActionsEnabled(): boolean;
  // actionGates.ts
  export const EDR_ACTION_RATE_LIMITS = {
    perConnection: { limit: 30, windowSeconds: 600 },   // all actions through one vendor console
    perActor: { limit: 10, windowSeconds: 600 },        // one user (or one AI session) across connections
  } as const;
  export async function checkEdrActionRateLimit(o: { redis: Redis | null; connectionId: string; actorKey: string; targets: number }):
    Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }>;   // fails CLOSED when redis is null
  export function edrActorKey(o: { userId: string | null; aiSessionId: string | null }): string; // 'u:<id>' | 's:<id>' | 'anon'
  // actionErrors.ts
  export type EdrActionErrorCode =
    | 'actions_disabled' | 'connection_actions_disabled' | 'connection_unavailable' | 'unsupported'
    | 'target_not_found' | 'target_detached' | 'site_denied' | 'action_in_progress' | 'action_recently_requested'
    | 'rate_limited' | 'licence' | 'api_not_enabled' | 'vendor_auth' | 'vendor_rejected'
    | 'dispatch_outcome_unknown' | 'approval_required' | 'audit_unavailable';
  export class EdrActionError extends Error { constructor(readonly code: EdrActionErrorCode, readonly httpStatus: 400|403|404|409|422|429|502|503, message: string, readonly retryAfterSeconds?: number) }
  /** Classify a performAction throw. `sent` = the request may have reached the vendor. */
  export function classifyVendorActionError(e: unknown): { rowStatus: 'failed' | 'queued'; code: EdrActionErrorCode; http: number; message: string; recordTenantDenial: boolean; markReauth: boolean };
  ```

Vendor error mapping (`classifyVendorActionError`). This is the exact table; the test enumerates it:

| Thrown | Row | HTTP | Side effect |
|---|---|---|---|
| `EdrProviderRequestError{code:'licence'}` | `failed`, error `licence` | 422 | `recordTenantDenial` (tenant `unsupported_actions += action`, `unsupported_actions_at = now()`) |
| `{code:'api_not_enabled'}` (the **key** lacks the API — a credential permission, not a company licence) | `failed`, error `api_not_enabled` | 422 | none on the tenant; message tells the MSP to enable the API on the key and re-test (the re-test refreshes `capabilities_snapshot` notes, which `supportsAction` rule 3 reads) |
| `{reauth:true, scope:'connection'}` (401 / dead key) | `failed`, `vendor_auth` | 502 | `markReauth` → connection `status='reauth_required'` (same as sync). A `reauth` error with any other scope does **not** touch the connection. |
| `{code:'rate_limited'}` / `{code:'rate_budget_exhausted'}` | `failed`, `rate_limited` (nothing was accepted) | 429 + `Retry-After` | none |
| `{code:'not_found' \| 'invalid_params' \| 'forbidden' \| 'vendor_error' \| 'method_not_found' \| 'http_error' \| 'unsupported_action'}` and **any other `EdrProviderRequestError` code** (default branch — an unknown code is a rejection the vendor answered, not an unknown outcome) | `failed`, `vendor_rejected` (vendor message scrubbed, ≤500 chars) | 502 | none |
| `{code:'outcome_unknown'}` (A3), or any non-`EdrProviderRequestError` throw after the call started | **stays `queued`**, error `dispatch_outcome_unknown` | 202 with `outcomeUnknown: true` | reconciler (A8) settles it |
| `{code:'host_not_allowed'}` (guarded fetch refusal before send) | `failed`, `vendor_rejected` | 502 | none |

**Action reserve (spec §4.4 "capacity is reserved for actions so polling cannot starve them, with a polling floor").** `createEdrRateLimiter` gains `actionReserveFraction` (default `0.2`): on the shared credential windows, every operation class **other than** `'actions'` is admitted only while usage is below `floor(limit * (1 - reserve))`, whereas `'actions'` may use the full limit. The `'actions'` operation-class window (GravityZone `perMinute: 30`) is its own key, so actions cannot starve polling beyond that cap: that is the polling floor. File: `services/edrProviders/rateLimiter.ts` (+ `rateLimiter.test.ts`: with limit 10/s and reserve 0.2, the 9th polling acquire waits while an `'actions'` acquire succeeds; the actions class cap is enforced).

- [ ] **Step 1: Failing tests.** `env.test.ts`: unset → true; `'false'`, `'0'` and `'off'` → false; the value is re-read per call (set the env after import and it is honoured). `actionGates.test.ts`: limits per connection and per actor, `targets: 3` consumes 3, `redis: null` → `{ok:false}` (fail closed), and the actor key prefers user over session. `actionErrors.test.ts`: one case per table row, plus "a plain `Error('socket hang up')` → queued/dispatch_outcome_unknown". A guard test: no row of the mapping ever yields `rowStatus:'queued'` together with `recordTenantDenial`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** The rate limit uses the existing `rateLimiter(redis, key, limit, windowSeconds, cost, { refundOnReject: true })` from `services/rate-limit`, with keys `edr-actions:conn:<id>` and `edr-actions:actor:<key>`. Add `BREEZE_EDR_ACTIONS_ENABLED` to the API service `environment:` block in every tracked compose file and to `.env.example` (commented, `# BREEZE_EDR_ACTIONS_ENABLED=true`). The parity test lists where.
- [ ] **Step 4: Run** the three suites plus `src/config/envComposeParity.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(edr): action kill switch, rate limits, vendor error mapping (#8167)`

---

### Task A6: `dispatchEdrAction` — the single action door

**Files:**
- Create: `apps/api/src/services/edrProviders/actions.ts`
- Test: `apps/api/src/services/edrProviders/actions.test.ts`

**Interfaces:**
- Consumes: A1 columns, A2 types, A5 gates/errors, `getEdrProvider`, `buildEdrAdapterContext`, `decryptEdrCredentials` (W01 `credentials.ts`), `resolveEdrReadScope` / `EdrSiteRestriction` (`readScope.ts`), `createAuditLog` (`services/auditService.ts`), `withDbAccessContext` / `withSystemDbAccessContext` / `runOutsideDbContext` (`db/index.ts`).
- Produces:
  ```ts
  export interface EdrActionActor {
    auth: AuthContext;                       // caller identity: RLS context + org reach
    restriction: EdrSiteRestriction;         // from resolveEdrReadScope (site axis) ∩ runFrozenDeviceIds for AI agent runs
    requestedVia: 'ui' | 'ai' | 'api';
    requestedBy: string | null;              // users.id or null — the CALLER passes it explicitly (AI: `auth.user.id` literal, see A11)
    aiSessionId: string | null;
    approvalId: string | null;
    reason: string | null;                   // free text, ≤500, stored in payload.reason
  }
  export type EdrActionTargetInput =
    | { kind: 'endpoint'; endpointId: string; action: EdrEndpointActionKey; pid?: number }
    | { kind: 'device'; deviceId: string; connectionId?: string; action: EdrEndpointActionKey; pid?: number }   // AI tools
    | { kind: 'detection'; detectionId: string; action: EdrDetectionActionKey };
  export interface EdrActionOutcome { actionId: string; status: EdrActionStatus; outcomeUnknown: boolean; error: string | null; httpStatus: 200 | 202 | 422 | 429 | 502 }
  export async function dispatchEdrAction(actor: EdrActionActor, target: EdrActionTargetInput): Promise<EdrActionOutcome>; // throws EdrActionError for pre-insert refusals
  export async function describeEndpointActions(endpoint: EdrEndpointRow, tenant: Pick<EdrTenantRow,'unsupportedActions'|'unsupportedActionsAt'>, connection: Pick<EdrConnectionRow,'actionsEnabled'|'isActive'|'status'|'capabilitiesSnapshot'|'provider'>): EdrEndpointActionAvailability[];
  export const EDR_TENANT_DENIAL_TTL_MS = 24 * 3600_000;
  ```

**Transaction ownership — read this first (Codex quorum finding).** `authMiddleware` wraps every authenticated request in a held `withDbAccessContext` transaction (`middleware/auth.ts` `runScopedHandler`). A nested `withDbAccessContext` simply joins that transaction (`db/index.ts`). So "insert, commit, then call the vendor" is **impossible** inside a normal route or a normal AI tool call: the row would be uncommitted, and the pooled connection would sit idle-in-transaction across vendor HTTP (#1105). Therefore:
- `POST /edr/actions` is added to `SELF_MANAGED_DB_CONTEXT_ROUTES` (`middleware/selfManagedDbContextRoutes.ts`, next to the W01 `/edr/connections` entries at ~:505): `{ method: 'POST', pattern: /^\/api\/v1\/edr\/actions\/?$/ }`.
- Both AI action tools declare `selfManagedDbContext: true` (`AiTool` flag, `aiTools.ts:171-194`).
- `dispatchEdrAction` **asserts** `!hasDbAccessContext()` on entry and throws otherwise (a unit test pins this). It then opens its own short contexts: `withDbAccessContext(buildDbAccessContext(<from auth>))` for the caller-scoped read and insert, `withSystemDbAccessContext` for the credential load and outcome write, and `runOutsideDbContext` for the vendor call.

**Org-scope callers cannot see partner tables.** `edr_connections` / `edr_tenants` are partner-axis RLS. An org token reads neither (`routes/edr/access.ts:17-30`). So authorization and credential loading are separated: the endpoint/detection row is read under the **caller's** context (that read is the authorization), and the connection + tenant (+ encrypted creds) are then loaded under `withSystemDbAccessContext` **constrained to the ids on the authorized row** (`edr_connections.id = row.connection_id AND partner_id = row.partner_id`, `edr_tenants.id = row.tenant_id AND org_id = row.org_id`). Nothing from the caller's input reaches the system query.

**Flow (each numbered step is a test):**

1. **Kill switch** — `!edrActionsEnabled()` → throw `EdrActionError('actions_disabled', 503)`. Nothing is read.
2. **Resolve target under the caller's RLS** — `withDbAccessContext(buildDbAccessContext(<from auth>), …)`, selecting the endpoint (or the detection plus its live endpoint) **only**. Connection and tenant are loaded afterwards under system context, keyed by the authorized row's ids (see above). Shape-1 RLS on `edr_endpoints`/`edr_detections` (`breeze_has_org_access`) already hides orgs outside a `selected` partner user's reach. The **explicit** checks still run, because the app layer must not trust RLS alone (CLAUDE.md "never claim parity"):
   - no row → `target_not_found` 404 (identical for "does not exist" and "not yours");
   - `auth.scope !== 'system' && !auth.canAccessOrg(row.orgId)` → `target_not_found` 404;
   - detection `detached_at IS NOT NULL` or `tenant_id IS NULL` → `target_detached` 409 (tombstoned history is read-only);
   - detection actions need a live endpoint only when the action's target kind is `process`/`endpoint`;
   - `device` input: select `edr_endpoints WHERE breeze_device_id = $deviceId` (plus `connection_id` when given). More than one live row → `EdrActionError('target_not_found', 404, 'Device is linked to more than one EDR connection; pass connectionId')`. Zero rows → 404.
3. **Site restriction (stricter than reads)** — when `isSiteRestricted(restriction)`, the endpoint's `breeze_device_id` must be non-null **and** in `restriction.allowedDeviceIds`. Never-linked and detached endpoints are refused (`site_denied` 403), unlike the read rule in `readScope.ts`, which shows never-linked findings. Reading an unattributed finding is fine; acting on an endpoint whose site is unknown is not (Open Decision 7).
4. **Connection gates** — `!connection.isActive || connection.status === 'reauth_required'` → `connection_unavailable` 409; `!connection.actionsEnabled` → `connection_actions_disabled` 409.
5. **Capability** — `adapter.capabilities.actions.includes(action)`, `typeof adapter.performAction === 'function'`, and `adapter.supportsAction(facts, action)`, where `facts.tenantUnsupportedActions` ignores denials older than `EDR_TENANT_DENIAL_TTL_MS`. A failure is `unsupported` 422 with the adapter's reason, **and no row is written** (spec §4.10 step 2).
6. **Rate limit + cooldown** — `checkEdrActionRateLimit` (runs outside the DB context; it is Redis only) → `rate_limited` 429 with retry-after, no row. **Cooldown:** a `succeeded`/`submitted` row for the same `(endpoint_id|detection_id, action)` with `requested_at > now() - 60s` → `action_recently_requested` 409, no row. The partial unique index only covers *in-flight* rows, so a delayed double-click after an immediate success would otherwise send a second scan. This is app-layer only (a short-window race costs at most one redundant, idempotent-at-vendor request) — Open Decision 9 covers a durable request key.
7. **Insert + audit + commit** — in one short tx under the caller's context: `db.insert(edrActions).values({ connectionId, partnerId, orgId, tenantId, endpointId, detectionId, breezeDeviceId, provider, action, requestedBy, requestedVia, aiSessionId, approvalId, status:'queued', payload:{ reason, target: <vendor ids>, pid? } })`. A 23505 on `edr_actions_inflight_*` → `action_in_progress` 409 (`pgErrorCode` from `routes/edr/access.ts`). A 23503 on `edr_actions_tenant_org_fk` / `_endpoint_org_fk` means the tenant was remapped or the endpoint deleted between steps 2 and 7 (the composite FKs are the remap fence); map it to `target_not_found` 404. Then `await createAuditLog({ orgId, actorType: 'user', actorId: requestedBy, action: 'edr.action.requested', resourceType: 'edr_action', resourceId: id, details: { provider, action, connectionId, endpointId, detectionId, requestedVia, aiSessionId, approvalId } })`. `createAuditLog` runs on its own connection (`auditService.ts:64-103`). If the audit write throws, the action is **not** sent: mark the row `failed` / `audit_unavailable` and rethrow. An action Breeze cannot account for is not taken. `actorType` is always `'user'`: `ACTOR_TYPES` (`packages/shared/src/constants/index.ts:79`) has no `ai` value, and the row's actor is the accountable human (after an agent release, the approver). AI provenance travels in `details`. Do not add an enum value.
8. **Vendor call** — `await runOutsideDbContext(async () => { const ctx = buildEdrAdapterContext(adapter, { creds, baseUrl, region, maxWaitMs: 5_000 }); return adapter.performAction!(ctx, tenantRef, request, actionId); })`. Credentials are decrypted inside the step-2 read (row-bound AAD, `decryptEdrCredentials`) and held only in memory.
9. **Write outcome** — under `withSystemDbAccessContext`, compare-and-set `WHERE id = $id AND status = 'queued'` (the reconciler's 120 s grace makes a collision unlikely; the CAS makes it harmless): `succeeded` → `status, submitted_at, completed_at`; `submitted` → `status, vendor_action_id, submitted_at`; thrown → `classifyVendorActionError` row update. On `recordTenantDenial`, update `edr_tenants` `unsupported_actions = array(select distinct unnest(unsupported_actions || ARRAY[$action]))`, `unsupported_actions_at = now()`. On `markReauth`, update the connection `status='reauth_required'`. Then a second audit `edr.action.<succeeded|submitted|failed|outcome_unknown>` via `createAuditLogAsync`. The ledger row is the source of truth; the async audit is the feed.
10. **Return** `EdrActionOutcome`. `httpStatus` is 200 for `succeeded`/`submitted`, 202 for an unknown outcome, and comes from the mapping for failures.

`describeEndpointActions` runs steps 4–5 for every action in `EDR_ENDPOINT_ACTIONS` against an already-loaded row, with no I/O, and powers the UI and `GET /edr/endpoints` (A9). The kill switch shows as `reason: 'Response actions are disabled on this server'`.

- [ ] **Step 1: Write failing tests** (Drizzle mocked per the `breeze-testing` skill; `adapter` is a fake registered via `vi.mock('./registry')`; `runOutsideDbContext` spied to assert the vendor call happens **outside** any DB context: `hasDbAccessContext()` is false inside the fake `performAction`). One `it` per numbered step, plus these:
  - "vendor call happens after the insert committed": the fake `performAction` asserts that the mock insert has already resolved;
  - "audit failure → no vendor call, row failed/audit_unavailable";
  - "23505 on the in-flight index → EdrActionError action_in_progress 409 and no vendor call";
  - "site-restricted caller, endpoint never linked → site_denied, no insert";
  - "selected-org partner, endpoint in an unreachable org → 404 (RLS returns no row) and canAccessOrg double-check (row returned by a mocked over-permissive RLS still 404)";
  - "tenant denial younger than 24 h → unsupported without a vendor call; older → vendor called";
  - "outcome unknown → row stays queued, error dispatch_outcome_unknown, httpStatus 202, performAction called exactly once";
  - "licence error → row failed, tenant denial recorded, 422";
  - "requestedBy is stored exactly as passed (null stays null)";
  - "called while a DB context is held → throws (no read, no vendor call)";
  - "org-scope caller: endpoint read under caller context; connection/tenant loaded under system context with the row's ids only (assert the system query's WHERE uses row.connection_id/row.partner_id, never input)";
  - "cooldown: succeeded row 30 s old → action_recently_requested, 90 s old → dispatched";
  - "23503 on the tenant/org FK at insert → target_not_found";
  - "outcome write is CAS on status='queued'".
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/edrProviders/actions.test.ts` → FAIL.
- [ ] **Step 3: Implement** to the flow above. Keep the file under ~450 lines; target resolution can move to `actionTargets.ts` if it grows.
- [ ] **Step 4: Run** → PASS; `npx tsc --noEmit -p .` exit 0.
- [ ] **Step 5: Commit** `feat(edr): dispatchEdrAction — gated, audited, single-send response actions (#8167)`

---

### Task A7: Action ledger read model

**Files:**
- Create: `apps/api/src/services/edrProviders/actionsRead.ts`
- Test: `actionsRead.test.ts`

**Interfaces:**
- Produces: `listEdrActions(scope: EdrReadScope, q: { orgId?: string; deviceId?: string; endpointId?: string; status?: EdrActionStatus | 'open'; limit: number; offset: number }): Promise<{ rows: EdrActionDto[]; total: number }>`. Org filter via `edrOrgCondition` (`read.ts:80`). Site rule: a restricted caller sees only rows whose `breeze_device_id` is in `allowedDeviceIds`; unlinked rows are hidden, matching the A6 action rule. `outcomeUnknown = status === 'queued' && error === 'dispatch_outcome_unknown'`. `payload` is never projected.

- [ ] Steps 1–5 (TDD): tests for the org filter (an org token cannot pass another `orgId` → `EdrReadError` 403), site restriction, `open` = queued+submitted, the projection excluding `payload`, and limit clamp 200. Commit `feat(edr): action ledger read model (#8167)`.

---

### Task A8: `sync-action-status` job — async completion + reconciliation (never re-send)

**Files:**
- Create: `apps/api/src/services/edrProviders/actionStatus.ts`
- Modify: `apps/api/src/jobs/edrProviderSync.ts` (job union, worker switch, `sync-all` fan-out, `enqueueEdrActionStatus`), `apps/api/src/services/edrProviders/persist.ts` (inventory run clears expired/contradicted tenant denials)
- Test: `actionStatus.test.ts`, `apps/api/src/jobs/edrProviderSync.test.ts`

**Interfaces:**
- Produces: job data `{ type: 'sync-action-status'; connectionId: string }`, job id `edr-action-status-<connectionId>`; `pollEdrActionStatus(connectionId: string, now: Date): Promise<{ checked: number; settled: number }>`; constants `EDR_ACTION_UNKNOWN_GRACE_MS = 120_000`, `EDR_ACTION_UNKNOWN_GIVEUP_MS = 30 * 60_000`, `EDR_ACTION_SUBMITTED_TIMEOUT_MS = 24 * 3600_000`.

Algorithm (three phases, as in the sync job):
- **Phase 1** (system tx, short): load the connection (+ decrypted creds) and up to 50 open rows `WHERE connection_id=$1 AND status IN ('queued','submitted') AND detached_at IS NULL ORDER BY requested_at`. Skip `queued` rows younger than `EDR_ACTION_UNKNOWN_GRACE_MS`: dispatch may still be in flight in the request.
- **Phase 2** (`runOutsideDbContext`): for each row:
  - `submitted` with `vendor_action_id` → `getActionStatus`; terminal → settle; still pending past `SUBMITTED_TIMEOUT` → `failed`/`vendor_status_timeout`.
  - `queued` (crash or unknown outcome) → `reconcileAction` (read-only). `applied` → `succeeded` (error `reconciled_applied`); `not_applied` → `failed` (error `not_sent_or_rejected`, re-issue manually); `unknown` and older than `GIVEUP` → `failed` (error `outcome_unknown_reissue_manually`); otherwise leave it for the next tick.
  - A transient fetch failure leaves the row unchanged (the spec §4.3 terminal-vs-transient rule).
  - **No code path in this file may call `performAction`.** A source-text test pins this (A10).
- **Phase 3** (system tx): compare-and-set updates `WHERE id=$id AND status=$observedStatus`, so a concurrent dispatch outcome write wins. One `createAuditLogAsync('edr.action.<outcome>', details.reconciled=true)` per settled row.
- `sync-all` enqueues `sync-action-status` for each active connection that has an open row (one `EXISTS` query on `edr_actions_open_status_idx`). The job holds the same advisory-lock namespace only in Phase 3.
- The inventory Phase 3 clears `edr_tenants.unsupported_actions` when `unsupported_actions_at < now() - 24h`. W03 does not try to infer licence re-grant from inventory; expiry is the only clear (simple, and the vendor is re-asked at most once a day).

- [ ] **Step 1: Failing tests** in `actionStatus.test.ts`, one per bullet: grace skip; submitted → succeeded/failed/pending/timeout; queued → applied/not_applied/unknown-young/unknown-old; transient getActionStatus failure → unchanged; CAS miss (status changed concurrently) → no audit; **`performAction` spy is never called in any case**. In `edrProviderSync.test.ts`: the worker routes `sync-action-status`; `sync-all` enqueues it only for connections with open rows; the job id is stable.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS (also the existing `edrProviderSync.test.ts` cases).
- [ ] **Step 5: Commit** `feat(edr): action status polling + crash reconciliation without re-send (#8167)`

---
### Task A9: Routes — `POST/GET /edr/actions`, endpoint action availability, the connection actions switch

**Files:**
- Create: `apps/api/src/routes/edr/actions.ts`, `actions.test.ts`
- Modify: `routes/edr/index.ts` (mount), `middleware/selfManagedDbContextRoutes.ts` (+ its test: `POST /api/v1/edr/actions` is self-managed, `GET` is not), `routes/edr/endpoints.ts` (+ test), `routes/edr/connections.ts` (+ test), `services/mcpCoverage.ts`, `apps/api/src/__tests__/writeRoutePermissionGate.contract.test.ts` (only if it enumerates authenticated write routes; check `grep -n "'POST /api/v1/edr" …` first)

**Interfaces:**
- Consumes: A6 `dispatchEdrAction`, `describeEndpointActions`; A7 `listEdrActions`; `resolveEdrReadScope`.
- Produces:
  - `POST /edr/actions` body (zod, `.strict()`):
    ```ts
    z.discriminatedUnion('targetKind', [
      z.object({ targetKind: z.literal('endpoint'), endpointIds: z.array(z.string().guid()).min(1).max(10), action: z.enum(EDR_ENDPOINT_ACTIONS), pid: z.number().int().positive().optional(), reason: z.string().trim().max(500).optional() }).strict(),
      z.object({ targetKind: z.literal('detection'), detectionId: z.string().guid(), action: z.enum(EDR_DETECTION_ACTIONS), reason: z.string().trim().max(500).optional() }).strict(),
    ])
    ```
    Middleware: `requireScope('organization','partner','system')`, `requirePermission(DEVICES_EXECUTE)`, `requireMfa()`. Response `{ data: EdrActionOutcome[] }`. Each endpoint target is dispatched sequentially, with one row each (spec §4.10 step 5). A per-target `EdrActionError` becomes `{ endpointId, error, code }` in the array rather than aborting the batch. HTTP status is the single outcome's status for one target, otherwise 207-style 200 with per-item statuses. `kill_process` requires `pid` (refine) and one endpoint.
  - `GET /edr/actions?orgId&deviceId&endpointId&status&limit&offset` — `devices.read`; `{ data: EdrActionDto[], pagination }`.
  - `GET /edr/endpoints` rows gain `actions: EdrEndpointActionAvailability[]` (from `describeEndpointActions`; read-only, no vendor call).
  - `PATCH /edr/connections/:id` accepts `actionsEnabled: boolean`. It needs the existing `requireEdrPartnerAdmin` + `ORGS_WRITE` + `requireMfa()` gates and writes audit `edr.connection.actions_enabled|disabled`. A selected-org partner user gets 403. Turning actions on does **not** require a re-test.
  - `mcpCoverage.ts`: `'edr/actions.ts': { tools: ['edr_endpoint_action', 'edr_detection_action'] }`. If A4b is skipped, use `{ tools: ['edr_endpoint_action'] }` and add a `note` that detection actions have no adapter yet.

- [ ] **Step 1: Failing route tests** (`app.request` with mocked auth/permissions per the `breeze-testing` skill):
  - 401/403 without `devices.execute`; 403 `MFA required` when `requireMfa` is unsatisfied;
  - an org-scope token **can** act on its own org's endpoint (spec §4.10 "partner or org scope"), and an `orgId`/endpoint of another org → 404;
  - `EdrActionError` codes map to their HTTP statuses (one case each: 503, 409×3, 422, 429 with a `Retry-After` header, 403 site_denied, 404);
  - a batch of 3 with one unsupported returns 3 items and makes 2 dispatch calls;
  - an unknown body key → 400 (strict); `endpointIds` > 10 → 400; `kill_process` without `pid` → 400;
  - the GET honours the site restriction (it delegates to A7 with the scope built from `c.get('permissions')`);
  - endpoints GET includes `actions` with reasons;
  - the connections PATCH `actionsEnabled` checks: selected-org partner → 403, org token → 403, MFA required, audit written.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/routes/edr/actions.test.ts src/routes/edr/endpoints.test.ts src/routes/edr/connections.test.ts` → FAIL.
- [ ] **Step 3: Implement**; mount `edrActionRoutes` in `routes/edr/index.ts`.
- [ ] **Step 4: Run** the three suites plus `src/__tests__/mcp-coverage.test.ts` (it will fail until A11 registers the tools; run it again after A11) and `src/__tests__/writeRoutePermissionGate.contract.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat(edr): /edr/actions routes, endpoint action availability, connection actions switch (#8167)`

---

### Task A10: Contract tests — single INSERT door, never re-send, portal isolation

**Files:**
- Create: `apps/api/src/services/edrProviders/edrActions.chokepoint.contract.test.ts`

Model it on `services/aiDispatch.contract.test.ts` (source-text scan of every non-test `.ts` under `apps/api/src`, plus `apps/portal/src`):

```ts
const INSERT_DOOR = 'apps/api/src/services/edrProviders/actions.ts';
it('only actions.ts inserts into edr_actions', () => {
  const re = /\b(?:db|tx|trx|client)\s*\.\s*insert\s*\(\s*edrActions\b|INSERT\s+INTO\s+edr_actions\b/i;
  expect(API_FILES.filter((f) => f !== INSERT_DOOR && re.test(read(f)))).toEqual([]);
});
it('performAction is called only from actions.ts (status/reconcile code never re-sends)', () => {
  const re = /\.performAction\s*\??\.?\s*\(/;
  expect(API_FILES.filter((f) => !f.endsWith('/bitdefender/adapter.ts') && f !== INSERT_DOOR && re.test(read(f)))).toEqual([]);
});
it('AI tool files reach actions only through dispatchEdrAction', () => {
  const offenders = API_FILES.filter((f) => /services\/aiTools[^/]*\.ts$/.test(f))
    .filter((f) => /edrProviders\/(registry|bitdefender)/.test(read(f)) && /performAction|getEdrProvider/.test(read(f)));
  expect(offenders).toEqual([]);
});
it('the portal never reaches EDR actions', () => {
  const re = /edrProviders\/actions|\/edr\/actions|dispatchEdrAction/;
  expect([...PORTAL_FILES, ...API_FILES.filter((f) => f.includes('/routes/portal/') || f.includes('/services/portal/'))]
    .filter((f) => re.test(read(f)))).toEqual([]);
});
```

- [ ] **Step 1:** Write the test. **Step 2: prove each assertion can fail** before trusting a green (evidence-discipline): temporarily add `db.insert(edrActions)` to a scratch file under `services/`, run, see red, then delete it. Do the same for the other three: one throwaway line each, run, red, revert. **Step 3:** Run green. **Step 4: Commit** `test(edr): action chokepoint, no-resend and portal-isolation contracts (#8167)`

---

### Task A11: AI tools `edr_endpoint_action` / `edr_detection_action` + every registry

**Files:**
- Modify: `services/aiToolsEdr.ts`, `aiToolSchemas.ts`, `aiGuardrails.ts`, `aiToolRateLimits.ts`, `aiAgentSdkTools.ts`, `aiAgents/agentToolCatalog.ts`, `mcpCoverage.ts` (A9 entry), `llm/toolEval/agentGoldenTasks.ts`, `jobs/intentReleaseWorker.ts`, `services/aiTools.userOwnedRelease.contract.test.ts` (`ACTION_GUARD_ALIASES`)
- Test: `services/aiToolsEdr.actions.test.ts` (create), plus the existing suites listed in Step 4

**Interfaces:**
- Consumes: A6 `dispatchEdrAction` (input kind `device` / `detection`), `resolveEdrReadScope`, `runFrozenDeviceIds`, `siteAllowlistOf` (`aiToolsSiteScope.ts`), `hasSatisfiedMfa`, `ToolExecutionContext.actionIntentId` / `.approverRelease`.
- Produces: two tools.

Tool contract:
- Both tools declare `selfManagedDbContext: true` (A6 transaction-ownership note). Check `aiTools.selfManagedDbContext.test.ts` / `aiTools.selfManagedHandlers.dbContext.test.ts` for any registration list they require.
- `edr_endpoint_action` — base tier 3; `deviceArgs: ['deviceId']` so the central `enforceDeviceArgs` gate, `runFrozenDeviceIds` and the site gate apply, as for `s1_isolate_device`. Schema: `{ deviceId: uuid (required), action: enum(EDR_ENDPOINT_ACTIONS minus 'kill_process' for W03), connectionId?: uuid, reason?: string ≤500 }`. `kill_process` stays out of the enum until an adapter implements it, which keeps the model's surface honest. The tier tables still classify it (fail-closed contract below).
- `edr_detection_action` — base tier 3. Schema `{ detectionId: uuid, action: enum(implemented detection actions), reason?: string }`. **Registered only if A4b ships.** Otherwise it is absent from every registry, and the tier tables still classify all of `EDR_DETECTION_ACTIONS` under the reserved name so the first adapter that adds one inherits vetted tiers.
- Description (≤300/160 budget): `"Run an EDR response action (isolate, release isolation, scan) on a device through its linked EDR vendor. Isolation/release require approval."`
- Handler order:
  1. `approverReleaseMismatch(auth, context)` → `{ error: 'approver_auth_mismatch' }` (copy the helper's shape from `aiToolsSentinelOne.ts:40-50`).
  2. `!hasSatisfiedMfa(auth)` → `{ error: 'MFA required' }`.
  3. **Tier-3 actions** (isolate, unisolate, and every tier-3 detection action) with `!context?.actionIntentId` → `{ error: 'approval_required' }`. This defends the approval gate, so a misregistered tier can never let a tier-3 action run directly.
  4. Build `restriction` from `siteAllowlistOf(auth)` ∩ `runFrozenDeviceIds(auth)` (copy `resolveScope` in `aiToolsEdr.ts:44-55`).
  5. Call `dispatchEdrAction({ auth, restriction, requestedVia: 'ai', requestedBy: auth.user.id, aiSessionId: auth.aiOrigin?.sessionId ?? null, approvalId: context?.actionIntentId ?? null, reason }, { kind: 'device', deviceId, connectionId, action })`. **Keep the literal `requestedBy: auth.user.id`** on its own line inside this tool's handler, so `aiTools.userOwnedRelease.contract.test.ts` sees the users-FK write. Moving it into the service would make that contract vacuous.
  6. Map `EdrActionError` → `{ error: code, message }`; outcomes → `{ success, actionId, status, outcomeUnknown }`.

Guardrail registrations, as **literal** entries (see Global Constraints):

| Table (`aiGuardrails.ts`) | `edr_endpoint_action` | `edr_detection_action` |
|---|---|---|
| `TIER2_ACTIONS` | `['scan', 'update_agent']` | — |
| `TIER3_ACTIONS` | `['isolate', 'unisolate', 'kill_process']` | `['rollback', 'resolve_detection', 'mark_false_positive', 'quarantine_restore', 'quarantine_delete']` |
| `TIER3_SUPERVISED_ACTIONS` | `['isolate', 'kill_process']` | `['quarantine_delete']` |
| `TIER3_FOUR_EYES_ACTIONS` | `['unisolate']` | `['rollback', 'resolve_detection', 'mark_false_positive', 'quarantine_restore']` |
| `TIER3_FOUR_EYES_TOOLS` (whole-tool fail-safe) | member | member |
| `TOOL_PERMISSIONS` | `{ resource: 'devices', action: 'execute' }` | same |

Other registries: `aiToolRateLimits.ts` `edr_endpoint_action: { limit: 5, windowSeconds: 600 }`, `edr_detection_action: { limit: 5, windowSeconds: 600 }` (S1 parity). `aiAgentSdkTools.ts` tier map `3` + `makeHandler` block next to `list_edr_detections` (`:1798-1817`). `agentToolCatalog.ts` `'security_response'`. `aiToolSchemas.ts` zod (no `z.undefined()`). `agentGoldenTasks.ts`: one task, "isolate the device with the Bitdefender detection" → expects `edr_endpoint_action`. **Not** in `HELPER_TOOL_SCOPING` / the helper whitelists: Breeze Helper must never isolate.

`jobs/intentReleaseWorker.ts` `USER_OWNED_RELEASE_ACTIONS` gets every key the agent lane can mint, **including Tier-2**, because the agent Tier-2 lane mints a supervised intent (`aiTools.userOwnedRelease.contract.test.ts` header): `'edr_endpoint_action:isolate'`, `':unisolate'`, `':scan'`, `':update_agent'`, `':kill_process'`. If A4b ships, add `'edr_detection_action:quarantine_restore'` / `':quarantine_delete'` plus the three reserved detection actions, so a future enum addition is already covered. Comment: `edr_actions.requested_by (db/schema/edrProviders.ts) — one dispatch site serves every action`.

**Approver constraint (Codex finding, accepted as-is):** an agent-originated intent's user-owned release builds the approver's context with `requirePartnerAxis: true` (`services/actionIntents/actorContext.ts:203-210`). An **org-only** user therefore cannot release an agent's EDR action; they get the worker's existing approver-axis failure, and a partner user must approve. That is acceptable for an MSP containment action and is pinned by a test, not changed. **Agent-run provenance:** an agent run has `auth.aiOrigin = { kind: 'ai_agent', agentRunId }` and possibly no `sessionId`. `ai_session_id` is then NULL; store `agentRunId` in `payload.aiAgentRunId` (no new column), and the audit details carry both.

`ACTION_GUARD_ALIASES`: the single `requestedBy: auth.user.id` line is not under an `if (action === …)` guard, so add `['services/aiToolsEdr.ts:<line>', [<every action in that tool's enum>]]`. **Line-keyed**: compute it after the final edit; re-key on any later edit above it.

Fail-closed contract (in `aiToolsEdr.actions.test.ts`):
```ts
import { EDR_DETECTION_ACTIONS, EDR_ENDPOINT_ACTIONS } from '@breeze/shared';
import { TIER2_ACTIONS, TIER3_FOUR_EYES_ACTIONS, TIER3_SUPERVISED_ACTIONS, TIER3_FOUR_EYES_TOOLS, checkGuardrails } from './aiGuardrails';
const EXPECT: Record<string, { tier: 2 | 3; scope?: 'supervised' | 'four_eyes' }> = {
  isolate: { tier: 3, scope: 'supervised' }, unisolate: { tier: 3, scope: 'four_eyes' },
  scan: { tier: 2 }, update_agent: { tier: 2 }, kill_process: { tier: 3, scope: 'supervised' },
  rollback: { tier: 3, scope: 'four_eyes' }, resolve_detection: { tier: 3, scope: 'four_eyes' },
  mark_false_positive: { tier: 3, scope: 'four_eyes' }, quarantine_restore: { tier: 3, scope: 'four_eyes' },
  quarantine_delete: { tier: 3, scope: 'supervised' },
};
it.each([...EDR_ENDPOINT_ACTIONS.map((a) => ['edr_endpoint_action', a]), ...EDR_DETECTION_ACTIONS.map((a) => ['edr_detection_action', a])])(
  '%s:%s resolves to its spec §4.10 tier', (tool, action) => {
    const g = checkGuardrails(tool, { action, deviceId: '00000000-0000-4000-8000-000000000001', detectionId: '00000000-0000-4000-8000-000000000002' });
    expect(g.tier).toBe(EXPECT[action].tier);
    if (EXPECT[action].scope) expect(g.approvalScope).toBe(EXPECT[action].scope);
  });
it('every EDR action appears in exactly one approval-scope bucket per tool (no fall-through)', () => { /* tier2 XOR supervised XOR four_eyes */ });
it('an unknown action string fails closed to tier 3 four_eyes', () => {
  expect(checkGuardrails('edr_endpoint_action', { action: 'wipe', deviceId: 'x' })).toMatchObject({ tier: 3, approvalScope: 'four_eyes' });
});
```
(If `edr_detection_action` is not registered, `checkGuardrails` returns tier 4 "Unknown tool" for it. Assert that instead, and keep the table-membership assertion so the classification is still pinned. If a registry-parity contract such as `aiGuardrailsTierConfig.parity.test.ts` or `aiToolsRegistryParity.test.ts` rejects tier-table entries for an unregistered tool, drop the `edr_detection_action` rows from `aiGuardrails.ts`. Keep the ten-action `EXPECT` map in this test as the pinned classification the first detection-action adapter must wire up. Never weaken the parity contract.)

- [ ] **Step 1: Failing tests** in `aiToolsEdr.actions.test.ts`:
  - the tier contract above;
  - handler: approver mismatch; MFA; tier-3 without `actionIntentId` → `approval_required` with **no** dispatch call; tier-2 `scan` without an intent → dispatched;
  - `dispatchEdrAction` receives `requestedVia:'ai'`, `approvalId === context.actionIntentId` and `aiSessionId === auth.aiOrigin.sessionId`;
  - for an agent-release context (`approverRelease` set, auth = approver), `requestedBy` is the approver's id;
  - a device-bound agent run with `runTargets` excluding the device → refused before dispatch;
  - output carries no vendor raw text.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** all registrations.
- [ ] **Step 4: Run** the new suite **and** these existing contracts, which are the known traps: `aiTools.userOwnedRelease.contract.test.ts`, `aiToolsActorParity.contract.test.ts`, `aiGuardrails.approvalScope.contract.test.ts`, `aiGuardrails.agentPrincipal.contract.test.ts`, `aiGuardrails.readonly.contract.test.ts`, `aiGuardrails.tier1WriteActions.contract.test.ts`, `aiGuardrailsTierConfig.parity.test.ts`, `aiGuardrailsAiDocs.parity.test.ts`, `aiGuardrails.routeParity.contract.test.ts`, `aiGuardrails.routeBinding.contract.test.ts`, `aiTools.descriptionBudget.contract.test.ts`, `aiTools.deviceArgsCoverage.contract.test.ts`, `aiToolsDeviceScope.contract.test.ts`, `aiToolsSiteScope.contract.test.ts`, `aiAgentSdkTools.mcpCoverage.test.ts`, `aiToolsRegistryParity.test.ts`, `__tests__/mcp-coverage.test.ts`, `jobs/intentReleaseWorker.test.ts`, `secretBearingTools.contract.test.ts` (the tools carry no secrets — confirm it does not demand an entry). Each must PASS. Fix registrations, never the contracts.
- [ ] **Step 5: Commit** `feat(edr): approval-gated EDR action AI tools with fail-closed tiers (#8167)`

---

### Task A12: #8658 — `/edr/status` coverage for selected-org partner users

**Files:** `apps/api/src/services/edrProviders/read.ts` (~L458-464), `read.test.ts`.

- [ ] **Step 1: Failing test:** partner user, `partnerOrgAccess: 'selected'` (reach = org A), no `orgId`, two connections: C1 maps a tenant to org A, C2 maps only to org B. Expected: `connections` lists only C1, and no "no vendor tenant mapped in this scope" note for C2.
- [ ] **Step 2: Run** → FAIL. **Step 3:** When `!q.orgId && auth.scope === 'partner' && auth.partnerOrgAccess === 'selected'`, apply the same `relevant` filter the `orgId` branch uses (connection has a reachable mapped tenant or an endpoint row). **Step 4:** PASS (+ `routes/edr/detections.test.ts`). **Step 5: Commit** `fix(edr): status coverage ignores unreachable connections for selected-org users (#8658)`. The PR body adds `Closes #8658`, which is a separate issue from the wave.

---

### Task A13: Real-Postgres integration suite

**Files:** `apps/api/src/__tests__/integration/edrActions.integration.test.ts` (from A1)

Cases, run as `breeze_app` with real RLS contexts (copy the harness of `edrProviderRls.integration.test.ts`):
1. An org-A token cannot INSERT an `edr_actions` row with `org_id = B` → 42501.
2. A selected-org partner (reach A only): `dispatchEdrAction` on an org-B endpoint → `target_not_found`, and no row exists afterwards (`withSystemDbAccessContext` count).
3. Two concurrent `dispatchEdrAction` isolate calls on one endpoint (`Promise.all`, fake adapter with a 200 ms `performAction`) → exactly one row and one adapter call; the other fails with `action_in_progress`.
4. A tombstoned detection (remap from W01's integration helper) → `target_detached`; no row.
5. Org erasure with `edr_actions` rows in all four statuses succeeds (`cascadeDeleteOrg` from `tenantCascade.ts`).
6. `edr_tenants.unsupported_actions` round-trips through the tenant export (`tenantExportErasureRoundtrip` helper).

- [ ] Write → run red against a stack **without** migration 1 applied (case 3 has no index yet, so two rows appear; record the red). → apply → green. Commit `test(edr): action tenancy, concurrency and erasure integration suite (#8167)`.

---

### Task A14: PR-A verification gate

- [ ] `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p .; echo exit=$?` → `exit=0` (also `packages/shared`).
- [ ] Full API unit run `cd apps/api && npx vitest run` (the merge registry and several contracts only red in the **full** run).
- [ ] `pnpm db:check-drift`.
- [ ] Test stack: `edrActions`, `edrProviderRls`, `edrProviderSync`, `tenant-export-policy`, `tenantExportErasureRoundtrip`, `tenantCascade` integration suites + `test:rls-coverage`, then `pnpm test-stack down`.
- [ ] Re-check the migration slot (Migration section) immediately before pushing.
- [ ] Review: one independent round, **Sonnet or Opus** (high blast radius: remote actions + AI guardrails). Act only on confirmed findings.

### Task A15: Lab gate (blocks enabling actions in production, not merging the code)

Actions ship **dark**: `actions_enabled` defaults false and nothing in the UI can turn it on until PR-B. Before Todd turns it on for any production connection:
- [ ] GravityZone trial (creds per memory `gravityzone_trial_lab_creds`, never printed) with a customer company that has the incidents/EDR add-on, and a GravityZone agent on a **nested brzlab VM** (never a host with an installed Breeze agent). Connect, map, sync, enable actions on the connection, then isolate → confirm in the GravityZone console and in the next inventory (`isolation_state='isolated'`) → restore → confirm → scan. Record the vendor return shapes and replace the `[U]` fixtures in A3 if they differ.
- [ ] A company **without** the licence: first isolate → 422 `licence`, the tenant denial is recorded, the button is then disabled with a reason (PR-B UI, or `GET /edr/endpoints` `actions` before PR-B).
- [ ] Quarantine restore/delete probe → decides A4b.
- [ ] Record the run (redacted) in the PR body.

---
# PR-B — Push hints, `sync_edr_data`, web

Branch from `main` after PR-A merges. Re-read PR-A's merged `actions.ts` / route shapes; do not trust this plan's signatures over merged code.

## File Structure (PR-B)

| File | Change |
|---|---|
| `apps/api/migrations/<next slot>-edr-push-hints.sql` | Create (re-check slot) |
| `apps/api/src/db/schema/edrProviders.ts` | `pushEnabled`, `pushRegisteredAt`, `pendingHintAt` |
| `apps/api/src/services/edrProviders/types.ts` | `RawWebhookRequest`, `EdrWebhookHint`, typed `verifyWebhook`, `registerPush?` / `unregisterPush?` / `sendTestPush?` |
| `bitdefender/client.ts`, `bitdefender/adapter.ts`, `bitdefender/push.ts` (create) | push settings calls; `verifyWebhook`; `detectionDelivery: 'poll_and_push'` |
| `apps/api/src/services/edrProviders/hints.ts` | Create — `recordEdrHint`, `drainEdrHints` |
| `apps/api/src/jobs/edrProviderSync.ts` | detections job drains hints at start, re-enqueues `rerun` if the marker advanced |
| `apps/api/src/routes/webhooks/edr.ts` | Create — `POST /webhooks/edr/:connectionId` |
| `apps/api/src/index.ts` | mount under `/webhooks` |
| `apps/api/src/middleware/partnerGuard.ts`, `bodyLimit.ts`, `globalRateLimit.ts` | exemption / cap / prefix bucket |
| `apps/api/src/routes/edr/connections.ts` | `POST/DELETE /edr/connections/:id/push`, `POST …/push/test` |
| `services/mcpCoverage.ts`, `__tests__/writeRoutePermissionGate.contract.test.ts` | register the webhook file / public route |
| `apps/api/src/services/aiToolsEdr.ts` + registries | `sync_edr_data` (Tier 2) |
| `apps/web/src/components/devices/DeviceEdrGenericSection.tsx` (+ new `EdrActionButtons.tsx`, `EdrActionHistory.tsx`) | action buttons + ledger |
| `apps/web/src/components/integrations/EdrProviderConnectionCard.tsx` | actions switch + push switch |
| `apps/web/src/lib/edrProviders.ts` | client calls |
| `apps/web/src/locales/*/…` (8 dirs) | strings |

### Task B1: Migration 2 + schema

Content: `ALTER TABLE edr_connections ADD COLUMN IF NOT EXISTS push_enabled boolean NOT NULL DEFAULT false; … push_registered_at timestamptz; … pending_hint_at timestamptz;` plus header comment (no `org_id` → no export-policy row; DDL only). Schema test is red first (column defaults); then `db:check-drift`. Commit `feat(edr): push-hint columns on edr_connections (#8167)`.

### Task B2: GravityZone push — settings calls + `verifyWebhook`

**Interfaces:**
```ts
// types.ts
export interface RawWebhookRequest { headers: Record<string, string | undefined>; body: string }
export interface EdrWebhookHint { vendorTenantId?: string; vendorDetectionId?: string }
verifyWebhook?(req: RawWebhookRequest, secret: string): { ok: true; hints: EdrWebhookHint[] } | { ok: false; error: string };
registerPush?(ctx: EdrAdapterContext, o: { url: string; secret: string; vendorTenantIds: string[] }): Promise<void>;
unregisterPush?(ctx: EdrAdapterContext): Promise<void>;
sendTestPush?(ctx: EdrAdapterContext): Promise<void>;
```
- Client: `setPushEventSettings({ status: 1|0, serviceType: 'jsonRPC', serviceSettings: { url, authorization, requireValidSslCertificate: true }, subscribeToEventTypes: { 'new-incident': true, av: true, 'aph': true, … } , subscribeToCompanies })`, `getPushEventSettings`, `sendTestPushEvent`. Operation class `push` with `operationBudgets.push = { perMinute: 5 }` (vendor 5/min). Event-type list and param names are `[U]` until the lab run; fixture per shape.
- `verifyWebhook` (pure, `bitdefender/push.ts`): constant-time compare (`crypto.timingSafeEqual` over equal-length SHA-256 digests of both strings, so a length mismatch leaks nothing) of `headers.authorization` against `secret`. **Ignore `Event-Push-Service-Md5`.** Parse `{ method: 'addEvents', params: { events: [...] } }`; per event emit `{ vendorTenantId: event.companyId }` (string, ≤128 chars, else dropped) and `vendorDetectionId` only for `module === 'new-incident'` with a string `incidentId` (`[U]` field name). Cap at 100 hints; malformed JSON with a valid secret → `{ ok: true, hints: [] }`, which still triggers one connection-wide poll (authenticated "something happened").
- Tests (red first): wrong/missing/empty secret → not ok; correct secret with a forged md5 header → ok; length-mismatch timing path uses the digest compare (spy on `timingSafeEqual`); >100 events → 100 hints; non-string ids dropped; the hint objects carry **no** other field (snapshot of keys).
- Commit `feat(edr): GravityZone push settings + hint-only webhook verification (#8167)`.

### Task B3: Durable hints + detection-job coordination

**Interfaces:**
```ts
export async function recordEdrHint(connectionId: string, hints: EdrWebhookHint[], redis: Redis | null): Promise<void>;
// SADD edr:hints:<connId> (members `t:<tenant>` / `d:<tenant>:<det>`, capped 500 via SCARD check, EXPIRE 1h)
// + UPDATE edr_connections SET pending_hint_at = now() (system ctx, short tx)
export async function drainEdrHints(connectionId: string, redis: Redis | null): Promise<{ hints: EdrWebhookHint[]; markerAt: Date | null }>;
```
- The detections job, at start: **snapshot** (not clear) the hints: `const snap = await readEdrHints(...)` returns `{ members, markerAt }`. Only **after Phase 3 commits successfully** does it acknowledge them: `SREM` exactly `snap.members`, and `UPDATE edr_connections SET pending_hint_at = NULL WHERE id=$1 AND pending_hint_at <= $snap.markerAt` (CAS). So a crash or failed run loses nothing, and a hint that arrives mid-run survives (its marker is newer than the snapshot). Then, if `pending_hint_at` is still non-null, `enqueueEdrSync(id, 'detections', { rerun: true })`. If that rerun id is itself active and the enqueue coalesces (Codex finding), the `sync-all` sweep below still picks the connection up within 5 min, so durability does not depend on the rerun enqueue. (`drainEdrHints` in the interface above becomes `readEdrHints` + `ackEdrHints(connectionId, snap)`.) This closes the `enqueueOrReplaceStale` dropped-payload gap (`services/bullmqUtils.ts:51-54`). Adapters with `getDetections` use the drained detection hints; GravityZone has none, so it runs its normal connection delta. The incidents budget (2/min) is the real latency floor; the UI must not promise seconds.
- `sync-all` treats `pending_hint_at > last_detection_sync_at` as "due now" (durable fallback when Redis lost the set).
- Tests: hint mid-run → exactly one rerun enqueue; hint before run → no rerun; Redis null → DB marker alone still makes the connection due; cap enforced.
- Commit `feat(edr): durable push hints coordinate with the detection sync (#8167)`.

### Task B4: Public webhook route

`POST /api/v1/webhooks/edr/:connectionId` in `routes/webhooks/edr.ts`, mounted `api.route('/webhooks', edrWebhookRoutes)` beside Xero (index.ts ~:919). It is **not** under `/edr`, whose router applies `authMiddleware` to `*` (`routes/edr/index.ts`) (Open Decision 4; the spec said `/edr/webhook/:id`).

Handler order (each a test):
1. `connectionId` must be a uuid → otherwise 404 (not 400: do not confirm the route shape to scanners).
2. Per-connection Redis limit (60/min) **before** any DB read → 429. `globalRateLimit.ts` gets a prefix bucket `{ prefix: '/api/v1/webhooks/edr/', name: 'edrwebhook', limit: 1200 }`.
3. Body: `bodyLimitForPath` rule for the prefix at 256 KB; read raw `c.req.text()`.
4. Load the connection under `withSystemDbAccessContext`: missing, `!is_active`, `!push_enabled`, or no adapter `verifyWebhook` → 404 (one uniform response).
5. No `webhook_secret_encrypted` → 403. Decrypt with row-bound AAD (`decryptForColumn('edr_connections','webhook_secret_encrypted', …, rowId)` per W01's encrypted-column helper).
6. `adapter.verifyWebhook` → not ok → 401 (uniform message; no detail).
7. `runOutsideDbContext(() => recordEdrHint(...))` then `enqueueEdrSync(id, 'detections')` → `202 { accepted: true }`. The body is never echoed and never logged.

Middleware: `partnerGuard.ts` gains `if (/^\/api\/v1\/webhooks\/edr\/[0-9a-f-]{36}$/i.test(path)) return true;`. Today an invalid bearer already passes through partnerGuard (Codex verified `partnerGuard.ts:49`). The exemption is defense in depth, matching the Xero/QuickBooks rule that no partner read or activation happens before the route's own secret check: GravityZone *does* send our secret in `Authorization`, and a future partnerGuard change must not start treating it as a JWT. Comment it that way, without overstating it (+ `partnerGuard.test.ts` rows: exact uuid path true, trailing slash / extra segment / non-uuid false). `mcpCoverage.ts`: `'webhooks/edr.ts': { exempt: 'inbound_integration' }`. `writeRoutePermissionGate.contract.test.ts`: `'POST /api/v1/webhooks/edr/:connectionId': 'webhook: EDR push hint; connection lookup + adapter secret verification in handler'`. CSRF: confirm the CSRF middleware skips requests without a session cookie (Xero precedent); add the path to its exemption only if a test shows it rejects.

Tests (red first): every numbered step; a valid push → hint recorded + one enqueue + 202; **a valid push carrying a fake detection payload writes no `edr_detections` row** (assert no insert mock call); a bearer-shaped `Authorization` does not reach `verifyToken` (partnerGuard spy).
Commit `feat(edr): public push-hint webhook with per-connection secret (#8167)`.

### Task B5: Push opt-in routes

- `POST /edr/connections/:id/push` — `requireEdrPartnerAdmin` + `ORGS_WRITE` + `requireMfa()`.
  1. Generate a 32-byte base64url secret, encrypt it (row AAD), and store it together with `push_enabled=false` in a short tx.
  2. Outside the DB context, call `adapter.registerPush(ctx, { url: \`${publicApiBase()}/api/v1/webhooks/edr/${id}\`, secret, vendorTenantIds: <mapped tenants> })`.
  3. On success, set `push_enabled=true, push_registered_at=now()`. On vendor failure, leave `push_enabled=false` and return the mapped error.

  `publicApiBase()` = `PUBLIC_API_URL ?? BREEZE_SERVER`, the same precedence as `services/backupStorageSessions.ts:328`, with `https://` required; it 409s when neither is set.
- `DELETE /edr/connections/:id/push` — `unregisterPush`, then `push_enabled=false` and secret cleared, even if the vendor call fails (`warnings`).
- `POST /edr/connections/:id/push/test` — `sendTestPush`; the UI then watches `pending_hint_at` change.
- Secret rotation = DELETE + POST. The secret is never returned by any route (`EDR_CONNECTION_PUBLIC_SELECT` already exposes only `hasWebhookSecret`).
- Tests: the gates (selected-org 403, org token 403, MFA); registration failure leaves the connection disabled; the URL uses the env base; audit rows `edr.connection.push_enabled|disabled`.
- Commit `feat(edr): GravityZone push opt-in / opt-out routes (#8167)`.

### Task B6: `sync_edr_data` tool (Tier 2)

Schema `{ connectionId?: uuid, orgId?: uuid }`. Handler: same gate as `POST /edr/connections/:id/sync` (`requireEdrPartnerAdmin(auth)`; org tokens and selected-org users get `{ error }`). With `orgId`, it syncs the connections mapping that org; `enqueueEdrSync` for both streams runs under `runOutsideDbContext`. Registries: `TIER2_ACTIONS` not needed (base tier 2); `TOOL_PERMISSIONS` `{ resource: 'orgs', action: 'write' }` (route parity, `aiGuardrails.routeParity.contract.test.ts`); rate limit `{ limit: 3, windowSeconds: 600 }`; `aiAgentSdkTools` tier 2; catalog `security_response`. Agent principals: add to `AGENT_HUMAN_ONLY_TOOLS`? **No.** The sync is read-only toward the vendor and coalesced; but it writes no users FK, so no `USER_OWNED_RELEASE_ACTIONS` entry. Tests: gate refusals, enqueue outside DB context, registry contracts from A11 Step 4. Commit `feat(edr): sync_edr_data AI tool (#8167)`.

### Task B7: Web — action buttons, ledger, connection switches

- `EdrActionButtons.tsx` inside `DeviceEdrGenericSection`: one button per `endpoint.actions` entry with `available` (disabled + tooltip `reason` otherwise; hidden entirely when every action is unavailable for the kill-switch reason).
  - **Isolate / release isolation**: confirm dialog naming device, vendor and consequence ("the device loses network access except to GravityZone"), with an optional reason field. **Scan**: one-click with toast.
  - All through `runAction` → `POST /edr/actions`. A 202 `outcomeUnknown` shows a neutral "Requested — confirming with GravityZone" state, not an error. A 409 `action_in_progress` shows an info toast, not an error. 401 is handled per the CLAUDE.md catch pattern.
  - `data-testid`: `edr-action-isolate`, `edr-action-unisolate`, `edr-action-scan`, `edr-action-confirm`.
- `EdrActionHistory.tsx`: last 10 rows from `GET /edr/actions?deviceId=` with status, requested-via (AI badge when `requestedVia==='ai'`), who, and when; refresh after an action and on a 15 s poll while any row is open.
- Connection card: an "Allow response actions" switch (`PATCH actionsEnabled`, confirm on enable). A "Push events" switch (POST/DELETE push) with a "Send test event" button and the last hint time. Both are hidden for non-partner-admins with the W02 stated reason (`canManagePartnerWide`).
- Settings rule 9: no new home; the switches live on the existing Integrations → Security card (count 1 → 1).
- Locales: all keys in 8 dirs; `localeParity` + `translationCoverage.test.ts`.
- Tests (red first, jsdom): disabled-with-reason rendering; the confirm dialog is required for isolate/unisolate but not scan; 202 unknown state; 409 info; the switches hidden for selected-org users; `no-silent-mutations` passes.
- Commit `feat(edr): web response-action buttons, history, connection action/push switches (#8167)`.

### Task B8: PR-B verification + lab

- tsc api/web/shared exit 0; full API unit run; web unit run; `db:check-drift`; integration suites from A14 (migration 2 touches only a no-org table, but run `tenant-export-policy` anyway: it is the suite that catches a mistaken org-table column).
- Lab: enable push on the trial connection through a tunnel-exposed lab stack; `sendTestPushEvent` reaches the webhook, `pending_hint_at` advances, and one detections job runs; a request with a wrong `Authorization` → 401 and no enqueue. Isolate/restore from the **web UI** on the nested brzlab VM; the unlicensed company shows disabled-with-reason.
- Browser pass recorded for the next pre-release sweep.
- One independent review round (Sonnet/Opus: public unauthenticated route).

---
## Open Decisions (Gate B — Todd)

Each one has a recommendation. Unless one is overridden, the plan executes as written.

1. **PR split: the action AI tools ship in PR-A, not PR-B.** `mcp-coverage.test.ts` refuses a new route file without its tool and freezes gaps, so `routes/edr/actions.ts` cannot merge before `edr_endpoint_action`. **Recommend accept.** This is the index's original W03 split, and Codex agrees. `sync_edr_data`, push and web stay in PR-B as asked.
2. **Kill switches: two of them.** The env `BREEZE_EDR_ACTIONS_ENABLED` defaults **true** and is read per call, as the server-wide off switch. The per-connection `actions_enabled` defaults **false** and is a partner-admin + MFA opt-in. **Recommend accept** (Codex agrees). The alternative, env default false, makes every self-hoster set a variable *and* flip the per-connection switch, which buys nothing over the per-connection gate.
3. **The durable hint marker goes on `edr_connections.pending_hint_at`**, not the index's `edr_tenants.pending_hint_at`. The GravityZone detection fetch is connection-wide (incidents budget 2/min), so tenant granularity adds nothing, and the no-`org_id` table needs no export-policy row. Tenant/detection granularity stays in the Redis set for future adapters with `getDetections`. **Recommend accept.**
4. **Webhook path `POST /api/v1/webhooks/edr/:connectionId`** instead of the spec's `/edr/webhook/:connectionId`. The `/edr` router applies `authMiddleware` to `*`, and `/webhooks` is where Xero, QuickBooks, Stripe and Resend already live, with their body-limit, rate-limit and partnerGuard conventions. **Recommend accept.**
5. **Autonomous agents may *propose* EDR actions**: every agent call mints an intent, and release runs as the approving human (S1 parity). The alternative is listing the tools in `AGENT_HUMAN_ONLY_TOOLS`. Constraint: the approver must be a partner-axis user (`actorContext.ts:203-210`); an org-only user cannot release an agent's action. **Recommend allow via intents.** Agents reaching EDR read tools today are useless if they can never propose containment, and nothing runs without a human.
6. **Human UI actions get no second approver.** `devices.execute` + MFA for all actions, including release of isolation (spec §4.10, S1 parity). Only AI-initiated actions use four-eyes. **Recommend accept**, the spec's own position. Listed because "release containment" is four-eyes for AI and not for humans.
7. **Site-restricted technicians may act only on endpoints linked to a device in their allowed sites.** Never-linked and detached endpoints get 403. This is stricter than the W02 read rule, which shows never-linked findings. **Recommend accept**: reading an unattributed finding is fine; isolating a machine whose site is unknown is not.
8. **`edr_detection_action` is registered only if the lab proves GravityZone quarantine restore/delete with the trial key** (A4b). Otherwise W03 ships only `edr_endpoint_action`. The tier tables still classify all ten actions, so the first adapter with detection actions inherits vetted tiers. **Recommend accept** (no dead tool in the model's context, #6147).
9. **Duplicate-request protection** (*Codex disagreed* with the first draft). The plan has in-flight partial unique indexes (one queued/submitted row per target and action) plus a 60 s same-action cooldown. Codex argued that only a durable request identity (client idempotency key, unique per actor) prevents a second task after a fast success. **Recommend in-flight index + cooldown now; defer the durable key.** The AI path is already single-shot (intent executing-CAS), the UI disables the button while a request is open, and isolate/restore are idempotent at the vendor (a repeat is a no-op on an isolated endpoint). Only a repeated *scan* costs anything. Revisit if the ledger ever shows two scans inside a minute. The durable key needs a column and an export-policy row.
10. **Licence denial memory**: a per-company `edr_tenants.unsupported_actions` with a 24 h TTL. The alternative is to always ask the vendor and show the error. **Recommend the column**: the spec requires "disabled-with-reason" for an unlicensed company (index W03 gate), and GravityZone offers no documented pre-flight licence query. The `api_not_enabled` (key permission) case uses the existing `capabilities_snapshot` notes instead, per Codex.
11. **#8658 is folded into PR-A as its own task (A12)**, closing that issue from PR-A. **Recommend accept**: it is a 10-line read-model fix in a file PR-A already touches, and a reviewer can reject it independently.

## Advisor quorum record

- **Fable position:** written before review (scratch `w03-position.md`, P1–P9).
- **Codex** (`gpt-6-astra`, `xhigh`, read-only, 2026-10-13) checked each position against the repo with file:line evidence.
- **Agreed:**
  - P1 split (AI with route);
  - P3 kill-switch defaults;
  - P6 gates (org scope allowed by spec);
  - P9 #8658 is real.
- **Codex disagreed — verified and adopted:**
  - (P4) The request transaction makes commit-before-send impossible. Fixed with the self-managed route plus `selfManagedDbContext: true` and an entry assertion (A6).
  - (P4) Org-scope callers cannot read partner tables. Authorization is now split from the system-context credential load keyed by the authorized row (A6).
  - (P5) `api_not_enabled` is a key permission, not a licence. Only connection-scoped `reauth` flips the connection, and unknown codes get a default branch (A5).
  - (P7) Tier entries must be literals, and aliases key the tool-module attribution line. Already planned and reinforced (A11).
  - (P8) Clearing hints at start loses them on a crash. Replaced with snapshot + ack-after-commit CAS, with the `sync-all` sweep as the durable fallback (B3). The partnerGuard rationale was corrected (B4).
  - (omission) Action reserve / polling floor in the limiter (A5).
  - (omission) Partner-axis approver constraint and agent-run provenance (A11).
  - (omission) Remap race fenced by the composite FKs (A6 step 7).
  - (omission) CAS outcome writes (A6 step 9, A8).
- **Codex disagreed — not fully adopted:** P2 durable request identity → Open Decision 9.
- **Advisor (Fable reviewer) additions adopted:**
  - literal tier tables;
  - `deviceId`-keyed AI tool with `deviceArgs`;
  - the licence-denial sequencing (first attempt writes a failed row; later attempts refuse pre-insert);
  - `[U]` vendor return shapes resolved by the lab;
  - an explicit no-FK line for `approval_id`;
  - request-path `maxWaitMs`;
  - the webhook registration surfaces.

## Self-review notes (for executors)

- **Spec coverage:**
  - §4.10 steps 1–5 → A6, A8, A9;
  - AI tiers → A11;
  - user-owned release → A11;
  - §4.8 rules 1–4 → B2, B4;
  - §4.4 hint coordination → B3;
  - §4.11 tools → A11, B6;
  - §4.12 device action buttons → B7;
  - index W03 gates → A15, B8;
  - acceptance "one row per target with `requested_via` / `ai_session_id` / `approval_id`" → A6, A11, A13;
  - "AI never lands an agent id in `requested_by`" → A11;
  - "unknown normalized action refused" → A11 (zod enum + fail-closed tier);
  - "forged-but-signed webhook only causes an extra poll" → B4.
- **Not in W03** (stated so nobody adds them): Sophos/Emsisoft actions (W04/W05), `kill_process` / `rollback` / `resolve_detection` / `mark_false_positive` adapters, bulk/fleet isolate UI, automation-triggered actions (`requested_via='automation'` stays unused), S1/Huntress port (D2).
- **Type names used across tasks:**
  - `EdrActionRequest`, `EdrActionResult`, `EdrActionSupport`, `EdrActionTargetFacts`, `EdrReconcileVerdict` (A2);
  - `EdrActionError`, `classifyVendorActionError`, `edrActionsEnabled` (A5);
  - `dispatchEdrAction`, `describeEndpointActions`, `EdrActionActor`, `EdrActionTargetInput`, `EdrActionOutcome` (A6);
  - `listEdrActions` (A7);
  - `pollEdrActionStatus` (A8);
  - `readEdrHints` / `ackEdrHints` / `recordEdrHint` (B3).

## Execution handoff

Recommended: **subagent-driven**. PR-A has 15 tightly coupled tasks over a high-blast-radius surface: remote containment, AI approval gates, tenancy. A per-task fresh reviewer catches registration misses, which the contract tests catch 5/5 and humans 0/5. Gate B approval (`plan-approved` label, added by Todd) is required before execution starts.
