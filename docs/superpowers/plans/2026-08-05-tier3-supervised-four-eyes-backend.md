# Tier-3 Supervised/Four-Eyes Split — Backend Core Implementation Plan (Plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split Tier-3 AI approvals into `supervised` (requester approves with a plain click) and `four_eyes` (second human), fix the confirmed intent-layer defects (non-atomic decide, users.status filter, single-deadline expiry, content TOCTOU), and expose a transport-neutral approvals API ready for the web inbox (Plan 2).

**Spec:** `docs/superpowers/specs/ai-mcp/2026-08-05-tier3-supervised-four-eyes-split-design.md` — read it first; §2–§4 are this plan.

**Architecture:** `checkGuardrails` gains an `approvalScope` field driven by explicit classification tables with an exhaustiveness contract test. `intentService` persists the scope, fans out a single requester-owned row for supervised, filters approvers by `users.status`, and splits expiry into `approval_expires_at` + `release_by`. The decide route gets a supervised plain-decide branch and becomes atomic. Four-eyes intents pin an effect digest revalidated at release.

**Tech Stack:** Hono, Drizzle, Postgres (hand-written SQL migrations), Vitest (unit + integration configs), BullMQ.

## Global Constraints

- Migrations: `YYYY-MM-DD-<slug>.sql`, idempotent (`IF NOT EXISTS` / `DO $$`), NO inner `BEGIN;`/`COMMIT;`, never edit a shipped migration. Same-day dependents use `-a-`/`-b-` infixes.
- `action_intents` has `org_id` → it is in `CORE_ORG_CASCADE_DELETE_ORDER`, so **every new column MUST be classified in `CORE_TENANT_EXPORT_POLICY`** (`services/tenantExportPolicyRegistry.ts`) in the same PR.
- `pnpm --filter @breeze/api test` does NOT run the RLS/integration contract suites; run `vitest.integration.config.ts` + `vitest.config.rls.ts` explicitly before PR (needs local Postgres; see `integration_suite_needs_fsync_off_tmpfs_locally`).
- Tier 4 keeps its existing meaning (blocked). Do not renumber anything.
- MCP behavior unchanged: effective tier 3 (both scopes) → `MCP_APPROVAL_REQUIRED`.
- All new i18n-visible strings are Plan 3; this plan is API-only.
- Commit after every green task; messages end with the standard co-author trailer.

---

### Task 1: Guardrails classification tables + `approvalScope`

**Files:**
- Modify: `apps/api/src/services/aiGuardrails.ts` (tables near `TIER3_ACTIONS` ~line 165; `GuardrailCheck` + `checkGuardrails` ~lines 858–955)
- Test: `apps/api/src/services/aiGuardrails.approvalScope.contract.test.ts` (new)

**Interfaces:**
- Produces: `GuardrailCheck.approvalScope?: 'supervised' | 'four_eyes'` (set whenever `tier === 3`); exported `TIER3_FOUR_EYES_ACTIONS: Record<string, string[]>`, `TIER3_FOUR_EYES_TOOLS: Set<string>`, `TIER3_SUPERVISED_ACTIONS: Record<string, string[]>`, `TIER3_SUPERVISED_TOOLS: Set<string>`, and `resolveApprovalScope(toolName: string, action: string | undefined): 'supervised' | 'four_eyes'`.

- [ ] **Step 1: Write the failing contract test.** Model it on `aiGuardrails.readonly.contract.test.ts`. Assertions:

```ts
import { describe, it, expect } from 'vitest';
import {
  TIER3_ACTIONS, TIER3_FOUR_EYES_ACTIONS, TIER3_FOUR_EYES_TOOLS,
  TIER3_SUPERVISED_ACTIONS, TIER3_SUPERVISED_TOOLS,
  checkGuardrails, resolveApprovalScope,
} from '../aiGuardrails';
import { getToolTier, getAllRegisteredToolNames } from '../aiTools';

describe('tier-3 approval scope classification', () => {
  it('classifies every per-action tier-3 pair in exactly one scope', () => {
    for (const [tool, actions] of Object.entries(TIER3_ACTIONS)) {
      for (const action of actions) {
        const inFourEyes = TIER3_FOUR_EYES_ACTIONS[tool]?.includes(action) ?? false;
        const inSupervised = TIER3_SUPERVISED_ACTIONS[tool]?.includes(action) ?? false;
        expect(inFourEyes !== inSupervised, `${tool}:${action} must be in exactly one scope table`).toBe(true);
      }
    }
  });

  it('classifies every base-tier-3 tool in exactly one whole-tool scope set', () => {
    for (const tool of getAllRegisteredToolNames()) {
      if (getToolTier(tool) !== 3) continue;
      const inFourEyes = TIER3_FOUR_EYES_TOOLS.has(tool);
      const inSupervised = TIER3_SUPERVISED_TOOLS.has(tool);
      expect(inFourEyes !== inSupervised, `${tool} must be in exactly one whole-tool scope set`).toBe(true);
    }
  });

  it('scope tables reference only real tier-3 surfaces', () => {
    for (const [tool, actions] of Object.entries(TIER3_FOUR_EYES_ACTIONS)) {
      for (const a of actions) expect(TIER3_ACTIONS[tool] ?? []).toContain(a);
    }
    for (const tool of TIER3_FOUR_EYES_TOOLS) expect(getToolTier(tool)).toBe(3);
  });

  it('defaults unclassified to four_eyes (fail-safe)', () => {
    expect(resolveApprovalScope('some_future_unclassified_tool', undefined)).toBe('four_eyes');
  });

  it('s1_isolate_device is whole-tool four-eyes-exempt via supervised set', () => {
    // boolean `isolate` discriminator — cannot be action-classified (spec §3.1)
    expect(TIER3_SUPERVISED_TOOLS.has('s1_isolate_device')).toBe(true);
  });

  it('checkGuardrails surfaces the scope on tier-3 results', () => {
    const fourEyes = checkGuardrails('manage_invoices', { action: 'issue' });
    expect(fourEyes.tier).toBe(3);
    expect(fourEyes.approvalScope).toBe('four_eyes');
    const supervised = checkGuardrails('manage_services', { action: 'restart' });
    expect(supervised.tier).toBe(3);
    expect(supervised.approvalScope).toBe('supervised');
    const tier2 = checkGuardrails('manage_patches', { action: 'approve' });
    expect(tier2.approvalScope).toBeUndefined();
  });
});
```

If `getAllRegisteredToolNames` does not exist in `aiTools.ts`, add it in this task: `export function getAllRegisteredToolNames(): string[]` returning the registry's tool-name keys (the same map `getToolTier` reads).

- [ ] **Step 2: Run it — must fail** (`pnpm --filter @breeze/api test -- aiGuardrails.approvalScope`), with "TIER3_FOUR_EYES_ACTIONS is not exported".

- [ ] **Step 3: Implement.** In `aiGuardrails.ts`, next to `TIER3_ACTIONS`:

```ts
// Spec 2026-08-05 §3: within tier 3, `four_eyes` requires a SECOND human
// (approvals:decide holder other than the requester); everything else is
// `supervised` — the requesting human approves their own AI action with a
// plain click, gated on their existing RBAC. Unclassified tier-3 surfaces
// resolve four_eyes (fail-safe); the contract test forbids relying on that.
export const TIER3_FOUR_EYES_ACTIONS: Record<string, string[]> = {
  manage_invoices: ['issue', 'record_payment', 'void_payment'],
  manage_contracts: ['activate', 'cancel'],
  manage_quotes: ['send'],
  manage_organizations: ['create_org', 'update_org'], // update_org: status-split is Task 9
  manage_tickets: ['move_org'],
  manage_hyperv_checkpoints: ['delete', 'apply'],
  manage_patches: ['rollback'],
};
export const TIER3_FOUR_EYES_TOOLS = new Set<string>([
  // populated from the registry sweep in Step 4: restore/DR executors,
  // M365/Google identity mutators, computer-control/unattended-remote,
  // S1 unisolate/threat-rollback multiplexer entries that are whole-tool.
]);
export const TIER3_SUPERVISED_ACTIONS: Record<string, string[]> = {
  // complement of TIER3_FOUR_EYES_ACTIONS within TIER3_ACTIONS — spelled
  // out explicitly; the contract test enforces exact-one membership.
  file_operations: ['read', 'write', 'delete', 'mkdir', 'rename'],
  manage_services: ['start', 'stop', 'restart'],
  security_scan: ['quarantine', 'remove', 'restore'],
  // ... every remaining TIER3_ACTIONS pair
};
export const TIER3_SUPERVISED_TOOLS = new Set<string>([
  'execute_command', 'run_script', 's1_isolate_device',
  // ... every remaining base-tier-3 tool
]);

export function resolveApprovalScope(
  toolName: string,
  action: string | undefined,
): 'supervised' | 'four_eyes' {
  if (action && TIER3_FOUR_EYES_ACTIONS[toolName]?.includes(action)) return 'four_eyes';
  if (action && TIER3_SUPERVISED_ACTIONS[toolName]?.includes(action)) return 'supervised';
  if (TIER3_FOUR_EYES_TOOLS.has(toolName)) return 'four_eyes';
  if (TIER3_SUPERVISED_TOOLS.has(toolName)) return 'supervised';
  return 'four_eyes'; // fail-safe; contract test keeps this unreachable for real tools
}
```

