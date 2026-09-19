# Caller Verification W05: Enforcement and Activation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require a fresh, single-use caller verification for M365 password resets and account disables, pin the Entra target through every backend, make rejection win before dispatch, support interactive administrative disable, and activate the completed feature.

**Architecture:** W01 owns the ledger, policy, binding resolution, gate and rejection outbox; W02–W04 supply delivery and UI. W05 adds immutable target snapshots to action intents, consumes only after the existing `executing` claim, then repeats verification under requester/target locks in a separately committed dispatch transaction. Only the pinned OID crosses the mutation boundary. Typed refusals survive chat, worker, MCP and helper adapters. Administrative grants retain the proven session and both epochs.

**Tech Stack:** Hono, TypeScript, Drizzle/PostgreSQL forced RLS, Redis step-up grants, BullMQ intent outbox, Vitest, Microsoft Graph executors, Astro docs, React/i18next UI from W04.

**Spec:** `docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md` v5; W05, D5/D8/D11/D13–D16, “Gate wiring”, “Administrative disable”, rejection fan-out, behavioural/integration testing and activation. Cross-wave authority: `docs/superpowers/plans/security-auth/2026-09-19-caller-verification.md`.

## Global Constraints

- This document is a plan. Its implementation commands are for the later W05 executor. Writing this plan neither implements nor commits product changes.
- W05 depends on **all W01–W04**. On the inspected checkout, `callerVerification/`, its schema, routes and W01 revocation stub do not yet exist. Paths marked **W01-owned** or **W04-owned** below are dependency outputs, not claims about current files. Read their merged implementations first; keep the index's public signatures unchanged. No made-up current line numbers are attached to those outputs.
- Preserve names: `callerVerifications`, `callerVerificationSubjectBindings`, `callerVerificationDestinations`, `callerVerificationPolicies`; SQL `caller_verifications`, `caller_verification_subject_bindings`, `caller_verification_destinations`, `caller_verification_policies`. Preserve all six `callerVerification*Enum` exports and their values from the index. This wave adds no enum value to that ledger.
- Every new tenant table has **RLS enabled + forced + policies in its creating migration**. Composite FKs carrying `org_id` are **DEFERRABLE INITIALLY IMMEDIATE**. W05 adds columns to an already protected table; it does not replace W01 policies or registrations.
- Migrations are idempotent, contain no inner `BEGIN`/`COMMIT`, and never edit shipped files. DML migrations start with `SELECT set_config('breeze.scope','system',true);` and report row counts. This wave's migration is DDL only. Reserved name: `2026-10-15-180300-action-intents-caller-target.sql`.
- Before **every commit**, run `ls apps/api/migrations | sort | tail -1`; compare with main and rename the unshipped migration upward if necessary, updating test references. The inspected latest committed file is `2026-10-15-160010-backup-snapshots-layout-manifest.sql`; billing owns `1700xx`, W01 owns `180000`, `180100`, `180200`.
- Never name a column `device_id` or `ticket_id` on the new tables. Preserve `workstation_device_ref`, `ticket_ref`, `consumed_intent_ref` snapshots with no FK. `target_connection_ref` is also a snapshot **without FK**; connection route and principal identity are separate.
- Classify all four new `action_intents` columns as `included` in `CORE_TENANT_EXPORT_POLICY`. Existing cascade/merge classifications remain; W01 owns the four caller tables' cascade/export/merge/RLS registrations.
- Readiness flag is `CALLER_VERIFICATION_ENABLED`. It remains false through Tasks 1–13, then defaults true in Task 14. False hides authenticated routes/UI and refuses protected execution; it is not a bypass switch. Missing intents always refuse. Do not expose W04 entry points before enforcement and rejection work.
- Preserve the exact gate interface: `requireCallerVerification(input: GateInput): Promise<{ verificationId: string; tier: number }>` with `GateInput = { orgId: string; action: CallerVerificationAction; target: EntraSubject; backendTenantId: string; technicianUserId: string; intentId: string; mode: 'check' | 'consume' }`. Creation uses `check` on unused evidence; dispatch separately insists on consumed ownership. Do not change what `check` means globally.
- Preserve `withSubjectLocks<T>(tx: Tx, bindingIds: Array<string | null>, fn: () => Promise<T>): Promise<T>`: ascending, deduplicated UUIDs, nulls omitted. Rejection and positive-tier consume/dispatch lock **both requester and target**, including manager A authorising B. No external mutation while those locks or their transaction remain open.
- The default partner policy requires tier 2; an org can only tighten it. A configured tier 0 still requires pinned identity, matching backend tenant and a durable intent. The index requires a verification ID even at tier 0 but specifies no sentinel; reconcile W01's implementation by returning `{ verificationId: '', tier: 0 }` for that explicit bypass; dispatch branches at tier 0 before binding, grant and fence checks, while retaining feature readiness, pinned identity, backend tenant, intent and dispatch-marker checks. Task 5 specifies this branch rather than inventing a grant row.
- `withSystemDbAccessContext` joins an ambient context. A background outbox job calls it directly. Request-originated escalation must use `runOutsideDbContext` **at the boundary**, never inside a transaction already holding subject locks. Dispatch reopens the same restricted org context, commits the marker, and only then performs HTTP/broker I/O.
- Web mutations use `runAction`; all new UI strings use real translations in all 8 locales: `en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`. This wave consumes W04's UI without adding a second flow.
- Branch `feature/<parent#>-caller-verification/wave-<sub#>`; PR body `Closes #<sub#>`. Resolve those two issue numbers from the assigned wave before creating the implementation branch. No merge/deploy in this plan.
- Run targeted API tests with `cd apps/api && npx vitest run <path>` and web tests with `cd apps/web && npx vitest run <path>`. Never forward `-- --run`. Integration requires `pnpm test-stack up` / `pnpm test-stack down`. RLS catalog coverage has its own `vitest.config.rls-coverage.ts`; the general integration config explicitly excludes it.

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-15-180300-action-intents-caller-target.sql` | Four columns and immutable target guard |
| `apps/api/src/db/schema/actionIntents.ts` | Drizzle target/dispatch fields |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | Include all four new columns |
| `apps/api/src/services/actionIntents/callerTarget.ts` | Protected action mapping, pinned connection loading |
| `apps/api/src/services/actionIntents/intentService.ts` | Resolve/check/store target before approval fan-out |
| `apps/api/src/services/actionIntents/revalidateRelease.ts` | Post-claim consume, structured failure |
| `apps/api/src/services/callerVerification/dispatch.ts`, `dispatch.test.ts`, `dispatchGateContext.ts` | Task 5: tier-zero branch, reader-scoped mailbox prefetch and committed dispatch marker |
| `apps/api/src/services/m365ControlPlane/readActionService.ts` | Verify the actual target-lookup credential against the expected tenant |
| `apps/api/src/jobs/callerVerificationPublisher.ts` | W01-owned durable administrative notification publication |
| `apps/api/src/services/callerVerification/gate.ts`, `locks.ts`, `rejection.ts` | W01-owned gate/fence/locking seam |
| `apps/api/src/services/m365DirectGraph.ts` | Direct PATCH guard and tenant-aware token cache |
| `apps/api/src/services/m365ControlPlane/writeActionService.ts` | Control-plane guard before executor call |
| `packages/shared/src/m365/writeActions.ts` | Strict wire action accepts pinned `oid` |
| `apps/m365-graph-actions-executor/src/microsoft/writeActions.ts` | OID execution without UPN resolution |
| `apps/api/src/services/aiToolsM365.ts`, `m365ToolsHeadless.ts` | Delegant guard and pinned backend routing |
| `apps/api/src/services/aiAgentSdkTools.ts`, `toolExecutionContext.ts` | Preserve existing `actionIntentId` context |
| `apps/api/src/services/actionIntents/revokeIntentsForSubject.ts` | Complete W01 system revocation stub |
| `apps/api/src/services/callerVerification/incidentLinks.ts` | Idempotent links to intent terminal states |
| `apps/api/src/services/mfaStepUpGrant.ts` | Administrative operation and digest |
| `apps/api/src/routes/auth/schemas.ts`, `mfa.ts` | Interactive step-up operation/resource |
| `apps/api/src/services/callerVerification/administrativeContext.ts`, `administrative.ts` | Request proof context, durable row and live eligibility |
| `apps/api/src/services/callerVerification/service.ts` | Tasks 11–12: preserve administrative attempt cap/audit actor; project consumed intent status through W01’s HTTP view |
| `apps/api/src/routes/callerVerification.ts` | W01-owned administrative POST |
| `apps/api/src/services/callerVerification/refusal.ts` | Single safe refusal serializer |
| `apps/api/src/services/aiAgentSdk.ts`, `apps/api/src/jobs/intentReleaseWorker.ts` | Inline/worker refusal persistence |
| `apps/api/src/routes/mcpServer.ts`, `apps/api/src/routes/helper/index.ts` | External MCP and helper stream/history adapters |
| `apps/api/src/services/callerVerification/callerVerificationGate.contract.test.ts` | Four-file named-case wiring contract |
| `apps/api/src/__tests__/integration/callerVerificationEnforcement.integration.test.ts` | Task 13: email adapter, bindingless tier zero, administrative cap/audit and outbound failure through real release |
| `apps/api/src/services/callerVerification/readiness.test.ts`, `apps/api/src/config/env.callerVerification.test.ts` | Task 14: inherited and new activation tests agree on unset→true, explicit false and invalid values |
| `apps/api/src/config/env.ts`, `.env.example`, `docker-compose.yml`, `deploy/docker-compose.prod.yml` | Activation and API env mapping |
| `apps/docs/src/content/docs/security/caller-verification.mdx`, `docs/release-notes/next-release-draft.md` | User/operator guidance |

Co-located `.test.ts` additions are enumerated in their owning tasks. W01's canonical row types are inferred from its schema; do not duplicate the ledger schema. All subsequent snippets are additions/replacements at the named seams, with existing unrelated code retained.

### Task 1: Persist and protect the pinned target

**Files:** Create `apps/api/migrations/2026-10-15-180300-action-intents-caller-target.sql`; create `apps/api/src/db/callerTargetColumns.test.ts`; modify `apps/api/src/db/schema/actionIntents.ts:151` (`actionIntents` table), `apps/api/src/services/tenantExportPolicyRegistry.ts:44` (`action_intents` entry).

**Interfaces:** Consumes `actionIntents`, `CORE_TENANT_EXPORT_POLICY`; produces `targetEntraTenantId: string | null`, `targetEntraOid: string | null`, `targetConnectionRef: string | null`, `dispatchStartedAt: Date | null` on `ActionIntent`.

- [ ] **Step 1: Write the failing test.**

```ts
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { actionIntents } from './schema/actionIntents';
import { CORE_TENANT_EXPORT_POLICY } from '../services/tenantExportPolicyRegistry';
it('persists all four caller target columns and exports them', () => {
  const columns = getTableColumns(actionIntents);
  for (const name of ['target_entra_tenant_id', 'target_entra_oid',
    'target_connection_ref', 'dispatch_started_at']) {
    expect(Object.values(columns).map(c => c.name)).toContain(name);
    expect(CORE_TENANT_EXPORT_POLICY.action_intents!.columns[name]?.decision).toBe('include');
  }
});
it('protects identity without freezing the dispatch lifecycle marker', () => {
  const sql = readFileSync(new URL('../../migrations/2026-10-15-180300-action-intents-caller-target.sql', import.meta.url), 'utf8');
  expect(sql).toContain('OLD.target_entra_oid IS DISTINCT FROM NEW.target_entra_oid');
  expect(sql).not.toContain('OLD.dispatch_started_at IS DISTINCT FROM');
  expect(sql).not.toMatch(/target_connection_ref\s+uuid\s+REFERENCES/i);
});
```

- [ ] **Step 2: Run:** `cd apps/api && npx vitest run src/db/callerTargetColumns.test.ts` → fails on missing columns/migration.
- [ ] **Step 3: Implement.** Add the fields to the existing Drizzle table (imports already include `varchar`, `uuid`, `timestamp`):

```ts
  targetEntraTenantId: varchar('target_entra_tenant_id', { length: 64 }),
  targetEntraOid: varchar('target_entra_oid', { length: 64 }),
  targetConnectionRef: uuid('target_connection_ref'),
  dispatchStartedAt: timestamp('dispatch_started_at', { withTimezone: true }),
```

Append the four SQL names to the existing `included` array; retain every other classification. Write this migration in full:

```sql
ALTER TABLE action_intents
  ADD COLUMN IF NOT EXISTS target_entra_tenant_id varchar(64),
  ADD COLUMN IF NOT EXISTS target_entra_oid varchar(64),
  ADD COLUMN IF NOT EXISTS target_connection_ref uuid,
  ADD COLUMN IF NOT EXISTS dispatch_started_at timestamptz;

-- Separate guard preserves every clause of the existing content trigger,
-- including task identity and device/ticket tombstone exceptions.
CREATE OR REPLACE FUNCTION action_intents_block_caller_target_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.target_entra_tenant_id IS DISTINCT FROM NEW.target_entra_tenant_id
     OR OLD.target_entra_oid IS DISTINCT FROM NEW.target_entra_oid
     OR OLD.target_connection_ref IS DISTINCT FROM NEW.target_connection_ref THEN
    RAISE EXCEPTION 'action intent caller target is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS action_intents_caller_target_immutable ON action_intents;
CREATE TRIGGER action_intents_caller_target_immutable
  BEFORE UPDATE ON action_intents FOR EACH ROW
  EXECUTE FUNCTION action_intents_block_caller_target_update();
```

The existing content trigger's latest replacement is `2026-10-14-100200-ai-operator-intent-identity.sql:114`; do not overwrite it from an older migration. Existing unpinned intents remain null and refuse release; do not backfill through a mutable UPN.

- [ ] **Step 4: Run:** `cd apps/api && npx vitest run src/db/callerTargetColumns.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts` → pass. Task 13 applies the migration twice and proves SQLSTATE 23514 for all three pinned fields.
- [ ] **Step 5: Commit.**

```bash
ls apps/api/migrations | sort | tail -1
git add apps/api/migrations/2026-10-15-180300-action-intents-caller-target.sql apps/api/src/db/schema/actionIntents.ts apps/api/src/db/callerTargetColumns.test.ts apps/api/src/services/tenantExportPolicyRegistry.ts
git commit -m "feat(caller-verification): pin immutable intent targets"
```

### Task 2: Resolve the selected backend to canonical tenant and OID

**Files:** Create `apps/api/src/services/actionIntents/callerTarget.ts`, `apps/api/src/services/actionIntents/callerTarget.test.ts`; modify `apps/api/src/services/aiToolsM365.ts:73,78,102,133` (backend union, context, call, resolution); modify `apps/api/src/services/m365ControlPlane/readActionService.ts:103,140`, `apps/api/src/services/m365ControlPlane/readActionService.test.ts`; modify `apps/api/src/services/toolExecutionContext.ts:91`, `apps/api/src/services/m365DirectGraph.ts:105,122,212` for the private expected-backend read pin.

**Interfaces:** Consumes index `EntraSubject`; produces the following W05-private interfaces (no cross-wave signature changes):

```ts
export type CallerBackend =
  | { backend: 'direct'; connectionId: string; tenantId: string; orgId: string }
  | { backend: 'controlPlane'; connectionId: string; tenantId: string; orgId: string }
  | { backend: 'delegant'; connectionId: string; tenantId: string; orgId: string };
export function callerAction(name: string): 'reset_password' | 'disable_user' | null;
export function loadPinnedCallerBackend(orgId: string, connectionId: string): Promise<CallerBackend>;
// Exported from aiToolsM365.ts; the preceding exports live in callerTarget.ts.
export function resolveM365CallerTarget(auth: AuthContext, orgId: string,
  identifier: string, sessionId?: string): Promise<CallerBackend & { entraOid: string }>;
