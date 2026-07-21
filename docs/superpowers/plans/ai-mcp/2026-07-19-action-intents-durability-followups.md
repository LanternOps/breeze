# Action-Intents Durability Follow-Ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the deferred structural-durability group from the action-intents review (PR #2625): make the create/decide paths atomic, bound the release worker's tool execution, add accurate stale-execution detection, and make session-aware M365/Google Tier-3 tools fail cleanly in the headless worker.

**Architecture:** All work sits on branch `ToddHebebrand/action-intents-durability` off the merged `origin/main @ 2fad7f644`. The durable layer is: immutable `action_intents` + unscoped `intent_outbox` → `intentOutboxPublisher` enqueues `intent_approved` jobs → `intentReleaseWorker` re-validates and re-executes. Every fix is proven against **real Postgres** integration tests (port 5433, `vitest.integration.config.ts`) — mock-only tests cannot validate the transaction-atomicity and RLS properties at issue, which is exactly why this group was deferred.

**Tech Stack:** Hono + Drizzle ORM + PostgreSQL (RLS, `breeze_app` NOBYPASSRLS), BullMQ/Redis, Vitest (unit + integration configs).

## Global Constraints

- **DB context helpers are real transactions.** `withDbAccessContext`/`withSystemDbAccessContext` each open one `BEGIN…COMMIT` and issue `SET LOCAL` GUCs (`apps/api/src/db/index.ts:249-259`). Nesting is a no-op that does **not** re-scope (`db/index.ts:245-247`) — an inner `withSystemDbAccessContext` inside an outer org context runs under the **outer** scope. No helper accepts an injected tx handle.
- **Migrations:** hand-written SQL in `apps/api/migrations/`, `YYYY-MM-DD-<slug>.sql`, applied in `localeCompare` order. Idempotent (`ADD COLUMN IF NOT EXISTS`). No inner `BEGIN;`/`COMMIT;` (the runner wraps each file). Never edit a shipped migration. Run `pnpm db:check-drift` after schema edits.
- **`action_intents` immutability trigger is deny-list style** (`migrations/2026-07-18-action-intents.sql:95-125`): it raises on `IS DISTINCT FROM` for identity/content columns only. Lifecycle columns are intentionally unguarded. A new lifecycle timestamp must **NOT** be added to the trigger body.
- **Cascade contract:** `action_intents` is already in `CORE_ORG_CASCADE_DELETE_ORDER` (`tenantCascade.ts:67`); `intent_outbox` cleans via `ON DELETE CASCADE`. Adding a **column** changes no cascade membership — do not touch the cascade lists.
- **The release worker must not import from `aiAgentSdk.ts`/`aiAgentSdkTools.ts`** — those pull in the whole chat-session graph. Shared helpers get extracted into lean modules or duplicated locally (existing precedent: `normalizeToolResult`, `isReturnedToolError` in `intentReleaseWorker.ts`).
- **Fail-closed, never silent.** Every worker abort CASes the intent to a terminal `failed` with a categorized `error_code` + audit. The inline chat path (`aiAgentSdk.ts`) can still execute session-aware tools under its live session — so the `session_required` gate added here is **worker-only**, never in the shared `revalidateApprovedIntentForRelease`.
- **Integration tests:** real PG on `localhost:5433` / redis `6380` — the test stack is defined in **repo-root** `docker-compose.test.yml` (NOT `apps/api/`) and is already running in this worktree; if it isn't, `docker compose -f docker-compose.test.yml up -d` from the repo root. Run tests from `apps/api` with `pnpm vitest run --config vitest.integration.config.ts <name>`. Co-located `*.integration.test.ts` files must be added to the `include` allow-list in `apps/api/vitest.integration.config.ts`. `beforeEach` TRUNCATEs — seed fixtures in `beforeEach`, not `beforeAll`. Template: `apps/api/src/__tests__/integration/intentFanout.integration.test.ts`; reaper template: `apps/api/src/jobs/suppressionExpiryReaper.integration.test.ts`.
- **Rigor:** Tasks 6 (decide-path) and 7 (create-path) move writes across RLS scopes / transaction boundaries — high blast radius. Each ends with a code-review checkpoint (`superpowers:requesting-code-review`, one round).

---

## File Structure

**Create:**
- `apps/api/src/services/toolTimeouts.ts` — lean, dependency-free tool-timeout table + `getToolTimeout` + `withToolTimeout`, shared by the chat SDK and the worker.
- `apps/api/src/services/toolTimeouts.test.ts` — unit tests for the extracted helpers.
- `apps/api/migrations/2026-07-19-action-intents-execution-started-at.sql` — adds the `execution_started_at` lifecycle column.
- `apps/api/src/jobs/intentExpiryReaper.integration.test.ts` — real-PG coverage for `reapStaleExecutingIntents` rekeyed on `execution_started_at`.
- `apps/api/src/routes/approvalsDecideAtomicity.integration.test.ts` — real-PG atomicity for the decide path.
- `apps/api/src/services/actionIntents/createIntentAtomicity.integration.test.ts` — real-PG atomicity + RLS for the create path.

**Modify:**
- `apps/api/src/services/aiAgentSdkTools.ts` — import timeout helpers from `toolTimeouts.ts` instead of defining them.
- `apps/api/src/services/aiTools.ts` — add `requiresLiveSession()` predicate.
- `apps/api/src/db/schema/actionIntents.ts` — add `executionStartedAt` to the lifecycle block.
- `apps/api/src/services/actionIntents/intentService.ts` — add `executionStartedAt?` to `ActionIntentTransitionPatch`; collapse the create path (Task 7).
- `apps/api/src/jobs/intentReleaseWorker.ts` — stamp `executionStartedAt` at claim, timeout wrapper, `session_required` gate.
- `apps/api/src/jobs/intentExpiryReaper.ts` — rekey `reapStaleExecutingIntents` on `execution_started_at`.
- `apps/api/src/routes/approvals.ts` — make the decide-path intent fan-in atomic (both `decideHandler` and report-suspicious).

