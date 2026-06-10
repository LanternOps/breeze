# Helper Tool-Action PAM Governance (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Model mutating Breeze Helper tool invocations as PAM `elevation_requests` (new `flow_type='ai_tool_action'`), decide them through `pamRuleEngine` tool-action rules (fail-safe to pending), approve them only via the existing separate-identity `POST /pam/elevation-requests/:id/respond`, and bridge the decision back to `ai_tool_executions.status` so `waitForApproval` unblocks unchanged — then re-enable mutating Helper tools under this governance.

**Architecture:** The hook point is the per-step approval branch of `createSessionPreToolUse` (`services/aiAgentSdk.ts`), which already inserts the pending `ai_tool_executions` row and blocks on `waitForApproval`. When `session.auth.helperDeviceId` is set, a new service (`pamToolActionGovernance.ts`) creates the elevation row, runs tool-action rules (`matchToolName`/`matchRiskTier`, new columns on `pam_rules`), and mirrors auto verdicts onto the execution row. Manual approvals flow through the existing `/respond` handler, which gains an in-transaction mirror keyed on the new `elevation_requests.execution_id`. `pamBridge` (executable-shaped) is deliberately skipped.

**Tech Stack:** Hono + Drizzle + Vitest (API), hand-written idempotent SQL migrations, PG enums + RLS (elevation_requests/pam_rules already Shape-1 covered).

**Spec:** `docs/superpowers/specs/2026-06-10-helper-privileged-action-pam-governance-design.md` (Phase 1 sections 1.1–1.6).

**Ground truths discovered during planning (do not re-derive):**
- `#1183` is merged; PAM code is on main. There is **no `/pam` admin web UI yet** (the `2026-06-09-pam-web-admin-ui.md` plan is unshipped) — spec §1.5's UI surfacing reduces to API support (list `flowType` filter + rules CRUD criteria). Do not build a web UI in this plan.
- `ALTER TYPE ... ADD VALUE` + a CHECK constraint referencing the new value **cannot share one transaction** ("unsafe use of new value of enum type"). `autoMigrate` wraps each *file* in one transaction → two migration files (`-a-`/`-b-`).
- The existing `elevation_requests_flow_shape_chk` has no branch for a third flow_type — it must be re-created or every `ai_tool_action` insert fails.
- Helper sessions have a synthetic user whose `id` is the **device id** — the `approval_requests` bridge (FK to `users`) and mobile push must be skipped on the helper path.
- Tier source is `guardrailCheck.tier` (from `checkGuardrails`, tiers 1–4; tier ≥ 2 requires approval; tier 4 is blocked earlier).
- `s1_threat_action` takes `threatIds` (not device-pinnable) — it must NOT return to the helper tool sets. All other returning tools take `deviceId`.
- `waitForApproval` (`services/aiAgent.ts:181`) polls for `'approved'`/`'rejected'` and times out at the caller-supplied 300s, marking the row `rejected`. Its contract is untouched.

---

## File map

| File | Change |
|---|---|
| `apps/api/migrations/2026-06-10-a-elevation-flow-type-ai-tool-action.sql` | Create — enum value only |
| `apps/api/migrations/2026-06-10-b-helper-tool-action-elevations.sql` | Create — columns, constraint, indexes |
| `apps/api/src/db/schema/elevations.ts` | Modify — flow enum + 4 columns |
| `apps/api/src/db/schema/pam.ts` | Modify — 2 match-criteria columns |
| `apps/api/src/services/pamRuleEngine.ts` | Modify — tool-action candidate + criteria |
| `apps/api/src/services/pamRuleEngine.test.ts` | Modify — new criteria tests |
| `apps/api/src/services/pamToolActionGovernance.ts` | Create — decision + status bridge |
| `apps/api/src/services/pamToolActionGovernance.test.ts` | Create |
| `apps/api/src/services/aiAgentSdk.ts` | Modify — helper branch in preToolUse |
| `apps/api/src/services/aiAgentSdk.test.ts` | Modify — helper-branch tests |
| `apps/api/src/routes/pam.ts` | Modify — flowType filter, respond mirror, rules criteria |
| `apps/api/src/routes/pam.test.ts` | Modify |
| `apps/api/src/services/helperToolFilter.ts` | Modify — governed standard/extended sets |
| `apps/api/src/services/helperToolFilter.test.ts` | Modify |
| `apps/api/src/services/aiTools.ts` | Modify — HELPER_TOOL_SCOPING additions |
| `apps/api/src/services/aiTools.test.ts` (or wherever Phase 0 gate tests live) | Modify |

One PR for the whole plan (single logical change: Phase 1 governance pipeline). Commit after every task.

Environment: work in the `helper-pam-phase1` worktree; prefix all pnpm/vitest/tsc with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`. Run API tests as e.g. `PATH=... npx vitest run src/services/pamRuleEngine.test.ts` from `apps/api/`. Known pre-existing tsc errors: `agents.test.ts`, `apiKeyAuth.test.ts`. Full-suite parallel flakiness is known — verify via affected files single-fork, trust CI for the rest.

---

### Task 1: Migrations + Drizzle schema

**Files:**
- Create: `apps/api/migrations/2026-06-10-a-elevation-flow-type-ai-tool-action.sql`
- Create: `apps/api/migrations/2026-06-10-b-helper-tool-action-elevations.sql`
- Modify: `apps/api/src/db/schema/elevations.ts`
- Modify: `apps/api/src/db/schema/pam.ts`

- [ ] **Step 1: Write migration `-a-` (enum value only — must be its own file/transaction)**

```sql
-- 2026-06-10-a-elevation-flow-type-ai-tool-action.sql
--
-- Phase 1 of Helper privileged-action governance (security finding A):
-- Helper AI tool actions become PAM elevation requests. The enum value is
-- added in its own migration file because the -b- file's CHECK constraint
-- references it, and PG forbids using a new enum value in the transaction
-- that added it ("unsafe use of new value of enum type"). autoMigrate wraps
-- each file in one transaction, so the file split is the transaction split.
ALTER TYPE elevation_flow_type ADD VALUE IF NOT EXISTS 'ai_tool_action';
```

- [ ] **Step 2: Write migration `-b-` (columns, constraint, indexes)**

```sql
-- 2026-06-10-b-helper-tool-action-elevations.sql
--
-- Phase 1 (Helper tool-action governance, spec 2026-06-10):
--   * elevation_requests gains the ai_tool_action shape: execution_id links
--     the PAM decision back to ai_tool_executions (the gate waitForApproval
--     polls), plus tool_name / action_digest / risk_tier.
--   * pam_rules gains tool-action match criteria (match_tool_name,
--     match_risk_tier) so org/site policy can auto_approve / auto_deny /
--     require_approval specific Helper tools.
-- No RLS changes: both tables are already Shape-1 org-scoped; new columns
-- inherit the existing policies.