```

Actual source differs from the spec shorthand: session `resolveContext` selects only direct/Delegant; the control-plane path lives in `m365ToolsHeadless.ts:55`. Unify protected mutation selection here: direct first, then the **selected session's** authorised Delegant connection, then active `customer-graph-actions`. With no session, use the control-plane profile, or exactly one active Delegant connection. Multiple possible Delegant connections refuse ambiguity. Persist the chosen connection; never select a fallback during release.

- [ ] **Step 1: Write the failing unit test.**

```ts
import { describe, expect, it } from 'vitest';
import { callerAction, requireResolvedOid } from './callerTarget';
describe('canonical caller targets', () => {
  it('maps only the two protected tools', () => {
    expect(callerAction('m365_reset_password')).toBe('reset_password');
    expect(callerAction('m365_disable_user')).toBe('disable_user');
    expect(callerAction('m365_lookup_user')).toBeNull();
  });
  it('never falls back to a UPN when Graph omitted id', () => {
    expect(() => requireResolvedOid({ userPrincipalName: 'person@example.com' })).toThrow();
    expect(() => requireResolvedOid({ id: 'person@example.com' })).toThrow();
    expect(requireResolvedOid({ id: '11111111-1111-4111-8111-111111111111' }))
      .toBe('11111111-1111-4111-8111-111111111111');
  });
});
```

- [ ] **Step 2: Run:** `cd apps/api && npx vitest run src/services/actionIntents/callerTarget.test.ts` → module missing.
- [ ] **Step 3: Implement `callerTarget.ts`.** Imports resolve against real schema `m365.ts:42,45` and `delegant.ts:19`.

```ts
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { m365Connections, delegantM365Connections } from '../../db/schema';
import { CallerVerificationValidationError } from '../callerVerification';
export type CallerBackend = {
  backend: 'direct' | 'controlPlane' | 'delegant';
  connectionId: string; tenantId: string; orgId: string;
};
export function callerAction(name: string): 'reset_password' | 'disable_user' | null {
  return name === 'm365_reset_password' ? 'reset_password'
    : name === 'm365_disable_user' ? 'disable_user' : null;
}
export function requireResolvedOid(resource: Record<string, unknown>): string {
  const oid = resource.id;
  if (typeof oid !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(oid)) {
    throw new CallerVerificationValidationError('subject_unmatched', 'Microsoft did not return a canonical object ID');
  }
  return oid.toLowerCase();
}
export async function loadPinnedCallerBackend(orgId: string, connectionId: string): Promise<CallerBackend> {
  const direct = await db.select().from(m365Connections).where(and(
    eq(m365Connections.id, connectionId), eq(m365Connections.orgId, orgId),
  )).limit(1);
  const row = direct[0];
  if (row?.status === 'active' && row.tenantId &&
      (row.profile === 'legacy-direct' || row.profile === 'customer-graph-actions')) {
    return { backend: row.profile === 'legacy-direct' ? 'direct' : 'controlPlane',
      connectionId: row.id, tenantId: row.tenantId, orgId };
  }
  const [broker] = await db.select().from(delegantM365Connections).where(and(
    eq(delegantM365Connections.id, connectionId), eq(delegantM365Connections.orgId, orgId),
  )).limit(1);
  if (broker?.status === 'active') return {
    backend: 'delegant', connectionId: broker.id, tenantId: broker.m365TenantId, orgId,
  };
  throw new CallerVerificationValidationError('connection_not_ready', 'The pinned Microsoft connection is unavailable');
}
```

Add the following resolver to `aiToolsM365.ts`; use existing `principals`, `env`, `loadSession`, `loadConnection`, `authorizeConnection`, `invokeDirect`, `invokeDelegantTool`, `executeM365ReadAction`. Import `db`, schema tables, `and`, `eq`, the three Task 2 exports, and `CallerVerificationValidationError`.

```ts
export async function resolveM365CallerTarget(
  auth: AuthContext, orgId: string, identifier: string, sessionId?: string,
): Promise<CallerBackend & { entraOid: string }> {
  if (!auth.canAccessOrg(orgId)) throw new Error('Organization not accessible');
  const connections = await db.select().from(m365Connections).where(and(
    eq(m365Connections.orgId, orgId), eq(m365Connections.status, 'active'),
  ));
  let selectedId = connections.find(c => c.profile === 'legacy-direct')?.id;
  if (!selectedId && sessionId) {
    const session = await loadSession(sessionId);
    if (!session || session.orgId !== orgId || session.userId !== auth.user.id) {
      throw new Error('AI session not accessible');
    }
    if (session.delegantM365ConnectionId) {
      const allowed = authorizeConnection(await loadConnection(session.delegantM365ConnectionId), orgId);
      if (!allowed.ok) throw new Error('Microsoft connection not accessible');
      selectedId = allowed.conn.id;
    }
  }
  selectedId ??= connections.find(c => c.profile === 'customer-graph-actions')?.id;
  if (!selectedId) {
    const brokers = await db.select().from(delegantM365Connections).where(and(
      eq(delegantM365Connections.orgId, orgId), eq(delegantM365Connections.status, 'active'),
    ));
    if (brokers.length !== 1) throw new CallerVerificationValidationError('subject_ambiguous', 'Select one Microsoft connection');
    selectedId = brokers[0]!.id;
  }
  const selected = await loadPinnedCallerBackend(orgId, selectedId);
  let resource: Record<string, unknown>;
  if (selected.backend === 'controlPlane') {
    const read = connections.find(c => c.profile === 'customer-graph-read');
    if (!read || read.tenantId !== selected.tenantId) {
      throw new CallerVerificationValidationError('tenant_mismatch', 'Read and write profiles must use the same tenant');
    }
    const result = await executeM365ReadAction(auth, { type: 'm365.user.get', userIdOrUpn: identifier }, orgId, undefined,
      { connectionId: read.id, tenantId: selected.tenantId });
    if (!result.ok || result.kind !== 'resource') throw new Error('Microsoft target lookup failed');
    resource = result.resource;
  } else {
    const result = selected.backend === 'direct'
      ? await invokeDirect(orgId, 'get_user', { userId: identifier }, { expectedCallerBackend: selected })
      : await invokeDelegantTool({ connection: (await loadConnection(selected.connectionId))!,
          toolName: 'get_user', parameters: { userId: identifier }, ...principals(auth), sessionId: sessionId ?? 'caller-target' }, { env });
    if (result.kind !== 'ok') throw new Error('Microsoft target lookup failed');
    resource = result.data as Record<string, unknown>;
  }
  const after = await loadPinnedCallerBackend(orgId, selected.connectionId);
  if (after.tenantId !== selected.tenantId) throw new CallerVerificationValidationError('tenant_mismatch', 'Connection changed during lookup');
  return { ...selected, entraOid: requireResolvedOid(resource) };
}
```

Add optional fifth `expectedBackend?: { connectionId: string; tenantId: string }` to `executeM365ReadAction`. After its actual connection lookup at line 140 and before client execution, enforce:

```ts
if (expectedBackend && (connection?.id !== expectedBackend.connectionId || connection?.tenantId !== expectedBackend.tenantId)) {
  throw new CallerVerificationValidationError('tenant_mismatch', 'Read connection changed during target lookup');
}
```

Add `expectedCallerBackend?: { connectionId: string; tenantId: string }` to internal `ToolExecutionContext`. Add optional fourth `context?: ToolExecutionContext` to `invokeDirect` now; make both successful `getToken` returns include `{ token, connectionId: row.id, tenantId: row.tenantId! }`. After token success, before any Graph read:

```ts
if (context?.expectedCallerBackend && (tok.connectionId !== context.expectedCallerBackend.connectionId ||
    tok.tenantId !== context.expectedCallerBackend.tenantId)) {
  throw new CallerVerificationValidationError('tenant_mismatch', 'Direct connection changed during target lookup');
}
```

The current local is `tok` at `m365DirectGraph.ts:217`; retain it. In the Delegant lookup branch load its connection into a local variable and compare `id` and `m365TenantId` to `selected` before passing that exact object to the broker. A mismatch throws the same typed validation error; the post-lookup comparison alone cannot detect an intervening re-point and restore. Add to `readActionService.test.ts`'s existing `describe`:

```ts
it('pins the exact read credential row used for target resolution', async () => {
  dbMocks.selectResults.push([connectionRow({ tenantId: '77777777-7777-4777-8777-777777777777' })]);
  await expect(executeM365ReadAction(auth(), { type: 'm365.user.get', userIdOrUpn: 'target@example.com' },
    ORG_ID, undefined, { connectionId: CONNECTION_ID, tenantId: TENANT_ID }))
    .rejects.toMatchObject({ code: 'tenant_mismatch' });
  expect(executorMocks.executeReadAction).not.toHaveBeenCalled();
});
```

Read lookup always verifies the returned OID, even when input already looks like a GUID. Tests in Task 13 prove Delegant-only and two-profile operation. Do not use `resolveUserId`'s existing `data.id ?? identifier` fallback for creation or release.

- [ ] **Step 4: Run:** `cd apps/api && npx vitest run src/services/actionIntents/callerTarget.test.ts src/services/aiToolsM365.test.ts src/services/m365ControlPlane/readActionService.test.ts && npx tsc --noEmit` → pass.
- [ ] **Step 5: Commit.**

```bash
ls apps/api/migrations | sort | tail -1
git add apps/api/src/services/m365DirectGraph.ts apps/api/src/services/m365ControlPlane/readActionService.ts apps/api/src/services/m365ControlPlane/readActionService.test.ts apps/api/src/services/toolExecutionContext.ts apps/api/src/services/actionIntents/callerTarget.ts apps/api/src/services/actionIntents/callerTarget.test.ts apps/api/src/services/aiToolsM365.ts
git commit -m "feat(caller-verification): resolve canonical targets per backend"
```

### Task 3: Check at creation and persist the pin before fan-out

**Files:** Modify `apps/api/src/services/actionIntents/intentService.ts:140,957,1591`, `apps/api/src/services/actionIntents/intentService.test.ts`; modify `apps/api/src/services/aiAgentSdk.ts:1198`; create `apps/api/src/services/callerVerification/refusal.ts`, `apps/api/src/services/callerVerification/refusal.test.ts`.

**Interfaces:** `createActionIntent(auth: AuthContext, input: CreateActionIntentInput): Promise<ActionIntentSnapshot>` unchanged; add internal optional `m365SessionId?: string` to its input, never to a tool schema. Consumes exact `CallerVerificationRequiredError.payload`; produces `requiresCallerVerification` containing that payload, not an error-message substring.

- [ ] **Step 1: Write a failing serializer test.**

```ts
import { expect, it } from 'vitest';
import { CallerVerificationRequiredError } from './errors';
import { callerRefusal } from './refusal';
it('preserves the actionable refusal without error internals', () => {
  const payload = { orgId: '11111111-1111-4111-8111-111111111111', contactId: null,
    action: 'disable_user' as const, requiredTier: 2, reason: 'no_fresh_verification' as const, latest: null };
  expect(callerRefusal(new CallerVerificationRequiredError(payload)))
    .toEqual({ error: 'Caller verification required', requiresCallerVerification: payload });
  expect(callerRefusal(new Error('database secret'))).toBeNull();
});
```

- [ ] **Step 2: Run:** `cd apps/api && npx vitest run src/services/callerVerification/refusal.test.ts` → missing module.
- [ ] **Step 3: Implement serializer and creation insertion.**

```ts
// callerVerification/refusal.ts
import { CallerVerificationRequiredError } from './errors';
export type CallerRefusalPayload = CallerVerificationRequiredError['payload'];
export function callerRefusal(error: unknown): {
  error: string; requiresCallerVerification: CallerRefusalPayload;
} | null {
  return error instanceof CallerVerificationRequiredError
    ? { error: 'Caller verification required', requiresCallerVerification: error.payload } : null;
}
```

In `createActionIntent`, after org/access/guardrail/idempotency validation and before the create/fan-out transaction, allocate `const proposedIntentId = randomUUID();`. The current implementation discovers replay only after INSERT conflict at lines 1685–1758. Add this protected-tool prelookup under `withDbAccessContext(dbAccessContextFromAuth(auth), ...)`; retain the original conflict path for races and its full snapshot return. A replay returns immediately and never attempts a replacement insert:

```ts
const [callerReplay] = callerAction(input.toolName) ? await withDbAccessContext(dbAccessContextFromAuth(auth), () =>
  db.select().from(actionIntents).where(and(eq(actionIntents.orgId, orgId),
    eq(actionIntents.idempotencyKey, idempotencyKey), inArray(actionIntents.status, LIVE_INTENT_STATUSES))).limit(1)) : [];