---

## Task 0: Verify the real-Postgres integration harness runs in this worktree

This is the enabling step the whole deferral hinged on. Do it first — if the harness doesn't come up, nothing else in this plan is testable.

**Files:** none modified.

- [ ] **Step 1: Bring up the test stack**

Run:
```bash
cd apps/api && docker compose -f docker-compose.test.yml up -d
```
Expected: `breeze-postgres-test` (5433) and redis (6380) healthy.

- [ ] **Step 2: Run the existing action_intents integration test**

Run:
```bash
cd apps/api && pnpm vitest run --config vitest.integration.config.ts intentFanout
```
Expected: `intentFanout.integration.test.ts` passes (autoMigrate runs once in globalSetup, fan-out assertions green). If it fails on connection/migration, resolve the harness before proceeding (see `docs/superpowers/plans/tenancy-rls/2026-04-11-rls-coverage-gaps.md` and memory `test_integration_config_run_mechanics`).

- [ ] **Step 3: Commit nothing** — this is a verification gate only.

---

## Task 1: Extract shared tool-timeout module (DRY prep for the worker timeout)

`getToolTimeout` + `withTimeout` currently live in `aiAgentSdkTools.ts` (which the worker must not import). Extract them into a lean module so both the chat SDK and the worker share one source of truth.

**Files:**
- Create: `apps/api/src/services/toolTimeouts.ts`
- Create: `apps/api/src/services/toolTimeouts.test.ts`
- Modify: `apps/api/src/services/aiAgentSdkTools.ts`

**Interfaces:**
- Produces: `getToolTimeout(toolName: string): number`; `withToolTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T>`.

- [ ] **Step 1: Create the shared module**

Move the constants and helpers **verbatim** from `aiAgentSdkTools.ts` (currently `TOOL_EXECUTION_TIMEOUT_MS`, `TOOL_TIMEOUT_OVERRIDES` ~lines 225-246, `getToolTimeout` :248-250, `withTimeout` :252-260) into a new file. Copy the exact override values from the source — do not retype from memory.

```ts
// apps/api/src/services/toolTimeouts.ts
/**
 * Tool-execution timeouts, extracted from aiAgentSdkTools.ts so the durable
 * release worker (jobs/intentReleaseWorker.ts) can bound tool execution WITHOUT
 * importing the chat-session dependency graph. Single source of truth: the
 * inline chat path and the durable worker use the same timeouts.
 */
const TOOL_EXECUTION_TIMEOUT_MS = 60_000; // COPY the real default from aiAgentSdkTools.ts

const TOOL_TIMEOUT_OVERRIDES: Record<string, number> = {
  // COPY the full map verbatim from aiAgentSdkTools.ts (take_screenshot, analyze_screen,
  // computer_control, generate_report, ... — including every entry present there).
};

export function getToolTimeout(toolName: string): number {
  return TOOL_TIMEOUT_OVERRIDES[toolName] ?? TOOL_EXECUTION_TIMEOUT_MS;
}

/**
 * Rejects with a timeout error after `ms` if `promise` hasn't settled. Does NOT
 * cancel the underlying work (JS promises aren't cancelable) — same semantics as
 * the inline chat path's withTimeout; it bounds when the CALLER gives up.
 */
export function withToolTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tool execution timed out after ${ms}ms: ${label}`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
```

- [ ] **Step 2: Rewire `aiAgentSdkTools.ts`**

Delete the moved definitions from `aiAgentSdkTools.ts`. Add `import { getToolTimeout, withToolTimeout } from './toolTimeouts';`. Its internal `withTimeout` was used at ~277/345/502 for tool exec AND postToolUse — for the tool-exec sites use `withToolTimeout`; keep a local `withTimeout` only if a non-tool caller (e.g. `POST_TOOL_USE_TIMEOUT_MS` at :277) still needs it, in which case have the local one delegate: `const withTimeout = withToolTimeout;` Verify no other symbol still references the deleted constants.

- [ ] **Step 3: Write the unit test**

```ts
// apps/api/src/services/toolTimeouts.test.ts
import { describe, it, expect } from 'vitest';
import { getToolTimeout, withToolTimeout } from './toolTimeouts';

describe('getToolTimeout', () => {
  it('returns the override for a known slow tool', () => {
    expect(getToolTimeout('take_screenshot')).toBe(30_000); // match the value copied in Step 1
  });
  it('returns the default for an unlisted tool', () => {
    expect(getToolTimeout('some_unknown_tool')).toBe(60_000); // match TOOL_EXECUTION_TIMEOUT_MS
  });
});

describe('withToolTimeout', () => {
  it('resolves when the promise settles first', async () => {
    await expect(withToolTimeout(Promise.resolve('ok'), 1000, 't')).resolves.toBe('ok');
  });
  it('rejects with a timeout error when the promise is too slow', async () => {
    const slow = new Promise((r) => setTimeout(() => r('late'), 50));
    await expect(withToolTimeout(slow, 5, 'slowtool')).rejects.toThrow(/timed out after 5ms: slowtool/);
  });
});
```

- [ ] **Step 4: Run tests + typecheck**

Run:
```bash
cd apps/api && pnpm vitest run toolTimeouts && pnpm vitest run aiAgentSdkTools 2>/dev/null; NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit
```
Expected: new tests pass; `tsc` clean (confirms `aiAgentSdkTools.ts` still resolves the imports).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/toolTimeouts.ts apps/api/src/services/toolTimeouts.test.ts apps/api/src/services/aiAgentSdkTools.ts
git commit -m "refactor(intents): extract shared tool-timeout module"
```

