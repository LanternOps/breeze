# Action Intents Core (Plan 1 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Durable, digest-bound `action_intents` + transactional outbox + approver fan-out through `approval_requests`, with the chat SDK's Tier-3 flow rebuilt on top — purely additive, no external behavior break.

**Architecture:** New org-scoped immutable-content `action_intents` table and system-scoped `intent_outbox` written atomically; approvals fan out one row per eligible approver via the existing `approval_requests` machinery (PAM-bridge pattern); a BullMQ outbox publisher and a release worker with pre-execution revalidation; `aiAgentSdk.ts` T3 becomes intent-backed with an inline fast path.

**Tech Stack:** Drizzle, hand-written SQL migration, BullMQ, node:crypto, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-18-action-intents-approval-layer-design.md` — the requirements source; read it before any task.

## Global Constraints

- Migration `2026-07-18-action-intents.sql`: idempotent, no inner BEGIN/COMMIT, RLS enabled+forced+policy in the SAME migration, `action_intents` added to `CORE_ORG_CASCADE_DELETE_ORDER` (alphabetical, FK-children-first) AND the RLS coverage allowlist in the same PR. `intent_outbox` is INTENTIONAL_UNSCOPED (system workers only, like `device_commands`) — document it as such in the RLS coverage test.
- Immutable content columns are UPDATE-blocked by trigger; lifecycle columns are the only mutable ones.
- Every state transition is a CAS: `UPDATE … WHERE id = $1 AND status = $expected`; zero rows = lost race, never an error.
- Expiry constants: `chat` 5 minutes, `mcp_api` 24 hours. Budget/expiry values are constants, not env vars.
- BullMQ jobIds use hyphens, never colons: `intent-created-<uuid>`, `intent-approved-<uuid>`.
- Sole-operator self-approval requires `decidedAssuranceLevel >= 3`; multi-approver orgs NEVER create an approval row for the requester.
- Audit details carry ids/action-name/digest/summaries — never raw argument contents.
- Sanitized result cap 64 KiB; oversize → `{truncated: true}` stored, intent still `completed`.
- No behavior change to external MCP in this plan (that is Plan 2). Chat UX timing unchanged (fast path stays inline).
- Run everything with pinned Node 22.20.0; API tsc needs `NODE_OPTIONS=--max-old-space-size=8192`.
- This worktree may contain unrelated concurrent WIP — stage files explicitly, never `git add -A`/stash.

## File Map

| File | Action | Responsibility |
|---|---|---|
| `apps/api/migrations/2026-07-18-action-intents.sql` | Create | Tables, enums, trigger, RLS, `approval_requests` ALTER |
| `apps/api/src/db/schema/actionIntents.ts` | Create | Drizzle schema for both tables |
| `apps/api/src/db/schema/approvals.ts` | Modify | `intentId`, `boundArgumentDigest` columns |
| `apps/api/src/db/schema/index.ts` (or barrel) | Modify | Export new schema |
| `apps/api/src/services/actionIntents/canonicalize.ts` | Create | Canonical JSON + SHA-256 digest |
| `apps/api/src/services/actionIntents/intentService.ts` | Create | Create/CAS-transition/fan-out/idempotency |
| `apps/api/src/services/actionIntents/actorContext.ts` | Create | Rebuild AuthContext from stored actor |
| `apps/api/src/services/actionIntents/metrics.ts` | Create | Counter + audit helpers |
| `apps/api/src/routes/approvals.ts` | Modify | Decide handler: intent CAS + sibling expiry + assurance gate |
| `apps/api/src/jobs/intentOutboxPublisher.ts` | Create | 5s poller → BullMQ |
| `apps/api/src/jobs/intentReleaseWorker.ts` | Create | Revalidate + execute + stale-executing sweep |
| `apps/api/src/jobs/approvalExpiryReaper.ts` | Modify | Also sweep expired intents |
| `apps/api/src/services/aiAgentSdk.ts` | Modify | T3 flow intent-backed |
| `apps/api/src/services/permissions.ts` (+ role seeds) | Modify | `approvals:decide` permission |
| Contract tests | Modify | `rls-coverage`, `tenantCascade` registration |

---

### Task 1: Schema + migration + contract-test registration

**Files:**
- Create: `apps/api/migrations/2026-07-18-action-intents.sql`
- Create: `apps/api/src/db/schema/actionIntents.ts`
- Modify: `apps/api/src/db/schema/approvals.ts`, schema barrel
- Modify: `apps/api/src/services/tenantCascade.ts` (`CORE_ORG_CASCADE_DELETE_ORDER` — insert `action_intents` alphabetically; verify FK direction: `intent_outbox` cascades from `action_intents`, `approval_requests.intent_id` is ON DELETE CASCADE so no ordering entry needed for it)
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` (register `action_intents` as shape-1 auto-discovered — verify; add `intent_outbox` to the INTENTIONAL_UNSCOPED documentation list)
- Test: `apps/api/src/db/schema/actionIntents.test.ts` + migration-application test following `migration-m365-control-plane-foundation.test.ts` pattern