if (callerReplay && (callerReplay.requestedByUserId !== requesterId || callerReplay.actionName !== input.toolName ||
    callerReplay.source !== input.source || callerReplay.argumentDigest !== argumentDigest)) {
  throw new ActionIntentError('Idempotency key belongs to another request', 'idempotency_conflict');
}
if (callerReplay) {
  return withDbAccessContext(dbAccessContextFromAuth(auth), async () => {
    const rows = await db.select({ id: approvalRequests.id, userId: approvalRequests.userId })
      .from(approvalRequests).where(eq(approvalRequests.intentId, callerReplay.id));
    return toSnapshot(callerReplay, rows.map(row => row.id),
      rows.find(row => row.userId === requesterId)?.id ?? null, []);
  });
}
```

`toSnapshot` is the existing helper at line 543. Returning the observed snapshot remains safe if it becomes terminal meanwhile: no mutation or fresh intent is created. Never resolve a replay's UPN again. Add `existing.requestedByUserId !== requesterId` to the protected-tool conflict predicate at line 1726, retaining all existing action/source/run/digest checks for concurrent inserts. Add this block with the existing `orgId` and `requesterId`:

```ts
const protectedAction = callerAction(input.toolName);
let callerTarget: Awaited<ReturnType<typeof import('../aiToolsM365').resolveM365CallerTarget>> | null = null;
if (protectedAction) {
  if (agentRun || !requesterId) throw new CallerVerificationRequiredError({
    orgId, contactId: null, action: protectedAction, requiredTier: 2,
    reason: 'technician_mismatch', latest: null,
  });
  const { resolveM365CallerTarget } = await import('../aiToolsM365');
  callerTarget = await withDbAccessContext(dbAccessContextFromAuth(auth), () =>
    resolveM365CallerTarget(auth, orgId, String(input.input.userIdentifier ?? ''), input.m365SessionId));
  await withDbAccessContext(dbAccessContextFromAuth(auth), () => requireCallerVerification({ orgId, action: protectedAction,
    target: { entraTenantId: callerTarget.tenantId, entraOid: callerTarget.entraOid },
    backendTenantId: callerTarget.tenantId, technicianUserId: requesterId,
    intentId: proposedIntentId, mode: 'check' }));
}
```

Insert in `.values` **at initial creation**, not a later UPDATE (Task 1 forbids it):

```ts
id: proposedIntentId,
targetEntraTenantId: callerTarget?.tenantId ?? null,
targetEntraOid: callerTarget?.entraOid ?? null,
targetConnectionRef: callerTarget?.connectionId ?? null,
```

Keep immutable `arguments`, argument digest, comms `connectionId/tenantId`, target scope and approval classification unchanged. The pin is separate from UPN display. SDK creation adds `m365SessionId: session.breezeSessionId`; its catch begins:

```ts
const refusal = callerRefusal(err);
if (refusal) return await failMatchedPlanStep({ allowed: false, ...refusal });
```

Before that catch's existing generic logging, retain the existing fallback for unrelated failures. Task 12 widens the denied callback type. Extend `intentService.test.ts`'s real `createActionIntent` harness with a hoisted resolver/gate double: refusing check must reject the typed error and leave `db.insert` uncalled; passing check must inspect insert values for the exact tenant/OID/connection and confirm gate `mode:'check'`, not `consume`. The concrete regression body is:

```ts
it('caller refusal creates no approval or intent', async () => {
  const auth = makeAuth();
  const error = new CallerVerificationRequiredError({ orgId: auth.orgId!, contactId: null,
    action: 'disable_user', requiredTier: 2, reason: 'no_fresh_verification', latest: null });
  vi.mocked(requireCallerVerification).mockRejectedValueOnce(error);
  await expect(createActionIntent(auth, { toolName: 'm365_disable_user', source: 'chat',
    input: { userIdentifier: 'person@example.com', reason: 'Confirmed offboarding request' } })).rejects.toBe(error);
  expect(dbState.insertedActionIntentValues).toEqual([]);
  expect(dbState.insertedApprovalRequestsValues).toEqual([]);
});
```

Use the existing test's auth construction rather than declaring a second incomplete `AuthContext`; Task 13 additionally tests the real persistence path. Typed target lookup failures `subject_unmatched`, `subject_ambiguous`, `tenant_mismatch` must be converted to `CallerVerificationRequiredError` at this block with `getEffectivePolicy(orgId)`'s action tier and null `latest`, before they reach adapters.

- [ ] **Step 4: Run:** `cd apps/api && npx vitest run src/services/callerVerification/refusal.test.ts src/services/actionIntents/intentService.test.ts` → pass; creation refusal has no fan-out side effect.
- [ ] **Step 5: Commit.**

```bash
ls apps/api/migrations | sort | tail -1
git add apps/api/src/services/actionIntents/intentService.ts apps/api/src/services/actionIntents/intentService.test.ts apps/api/src/services/aiAgentSdk.ts apps/api/src/services/callerVerification/refusal.ts apps/api/src/services/callerVerification/refusal.test.ts
git commit -m "feat(caller-verification): preflight and persist caller target pins"
```

### Task 4: Consume after the executing claim, last in release revalidation

**Files:** Modify `apps/api/src/services/actionIntents/revalidateRelease.ts:137,290,303`, `apps/api/src/services/actionIntents/revalidateRelease.test.ts:42`; modify `apps/api/src/jobs/intentReleaseWorker.ts:904,922,1025,1043,1067`; modify `apps/api/src/services/aiAgentSdk.ts:1388,1455`.

**Interfaces:** Consumes `revalidateApprovedIntentForRelease(intent: ActionIntent, winningApproval: { boundArgumentDigest: string | null } | null): Promise<IntentReleaseRevalidation>`; produces existing failure shape with `errorCode: 'caller_verification_required'`, `details: { requiresCallerVerification: CallerRefusalPayload }`. No retry exception for a typed refusal.

- [ ] **Step 1: Extend the existing revalidation test harness.** Add mocked `requireCallerVerification` and `loadPinnedCallerBackend`, returning an active connection in the intent's tenant. Append:

```ts
it('does not consume before the existing RBAC checks pass', async () => {
  const args = { userIdentifier: 'person@example.com', reason: 'Requested account disable' };
  const digest = computeArgumentDigest(canonicalizeArguments(args));
  vi.mocked(checkToolPermission).mockResolvedValueOnce('permission removed');
  const result = await revalidateApprovedIntentForRelease(intentFixture({
    actionName: 'm365_disable_user', arguments: args, argumentDigest: digest,
    status: 'executing', targetEntraTenantId: 'tenant', targetEntraOid: 'oid', targetConnectionRef: 'connection',
  }), { boundArgumentDigest: digest });
  expect(result).toMatchObject({ ok: false, errorCode: 'rbac_denied' });
  expect(requireCallerVerification).not.toHaveBeenCalled();
});
it('returns the complete typed caller refusal after claim', async () => {
  const args = { userIdentifier: 'person@example.com', reason: 'Requested account disable' };
  const digest = computeArgumentDigest(canonicalizeArguments(args));
  const payload = { orgId: 'org-1', contactId: null, action: 'disable_user' as const,
    requiredTier: 2, reason: 'contact_fenced' as const, latest: null };
  vi.mocked(requireCallerVerification).mockRejectedValueOnce(new CallerVerificationRequiredError(payload));
  const result = await revalidateApprovedIntentForRelease(intentFixture({
    actionName: 'm365_disable_user', status: 'executing', arguments: args, argumentDigest: digest,
    targetEntraTenantId: 'tenant', targetEntraOid: 'oid', targetConnectionRef: 'connection',
  }), { boundArgumentDigest: digest });
  expect(result).toEqual({ ok: false, errorCode: 'caller_verification_required',
    details: { requiresCallerVerification: payload } });
  expect(requireCallerVerification).toHaveBeenCalledWith(expect.objectContaining({ mode: 'consume', intentId: 'intent-1' }));
  expect(vi.mocked(requireCallerVerification).mock.calls[0]![0]).not.toHaveProperty('mfa');
});
```

- [ ] **Step 2: Run:** `cd apps/api && npx vitest run src/services/actionIntents/revalidateRelease.test.ts` → missing gate invocation/payload.
- [ ] **Step 3: Add the final consume block before the final success return.** Import gate, error, `callerAction`, `loadPinnedCallerBackend`, `getEffectivePolicy`. Protected agent intents fail `technician_mismatch`; the early agent success at line 290 must not bypass that check.

```ts
const action = callerAction(intent.actionName);
if (action) {
  const policy = await getEffectivePolicy(intent.orgId);
  const requiredTier = action === 'reset_password'
    ? policy.requiredTierResetPassword : policy.requiredTierDisableUser;
  try {
    if (!intent.requestedByUserId || intent.requestingAgentRunId) {
      throw new CallerVerificationRequiredError({ orgId: intent.orgId, contactId: null,
        action, requiredTier, reason: 'technician_mismatch', latest: null });
    }
    if (!intent.targetEntraTenantId || !intent.targetEntraOid || !intent.targetConnectionRef) {
      throw new CallerVerificationRequiredError({ orgId: intent.orgId, contactId: null,
        action, requiredTier, reason: 'subject_unmatched', latest: null });
    }
    const backend = await loadPinnedCallerBackend(intent.orgId, intent.targetConnectionRef);
    await requireCallerVerification({ orgId: intent.orgId, action,
      target: { entraTenantId: intent.targetEntraTenantId, entraOid: intent.targetEntraOid },
      backendTenantId: backend.tenantId, technicianUserId: intent.requestedByUserId,
      intentId: intent.id, mode: 'consume' });
  } catch (error) {
    if (!(error instanceof CallerVerificationRequiredError)) throw error;
    return { ok: false, errorCode: 'caller_verification_required',
      details: { requiresCallerVerification: error.payload } };
  }
}
```

Wrap the entire new final block (policy read through consume) in a new local async function `finishCallerRevalidation(): Promise<IntentReleaseRevalidation>` whose body is the complete printed block followed by `return { ok: true, auth };`. Replace the final return with `return runOutsideDbContext(() => withDbAccessContext(dbAccessContextFromAuth(auth!), finishCallerRevalidation));`. Both callers enter this boundary after a committed claim. Refactor the agent branch's final return to deny protected actions before returning; retain all policy evidence and structural authority checks. Do not weaken `checkToolPermission` for agents.

**Verified ordering:** worker line 904 `transitionIntent(...'approved','executing'...)` precedes line 922 revalidation. Inline line 1388 claim precedes line 1455 revalidation. Pass an `executing` view to revalidation (`{ ...intent, status:'executing' }`) because the originally fetched object can still say `approved`; authority comes from winning CAS, not an input status assertion. Keep both claims where they are.

Worker currently performs effect-digest comparison, session eligibility and kill checks **after** revalidation. Move their existing refusal blocks (lines 1025–1084) immediately before its revalidation call, retaining their original error codes and terminalisation. Move the inline SDK's existing effect-digest refusal block at `aiAgentSdk.ts:1513` before its line-1455 revalidation too. The final gate/consume is then the last admission step. A later crash or dispatch error is explicitly a post-consumption failure. Do not consume during creation, approval or failed digest/RBAC/kill checks.

D13: pre-consume refusal leaves the grant untouched; mutation/transport failure after consume leaves it used and fails the intent; a retry using the **same** intent may pass gate ownership, a new intent cannot. This does not authorise blindly reissuing an outbound request after `dispatch_started_at` is set—Task 5 prevents that ambiguous duplicate.

- [ ] **Step 4: Run:** `cd apps/api && npx vitest run src/services/actionIntents/revalidateRelease.test.ts src/jobs/intentReleaseWorker.test.ts src/services/aiAgentSdk.test.ts` → pass, including existing digest/policy/agent tests.
- [ ] **Step 5: Commit.**

```bash
ls apps/api/migrations | sort | tail -1
git add apps/api/src/services/actionIntents/revalidateRelease.ts apps/api/src/services/actionIntents/revalidateRelease.test.ts apps/api/src/jobs/intentReleaseWorker.ts apps/api/src/services/aiAgentSdk.ts
git commit -m "feat(caller-verification): consume grants after release claims"
```

### Task 5: Commit the final fence check and dispatch marker under both locks

**Files:** Create `apps/api/src/services/callerVerification/dispatch.ts`, `apps/api/src/services/callerVerification/dispatch.test.ts`, `apps/api/src/services/callerVerification/dispatchGateContext.ts`; modify W01-owned `apps/api/src/services/callerVerification/gate.ts` only to expose its existing transaction-bound fence check as `assertCallerSubjectsUnfenced` and ensure nested gate reads use the ambient transaction.

**Interfaces:** Consumes exact gate and lock interfaces from the index. Produces `prepareCallerDispatch(input: { orgId: string; intentId?: string; action: CallerVerificationAction; connectionId: string; backendTenantId: string; oid: string }, gate?: typeof requireCallerVerification): Promise<void>`. The optional function defaults to the real gate; backends pass the imported real function explicitly so the four-file source contract checks actual named call sites. It is an internal code argument, never request data.

- [ ] **Step 1: Write the unit refusal test (no DB needed for missing intent).**

```ts
import { expect, it, vi } from 'vitest';
import { prepareCallerDispatch } from './dispatch';
it('refuses a backend call without a durable intent before any gate/HTTP work', async () => {
  const gate = vi.fn();
  await expect(prepareCallerDispatch({ orgId: '11111111-1111-4111-8111-111111111111',
    action: 'disable_user', connectionId: '22222222-2222-4222-8222-222222222222',
    backendTenantId: 'tenant', oid: 'oid' }, gate))
    .rejects.toMatchObject({ payload: { reason: 'no_fresh_verification' } });
  expect(gate).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run:** `cd apps/api && npx vitest run src/services/callerVerification/dispatch.test.ts` → missing module.
- [ ] **Step 3: Implement the short transaction.** Import `and`, `eq`, `isNull`, `sql`; `db`, `getCurrentDbAccessContext`, `runOutsideDbContext`, `withDbAccessContext`; `actionIntents`, W01 ledger tables; gate/error/policy/subjects/locks; Task 2 backend loader. W01's `Tx` alias is not present to inspect yet: make its internal type `Pick<typeof db, 'execute'>` if it is unnecessarily restricted to a concrete Drizzle transaction. This preserves the index signature and lets the transaction-routed `db` execute the exact same advisory-lock SQL. Do not cast an unrelated pool to a transaction.

The concurrently written W01 draft has a gate that always escapes into system transactions and scans every candidate. Preserve that behaviour for ordinary calls, but add this private dispatch context; it is never populated from HTTP/tool input:

```ts
// dispatchGateContext.ts
import { AsyncLocalStorage } from 'node:async_hooks';
import type { GateInput } from './gate';
type Prepared = { input: GateInput; verificationId: string | null; mailboxHashes: Set<string> | null };
const prepared = new AsyncLocalStorage<Prepared>();
export const currentDispatchGate = () => prepared.getStore();
export const withPreparedDispatchGate = <T>(value: Prepared, fn: () => Promise<T>) => prepared.run(value, fn);
```

In `gate.ts`, import these accessors and adapt the existing orchestration at its named seams. Retain the entire candidate eligibility/CAS body:

```ts
const dispatch = currentDispatchGate();
if (dispatch && (input.mode !== 'check' || JSON.stringify(input) !== JSON.stringify(dispatch.input))) {
  throw new Error('Dispatch gate context does not match the pinned operation');
}
const scoped = <T>(fn: () => Promise<T>, label?: string): Promise<T> =>
  dispatch ? fn() : withSystemDbAccessContext(fn, label);
```

Replace the outer `return runOutsideDbContext(async () => { ... })` with a named `const evaluate = async () => { ... }; return dispatch ? evaluate() : runOutsideDbContext(evaluate);`; inside that function replace its three `withSystemDbAccessContext` calls with `scoped`. Add this predicate to the initial verification-row query:

```ts
dispatch ? and(eq(v.id, dispatch.verificationId ?? '00000000-0000-0000-0000-000000000000'),
  eq(v.consumedIntentRef, input.intentId)) : undefined,
```

Initialize `mailboxHashes` from `dispatch?.mailboxHashes ?? null`; run the existing `ports.mailboxes` block only when `!dispatch`. Thus the nested gate evaluates only the already-consumed grant, re-acquires only the already-held sorted lock set, and performs DB work in the marker transaction. Keep flag, target, policy, destination, epoch and fence revalidation. An alternate newer grant cannot change the requester locks or supersede ownership.

```ts
export async function prepareCallerDispatch(input: {
  orgId: string; intentId?: string; action: CallerVerificationAction;
  connectionId: string; backendTenantId: string; oid: string;
}, gate: typeof requireCallerVerification = requireCallerVerification): Promise<void> {
  const refuse = (reason: CallerVerificationRequiredError['payload']['reason'], requiredTier = 2): never => {
    throw new CallerVerificationRequiredError({ orgId: input.orgId, contactId: null,
      action: input.action, requiredTier, reason, latest: null });
  };
  if (!input.intentId) refuse('no_fresh_verification');
  const context = getCurrentDbAccessContext();
  if (!context) throw new Error('Caller dispatch requires an authorized DB context');
  // The surrounding SDK/worker context can span HTTP. A savepoint there
  // would leave the marker invisible until AFTER the mutation. Open a fresh
  // short transaction with the same scope; await its COMMIT before returning.
  const prepared = await runOutsideDbContext(() => withDbAccessContext(context, async () => {
    const [pin] = await db.select().from(actionIntents).where(and(eq(actionIntents.id, input.intentId!), eq(actionIntents.orgId, input.orgId))).limit(1);
    if (!pin?.requestedByUserId || !pin.targetEntraTenantId || !pin.targetEntraOid) refuse('target_rebound');
    const policy = await getEffectivePolicy(input.orgId);
    const requiredTier = input.action === 'reset_password' ? policy.requiredTierResetPassword : policy.requiredTierDisableUser;
    const [grant] = requiredTier === 0 ? [] : await db.select().from(callerVerifications).where(and(eq(callerVerifications.orgId, input.orgId), eq(callerVerifications.consumedIntentRef, pin.id))).limit(1);
    return { pin, grant };
  }));
  const gateInput: GateInput = { orgId: input.orgId, action: input.action,
    target: { entraTenantId: prepared.pin.targetEntraTenantId!, entraOid: prepared.pin.targetEntraOid! },
    backendTenantId: input.backendTenantId, technicianUserId: prepared.pin.requestedByUserId!, intentId: input.intentId!, mode: 'check' };
  let mailboxHashes: Set<string> | null = null;
  if (prepared.grant?.method === 'email') {
    try {
      const mailboxes = await runOutsideDbContext(() => withMailboxReader(gateInput.technicianUserId,
        () => callerVerificationPorts.mailboxes({ orgId: input.orgId, target: gateInput.target })));
      mailboxHashes = new Set(mailboxes.map(value => normalizeDestination('email', value.replace(/^smtp:/i, '')))
        .filter((value): value is string => !!value).map(destinationHash));
    } catch { mailboxHashes = null; }
  }
  await runOutsideDbContext(() => withDbAccessContext(context, async () => {
    const [intent] = await db.select().from(actionIntents).where(and(
      eq(actionIntents.id, input.intentId!), eq(actionIntents.orgId, input.orgId),
    )).limit(1);
    if (!intent || intent.status !== 'executing' || !intent.requestedByUserId) refuse('no_fresh_verification');
    if (callerAction(intent.actionName) !== input.action || intent.targetConnectionRef !== input.connectionId ||
        intent.targetEntraOid !== input.oid) refuse('target_rebound');
    const backend = await loadPinnedCallerBackend(input.orgId, input.connectionId);
    if (backend.tenantId !== input.backendTenantId || backend.tenantId !== intent.targetEntraTenantId) refuse('tenant_mismatch');
    if (!isCallerVerificationEnabled()) refuse('feature_disabled');
    const policy = await getEffectivePolicy(input.orgId);
    const requiredTier = input.action === 'reset_password' ? policy.requiredTierResetPassword : policy.requiredTierDisableUser;
    const markDispatch = async () => {
      const marked = await db.update(actionIntents).set({ dispatchStartedAt: sql`now()` }).where(and(
        eq(actionIntents.id, intent.id), eq(actionIntents.orgId, input.orgId),
        eq(actionIntents.status, 'executing'), isNull(actionIntents.dispatchStartedAt),
      )).returning({ id: actionIntents.id });
      if (!marked.length) throw new Error('Dispatch already started; reconcile the existing intent before retrying');
    };
    // Policy disables verification-specific checks, not the durable dispatch boundary.
    if (requiredTier === 0) { await markDispatch(); return; }
    const target = await resolveTargetBinding(input.orgId, {
      entraTenantId: intent.targetEntraTenantId!, entraOid: intent.targetEntraOid!,
    });
    const [consumed] = await db.select().from(callerVerifications).where(and(
      eq(callerVerifications.orgId, input.orgId), eq(callerVerifications.consumedIntentRef, intent.id),
    )).limit(1);
    if (requiredTier > 0 && (!consumed?.consumedAt || consumed.targetBindingId !== target.id)) refuse('grant_consumed', requiredTier);
    await withSubjectLocks(db, [target.id, consumed?.requesterBindingId ?? null], async () => {
      const [lockedGrant] = consumed ? await db.select().from(callerVerifications).where(and(
        eq(callerVerifications.id, consumed.id), eq(callerVerifications.orgId, input.orgId),
        eq(callerVerifications.consumedIntentRef, intent.id),
      )).limit(1) : [];
      if (requiredTier > 0 && (!lockedGrant?.consumedAt ||
          lockedGrant.requesterBindingId !== consumed?.requesterBindingId || lockedGrant.targetBindingId !== target.id)) {
        refuse('target_rebound', requiredTier);
      }
      // Positive-tier dispatch uses W01's cooling-off/override predicate
      // in this SAME transaction-routed db.
      try { await assertCallerSubjectsUnfenced(input.orgId, [target.id, consumed?.requesterBindingId ?? null]); }
      catch (error) {
        if (error instanceof CallerVerificationValidationError &&
            (error.code === 'contact_fenced' || error.code === 'target_rebound')) refuse(error.code, requiredTier);
        throw error;
      }
      if ((consumed?.id ?? null) !== (prepared.grant?.id ?? null)) refuse('target_rebound', requiredTier);
      const verified = await withPreparedDispatchGate({ input: gateInput, verificationId: consumed?.id ?? null, mailboxHashes },
        () => gate(gateInput));
      if (requiredTier > 0 && verified.verificationId !== consumed!.id) refuse('grant_consumed', requiredTier);
      await markDispatch();
    });
  }));
}
```

Import `withMailboxReader` from W03's `../aiToolsM365`, `isCallerVerificationEnabled` from `./gate`, and `withPreparedDispatchGate`, `GateInput`, `callerVerificationPorts`, `normalizeDestination` and `destinationHash` in `dispatch.ts` from the corresponding sibling modules. Export a wrapper over W01's existing `fencedUntil` with this exact new internal signature: `assertCallerSubjectsUnfenced(orgId: string, bindingIds: Array<string | null>): Promise<void>`. It resolves binding contacts, reads `rejected_by_user` rows, applies policy cooling-off and `fence_override_until`, and throws `contact_fenced`. Do not create a second independent fence algorithm. Rejection must acquire the full sorted lock set **before** writing the fence, and dispatch must re-read the consumed row under those locks through the real gate; a snapshot from before locking is not authority.

The wrapper reuses W01's fence calculation; add `inArray` and the validation error import to `gate.ts`:

```ts
export async function assertCallerSubjectsUnfenced(orgId: string, bindingIds: Array<string | null>): Promise<void> {
  const ids = [...new Set(bindingIds.filter((id): id is string => id !== null))];
  if (!ids.length) return;
  const bindings = await db.select().from(b).where(and(eq(b.orgId, orgId), inArray(b.id, ids)));
  if (bindings.length !== ids.length) throw new CallerVerificationValidationError('target_rebound', 'A subject binding is no longer present');
  const policy = await getEffectivePolicy(orgId);
  for (const binding of bindings) if (await fencedUntil(orgId, binding.contactId, policy)) {
    throw new CallerVerificationValidationError('contact_fenced', 'Caller rejection fences this subject');
  }
}
```

No `requireCallerVerification` implementation may escape this context or open a separate connection for the fence/CAS. Graph mailbox reads should be fetched before locks, then binding/destination identity rechecked under locks. A committed marker with a subsequent HTTP failure remains an honest “dispatch started” record, not proof Microsoft applied it.

- [ ] **Step 4: Run:** `cd apps/api && npx vitest run src/services/callerVerification/dispatch.test.ts src/services/callerVerification/gate.test.ts` → pass; Task 13 additionally proves bindingless tier-zero dispatch, successful email dispatch through W03’s real mailbox adapter, commit visibility and lock races with real PostgreSQL.
- [ ] **Step 5: Commit.**

```bash
ls apps/api/migrations | sort | tail -1
git add apps/api/src/services/callerVerification/dispatch.ts apps/api/src/services/callerVerification/dispatch.test.ts apps/api/src/services/callerVerification/dispatchGateContext.ts apps/api/src/services/callerVerification/gate.ts
git commit -m "feat(caller-verification): serialize fence checks with dispatch markers"
```

### Task 6: Guard direct Graph mutations and pin the credential tenant

**Files:** Modify `apps/api/src/services/m365DirectGraph.ts:105,122,212,248,252`, `apps/api/src/services/m365DirectGraph.test.ts:1,57`.

**Interfaces:** Extend `invokeDirect(orgId: string, toolName: DelegantToolName, params: Record<string, unknown>, context?: ToolExecutionContext): Promise<DirectInvokeResult>`. Extend successful `getToken` result to `{ token: string; connectionId: string; tenantId: string }`; existing consumers reading `.token` remain valid. Consumes existing `ToolExecutionContext.actionIntentId` (`toolExecutionContext.ts:91`).

- [ ] **Step 1: Append to the direct HTTP test.** Hoist `prepareCallerDispatch` mock, default resolved; add real IDs to the existing `mockRow`. Reset that mock in `beforeEach`.

```ts
it.each(['disable_user', 'reset_user_password'] as const)('%s refuses without a PATCH', async tool => {
  const error = new CallerVerificationRequiredError({ orgId: 'org-1', contactId: null,
    action: tool === 'disable_user' ? 'disable_user' : 'reset_password',
    requiredTier: 2, reason: 'contact_fenced', latest: null });
  vi.mocked(prepareCallerDispatch).mockRejectedValueOnce(error);
  const http = mockFetch(200, {});
  await expect(invokeDirect('org-1', tool, { userId: '11111111-1111-4111-8111-111111111111' },
    { actionIntentId: '22222222-2222-4222-8222-222222222222' })).rejects.toBe(error);
  expect(http.mock.calls.filter(c => c[1]?.method === 'PATCH')).toHaveLength(0);
});
it.each(['disable_user', 'reset_user_password'] as const)('%s sends exactly one pinned PATCH on pass', async tool => {
  const http = mockFetch(200, {});
  await invokeDirect('org-1', tool, { userId: '11111111-1111-4111-8111-111111111111' },
    { actionIntentId: '22222222-2222-4222-8222-222222222222' });
  expect(http.mock.calls.filter(c => c[1]?.method === 'PATCH')).toHaveLength(1);
  expect(http.mock.calls[0]![0]).toBe(`${GRAPH}/users/11111111-1111-4111-8111-111111111111`);
});
```

- [ ] **Step 2: Run:** `cd apps/api && npx vitest run src/services/m365DirectGraph.test.ts` → refusal still PATCHes.
- [ ] **Step 3: Implement at both named cases.** `getToken` now keys cache by `` `${orgId}:${row.id}:${row.tenantId}:${row.clientId}` `` and both success returns include `connectionId: row.id, tenantId: row.tenantId!`. Validate tenant before reading cache. The token and gate must use the **same observed row**, not unrelated fresh credentials.

```ts
case 'disable_user': {
  await prepareCallerDispatch({ orgId, intentId: context?.actionIntentId,
    action: 'disable_user', connectionId: tok.connectionId,
    backendTenantId: tok.tenantId, oid: userId }, requireCallerVerification);
  return graphFetch(token, 'PATCH', `/users/${encodeURIComponent(userId)}`, { accountEnabled: false });
}
case 'reset_user_password': {
  const password = generateTempPassword();
  await prepareCallerDispatch({ orgId, intentId: context?.actionIntentId,
    action: 'reset_password', connectionId: tok.connectionId,
    backendTenantId: tok.tenantId, oid: userId }, requireCallerVerification);
  const res = await graphFetch(token, 'PATCH', `/users/${encodeURIComponent(userId)}`, {
    passwordProfile: { forceChangePasswordNextSignIn: true, password },
  });
  if (res.kind === 'ok') return { kind: 'ok', data: { ok: true, temporaryPassword: password } };
  return res;
}
```

Import `prepareCallerDispatch`, `requireCallerVerification`, and type `ToolExecutionContext`. Do not catch typed gate errors into the existing generic Graph result. Update existing mutation tests to supply an intent context; existing GET tests need no intent. Add a cache regression by changing only the tenant in `selectRows`, calling `getToken` again and asserting `acquireClientCredentialsToken` ran twice. Task 13 tests a real re-pointed connection's `tenant_mismatch`.

- [ ] **Step 4: Run:** `cd apps/api && npx vitest run src/services/m365DirectGraph.test.ts && npx tsc --noEmit` → zero PATCH on refusal, exactly one on pass.
- [ ] **Step 5: Commit.**

```bash
ls apps/api/migrations | sort | tail -1
git add apps/api/src/services/m365DirectGraph.ts apps/api/src/services/m365DirectGraph.test.ts
git commit -m "feat(caller-verification): guard direct Graph dispatch"
```

### Task 7: Guard control-plane writes and send OIDs to the executor

**Files:** Modify `apps/api/src/services/m365ControlPlane/writeActionService.ts:98,159`, `apps/api/src/services/m365ControlPlane/writeActionService.test.ts:67`; modify `packages/shared/src/m365/writeActions.ts:17`, `packages/shared/src/m365/writeActions.test.ts`; modify `apps/m365-graph-actions-executor/src/microsoft/writeActions.ts:56`, `apps/m365-graph-actions-executor/src/microsoft/writeActions.test.ts:14`.

**Interfaces:** Preserve existing `M365WriteAction` discriminants `m365.user.disable`, `m365.user.reset_password`; add optional GUID `oid` alongside optional `userIdentifier`, require exactly one. Executor-only compatibility accepts old identifier payloads during rollout; every W05 API dispatch sends **only oid**. Extend service opts with `actionIntentId?: string`; keep existing idempotency key, actor and audit options.

- [ ] **Step 1: Write tests in shared and executor suites.**

```ts
// packages/shared/src/m365/writeActions.test.ts
it('accepts only one target representation and retains oid', () => {
  const base = { type: 'm365.user.disable', reason: 'Approved offboarding',
    oid: '11111111-1111-4111-8111-111111111111' };
  expect(m365WriteActionSchema.parse(base)).toEqual(base);
  expect(m365WriteActionSchema.safeParse({ ...base, userIdentifier: 'changed@example.com' }).success).toBe(false);
  expect(m365WriteActionSchema.safeParse({ ...base, oid: undefined }).success).toBe(false);
});
// executor suite: uses existing client(), USER_ID and ACCESS_TOKEN.
it.each(['m365.user.disable', 'm365.user.reset_password'] as const)('pinned %s skips resolution', async type => {
  const gc = client({});
  const result = await executeGraphWriteAction({ type, oid: USER_ID, reason: 'Approved offboarding' },
    { accessToken: ACCESS_TOKEN, graphClient: gc });
  expect(result.success).toBe(true);
  expect(gc.readResource).not.toHaveBeenCalled();
  expect(gc.patch).toHaveBeenCalledTimes(1);
  expect(gc.patch).toHaveBeenCalledWith(expect.objectContaining({ path: `/users/${USER_ID}` }));
});
```

Add control-plane tests using its existing `executeWriteAction`, `connRows`, `enabled`, `budget` doubles. A rejected `prepareCallerDispatch` must produce zero executor calls; resolved guard with a pinned `oid` and `actionIntentId` must call once with `action.oid` and no `action.userIdentifier`.

- [ ] **Step 2: Run:** `cd packages/shared && npx vitest run src/m365/writeActions.test.ts`; `cd apps/m365-graph-actions-executor && npx vitest run src/microsoft/writeActions.test.ts` → pinned shape rejected.
- [ ] **Step 3: Implement schema and executor.** Replace each action's `userIdentifier` field with:

```ts
userIdentifier: userIdOrUpnSchema.optional(),
oid: guidSchema.optional(),
```

Apply a union-level refinement after the existing discriminated union:

```ts
.refine(action => Boolean(action.oid) !== Boolean(action.userIdentifier), {
  message: 'Exactly one of oid or userIdentifier is required',
});
```

At executor `resolveUserId` entry:

```ts
if (action.oid) return action.oid;
if (!action.userIdentifier) throw new GraphClientError('graph_not_found');
```

The API service **must reject identifier-only protected calls**, even though the executor compatibility schema still understands them. Just before line 159's `client.executeWriteAction`, add:

```ts
switch (action.type) {
  case 'm365.user.disable':
  case 'm365.user.reset_password':
    await prepareCallerDispatch({ orgId, intentId: opts?.actionIntentId,
      action: action.type === 'm365.user.disable' ? 'disable_user' : 'reset_password',
      connectionId: ready.id, backendTenantId: ready.tenantId!, oid: action.oid ?? '' }, requireCallerVerification);
    break;
}
```

Require `opts.actionIntentId === opts.idempotencyKey`; use that trusted ID as executor idempotency key, removing the random fallback for these protected actions. Keep budget/readiness checks before marking dispatch and the outbound call immediately after. Preserve `GraphActionsExecutorClientError` handling and password secret sealing.

- [ ] **Step 4: Run:** the two commands from Step 2, then `cd apps/api && npx vitest run src/services/m365ControlPlane/writeActionService.test.ts src/services/m365ToolsHeadless.test.ts` → pass; update existing success fixtures to pinned OIDs and real intent context, never mock away a refusal assertion.
- [ ] **Step 5: Commit.**

```bash
ls apps/api/migrations | sort | tail -1
git add packages/shared/src/m365/writeActions.ts packages/shared/src/m365/writeActions.test.ts apps/api/src/services/m365ControlPlane/writeActionService.ts apps/api/src/services/m365ControlPlane/writeActionService.test.ts apps/m365-graph-actions-executor/src/microsoft/writeActions.ts apps/m365-graph-actions-executor/src/microsoft/writeActions.test.ts
git commit -m "feat(caller-verification): enforce pinned OIDs in Graph executor"
```

### Task 8: Preserve intent context and guard Delegant plus headless routing

**Files:** Modify `apps/api/src/services/aiAgentSdkTools.ts:632,686,723`, `apps/api/src/services/aiAgentSdkTools.m365gating.test.ts`; modify `apps/api/src/services/aiToolsM365.ts:73,102,217,245`, `apps/api/src/services/aiToolsM365.test.ts`; modify `apps/api/src/services/m365ToolsHeadless.ts:55`, `apps/api/src/services/m365ToolsHeadless.test.ts`; modify `apps/api/src/jobs/intentReleaseWorker.ts:1108`.

**Interfaces:** Session mutation handlers gain fourth `context?: ToolExecutionContext`; `call` gains sixth context parameter. `executeM365ToolHeadless(actionName: string, args: unknown, orgId: string, idempotencyKey?: string): Promise<string>` stays callable but now refuses missing intent; backend comes from the stored connection reference. No trusted ID is taken from `args`.

- [ ] **Step 1: Extend existing broker tests.** Using their mocked broker and connection/session harness, replace the old expected UPN lookup on mutation with a stored pinned target. Add:

```ts
it('refusal never reaches the Delegant mutation', async () => {
  const error = new CallerVerificationRequiredError({ orgId: auth.orgId!, contactId: null,
    action: 'disable_user', requiredTier: 2, reason: 'contact_fenced', latest: null });
  vi.mocked(prepareCallerDispatch).mockRejectedValueOnce(error);
  await expect(m365DisableUserHandler({ userIdentifier: 'renamed@example.com', reason: 'Approved offboarding' },
    auth, 'session-1', { actionIntentId: '11111111-1111-4111-8111-111111111111' })).rejects.toBe(error);
  expect(vi.mocked(invokeDelegantTool).mock.calls.filter(([x]) => x.toolName === 'disable_user')).toHaveLength(0);
});
it('passed broker disable sends exactly the pinned OID once', async () => {
  await m365DisableUserHandler({ userIdentifier: 'renamed@example.com', reason: 'Approved offboarding' },
    auth, 'session-1', { actionIntentId: '11111111-1111-4111-8111-111111111111' });
  const writes = vi.mocked(invokeDelegantTool).mock.calls.filter(([x]) => x.toolName === 'disable_user');
  expect(writes).toHaveLength(1);
  expect(writes[0]![0].parameters.userId).toBe('22222222-2222-4222-8222-222222222222');
  expect(vi.mocked(invokeDelegantTool).mock.calls.some(([x]) => x.toolName === 'get_user')).toBe(false);
});
```

Repeat the table for reset using its `SecretToolResult` carrier; assert no temporary password in `llmText`. The gate may perform the dedicated mailbox read, but the mutation handler never re-resolves a UPN.

- [ ] **Step 2: Run:** `cd apps/api && npx vitest run src/services/aiToolsM365.test.ts src/services/aiAgentSdkTools.m365gating.test.ts src/services/m365ToolsHeadless.test.ts` → missing fourth-argument pinning.
- [ ] **Step 3: Implement context plumbing and pinned dispatch.** `makeSessionAwareHandler`'s function type becomes `(args, auth, sessionId, context?: ToolExecutionContext) => Promise<string | SecretToolResult>`; its call becomes:

```ts
withDbAccessContext(dbContext, () =>
  sessionHandler(args, auth, session.breezeSessionId, { actionIntentId: intentId }))
```

This replaces the existing `withDbAccessContext` call inside `withToolTimeout`; do not nest a second wrapper. In both protected handlers replace `resolveContext` and `resolveUserId` mutation lookup with this new exported helper in `aiToolsM365.ts`:

```ts
export async function loadM365MutationContext(orgId: string, action: CallerVerificationAction, intentId?: string) {
  if (!intentId) throw new CallerVerificationRequiredError({ orgId, contactId: null,
    action, requiredTier: 2, reason: 'no_fresh_verification', latest: null });
  const [intent] = await db.select().from(actionIntents).where(and(
    eq(actionIntents.id, intentId), eq(actionIntents.orgId, orgId),
  )).limit(1);
  if (!intent?.targetConnectionRef || !intent.targetEntraOid) throw new Error('Intent target is not pinned');
  const selected = await loadPinnedCallerBackend(orgId, intent.targetConnectionRef);
  if (selected.backend === 'delegant') {
    const conn = await loadConnection(selected.connectionId);
    if (!conn || conn.orgId !== orgId) throw new Error('Pinned connection unavailable');
    return { intent, ctx: { backend: 'delegant' as const, conn }, userId: intent.targetEntraOid };
  }
  return { intent, ctx: { backend: selected.backend, orgId }, userId: intent.targetEntraOid };
}
```

Extend `Backend` with `{ backend:'controlPlane'; orgId:string }`. The handlers use `const { ctx, userId } = await loadM365MutationContext(auth.orgId!, 'disable_user', context?.actionIntentId);`, with `'reset_password'` in the reset handler; then `call(ctx, auth, sessionId, tool, {userId,reason}, context)`; the direct branch forwards context. Before the existing Delegant outbound, add:

```ts
if (toolName === 'disable_user' || toolName === 'reset_user_password') {
  await prepareCallerDispatch({ orgId: ctx.conn.orgId, intentId: context?.actionIntentId,
    action: toolName === 'disable_user' ? 'disable_user' : 'reset_password',
    connectionId: ctx.conn.id, backendTenantId: ctx.conn.m365TenantId,
    oid: String(parameters.userId ?? '') }, requireCallerVerification);
}
```

For the control-plane branch call `executeM365WriteActionByOrg(ctx.orgId, { type: toolName === 'disable_user' ? 'm365.user.disable' : 'm365.user.reset_password', oid: String(parameters.userId), reason: String(parameters.reason) }, { actionIntentId: context?.actionIntentId, idempotencyKey: context?.actionIntentId, actorId: auth.user.id })`. Change the internal `call()` return type to `Promise<Exclude<DelegantInvokeResult, { kind: 'error' }> | { kind: 'error'; code: string; message: string }>`; the external broker's error enum stays unchanged. Map success to `{kind:'ok',data: outcome.result}` and ordinary service failure to `{kind:'error',code:outcome.code,message:outcome.message}`; typed gate errors propagate.

Headless execution must **not** switch a Delegant/direct pin to control-plane. Read the intent by `(orgId,idempotencyKey)`, rebuild its user with existing `buildAuthContextForIntent`, and dispatch the same handlers with a synthetic correlation string only (never a fake browser proof):

```ts
const loaded = await loadM365MutationContext(orgId, actionName === 'm365_disable_user' ? 'disable_user' : 'reset_password', idempotencyKey);
const auth = await buildAuthContextForIntent(loaded.intent);
if (!auth) throw new Error('Intent actor unavailable');
const context = { actionIntentId: loaded.intent.id };
if (actionName === 'm365_disable_user') {
  return m365DisableUserHandler(input, auth, loaded.intent.id, context);
}
const result = await m365ResetPasswordHandler(input, auth, loaded.intent.id, context);
return result.kind === 'error' ? result.llmText
  : JSON.stringify({ success: true, ...result.secrets });
```

Worker already seals returned secrets; keep that seam. Reads retain the old session routing. The broker session string is correlation only; it never creates an administrative step-up context. Task 12 catches typed failures outside all these handlers.

- [ ] **Step 4: Run:** Step 2 command plus `cd apps/api && npx tsc --noEmit` → pass. SDK test must inspect actual handler's fourth argument for the pre-tool returned intent ID.
- [ ] **Step 5: Commit.**

```bash
ls apps/api/migrations | sort | tail -1
git add apps/api/src/services/aiAgentSdkTools.ts apps/api/src/services/aiAgentSdkTools.m365gating.test.ts apps/api/src/services/aiToolsM365.ts apps/api/src/services/aiToolsM365.test.ts apps/api/src/services/m365ToolsHeadless.ts apps/api/src/services/m365ToolsHeadless.test.ts apps/api/src/jobs/intentReleaseWorker.ts
git commit -m "feat(caller-verification): preserve intent context across M365 backends"
```

### Task 9: Complete system revocation and incident terminal linkage

**Files:** Modify W01-owned `apps/api/src/services/actionIntents/revokeIntentsForSubject.ts`, `apps/api/src/services/callerVerification/rejection.ts`; create `apps/api/src/services/actionIntents/revokeIntentsForSubject.test.ts`, `apps/api/src/services/callerVerification/incidentLinks.ts`; modify `apps/api/src/jobs/intentOutboxPublisher.ts:204,223` (`enqueueClaimedRows`), `apps/api/src/jobs/intentOutboxPublisher.test.ts`.

**Interfaces:** Preserve verbatim `revokeIntentsForSubject(input: { orgId: string; bindingIds: string[]; verificationId: string }): Promise<{ cancelled: string[]; alreadyExecuting: string[]; alreadyDispatched: string[] }>`; produce `linkCallerIncidentIntents(orgId: string, verificationId: string, intentIds: string[]): Promise<void>` and `linkCallerIntentTerminal(intentId: string): Promise<void>`.

- [ ] **Step 1: Write the empty-input unit test and the failing live cancellation test.**

```ts
import { expect, it } from 'vitest';
import { revokeIntentsForSubject } from './revokeIntentsForSubject';
it('empty subject set never cancels unrelated intents', async () => {
  expect(await revokeIntentsForSubject({ orgId: '11111111-1111-4111-8111-111111111111',
    bindingIds: [], verificationId: '22222222-2222-4222-8222-222222222222' }))
    .toEqual({ cancelled: [], alreadyExecuting: [], alreadyDispatched: [] });
});
```

Install Task 13's complete `seed`/`run`/`beforeEach` fixture in the live enforcement file now, and add this regression before implementing revocation:

```ts
it('rejection cancels an approved intent for the bound target', async () => {
  await run(() => db.update(actionIntents).set({ status: 'approved' }).where(eq(actionIntents.id, f.intent.id)));
  const result = await revokeIntentsForSubject({ orgId: f.org.id, bindingIds: [f.target.id], verificationId: f.grant.id });
  expect(result.cancelled).toEqual([f.intent.id]);
  const [row] = await run(() => db.select().from(actionIntents).where(eq(actionIntents.id, f.intent.id)));
  expect(row!.status).toBe('cancelled');
});
```

- [ ] **Step 2: Run:** `pnpm test-stack up`, then `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/callerVerificationEnforcement.integration.test.ts -t 'rejection cancels an approved intent'` → W01's empty-result stub fails the expected cancelled ID. The empty-input unit test is a safety regression, not the red evidence.
- [ ] **Step 3: Implement the system query/CAS.** Imports: `and`, `eq`, `inArray`, `sql`; `db`, `withSystemDbAccessContext`; schema `actionIntents`, `aiOperatorOperations`; `isTaskLinkedIntent`, `markOperationCancelled` from `../aiOperator/operationService`; `publishIntentTerminalOutbox` from `../aiOperator/taskOutbox`; `linkCallerIncidentIntents` from the new module.

```ts
export async function revokeIntentsForSubject(input: {
  orgId: string; bindingIds: string[]; verificationId: string;
}): Promise<{ cancelled: string[]; alreadyExecuting: string[]; alreadyDispatched: string[] }> {
  const result = { cancelled: [] as string[], alreadyExecuting: [] as string[], alreadyDispatched: [] as string[] };
  if (!input.bindingIds.length) return result;
  return withSystemDbAccessContext(async () => {
    const ids = sql.join(input.bindingIds.map(id => sql`${id}::uuid`), sql`, `);
    const candidates = await db.select().from(actionIntents).where(and(
      eq(actionIntents.orgId, input.orgId),
      inArray(actionIntents.actionName, ['m365_reset_password', 'm365_disable_user']),
      sql`(
        EXISTS (SELECT 1 FROM caller_verification_subject_bindings b
          WHERE b.org_id = ${actionIntents.orgId} AND b.id IN (${ids})
            AND b.entra_tenant_id = ${actionIntents.targetEntraTenantId}
            AND b.entra_oid = ${actionIntents.targetEntraOid})
        OR EXISTS (SELECT 1 FROM caller_verifications g
          WHERE g.org_id = ${actionIntents.orgId} AND g.requester_binding_id IN (${ids})
            AND (g.consumed_intent_ref = ${actionIntents.id}
              OR (g.consumed_at IS NULL AND g.status IN ('verified', 'revoked')
                AND g.target_entra_tenant_id = ${actionIntents.targetEntraTenantId}
                AND g.target_entra_oid = ${actionIntents.targetEntraOid}
                AND g.action_scope::text IN ('any', CASE WHEN ${actionIntents.actionName} = 'm365_disable_user'
                  THEN 'disable_user' ELSE 'reset_password' END)
                AND g.initiated_by_user_id IS NOT NULL))))`,
    ));
    // The broad requester-candidate arm deliberately includes cross-technician
    // grants: policy can allow them, and rejection must fence that subject
    // regardless of who currently owns a candidate intent. No org widening.
    for (const intent of candidates) {
      if (isTaskLinkedIntent(intent)) await db.select({ id: aiOperatorOperations.id })
        .from(aiOperatorOperations).where(eq(aiOperatorOperations.intentId, intent.id)).for('update').limit(1);
      const won = await db.update(actionIntents).set({ status: 'cancelled',
        result: { actor: 'system:caller_verification', verificationId: input.verificationId } }).where(and(
          eq(actionIntents.id, intent.id), eq(actionIntents.orgId, input.orgId),
          inArray(actionIntents.status, ['pending_approval', 'approved']),
        )).returning({ id: actionIntents.id });
      if (won.length) {
        if (isTaskLinkedIntent(intent)) await markOperationCancelled(db, intent.id);
        await publishIntentTerminalOutbox(db, intent, 'intent_cancelled');
        result.cancelled.push(intent.id);
      } else {
        const [live] = await db.select().from(actionIntents).where(eq(actionIntents.id, intent.id)).limit(1);
        if (live?.dispatchStartedAt) result.alreadyDispatched.push(intent.id);
        else if (live?.status === 'executing') result.alreadyExecuting.push(intent.id);
      }
    }
    await linkCallerIncidentIntents(input.orgId, input.verificationId, candidates.map(i => i.id));
    return result;
  }, 'callerVerification.revokeIntentsForSubject');
}
```

Use the existing CAS/outbox machinery behind `cancelActionIntent:2333–2390`, **not its public requester/approver check at 2305**. The private `transitionIntentAndPublish` in `aiAgentSdk.ts:512` is not importable and only handles `executing`→terminal. Never cancel an `executing` row; the final backend fence makes it fail before dispatch, while a marker already set is reported honestly. Operation-before-intent locking preserves existing task lock order.

W01 rejection already writes fence → incident → grant revocations → this function → audit/notifications. Preserve both org and partner recipients and the verification-ID outbox idempotency key. This routine is called from that **background** outbox context, so `withSystemDbAccessContext` is correct directly; request entry uses `runOutsideDbContext` before entering rejection, not within this routine.

Implement incident linking with the real `incidents` table in `schema/incidentResponse.ts:51`; no incident service helper exists. Its timeline shape is `{at,type,actor,summary,metadata?}`. Use one row lock and idempotency key `intentId:status`:

```ts
async function appendIntentLinks(incidentId: string, intentIds: string[]) {
  const [incident] = await db.select().from(incidents).where(eq(incidents.id, incidentId)).for('update').limit(1);
  if (!incident || !intentIds.length) return;
  const rows = await db.select().from(actionIntents).where(and(
    eq(actionIntents.orgId, incident.orgId), inArray(actionIntents.id, intentIds),
  ));
  const timeline = [...incident.timeline];
  for (const intent of rows) {
    const key = `${intent.id}:${intent.status}`;
    if (timeline.some(e => e.metadata?.callerIntentKey === key)) continue;
    timeline.push({ at: new Date().toISOString(), type: 'caller_verification.intent', actor: 'system',
      summary: intent.dispatchStartedAt ? 'Dispatch started before rejection; confirm the outcome in Entra'
        : `Related intent ${intent.status}`, metadata: { callerIntentKey: key, intentId: intent.id,
          status: intent.status, errorCode: intent.errorCode, dispatchStartedAt: intent.dispatchStartedAt?.toISOString() ?? null,
          actor: 'system:caller_verification' } });
  }
  await db.update(incidents).set({ timeline, updatedAt: new Date() }).where(eq(incidents.id, incident.id));
}
export async function linkCallerIncidentIntents(orgId: string, verificationId: string, intentIds: string[]) {
  const [incident] = await db.select({ id: incidents.id }).from(incidents).where(and(
    eq(incidents.orgId, orgId), eq(incidents.sourceType, 'caller_verification'), eq(incidents.sourceRef, verificationId),
  )).limit(1);
  if (incident) await appendIntentLinks(incident.id, intentIds);
}
export async function linkCallerIntentTerminal(intentId: string): Promise<void> {
  await withSystemDbAccessContext(async () => {
    const rows = await db.select({ id: incidents.id }).from(incidents).where(and(
      eq(incidents.sourceType, 'caller_verification'),
      sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${incidents.timeline}) e
        WHERE e->'metadata'->>'intentId' = ${intentId})`,
    ));
    for (const row of rows) await appendIntentLinks(row.id, [intentId]);
  }, 'callerVerification.incidentLinks');
}
```

In `intentOutboxPublisher`'s claimed-row loop, inside `else if (row.intent_id)` and before enqueueing/acknowledging a terminal row, run `if (['intent_completed','intent_failed','intent_cancelled','intent_expired','intent_rejected'].includes(row.event_type)) await linkCallerIntentTerminal(row.intent_id);`. Let failures keep the outbox unpublished for retry; do not swallow them. This also catches inline terminalisation and reaper outcomes. Rejection's initial link reads live terminal states, covering an outcome that published before incident creation.

- [ ] **Step 4: Run:** `cd apps/api && npx vitest run src/services/actionIntents/revokeIntentsForSubject.test.ts src/jobs/intentOutboxPublisher.test.ts`; rerun Step 2's filtered live cancellation command before this task's commit. Administrative tests are added after Task 11.
- [ ] **Step 5: Commit.**

```bash
ls apps/api/migrations | sort | tail -1
git add apps/api/src/__tests__/integration/callerVerificationEnforcement.integration.test.ts apps/api/src/services/actionIntents/revokeIntentsForSubject.ts apps/api/src/services/actionIntents/revokeIntentsForSubject.test.ts apps/api/src/services/callerVerification/rejection.ts apps/api/src/services/callerVerification/incidentLinks.ts apps/api/src/jobs/intentOutboxPublisher.ts apps/api/src/jobs/intentOutboxPublisher.test.ts
git commit -m "feat(caller-verification): revoke subject intents and link incident outcomes"
```

### Task 10: Mint resource-bound administrative step-up grants

**Files:** Modify `apps/api/src/services/mfaStepUpGrant.ts:34,58,112`, `apps/api/src/services/mfaStepUpGrant.test.ts`; modify `apps/api/src/routes/auth/schemas.ts:148,179`, `apps/api/src/routes/auth/schemas.test.ts`; modify `apps/api/src/routes/auth/mfa.ts:1209,1223,1345`, `apps/api/src/routes/auth.test.ts`.

**Interfaces:** Add `StepUpOperation = 'caller_verification_administrative_disable'` to the existing union. Produce `callerVerificationAdministrativeDigest(input: { orgId: string; entraTenantId: string; entraOid: string; reason: string }): \`sha256:${string}\``. Preserve `StepUpGrant`, `GrantBind`, mint/validate/consume signatures and 300-second TTL.