---

## Task 2: Bound the worker's tool execution with a timeout (③)

The worker runs `executeTool` inside a held `withDbAccessContext` with **no timeout** (`intentReleaseWorker.ts:252-266`), while the inline path wraps its handler in `withTimeout(getToolTimeout(...))`. Add the same bound.

**Files:**
- Modify: `apps/api/src/jobs/intentReleaseWorker.ts`
- Test: `apps/api/src/jobs/intentReleaseWorker.test.ts` (existing)

**Interfaces:**
- Consumes: `getToolTimeout`, `withToolTimeout` from Task 1.

- [ ] **Step 1: Write the failing test**

Add to `intentReleaseWorker.test.ts` (follow the file's existing mock setup for `../services/aiTools`, `transitionIntent`, `revalidateApprovedIntentForRelease`). Mock `executeTool` to never resolve, and mock `getToolTimeout` to return a tiny value so the test is fast:

```ts
it('fails the intent with execution_error when the tool exceeds its timeout', async () => {
  // arrange: claim CAS wins, revalidation ok, executeTool hangs, timeout tiny
  vi.mocked(getToolTimeout).mockReturnValue(5);
  vi.mocked(executeTool).mockReturnValue(new Promise<string>(() => {})); // never settles
  // (transitionIntent: claim -> true, then executing->failed -> true)
  await releaseApprovedIntent('intent-1');
  expect(transitionIntent).toHaveBeenCalledWith(
    'intent-1', 'executing', 'failed',
    expect.objectContaining({ errorCode: 'execution_error', executedAt: expect.any(Date) }),
  );
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `cd apps/api && pnpm vitest run intentReleaseWorker -t "exceeds its timeout"`
Expected: FAIL (no timeout today; the test hangs until the vitest testTimeout, or the assertion never fires).

- [ ] **Step 3: Implement the timeout**

In `intentReleaseWorker.ts`, add imports:
```ts
import { getToolTimeout, withToolTimeout } from '../services/toolTimeouts';
```
Wrap the exec call (currently `:253-258`):
```ts
  let rawResult: string;
  try {
    rawResult = await withToolTimeout(
      runOutsideDbContext(() =>
        withDbAccessContext(dbAccessContextFromAuth(auth), () =>
          executeTool(intent.actionName, intent.arguments, auth),
        ),
      ),
      getToolTimeout(intent.actionName),
      intent.actionName,
    );
  } catch (err) {
    console.error(`[IntentReleaseWorker] executeTool threw for intent ${intent.id}:`, err);
    await failIntent(intent, 'execution_error', {
      details: { error: err instanceof Error ? err.message : String(err) },
      executed: true,
    });
    return;
  }
```
Note in a comment that the timeout bounds when the worker gives up, not the underlying handler (same limitation as the inline path); `execution_error` + `executed:true` is the existing semantics for "an attempt was made."

- [ ] **Step 4: Run tests — verify pass**

Run: `cd apps/api && pnpm vitest run intentReleaseWorker`
Expected: new test + all existing worker tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/intentReleaseWorker.ts apps/api/src/jobs/intentReleaseWorker.test.ts
git commit -m "fix(intents): bound durable release tool execution with a timeout"
```

---

## Task 3: Fail session-aware M365/Google Tier-3 tools cleanly (⑤)

`getToolTier` recognizes `m365_disable_user`, `m365_reset_password`, and every Google tool as Tier-3 (`aiTools.ts:305-307`, via `m365ToolTiers`/`googleToolTiers`), so they get durable intents — but `executeTool` throws `Unknown tool` (`aiTools.ts:375`) because they're never registered in the core `aiTools` map (only the 6 Tier-1 M365 read tools are). Today an async-approved intent for one of these fails with a confusing `execution_error`. Make the worker detect them and fail with an explicit `session_required` (Phase 1; headless dispatch deferred).

**Files:**
- Modify: `apps/api/src/services/aiTools.ts`
- Modify: `apps/api/src/jobs/intentReleaseWorker.ts`
- Test: `apps/api/src/services/aiTools.test.ts`, `apps/api/src/jobs/intentReleaseWorker.test.ts`

**Interfaces:**
- Produces: `requiresLiveSession(toolName: string, registry?): boolean` — true iff the tool is recognized by `getToolTier` but not resolvable by `executeTool` (i.e. session-aware M365 mutations + all Google tools).

- [ ] **Step 1: Write the failing predicate test**

Add to `aiTools.test.ts`:
```ts
import { requiresLiveSession } from './aiTools';

describe('requiresLiveSession', () => {
  it('is true for session-aware M365 mutation tools', () => {
    expect(requiresLiveSession('m365_disable_user')).toBe(true);
    expect(requiresLiveSession('m365_reset_password')).toBe(true);
  });
  it('is true for Google tools (never registered headless)', () => {
    expect(requiresLiveSession('google_suspend_user')).toBe(true);
    expect(requiresLiveSession('google_reset_password')).toBe(true);
  });
  it('is false for the registered Tier-1 M365 read tools', () => {
    expect(requiresLiveSession('m365_query_users')).toBe(false);
  });
  it('is false for stateless core tools', () => {
    expect(requiresLiveSession('execute_command')).toBe(false);
  });
  it('is false for an unknown name (not a recognized tool at all)', () => {
    expect(requiresLiveSession('not_a_real_tool')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `cd apps/api && pnpm vitest run aiTools -t requiresLiveSession`
Expected: FAIL — `requiresLiveSession is not a function`.

- [ ] **Step 3: Implement the predicate**

Add to `aiTools.ts` (near `getToolTier`, reusing the same `registry` default and `getToolTier`/`aiTools`/`resolveExtensionTool` already in scope):
```ts
/**
 * True iff a tool is recognized (getToolTier defined) but NOT executable by the
 * headless `executeTool` path — i.e. it only runs via the inline chat path's
 * makeSessionAwareHandler, which threads a live SSE session id to reach the
 * per-tenant M365/Google OAuth connection. Covers the M365 mutation helpdesk
 * tools (m365_disable_user, m365_reset_password) and ALL Google tools (there is
 * no registerGoogleTools into the core map). The durable release worker uses
 * this to fail such intents with `session_required` instead of `Unknown tool`.
 * Phase 2 (headless dispatch) would make these executable and flip this to false.
 */
export function requiresLiveSession(
  toolName: string,
  registry: ExtensionContributionRegistry = extensionContributionRegistry,
): boolean {
  const executableHeadless = aiTools.has(toolName) || registry.getAiTool(toolName) !== undefined;
  return !executableHeadless && getToolTier(toolName, registry) !== undefined;
}
```

- [ ] **Step 4: Write the failing worker test**

Add to `intentReleaseWorker.test.ts`:
```ts
it('fails a session-aware tool with session_required and never calls executeTool', async () => {
  // claim CAS -> true, revalidation ok, intent.actionName = 'm365_disable_user'
  vi.mocked(requiresLiveSession).mockReturnValue(true);
  await releaseApprovedIntent('intent-2');
  expect(executeTool).not.toHaveBeenCalled();
  expect(transitionIntent).toHaveBeenCalledWith(
    'intent-2', 'executing', 'failed',
    expect.objectContaining({ errorCode: 'session_required' }),
  );
});
```
(Add `requiresLiveSession` to the `../services/aiTools` mock.)

- [ ] **Step 5: Run it — verify it fails**

Run: `cd apps/api && pnpm vitest run intentReleaseWorker -t session_required`
Expected: FAIL — executeTool is still called / no `session_required`.

- [ ] **Step 6: Implement the worker gate**

In `intentReleaseWorker.ts`, update the import and add the gate **after** revalidation succeeds (`:241`, after `const { auth } = revalidation;`) and **before** the exec try-block:
```ts
import { executeTool, requiresLiveSession } from '../services/aiTools';
```
```ts
  const { auth } = revalidation;

  // Phase-1 guard: the headless worker cannot run session-aware M365/Google
  // Tier-3 tools — they need a live SSE session's per-tenant OAuth connection
  // (see services/aiAgentSdkTools.ts makeSessionAwareHandler). executeTool would
  // throw `Unknown tool`; fail with an explicit, categorized code instead. The
  // inline chat path still runs these under its live session. Headless dispatch
  // is deferred (Phase 2).
  if (requiresLiveSession(intent.actionName)) {
    await failIntent(intent, 'session_required', { details: { actionName: intent.actionName } });
    return;
  }
```
(`failIntent`'s default `executed:false` correctly leaves `executedAt` null — nothing ran.)

- [ ] **Step 7: Run tests — verify pass**

Run: `cd apps/api && pnpm vitest run aiTools intentReleaseWorker`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/aiTools.ts apps/api/src/services/aiTools.test.ts apps/api/src/jobs/intentReleaseWorker.ts apps/api/src/jobs/intentReleaseWorker.test.ts
git commit -m "fix(intents): fail session-aware M365/Google tier-3 releases as session_required"
```

---

## Task 4: Add `execution_started_at`; rekey the stale-execution reaper (④, DB + reaper half)

The reaper keys stale detection off `decided_at` (`intentExpiryReaper.ts:209`), but approval→execution can lag decision. Add a dedicated `execution_started_at` lifecycle timestamp and rekey the reaper onto it, falling back to `decided_at` via `COALESCE` for rows that predate the column or were never stamped.

**Files:**
- Modify: `apps/api/src/db/schema/actionIntents.ts`
- Create: `apps/api/migrations/2026-07-19-action-intents-execution-started-at.sql`
- Modify: `apps/api/src/services/actionIntents/intentService.ts` (`ActionIntentTransitionPatch` type)
- Modify: `apps/api/src/jobs/intentExpiryReaper.ts`
- Create: `apps/api/src/jobs/intentExpiryReaper.integration.test.ts`
- Modify: `apps/api/vitest.integration.config.ts` (add the new integration test to `include`)

- [ ] **Step 1: Add the schema column**

In `actionIntents.ts`, in the "Lifecycle (mutable)" block (after `decidedVia` at `:105`, before `executedAt` at `:106`):
```ts
    executionStartedAt: timestamp('execution_started_at', { withTimezone: true }),
```

- [ ] **Step 2: Write the migration**

```sql
-- apps/api/migrations/2026-07-19-action-intents-execution-started-at.sql
-- Adds execution_started_at: the timestamp the release worker CASes the intent
-- approved -> executing. Stale-execution detection keys off this (not decided_at,
-- which can precede execution start). Lifecycle column — deliberately NOT added
-- to action_intents_immutable_trg (the deny-list trigger guards identity/content
-- columns only; lifecycle timestamps are mutable by design).
ALTER TABLE action_intents
  ADD COLUMN IF NOT EXISTS execution_started_at TIMESTAMPTZ;
```

- [ ] **Step 3: Verify no drift**

Run: `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:check-drift`
Expected: schema matches migrations, no drift. (If the local dev DB isn't up, run the migration via the integration harness in Step 7 instead and note it.)

- [ ] **Step 4: Extend the transition patch type**

In `intentService.ts`, find `ActionIntentTransitionPatch` (the `patch?` type on `transitionIntent`, ~`:554`). Add the optional field so the worker can stamp it through the existing `.set({ status: to, ...patch })`:
```ts
  executionStartedAt?: Date | null;
```
(No other change to `transitionIntent` — it spreads `patch` into the `UPDATE ... SET` already.)

- [ ] **Step 5: Rekey the reaper**

In `intentExpiryReaper.ts` `reapStaleExecutingIntents` (`:203-228`), replace the `decided_at` predicate/order/return with `execution_started_at`, `COALESCE`-ing to `decided_at` for null-stamped rows:
```ts
  const transitioned = await db.execute<StaleExecutingIntentRow>(sql`
    WITH due AS (
      SELECT id
      FROM ${actionIntents}
      WHERE ${actionIntents.status} = 'executing'
        AND ${actionIntents.executedAt} IS NULL
        AND COALESCE(${actionIntents.executionStartedAt}, ${actionIntents.decidedAt})
              < now() - (${STALE_EXECUTING_TIMEOUT_MINUTES} * interval '1 minute')
      ORDER BY COALESCE(${actionIntents.executionStartedAt}, ${actionIntents.decidedAt}) ASC
      LIMIT ${MAX_REAP_PER_RUN}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ${actionIntents} AS a
    SET status = 'failed', error_code = 'execution_lost'
    FROM due
    WHERE a.id = due.id AND a.status = 'executing' AND a.executed_at IS NULL
    RETURNING a.id, a.org_id, a.action_name, a.argument_digest, a.source, a.execution_started_at, a.decided_at;
  `);
```
Update `StaleExecutingIntentRow` (`~:107`) to add `execution_started_at: Date | string | null;`. In the audit `details` (`:246-253`), add `executionStartedAt` alongside `decidedAt` (ISO-normalize the same way). Update the file-header doc (`:37-48`) to say the sweep keys off `execution_started_at` (fallback `decided_at`).

- [ ] **Step 6: Write the reaper integration test**

Copy the shape of `suppressionExpiryReaper.integration.test.ts`. Seed a partner→org, insert an `executing` intent with `execution_started_at` older than the timeout (and a second one that's recent), run `reapStaleExecutingIntents`, assert only the stale one flips to `failed`/`execution_lost`. Add a third case: `execution_started_at IS NULL` but `decided_at` old ⇒ still reaped (COALESCE fallback).

```ts
// apps/api/src/jobs/intentExpiryReaper.integration.test.ts
import './__tests__-setup-or-relative-import-to-integration/setup'; // use the same './setup' path the integration tests use
import { describe, it, expect, beforeEach } from 'vitest';
import { db, withSystemDbAccessContext } from '../db';
import { actionIntents } from '../db/schema/actionIntents';
import { eq } from 'drizzle-orm';
import { reapStaleExecutingIntents } from './intentExpiryReaper';
import { createPartner, createOrganization } from '../__tests__/integration/db-utils';

describe('reapStaleExecutingIntents (real PG)', () => {
  let orgId: string;
  beforeEach(async () => {
    const partnerId = await createPartner();
    orgId = await createOrganization({ partnerId });
  });

  async function seedExecuting(fields: { executionStartedAt: Date | null; decidedAt: Date }): Promise<string> {
    return withSystemDbAccessContext(async () => {
      const [row] = await db.insert(actionIntents).values({
        orgId, source: 'chat_web', actionName: 'execute_command', arguments: {},
        argumentDigest: 'd', targetSummary: 't', impactSummary: 'i', riskTier: 3,
        idempotencyKey: crypto.randomUUID(), correlationId: crypto.randomUUID(),
        status: 'executing', expiresAt: new Date(Date.now() + 3_600_000),
        decidedAt: fields.decidedAt, executionStartedAt: fields.executionStartedAt, executedAt: null,
      }).returning({ id: actionIntents.id });
      return row.id;
    });
  }

  it('reaps only intents whose execution start is older than the timeout', async () => {
    const old = new Date(Date.now() - 60 * 60_000);
    const recent = new Date();
    const staleId = await seedExecuting({ executionStartedAt: old, decidedAt: recent });
    const freshId = await seedExecuting({ executionStartedAt: recent, decidedAt: old });
    const nullStampButOldDecided = await seedExecuting({ executionStartedAt: null, decidedAt: old });

    const n = await withSystemDbAccessContext(() => reapStaleExecutingIntents());
    expect(n).toBe(2); // stale + null-stamp-old-decided; NOT the fresh one

    const read = async (id: string) => withSystemDbAccessContext(async () => {
      const [r] = await db.select().from(actionIntents).where(eq(actionIntents.id, id)).limit(1);
      return r;
    });
    expect((await read(staleId)).status).toBe('failed');
    expect((await read(nullStampButOldDecided)).errorCode).toBe('execution_lost');
    expect((await read(freshId)).status).toBe('executing');
  });
});
```
(Adjust the `./setup` import path and `db-utils` helper signatures to match the real files — read `intentFanout.integration.test.ts` for the exact imports. If `reapStaleExecutingIntents` manages its own system context internally, drop the outer `withSystemDbAccessContext` wrapper around it.)

- [ ] **Step 7: Register + run the integration test**

Add `'src/jobs/intentExpiryReaper.integration.test.ts'` to the `include` array in `apps/api/vitest.integration.config.ts`.
Run: `cd apps/api && pnpm vitest run --config vitest.integration.config.ts intentExpiryReaper`
Expected: PASS (migration applied by globalSetup gives the new column).

- [ ] **Step 8: Typecheck + unit reaper tests + commit**

Run: `cd apps/api && pnpm vitest run intentExpiryReaper && NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit`
Expected: green.
```bash
git add apps/api/src/db/schema/actionIntents.ts apps/api/migrations/2026-07-19-action-intents-execution-started-at.sql apps/api/src/services/actionIntents/intentService.ts apps/api/src/jobs/intentExpiryReaper.ts apps/api/src/jobs/intentExpiryReaper.integration.test.ts apps/api/vitest.integration.config.ts
git commit -m "feat(intents): key stale-execution reaping off execution_started_at"
```

---

## Task 5: Worker stamps `execution_started_at` at the claim CAS (④, worker half)

**Files:**
- Modify: `apps/api/src/jobs/intentReleaseWorker.ts`
- Test: `apps/api/src/jobs/intentReleaseWorker.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('stamps execution_started_at when it claims the intent (approved -> executing)', async () => {
  await releaseApprovedIntent('intent-3'); // claim CAS mocked to true, rest short-circuits fine
  expect(transitionIntent).toHaveBeenCalledWith(
    'intent-3', 'approved', 'executing',
    expect.objectContaining({ executedAt: null, executionStartedAt: expect.any(Date) }),
    { requireNotExpired: true },
  );
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `cd apps/api && pnpm vitest run intentReleaseWorker -t "stamps execution_started_at"`
Expected: FAIL — patch has only `{ executedAt: null }`.

- [ ] **Step 3: Implement**

In `intentReleaseWorker.ts`, the claim CAS (`:184-190`):
```ts
  const claimed = await transitionIntent(
    intentId,
    'approved',
    'executing',
    { executedAt: null, executionStartedAt: new Date() },
    { requireNotExpired: true },
  );
```

- [ ] **Step 4: Run tests — verify pass**

Run: `cd apps/api && pnpm vitest run intentReleaseWorker`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/intentReleaseWorker.ts apps/api/src/jobs/intentReleaseWorker.test.ts
git commit -m "feat(intents): stamp execution_started_at at durable release claim"
```

---

## Task 6: Make the decide-path intent fan-in atomic (②)

Today the decide handler transitions the intent (`transitionIntent`, `approvals.ts:763`) in its own transaction, then does sibling-expiry + `intent_approved` outbox insert in a **separate, error-swallowed** transaction (`:782-809`). If the CAS commits but the fan-in is swallowed, the intent is `approved` with **no outbox row → the worker never releases it**, and sibling approvals stay `pending`. Collapse {intent CAS + sibling-expiry + outbox} into ONE system-scoped transaction so they commit all-or-nothing.

**Scope decision (documented):** the deciding user's own approval CAS (`approvals.ts:602-620`) already committed earlier under the request context and stays separate — folding it in would require wrapping the entire ~200-line handler (PAM elevation, `ai_tool_executions` mirror, legacy sibling-expiry) in one transaction, a much larger risk surface. The atomic unit that matters for the worker-release contract is the intent-mirror trio; the approval-vs-intent seam remains eventually-consistent and self-heals via the expiry reaper. This is a deliberate narrowing, not an oversight.

**Files:**
- Modify: `apps/api/src/routes/approvals.ts` (`decideHandler` fan-in `:756-809`; and the identical report-suspicious block `:320-368`)
- Create: `apps/api/src/routes/approvalsDecideAtomicity.integration.test.ts`
- Modify: `apps/api/vitest.integration.config.ts` (`include`)

- [ ] **Step 1: Write the failing atomicity integration test (real PG)**

Using the `intentFanout.integration.test.ts` template (real approver seed + `requesterAuth`/`buildOrgAccessClosures` + the actual decide route or `decideHandler`), assert the **happy path first** so the test is meaningful before the refactor: approve an intent-backed request and assert, in one read, that (a) the intent is `approved`, (b) an `intent_outbox` row with `event_type='intent_approved'` exists for it, and (c) sibling `pending` approvals for the intent are `expired`. Then add the atomicity assertion: with a forced fault injected into the outbox insert (e.g. temporarily monkeypatch `intentOutbox` insert to throw, or assert via a unit-level seam), the intent must **not** be left `approved` without an outbox row — either all three land or none do.

Concretely, the durable/black-box assertion that survives refactoring:
```ts
it('commits intent status, sibling expiry, and the intent_approved outbox atomically', async () => {
  const { intentId, approverA, approverB } = await seedIntentWithTwoApprovers();
  await approveAs(approverA, /* the approval_request id */);

  await withSystemDbAccessContext(async () => {
    const [intent] = await db.select().from(actionIntents).where(eq(actionIntents.id, intentId));
    expect(intent.status).toBe('approved');

    const outbox = await db.select().from(intentOutbox)
      .where(and(eq(intentOutbox.intentId, intentId), eq(intentOutbox.eventType, 'intent_approved')));
    expect(outbox).toHaveLength(1);

    const siblings = await db.select().from(approvalRequests)
      .where(and(eq(approvalRequests.intentId, intentId), eq(approvalRequests.status, 'pending')));
    expect(siblings).toHaveLength(0); // approverB's row expired in the same commit
  });
});
```
For the fault-injection half, prefer a focused unit test in `approvals.test.ts` that stubs the outbox insert to reject and asserts the intent status was **not** advanced to `approved` (i.e. the transaction rolled the CAS back) — this is the property the single-transaction refactor delivers and the current three-transaction code cannot.

- [ ] **Step 2: Register + run — verify the atomicity/fault test fails on current code**

Add `'src/routes/approvalsDecideAtomicity.integration.test.ts'` to `include`. Run it.
Expected: the happy-path assertions may pass, but the fault-injection assertion FAILS on current code (CAS commits independently of the swallowed fan-in).

- [ ] **Step 3: Refactor `decideHandler` to one atomic transaction**

Replace the `transitionIntent(...)` call (`:763-768`) **and** the separate `runOutsideDbContext(withSystemDbAccessContext(db.transaction(...)))` fan-in (`:782-806`) with a single `withSystemDbAccessContext(db.transaction(...))` that does the intent CAS inline and, only if it affected a row, the sibling-expiry + outbox insert — all in the same `tx`:
```ts
  if (updated?.intentId && linkedIntent) {
    const intentId = updated.intentId;
    const intentTargetStatus: ActionIntentStatus = status === 'approved' ? 'approved' : 'rejected';
    const soleOperatorApproval = status === 'approved' && linkedIntent.requestedByUserId === userId;

    let wonIntent = false;
    try {
      // Atomic intent fan-in: CAS + sibling expiry + outbox in ONE system-scoped
      // transaction, so an `approved` intent can never exist without its
      // intent_approved outbox row (which is what the release worker consumes).
      // System scope: approval_requests is Shape-6, sibling rows belong to OTHER
      // approvers and are invisible under this approver's request context.
      wonIntent = await runOutsideDbContext(() =>
        withSystemDbAccessContext(() =>
          db.transaction(async (tx) => {
            const cas = await tx
              .update(actionIntents)
              .set({
                status: intentTargetStatus,
                decidedAt: new Date(),
                decidedByUserId: userId,
                decidedAssuranceLevel: assurance.decidedAssuranceLevel,
                decidedVia: assurance.decidedVia,
              })
              .where(and(eq(actionIntents.id, intentId), eq(actionIntents.status, 'pending_approval')))
              .returning({ id: actionIntents.id });
            if (cas.length === 0) return false; // lost the race — clean no-op

            await tx.update(approvalRequests)
              .set({ status: 'expired', decidedAt: new Date() })
              .where(and(
                eq(approvalRequests.intentId, intentId),
                eq(approvalRequests.status, 'pending'),
                ne(approvalRequests.id, updated.id),
              ));

            if (status === 'approved') {
              await tx.insert(intentOutbox).values({
                intentId,
                eventType: 'intent_approved',
                payload: { intentId, orgId: linkedIntent!.orgId },
              });
            }
            return true;
          }),
        ),
      );
    } catch (err) {
      // The user's own approval already committed above; a failure of the intent
      // mirror rolls back ALL of {CAS, sibling expiry, outbox} together (no
      // partial state) and leaves the intent pending_approval for re-decide/expiry.
      console.error('[approvals] Failed atomic intent fan-in (CAS / sibling expiry / outbox):', err);
      wonIntent = false;
    }

    if (wonIntent) {
      recordActionIntentEvent({ /* unchanged — same metrics call as today */ });
    }
  }
```
Preserve the exact `recordActionIntentEvent` payload that follows (`:811+`). Confirm `and`, `eq`, `ne`, `actionIntents`, `intentOutbox`, `approvalRequests`, `runOutsideDbContext`, `withSystemDbAccessContext`, `db` are all imported in `approvals.ts` (most already are — the old fan-in used them).

- [ ] **Step 4: Mirror the same refactor in the report-suspicious handler**

Apply the identical single-transaction collapse to the report-suspicious block (`approvals.ts:320-368`) — it has the same `transitionIntent` + swallowed fan-in shape. (Its intent target is `rejected`/sibling-expiry; there is no `intent_approved` outbox for a rejection, mirror only what that block writes today.)

- [ ] **Step 5: Run the atomicity tests — verify pass**

Run: `cd apps/api && pnpm vitest run --config vitest.integration.config.ts approvalsDecideAtomicity && pnpm vitest run approvals`
Expected: fault-injection and happy-path assertions PASS; existing decide-handler unit tests still green.

- [ ] **Step 6: Commit, then code-review checkpoint**

```bash
git add apps/api/src/routes/approvals.ts apps/api/src/routes/approvalsDecideAtomicity.integration.test.ts apps/api/vitest.integration.config.ts
git commit -m "fix(intents): make decide-path intent fan-in atomic"
```
Then run one round of `superpowers:requesting-code-review` focused on: transaction scope correctness, that the CAS still first-wins, that no partial state is possible, and that the `recordActionIntentEvent` semantics are unchanged.

---

## Task 7: Collapse the create path into one atomic transaction (①)

`createActionIntent` inserts the intent org-scoped (TX1, `intentService.ts:250-327`), commits, then does fan-out + outbox system-scoped (TX2, `:362-427`). The FKs point child→parent, so a **single** transaction sees its own uncommitted parent row — the two-transaction split is only needed because they were separate connections at different scopes. Collapse into ONE system-scoped transaction so a crash between TX1 and TX2 can't strand a `pending_approval` intent with no approvers/outbox.

**Scope decision (documented):** collapsing forces the intent INSERT from org-scoped RLS into the system-scoped transaction (you cannot re-scope mid-transaction; the `approval_requests` fan-out requires system scope). This trades one layer of defense-in-depth (org-access RLS re-checking the insert) for atomicity. Mitigations: (a) the caller has already completed app-layer authz before this point; (b) `org_id` is taken from the authenticated `auth`, not user input; (c) the release/decide paths re-validate org access; (d) `intent_outbox` and the fan-out are already system-only, so the whole operation being system-scoped is internally consistent. The integration test in Step 1 proves cross-tenant reads remain denied.

**Files:**
- Modify: `apps/api/src/services/actionIntents/intentService.ts` (`createActionIntent`, `:246-439`)
- Create: `apps/api/src/services/actionIntents/createIntentAtomicity.integration.test.ts`
- Modify: `apps/api/vitest.integration.config.ts` (`include`)

- [ ] **Step 1: Write the failing atomicity + RLS integration test (real PG)**

Two assertions, both against real breeze_app RLS (template: `intentFanout.integration.test.ts`):
1. **Atomicity:** inject a fault into the fan-out/outbox portion (e.g. stub `intentOutbox` insert to throw once) and assert that after `createActionIntent` rejects, **no** `action_intents` row for that idempotency key exists in a live status — the whole insert rolled back (today TX1 commits and the catch marks it `failed`, leaving a terminal row; after the refactor there is no committed row at all). Assert whichever invariant the single-transaction design delivers: no *live* orphan, and no partial fan-out (zero `approval_requests`, zero `intent_outbox`).
2. **RLS still holds:** create an intent for org A under org A's context; then, using the raw `getAppDb()` breeze_app handle under org B's context, assert a `SELECT` for that intent id returns **zero rows** (cross-tenant read still denied — the system-scoped insert did not weaken row visibility, because `org_id` is set correctly and RLS filters reads regardless of who inserted).

- [ ] **Step 2: Register + run — verify it fails on current code**

Add `'src/services/actionIntents/createIntentAtomicity.integration.test.ts'` to `include`. Run it.
Expected: the atomicity assertion FAILS on current code (TX1 commits a `failed` row on fan-out fault; not a full rollback).

- [ ] **Step 3: Refactor `createActionIntent` to one system-scoped transaction**

Keep the pre-transaction approver resolution (`:242-244`) as-is (read-only, correctly outside any held context). Merge the TX1 insert/replay logic and the TX2 fan-out/outbox into a single `withSystemDbAccessContext(async () => { ... })`:
- Do the `db.insert(actionIntents)...onConflictDoNothing(...).returning()` and the idempotent-replay re-select inside this one system context (unchanged SQL; only the enclosing scope changes from `withDbAccessContext(dbContext, ...)` to the shared system context).
- If it's a replay, return the replay result (short-circuit) exactly as today.
- Otherwise, in the SAME context/transaction, run the fan-out (`approvalRequests` insert), the no-approver fail-closed branch, and the `intentOutbox` insert.
- Because it's one transaction, a throw anywhere rolls back the intent insert too — so the `catch` that best-effort-marks the intent `failed` via `transitionIntent` (`:428-439`) is **removed**; on error, rethrow an `ActionIntentError('fanout_failed')` (there is no committed row to mark). Keep the post-commit best-effort push block (`:441+`) exactly as-is — it must stay AFTER the context returns (never hold a context across the push, per #1105).
- Delete the now-obsolete TX1/TX2-split comment (`:335-359`) and replace with a short comment explaining the single-system-transaction design + the defense-in-depth tradeoff above.

- [ ] **Step 4: Run the atomicity + RLS tests — verify pass**

Run: `cd apps/api && pnpm vitest run --config vitest.integration.config.ts createIntentAtomicity intentFanout`
Expected: new atomicity + RLS assertions PASS; the existing `intentFanout` suite (fan-out across org+partner, idempotency replay) still PASS — this is the regression guard that the scope change didn't break fan-out or idempotency.

- [ ] **Step 5: Typecheck + unit + commit, then code-review checkpoint**

Run: `cd apps/api && pnpm vitest run intentService && NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit`
```bash
git add apps/api/src/services/actionIntents/intentService.ts apps/api/src/services/actionIntents/createIntentAtomicity.integration.test.ts apps/api/vitest.integration.config.ts
git commit -m "fix(intents): create action intent + fan-out + outbox in one atomic txn"
```
Then one round of `superpowers:requesting-code-review` focused on: the org→system scope change and its RLS implications, idempotency-replay still correct under one transaction, and no held context across the post-commit push.

---

## Task 8: Full verification + PR

**Files:** none (verification + memory).

- [ ] **Step 1: Full API unit suite**

Run: `cd apps/api && pnpm vitest run`
Expected: green (baseline was 15,104 passing before this work).

- [ ] **Step 2: Full integration suite (real PG)**

Run: `cd apps/api && pnpm vitest run --config vitest.integration.config.ts`
Expected: green, including the three new integration files and the RLS-coverage/cascade contract tests (unchanged — column-only schema change).

- [ ] **Step 3: Typecheck + lint**

Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 pnpm exec tsc --noEmit && pnpm exec eslint <all changed files>`
Expected: clean.

- [ ] **Step 4: Drift check**

Run: `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:check-drift`
Expected: no drift.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin ToddHebebrand/action-intents-durability
gh pr create --title "fix(intents): durable approval-layer structural-durability follow-ups" --body "<summary of the 4 items, links spec + this plan, notes Phase-2 headless dispatch deferred>"
```

- [ ] **Step 6: Update memory**

Update `action_intents_durable_approval_review.md`: mark the DEFERRED group as ADDRESSED (create/decide atomicity, worker timeout, execution_started_at reaper, session_required), and record the one remaining open item — **Phase 2: headless dispatch for session-aware M365/Google Tier-3 tools** (capture connectionId/tenant into the immutable intent + a session-less worker dispatch).

---

## Self-Review

- **Spec coverage:** ① Task 7; ② Task 6; ③ Tasks 1–2; ④ Tasks 4–5; ⑤ Task 3; enabling harness Task 0; verification Task 8. All four deferred items + the user's Phase-1 decision on ⑤ are covered.
- **Type consistency:** `requiresLiveSession` (Task 3) used identically in the worker; `executionStartedAt`/`execution_started_at` consistent across schema (Task 4 Step 1), patch type (Task 4 Step 4), reaper (Task 4 Step 5), worker (Task 5); `getToolTimeout`/`withToolTimeout` defined in Task 1 and consumed in Task 2.
- **Deferred by decision (not gaps):** headless dispatch for session-aware tools (Phase 2); folding the approval CAS itself into the decide-path transaction (documented narrowing in Task 6). Both recorded, not silently dropped.