**Interfaces produced (used by all later tasks):**
- Drizzle exports `actionIntents`, `intentOutbox`; enums `actionIntentStatusEnum` (`pending_approval|approved|executing|completed|failed|rejected|expired|cancelled`), `actionIntentSourceEnum` (`chat|mcp_api`), `intentOutboxEventEnum` (`intent_created|intent_approved`).
- `approvalRequests` gains `intentId: uuid('intent_id')` (FK `action_intents.id` ON DELETE CASCADE, indexed) and `boundArgumentDigest: char('bound_argument_digest', { length: 64 })`, both nullable.

- [ ] **Step 1: Write the failing schema test** — asserts column names/types on the Drizzle objects (12 immutable content fields, lifecycle fields, checks list), enum members exactly as above, and that `approvalRequests.intentId` exists.
- [ ] **Step 2: Run** `pnpm --filter @breeze/api test -- actionIntents` → FAIL (module not found).
- [ ] **Step 3: Write the migration.** Content requirements (all idempotent — `IF NOT EXISTS` / `DO $$` / pg_policies checks):

```sql
-- 2026-07-18-action-intents.sql
CREATE TABLE IF NOT EXISTS action_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  partner_id UUID REFERENCES partners(id),
  requested_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  requesting_api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('chat','mcp_api')),
  requesting_client_label VARCHAR(255),
  action_name VARCHAR(255) NOT NULL,
  action_version INTEGER NOT NULL DEFAULT 1,
  arguments JSONB NOT NULL DEFAULT '{}',
  argument_digest CHAR(64) NOT NULL,
  target_summary TEXT NOT NULL,
  impact_summary TEXT NOT NULL,
  reason TEXT,
  risk_tier SMALLINT NOT NULL,
  connection_id UUID,
  tenant_id UUID,
  idempotency_key TEXT NOT NULL,
  correlation_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_approval'
    CHECK (status IN ('pending_approval','approved','executing','completed','failed','rejected','expired','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  decided_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_assurance_level SMALLINT,
  decided_via TEXT,
  executed_at TIMESTAMPTZ,
  result JSONB,
  error_code TEXT,
  CONSTRAINT action_intents_one_actor_chk
    CHECK ((requested_by_user_id IS NULL) <> (requesting_api_key_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS action_intents_org_idem_uniq
  ON action_intents (org_id, idempotency_key);
CREATE INDEX IF NOT EXISTS action_intents_org_status_idx
  ON action_intents (org_id, status, expires_at);
```

plus (same file): the immutability trigger —