- [ ] **Step 1: Write tests (service and schema).**

```ts
it('binds administrative step-up to org, tenant, OID and trimmed reason', () => {
  const input = { orgId: '11111111-1111-4111-8111-111111111111',
    entraTenantId: '22222222-2222-4222-8222-222222222222',
    entraOid: '33333333-3333-4333-8333-333333333333', reason: 'Confirmed offboarding request' };
  const digest = callerVerificationAdministrativeDigest(input);
  expect(callerVerificationAdministrativeDigest({ ...input, reason: ` ${input.reason} ` })).toBe(digest);
  for (const key of ['orgId', 'entraTenantId', 'entraOid', 'reason'] as const) {
    expect(callerVerificationAdministrativeDigest({ ...input, [key]: input[key] + 'x' })).not.toBe(digest);
  }
});
it('accepts the operation and rejects a short administrative reason', () => {
  const body = { method: 'totp', code: '123456', operation: 'caller_verification_administrative_disable',
    resource: { orgId: '11111111-1111-4111-8111-111111111111', entraTenantId: 'tenant', entraOid: 'oid',
      reason: 'Confirmed offboarding request' } };
  expect(mfaStepUpSchema.safeParse(body).success).toBe(true);
  expect(callerVerificationAdministrativeStepUpResource.safeParse({ ...body.resource, reason: 'short' }).success).toBe(false);
});
```

- [ ] **Step 2: Run:** `cd apps/api && npx vitest run src/services/mfaStepUpGrant.test.ts src/routes/auth/schemas.test.ts` → missing digest/schema/operation.
- [ ] **Step 3: Implement the exact digest and resource shape.**

```ts
export function callerVerificationAdministrativeDigest(input: {
  orgId: string; entraTenantId: string; entraOid: string; reason: string;
}): `sha256:${string}` {
  const reasonHash = createHash('sha256').update(input.reason.trim()).digest('hex');
  const canonical = [input.orgId, input.entraTenantId, input.entraOid, reasonHash].join('|');
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}
// routes/auth/schemas.ts
export const callerVerificationAdministrativeStepUpResource = z.object({
  orgId: z.string().uuid(), entraTenantId: z.string().min(1).max(64),
  entraOid: z.string().min(1).max(64), reason: z.string().trim().min(20).max(2000),
}).strict();
```

Add the operation to both `StepUpOperation` and `STEP_UP_OPERATIONS`; append the resource to `stepUpResource`'s union. In the MFA route add the schema to `RESOURCE_BOUND_OPERATIONS` under the exact operation key and extend `boundResource`'s type. Add this branch **before** the existing rollback branch of `resourceDigest`:

```ts
body.operation === 'caller_verification_administrative_disable'
  ? callerVerificationAdministrativeDigest(boundResource as z.infer<typeof callerVerificationAdministrativeStepUpResource>)
  : body.operation === 'agent_rollback'
```