Add `approvalScope?: 'supervised' | 'four_eyes'` to `GuardrailCheck`, and set `approvalScope: resolveApprovalScope(toolName, action)` in both tier-3 return branches of `checkGuardrails` (the `TIER3_ACTIONS` escalation return and the `baseTier >= 3` return — only when the effective tier is exactly 3, NOT for blocked tier 4).

- [ ] **Step 4: Registry sweep to fill the supervised/four-eyes sets.** Run the contract test; it fails once per unclassified surface. Classify each per spec §3.2 (identity/restore/containment-release/computer-control → four_eyes; device work → supervised). Sweep `aiToolsM365.ts` / `aiToolsGoogle.ts` action lists for password/2SV reset, forwarding, delegates, offboarding, wipe → those actions go in `TIER3_FOUR_EYES_ACTIONS` under their tool names; S1 unisolate/rollback likewise. Iterate until the contract test passes with zero unclassified surfaces.

- [ ] **Step 5: Run the full guardrails test file set** (`pnpm --filter @breeze/api test -- aiGuardrails`) — all green, including the pre-existing readonly contract test.

- [ ] **Step 6: Commit** (`feat(ai): classify tier-3 tools into supervised vs four-eyes approval scopes`).

---

### Task 2: Migration + Drizzle schema for scope, deadlines, digest

**Files:**
- Create: `apps/api/migrations/2026-08-05-intent-approval-scope-and-deadlines.sql`
- Modify: `apps/api/src/db/schema/actionIntents.ts`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts`

**Interfaces:**
- Produces columns on `action_intents`: `approval_scope text NOT NULL DEFAULT 'four_eyes'` (CHECK `IN ('supervised','four_eyes')`), `classification_version integer NOT NULL DEFAULT 0`, `approval_expires_at timestamptz` (backfilled from `expires_at`), `release_by timestamptz`, `effect_digest char(64)`. Drizzle fields: `approvalScope`, `classificationVersion`, `approvalExpiresAt`, `releaseBy`, `effectDigest`.

- [ ] **Step 1: Write the migration** (idempotent, no inner transaction):

```sql
-- Spec 2026-08-05 tier3-supervised-four-eyes-split §4.1.
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS approval_scope text NOT NULL DEFAULT 'four_eyes';
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS classification_version integer NOT NULL DEFAULT 0;
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS approval_expires_at timestamptz;
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS release_by timestamptz;
ALTER TABLE action_intents ADD COLUMN IF NOT EXISTS effect_digest char(64);