```sql
CREATE OR REPLACE FUNCTION action_intents_block_content_update() RETURNS trigger AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
     OR NEW.requesting_api_key_id IS DISTINCT FROM OLD.requesting_api_key_id
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.action_name IS DISTINCT FROM OLD.action_name
     OR NEW.action_version IS DISTINCT FROM OLD.action_version
     OR NEW.arguments IS DISTINCT FROM OLD.arguments
     OR NEW.argument_digest IS DISTINCT FROM OLD.argument_digest
     OR NEW.risk_tier IS DISTINCT FROM OLD.risk_tier
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'action_intents content is immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'action_intents_immutable_trg') THEN
    CREATE TRIGGER action_intents_immutable_trg BEFORE UPDATE ON action_intents
      FOR EACH ROW EXECUTE FUNCTION action_intents_block_content_update();
  END IF;
END $$;
```

the RLS block (copy the enable/force/policy structure from `2026-07-13-m365-control-plane-foundation.sql`; policy = system OR `breeze_has_org_access(org_id)`), the `intent_outbox` table —

```sql
CREATE TABLE IF NOT EXISTS intent_outbox (
  id BIGSERIAL PRIMARY KEY,
  intent_id UUID NOT NULL REFERENCES action_intents(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('intent_created','intent_approved')),
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  publish_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS intent_outbox_unpublished_idx
  ON intent_outbox (created_at) WHERE published_at IS NULL;
```

and the `approval_requests` ALTER (`ADD COLUMN IF NOT EXISTS intent_id UUID REFERENCES action_intents(id) ON DELETE CASCADE`, `ADD COLUMN IF NOT EXISTS bound_argument_digest CHAR(64)`, index on `intent_id`; extend/add the at-most-one-source CHECK across `execution_id`/`elevation_request_id`/`intent_id` with `DROP CONSTRAINT IF EXISTS` + re-add — first check the shipped schema for an existing constraint name). NOTE: use `gen_random_uuid()` (pgcrypto-free, Postgres 13+ builtin) — never `gen_random_bytes` (known footgun).

- [ ] **Step 4: Write the Drizzle schema** mirroring the SQL exactly (follow `db/schema/elevations.ts` style for enums/indexes; put both tables in `actionIntents.ts`); wire barrel export; add the two columns to `approvals.ts`.
- [ ] **Step 5: Run schema tests + `pnpm db:check-drift`** (needs local DB per Development Commands) → both green.
- [ ] **Step 6: Register contract tests.** `tenantCascade.ts`: insert `'action_intents'` alphabetically into `CORE_ORG_CASCADE_DELETE_ORDER`. RLS coverage test: confirm shape-1 auto-discovery picks up `action_intents` (it has org_id — run the integration file if a local :5433 DB is available; otherwise rely on CI Integration Tests and say so in the report); add `intent_outbox` to the documented system-scoped list.
- [ ] **Step 7: Commit** — `git add apps/api/migrations/2026-07-18-action-intents.sql apps/api/src/db/schema/actionIntents.ts apps/api/src/db/schema/actionIntents.test.ts apps/api/src/db/schema/approvals.ts <barrel> apps/api/src/services/tenantCascade.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` ; `git commit -m "feat(intents): add action_intents schema with immutable content and outbox"`

---

### Task 2: Canonicalization + digest

**Files:** Create `apps/api/src/services/actionIntents/canonicalize.ts` + test.

**Interfaces produced:**
- `canonicalizeArguments(input: Record<string, unknown>): string` — deterministic JSON: recursively sorted object keys, arrays order-preserved, `undefined` properties dropped, throws `TypeError` on functions/symbols/bigints/circular refs, numbers via default JSON serialization.
- `computeArgumentDigest(canonical: string): string` — `createHash('sha256').update(canonical, 'utf8').digest('hex')`.

- [ ] **Step 1: Failing tests**: key-order invariance (`{b:1,a:2}` ≡ `{a:2,b:1}` → same digest); nested objects sorted; array order preserved (different order → different digest); `undefined` dropped ≡ absent; circular ref throws; digest is 64 lowercase hex.
- [ ] **Step 2–4: Red → implement → green.** Implementation core:

```ts
function sortValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
      throw new TypeError('argument value is not JSON-serializable');
    }
    return value;
  }
  if (seen.has(value as object)) throw new TypeError('circular argument structure');
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((item) => sortValue(item, seen));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) out[key] = sortValue(item, seen);
  }
  return out;
}
export function canonicalizeArguments(input: Record<string, unknown>): string {
  return JSON.stringify(sortValue(input, new WeakSet()));
}
```