Existing `/auth/mfa/step-up` factor proof, per-user limits, live epochs and session binding remain authoritative. The resource map rejects a resource of a different operation even if the coarse union accepts it. Keep `enroll_first_factor` excluded. Route tests call the actual route with TOTP/SMS/passkey mocks already present and assert the minted bind operation/digest; missing resource returns 400 **before** factor verification.

- [ ] **Step 4: Run:** `cd apps/api && npx vitest run src/services/mfaStepUpGrant.test.ts src/routes/auth/schemas.test.ts src/routes/auth.test.ts` → pass. Task 13 exercises real Redis binding mismatch and single use.
- [ ] **Step 5: Commit.**

```bash
ls apps/api/migrations | sort | tail -1
git add apps/api/src/services/mfaStepUpGrant.ts apps/api/src/services/mfaStepUpGrant.test.ts apps/api/src/routes/auth/schemas.ts apps/api/src/routes/auth/schemas.test.ts apps/api/src/routes/auth/mfa.ts apps/api/src/routes/auth.test.ts
git commit -m "feat(auth): bind administrative disable step-up to exact target"
```

### Task 11: Create durable administrative rows and check live session/epochs

**Files:** Create `apps/api/src/services/callerVerification/administrativeContext.ts`, `apps/api/src/services/callerVerification/administrative.ts`, `apps/api/src/services/callerVerification/administrative.test.ts`; modify W01-owned `apps/api/src/services/callerVerification/service.ts`, `apps/api/src/services/callerVerification/gate.ts`, `apps/api/src/jobs/callerVerificationPublisher.ts`, `apps/api/src/routes/callerVerification.ts`, `apps/api/src/routes/callerVerification.test.ts`. Read current `apps/api/src/services/actionIntents/actorContext.ts:276–293`, `apps/api/src/services/jwt.ts:499–506`, `apps/api/src/db/schema/refreshTokenFamilies.ts:30–43`, `apps/api/src/db/schema/users.ts:38,67–68` without modifying them.

**Interfaces:** Preserve verbatim `createAdministrative(actor: CallerVerificationActor, input: { orgId: string; targetContactId: string; reason: string; stepUpGrantId: string }): Promise<VerificationView>`. `CallerVerificationActor` remains `{ userId; partnerId; scope; accessibleOrgIds; allowedSiteIds; displayName }`; no token/MFA fields. New request-local proof context is private, populated only by an authenticated interactive route.

- [ ] **Step 1: Write the failing request-context test.**

```ts
import { expect, it } from 'vitest';
import { administrativeProofFor, withAdministrativeProof } from './administrativeContext';
it('requires an interactive proof context and does not leak it', async () => {
  expect(() => administrativeProofFor('u')).toThrow('Interactive step-up required');
  await withAdministrativeProof({ userId: 'u', sid: 'family', authEpoch: 2, mfaEpoch: 3 }, async () => {
    expect(administrativeProofFor('u').sid).toBe('family');
    expect(() => administrativeProofFor('other')).toThrow();
  });
  expect(() => administrativeProofFor('u')).toThrow();
});
```

- [ ] **Step 2: Run:** `cd apps/api && npx vitest run src/services/callerVerification/administrative.test.ts` → module missing.
- [ ] **Step 3: Implement request proof storage and live administrative eligibility.**

```ts
// administrativeContext.ts
import { AsyncLocalStorage } from 'node:async_hooks';
import { CallerVerificationValidationError } from './errors';
type InteractiveProof = { userId: string; sid: string; authEpoch: number; mfaEpoch: number };
const proofs = new AsyncLocalStorage<InteractiveProof>();
export function withAdministrativeProof<T>(proof: InteractiveProof, fn: () => Promise<T>): Promise<T> {
  return proofs.run(proof, fn);
}
export function administrativeProofFor(userId: string): InteractiveProof {
  const proof = proofs.getStore();
  if (!proof || proof.userId !== userId) throw new CallerVerificationValidationError(
    'interactive_stepup_required', 'Interactive step-up required');
  return proof;
}
```

In `administrative.ts`, import Drizzle `and`, `eq`, `gt`, `isNull`; `db`; tables `users`, `refreshTokenFamilies`, `organizations`; permission functions `getUserPermissions`, `hasPermission`, `canAccessOrg`, `PERMISSIONS` from `../permissions`. Implement:

```ts
export async function administrativeEligible(input: {
  orgId: string; userId: string; sid: string; authEpoch: number; mfaEpoch: number;
  verifiedAt: Date; ttlMinutes: number;
}): Promise<boolean> {
  const now = new Date();
  const proofTime = input.verifiedAt.getTime();
  if (!Number.isFinite(proofTime) || proofTime > now.getTime() ||
      proofTime <= now.getTime() - input.ttlMinutes * 60_000) return false;
  const [live] = await db.select({ authEpoch: users.authEpoch, mfaEpoch: users.mfaEpoch })
    .from(users).innerJoin(refreshTokenFamilies, and(
      eq(refreshTokenFamilies.userId, users.id), eq(refreshTokenFamilies.familyId, input.sid),
      isNull(refreshTokenFamilies.revokedAt), gt(refreshTokenFamilies.absoluteExpiresAt, now),
    )).where(and(eq(users.id, input.userId), eq(users.status, 'active'))).limit(1);
  if (!live || live.authEpoch !== input.authEpoch || live.mfaEpoch !== input.mfaEpoch) return false;
  const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations)
    .where(eq(organizations.id, input.orgId)).limit(1);
  if (!org) return false;
  const permissions = await getUserPermissions(input.userId, { orgId: input.orgId, partnerId: org.partnerId });
  return !!permissions && canAccessOrg(permissions, input.orgId)
    && hasPermission(permissions, PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action)
    && (permissions.scope !== 'partner' || permissions.partnerId === org.partnerId);
}
```

`auth.token.sid` is **refreshTokenFamilies.familyId**, not `sessions.id`: `jwt.ts` promotes `refreshFam` to `sid`. Read live DB epochs, not only cached token claims. Gate administrative branch calls `administrativeEligible` with stored row fields; false throws `stepup_invalidated`. It remains exempt from `allowedMethods` and requester/destination checks, but must meet target/fence/technician rules and `allowAdministrativeDisable`. Reject it for reset, regardless of `action_scope` corruption.

W01 `createAdministrative` is an implemented factory with a default-refusing proof port, not a stub. Retain its feature flag and actor/org/contact site checks and HTTP view projection. Replace the proof adapter and row construction after those checks with the following body, preserving the contact lock, hourly count, cap and incremented attempt number. Import `lockContact` alongside `withSubjectLocks`; the cap must run before Redis grant consumption:

```ts
const proof = administrativeProofFor(actor.userId);
const reason = input.reason.trim();
if (reason.length < 20 || reason.length > 2000) throw new CallerVerificationValidationError('reason_invalid', 'Reason must contain 20 to 2000 characters');
const policy = await getEffectivePolicy(input.orgId);
if (!policy.allowAdministrativeDisable) throw new CallerVerificationValidationError('administrative_disabled', 'Administrative disable is disabled');
const bindings = (await bindingsForContact(input.orgId, input.targetContactId))
  .filter(b => !b.revokedAt && b.entraTenantId && b.entraOid);
if (bindings.length !== 1) throw new CallerVerificationValidationError('subject_ambiguous', 'One current Entra binding is required');
const target = bindings[0]!;
await lockContact(input.orgId, input.targetContactId);
return withSubjectLocks(db, [target.id], async () => {
const current = await resolveTargetBinding(input.orgId, { entraTenantId: target.entraTenantId!, entraOid: target.entraOid! });
if (current.id !== target.id || current.contactId !== input.targetContactId) throw new CallerVerificationValidationError('target_rebound', 'Target binding changed');
await assertCallerSubjectsUnfenced(input.orgId, [target.id]);
const [attempts] = await db.select({ count: sql<number>`count(*)::int` }).from(callerVerifications).where(and(
  eq(callerVerifications.orgId, input.orgId), eq(callerVerifications.contactId, input.targetContactId),
  sql`${callerVerifications.createdAt}>now()-interval '1 hour'`,
));
const count = attempts!.count;
if (count >= policy.maxAttemptsPerHour) {
  throw new CallerVerificationValidationError('attempt_cap', 'Contact attempt limit reached');
}
const now = new Date();
if (!await administrativeEligible({ orgId: input.orgId, userId: actor.userId, sid: proof.sid,
  authEpoch: proof.authEpoch, mfaEpoch: proof.mfaEpoch, verifiedAt: now, ttlMinutes: policy.verificationTtlMinutes })) {
  throw new CallerVerificationValidationError('stepup_invalidated', 'Step-up session is no longer valid');
}
const bind = { userId: actor.userId, operation: 'caller_verification_administrative_disable' as const,
  sid: proof.sid, authEpoch: proof.authEpoch, mfaEpoch: proof.mfaEpoch,
  resourceDigest: callerVerificationAdministrativeDigest({ orgId: input.orgId,
    entraTenantId: target.entraTenantId!, entraOid: target.entraOid!, reason }) };
if (!await consumeStepUpGrant(input.stepUpGrantId, bind)) {
  throw new CallerVerificationValidationError('stepup_invalidated', 'Step-up grant is invalid or already used');
}
const verifiedAt = new Date();
const [row] = await db.insert(callerVerifications).values({
  orgId: input.orgId, contactId: input.targetContactId, requesterBindingId: null,
  targetBindingId: target.id, targetEntraTenantId: target.entraTenantId, targetEntraOid: target.entraOid,
  initiatedByUserId: actor.userId, technicianLabel: actor.displayName,
  method: 'administrative_stepup', status: 'verified', actionScope: 'disable_user',
  targetLabel: target.upnSnapshot ?? target.entraOid, reason, tier: 3, tierReason: 'administrative',
  stepupSessionId: proof.sid, stepupAuthEpoch: proof.authEpoch, stepupMfaEpoch: proof.mfaEpoch,
  stepupVerifiedAt: verifiedAt, decidedAt: verifiedAt,
  expiresAt: new Date(verifiedAt.getTime() + policy.verificationTtlMinutes * 60_000),
  // Administrative rows never deliver a challenge; keep NOT NULL schema
  // fields valid without creating any public bearer token.
  matchValue: '00', decoyValues: ['01', '02'], reverseCode: '0000', attemptNo: count + 1,
}).returning();
await recordEffect(row!, 'administrative_created', actor.userId);
return get(actor, input.orgId, row!.id);
});
```

Keep the contact lock before the target subject lock, with the hourly count, step-up consume and insertion inside the existing request transaction. Count all methods and statuses in the last hour, as W01 does. Task 13 races two administrative requests at the cap and verifies the losing request retains its step-up grant and the winner audits the technician. Consume returns **boolean**, so copy the exact successfully matched binding above; there is no `grant.verifiedAt` to copy. Stamp time after consume. Failed SQL after Redis GETDEL requires another interactive step-up; never recreate the consumed grant. Import W01's `recordEffect` from `./effects`; it records the administrative audit, including reason, transactionally. W01's new publisher uses the ledger itself as its durable outbox. Leave `deliveryPublishedAt` null for administrative rows and extend that publisher as specified below; no new outbox table is needed.

Add the actual route using W01's `cv`, `base`, `write`, `actor(c)` and `oid(c)` helpers and `administrativeCallerVerificationSchema`:

```ts
callerVerificationRoutes.post(`${cv}/administrative`, ...base, write, requireMfa(),
  zValidator('json', administrativeCallerVerificationSchema), async c => {
  const auth = c.get('auth') as AuthContext;
  if (auth.principal.kind !== 'user_session' || !auth.token?.sid ||
      typeof auth.token.aep !== 'number' || typeof auth.token.mep !== 'number') {
    return c.json({ error: 'Interactive step-up required', code: 'interactive_stepup_required' }, 403);
  }
  return withAdministrativeProof({ userId: auth.user.id, sid: auth.token.sid,
    authEpoch: auth.token.aep, mfaEpoch: auth.token.mep }, async () =>
    c.json({ data: await service.createAdministrative(actor(c), { orgId: oid(c), ...c.req.valid('json') }) }, 201));
});
```

In the existing validation-error handler map `stepup_invalidated` and `interactive_stepup_required` to 403 before its ordinary 400 branch. No body session/epoch fields are accepted. Actor-context `mfa:true` at `actorContext.ts:292` has no live SID/epochs. Keep `reachableContact` site checks; the route's schema is strict.

Replace W01 gate's default-false `ports.administrativeEligible(r)` call with this concrete live checker, imported from `administrative.ts` (the existing preceding age check remains):

```ts
const eligible = r.initiatedByUserId !== null && r.stepupSessionId !== null &&
  r.stepupAuthEpoch !== null && r.stepupMfaEpoch !== null && r.stepupVerifiedAt !== null &&
  await administrativeEligible({ orgId: r.orgId, userId: r.initiatedByUserId,
    sid: r.stepupSessionId, authEpoch: r.stepupAuthEpoch, mfaEpoch: r.stepupMfaEpoch,
    verifiedAt: r.stepupVerifiedAt, ttlMinutes: p.verificationTtlMinutes });
if (!eligible) { reason = 'stepup_invalidated'; return null; }
```

Extend `publishCallerVerificationEffects`' ledger scan with `and(eq(v.method,'administrative_stepup'),isNull(v.deliveryPublishedAt))`. Before its pending/rejection branches add this administrative notification branch; its marker is independent of `rejectionNotifiedAt`:

```ts
if (row.method === 'administrative_stepup' && !row.deliveryPublishedAt) {
  const recipients = await scoped(() => securityRecipients(row.orgId));
  const email = getEmailService();
  if (!email) throw new Error('Administrative notification transport unavailable');
  for (const person of recipients) {
    await scoped(() => createNotification({ userId: person.id, orgId: row.orgId, type: 'security', priority: 'high',
      title: 'Administrative account disable authorised', message: row.reason ?? 'Review the contact verification record.',
      link: '/security/incidents', dedupeKey: `caller-administrative-${row.id}`,
      metadata: { verificationId: row.id, contactId: row.contactId } }));
    await email.sendEmail({ to: person.email, subject: 'Administrative account disable authorised',
      html: '<p>Review the administrative verification and its reason in Breeze.</p>',
      text: `Administrative verification ${row.id}. Reason: ${row.reason ?? ''}`,
      headers: { 'Message-ID': `<caller-admin-${row.id}-${person.id}@notifications.invalid>` } });
  }
  await scoped(() => db.update(v).set({ deliveryPublishedAt: new Date() }).where(eq(v.id, row.id)));
  continue;
}
```

The existing publisher's `scoped` helper closes transactions before email. This branch never sends a caller challenge. Audit is transactional; in-app notifications deduplicate; SMTP remains at-least-once on a crash after send, matching W01. Extend its tests to seed one unmarked administrative row, assert one notification and no `ports.deliver`, rerun with the marker populated and assert zero repeated delivery.

- [ ] **Step 4: Run:** `cd apps/api && npx vitest run src/services/callerVerification/administrative.test.ts src/services/callerVerification/gate.test.ts src/routes/callerVerification.test.ts` → pass; route cases include unauthenticated, wrong role/org/site, malformed reason and cross-session grant.
- [ ] **Step 5: Commit.**

```bash
ls apps/api/migrations | sort | tail -1
git add apps/api/src/jobs/callerVerificationPublisher.ts apps/api/src/services/callerVerification/administrativeContext.ts apps/api/src/services/callerVerification/administrative.ts apps/api/src/services/callerVerification/administrative.test.ts apps/api/src/services/callerVerification/service.ts apps/api/src/services/callerVerification/gate.ts apps/api/src/routes/callerVerification.ts apps/api/src/routes/callerVerification.test.ts
git commit -m "feat(caller-verification): create session-bound administrative grants"
```

### Task 12: Preserve typed refusals through all four adapters

**Files:** Modify `apps/api/src/services/aiAgentSdk.ts:1207,1455,1477`, `apps/api/src/services/aiAgentSdk.test.ts`; `apps/api/src/services/aiAgentSdkTools.ts:132,367,468,668,1097`, `apps/api/src/services/aiAgentSdkTools.m365gating.test.ts`; `apps/api/src/jobs/intentReleaseWorker.ts:707,738,922`, `apps/api/src/jobs/intentReleaseWorker.test.ts`; `apps/api/src/routes/mcpServer.ts:1324`, `apps/api/src/routes/mcpServer.test.ts`; `apps/api/src/routes/helper/index.test.ts:148,306`. Read helper stream/history at `apps/api/src/routes/helper/index.ts:383–405,612`; no product change there if passthrough remains intact. Also modify W01-owned `apps/api/src/services/callerVerification/service.ts` (the additive HTTP projection).

**Interfaces:** Denied `PreToolUseCallback` adds `requiresCallerVerification?: CallerRefusalPayload`. Worker persists `{ error: 'Caller verification required', requiresCallerVerification }` in `ActionIntentTransitionPatch.result`; existing failure `errorCode` remains `caller_verification_required`. MCP retains text-content envelope and sets `isError:true`; helper retains JSON in `tool_result.output` and history `toolOutput`.

- [ ] **Step 1: Write one behavioural test at each adapter using its existing harness.** These are additions to current suites, not source-string assertions:

```ts
// aiAgentSdk.test.ts: existing makeActiveSession / mockCreateActionIntent.
it('creation refusal reaches the SDK pre-tool result intact', async () => {
  const session = makeActiveSession();
  mockInsertReturning({ id: 'exec-caller' });
  const payload = { orgId: session.orgId, contactId: null, action: 'disable_user' as const,
    requiredTier: 2, reason: 'no_fresh_verification' as const, latest: null };
  mockCreateActionIntent.mockRejectedValueOnce(new CallerVerificationRequiredError(payload));
  vi.mocked(checkGuardrails).mockReturnValue({ allowed: true, tier: 3, requiresApproval: true,
    description: 'Disable user', warnings: [] } as never);
  const result = await createSessionPreToolUse(session)('m365_disable_user', {
    userIdentifier: 'person@example.com', reason: 'Approved offboarding request',
  });
  expect(result).toMatchObject({ allowed: false, requiresCallerVerification: payload });
});
// intentReleaseWorker.test.ts: existing baseIntent / primeThroughRevalidation.
it('typed caller refusal terminalises once and is not retried', async () => {
  const args = { userIdentifier: 'person@example.com', reason: 'Approved offboarding request' };
  const intent = baseIntent({ actionName: 'm365_disable_user', arguments: args,
    argumentDigest: computeArgumentDigest(canonicalizeArguments(args)),
    targetEntraTenantId: 'tenant', targetEntraOid: 'oid', targetConnectionRef: 'connection' });
  vi.mocked(loadPinnedCallerBackend).mockResolvedValue({ backend: 'controlPlane', orgId: intent.orgId, connectionId: 'connection', tenantId: 'tenant' });
  primeThroughRevalidation(intent);
  const payload = { orgId: intent.orgId, contactId: null, action: 'disable_user' as const,
    requiredTier: 2, reason: 'contact_fenced' as const, latest: null };
  vi.mocked(requireCallerVerification).mockRejectedValueOnce(new CallerVerificationRequiredError(payload));
  await expect(releaseApprovedIntent(intent.id)).resolves.toBeUndefined();
  expect(intentServiceMock.transitionIntent).toHaveBeenCalledWith(intent.id, 'executing', 'failed',
    expect.objectContaining({ errorCode: 'caller_verification_required',
      result: { error: 'Caller verification required', requiresCallerVerification: payload } }));
  expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
});
// mcpServer.test.ts: route injection uses a permitted READ tool to test the
// adapter independently; Tier-3's existing MCP_APPROVAL_REQUIRED stays intact.
it('MCP serialises a typed refusal without sanitising its payload away', async () => {
  setTestApiKey({ scopes: ['ai:read', 'ai:execute'] });
  routeMocks.getToolTier.mockReturnValue(1);
  routeMocks.getToolDefinitions.mockReturnValue([{ name: 'query_devices', description: 'List devices',
    input_schema: { type: 'object', properties: {} } }]);
  routeMocks.checkGuardrails.mockReturnValue({ allowed: true, tier: 1, requiresApproval: false, warnings: [] });
  const payload = { orgId: 'org-1', contactId: null, action: 'disable_user' as const,
    requiredTier: 2, reason: 'subject_unmatched' as const, latest: null };
  routeMocks.executeTool.mockRejectedValueOnce(new CallerVerificationRequiredError(payload));
  const response = await mcpServerRoutes.request('/message', { method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-Key': 'brz_test' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'query_devices', arguments: {} } }) });
  const body = await response.json();
  expect(body.result.isError).toBe(true);
  expect(JSON.parse(body.result.content[0].text).requiresCallerVerification).toEqual(payload);
});
```

In the existing helper stream test's `activeSession.eventBus.subscribe` generator, use this complete event sequence instead of its single `done`; keep `mockHelperAuthDevice`, existing DB session row, `streamingSessionManager` setup and actual request unchanged:

```ts
const payload = { orgId: 'org-1', contactId: null, action: 'disable_user',
  requiredTier: 2, reason: 'contact_fenced', latest: null };
const refusal = JSON.stringify({ error: 'Caller verification required', requiresCallerVerification: payload });
subscribe: vi.fn(async function* () {
  yield { type: 'tool_result', toolUseId: 'call-caller', output: refusal, isError: true };
  yield { type: 'done' };
}),
```