DO $$ BEGIN
  ALTER TABLE action_intents ADD CONSTRAINT action_intents_approval_scope_chk
    CHECK (approval_scope IN ('supervised','four_eyes'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Backfill: pre-split rows are legacy four-eyes (spec §9.1); their approval
-- deadline is the old single deadline.
UPDATE action_intents SET approval_expires_at = expires_at
  WHERE approval_expires_at IS NULL;
```

Note: `approval_scope`/`classification_version` land on rows via the DEFAULTs — matching the backfill rule (legacy = `four_eyes`/v0). The immutability trigger (`action_intents_immutable_trg`) must not block `release_by` stamping: check the trigger's column list in `2026-07-18-action-intents.sql` — if it blocks all UPDATEs outside status transitions, extend its allowlist in THIS migration (`DROP TRIGGER IF EXISTS` + recreate with `release_by`, `approval_expires_at` writable). Do not edit the shipped 07-18 file.

- [ ] **Step 2: Update Drizzle schema** — add the five fields to `actionIntents` in `actionIntents.ts` with `.$type<'supervised' | 'four_eyes'>()` on `approvalScope` (text + CHECK pattern already documented in that file's header).

- [ ] **Step 3: Export-policy registration.** In `tenantExportPolicyRegistry.ts`, find the `action_intents` `tablePolicy` entry and add all five columns to `included` (identifiers/timestamps/digest — no secrets, no open containers).

- [ ] **Step 4: Apply + verify.** `export DATABASE_URL=postgresql://breeze:breeze@localhost:5432/breeze && pnpm db:migrate && pnpm db:check-drift` — drift check green. Re-run `pnpm db:migrate` — re-application is a no-op.

- [ ] **Step 5: Run the export-policy + cascade integration suites** (`pnpm --filter @breeze/api exec vitest run -c vitest.integration.config.ts tenant-export-policy tenantCascade`) — green.

- [ ] **Step 6: Commit** (`feat(ai): action_intents approval scope, split deadlines, effect digest columns`).

---

### Task 3: Approver resolver filters `users.status`

**Files:**
- Modify: `apps/api/src/services/actionIntents/intentApprovers.ts` (org-member query ~line 78, partner-axis query below it)
- Test: `apps/api/src/services/actionIntents/intentApprovers.test.ts` (extend; follow its existing Drizzle-mock pattern — see `breeze-testing` skill)

**Interfaces:**
- Consumes/produces: `resolveIntentApprovers(orgId)` signature unchanged; result now excludes users whose `users.status !== 'active'`.

- [ ] **Step 1: Failing test.** In the existing test file, add a case seeding an org with one active admin and one `disabled` admin (mirror the file's existing seed/mock helpers) asserting the disabled user is absent from the result. Also assert the sole-operator implication: with requester active + only disabled others, `resolveIntentApprovers` returns only the requester.
- [ ] **Step 2: Run — fails** (disabled user present).
- [ ] **Step 3: Implement.** Both candidate queries (org members, partner-axis members) gain an `innerJoin(users, eq(users.id, <membership>.userId))` + `eq(users.status, 'active')` condition. Check `users.ts:15` for the exact status union before writing the literal.
- [ ] **Step 4: Run intentApprovers tests — green.**
- [ ] **Step 5: Commit** (`fix(ai): exclude non-active users from intent approver fan-out`).

---

### Task 4: `intentService` — scope-aware creation, fan-out, deadlines

**Files:**
- Modify: `apps/api/src/services/actionIntents/intentService.ts` (tier gate ~215, `computeExpiresAt` ~175, fan-out branch ~408–470, push loop ~495–512)
- Test: `apps/api/src/services/actionIntents/intentService.test.ts` (extend)

**Interfaces:**
- Consumes: `guardrail.approvalScope` (Task 1), new columns (Task 2), filtered approvers (Task 3).
- Produces: `createIntent(input)` persists `approvalScope`, `classificationVersion: 1`, `approvalExpiresAt`; supervised → exactly one approval row for the requester, `requesterApprovalRequestId` set, `fanOutUserIds: [requesterId]`, **no push**; four_eyes → existing behavior + 60-min chat approval deadline. Constant `CLASSIFICATION_VERSION = 1` exported.

- [ ] **Step 1: Failing tests** (extend the file's existing harness):

```ts
it('supervised intent fans out a single requester-owned row and skips push', async () => {
  const snap = await createIntentWith({ approvalScope: 'supervised' }); // use file's builder
  expect(snap.requesterApprovalRequestId).toBeDefined();
  expect(snap.fanOutUserIds).toEqual([REQUESTER_ID]);
  expect(pushSpy).not.toHaveBeenCalled();
});

it('four_eyes chat intent gets a 60-minute approval deadline; supervised keeps 5', async () => {
  const fe = await createIntentWith({ approvalScope: 'four_eyes', source: 'chat' });
  const sv = await createIntentWith({ approvalScope: 'supervised', source: 'chat' });
  expect(msUntil(fe.approvalExpiresAt)).toBeCloseTo(60 * 60 * 1000, -4);
  expect(msUntil(sv.approvalExpiresAt)).toBeCloseTo(5 * 60 * 1000, -4);
});

it('four_eyes with no other active approver keeps sole-operator fallback', async () => { /* existing sole-operator asserts, now under scope four_eyes */ });
```

- [ ] **Step 2: Run — fails.**
- [ ] **Step 3: Implement.**
  - `computeExpiresAt(source, approvalScope)`: chat+supervised → 5 min; chat+four_eyes → 60 min (`FOUR_EYES_CHAT_EXPIRY_MS = 60 * 60 * 1000`); mcp_api → 24 h unchanged. Write to `approvalExpiresAt`; keep legacy `expiresAt` written with the same value for rolling-upgrade compat (old reaper reads it) — note removal as Plan 3 cleanup.
  - Creation values: `approvalScope: input.guardrail.approvalScope ?? 'four_eyes'`, `classificationVersion: CLASSIFICATION_VERSION`.
  - Fan-out: `if (approvalScope === 'supervised')` short-circuit before the eligible-approver branch — insert one row via the existing `approvalRowFor(requesterId)`, set `requesterApprovalRequestId`, skip the push loop (`if (creation.intent.approvalScope === 'four_eyes')` guard around the push block). Four-eyes path unchanged.
- [ ] **Step 4: Run intentService tests — green.**
- [ ] **Step 5: Commit** (`feat(ai): scope-aware intent creation — supervised self fan-out, split deadlines`).

---

### Task 5: Reaper + release worker honor the deadline split

**Files:**
- Modify: `apps/api/src/jobs/intentExpiryReaper.ts` (~lines 121–185)
- Modify: `apps/api/src/jobs/intentReleaseWorker.ts` (claim CAS ~242–257)
- Modify: `apps/api/src/routes/approvals.ts` (fan-in block ~846–940: stamp `release_by` on approval win)
- Test: `apps/api/src/jobs/intentExpiryReaper.test.ts`, `apps/api/src/jobs/intentReleaseWorker.test.ts` (extend)

**Interfaces:**
- Produces: `RELEASE_LEASE_MS = 10 * 60 * 1000` (exported from `intentService.ts`). Pending intents expire on `approval_expires_at`; approved intents expire on `release_by`; the approve fan-in stamps `release_by = now() + RELEASE_LEASE_MS` in the same CAS that flips the intent to `approved`.

- [ ] **Step 1: Failing tests.**
  - Reaper: an intent `pending_approval` past `approvalExpiresAt` → expired; an intent `approved` with `releaseBy` in the future but `approvalExpiresAt` in the past → **NOT** expired (this is the 59:59 trap); `approved` past `releaseBy` → expired.
  - Worker: claim CAS succeeds when `releaseBy` future even if `approvalExpiresAt` past; refuses past `releaseBy`.
- [ ] **Step 2: Run — fails.**
- [ ] **Step 3: Implement.** Reaper `where` clauses split by status: `pending_approval AND approval_expires_at < now()` vs `approved AND release_by < now()` (fall back to `expires_at` when `release_by IS NULL` — legacy rows). Worker `requireNotExpired` check compares `release_by ?? expires_at`. Approve fan-in (Task 6 makes it atomic; here just add the field): the intent-transition UPDATE gains `releaseBy: new Date(Date.now() + RELEASE_LEASE_MS)`.
- [ ] **Step 4: Run both job test files — green.**
- [ ] **Step 5: Commit** (`fix(ai): split intent expiry into approval deadline + release lease`).

---

### Task 6: Atomic decide + supervised plain-decide branch

**Files:**
- Modify: `apps/api/src/routes/approvals.ts` (assurance gate ~657–680, decision write ~681–860, fan-in ~846–940, report-suspicious ~274–440)
- Test: `apps/api/src/routes/approvalsDecideAtomicity.integration.test.ts` (update expectations), `apps/api/src/routes/approvals.test.ts` (extend)

**Interfaces:**
- Consumes: intent columns (Task 2), `RELEASE_LEASE_MS` (Task 5).
- Produces: `POST /:id/approve` accepts a supervised requester decide with **no WebAuthn assertion**; all decide writes (approval-row CAS, intent transition + `release_by`, sibling expiry, outbox insert, audit projection) run in ONE `db.transaction`; HTTP 200 only after the intent transition commits. Error codes unchanged (`digest_mismatch`, `not_sole_approver`, 409/410 semantics).

- [ ] **Step 1: Failing unit tests** (`approvals.test.ts`, existing mock harness):

```ts
it('supervised requester approves with no assertion', async () => {
  // row: approval_scope=supervised, approval owned by requester
  const res = await app.request(`/approvals/${rowId}/approve`, { method: 'POST', headers: authFor(REQUESTER), body: '{}' });
  expect(res.status).toBe(200);
});
it('supervised row rejects a NON-requester decide even with approvals:decide', async () => {
  const res = await app.request(`/approvals/${rowId}/approve`, { method: 'POST', headers: authFor(OTHER_ADMIN), body: '{}' });
  expect(res.status).toBe(403);
});
it('four_eyes rows keep the assurance gate', async () => { /* existing assertions unchanged, re-labeled */ });
it('supervised approve re-checks live RBAC for the underlying tool action', async () => {
  // revoke devices:execute from requester between create and decide → 403
});
```

- [ ] **Step 2: Failing integration test.** In `approvalsDecideAtomicity.integration.test.ts` (~line 269), invert the current expectation: inject the fan-in fault and assert the endpoint now returns **500** AND the approval row is still `pending` (rolled back) AND a retry succeeds. Delete the "200 with pending intent" assertion.
- [ ] **Step 3: Implement.**
  - **Branch order** in the approve handler: (1) load row + linked intent; (2) if `intent.approvalScope === 'supervised'`: require `intent.requestedByUserId === userId` (else 403 `not_requester`), require live RBAC via the same `TOOL_PERMISSIONS` check used at execution (import `checkToolPermission` or its equivalent from the guardrails/permissions module), skip the assertion/assurance ladder entirely; (3) else: existing four-eyes/sole-operator logic untouched.
  - **Atomicity**: wrap the approval-row CAS → intent CAS (+ `release_by`) → sibling-expiry → outbox insert → `ai_tool_executions` mirror → audit insert in one `db.transaction(async (tx) => ...)`, threading `tx` through the helpers that currently take `db`. The current post-commit push dispatch stays OUTSIDE the transaction (#1105 — never hold a txn across network I/O). On any throw: transaction rolls back, respond 500 with a retryable error body. Apply the same wrap to `report-suspicious`'s intent-rejection block (~:288–320).
  - Audit `approvalMethod`: supervised decides record `'supervised_self'` (extend the `AiApprovalMethod` union in `aiAgentSdk.ts` ~line 225).
- [ ] **Step 4: Run** `approvals.test.ts` (unit) — green. Run the atomicity integration test against local Postgres — green.
- [ ] **Step 5: Commit** (`feat(ai): supervised plain-decide branch + atomic decide transaction`).

---

### Task 7: Effect-digest pinning for four-eyes intents

**Files:**
- Create: `apps/api/src/services/actionIntents/effectDigest.ts`
- Modify: `apps/api/src/services/actionIntents/intentService.ts` (creation), `apps/api/src/jobs/intentReleaseWorker.ts` (revalidation ~300–330)
- Test: `apps/api/src/services/actionIntents/effectDigest.test.ts` (new), `apps/api/src/jobs/intentReleaseWorker.test.ts` (extend)

**Interfaces:**
- Produces: `computeEffectDigest(toolName, args, dbContext): Promise<string | null>` — SHA-256 hex over tool-specific materialized content; `null` = tool has no pinnable effect (digest check skipped). Resolvers (v1): `run_script` → script body hash (`scripts.content` by `scriptId`); `manage_quotes:send` → quote `updated_at` + line-item hash; `manage_invoices:issue|record_payment|void_payment` → invoice `updated_at`; `manage_contracts:activate|cancel` → contract `updated_at`; `manage_organizations:update_org` → current org `status`. Everything else → `null`.
- Worker failure mode: recomputed digest ≠ stored `effect_digest` → intent `failed` with `errorCode: 'content_changed'` (never executes).

- [ ] **Step 1: Failing unit tests** for `computeEffectDigest`: same content → same digest; changed script body → different digest; unpinnable tool → `null`. Use the Drizzle mock pattern from `breeze-testing`.
- [ ] **Step 2: Failing worker test:** approved four-eyes `run_script` intent whose script content changed after creation → release fails `content_changed`, no execution, audit row records the code.
- [ ] **Step 3: Implement.** `effectDigest.ts` — a `Record<string, (args, tx) => Promise<string | Buffer | null>>` resolver map keyed `tool` or `tool:action`, hashed with `createHash('sha256')`. `createIntent`: when scope is `four_eyes`, compute inside the creation transaction and store `effectDigest`. Worker: after the existing digest/tier revalidation (~:310), recompute; mismatch → CAS to `failed`/`content_changed`. Supervised intents: skip (spec §4.1).
- [ ] **Step 4: Run both test files — green.**
- [ ] **Step 5: Commit** (`feat(ai): pin four-eyes intent effect digests; fail release on drift`).

---

### Task 8: `/pending` live authz, pagination, count, neutral mount

**Files:**
- Modify: `apps/api/src/routes/approvals.ts` (`GET /pending` ~46–85; new `GET /pending/count`)
- Modify: `apps/api/src/index.ts` (~1038: add `app.route('/api/v1/approvals', approvalRoutes)` alongside the existing `/api/v1/mobile/approvals` mount)
- Test: `apps/api/src/routes/approvals.test.ts` (extend)

**Interfaces:**
- Produces: `GET /pending?limit&cursor` — joins `action_intents`, returns only rows whose intent is `pending_approval` and (four_eyes: caller still holds `approvals:decide` + org access; supervised: caller is the requester); response `{ items, nextCursor }`, items capped at 50. `GET /pending/count` → `{ count }` (same filters, no arguments in payload). Both mounted at `/api/v1/approvals/*`; `/api/v1/mobile/approvals/*` alias preserved.

- [ ] **Step 1: Failing tests:** demoted approver (permission revoked after fan-out) gets `[]` and count 0; supervised requester sees own row; pagination cursor walks a 3-row seed with `limit=2`; count endpoint returns bare integer count; both paths reachable under `/api/v1/approvals`.
- [ ] **Step 2: Run — fails.**
- [ ] **Step 3: Implement.** Join + filters as above (permission re-check via the same helper `resolveIntentApprovers` uses — `PERMISSIONS.APPROVALS_DECIDE` through `hasPermission`); keyset pagination on `(createdAt, id)`; count via `count(*)` with identical predicates. Mount addition in `index.ts` is one line.
- [ ] **Step 4: Run route tests — green.**
- [ ] **Step 5: Commit** (`feat(api): live-authorized paginated approvals list + count; transport-neutral mount`).

---

### Task 9: Chat path wiring + `update_org` status split + durable-executable contract

**Files:**
- Modify: `apps/api/src/services/aiAgentSdk.ts` (intent branch ~900–1000: pass scope; supervised bridge; push guard ~1304–1320)
- Modify: `apps/api/src/services/aiToolsOrgs.ts` (~349: split `update_org`)
- Modify: `apps/api/src/services/aiGuardrails.ts` (dynamic escalation for `update_org` with `status` present)
- Test: `apps/api/src/services/aiAgentSdk.approvalWait.test.ts` (extend), `apps/api/src/services/aiGuardrails.approvalScope.contract.test.ts` (extend), new `apps/api/src/jobs/intentReleaseWorker.durable.contract.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: chat SSE approval payload gains `approvalScope` and (supervised) `selfApprovalRequestId` — the shape `AiApprovalDialog` already consumes for sole-operator, so the web card renders actionable buttons without Plan-2 work; plain decide is authorized server-side by Task 6. `update_org` with a `status` argument resolves `four_eyes`; without it, `supervised`. Contract test: every four-eyes-classified tool must NOT be `session_required` in the release worker.

- [ ] **Step 1: Failing tests.**
  - `aiAgentSdk`: supervised tier-3 call emits an approval event carrying `selfApprovalRequestId` + `approvalScope: 'supervised'`; **no push dispatched**; four_eyes still pushes.
  - Guardrails: `checkGuardrails('manage_organizations', { action: 'update_org', status: 'suspended' }).approvalScope === 'four_eyes'`; without `status` → `'supervised'`.
  - Durable contract: iterate `TIER3_FOUR_EYES_TOOLS` + tools in `TIER3_FOUR_EYES_ACTIONS` against the worker's `session_required` set (export it from `intentReleaseWorker.ts` if currently module-private) — assert empty intersection.
- [ ] **Step 2: Run — fails.**
- [ ] **Step 3: Implement.** In `resolveApprovalScope`, add an input-aware override hook: `if (toolName === 'manage_organizations' && action === 'update_org') return 'status' in input ? 'four_eyes' : 'supervised'` (pass `input` through from `checkGuardrails`; extend the signature to `resolveApprovalScope(toolName, action, input)`). In `aiAgentSdk.ts`: thread `guardrailCheck.approvalScope` into `createIntent`; include `selfApprovalRequestId: snapshot.requesterApprovalRequestId` and `approvalScope` in the approval event payload for supervised (mirror the existing sole-operator emission ~:964); wrap the push block in a four_eyes guard. Fix any durable-contract failures by either making the tool durably executable or (if genuinely session-bound) documenting a session-window carve-out in the contract test's explicit allowlist with a comment.
- [ ] **Step 4: Run the three test files — green.**
- [ ] **Step 5: Commit** (`feat(ai): supervised chat bridge, update_org status escalation, durable four-eyes contract`).

---

### Task 10: Integration pass + full verification

**Files:**
- Create: `apps/api/src/__tests__/integration/intentSupervisedFourEyes.integration.test.ts`

- [ ] **Step 1: Write the end-to-end integration test** (real Postgres; follow `intentReleaseWorker*.integration.test.ts` setup): seed two active admins + one requester-technician. Assert: (a) supervised intent → single requester row → plain-click approve API → release worker executes; (b) four_eyes intent → rows for both admins, none for requester → approve at t+30 min (past old 5-min window, mock clock or shrink constants via injection) → executes within lease; (c) disabled second admin → sole-operator fallback engages; (d) fan-in fault injection → rollback (no spent approval row).
- [ ] **Step 2: Run it + the RLS suite** (`vitest -c vitest.integration.config.ts intentSupervisedFourEyes`, then `vitest -c vitest.config.rls.ts`) — green.
- [ ] **Step 3: Full local verification:** `pnpm --filter @breeze/api test`, `pnpm db:check-drift`, then the two contract suites again if any tenancy file changed since Task 2.
- [ ] **Step 4: Commit** (`test(ai): supervised/four-eyes end-to-end integration coverage`).
- [ ] **Step 5: Open the PR** (`feat(ai): tier-3 supervised/four-eyes approval split — backend core`). PR body: link the spec; call out the `users.status` fan-out fix, the decide-atomicity behavior change (500 on fan-in fault, was 200), the audit `approvalMethod: 'supervised_self'` addition (SIEM shape), and that the web inbox lands in Plan 2. Dispatch CI per branch if stacked (`gh workflow run CI --ref <branch>`).

---

## Self-Review Notes

- Spec coverage: §2 (Task 1, 6, 9), §3 (Task 1, 9), §4.1 (Tasks 2–5, 7), §4.2 (Tasks 6, 8), §8 backend rows (Tasks 1–10). §5–§7 are Plans 2–3 by design.
- Legacy `expires_at` dual-write (Task 4) keeps old reapers correct during rolling upgrade; removal is noted for Plan 3.
- Type names consistent: `approvalScope`/`approval_scope`, `approvalExpiresAt`, `releaseBy`, `effectDigest`, `resolveApprovalScope(toolName, action, input)`, `CLASSIFICATION_VERSION`, `RELEASE_LEASE_MS` — used identically across Tasks 1–9.