- [ ] **Step 5: Commit** — `feat(intents): add argument canonicalization and digest`

---

### Task 3: `approvals:decide` permission

**Files:** Modify `apps/api/src/services/permissions.ts` (and wherever role→permission seeds live — READ that file first and follow the existing permission-definition + role-seeding pattern exactly); test alongside.

**Behavioral contract (binding):** a new permission key `approvals:decide`; granted by default to the same roles that hold org-admin and partner-admin capability today (match how an existing admin-only permission is seeded); checkable per-org via the existing permission helpers used by `canAccessOrg`-style checks. Produce a helper `userCanDecideApprovals(userPerms, orgId): boolean` exported wherever sibling helpers live.

- [ ] TDD steps: failing test (admin role has it, technician-without-grant doesn't, org scoping respected) → implement → green → commit `feat(intents): add approvals:decide permission`.

---

### Task 4: Intent service (create, CAS, fan-out, idempotency)

**Files:** Create `apps/api/src/services/actionIntents/intentService.ts`, `apps/api/src/services/actionIntents/metrics.ts` (pattern-match `m365ControlPlane/readActionMetrics.ts`: counter `breeze_action_intents_total{source,action,outcome}` + audit helper writing `action_intent.*` events); tests.

**Interfaces produced (used by Tasks 5–8 and Plan 2):**

```ts
export interface CreateActionIntentInput {
  toolName: string;
  input: Record<string, unknown>;
  reason?: string;
  source: 'chat' | 'mcp_api';
  requestingClientLabel?: string;
  idempotencyKey?: string;          // MCP callers; derived for chat
  orgId?: string;                   // resolved via resolveWritableToolOrgId when absent
}
export type ActionIntentSnapshot = {
  id: string; status: ActionIntentStatus; actionName: string; argumentDigest: string;
  source: 'chat' | 'mcp_api'; expiresAt: Date; result: unknown; errorCode: string | null;
  approvalRequestIds: string[];
};
export async function createActionIntent(auth: AuthContext, input: CreateActionIntentInput): Promise<ActionIntentSnapshot>;
export async function getActionIntent(auth: AuthContext, intentId: string): Promise<ActionIntentSnapshot | null>;
export async function cancelActionIntent(auth: AuthContext, intentId: string): Promise<{ ok: boolean; status: ActionIntentStatus }>;
export async function transitionIntent(intentId: string, from: ActionIntentStatus | ActionIntentStatus[], to: ActionIntentStatus, patch?: Partial<...lifecycle cols...>): Promise<boolean>; // the CAS primitive, system context
```

**Behavior (spec §4, binding):** tier resolution via `getToolTier` + `checkGuardrails` (reject non-T3 with a typed error; T4 refused); canonicalize+digest; summaries = tool description first sentence + top-level arg keys with values truncated to 80 chars; idempotency insert with `onConflictDoNothing` + re-select returning the existing snapshot; approver resolution (org users with `approvals:decide` via Task 3 helper, excluding requester; sole-operator and no-approver branches per spec §4.4 — sole-operator approval row carries `boundArgumentDigest` and a marker the decide handler can read: reuse `isRecursive`? NO — add nothing; the decide handler recomputes sole-operator status from the intent's requester vs decider, see Task 5); intent + fan-out rows + `intent_created` outbox row in ONE `db.transaction` under the caller's RLS context EXCEPT the outbox insert which is system-scope — run the whole creation inside `withDbAccessContext` and insert outbox via the same transaction (outbox has no RLS, plain insert works); push notifications AFTER commit (best-effort, like `aiAgentSdk.ts:530-560`'s pattern).

- [ ] TDD steps: failing tests for — T2 tool rejected; T4 refused; digest stability; idempotent double-create returns same id; fan-out excludes requester; sole-operator single row; no-approver → cancelled + `no_eligible_approvers`; outbox row written in-txn (assert via mocked db capture); CAS transition zero-row semantics. Then implement → green → `tsc` clean → commit `feat(intents): add intent service with approver fan-out`.

---

### Task 5: Decide-handler extension (`routes/approvals.ts`)

**Files:** Modify `apps/api/src/routes/approvals.ts` + its test file.

**Behavior (binding):** when the decided row has `intentId`: (1) sole-operator enforcement — if the approval's user is the intent's `requested_by_user_id`, require `decidedAssuranceLevel >= 3` (the step-up machinery already computes this; refuse with the existing StepUpRequiredError flow otherwise) and audit `action_intent.self_approved_sole_operator`; (2) in the same transaction as the approval CAS: intent CAS `pending_approval → approved|rejected` with decider fields, expire sibling approval rows (`status='pending' AND intent_id=X AND id<>this` → `expired`), insert `intent_approved` outbox row on approval; (3) digest check — refuse decision if `bound_argument_digest` ≠ intent's `argument_digest` (defense-in-depth, audited). Rows without `intentId` behave exactly as today (regression tests must pass unmodified).

- [ ] TDD: failing tests for the four behaviors + first-wins race (second decider gets "Already decided") + non-intent rows untouched → implement → green → commit `feat(intents): bind approval decisions to intents`.

---

### Task 6: Outbox publisher + expiry sweeps

**Files:** Create `apps/api/src/jobs/intentOutboxPublisher.ts`; modify `apps/api/src/jobs/approvalExpiryReaper.ts` (add intent sweep) or create sibling `intentExpiryReaper.ts` if the existing file's shape resists extension — implementer's call, report which; tests for both. READ `approvalExpiryReaper.ts` fully first; mirror its BullMQ registration, 30s cadence, `FOR UPDATE SKIP LOCKED` CTE, batch cap, and `withSystemDbAccessContext` usage.

**Behavior (binding):** publisher — 5s repeatable job; claim ≤200 unpublished rows; for each, enqueue to queue `action-intents` with jobId `intent-<eventType>-<intentId>` and mark `published_at`, increment `publish_attempts`; rows with `publish_attempts > 5` logged at error level and skipped (alarm surface). Expiry sweep — `pending_approval|approved` past `expires_at` → `expired` (CAS), linked pending approval rows → `expired`, audit per intent; stale-executing sweep — `executing` where `executed_at IS NULL AND decided_at < now() - interval '20 minutes'` → `failed` + `error_code='execution_lost'` (20 min = comfortably ≥ 2× the longest tool timeout, per spec §8; keep as one constant beside the expiry constants).

- [ ] TDD: publisher idempotence (re-run doesn't double-enqueue thanks to jobId dedupe), attempts increment, expiry CAS, stale-executing flip → implement → green → commit `feat(intents): publish outbox and sweep expiries`.

---

### Task 7: Actor context + release worker

**Files:** Create `apps/api/src/services/actionIntents/actorContext.ts`, `apps/api/src/jobs/intentReleaseWorker.ts`; tests.

**`buildAuthContextForIntent(intent): Promise<AuthContext | null>`** — for `requested_by_user_id`: load user, refuse if disabled/deleted, rebuild permissions/org/site closures by calling the SAME functions `middleware/auth.ts` uses (READ it and extract/reuse; if the logic is inline-only, extract a shared helper in `middleware/auth.ts` exported for both — do not fork the logic); for `requesting_api_key_id`: load key, refuse if revoked/expired, rebuild scope-based context matching `apiKeyAuthMiddleware`. Returns null (refusal) → intent `failed: actor_invalid`.

**Release worker (binding, spec §5):** consumes `intent_approved` jobs from queue `action-intents`; CAS `approved → executing` (zero rows → exit silently); revalidation chain (each failure → CAS `executing → failed` with the exact codes): approval row still approved + digest equality (`digest_mismatch`); tool exists + `getToolTier` not increased (`tier_escalated`); `buildAuthContextForIntent` non-null (`actor_invalid`); org active (`org_inactive`). Then `executeTool(toolName, args, auth)` via the existing dispatch (this creates the ledger row + audit as normal); cap result to 64 KiB (`Buffer.byteLength(JSON.stringify(result))`); CAS `executing → completed|failed` + metrics/audit.

- [ ] TDD: revalidation matrix (each stop condition), double-release no-op, result cap, ledger row created → implement → green → commit `feat(intents): durable release worker with revalidation`.

---

### Task 8: Chat SDK integration

**Files:** Modify `apps/api/src/services/aiAgentSdk.ts` (the T3 block at ~lines 489–620: approval-row insert at 530, `waitForApproval` calls at 325/598) + its tests.

**Behavior (binding, spec §6.1):** replace the direct `approvalRequests` insert with `createActionIntent(auth, {toolName, input, source: 'chat', ...})`; keep the 300s wait window (chat intent expiry = 5 min aligns); `waitForApproval` is REPLACED at these call sites by a new `waitForIntentDecision(intentId, timeoutMs, signal)` (same poll/backoff shape as `aiAgent.ts:300`'s loop but reading `action_intents.status`; put it in `intentService.ts`); on `approved` while session alive: session performs CAS `approved → executing` itself — if the CAS loses (worker got it), poll until terminal and use the stored result; then execute inline exactly as today and CAS `executing → completed|failed`. On timeout: leave the intent pending (it can still be approved and executed durably later — this is the new capability); the chat message says approval is still pending and results will be available in the session/audit. The synthetic-helper skip path at line ~270 keeps its current behavior (helper contexts bypass unchanged). Existing `ai_tool_executions` mirroring: the decide handler no longer mirrors executions for intent-linked rows (Task 5 replaced that with intent CAS); the session/worker owns ledger writes.

- [ ] TDD: intent created with source chat + 5min expiry; fast-path inline execution wins CAS; session-lost path completes via worker (simulate by letting worker CAS first); timeout leaves pending; helper-context path untouched → implement → green (full `aiAgentSdk` + `aiAgent` test files) → commit `feat(intents): back chat tier-3 approvals with durable intents`.

---

### Task 9: Approval UI payload fields + verification gate

**Files:** Modify the approval push builder (`services/expoPush.ts` `buildApprovalPush`) and the web approval detail data source (`routes/approvals.ts` GET `/:id` — include intent fields when linked: org name, action name/version, target/impact summaries, source, client label, expiry); web component that renders approval detail (find via `grep -rn "approval" apps/web/src/components --include='*.tsx' -l` and extend the detail fields; follow existing i18n patterns — new strings in ALL locale files, en + de-DE + es-419 + fr-FR + pt-BR per the key-parity gate).

- [ ] Steps: extend GET payload + push payload (tests) → web detail fields + locale keys (run the web i18n parity test) → full gate: `pnpm --filter @breeze/api test`, `pnpm --filter @breeze/web test`, tsc both, eslint changed files, `git diff --check` → commit `feat(intents): surface intent context in approval UI` → run `/code-review` (one round).

---

## Self-Review Notes

- Task 5 removes the decide-handler's `ai_tool_executions` mirroring only for intent-linked rows; legacy rows (PAM bridge, non-intent AI rows during rollout) keep the existing mirror — Task 8's tests must cover both.
- `intent_outbox` insert inside the caller-context transaction is legal because the table has no RLS (system table); the RLS coverage test documents it as INTENTIONAL_UNSCOPED (Task 1 Step 6).
- The CAS primitive `transitionIntent` (Task 4) is consumed by Tasks 5, 6, 7, 8 — one implementation, no per-file variants.
- Cascade note: `approval_requests.intent_id` and `intent_outbox.intent_id` are both ON DELETE CASCADE, so `CORE_ORG_CASCADE_DELETE_ORDER` needs only `action_intents` itself (children resolve via FK cascade) — but verify `tenantCascade.integration.test.ts`'s five properties still hold after insertion.