After the request assert `const stream = await res.text(); expect(stream).toContain(JSON.stringify(refusal));`. Add the same refusal string as the stored `toolOutput` in the existing GET-history fixture and assert the returned field equals it. Add this separate inline-release regression inside the existing `createSessionPreToolUse` suite (its `beforeEach` already primes the intent/approval DB reads):

```ts
it('inline release persists and returns the caller payload after its claim', async () => {
  vi.mocked(checkGuardrails).mockReturnValue({ allowed: true, tier: 3, requiresApproval: true,
    description: 'Disable user' } as never);
  mockInsertReturning({ id: 'exec-inline-caller' });
  mockCreateActionIntent.mockResolvedValue(makeIntentSnapshot({ id: 'intent-inline-caller', approvalRequestIds: ['approval-caller'] }));
  mockWaitForIntentDecision.mockResolvedValue('approved');
  mockTransitionIntent.mockResolvedValue(true);
  const payload = { orgId: 'org-1', contactId: null, action: 'disable_user', requiredTier: 2,
    reason: 'contact_fenced', latest: null };
  mockRevalidateApprovedIntentForRelease.mockResolvedValue({ ok: false, errorCode: 'caller_verification_required',
    details: { requiresCallerVerification: payload } });
  const session = makeActiveSession({ approvalMode: 'per_step' });
  const result = await createSessionPreToolUse(session)('m365_disable_user', {
    userIdentifier: 'person@example.com', reason: 'Approved offboarding request' });
  expect(result).toMatchObject({ allowed: false, requiresCallerVerification: payload });
  expect(mockTransitionIntent).toHaveBeenCalledWith('intent-inline-caller', 'executing', 'failed',
    expect.objectContaining({ result: { error: 'Caller verification required', requiresCallerVerification: payload } }));
});
```


- [ ] **Step 2: Run:** `cd apps/api && npx vitest run src/services/aiAgentSdk.test.ts src/jobs/intentReleaseWorker.test.ts src/routes/mcpServer.test.ts src/routes/helper/index.test.ts` → creation/inline/worker/MCP lose the payload; helper regression may already pass.
- [ ] **Step 3: Implement without parsing prose.** Import `CallerRefusalPayload` and widen all four denied callback annotations (132/468/668/1097). `preToolUseDenialResult` accepts the optional payload; its ordinary error branch becomes:

```ts
{ error: check.error, ...(check.requiresCallerVerification
  ? { requiresCallerVerification: check.requiresCallerVerification } : {}) }
```

In SDK revalidation failure compute:

```ts
const requiresCallerVerification = revalidation.errorCode === 'caller_verification_required'
  ? revalidation.details?.requiresCallerVerification as CallerRefusalPayload | undefined : undefined;
const result = requiresCallerVerification
  ? { error: 'Caller verification required', requiresCallerVerification } : undefined;
```

Pass `{ errorCode: revalidation.errorCode, ...(result ? { result } : {}) }` to `transitionIntentAndPublish`, and return `failMatchedPlanStep({ allowed:false, error: result?.error ?? 'Authorization for this action could no longer be verified; it was not executed.', ...(requiresCallerVerification ? {requiresCallerVerification} : {}) })`. Preserve lost-CAS reporting. Do not expose entire revalidation `details` indiscriminately.

Worker `failIntent` adds this safe conditional result to its existing `terminalizeIntent` patch:

```ts
...(errorCode === 'caller_verification_required' && options.details?.requiresCallerVerification
  ? { result: { error: 'Caller verification required',
      requiresCallerVerification: options.details.requiresCallerVerification } } : {}),
```

In worker dispatch catch, **before** ordinary connection/execution errors:

```ts
const refusal = callerRefusal(err);
if (refusal) {
  await failIntent(intent, 'caller_verification_required', {
    details: { requiresCallerVerification: refusal.requiresCallerVerification },
  });
  return;
}
```

Return normally, no BullMQ throw or retry. A refused final gate writes no marker and made no mutation. For a transport failure after a marker, retain normal execution failure and stored consumption. The concrete projection below supplies W04's translated “verification used, action failed, re-verify” state from the persisted intent/grant relationship; never clear `consumed_at`. Task 13 exercises this path through the real release worker and a failing outbound client.

Extend W01's **existing** `service.ts` additive HTTP projection; do not change the index's `VerificationView` or return signatures. W04 consumes the exact field `consumedIntentStatus` and owns its translated failed-action/re-verification UI in `VerificationStatus`, `VerificationFlow` and `TicketVerificationBadge` (W04 Tasks 3, 5–6, including all eight locale values for `usedActionFailed` and `reverify`). Preserve those consumers unchanged. Replace W01's additive type and pure projection helper with the following; the optional final argument preserves its existing test calls:

```ts
export type VerificationDetails = VerificationView & {
  remainingAttempts: number | null; usableUntil: string | null; incidentId: string | null;
  consumedAction: CallerVerificationAction | null;
  consumedIntentStatus: typeof actionIntents.$inferSelect['status'] | null;
  undeliverableReason: 'no_session_for_user' | 'session_not_console' | 'helper_outdated' | 'sms_failed' | 'email_failed' | null;
};
export function verificationDetails(r: VerificationRow, userId: string | null, targetId: string | null,
  policy: Awaited<ReturnType<typeof getEffectivePolicy>>, attempts: number, incidentId: string | null,
  actionName: string | null, intentStatus: typeof actionIntents.$inferSelect['status'] | null = null): VerificationDetails {
  const reasons = ['no_session_for_user', 'session_not_console', 'helper_outdated', 'sms_failed', 'email_failed'] as const;
  const reason = reasons.find(value => value === r.reason) ?? null;
  const proofAt = r.method === 'administrative_stepup' ? r.stepupVerifiedAt : r.decidedAt;
  return { ...view(r, userId, targetId), remainingAttempts: Math.max(0, policy.maxAttemptsPerHour - attempts),
    usableUntil: r.status === 'verified' && proofAt
      ? new Date(proofAt.getTime() + policy.verificationTtlMinutes * 60000).toISOString() : null,
    incidentId,
    consumedAction: !r.consumedAt ? null : actionName === 'm365_reset_password' ? 'reset_password'
      : actionName === 'm365_disable_user' ? 'disable_user' : null,
    consumedIntentStatus: r.consumedAt ? intentStatus : null,
    undeliverableReason: r.status === 'undeliverable' ? reason : null };
}
```

In `projectVerification`, replace its consumed-intent select and final return with this concrete code. The authorized org predicate is required even under system scope; a merge may leave the historical intent in the former org. Do not expose executor errors, credentials, or raw `result`:

```ts
const [intent] = r.consumedAt && r.consumedIntentRef
  ? await db.select({ actionName: actionIntents.actionName, status: actionIntents.status }).from(actionIntents)
    .where(and(eq(actionIntents.orgId, r.orgId), eq(actionIntents.id, r.consumedIntentRef))).limit(1)
  : [];
return verificationDetails(r, userId, targetId, policy, Number(attempts?.count ?? 0),
  incident?.id ?? null, intent?.actionName ?? null, intent?.status ?? null);
```

All start/get/cancel/attest/history/ticket/admin responses retain W01's `projectVerification` path. An absent or out-of-org intent projects null while `consumedAt` remains set. Task 13's real release failure asserts this projection through the authorized `get` reader, with a separate cross-org negative control. Run the exact W04 response and presentation suites in Step 4; the failed-action display must be driven by `consumedIntentStatus === 'failed'`, never by consumption alone. Re-verification creates a fresh challenge through W04's existing `runAction` path; it never replays the failed intent.

MCP catch becomes:

```ts
const refusal = callerRefusal(err);
const message = refusal ? refusal.error : sanitizeThrownToolError(toolName, err);
const safeError = compactToolResultForChat(toolName, JSON.stringify(refusal ?? { error: message }));
```

Keep its failure ledger/MCP envelope. Session-aware SDK catch likewise uses `callerRefusal(error)` before generic sanitisation and passes the safe serialized object to `safePostToolUse`; never put a `SecretToolResult.secrets` into the refusal. Check `compactToolResultForChat` does not discard `requiresCallerVerification`; if it transforms that tool's payload, return this bounded refusal object before compaction. Existing Tier-3 MCP denial at `mcpServer.ts:1215` must remain.

- [ ] **Step 4: Run:** Step 2 command plus `cd apps/api && npx vitest run src/services/aiAgentSdkTools.m365gating.test.ts` → each adapter has a passing behavioural assertion; helper stream/history remain intact. Also run `cd apps/api && npx vitest run src/services/callerVerification/service.test.ts` and `cd apps/web && npx vitest run src/lib/api/callerVerification.test.ts src/components/callerVerification/VerificationStatus.test.tsx src/components/callerVerification/VerifyCallerModal.test.tsx src/components/callerVerification/TicketVerificationBadge.test.tsx` to verify the inherited projection and translated re-verification consumers.
- [ ] **Step 5: Commit.**

```bash
ls apps/api/migrations | sort | tail -1
git add apps/api/src/services/callerVerification/service.ts apps/api/src/services/aiAgentSdk.ts apps/api/src/services/aiAgentSdk.test.ts apps/api/src/services/aiAgentSdkTools.ts apps/api/src/services/aiAgentSdkTools.m365gating.test.ts apps/api/src/jobs/intentReleaseWorker.ts apps/api/src/jobs/intentReleaseWorker.test.ts apps/api/src/routes/mcpServer.ts apps/api/src/routes/mcpServer.test.ts apps/api/src/routes/helper/index.test.ts
git commit -m "fix(caller-verification): preserve refusals through every adapter"
```

### Task 13: Prove the real contract, tenant isolation and rejection races

**Files:** Create `apps/api/src/services/callerVerification/callerVerificationGate.contract.test.ts`; create `apps/api/src/__tests__/integration/callerVerificationEnforcement.integration.test.ts`; modify existing backend, administrative, revocation and revalidation tests from Tasks 2–12. Integration placement is intentional: the standing integration config discovers this directory, while the unit config excludes it.

**Interfaces:** Consumes exact W01 public `requireCallerVerification`, `withSubjectLocks`, `applyDecision`, `handleRejection`, `createAdministrative`; W05 `prepareCallerDispatch`, `revokeIntentsForSubject`; existing `db`, `withSystemDbAccessContext`, `withDbAccessContext`. Produces test evidence only; no alternative gate/authorisation implementation.

- [ ] **Step 1: Write the source contract, then the live DB tests.**

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
describe('caller verification enforcement sites', () => {
  it.each([
    ['../actionIntents/revalidateRelease.ts', 'revalidateApprovedIntentForRelease', "mode: 'consume'"],
    ['../m365DirectGraph.ts', "case 'disable_user'", 'requireCallerVerification'],
    ['../m365DirectGraph.ts', "case 'reset_user_password'", 'requireCallerVerification'],
    ['../m365ControlPlane/writeActionService.ts', "case 'm365.user.disable'", 'requireCallerVerification'],
    ['../m365ControlPlane/writeActionService.ts', "case 'm365.user.reset_password'", 'requireCallerVerification'],
    ['../aiToolsM365.ts', "toolName === 'disable_user'", 'requireCallerVerification'],
    ['../aiToolsM365.ts', "toolName === 'reset_user_password'", 'requireCallerVerification'],
  ])('%s guards %s', (path, marker, gate) => {
    const text = source(path);
    const start = text.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const stops = [text.indexOf('\n    case ', start + marker.length),
      text.indexOf('\nexport ', start + marker.length), text.indexOf('\nasync function ', start + marker.length)]
      .filter(index => index > start);
    let end = stops.length ? Math.min(...stops) : text.length;
    // Consecutive case labels share one block; advance across the second label.
    if (text.slice(start, end).trim() === marker + ':') {
      const next = text.indexOf('\n    case ', end + 1);
      end = next < 0 ? text.length : next;
    }
    expect(text.slice(start, end)).toContain(gate);
    expect(text).toContain('requireCallerVerification');
  });
});
```

The slice ends at the next function/case; keep the combined-label clause when formatting the switch. The combined control-plane two-label block counts as one guard for both actions. Keep the behavioural tests: a source reference alone proves neither ordering nor zero HTTP writes.

The live suite imports `./setup` and seeds **before each test** because shared setup truncates core rows. Its fixture is new and explicit:

```ts
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, users, contacts, sites, actionIntents,
  m365Connections, delegantM365Connections, callerVerifications, callerVerificationSubjectBindings, callerVerificationPolicies } from '../../db/schema';
import { seedActionsConnection } from '../../services/m365ControlPlane/__testHelpers__/seedActionsConnection';
import { requireCallerVerification, applyDecision, handleRejection } from '../../services/callerVerification';
import { prepareCallerDispatch } from '../../services/callerVerification/dispatch';
import { resolveTargetBinding } from '../../services/callerVerification/subjects';
import { loadPinnedCallerBackend } from '../../services/actionIntents/callerTarget';
import { revokeIntentsForSubject } from '../../services/actionIntents/revokeIntentsForSubject';
import { computeArgumentDigest, canonicalizeArguments } from '../../services/actionIntents/canonicalize';
import { getCurrentDbAccessContext, runOutsideDbContext } from '../../db';
import { callerVerificationDestinations, auditLogs, approvalRequests } from '../../db/schema';
import { destinationHash } from '../../services/callerVerification/destinations';
import * as mailboxReadService from '../../services/m365ControlPlane/readActionService';

// Match the existing jobs/intentReleaseWorkerM365Headless.integration.test.ts
// transport boundary. No gate, dispatch, headless service or DB mocks.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseApprovedIntent } from '../../jobs/intentReleaseWorker';
import { get as getVerification } from '../../services/callerVerification/service';
const outbound = vi.hoisted(() => ({ executeWriteAction: vi.fn() }));
vi.mock('../../services/m365ControlPlane/graphActionsExecutorClient', () => ({
  createGraphActionsExecutorClient: () => ({ executeWriteAction: outbound.executeWriteAction }),
  GraphActionsExecutorClientError: class GraphActionsExecutorClientError extends Error {},
}));
let releaseTempDir: string;
let releaseSigningFile: string;
beforeAll(() => {
  releaseTempDir = mkdtempSync(join(tmpdir(), 'breeze-caller-release-'));
  releaseSigningFile = join(releaseTempDir, 'signing.jwk');
  writeFileSync(releaseSigningFile, JSON.stringify({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA',
    use: 'sig', kid: 'graph-actions-api-1', x: Buffer.alloc(32, 1).toString('base64url'),
    d: Buffer.alloc(32, 2).toString('base64url') }), { mode: 0o600 });
});
beforeEach(() => {
  outbound.executeWriteAction.mockReset();
  for (const [name, value] of Object.entries({
    M365_GRAPH_ACTIONS_TOOLS_ENABLED: 'true', M365_GRAPH_ACTIONS_TOOLS_ORG_IDS: '*',
    M365_CUSTOMER_GRAPH_ACTIONS_CLIENT_ID: 'c3333333-3333-4333-8333-333333333333',
    M365_CUSTOMER_GRAPH_ACTIONS_CREDENTIAL_VERSION: '0123456789abcdef0123456789abcdef',
    M365_CUSTOMER_GRAPH_ACTIONS_VAULT_REF: 'akv://vault.example/m365-customer-graph-actions/0123456789abcdef0123456789abcdef',
    M365_GRAPH_ACTIONS_EXECUTOR_URL: 'https://executor.example.test',
    M365_GRAPH_ACTIONS_EXECUTOR_AUDIENCE: 'm365-graph-actions-executor',
    M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_PRIVATE_JWK_FILE: releaseSigningFile,
    M365_GRAPH_ACTIONS_EXECUTOR_SIGNING_KID: 'graph-actions-api-1',
  })) vi.stubEnv(name, value);
});
afterAll(() => rmSync(releaseTempDir, { recursive: true, force: true }));