-- elevation_requests: ai_tool_action columns ------------------------------
ALTER TABLE elevation_requests
  ADD COLUMN IF NOT EXISTS execution_id uuid REFERENCES ai_tool_executions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tool_name varchar(100),
  ADD COLUMN IF NOT EXISTS action_digest varchar(64),
  ADD COLUMN IF NOT EXISTS risk_tier smallint;

-- Mirror-lookup hot path: /respond resolves execution_id for ai_tool_action rows.
CREATE INDEX IF NOT EXISTS elevation_requests_execution_id_idx
  ON elevation_requests (execution_id)
  WHERE execution_id IS NOT NULL;

-- Re-create the flow-shape constraint with the third branch. Note:
-- execution_id is deliberately NOT required by the constraint — its FK is
-- ON DELETE SET NULL, so requiring it would make ai_tool_executions rows
-- undeletable underneath historical elevations.
ALTER TABLE elevation_requests
  DROP CONSTRAINT IF EXISTS elevation_requests_flow_shape_chk;
ALTER TABLE elevation_requests
  ADD CONSTRAINT elevation_requests_flow_shape_chk
  CHECK (
    (flow_type = 'tech_jit_admin' AND subject_user_id IS NOT NULL)
    OR
    (flow_type = 'uac_intercept' AND target_executable_path IS NOT NULL)
    OR
    (flow_type = 'ai_tool_action' AND tool_name IS NOT NULL)
  );

-- pam_rules: tool-action match criteria -----------------------------------
ALTER TABLE pam_rules
  ADD COLUMN IF NOT EXISTS match_tool_name varchar(100),
  ADD COLUMN IF NOT EXISTS match_risk_tier smallint;
```

- [ ] **Step 3: Update `apps/api/src/db/schema/elevations.ts`**

Add `'ai_tool_action'` to the flow-type enum:

```ts
export const elevationFlowTypeEnum = pgEnum('elevation_flow_type', [
  'uac_intercept',
  'tech_jit_admin',
  'ai_tool_action',
]);
```

Add the columns to `elevationRequests` directly after the `softwarePolicyMatchId` block (import `aiToolExecutions` from `./ai` at the top of the file):

```ts
    // ai_tool_action flow (Phase 1, spec 2026-06-10): links the PAM decision
    // back to the AI tool gate. ON DELETE SET NULL — historical elevations
    // outlive their execution rows; flow_shape_chk requires tool_name only.
    executionId: uuid('execution_id').references(() => aiToolExecutions.id, {
      onDelete: 'set null',
    }),
    toolName: varchar('tool_name', { length: 100 }),
    actionDigest: varchar('action_digest', { length: 64 }),
    riskTier: smallint('risk_tier'),
```

Add `smallint` to the `drizzle-orm/pg-core` import in that file.

- [ ] **Step 4: Update `apps/api/src/db/schema/pam.ts`**

After `matchAdGroup`:

```ts
    // Tool-action criteria (Phase 1 Helper governance). A rule is either
    // executable-shaped (signer/hash/path/parent) or tool-action-shaped
    // (tool name / risk tier) — the API layer rejects mixing the two.
    matchToolName: varchar('match_tool_name', { length: 100 }),
    matchRiskTier: smallint('match_risk_tier'),
```

Add `smallint` to the pg-core import.

- [ ] **Step 5: Verify drift + migration ordering test**

```bash
cd /Users/toddhebebrand/breeze/.claude/worktrees/helper-pam-phase1
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/db/autoMigrate.test.ts
```
Expected: no drift; ordering test passes (date-prefixed `-a-` < `-b-`). If the local DB doesn't have the migrations applied, apply by booting the API once or running autoMigrate; drift check requires migrations applied.

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2026-06-10-a-elevation-flow-type-ai-tool-action.sql \
        apps/api/migrations/2026-06-10-b-helper-tool-action-elevations.sql \
        apps/api/src/db/schema/elevations.ts apps/api/src/db/schema/pam.ts
git commit -m "feat(pam): ai_tool_action elevation flow + tool-action rule criteria (Phase 1 schema)"
```

---

### Task 2: pamRuleEngine — tool-action candidate + criteria (TDD)

**Files:**
- Modify: `apps/api/src/services/pamRuleEngine.ts`
- Test: `apps/api/src/services/pamRuleEngine.test.ts`

**Design (locked):**
- `PamRuleCandidate.targetExecutablePath` becomes optional; new optional `toolName` / `riskTier`. Every criterion treats an absent candidate field as **no match** (this is already the pattern for hash/signer/parent).
- `matchToolName`: exact, case-insensitive. `matchRiskTier`: exact numeric equality (predictable; tiers are 2/3 in practice).
- `hasAnyCriteria` includes the new fields (a matchToolName-only rule is valid).
- New export `evaluatePamToolActionRules(rules, candidate)`: pre-filters to rules carrying **at least one tool-action criterion**, then delegates to `evaluatePamRules`. This is the safety wall: a pre-existing matchUser-only UAC rule must never auto-approve Helper tool actions.
- The executable path needs no filtering: a rule with `matchToolName`/`matchRiskTier` set can't match an executable candidate because those candidate fields are absent → criterion fails.