async function seed() {
  return withSystemDbAccessContext(async () => {
    const suffix = randomUUID();
    const [partner] = await db.insert(partners).values({ name: 'Caller test', slug: `caller-${suffix}` }).returning();
    const [org] = await db.insert(organizations).values({ partnerId: partner!.id, name: 'Caller test',
      slug: `caller-${suffix}`, currencyCode: 'USD' }).returning();
    const [user] = await db.insert(users).values({ email: `${suffix}@example.com`, name: 'Technician',
      passwordHash: 'test-only', status: 'active', orgId: org!.id, partnerId: partner!.id }).returning();
    const [contact] = await db.insert(contacts).values({ orgId: org!.id, name: 'Requester', roles: ['admin'] }).returning();
    const [other] = await db.insert(contacts).values({ orgId: org!.id, name: 'Target' }).returning();
    const tenant = randomUUID();
    const [requester, target] = await db.insert(callerVerificationSubjectBindings).values([
      { orgId: org!.id, contactId: contact!.id, entraTenantId: tenant, entraOid: randomUUID(), source: 'technician_attested', establishedAt: new Date() },
      { orgId: org!.id, contactId: other!.id, entraTenantId: tenant, entraOid: randomUUID(), source: 'technician_attested', establishedAt: new Date() },
    ]).returning();
    const connection = await seedActionsConnection({ orgId: org!.id, tenantId: tenant });
    const args = { userIdentifier: 'target@example.com', reason: 'Approved account offboarding' };
    const [intent] = await db.insert(actionIntents).values({ orgId: org!.id, partnerId: partner!.id,
      requestedByUserId: user!.id, originPrincipalKind: 'user_session', source: 'chat',
      actionName: 'm365_disable_user', arguments: args, argumentDigest: computeArgumentDigest(canonicalizeArguments(args)),
      targetSummary: 'Disable target', impactSummary: 'Block sign-in', riskTier: 3,
      idempotencyKey: suffix, correlationId: randomUUID(), expiresAt: new Date(Date.now() + 3600_000),
      status: 'executing', targetEntraTenantId: tenant, targetEntraOid: target!.entraOid,
      targetConnectionRef: connection.id }).returning();
    const [grant] = await db.insert(callerVerifications).values({ orgId: org!.id, contactId: contact!.id,
      requesterBindingId: requester!.id, targetBindingId: target!.id, targetEntraTenantId: tenant,
      targetEntraOid: target!.entraOid, initiatedByUserId: user!.id, technicianLabel: user!.name,
      actionScope: 'disable_user', method: 'callback_attestation', status: 'verified', tier: 1,
      tierReason: 'attestation', matchValue: '42', decoyValues: ['17', '63'], reverseCode: '7319',
      attemptNo: 1, decidedAt: new Date(), expiresAt: new Date(Date.now() + 1800_000) }).returning();
    // Explicit partner policy permits callback for these lock/identity tests.
    // Administrative default-policy tests below delete this row.
    await db.insert(callerVerificationPolicies).values({ partnerId: partner!.id, requiredTierDisableUser: 1 });
    return { org: org!, partner: partner!, user: user!, contact: contact!, other: other!,
      requester: requester!, target: target!, connection, intent: intent!, grant: grant!, tenant };
  });
}
let f: Awaited<ReturnType<typeof seed>>;
beforeEach(async () => { vi.stubEnv('CALLER_VERIFICATION_ENABLED', 'true'); f = await seed(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const run = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn, 'caller-enforcement-test');
const gateInput = (intentId = f.intent.id) => ({ orgId: f.org.id, action: 'disable_user' as const,
  target: { entraTenantId: f.tenant, entraOid: f.target.entraOid! }, backendTenantId: f.tenant,
  technicianUserId: f.user.id, intentId, mode: 'consume' as const });
const dispatchInput = () => ({ orgId: f.org.id, action: 'disable_user' as const, intentId: f.intent.id,
  connectionId: f.connection.id, backendTenantId: f.tenant, oid: f.target.entraOid! });

it('tier zero dispatches a bindingless target and still prevents duplicate dispatch', async () => {
  await run(async () => {
    await db.update(callerVerificationPolicies).set({ requiredTierDisableUser: 0 })
      .where(eq(callerVerificationPolicies.partnerId, f.partner.id));
    await db.delete(callerVerifications).where(eq(callerVerifications.orgId, f.org.id));
    await db.delete(callerVerificationSubjectBindings).where(eq(callerVerificationSubjectBindings.orgId, f.org.id));
  });
  await expect(run(() => requireCallerVerification(gateInput()))).resolves.toEqual({ verificationId: '', tier: 0 });
  await expect(run(() => prepareCallerDispatch({ ...dispatchInput(), oid: randomUUID() })))
    .rejects.toMatchObject({ payload: { reason: 'target_rebound' } });
  await expect(run(() => prepareCallerDispatch({ ...dispatchInput(), backendTenantId: randomUUID() })))
    .rejects.toMatchObject({ payload: { reason: 'tenant_mismatch' } });
  vi.stubEnv('CALLER_VERIFICATION_ENABLED', 'false');
  await expect(run(() => prepareCallerDispatch(dispatchInput())))
    .rejects.toMatchObject({ payload: { reason: 'feature_disabled' } });
  vi.stubEnv('CALLER_VERIFICATION_ENABLED', 'true');
  const [before] = await run(() => db.select().from(actionIntents).where(eq(actionIntents.id, f.intent.id)));
  expect(before!.dispatchStartedAt).toBeNull();
  await expect(run(() => prepareCallerDispatch(dispatchInput()))).resolves.toBeUndefined();
  const [after] = await run(() => db.select().from(actionIntents).where(eq(actionIntents.id, f.intent.id)));
  expect(after!.dispatchStartedAt).toBeInstanceOf(Date);
  await expect(run(() => prepareCallerDispatch(dispatchInput()))).rejects.toThrow('Dispatch already started');
});
it('email dispatch uses the real W03 mailbox adapter with reader attribution outside the DB context', async () => {
  await run(async () => {
    await db.insert(m365Connections).values({ ...f.connection, id: randomUUID(),
      profile: 'customer-graph-read', credentialDomain: 'customer-graph-read' });
    await db.update(callerVerificationPolicies).set({ requiredTierDisableUser: 2 })
      .where(eq(callerVerificationPolicies.partnerId, f.partner.id));
    const [destination] = await db.insert(callerVerificationDestinations).values({
      orgId: f.org.id, contactId: f.contact.id, kind: 'email',
      valueHash: destinationHash('manager@example.com'), valueRedacted: 'm•••@example.com',
      source: 'technician', setByUserId: f.user.id, setAt: new Date(Date.now() - 8 * 86400_000),
    }).returning();
    await db.update(callerVerifications).set({ method: 'email', destinationId: destination!.id,
      tier: 2, tierReason: 'destination_established' }).where(eq(callerVerifications.id, f.grant.id));
  });
  // Only the selected backend read is stubbed. Ports, fetchTargetMailboxes,
  // fetchMailboxResourceByOrg, withMailboxReader and both gates remain real.
  const read = vi.spyOn(mailboxReadService, 'executeM365MailboxReadByOrg').mockImplementation(async (orgId, target, actorId) => {
    expect(getCurrentDbAccessContext()).toBeUndefined();
    expect({ orgId, target, actorId }).toEqual({ orgId: f.org.id,
      target: { entraTenantId: f.tenant, entraOid: f.target.entraOid }, actorId: f.user.id });
    return { id: f.target.entraOid!, userPrincipalName: 'target@example.com',
      mail: 'target@example.com', proxyAddresses: ['SMTP:target@example.com', 'smtp:alias@example.com'] };
  });
  await run(() => requireCallerVerification(gateInput()));
  expect(read).toHaveBeenCalledTimes(1);
  await expect(run(() => prepareCallerDispatch(dispatchInput()))).resolves.toBeUndefined();
  expect(read).toHaveBeenCalledTimes(2);
  const [intent] = await run(() => db.select().from(actionIntents).where(eq(actionIntents.id, f.intent.id)));
  expect(intent!.dispatchStartedAt).toBeInstanceOf(Date);
});
it('outbound failure after consumption fails release, retains the marker, and refuses reuse', async () => {
  const role = await createRole({ scope: 'organization', orgId: f.org.id });
  await grantRolePermissions(role.id, [{ resource: 'm365', action: 'execute' }]);
  await assignUserToOrganization(f.user.id, f.org.id, role.id);
  await run(async () => {
    await db.update(actionIntents).set({ status: 'approved' }).where(eq(actionIntents.id, f.intent.id));
    await db.insert(approvalRequests).values({ userId: f.user.id, requestingClientLabel: 'Caller regression',
      actionLabel: 'Disable target', actionToolName: f.intent.actionName, actionArguments: f.intent.arguments,
      riskTier: 'high', riskSummary: 'Block sign-in', status: 'approved', expiresAt: f.intent.expiresAt,
      intentId: f.intent.id, boundArgumentDigest: f.intent.argumentDigest });
  });
  let atDispatch: { intent: typeof actionIntents.$inferSelect | undefined;
    grant: typeof callerVerifications.$inferSelect | undefined } | undefined;
  outbound.executeWriteAction.mockImplementationOnce(async () => {
    // Fresh connections prove both writes committed BEFORE the outbound call.
    atDispatch = await runOutsideDbContext(() => run(async () => {
      const [intent] = await db.select().from(actionIntents).where(eq(actionIntents.id, f.intent.id));
      const [grant] = await db.select().from(callerVerifications).where(eq(callerVerifications.id, f.grant.id));
      return { intent, grant };
    }));
    throw new Error('executor transport failed');
  });
  // Do not wrap release in run(): the production worker owns its boundaries.
  await releaseApprovedIntent(f.intent.id);
  expect(outbound.executeWriteAction).toHaveBeenCalledTimes(1);
  // Assert outside the outbound double: worker error handling must not swallow
  // an assertion failure and accidentally make this regression pass.
  expect(atDispatch).toMatchObject({
    intent: { status: 'executing', dispatchStartedAt: expect.any(Date) },
    grant: { consumedAt: expect.any(Date), consumedIntentRef: f.intent.id },
  });
  const [failed] = await run(() => db.select().from(actionIntents).where(eq(actionIntents.id, f.intent.id)));
  const [used] = await run(() => db.select().from(callerVerifications).where(eq(callerVerifications.id, f.grant.id)));
  expect(failed).toMatchObject({ status: 'failed', errorCode: 'execution_error', dispatchStartedAt: expect.any(Date) });
  expect(used).toMatchObject({ consumedAt: expect.any(Date), consumedIntentRef: f.intent.id });
  const actor: CallerVerificationActor = { userId: f.user.id, partnerId: f.partner.id,
    scope: 'organization', accessibleOrgIds: [f.org.id], allowedSiteIds: null, displayName: 'Technician' };
  await expect(run(() => getVerification(actor, f.org.id, f.grant.id))).resolves.toMatchObject({
    consumedAction: 'disable_user', consumedIntentStatus: 'failed', consumedAt: used!.consumedAt!.toISOString(),
  });
  const [second] = await run(() => db.insert(actionIntents).values({ ...f.intent,
    id: randomUUID(), idempotencyKey: randomUUID(), status: 'executing', dispatchStartedAt: null }).returning());
  await expect(run(() => requireCallerVerification(gateInput(second!.id))))
    .rejects.toMatchObject({ payload: { reason: 'grant_consumed' } });
  await releaseApprovedIntent(f.intent.id);
  expect(outbound.executeWriteAction).toHaveBeenCalledTimes(1);
  const [retained] = await run(() => db.select().from(callerVerifications).where(eq(callerVerifications.id, f.grant.id)));
  expect(retained!.consumedAt).toEqual(used!.consumedAt);
  expect(retained!.consumedIntentRef).toBe(f.intent.id);
});
it('consumed-intent projection does not cross organizations or erase consumption', async () => {
  const other = await seed();
  await run(() => db.update(callerVerifications).set({ consumedAt: new Date(), consumedIntentRef: other.intent.id })
    .where(eq(callerVerifications.id, f.grant.id)));
  const actor: CallerVerificationActor = { userId: f.user.id, partnerId: f.partner.id,
    scope: 'organization', accessibleOrgIds: [f.org.id], allowedSiteIds: null, displayName: 'Technician' };
  const result = await run(() => getVerification(actor, f.org.id, f.grant.id));
  expect(result).toMatchObject({ consumedAction: null, consumedIntentStatus: null });
  expect(result.consumedAt).not.toBeNull();
});
it('two different intents cannot consume one grant; same-intent retry can', async () => {
  const [second] = await run(() => db.insert(actionIntents).values({ ...f.intent,
    id: randomUUID(), idempotencyKey: randomUUID(), dispatchStartedAt: null }).returning());
  const secondId = second!.id;
  const results = await Promise.allSettled([
    run(() => requireCallerVerification(gateInput())),
    run(() => requireCallerVerification(gateInput(secondId))),
  ]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const [grant] = await run(() => db.select().from(callerVerifications).where(eq(callerVerifications.id, f.grant.id)));
  await expect(run(() => requireCallerVerification(gateInput(grant!.consumedIntentRef!)))).resolves.toHaveProperty('verificationId', f.grant.id);
});
it('read and write profiles for one tenant resolve one binding', async () => {
  const [read] = await run(() => db.insert(m365Connections).values({ ...f.connection, id: randomUUID(),
    profile: 'customer-graph-read', credentialDomain: 'customer-graph-read' }).returning());
  const bindings = await run(() => Promise.all([read!, f.connection].map(connection => resolveTargetBinding(f.org.id,
    { entraTenantId: connection.tenantId!, entraOid: f.target.entraOid! }))));
  expect(bindings.map(binding => binding.id)).toEqual([f.target.id, f.target.id]);
});
it('Delegant-only org resolves its own tenant without an m365_connections row', async () => {
  await run(() => db.delete(m365Connections).where(eq(m365Connections.orgId, f.org.id)));
  const [connection] = await run(() => db.insert(delegantM365Connections).values({ orgId: f.org.id,
    customerLabel: 'caller-test', customerDisplayName: 'Caller test', delegantOrgId: randomUUID(),
    delegantConnectionId: randomUUID(), m365TenantId: f.tenant, status: 'active' }).returning());
  const backend = await run(() => loadPinnedCallerBackend(f.org.id, connection!.id));
  expect(backend).toMatchObject({ backend: 'delegant', tenantId: f.tenant });
  await expect(run(() => requireCallerVerification({ ...gateInput(), backendTenantId: backend.tenantId })))
    .resolves.toHaveProperty('verificationId', f.grant.id);
});
it('a newer grant cannot replace the consumed dispatch grant', async () => {
  await run(() => requireCallerVerification(gateInput()));
  await run(() => db.insert(callerVerifications).values({ ...f.grant, id: randomUUID(), consumedAt: null,
    consumedIntentRef: null, createdAt: new Date(Date.now() + 1000) }));
  await expect(run(() => prepareCallerDispatch(dispatchInput()))).resolves.toBeUndefined();
});
it('manager may disable target, but substituting another OID fails', async () => {
  await expect(run(() => requireCallerVerification(gateInput()))).resolves.toHaveProperty('verificationId', f.grant.id);
  await expect(run(() => prepareCallerDispatch({ ...dispatchInput(), oid: f.requester.entraOid! })))
    .rejects.toMatchObject({ payload: { reason: 'target_rebound' } });
});
it('a site primary with admin role cannot authorise another account', async () => {
  await run(async () => {
    const [site] = await db.insert(sites).values({ orgId: f.org.id, name: 'Branch' }).returning();
    await db.update(contacts).set({ siteId: site!.id, isPrimary: true }).where(eq(contacts.id, f.contact.id));
  });
  await expect(run(() => requireCallerVerification(gateInput())))
    .rejects.toMatchObject({ payload: { reason: 'requester_not_authorized' } });
});
it('pre-consume refusal leaves the grant unused', async () => {
  await expect(run(() => requireCallerVerification({ ...gateInput(), backendTenantId: randomUUID() })))
    .rejects.toMatchObject({ payload: { reason: 'tenant_mismatch' } });
  const [grant] = await run(() => db.select().from(callerVerifications).where(eq(callerVerifications.id, f.grant.id)));
  expect(grant!.consumedAt).toBeNull();
});
it('rejection before dispatch fences even an executing intent', async () => {
  await run(() => requireCallerVerification(gateInput()));
  await applyDecision({ verificationId: f.grant.id, decision: { kind: 'not_me' } });
  await run(() => handleRejection(f.grant.id));
  await expect(run(() => prepareCallerDispatch(dispatchInput())))
    .rejects.toMatchObject({ payload: { reason: 'contact_fenced' } });
  const result = await revokeIntentsForSubject({ orgId: f.org.id,
    bindingIds: [f.requester.id], verificationId: f.grant.id });
  expect(result.alreadyExecuting).toContain(f.intent.id);
  expect(result.alreadyDispatched).toEqual([]);
});
it('rejection after dispatch reports the irreversible boundary honestly', async () => {
  await run(() => requireCallerVerification(gateInput()));
  await run(() => prepareCallerDispatch(dispatchInput()));
  await applyDecision({ verificationId: f.grant.id, decision: { kind: 'not_me' } });
  await run(() => handleRejection(f.grant.id));
  const result = await revokeIntentsForSubject({ orgId: f.org.id,
    bindingIds: [f.requester.id], verificationId: f.grant.id });
  expect(result.alreadyDispatched).toContain(f.intent.id);
  expect(result.alreadyExecuting).toEqual([]);
});
```

- [ ] **Step 2: Run red:** `pnpm test-stack up`, then `cd apps/api && npx vitest run src/services/callerVerification/callerVerificationGate.contract.test.ts` and `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/callerVerificationEnforcement.integration.test.ts`. Before Tasks 5/9/11/12 are complete these expose missing reader context, tier-zero bypass, attempt caps, audit attribution, consumed-intent projection, fences, markers or step-up checks; after implementation they must pass with non-zero counts.
- [ ] **Step 3: Complete the behavioural matrix by appending the following concrete variants to the fixture.** Use real gate/DB, stub only outbound clients:

```ts
it('pending intents cancel through the system path without approver identity', async () => {
  await run(() => db.update(actionIntents).set({ status: 'approved' }).where(eq(actionIntents.id, f.intent.id)));
  const result = await revokeIntentsForSubject({ orgId: f.org.id, bindingIds: [f.target.id], verificationId: f.grant.id });
  expect(result.cancelled).toEqual([f.intent.id]);
  const [row] = await run(() => db.select().from(actionIntents).where(eq(actionIntents.id, f.intent.id)));
  expect(row!.result).toMatchObject({ actor: 'system:caller_verification', verificationId: f.grant.id });
});
it('all pinned fields are immutable while dispatch_started_at remains mutable', async () => {
  for (const column of ['target_entra_tenant_id', 'target_entra_oid', 'target_connection_ref']) {
    await expect(run(() => db.execute(sql`UPDATE action_intents SET ${sql.identifier(column)} = ${randomUUID()}
      WHERE id = ${f.intent.id}`))).rejects.toMatchObject({ cause: { code: '23514' } });
  }
  await expect(run(() => db.update(actionIntents).set({ dispatchStartedAt: new Date() })
    .where(eq(actionIntents.id, f.intent.id)))).resolves.toBeDefined();
});
it('changing a connection tenant cannot redirect an already-consumed intent', async () => {
  await run(() => requireCallerVerification(gateInput()));
  await run(() => db.execute(sql`UPDATE m365_connections SET tenant_id = ${randomUUID()} WHERE id = ${f.connection.id}`));
  await expect(run(() => prepareCallerDispatch(dispatchInput()))).rejects.toMatchObject({ payload: { reason: 'tenant_mismatch' } });
});
```

Add these administrative fixtures and tests to the same live suite. The existing DB utilities are verified at `__tests__/integration/db-utils.ts:324,349,405`; they create real roles and memberships. Extend imports with `refreshTokenFamilies`, `m365Connections`, `incidents`, `createAdministrative`, `withSubjectLocks`, `withAdministrativeProof`, `mintStepUpGrant`, `validateStepUpGrant` (both from `../../services/mfaStepUpGrant`), `callerVerificationAdministrativeDigest`, `buildAuthContextForIntent`, `CallerVerificationActor`, and the utilities below.

```ts
import { createRole, grantRolePermissions, assignUserToOrganization } from './db-utils';
import { PERMISSIONS } from '../../services/permissions';
async function adminFixture() {
  const role = await createRole({ scope: 'organization', orgId: f.org.id });
  await grantRolePermissions(role.id, [PERMISSIONS.ORGS_WRITE]);
  await assignUserToOrganization(f.user.id, f.org.id, role.id);
  const sid = randomUUID();
  await run(async () => {
    await db.delete(callerVerificationPolicies).where(eq(callerVerificationPolicies.partnerId, f.partner.id));
    await db.update(callerVerifications).set({ status: 'revoked' }).where(eq(callerVerifications.id, f.grant.id));
    await db.insert(refreshTokenFamilies).values({ familyId: sid, userId: f.user.id,
      absoluteExpiresAt: new Date(Date.now() + 3600_000) });
  });
  const proof = { userId: f.user.id, sid, authEpoch: f.user.authEpoch, mfaEpoch: f.user.mfaEpoch };
  const actor: CallerVerificationActor = { userId: f.user.id, partnerId: f.partner.id,
    scope: 'organization', accessibleOrgIds: [f.org.id], allowedSiteIds: null, displayName: 'Technician' };
  const reason = 'Confirmed offboarding after approval';
  const bind = { ...proof, operation: 'caller_verification_administrative_disable' as const,
    resourceDigest: callerVerificationAdministrativeDigest({ orgId: f.org.id,
      entraTenantId: f.tenant, entraOid: f.target.entraOid!, reason }) };
  return { proof, actor, bind, reason };
}
it('serializes administrative attempts, preserves the capped proof, and audits the technician', async () => {
  const a = await adminFixture();
  // Two recent attempts of different statuses count; an older one does not.
  await run(() => db.insert(callerVerifications).values([
    { ...f.grant, id: randomUUID(), contactId: f.other.id, requesterBindingId: f.target.id,
      status: 'cancelled', attemptNo: 1 },
    { ...f.grant, id: randomUUID(), contactId: f.other.id, requesterBindingId: f.target.id,
      status: 'revoked', attemptNo: 2 },
    { ...f.grant, id: randomUUID(), contactId: f.other.id, requesterBindingId: f.target.id,
      status: 'expired', createdAt: new Date(Date.now() - 2 * 3600_000) },
  ]));
  const ids = await Promise.all([mintStepUpGrant(a.bind), mintStepUpGrant(a.bind)]);
  expect(ids.every(Boolean)).toBe(true);
  const results = await Promise.allSettled(ids.map(id => run(() => withAdministrativeProof(a.proof,
    () => createAdministrative(a.actor, { orgId: f.org.id, targetContactId: f.other.id,
      reason: a.reason, stepUpGrantId: id! })))));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const loser = results.findIndex(r => r.status === 'rejected');
  expect(results[loser]).toMatchObject({ status: 'rejected', reason: { code: 'attempt_cap' } });
  expect(await validateStepUpGrant(ids[loser]!, a.bind)).toBe(true);
  const rows = await run(() => db.select().from(callerVerifications).where(and(
    eq(callerVerifications.orgId, f.org.id), eq(callerVerifications.method, 'administrative_stepup'))));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.attemptNo).toBe(3);
  const audits = await run(() => db.select().from(auditLogs).where(and(
    eq(auditLogs.orgId, f.org.id), eq(auditLogs.resourceId, rows[0]!.id),
    eq(auditLogs.action, 'caller_verification.administrative_created'))));
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({ actorType: 'user', actorId: f.user.id,
    details: expect.objectContaining({ reason: a.reason }) });
});
it.each(['operation', 'digest', 'session'] as const)('administrative grant rejects wrong %s', async wrong => {
  const a = await adminFixture();
  const minted = { ...a.bind,
    ...(wrong === 'operation' ? { operation: 'device_maintenance' as const } : {}),
    ...(wrong === 'digest' ? { resourceDigest: 'sha256:wrong' } : {}),
    ...(wrong === 'session' ? { sid: randomUUID() } : {}) };
  const id = await mintStepUpGrant(minted);
  expect(id).not.toBeNull();
  await expect(run(() => withAdministrativeProof(a.proof, () => createAdministrative(a.actor, {
    orgId: f.org.id, targetContactId: f.other.id, reason: a.reason, stepUpGrantId: id!,
  })))).rejects.toMatchObject({ code: 'stepup_invalidated' });
  const rows = await run(() => db.select().from(callerVerifications).where(and(
    eq(callerVerifications.orgId, f.org.id), eq(callerVerifications.method, 'administrative_stepup'))));
  expect(rows).toEqual([]);
});
it.each(['mfa_epoch', 'auth_epoch', 'revoked_session'] as const)('default-policy administrative grant fails after %s', async change => {
  const a = await adminFixture();
  const id = await mintStepUpGrant(a.bind);
  const created = await run(() => withAdministrativeProof(a.proof, () => createAdministrative(a.actor, {
    orgId: f.org.id, targetContactId: f.other.id, reason: a.reason, stepUpGrantId: id!,
  })));
  expect(created).toMatchObject({ method: 'administrative_stepup', tier: 3, actionScope: 'disable_user' });
  const [row] = await run(() => db.select().from(callerVerifications).where(eq(callerVerifications.id, created.id)));
  expect(row).toMatchObject({ requesterBindingId: null, stepupSessionId: a.proof.sid,
    stepupAuthEpoch: a.proof.authEpoch, stepupMfaEpoch: a.proof.mfaEpoch });
  expect(row!.stepupVerifiedAt).toBeInstanceOf(Date);
  await expect(run(() => requireCallerVerification(gateInput()))).resolves.toMatchObject({ verificationId: created.id, tier: 3 });
  await run(async () => {
    if (change === 'revoked_session') await db.update(refreshTokenFamilies).set({ revokedAt: new Date() })
      .where(eq(refreshTokenFamilies.familyId, a.proof.sid));
    else await db.execute(sql`UPDATE users SET ${sql.identifier(change)} = ${sql.identifier(change)} + 1 WHERE id = ${f.user.id}`);
  });
  await expect(run(() => prepareCallerDispatch(dispatchInput())))
    .rejects.toMatchObject({ payload: { reason: 'stepup_invalidated' } });
  const [intent] = await run(() => db.select().from(actionIntents).where(eq(actionIntents.id, f.intent.id)));
  expect(intent!.dispatchStartedAt).toBeNull();
});
it('the real release actor synthetic MFA cannot create an administrative grant', async () => {
  const a = await adminFixture();
  const auth = await buildAuthContextForIntent(f.intent);
  expect(auth?.token.mfa).toBe(true);
  expect(auth?.token.sid).toBeUndefined();
  const id = await mintStepUpGrant(a.bind);
  await expect(run(() => createAdministrative(a.actor, { orgId: f.org.id,
    targetContactId: f.other.id, reason: a.reason, stepUpGrantId: id! })))
    .rejects.toMatchObject({ code: 'interactive_stepup_required' });
});
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
it('requester rejection holds the same locks as an in-flight dispatch', async () => {
  await run(() => requireCallerVerification(gateInput()));
  const locked = barrier();
  const release = barrier();
  const fence = run(() => withSubjectLocks(db, [f.requester.id, f.target.id], async () => {
    locked.resolve();
    await release.promise;
    await db.update(callerVerifications).set({ status: 'rejected_by_user', decidedAt: new Date() })
      .where(eq(callerVerifications.id, f.grant.id));
  }));
  await locked.promise;
  const attempted = run(() => prepareCallerDispatch(dispatchInput()));
  const observed = attempted.then(() => ({ passed: true }), error => ({ error }));
  release.resolve();
  await fence;
  expect(await observed).toMatchObject({ error: { payload: { reason: 'contact_fenced' } } });
});
it('a dispatch transaction winning the lock is visible to rejection', async () => {
  await run(() => requireCallerVerification(gateInput()));
  const locked = barrier();
  const release = barrier();
  const marker = run(() => withSubjectLocks(db, [f.requester.id, f.target.id], async () => {
    await db.update(actionIntents).set({ dispatchStartedAt: new Date() }).where(eq(actionIntents.id, f.intent.id));
    locked.resolve();
    await release.promise;
  }));
  await locked.promise;
  const rejection = applyDecision({ verificationId: f.grant.id, decision: { kind: 'not_me' } });
  release.resolve();
  await marker;
  await rejection;
  await run(() => handleRejection(f.grant.id));
  const result = await revokeIntentsForSubject({ orgId: f.org.id,
    bindingIds: [f.requester.id], verificationId: f.grant.id });
  expect(result.alreadyDispatched).toContain(f.intent.id);
});
```

The admin service tests above use real Redis binding and real DB eligibility. Mirror their three mismatches in the **actual administrative route** suite with W01's mocked authenticated request harness, passing only `{targetContactId,reason,stepUpGrantId}` and expecting `stepup_invalidated`/403. Keep permission/site/flag middleware active; the service tests do not replace route tests. Add this table-driven body in that suite, using the route's declared `callerVerificationRoutes` mount at `/` (its routes already include `/orgs`) and its existing authenticated `app`:

```ts
it.each(['operation', 'digest', 'session'])('POST administrative rejects wrong %s grant', async mismatch => {
  vi.mocked(consumeStepUpGrant).mockResolvedValueOnce(false);
  const response = await app.request(`/orgs/${ORG_ID}/caller-verifications/administrative`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetContactId: TARGET_CONTACT_ID, reason: 'Confirmed offboarding after approval',
      stepUpGrantId: GRANT_ID }),
  });
  expect(response.status, mismatch).toBe(403);
  expect(await response.json()).toMatchObject({ code: 'stepup_invalidated' });
  expect(consumeStepUpGrant).toHaveBeenCalledWith(GRANT_ID, expect.objectContaining({
    operation: 'caller_verification_administrative_disable', sid: AUTH_SESSION_ID,
    resourceDigest: callerVerificationAdministrativeDigest({ orgId: ORG_ID,
      entraTenantId: TENANT_ID, entraOid: TARGET_OID, reason: 'Confirmed offboarding after approval' }),
  }));
});
```

Declare these fixture identifiers in `callerVerification.test.ts`:

```ts
const ORG_ID = '10000000-0000-4000-8000-000000000001';
const TARGET_CONTACT_ID = '10000000-0000-4000-8000-000000000002';
const GRANT_ID = '10000000-0000-4000-8000-000000000003';
const AUTH_SESSION_ID = '10000000-0000-4000-8000-000000000004';
const TENANT_ID = '10000000-0000-4000-8000-000000000005';
const TARGET_OID = '10000000-0000-4000-8000-000000000006';
const TECHNICIAN_ID = '10000000-0000-4000-8000-000000000007';
```

These identifiers They must also populate the existing mocked auth/contact/binding rows so validation exercises the intended service. The live service table above supplies the actual distinct malformed grants; route tests prove the refused result and bind reach HTTP unchanged.

Retain Tasks 2/6/7/8 backend fixtures for Delegant-only routing, two-profile binding, renamed UPN, zero mutation on refusal and exactly one on pass. Preserve W01 RLS/merge/deletion suites; this system fixture cannot prove RLS in their place.

- [ ] **Step 4: Run green:** `cd apps/api && npx vitest run src/services/callerVerification/callerVerificationGate.contract.test.ts` and `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/callerVerificationEnforcement.integration.test.ts`, plus `cd apps/api && npx vitest run src/services/m365DirectGraph.test.ts src/services/aiToolsM365.test.ts src/services/m365ControlPlane/writeActionService.test.ts src/services/callerVerification/administrative.test.ts`. Apply the migration a second time on the test stack and rerun the column/immutability checks; no duplicate trigger or data rewrite.
- [ ] **Step 5: Commit.**

```bash
ls apps/api/migrations | sort | tail -1
git add apps/api/src/services/callerVerification/callerVerificationGate.contract.test.ts apps/api/src/__tests__/integration/callerVerificationEnforcement.integration.test.ts apps/api/src/services/m365DirectGraph.test.ts apps/api/src/services/aiToolsM365.test.ts apps/api/src/services/m365ControlPlane/writeActionService.test.ts apps/api/src/services/callerVerification/administrative.test.ts apps/api/src/services/actionIntents/revalidateRelease.test.ts
git commit -m "test(caller-verification): prove dispatch, revocation and session contracts"
```

### Task 14: Activate the finished feature and publish operator guidance

**Files:** Modify W01 flag in `apps/api/src/config/env.ts` (current flag conventions at `:642`), W01-owned `apps/api/src/services/callerVerification/gate.ts` flag adapter; create `apps/api/src/config/env.callerVerification.test.ts`; modify inherited `apps/api/src/services/callerVerification/readiness.test.ts`; modify `.env.example:1093`, `docker-compose.yml:278`, `deploy/docker-compose.prod.yml:202`; create `apps/docs/src/content/docs/security/caller-verification.mdx`; modify `docs/release-notes/next-release-draft.md:13`.

**Interfaces:** Existing public `isCallerVerificationEnabled(): boolean` delegates to config. New/defaulted `callerVerificationEnabled(): boolean` reads `CALLER_VERIFICATION_ENABLED` at call time; absent→true, literal `'true'`→true, other values→false. Preserve explicit operator false. Activation is contingent on the prior tests and W01–W04 being merged.

- [ ] **Step 1: Write the flag and compose contract test.**

```ts
import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { callerVerificationEnabled } from './env';
afterEach(() => vi.unstubAllEnvs());
it.each([[undefined, true], ['true', true], ['false', false], ['', false], ['garbage', false]])(
  'readiness flag %s -> %s', (value, expected) => {
    vi.stubEnv('CALLER_VERIFICATION_ENABLED', value as string | undefined);
    expect(callerVerificationEnabled()).toBe(expected);
  });
it('maps the flag into both API compose environment anchors', () => {
  for (const file of ['../../../../docker-compose.yml', '../../../../deploy/docker-compose.prod.yml']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    expect(source).toContain('CALLER_VERIFICATION_ENABLED: ${CALLER_VERIFICATION_ENABLED:-true}');
  }
});
```

Replace W01's inherited `readiness.test.ts` matrix in the same task; leaving its unset→false assertion would contradict activation. Preserve its explicit-false and invalid-value coverage:

```ts
import { afterEach, expect, it, vi } from 'vitest';
import { callerVerificationEnabled } from '../../config/env';
afterEach(() => vi.unstubAllEnvs());
it.each([
  [undefined, true], ['', false], ['false', false], ['1', false],
  ['yes', false], ['TRUE', false], ['garbage', false], ['true', true],
] as const)('exact activated readiness value %s -> %s', (value, expected) => {
  vi.stubEnv('CALLER_VERIFICATION_ENABLED', value);
  expect(callerVerificationEnabled()).toBe(expected);
});
```

- [ ] **Step 2: Run:** `cd apps/api && npx vitest run src/config/env.callerVerification.test.ts src/services/callerVerification/readiness.test.ts` → missing true default/mapping.
- [ ] **Step 3: Implement the config default and docs.**

```ts
export function callerVerificationEnabled(): boolean {
  return (process.env.CALLER_VERIFICATION_ENABLED ?? 'true') === 'true';
}
// W01 gate.ts retains this public API:
export function isCallerVerificationEnabled(): boolean {
  return callerVerificationEnabled();
}
```

Set `.env.example` to `CALLER_VERIFICATION_ENABLED=true`. In each compose file's shared **API environment anchor**, add:

```yaml
CALLER_VERIFICATION_ENABLED: ${CALLER_VERIFICATION_ENABLED:-true}
```

Do not put it solely in an unrelated service or a comment: inspect the API service's anchor merge so server and worker roles inherit it. W04 web obtains readiness through its existing server-backed feature response; do not invent a separate build-time web flag.

Write this complete docs page:

```mdx
---
title: Caller verification
description: Verify a caller before resetting a Microsoft 365 password or disabling an account.
sidebar:
  order: 8
---

Breeze requires caller verification before Microsoft 365 password resets and account disables. A verification is usable once, for the named action and target, by the initiating technician. The default minimum assurance is tier 2 and the default freshness window is 30 minutes.

## Verify a caller

Open **Verify caller** on a ticket, contact or device. Confirm the requester, action and target. Choose an available method and explain the action shown on the challenge card. The caller selects the matching number; never ask them to read a code back.

A bound workstation response is tier 3. An unbound workstation or callback attestation is tier 1. SMS and email reach tier 2 only through an established destination. Imported or AI-written destinations require technician attestation. Email to any of the target account's mailbox addresses cannot verify a reset of that mailbox.

Number matching confirms the request; it does not prove the technician's identity or prevent a coached caller from being relayed. If uncertain, the caller should hang up and call the MSP on a number they already trust.

## Disable an account without contacting its owner

An org-level contact with an allowed authoriser role can verify a disable of another account. A site's primary contact has no automatic org-wide authority. For offboarding or containment, use **Administrative disable**, enter a reason of at least 20 characters and complete interactive MFA step-up. This option requires organization write permission and an effective policy that permits it. It cannot authorise password resets, and ordinary action approval still applies.

## Rejection and failures

**This is not me** fences the requester and relevant targets, opens a security incident, and cancels pending or approved actions. An action that already started dispatch appears in the incident for investigation; confirm in Entra whether the change landed. Expired challenges can still report a suspicious request within the rejection window.

A verification remains used when dispatch fails. Re-verify before creating another intent. A retry of the same intent does not consume a second grant, but an already-started dispatch must be reconciled rather than blindly repeated.

## Rollout

Install the updated agent and helper for workstation prompts. Older or non-console helpers report unavailable; timeout never counts as approval. Bind contacts to their Entra principals and attest imported destinations before relying on tier 2. Renaming a UPN does not change an intent's pinned account.

`CALLER_VERIFICATION_ENABLED` defaults to `true`. An explicit `false` hides entry points and refuses protected execution; it does not disable the safety gate while leaving mutations available. Self-hosted deployments must map this variable into the API service environment as well as setting it in `.env`. Deploy the OID-capable Graph actions executor before activating the API change.
```

Append to release notes:

```md
### Caller verification is now enforced for Microsoft 365 identity actions

Password resets and account disables require fresh, single-use verification for the pinned Entra account. Verification is checked at release and immediately before direct Graph, Graph executor or Delegant dispatch. Administrative disable uses an interactive MFA step-up bound to the target and reason. “This is not me” opens an incident and fences undispatched actions.

Upgrade agents/helpers for workstation verification, establish Entra bindings and attest imported contact destinations. Existing unpinned intents must be recreated. Roll the OID-capable Graph actions executor before the API. `CALLER_VERIFICATION_ENABLED` now defaults to `true`; set and map it in the API service environment. Explicit false hides the workflow and refuses protected actions. A failed dispatch does not restore a consumed verification.
```

W04 owns translated product copy. Verify its `callerVerification.json` keys in all eight locales and its `runAction` adoption; add no English-only fallback UI here. Docs remain in the docs site's existing language convention.

- [ ] **Step 4: Run:** `cd apps/api && npx vitest run src/config/env.callerVerification.test.ts src/services/callerVerification/readiness.test.ts src/config/envComposeParity.test.ts`; `cd apps/web && npx vitest run src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts`; `cd apps/docs && pnpm check && pnpm build` → pass. Check both false-hidden and true-visible W04 tests.
- [ ] **Step 5: Commit.**

```bash
ls apps/api/migrations | sort | tail -1
git add apps/api/src/config/env.ts apps/api/src/config/env.callerVerification.test.ts apps/api/src/services/callerVerification/readiness.test.ts apps/api/src/services/callerVerification/gate.ts .env.example docker-compose.yml deploy/docker-compose.prod.yml apps/docs/src/content/docs/security/caller-verification.mdx docs/release-notes/next-release-draft.md
git commit -m "feat(caller-verification): activate enforcement and document rollout"
```

### Task 15: Wave verification and reviewable PR

**Files:** Modify `apps/api/src/__tests__/integration/callerVerificationEnforcement.integration.test.ts` (Task 13 output); modify W01-owned `apps/api/src/services/callerVerification/gate.ts` only if the negative control exposes a regression. This task consumes the completed implementation and produces test evidence and one open PR.

**Interfaces:** All public cross-wave signatures and routes above remain unchanged. Read-only readiness evidence must prove W01–W04 dependency completion, zero bypass paths and passing CI. No deployment, merge or issue closure is performed by the executor.

- [ ] **Step 1: Write the final negative control before final verification.** Append to the live enforcement suite, using Task 13's executing fixture:

```ts
it('explicit flag-off refuses a real pinned intent without a dispatch marker', async () => {
  await run(() => requireCallerVerification(gateInput()));
  vi.stubEnv('CALLER_VERIFICATION_ENABLED', 'false');
  await expect(run(() => prepareCallerDispatch(dispatchInput())))
    .rejects.toMatchObject({ payload: { reason: 'feature_disabled' } });
  const [intent] = await run(() => db.select().from(actionIntents).where(eq(actionIntents.id, f.intent.id)));
  expect(intent!.dispatchStartedAt).toBeNull();
});
```

- [ ] **Step 2: Run:** `pnpm test-stack up`, then `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/callerVerificationEnforcement.integration.test.ts`. This regression may already pass after Task 14. Prove its negative control by temporarily bypassing only the flag refusal locally: it must fail with a resolved dispatch/marker instead of `feature_disabled`; immediately restore the guard before continuing. The restored guard is:

```ts
if (!isCallerVerificationEnabled()) throw new CallerVerificationRequiredError({
  orgId: input.orgId, contactId: null, action: input.action,
  requiredTier: 2, reason: 'feature_disabled', latest: null,
});
```

Place it before policy/grant success. The flag is not allowed to bypass dispatch's existing intent/tenant checks. Re-run to pass.
- [ ] **Step 3: Run typechecks and targeted suites.** From repository root run each scoped command separately:

```bash
cd apps/api && npx tsc --noEmit
cd apps/web && pnpm typecheck
cd packages/shared && npx tsc --noEmit
cd apps/m365-graph-actions-executor && npx tsc --noEmit
cd apps/api && npx vitest run src/services/callerVerification src/services/actionIntents src/services/m365DirectGraph.test.ts src/services/m365ControlPlane/writeActionService.test.ts src/services/aiToolsM365.test.ts src/services/m365ToolsHeadless.test.ts src/services/mfaStepUpGrant.test.ts src/services/aiAgentSdk.test.ts src/services/aiAgentSdkTools.m365gating.test.ts src/jobs/intentReleaseWorker.test.ts src/jobs/intentOutboxPublisher.test.ts src/routes/auth.test.ts src/routes/auth/schemas.test.ts src/routes/callerVerification.test.ts src/routes/helper/index.test.ts src/routes/mcpServer.test.ts src/db/callerTargetColumns.test.ts src/config/env.callerVerification.test.ts
cd packages/shared && npx vitest run src/m365/writeActions.test.ts
cd apps/m365-graph-actions-executor && npx vitest run src/microsoft/writeActions.test.ts
cd apps/web && npx vitest run src/components/callerVerification src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts
```

- [ ] **Step 4: Run distinct DB contract suites and the live enforcement suite.** Start the worktree stack if not already running. Never run these concurrently against the same DB (integration setup truncates fixtures).

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/callerVerificationEnforcement.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts src/__tests__/integration/actionIntentsImmutabilityTrigger.integration.test.ts src/services/mfaStepUpGrant.integration.test.ts
cd apps/api && npx vitest run --config vitest.config.rls-coverage.ts src/__tests__/integration/rls-coverage.integration.test.ts
cd apps/api && npx vitest run --config vitest.config.integration-suite-coverage.ts
cd apps/api && pnpm db:check-drift
```

Run W01's caller-verification RLS/merge/deletion suites through their merged integration filenames as well; enumerate them with `rg --files apps/api/src | rg 'caller.*integration.test.ts'` and verify each appears in the runner's reported files. The index does not name these dependency-owned test files, so do not invent them in this plan. Every named suite must report a non-zero count.

- [ ] **Step 5: Finish release qualification.** Run `cd apps/api && npx vitest run`, `pnpm lint`, `cd apps/docs && pnpm check`, and `cd apps/docs && pnpm build`. Smoke W02 workstation verification on the available Windows/macOS lab rigs, W03 link verification, W04 administrative flow, and “not me” before/after dispatch; record actual results in the PR. An unavailable required rig is incomplete release evidence, not a fabricated pass. The agent package check is `cd agent && go test -race ./internal/heartbeat/...`.
- [ ] **Step 6: Commit final verified changes, open the PR, and tear down.** The implementation branch must already be `feature/<parent#>-caller-verification/wave-<sub#>`. Use the assigned numerical issue IDs in PR metadata; the angle-bracket notation describes the naming contract, not literal CLI input. Prepare the PR body from the exact completed test record, including `Closes #<sub#>`, spec link, four new included export columns, no FK on snapshots, both-lock dispatch boundary, session-family eligibility and executor-first rollout. Use `gh pr create --base main --title "feat(caller-verification): enforce verified M365 identity actions" --body-file /tmp/caller-verification-w05-pr.md` after writing that concrete body. Stop with the PR open for review.

```bash
ls apps/api/migrations | sort | tail -1
scripts/check-migration-naming.sh --against-ref origin/main
git add apps/api/src/__tests__/integration/callerVerificationEnforcement.integration.test.ts
git commit -m "test(caller-verification): verify activation fails closed"
git diff --check
git push -u origin HEAD
pnpm test-stack down
```

Review the PR once with independent security review focused on identity/tenant pinning, locks and typed refusals; fix confirmed findings. Do not use admin merge bypass. Nothing in this plan authorises production changes.

## Self-review

**Spec coverage.** D11/D14 pinning and route stability → Tasks 1–3, 6–8; D5 creation/release/three-backend enforcement → Tasks 3–8; D13 post-claim single-use semantics, real outbound failure with retained consumption/marker and refusal of another intent → Tasks 4–5, 12–13; tier-zero policy order with bindingless target → Tasks 5, 13; W03 email-reader context and successful email dispatch → Tasks 5, 13; D8 rejection, honest dispatch classification, system revocation and incident terminal linkage → Tasks 9, 13; D15 interactive administrative operation/digest, session family, epochs, preserved contact attempt cap before proof consumption, technician audit attribution and requester/target authorisation → Tasks 10–11, 13; refusal adapters → Task 12; consumed-intent status projection for W04’s translated failure/re-verification UI → Tasks 12–13; D16 activation, inherited readiness test, compose mapping, docs and release note → Tasks 14–15. W01 policy, provenance, composite FKs, cascade/export/merge and W02/W03 delivery remain dependency contracts, explicitly rerun at wave verification.

**Verified repository corrections.** The session backend union currently lacks control-plane; the headless worker owns that route. Session-aware SDK drops the existing `actionIntentId`. Direct token cache omits tenant. Control-plane strict action schema needs OID support before the executor receives it. Release actor synthesises MFA at current line 292; step-up SID names a refresh family, not a legacy session. Cancel's public permission check is unsuitable; its operation-first CAS/outbox helpers are reusable. No incident append service exists. RLS coverage is excluded by the general integration runner. The real `intentReleaseWorkerM365Headless.integration.test.ts` supplies the outbound-client/configuration pattern, and `mfaStepUpGrant.ts` supplies a non-consuming proof validator for the cap regression. W03’s `withMailboxReader` and W01’s `projectVerification` are verified plan outputs, not pre-existing checkout modules. These are addressed explicitly rather than copied from stale spec line hints.

**Type consistency.** Cross-wave gate, actor, service, error and revocation signatures are retained; only W05-private helpers, optional existing execution context plumbing and the additive HTTP `consumedIntentStatus` field are added; the index `VerificationView` stays unchanged. The refusal field is always `requiresCallerVerification`, the release code always `caller_verification_required`, the administrative operation always `caller_verification_administrative_disable`. No token, principal or epoch comes from a tool argument or administrative request body.

**Execution completeness.** Run every red/green task against merged dependencies; update source anchors when prior waves move them. The document does not claim product tests were run while writing it. Security success requires behavioural client assertions and real DB races in addition to source contracts. Default activation is the last implementation change, and the last task ends at a reviewable PR.