- [ ] **Step 1: Write the failing tests** (append a `describe` block to `pamRuleEngine.test.ts`, reusing the file's existing rule-factory helper if present — otherwise build rules as plain objects matching `PamRule`):

```ts
describe('tool-action rules (Phase 1 helper governance)', () => {
  const baseRule = (over: Partial<PamRule>): PamRule => ({
    id: '00000000-0000-0000-0000-000000000001',
    orgId: 'org-1', siteId: null,
    name: 'r', description: null, enabled: true, priority: 100,
    matchSigner: null, matchHash: null, matchPathGlob: null,
    matchParentImage: null, matchUser: null, matchAdGroup: null,
    matchToolName: null, matchRiskTier: null,
    timeWindow: null, verdict: 'auto_approve', approvalDurationMinutes: null,
    createdByUserId: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
    ...over,
  });
  const toolCandidate = { toolName: 'manage_services', riskTier: 2, subjectUsername: 'HOST-01' };

  it('matches on tool name, case-insensitive', () => {
    const m = evaluatePamToolActionRules([baseRule({ matchToolName: 'Manage_Services' })], toolCandidate);
    expect(m?.verdict).toBe('auto_approve');
  });

  it('does not match a different tool name', () => {
    expect(evaluatePamToolActionRules([baseRule({ matchToolName: 'execute_command' })], toolCandidate)).toBeNull();
  });

  it('matches risk tier exactly', () => {
    expect(evaluatePamToolActionRules([baseRule({ matchRiskTier: 2 })], toolCandidate)?.verdict).toBe('auto_approve');
    expect(evaluatePamToolActionRules([baseRule({ matchRiskTier: 3 })], toolCandidate)).toBeNull();
  });

  it('ANDs tool criteria with user and time window', () => {
    const rule = baseRule({
      matchToolName: 'manage_services', matchUser: 'host-01',
      timeWindow: { start: '00:00', end: '23:59' },
    });
    expect(evaluatePamToolActionRules([rule], { ...toolCandidate, at: new Date() })?.verdict).toBe('auto_approve');
    expect(evaluatePamToolActionRules([rule], { ...toolCandidate, subjectUsername: 'other', at: new Date() })).toBeNull();
  });

  it('a matchUser-only rule never matches tool actions (filtered out)', () => {
    expect(evaluatePamToolActionRules([baseRule({ matchUser: 'host-01' })], toolCandidate)).toBeNull();
  });

  it('an executable rule never matches tool actions', () => {
    expect(evaluatePamToolActionRules([baseRule({ matchHash: 'a'.repeat(64) })], toolCandidate)).toBeNull();
  });

  it('a tool-action rule never matches an executable candidate via evaluatePamRules', () => {
    const m = evaluatePamRules([baseRule({ matchToolName: 'manage_services' })], {
      targetExecutablePath: 'C:\\x.exe', subjectUsername: 'alice',
    });
    expect(m).toBeNull();
  });

  it('criteria-less rules still match nothing', () => {
    expect(evaluatePamToolActionRules([baseRule({})], toolCandidate)).toBeNull();
  });

  it('matchPathGlob fails closed when candidate has no executable path', () => {
    expect(evaluatePamRules([baseRule({ matchPathGlob: '**' })], { subjectUsername: 'a', toolName: 't' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run src/services/pamRuleEngine.test.ts
```
Expected: FAIL — `evaluatePamToolActionRules` not exported; type errors for new candidate fields.

- [ ] **Step 3: Implement in `pamRuleEngine.ts`**

Candidate interface:

```ts
export interface PamRuleCandidate {
  /** Absent for ai_tool_action candidates. */
  targetExecutablePath?: string;
  targetExecutableHash?: string;
  targetExecutableSigner?: string;
  subjectUsername: string;
  parentImage?: string;
  /** AD/local group names of the subject, when known. */
  subjectAdGroups?: string[];
  /** ai_tool_action candidates: bare tool name (no mcp__ prefix). */
  toolName?: string;
  /** ai_tool_action candidates: guardrail tier (2–3 today). */
  riskTier?: number;
  /** Evaluation instant; injectable for tests. Defaults to now. */
  at?: Date;
}
```

`hasAnyCriteria` gains the two fields (note `matchRiskTier` can legitimately be `0`, use explicit null check):

```ts
function hasAnyCriteria(rule: PamRule): boolean {
  return Boolean(
    rule.matchSigner ||
      rule.matchHash ||
      rule.matchPathGlob ||
      rule.matchParentImage ||
      rule.matchUser ||
      rule.matchAdGroup ||
      rule.matchToolName ||
      rule.matchRiskTier != null,
  );
}
```

In `ruleMatches`, make the path criterion fail closed on absent path, and add the new criteria:

```ts
  if (rule.matchPathGlob) {
    if (!candidate.targetExecutablePath) return false;
    if (!matchPathGlob(rule.matchPathGlob, candidate.targetExecutablePath)) return false;
  }
  // ... existing parent/user/adGroup checks unchanged ...
  if (rule.matchToolName) {
    if (!candidate.toolName) return false;
    if (!eqCi(rule.matchToolName, candidate.toolName)) return false;
  }
  if (rule.matchRiskTier != null) {
    if (candidate.riskTier == null) return false;
    if (rule.matchRiskTier !== candidate.riskTier) return false;
  }
```

New export at the bottom:

```ts
/** A rule is tool-action-shaped when it carries a tool-action criterion. */
export function hasToolActionCriterion(rule: Pick<PamRule, 'matchToolName' | 'matchRiskTier'>): boolean {
  return Boolean(rule.matchToolName) || rule.matchRiskTier != null;
}

/**
 * Evaluate an ai_tool_action candidate. Only rules carrying at least one
 * tool-action criterion participate — a pre-existing user-only or
 * executable rule must never govern Helper tool actions.
 */
export function evaluatePamToolActionRules(
  rules: PamRule[],
  candidate: PamRuleCandidate,
): PamRuleMatch | null {
  return evaluatePamRules(rules.filter(hasToolActionCriterion), candidate);
}
```

Update the file-top doc comment to mention tool-action criteria.

- [ ] **Step 4: Run tests to verify they pass** (same command). Also run `npx vitest run src/services/pamBridge.test.ts src/routes/agents/elevationRequests.test.ts` — the candidate type widening must not regress the UAC ingest path or its types.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/pamRuleEngine.ts apps/api/src/services/pamRuleEngine.test.ts
git commit -m "feat(pam): tool-action rule criteria (matchToolName/matchRiskTier) in rule engine"
```

---

### Task 3: Governance service + status bridge (TDD)

**Files:**
- Create: `apps/api/src/services/pamToolActionGovernance.ts`
- Test: `apps/api/src/services/pamToolActionGovernance.test.ts`

**Design (locked):**
- `decideHelperToolAction(params)` — called from the preToolUse helper branch *after* the pending `ai_tool_executions` row exists. Creates the elevation row, evaluates rules, writes elevation_audit rows, emits events, mirrors auto verdicts. Returns `'auto_approved' | 'denied' | 'pending'`.
- **Fail-safe:** any throw → log + return `'pending'` (mirrors ingest). A pending elevation that was never inserted simply lets `waitForApproval` time out (reject) — still safe.
- Verdict mapping: `auto_approve` → elevation `auto_approved` (+ `approvedAt`, `expiresAt = now + (rule.approvalDurationMinutes ?? 15) min` — required by `status_timestamps_chk` is `approved_at` only, but keep the expiry for the Active tab semantics); `auto_deny` → `denied` (+ `denialReason`); `require_approval`, `ignore`, or no match → `pending`. `ignore` has no suppress semantics for tool actions — an action must be decided; treat as pending (document in code).
- `subjectUserId` stays null (helper has no real user); `subjectUsername` = helper device hostname.
- `actionDigest` = sha256 hex of `JSON.stringify(toolInput)`.
- The service wraps all DB work in `withDbAccessContext({scope:'organization', orgId, accessibleOrgIds:[orgId]})` because preToolUse runs outside the request ALS context (same pattern as the surrounding aiAgentSdk.ts code). All work is fast DB-only — no slow I/O inside the context (per the txn pool-poison rule).
- `mirrorElevationDecisionToExecution(executor, executionId, approved, approvedByUserId)` — CAS `pending → approved|rejected` on `ai_tool_executions`; returns whether a row flipped. Shared with `routes/pam.ts` (pass `tx`).

- [ ] **Step 1: Write the failing tests.** Follow the repo's Drizzle-mock pattern (see `breeze-testing` skill and `apps/api/src/routes/agents/elevationRequests.test.ts` for the established mock style: `vi.mock('../db', ...)` with chainable query builders). Cover:

```ts
// pamToolActionGovernance.test.ts — outline; flesh out with the repo mock helpers
describe('decideHelperToolAction', () => {
  it('auto_approve rule → elevation auto_approved, execution mirrored to approved, audit requested+auto_approved, events requested+auto_approved');
  it('auto_deny rule → elevation denied with denialReason, execution mirrored to rejected, audit denied');
  it('require_approval rule → elevation pending, execution untouched, returns "pending"');
  it('no matching rule → pending (default posture)');
  it('ignore verdict → pending (no suppress semantics for tool actions)');
  it('rule loading throws → returns "pending", logs, does not throw');
  it('elevation insert includes flowType ai_tool_action, executionId, toolName, riskTier, sha256 actionDigest, device org/site');
});
describe('mirrorElevationDecisionToExecution', () => {
  it('flips pending → approved with approvedBy/approvedAt');
  it('flips pending → rejected');
  it('returns false when execution is not pending (CAS 0 rows)');
});
```

Assert the insert payload via the mock's captured `values()` argument; assert the mirror's `where` includes the `status='pending'` CAS condition.

- [ ] **Step 2: Run to verify failure** (`npx vitest run src/services/pamToolActionGovernance.test.ts` → module not found).

- [ ] **Step 3: Implement `pamToolActionGovernance.ts`:**

```ts
/**
 * Phase 1 Helper privileged-action governance (security finding A).
 *
 * Models a governed (tier>=2) Helper tool invocation as a PAM elevation
 * request (flow_type='ai_tool_action') and decides it through the PAM rule
 * engine. pamBridge is deliberately skipped — it is executable-shaped and
 * has no binding for a tool action. The decision is mirrored onto
 * ai_tool_executions.status so the SDK gate's waitForApproval() unblocks
 * with no change to its polling contract:
 *   auto_approve            → elevation auto_approved → execution approved
 *   auto_deny               → elevation denied        → execution rejected
 *   require_approval / none → elevation pending; an admin decides via
 *     POST /pam/elevation-requests/:id/respond (separate identity,
 *     pam:execute + MFA), whose handler calls the mirror in-transaction.
 * FAIL SAFE: any error → 'pending' (never auto-approve on failure).
 */
import { createHash } from 'node:crypto';
import { and, eq, isNull, or } from 'drizzle-orm';
import { db, withDbAccessContext } from '../db';
import { aiToolExecutions, devices, elevationAudit, elevationRequests, pamRules } from '../db/schema';
import { evaluatePamToolActionRules } from './pamRuleEngine';
import { publishEvent } from '../services/eventBus';

const AUTO_APPROVE_DEFAULT_DURATION_MINUTES = 15;

export type ToolActionDecision = 'auto_approved' | 'denied' | 'pending';

export interface ToolActionParams {
  orgId: string;
  deviceId: string;
  executionId: string;
  /** Bare tool name (mcp__breeze__ prefix already stripped). */
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Guardrail tier (2–3). */
  riskTier: number;
  /** Helper identity — the device hostname. */
  subjectUsername: string;
}

type DbExecutor = Pick<typeof db, 'update'>;

/**
 * CAS the linked ai_tool_executions row out of 'pending'. Returns whether a
 * row actually flipped — false means the execution was already decided
 * (e.g. waitForApproval timed out and marked it rejected).
 */
export async function mirrorElevationDecisionToExecution(
  executor: DbExecutor,
  executionId: string,
  approved: boolean,
  approvedByUserId: string | null,
): Promise<boolean> {
  const updated = await executor
    .update(aiToolExecutions)
    .set(
      approved
        ? { status: 'approved', approvedBy: approvedByUserId, approvedAt: new Date() }
        : { status: 'rejected' },
    )
    .where(and(eq(aiToolExecutions.id, executionId), eq(aiToolExecutions.status, 'pending')))
    .returning({ id: aiToolExecutions.id });
  return updated.length > 0;
}

export async function decideHelperToolAction(params: ToolActionParams): Promise<ToolActionDecision> {
  try {
    return await withDbAccessContext(
      { scope: 'organization', orgId: params.orgId, accessibleOrgIds: [params.orgId] },
      () => decideInContext(params),
    );
  } catch (err) {
    console.error('[PAM-ToolAction] decisioning failed — failing safe to pending:', err);
    return 'pending';
  }
}

async function decideInContext(params: ToolActionParams): Promise<ToolActionDecision> {
  const now = new Date();

  const [device] = await db
    .select({ siteId: devices.siteId, partnerId: devices.partnerId })
    .from(devices)
    .where(eq(devices.id, params.deviceId))
    .limit(1);
  const siteId = device?.siteId ?? null;

  // Org rules, site-narrowed the same way ingest narrows them: an org-wide
  // rule (site_id null) or a rule for the device's own site.
  const rules = await db
    .select()
    .from(pamRules)
    .where(
      and(
        eq(pamRules.orgId, params.orgId),
        eq(pamRules.enabled, true),
        siteId ? or(isNull(pamRules.siteId), eq(pamRules.siteId, siteId)) : isNull(pamRules.siteId),
      ),
    );

  const match = evaluatePamToolActionRules(rules, {
    toolName: params.toolName,
    riskTier: params.riskTier,
    subjectUsername: params.subjectUsername,
    at: now,
  });

  // 'ignore' has no suppress semantics for a tool action (the action must be
  // decided one way or the other) — treat as no-match → pending.
  const verdict = match && match.verdict !== 'ignore' ? match.verdict : null;
  const decision: ToolActionDecision =
    verdict === 'auto_approve' ? 'auto_approved' : verdict === 'auto_deny' ? 'denied' : 'pending';

  const actionDigest = createHash('sha256')
    .update(JSON.stringify(params.toolInput ?? {}))
    .digest('hex');

  const durationMinutes = match?.approvalDurationMinutes ?? AUTO_APPROVE_DEFAULT_DURATION_MINUTES;
  const [row] = await db
    .insert(elevationRequests)
    .values({
      orgId: params.orgId,
      siteId,
      partnerId: device?.partnerId ?? null,
      deviceId: params.deviceId,
      flowType: 'ai_tool_action',
      subjectUserId: null,
      subjectUsername: params.subjectUsername,
      reason: `Breeze Helper requested AI tool '${params.toolName}' (tier ${params.riskTier})`,
      status: decision,
      requestedAt: now,
      approvedAt: decision === 'auto_approved' ? now : null,
      expiresAt: decision === 'auto_approved' ? new Date(now.getTime() + durationMinutes * 60_000) : null,
      denialReason: decision === 'denied' ? `Denied by PAM rule '${match!.ruleName}'` : null,
      executionId: params.executionId,
      toolName: params.toolName,
      actionDigest,
      riskTier: params.riskTier,
      metadata: match ? { pam_rule_id: match.ruleId, pam_rule_name: match.ruleName } : {},
    })
    .returning({ id: elevationRequests.id });

  // Audit chain (best-effort — must not flip a safe decision into a throw).
  try {
    await db.insert(elevationAudit).values({
      orgId: params.orgId,
      elevationRequestId: row!.id,
      eventType: 'requested',
      actor: 'system',
      actorUserId: null,
      details: { tool_name: params.toolName, risk_tier: params.riskTier, execution_id: params.executionId },
      occurredAt: now,
    });
    if (decision !== 'pending') {
      await db.insert(elevationAudit).values({
        orgId: params.orgId,
        elevationRequestId: row!.id,
        eventType: decision === 'auto_approved' ? 'auto_approved' : 'denied',
        actor: 'policy',
        actorUserId: null,
        details: { pam_rule_id: match!.ruleId, pam_rule_name: match!.ruleName },
        occurredAt: now,
      });
    }
  } catch (err) {
    console.error('[PAM-ToolAction] audit insert failed (non-fatal):', err);
  }

  // Mirror auto verdicts onto the execution row the SDK gate is polling.
  if (decision !== 'pending') {
    await mirrorElevationDecisionToExecution(db, params.executionId, decision === 'auto_approved', null);
  }

  // Events (best-effort).
  try {
    const eventType =
      decision === 'auto_approved'
        ? 'elevation.auto_approved'
        : decision === 'denied'
          ? 'elevation.denied'
          : 'elevation.requested';
    await publishEvent(eventType, params.orgId, {
      elevationRequestId: row!.id,
      deviceId: params.deviceId,
      flowType: 'ai_tool_action',
      status: decision,
      toolName: params.toolName,
      executionId: params.executionId,
      ...(match ? { pamRuleId: match.ruleId } : {}),
    }, 'pam-tool-action');
  } catch (err) {
    console.error('[PAM-ToolAction] event publish failed (non-fatal):', err);
  }

  return decision;
}
```

Verify against the real `publishEvent` signature and the ingest's rule-loading condition (`routes/agents/elevationRequests.ts` ~lines 191–235) — copy its exact site-narrowing shape if it differs from the above. Verify `EventType` includes `elevation.requested`/`elevation.auto_approved`/`elevation.denied` (it does — ingest emits them).

- [ ] **Step 4: Run tests to verify they pass.**

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/pamToolActionGovernance.ts apps/api/src/services/pamToolActionGovernance.test.ts
git commit -m "feat(pam): helper tool-action governance service + execution status bridge"
```

---

### Task 4: preToolUse helper branch in aiAgentSdk.ts (TDD)

**Files:**
- Modify: `apps/api/src/services/aiAgentSdk.ts` (inside the `guardrailCheck.tier >= 2` block, currently lines ~265–538)
- Test: `apps/api/src/services/aiAgentSdk.test.ts`

**Design (locked):**
- The helper branch comes **first** in the tier≥2 block, before the `auto_approve`-mode and plan-mode shortcuts — a Helper session must never bypass PAM via session approval mode.
- It skips the `approval_requests` bridge and mobile push entirely (the synthetic helper user id is a **device id**; the users-FK insert would fail, and there is no mobile owner to push to).
- It still publishes the `approval_required` SSE event (with `requiresAdminApproval: true`) so the Helper UI can render "waiting for administrator approval", and still ends with `waitForApproval` + mark-executing — the polling contract is unchanged. An auto-approved elevation flips the row before the first poll, so the wait returns immediately.

- [ ] **Step 1: Write the failing tests.** Check how `aiAgentSdk.test.ts` builds an `ActiveSession` fixture and mocks `../db`; extend it. Mock `./pamToolActionGovernance`:

```ts
vi.mock('./pamToolActionGovernance', () => ({
  decideHelperToolAction: vi.fn(),
  mirrorElevationDecisionToExecution: vi.fn(),
}));
vi.mock('./aiAgent', async (orig) => ({ ...(await orig()), waitForApproval: vi.fn() }));
```

Cases (helper session = fixture whose `session.auth.helperDeviceId = 'dev-1'`):
1. Tier-2 tool on a helper session calls `decideHelperToolAction` with `{ orgId, deviceId: 'dev-1', executionId: <inserted id>, toolName: <bare name>, riskTier: 2 }` and does **not** insert an `approval_requests` row.
2. `decideHelperToolAction` resolves `'denied'` → preToolUse returns `{ allowed: false }` and `waitForApproval` is never called.
3. `decideHelperToolAction` resolves `'pending'`, `waitForApproval` resolves `true` → `{ allowed: true }` and execution marked executing.
4. Helper session with `session.approvalMode = 'auto_approve'` and a tier-2 tool **still** goes through `decideHelperToolAction` (no bypass).
5. Non-helper session behavior unchanged (existing tests keep passing).

- [ ] **Step 2: Run to verify failure** (`npx vitest run src/services/aiAgentSdk.test.ts`).

- [ ] **Step 3: Implement.** At the top of the `if (guardrailCheck.tier >= 2) {` block, insert:

```ts
      // Helper sessions: PAM governs (Phase 1, security finding A). This
      // branch precedes the auto_approve/plan shortcuts on purpose — a
      // helper token must never self-relax the approval gate. The
      // approval_requests/mobile bridge is skipped: the synthetic helper
      // "user" id is a device id (no users-FK row, no mobile owner).
      if (session.auth.helperDeviceId) {
        const helperDeviceId = session.auth.helperDeviceId;
        let helperExec: { id: string } | undefined;
        try {
          const [row] = await withDbAccessContext(
            { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
            () =>
              db
                .insert(aiToolExecutions)
                .values({
                  sessionId: session.breezeSessionId,
                  toolName,
                  toolInput: input,
                  status: 'pending',
                })
                .returning()
          );
          helperExec = row;
        } catch (err) {
          console.error('[AI-SDK] Failed to create helper approval record:', toolName, err);
          return { allowed: false, error: 'Failed to create approval record' };
        }
        if (!helperExec) {
          return { allowed: false, error: 'Failed to create approval record' };
        }

        session.eventBus.publish({
          type: 'approval_required',
          executionId: helperExec.id,
          toolName,
          input,
          description: guardrailCheck.description ?? `Execute ${toolName}`,
          requiresAdminApproval: true,
        });

        const decision = await decideHelperToolAction({
          orgId: session.orgId,
          deviceId: helperDeviceId,
          executionId: helperExec.id,
          toolName: stripMcpPrefix(toolName),
          toolInput: input as Record<string, unknown>,
          riskTier: guardrailCheck.tier,
          subjectUsername: session.auth.user.name ?? 'helper',
        });

        if (decision === 'denied') {
          return { allowed: false, error: 'This action was denied by organization policy' };
        }

        const approved = await waitForApproval(helperExec.id, 300_000, session.abortController.signal);
        if (!approved) {
          return { allowed: false, error: 'Tool execution was rejected or timed out awaiting administrator approval' };
        }

        try {
          await withDbAccessContext(
            { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
            () =>
              db
                .update(aiToolExecutions)
                .set({ status: 'executing' })
                .where(eq(aiToolExecutions.id, helperExec!.id))
          );
        } catch (err) {
          console.error('[AI-SDK] Failed to update helper approval to executing:', helperExec.id, err);
        }
        return { allowed: true };
      }
```

Import `decideHelperToolAction` from `./pamToolActionGovernance`. If the session event-bus payload type rejects `requiresAdminApproval`, extend the `approval_required` event type where it is defined (find via `type: 'approval_required'` in `streamingSessionManager.ts` / event type unions) with an optional `requiresAdminApproval?: boolean`.

- [ ] **Step 4: Run the test file + neighbors:**

```bash
npx vitest run src/services/aiAgentSdk.test.ts src/services/aiAgentSdk.m365risk.test.ts src/services/aiAgentSdkTools.sessionAware.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiAgentSdk.ts apps/api/src/services/aiAgentSdk.test.ts
git commit -m "feat(ai): route helper tier-2+ tool calls through PAM governance at preToolUse"
```

---

### Task 5: routes/pam.ts — flowType filter, respond mirror, tool-action rule CRUD (TDD)

**Files:**
- Modify: `apps/api/src/routes/pam.ts`
- Test: `apps/api/src/routes/pam.test.ts`

**Design (locked):**
- `listQuerySchema.flowType` gains `'ai_tool_action'`.
- `/respond` for `ai_tool_action` rows mirrors onto the execution **inside the same transaction**, ordered: elevation CAS → audit → mirror CAS; a failed mirror (execution no longer pending, e.g. the 5-min wait already timed out) rolls the whole transaction back via `tx.rollback()` and returns 409 — approving a stale request must not leave an `approved` elevation pointing at a rejected execution.
- Rules CRUD: add `matchToolName` / `matchRiskTier` to the zod schema and inserts/updates. Validation refine: a rule must have ≥1 criterion, must NOT mix executable criteria with tool-action criteria, and a tool-action rule may not use `verdict: 'ignore'` (no suppress semantics for tool actions). Same checks on the PATCH merged result.

- [ ] **Step 1: Write the failing tests** (extend `pam.test.ts`, following its existing handler-test style):

1. `GET /elevation-requests?flowType=ai_tool_action` is accepted (200) and filters.
2. `/respond` approve on an `ai_tool_action` row with a pending execution → 200; execution updated to `approved` with `approvedBy = auth.user.id`; elevation `approved`; audit row written.
3. `/respond` deny → execution `rejected`, elevation `denied`.
4. `/respond` approve when the linked execution is no longer pending (mirror CAS returns 0 rows) → 409, transaction rolled back.
5. `POST /rules` with only `matchToolName` → 201.
6. `POST /rules` mixing `matchHash` + `matchToolName` → 400.
7. `POST /rules` with `matchToolName` + `verdict: 'ignore'` → 400.
8. `POST /rules` with no criteria still → 400 (regression).
9. `PATCH /rules/:id` that would strip the last criterion or produce a mixed/ignore-tool-action rule → 400.

- [ ] **Step 2: Run to verify failure** (`npx vitest run src/routes/pam.test.ts`).

- [ ] **Step 3: Implement.**

List filter:

```ts
  flowType: z.enum(['uac_intercept', 'tech_jit_admin', 'ai_tool_action']).optional(),
```

Respond — add `executionId: elevationRequests.executionId` to the initial `tx.select({...})`, and after the `elevationAudit` insert (before `return { kind: 'ok' ... }`):

```ts
      // ai_tool_action rows: mirror the decision onto the linked
      // ai_tool_executions row the SDK gate is polling — in the SAME
      // transaction. If the execution is no longer pending (the 5-min
      // waitForApproval already timed out and rejected it), approving the
      // elevation would be a lie: roll everything back and 409.
      if (row.flowType === 'ai_tool_action' && row.executionId) {
        const flipped = await mirrorElevationDecisionToExecution(
          tx,
          row.executionId,
          approve,
          approve ? auth.user.id : null,
        );
        if (!flipped) {
          tx.rollback(); // throws TransactionRollbackError
        }
      }
```

Catch the rollback outside (drizzle's `tx.rollback()` throws; wrap the `db.transaction(...)` call):

```ts
    let result: Awaited<ReturnType<typeof runRespondTx>>;
    try {
      result = await runRespondTx();
    } catch (err) {
      if (err instanceof TransactionRollbackError) {
        return c.json(
          { success: false, error: 'Linked tool execution is no longer pending (it likely timed out)' },
          409,
        );
      }
      throw err;
    }
```

(Where `runRespondTx` is the existing `db.transaction(async (tx) => {...})` extracted into a closure, unchanged otherwise. Import `TransactionRollbackError` from `drizzle-orm`; import `mirrorElevationDecisionToExecution` from `../services/pamToolActionGovernance`.)

Rules CRUD — schema additions to `ruleBaseSchema`:

```ts
  matchToolName: z.string().min(1).max(100).nullable().optional(),
  matchRiskTier: z.number().int().min(0).max(4).nullable().optional(),
```

Validation helpers (replace the single `createRuleSchema` refine; keep `hasExecutableCriterion` as-is but rename-safe):

```ts
type RuleCriteriaShape = {
  matchSigner?: string | null; matchHash?: string | null; matchPathGlob?: string | null;
  matchParentImage?: string | null; matchUser?: string | null; matchAdGroup?: string | null;
  matchToolName?: string | null; matchRiskTier?: number | null;
  verdict?: 'auto_approve' | 'auto_deny' | 'require_approval' | 'ignore';
};

const executableCriteriaFields = ['matchSigner', 'matchHash', 'matchPathGlob', 'matchParentImage'] as const;

function hasToolActionCriteria(rule: RuleCriteriaShape): boolean {
  return Boolean(rule.matchToolName) || rule.matchRiskTier != null;
}
function hasExecutableShapeCriteria(rule: RuleCriteriaShape): boolean {
  return executableCriteriaFields.some((f) => Boolean(rule[f]));
}

/** Returns an error string, or null when the rule shape is valid. */
function validateRuleShape(rule: RuleCriteriaShape): string | null {
  if (!hasExecutableCriterion(rule) && !hasToolActionCriteria(rule)) {
    return 'At least one match criterion (signer/hash/path/parent/user/group/tool/tier) is required';
  }
  if (hasExecutableShapeCriteria(rule) && hasToolActionCriteria(rule)) {
    return 'A rule cannot mix executable criteria with tool-action criteria';
  }
  if (hasToolActionCriteria(rule) && rule.verdict === 'ignore') {
    return "verdict 'ignore' is not valid for tool-action rules — a tool action must be decided";
  }
  return null;
}

const createRuleSchema = ruleBaseSchema.superRefine((rule, ctx) => {
  const err = validateRuleShape(rule);
  if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
});
```

Note: `hasExecutableCriterion`'s field list (`ruleCriteriaFields`) already includes user/group; leave it — `validateRuleShape`'s first check uses it for "any criterion at all" together with the tool-action check. In the POST handler add to `.values({...})`:

```ts
      matchToolName: payload.matchToolName ?? null,
      matchRiskTier: payload.matchRiskTier ?? null,
```

In PATCH: replace the `if (!hasExecutableCriterion(merged))` block with `const shapeErr = validateRuleShape(merged); if (shapeErr) return c.json({ error: shapeErr }, 400);` and add the two spread-set lines:

```ts
      ...(payload.matchToolName !== undefined ? { matchToolName: payload.matchToolName } : {}),
      ...(payload.matchRiskTier !== undefined ? { matchRiskTier: payload.matchRiskTier } : {}),
```

- [ ] **Step 4: Run tests** (`npx vitest run src/routes/pam.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/pam.ts apps/api/src/routes/pam.test.ts
git commit -m "feat(pam): ai_tool_action respond mirror + tool-action rule criteria in admin API"
```

---

### Task 6: Re-enable mutating Helper tools under governance (TDD)

**Files:**
- Modify: `apps/api/src/services/helperToolFilter.ts`
- Modify: `apps/api/src/services/aiTools.ts` (`HELPER_TOOL_SCOPING`)
- Test: `apps/api/src/services/helperToolFilter.test.ts` and the Phase 0 gate tests (find via `grep -rn "HELPER_TOOL_SCOPING" apps/api/src --include='*.test.ts'`)

**Design (locked):**
- Every tool in any helper set MUST have a `HELPER_TOOL_SCOPING` entry (the Phase 0 gate denies unscoped tools). Therefore the org-wide tools currently listed in `standard`/`extended` (`query_devices`, `get_fleet_health`, `get_s1_threats`, `get_backup_health`, `get_recovery_readiness`, `query_audit_log`, `get_log_trends`, `detect_log_correlations`, `query_change_log`, `get_cis_compliance`) are **removed** — they were dead weight (gate-denied) and a single-device assistant doesn't need fleet queries.
- `s1_threat_action` is removed: it is keyed on `threatIds`, not a device, so it cannot be device-pinned.
- New sets — **verify each tool's input schema actually declares `deviceId` before adding its scoping entry** (all were spot-checked during planning, but re-check `get_user_experience_metrics` in `aiToolsPerformance.ts` and `run_backup_verification`'s registration; drop any that are not device-keyed):

```ts
  basic: [ /* unchanged Phase 0 list */ ],
  // standard = basic + device-pinned safe actions. Mutations are governed:
  // tier>=2 calls go through PAM (flow_type=ai_tool_action) at the
  // preToolUse gate — default posture require_approval unless an org rule
  // says otherwise. Org-wide tools stay excluded (cannot be device-pinned).
  standard: [
    ...basic list...,
    'get_active_users',
    'get_user_experience_metrics',
    'manage_alerts',
    'manage_services',
    'disk_cleanup',
    'file_operations',
  ],
  // extended adds destructive single-device tools — always PAM-governed.
  // s1_threat_action is deliberately absent (threat-keyed, not device-pinnable).
  extended: [
    ...standard list...,
    'computer_control',
    'execute_command',
    'security_scan',
    's1_isolate_device',
    'network_discovery',
    'apply_cis_remediation',
    'run_backup_verification',
  ],
```

- `HELPER_TOOL_SCOPING` additions in `aiTools.ts` (all `'deviceId'`): `get_active_users`, `get_user_experience_metrics`, `manage_alerts`, `manage_services`, `disk_cleanup`, `file_operations`, `computer_control`, `execute_command`, `security_scan`, `s1_isolate_device`, `network_discovery`, `apply_cis_remediation`, `run_backup_verification`.
- Update the Phase-0 comment on both maps: capability is back under PAM governance; the two lists must stay in sync (every whitelisted tool has a scoping entry).

- [ ] **Step 1: Write/extend failing tests:**
  - `helperToolFilter.test.ts`: `standard` contains `manage_services`/`file_operations` but not `query_devices`/`s1_threat_action`; `extended` contains `execute_command` but no org-wide tool; `basic` unchanged.
  - Cross-consistency test (place next to the existing Phase 0 gate tests): every tool in every `TOOL_WHITELIST` level exists in `HELPER_TOOL_SCOPING` — this pins the invariant the gate depends on:

```ts
import { HELPER_TOOL_SCOPING } from './aiTools';
import { getHelperAllowedTools } from './helperToolFilter';

it('every helper-whitelisted tool is device-scopable by the executeTool gate', () => {
  for (const level of ['basic', 'standard', 'extended'] as const) {
    for (const tool of getHelperAllowedTools(level)) {
      expect(HELPER_TOOL_SCOPING[tool], `${level}:${tool}`).toBeDefined();
    }
  }
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement both file changes.**

- [ ] **Step 4: Run the filter tests + Phase 0 gate tests + helper route tests:**

```bash
npx vitest run src/services/helperToolFilter.test.ts src/services/aiTools.test.ts src/routes/helper/index.test.ts
```

(Adjust the gate-test path to wherever `HELPER_TOOL_SCOPING` tests actually live.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/helperToolFilter.ts apps/api/src/services/aiTools.ts \
        apps/api/src/services/helperToolFilter.test.ts
git commit -m "feat(helper): re-enable mutating single-device tools under PAM governance"
```

---

### Task 7: Verification + PR

- [ ] **Step 1: Type-check** — `cd apps/api && PATH=... npx tsc --noEmit` (pre-existing errors only: `agents.test.ts`, `apiKeyAuth.test.ts`).
- [ ] **Step 2: Affected-file test sweep (single fork):**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH npx vitest run \
  src/services/pamRuleEngine.test.ts src/services/pamBridge.test.ts \
  src/services/pamToolActionGovernance.test.ts src/services/aiAgentSdk.test.ts \
  src/routes/pam.test.ts src/routes/agents/elevationRequests.test.ts \
  src/services/helperToolFilter.test.ts src/routes/helper/index.test.ts \
  src/db/autoMigrate.test.ts
```

- [ ] **Step 3: RLS contract test against local DB if available** (`vitest.config.rls.ts` / `rls-coverage.integration.test.ts`) — no allowlist change expected (no new tables; columns only). If the local DB isn't running, note it and trust CI/smoke.
- [ ] **Step 4: Drift check** — `pnpm db:check-drift`.
- [ ] **Step 5: Manual cross-tenant probe (if local DB available):** as `breeze_app`, forge an `ai_tool_action` insert for another org — must fail with the RLS violation (existing policies cover the new flow type automatically; this is a confidence check, not new coverage).
- [ ] **Step 6: Push + PR** targeting `main`:

```bash
git push -u origin worktree-helper-pam-phase1
gh pr create --title "feat(pam): Phase 1 — Helper privileged-action governance via PAM (finding A)" --body "$(cat <<'EOF'
## Summary
Phase 1 of the Helper privileged-action governance design (spec: docs/superpowers/specs/2026-06-10-helper-privileged-action-pam-governance-design.md). Folds Helper mutating-tool approval into PAM:

- **Model**: `elevation_requests` gains `flow_type='ai_tool_action'` + `execution_id` FK to `ai_tool_executions`, `tool_name`, `action_digest`, `risk_tier` (new idempotent migrations `2026-06-10-a/-b-`; flow-shape CHECK re-created with the third branch).
- **Decide**: tier>=2 Helper tool calls create an elevation at the preToolUse gate and run through `pamRuleEngine` tool-action criteria (`matchToolName`, `matchRiskTier` on `pam_rules`); `pamBridge` is skipped (executable-shaped). Fail-safe to pending. Helper sessions cannot bypass via session approval mode.
- **Approve**: only the existing separate-identity `POST /pam/elevation-requests/:id/respond` (pam:execute + MFA, audited, emits `elevation.approved`). No new approval surface; the helper self-approve path stays deleted (Phase 0).
- **Bridge**: PAM decision mirrors onto `ai_tool_executions.status` keyed by `execution_id` — in-transaction on /respond (409 + rollback if the execution already timed out), in-service for auto verdicts. `waitForApproval` polling contract unchanged.
- **Re-enable**: mutating single-device Helper tools return to `standard`/`extended` under governance; org-wide and non-device-pinnable tools (`query_devices`, `s1_threat_action`, …) stay out; every whitelisted tool is pinned by `HELPER_TOOL_SCOPING`.

Note: the /pam admin web UI does not exist yet (separate plan); list/rules API supports `ai_tool_action` for when it lands.

## Test plan
- [ ] Rule-engine tool-action criteria unit tests (incl. cross-shape isolation)
- [ ] Governance service: auto_approve/auto_deny/pending/error fail-safe, audit + events, digest
- [ ] preToolUse helper branch: PAM call, deny short-circuit, no approval_requests/mobile bridge, no auto_approve bypass
- [ ] /respond mirror CAS + stale-execution 409 rollback; rules CRUD shape validation
- [ ] helper filter/scoping consistency tests
- [ ] db:check-drift + autoMigrate ordering

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 7: When CI is green:** `gh pr merge --squash --admin`.

---

## Self-review notes (spec coverage)

- §1.1 model → Task 1. §1.2 decisioning (skip pamBridge, criteria, fail-safe) → Tasks 2–4. §1.3 approval reuse → Task 5 (no new surface). §1.4 bridge → Tasks 3 + 5. §1.5 policy+UI → Task 5 API-side; web UI explicitly out (does not exist yet — ground truth above). §1.6 re-enable → Task 6. Acceptance bullets map to the listed tests.
- Deliberate deviations from spec wording: `action_digest` is a sha256 hex (varchar(64)) rather than free text; `ignore` verdict is rejected for tool-action rules and treated as pending by the engine path; flow-shape CHECK requires `tool_name` (not `execution_id`) so execution deletion stays possible.
