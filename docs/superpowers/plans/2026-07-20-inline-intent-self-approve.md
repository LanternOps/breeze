# Inline Web Self-Approve (Touch ID) for Tier-3 Action Intents + Tier Recalibration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore in-chat approval of Tier-3 AI tool actions for the sole-operator case — as a WebAuthn (Touch ID / Windows Hello) tap in the chat card — and downgrade three over-tiered action groups to Tier 2.

**Architecture:** PR #2625 moved Tier-3 chat tools onto durable `action_intents` decided via `POST /api/v1/mobile/approvals/:id/approve`, and the web chat card (`AiApprovalDialog`) stopped rendering approve/deny for intent-backed executions. The decide API is *not* mobile-gated and already accepts a browser WebAuthn proof at assurance level 3 — which is exactly what the sole-operator self-approve gate (`approvals.ts:606-615`) requires. This plan: (1) has `createActionIntent` report the *requester's own* approval-row id (non-null only when the requester received a fan-out row, i.e. the sole-operator branch), (2) carries that id through the `approval_required` SSE event to the web, (3) renders Approve/Deny on the intent-backed chat card when that id is present, running the existing `getApprovalAssertion` WebAuthn ceremony (same pattern as `PamRespondModal`) and POSTing the proof to the existing decide endpoint. Separately, (4) moves `file_operations:list`, `manage_patches:scan`, and ticket timer actions from Tier 3 to Tier 2 in `aiGuardrails.ts`.

**Tech Stack:** Hono (API), Drizzle mocks in Vitest (API unit tests), React + zustand + Vitest/jsdom (web), `@simplewebauthn/browser` (already wrapped by `apps/web/src/stores/authenticator.ts`).

## Global Constraints

- **Branch:** create `feat/inline-intent-self-approve` off `main`. Do NOT commit onto `fix/web-dockerfile-extension-web-sdk-manifest`. Pre-existing modified files in the worktree (`apps/docs/...`, `scripts/docs-review/...`) are user WIP — never stage, stash, or revert them.
- **i18n parity:** every new key added to `apps/web/src/locales/en/ai.json` MUST be added to ALL locales in the same commit: `de-DE`, `es-419`, `fr-FR`, `pt-BR` (CI enforces key parity; a missing key reds main).
- **`runAction` rule (project CLAUDE.md):** web mutation POSTs must go through `runAction` (`apps/web/src/lib/runAction.ts`) so outcomes are always surfaced.
- **No new endpoints, no schema/migration changes.** The decide API, WebAuthn registration, and assertion routes all exist. The web calls the existing `/mobile/approvals` mount (the `/mobile` prefix is cosmetic — `mobileDeviceBlockedMiddleware` only acts when the `X-Breeze-Mobile-Device-Id` header is present).
- **Security invariants that must NOT be weakened:** `file_operations:read` stays Tier 3 (SR5-01 — root-context file reads are exfiltration). The L3 self-approve gate in `approvals.ts` is untouched — the web card *satisfies* it with a WebAuthn proof; it never bypasses it. Multi-approver fan-out still excludes the requester; the inline buttons only appear when the server fanned a row out *to the requester* (sole-operator branch).
- Run API tests with `pnpm test --filter=@breeze/api -- <file>`; web tests with `pnpm test --filter=@breeze/web -- <file>`. Node must be the pinned 22.x (`nvm use` if needed).

---

### Task 1: Guardrail tier recalibration

**Files:**
- Modify: `apps/api/src/services/aiGuardrails.ts:30-106` (TIER2_ACTIONS / TIER3_ACTIONS)
- Modify: `apps/api/src/services/aiToolsFilesystem.ts:66` (tool description text)
- Test: `apps/api/src/services/aiGuardrails.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `checkGuardrails('file_operations', {action:'list'})` → `{tier: 2, requiresApproval: false}`; same for `manage_patches:scan` and `manage_tickets:log_time_entry|start_timer|stop_timer`. Task 2's tier gate (`createActionIntent` rejects tier ≤ 2) is unaffected because these actions simply stop reaching the intent path.

Tier resolution order in `checkGuardrails` (`aiGuardrails.ts:699-735`) is TIER1 → TIER3 → TIER2 → base tier, so an action removed from TIER3 **must** be added to TIER2 or it falls to the tool's base tier (1 for all three tools — no audit trail).

- [ ] **Step 1: Update the existing tier expectations in the test file (these become the failing tests)**

In `apps/api/src/services/aiGuardrails.test.ts`:

1. The Tier-3 case table (around lines 149-151) currently contains `['manage_patches', 'scan']`. Remove that entry (keep `install` and `rollback`).
2. In the Tier-2 case table (the block around lines 117-120 with `['manage_patches', 'approve']` etc.), add:

```ts
      ['manage_patches', 'scan'],
      ['manage_tickets', 'log_time_entry'],
      ['manage_tickets', 'start_timer'],
      ['manage_tickets', 'stop_timer'],
      ['file_operations', 'list'],
```

3. Search the file for other assertions pinning these actions to tier 3 (`grep -n "start_timer\|log_time_entry\|'scan'\|'list'" apps/api/src/services/aiGuardrails.test.ts`) and update any that assert tier 3 for the downgraded actions. If `file_operations` read/write assertions exist, leave them at tier 3.
4. Add a pinning describe block so the SR5-01 boundary is explicit:

```ts
describe('file_operations tier boundary (SR5-01 partial relaxation)', () => {
  it('list is Tier 2 (auto-execute + audit) — recon only, deliberate downgrade', () => {
    const result = checkGuardrails('file_operations', { action: 'list', deviceId: 'd1', path: '/tmp' });
    expect(result.tier).toBe(2);
    expect(result.requiresApproval).toBe(false);
    expect(result.allowed).toBe(true);
  });

  it.each(['read', 'write', 'delete', 'mkdir', 'rename'])(
    '%s stays Tier 3 (root-context content access requires approval)',
    (action) => {
      const result = checkGuardrails('file_operations', { action, deviceId: 'd1', path: '/tmp/x' });
      expect(result.tier).toBe(3);
      expect(result.requiresApproval).toBe(true);
    },
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test --filter=@breeze/api -- aiGuardrails.test.ts`
Expected: FAIL — `file_operations list` returns tier 3, `manage_patches scan` returns tier 3, timer actions return tier 3.

- [ ] **Step 3: Update the tier lists**

In `apps/api/src/services/aiGuardrails.ts`:

TIER2_ACTIONS — change the `manage_tickets` and `manage_patches` entries and add `file_operations`:

```ts
const TIER2_ACTIONS: Record<string, string[]> = {
  manage_alerts: ['acknowledge', 'resolve', 'suppress'],
  manage_tickets: [
    'create',
    'comment',
    'assign',
    'update_status',
    'update_fields',
    'link_alert',
    'unlink_alert',
    'create_from_alert',
    'edit_comment',
    'delete_comment',
    // Time-tracking downgraded from Tier 3 (2026-07-20): starting/stopping a
    // timer or logging time is org-internal bookkeeping, consistent with
    // create/comment above. move_org stays Tier 3 (tenant-shape mutation).
    'log_time_entry',
    'start_timer',
    'stop_timer'
  ],
  manage_services: ['list'],
  // SR5-01 partial relaxation (2026-07-20): directory LISTING is recon-only —
  // filenames leak far less than contents — so it auto-executes with audit.
  // file READ stays Tier 3 below: the agent runs as root/LocalSystem and an
  // unapproved read can exfiltrate any file's contents.
  file_operations: ['list'],
  // Fleet tools — Tier 2 actions (auto-execute + audit)
  manage_configuration_policy: ['activate', 'deactivate'],
  manage_deployments: ['pause', 'resume'],
  // scan downgraded from Tier 3 (2026-07-20): discovery, not mutation —
  // consistent with approve/decline/defer here. install/rollback stay Tier 3.
  manage_patches: ['approve', 'decline', 'defer', 'bulk_approve', 'scan'],
  ...
```

(Leave every other entry exactly as it is.)

TIER3_ACTIONS — remove the three downgraded actions and update the SR5-01 comment:

```ts
const TIER3_ACTIONS: Record<string, string[]> = {
  // SR5-01: filesystem READ is privileged. The endpoint agent runs as
  // root/LocalSystem and does not restrict reads to an approved root, so an
  // unapproved read can exfiltrate any file (/etc/shadow, SAM hive, SSH keys).
  // Require interactive approval (Tier 3) for read, same as the mutations.
  // `list` was deliberately downgraded to Tier 2 (2026-07-20) — recon-only.
  file_operations: ['read', 'write', 'delete', 'mkdir', 'rename'],
  ...
  manage_patches: ['install', 'rollback'],
  ...
  manage_tickets: ['move_org'],
  ...
```

(`manage_patches` loses `'scan'`; `manage_tickets` loses the three timer actions and keeps only `'move_org'`.)

- [ ] **Step 4: Update the tool description**

`apps/api/src/services/aiToolsFilesystem.ts:66` — replace the description string:

```ts
      description: 'Perform file operations on a device. list auto-executes with audit; read, write, delete, mkdir and rename require approval because the agent reads/writes as root/LocalSystem.',
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test --filter=@breeze/api -- aiGuardrails.test.ts`
Expected: PASS. Also run the neighbors that pin tier behavior: `pnpm test --filter=@breeze/api -- aiGuardrails.bootstrapParity.test.ts aiToolsFleet.test.ts aiToolsTicketing.test.ts intentService.test.ts` — all PASS (if any assert the old tiers for the downgraded actions, update them the same way as Step 1).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/aiGuardrails.ts apps/api/src/services/aiGuardrails.test.ts apps/api/src/services/aiToolsFilesystem.ts
git commit -m "feat(ai): downgrade file list, patch scan, ticket timers to Tier 2

file_operations:list, manage_patches:scan, and ticket time-tracking no
longer require interactive approval — they auto-execute with audit
(Tier 2). file READ/WRITE stay Tier 3 (SR5-01: agent runs as root).
Partially relaxes SR5-01 for list only, deliberately."
```

---

### Task 2: `createActionIntent` reports the requester's own approval-row id

**Files:**
- Modify: `apps/api/src/services/actionIntents/intentService.ts` (types at 77-87 + 176-182, `toSnapshot` at 158, dedup branch at 340-350, fan-out branches at 372-391, returns at 479 and 486-495)
- Test: `apps/api/src/services/actionIntents/intentService.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `ActionIntentSnapshot.requesterApprovalRequestId: string | null` — the id of the `approval_requests` row fanned out **to the requester**, or `null` when the requester holds no row (multi-approver fan-out, or no approvers). Task 3 reads this field.

- [ ] **Step 1: Write the failing tests**

In `apps/api/src/services/actionIntents/intentService.test.ts`, extend the existing fan-out describe block (`createActionIntent — approver fan-out`, ~line 369). The existing tests already assert `snapshot.approvalRequestIds` for the multi-approver (`['approval-1','approval-2']`, ~line 385), sole-operator (`['approval-solo']`, ~line 409), and no-approver (`[]`, ~line 430) cases — add one assertion to each, in the same tests or as siblings using the identical mock setup:

```ts
  // In the multi-approver test (fan-out excludes the requester):
  expect(snapshot.requesterApprovalRequestId).toBeNull();

  // In the sole-operator test:
  expect(snapshot.requesterApprovalRequestId).toBe('approval-solo');

  // In the no-eligible-approvers (immediate-cancel) test:
  expect(snapshot.requesterApprovalRequestId).toBeNull();
```

And in the idempotent-replay test (`createActionIntent — idempotency`, ~line 354, which asserts `approvalRequestIds: ['approval-existing']`): the dedup branch now also selects `userId` per row. Update that test's mocked `approval_requests` select to return `[{ id: 'approval-existing', userId: <the requester id used by the test> }]` and assert:

```ts
  expect(snapshot.requesterApprovalRequestId).toBe('approval-existing');
```

(If the mocked row's `userId` differs from the requester, assert `toBeNull()` instead — match whichever fixture the test already uses; add the second variant as a new test if cheap.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test --filter=@breeze/api -- actionIntents/intentService.test.ts`
Expected: FAIL — `requesterApprovalRequestId` is `undefined`.

- [ ] **Step 3: Implement**

In `apps/api/src/services/actionIntents/intentService.ts`:

1. `ActionIntentSnapshot` (line 77-87) — add:

```ts
  /**
   * The approval_requests row fanned out to the REQUESTER, when one exists —
   * i.e. the sole-operator branch (requester is the only eligible approver).
   * null on a multi-approver fan-out (spec §4: the requester is excluded) and
   * when there are no approvers. The web chat card uses this to offer an
   * inline L3 self-approve (WebAuthn) for exactly this row and no other.
   */
  requesterApprovalRequestId: string | null;
```

2. `toSnapshot` (line 158) — add the third parameter and field:

```ts
function toSnapshot(
  intent: ActionIntent,
  approvalRequestIds: string[],
  requesterApprovalRequestId: string | null,
): ActionIntentSnapshot {
  return {
    id: intent.id,
    status: intent.status,
    actionName: intent.actionName,
    argumentDigest: intent.argumentDigest,
    source: intent.source,
    expiresAt: intent.expiresAt,
    result: intent.result,
    errorCode: intent.errorCode,
    approvalRequestIds,
    requesterApprovalRequestId,
  };
}
```

3. `CreationResult` (line 176-182) — add `requesterApprovalRequestId: string | null;`.

4. Dedup/replay branch (lines 340-350) — select `userId` too and resolve the requester's row:

```ts
        const approvalRows = await db
          .select({ id: approvalRequests.id, userId: approvalRequests.userId })
          .from(approvalRequests)
          .where(eq(approvalRequests.intentId, existing.id));
        return {
          intent: existing,
          approvalRequestIds: approvalRows.map((r) => r.id),
          requesterApprovalRequestId:
            approvalRows.find((r) => r.userId === requesterId)?.id ?? null,
          fanOutUserIds: [],
          isNew: false,
        };
```

5. Fresh fan-out: initialize `let requesterApprovalRequestId: string | null = null;` next to `approvalRequestIds`/`fanOutUserIds` (line 354-355). The multi-approver branch (line 372-378) leaves it `null`. In the sole-operator branch (line 379-391) set it:

```ts
        if (rows[0]) {
          approvalRequestIds = [rows[0].id];
          requesterApprovalRequestId = rows[0].id;
          fanOutUserIds = [requesterId];
        }
```

Include `requesterApprovalRequestId` in the transaction's `return { intent: finalIntent, ... }` (line 417).

6. Both `toSnapshot` call sites for creation: line 479 becomes

```ts
  return toSnapshot(creation.intent, creation.approvalRequestIds, creation.requesterApprovalRequestId);
```

7. `getActionIntent` (line 486-495) — select `userId` and match against the intent's own requester:

```ts
    const approvalRows = await db
      .select({ id: approvalRequests.id, userId: approvalRequests.userId })
      .from(approvalRequests)
      .where(eq(approvalRequests.intentId, intent.id));
    return toSnapshot(
      intent,
      approvalRows.map((r) => r.id),
      approvalRows.find((r) => r.userId === intent.requestedByUserId)?.id ?? null,
    );
```

(Adapt variable names to the actual surrounding code — read the function before editing.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test --filter=@breeze/api -- actionIntents/intentService.test.ts`
Expected: PASS. Then typecheck for other `toSnapshot`/snapshot consumers: `pnpm --filter=@breeze/api typecheck` (or `pnpm typecheck` at root if no per-package script). Fix any consumer that constructs an `ActionIntentSnapshot` literal (search: `grep -rn "approvalRequestIds:" apps/api/src --include="*.ts" | grep -v test | grep -v intentService.ts`).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/actionIntents/intentService.ts apps/api/src/services/actionIntents/intentService.test.ts
git commit -m "feat(intents): expose the requester's own approval-row id on the snapshot"
```

---

### Task 3: Carry `selfApprovalRequestId` through the `approval_required` event

**Files:**
- Modify: `packages/shared/src/types/ai.ts:121` (event union member)
- Modify: `apps/api/src/services/aiAgentSdk.ts:592-601` (event publish)
- Modify: `apps/web/src/stores/processStreamEvent.ts:24-32` (PendingApproval) and `:126-137` (event case)
- Test: `apps/api/src/services/aiAgentSdk.test.ts` (only if it exists and asserts the publish payload — check with `ls apps/api/src/services/aiAgentSdk*.test.ts`); `apps/web/src/stores/processStreamEvent.test.ts` (check existence: `ls apps/web/src/stores/*.test.ts`)

**Interfaces:**
- Consumes: `ActionIntentSnapshot.requesterApprovalRequestId` (Task 2).
- Produces: `approval_required` SSE events carry optional `selfApprovalRequestId?: string` — set ONLY when the server fanned an approval row out to the requester. `PendingApproval.selfApprovalRequestId?: string` on the web. Tasks 5–6 read this.

- [ ] **Step 1: Write the failing web test**

If `apps/web/src/stores/processStreamEvent.test.ts` exists, add (mirroring its existing `approval_required` case style); if it does not exist, create it minimally:

```ts
import { describe, it, expect } from 'vitest';
import { processStreamEvent, type StreamableState } from './processStreamEvent';

function makeState(): StreamableState {
  return {
    messages: [], pendingApproval: null, pendingPlan: null, activePlan: null,
    approvalMode: 'per_step', isPaused: false, isStreaming: true,
    error: null, sessionId: 's1', sessions: [],
  };
}

describe('approval_required — selfApprovalRequestId passthrough', () => {
  it('carries selfApprovalRequestId into pendingApproval', () => {
    const state = makeState();
    let patch: Partial<StreamableState> = {};
    processStreamEvent(
      {
        type: 'approval_required', executionId: 'e1', toolName: 'file_operations',
        input: { action: 'read' }, description: 'Read a file',
        intentBacked: true, selfApprovalRequestId: 'ap-1',
      },
      (fn) => { patch = { ...patch, ...fn({ ...state, ...patch }) }; },
      () => ({ ...state, ...patch }),
      null,
    );
    expect(patch.pendingApproval).toMatchObject({
      executionId: 'e1', intentBacked: true, selfApprovalRequestId: 'ap-1',
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test --filter=@breeze/web -- processStreamEvent`
Expected: FAIL — TypeScript rejects `selfApprovalRequestId` on the event type (or the assertion fails).

- [ ] **Step 3: Implement all three layers**

1. `packages/shared/src/types/ai.ts:121` — inside the `approval_required` member, after `approvalRequestId?: string;` add `selfApprovalRequestId?: string;` (keep the single-line union style of the file).

2. `apps/api/src/services/aiAgentSdk.ts:592-601` — the publish becomes:

```ts
        session.eventBus.publish({
          type: 'approval_required',
          executionId: approvalExec.id,
          approvalRequestId: intent.approvalRequestIds[0],
          // Set ONLY when the fan-out created a row for the requester (the
          // sole-operator branch) — the web card offers the inline L3
          // WebAuthn self-approve for exactly that row. In a multi-approver
          // org the requester holds no row and this stays undefined; the
          // card keeps its waiting state (four-eyes preserved).
          selfApprovalRequestId: intent.requesterApprovalRequestId ?? undefined,
          toolName,
          input,
          description,
          deviceContext,
          intentBacked: true,
        });
```

3. `apps/web/src/stores/processStreamEvent.ts` — `PendingApproval` gains:

```ts
  /** Set when the viewer (requester) holds the fanned-out approval row — enables inline L3 self-approve. */
  selfApprovalRequestId?: string;
```

and the `approval_required` case copies it: `selfApprovalRequestId: event.selfApprovalRequestId,` after the `intentBacked` line.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test --filter=@breeze/web -- processStreamEvent` → PASS.
Run: `pnpm test --filter=@breeze/api -- aiAgentSdk` → PASS (update payload assertions if any test pins the exact publish object).
Run the shared package build/typecheck: `pnpm --filter=@breeze/shared build` (or `typecheck`) → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/ai.ts apps/api/src/services/aiAgentSdk.ts apps/web/src/stores/processStreamEvent.ts apps/web/src/stores/processStreamEvent.test.ts
git commit -m "feat(intents): carry the requester's approval-row id on approval_required events"
```

---

### Task 4: Web decide helper — `decideIntentApproval`

**Files:**
- Create: `apps/web/src/lib/intentApprovals.ts`
- Test: `apps/web/src/lib/intentApprovals.test.ts`

**Interfaces:**
- Consumes: `getApprovalAssertion` (`apps/web/src/stores/authenticator.ts:95` — signature `getApprovalAssertion(basePath: string, id: string): Promise<AssertionProof>`, throws `Error` with `name === 'NoApproverDeviceError'` when no device is registered); `runAction`/`ActionError` (`apps/web/src/lib/runAction.ts`); `fetchWithAuth` (`apps/web/src/stores/auth.ts`).
- Produces: `decideIntentApproval(approvalRequestId: string, decision: 'approve' | 'deny'): Promise<IntentDecisionOutcome>` where `type IntentDecisionOutcome = 'decided' | 'needs_device'`. Throws on ceremony cancel/failure and on server rejection (after `runAction` has toasted). Task 5 calls this.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/lib/intentApprovals.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getApprovalAssertion = vi.fn();
const runAction = vi.fn();
vi.mock('../stores/authenticator', () => ({
  getApprovalAssertion: (...args: unknown[]) => getApprovalAssertion(...args),
}));
vi.mock('./runAction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./runAction')>();
  return { ...actual, runAction: (...args: unknown[]) => runAction(...args) };
});
vi.mock('../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import { decideIntentApproval } from './intentApprovals';

const PROOF = { type: 'webauthn_platform', credentialId: 'c1' };

beforeEach(() => {
  vi.clearAllMocks();
  runAction.mockResolvedValue(undefined);
});

describe('decideIntentApproval', () => {
  it('approve: runs the assertion ceremony against /mobile/approvals and POSTs the proof', async () => {
    getApprovalAssertion.mockResolvedValue(PROOF);
    const outcome = await decideIntentApproval('ap-1', 'approve');
    expect(outcome).toBe('decided');
    expect(getApprovalAssertion).toHaveBeenCalledWith('/mobile/approvals', 'ap-1');
    expect(runAction).toHaveBeenCalledTimes(1);
  });

  it('approve: returns needs_device (no POST) when no approver device is registered', async () => {
    const err = new Error('No registered approver device');
    err.name = 'NoApproverDeviceError';
    getApprovalAssertion.mockRejectedValue(err);
    const outcome = await decideIntentApproval('ap-1', 'approve');
    expect(outcome).toBe('needs_device');
    expect(runAction).not.toHaveBeenCalled();
  });

  it('approve: rethrows a cancelled/failed ceremony without POSTing', async () => {
    getApprovalAssertion.mockRejectedValue(new DOMException('cancelled', 'NotAllowedError'));
    await expect(decideIntentApproval('ap-1', 'approve')).rejects.toBeInstanceOf(DOMException);
    expect(runAction).not.toHaveBeenCalled();
  });

  it('deny: POSTs without any ceremony', async () => {
    const outcome = await decideIntentApproval('ap-1', 'deny');
    expect(outcome).toBe('decided');
    expect(getApprovalAssertion).not.toHaveBeenCalled();
    expect(runAction).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test --filter=@breeze/web -- intentApprovals`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`apps/web/src/lib/intentApprovals.ts`:

```ts
import { fetchWithAuth } from '../stores/auth';
import { getApprovalAssertion } from '../stores/authenticator';
import { runAction } from './runAction';
import i18n from './i18n';

export type IntentDecisionOutcome = 'decided' | 'needs_device';

/**
 * True when the assertion ceremony failed because the user has no registered
 * approver device (challenge carried no allowCredentials). A genuine
 * cancelled/timed-out ceremony is a DOMException and must NOT match — the
 * caller aborts instead. Mirrors PamRespondModal's helper; here the outcome is
 * a "register a device" CTA rather than an L1 fallback, because the
 * sole-operator self-approve gate (approvals.ts) REQUIRES an L3 proof.
 */
function isNoApproverDeviceError(err: unknown): boolean {
  if (err instanceof DOMException) return false;
  return (err as { name?: string } | null)?.name === 'NoApproverDeviceError';
}

/**
 * Decide the viewer's own fanned-out approval row for a Tier-3 action intent
 * (the inline chat self-approve, sole-operator case). Approve runs the
 * WebAuthn (Touch ID / Windows Hello) ceremony first — the server's L3
 * self-approve gate refuses a proofless approve — then POSTs the proof to the
 * existing decide endpoint. Deny needs no proof.
 *
 * Returns 'needs_device' (before any network write) when no approver device
 * is registered. Throws on a cancelled/failed ceremony and on server
 * rejection (runAction has already toasted the latter).
 */
export async function decideIntentApproval(
  approvalRequestId: string,
  decision: 'approve' | 'deny',
): Promise<IntentDecisionOutcome> {
  const body: Record<string, unknown> = {};

  if (decision === 'approve') {
    try {
      body.proof = await getApprovalAssertion('/mobile/approvals', approvalRequestId);
    } catch (err) {
      if (isNoApproverDeviceError(err)) return 'needs_device';
      throw err;
    }
  }

  await runAction({
    request: () =>
      fetchWithAuth(`/mobile/approvals/${approvalRequestId}/${decision === 'approve' ? 'approve' : 'deny'}`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    errorFallback: i18n.t('ai:aiApprovalDialog.decideFailed', {
      defaultValue: 'Failed to submit the decision',
    }),
    successMessage:
      decision === 'approve'
        ? i18n.t('ai:aiApprovalDialog.approvedToast', { defaultValue: 'Action approved' })
        : i18n.t('ai:aiApprovalDialog.deniedToast', { defaultValue: 'Action denied' }),
  });

  return 'decided';
}
```

Check `runAction`'s actual options shape before finalizing (`apps/web/src/lib/runAction.ts`) — match its `request`/`errorFallback`/`successMessage` names exactly as `PamRespondModal.tsx:90-105` does. If the default `i18n` import path differs (see `apps/web/src/lib/i18n.ts` exports), import the same way other lib files do; if none do, take `t` as an optional argument instead and default the strings.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm test --filter=@breeze/web -- intentApprovals`
Expected: PASS.

- [ ] **Step 5: Check the no-silent-mutations guard**

Run: `pnpm test --filter=@breeze/web -- no-silent-mutations`
Expected: PASS (the POST goes through `runAction`). If it flags the new file, register it per the failure message / `apps/web/src/lib/runActionAllowlist.ts` conventions — but it should not, since `runAction` wraps the mutation.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/intentApprovals.ts apps/web/src/lib/intentApprovals.test.ts
git commit -m "feat(web): decideIntentApproval helper — WebAuthn ceremony + decide POST"
```

---

### Task 5: Inline self-approve UI in `AiApprovalDialog` + i18n keys

**Files:**
- Modify: `apps/web/src/components/ai/AiApprovalDialog.tsx`
- Modify: `apps/web/src/locales/en/ai.json`, `apps/web/src/locales/de-DE/ai.json`, `apps/web/src/locales/es-419/ai.json`, `apps/web/src/locales/fr-FR/ai.json`, `apps/web/src/locales/pt-BR/ai.json`
- Test: `apps/web/src/components/ai/AiApprovalDialog.test.tsx`

**Interfaces:**
- Consumes: `decideIntentApproval(approvalRequestId, 'approve' | 'deny'): Promise<'decided' | 'needs_device'>` (Task 4).
- Produces: new optional props on `AiApprovalDialogProps`: `selfApprovalRequestId?: string;` and `onIntentDecided?: () => void;` (called after a successful decide so the parent store clears `pendingApproval`). Task 6 wires them.

Behavior matrix:
- `intentBacked && selfApprovalRequestId` → render Approve (with a fingerprint icon, biometric wording) + Deny buttons. Approve runs the ceremony via `decideIntentApproval`; `'needs_device'` swaps the buttons for a register-CTA linking to `/settings/profile`; a thrown error shows inline error text and re-enables the buttons; `'decided'` calls `onIntentDecided`.
- `intentBacked` without `selfApprovalRequestId` → unchanged (hourglass, no buttons — four-eyes case).
- Non-intent (`!intentBacked`) → unchanged legacy Tier-2 path.

- [ ] **Step 1: Write the failing tests**

Read `apps/web/src/components/ai/AiApprovalDialog.test.tsx` first and follow its existing render/i18n harness exactly (it already renders the component and asserts on the intent-backed hourglass state). Add:

```tsx
const decideIntentApproval = vi.fn();
vi.mock('@/lib/intentApprovals', () => ({
  decideIntentApproval: (...args: unknown[]) => decideIntentApproval(...args),
}));

describe('intent-backed self-approve (sole operator)', () => {
  it('renders Approve/Deny when selfApprovalRequestId is present', () => {
    render(
      <AiApprovalDialog
        toolName="file_operations" description="Read a file" input={{}}
        onApprove={vi.fn()} onReject={vi.fn()}
        intentBacked selfApprovalRequestId="ap-1" onIntentDecided={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /deny/i })).toBeInTheDocument();
  });

  it('keeps the buttonless waiting state without selfApprovalRequestId', () => {
    render(
      <AiApprovalDialog
        toolName="file_operations" description="Read a file" input={{}}
        onApprove={vi.fn()} onReject={vi.fn()} intentBacked
      />,
    );
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });

  it('approve → decideIntentApproval(approve) → onIntentDecided', async () => {
    decideIntentApproval.mockResolvedValue('decided');
    const onIntentDecided = vi.fn();
    render(
      <AiApprovalDialog
        toolName="file_operations" description="Read a file" input={{}}
        onApprove={vi.fn()} onReject={vi.fn()}
        intentBacked selfApprovalRequestId="ap-1" onIntentDecided={onIntentDecided}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() => expect(onIntentDecided).toHaveBeenCalled());
    expect(decideIntentApproval).toHaveBeenCalledWith('ap-1', 'approve');
  });

  it('needs_device → shows the register-device CTA instead of buttons', async () => {
    decideIntentApproval.mockResolvedValue('needs_device');
    render(
      <AiApprovalDialog
        toolName="file_operations" description="Read a file" input={{}}
        onApprove={vi.fn()} onReject={vi.fn()}
        intentBacked selfApprovalRequestId="ap-1" onIntentDecided={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() =>
      expect(screen.getByText(/register/i)).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });

  it('ceremony failure → inline error, buttons stay', async () => {
    decideIntentApproval.mockRejectedValue(new DOMException('cancelled', 'NotAllowedError'));
    render(
      <AiApprovalDialog
        toolName="file_operations" description="Read a file" input={{}}
        onApprove={vi.fn()} onReject={vi.fn()}
        intentBacked selfApprovalRequestId="ap-1" onIntentDecided={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
  });

  it('deny → decideIntentApproval(deny) → onIntentDecided', async () => {
    decideIntentApproval.mockResolvedValue('decided');
    const onIntentDecided = vi.fn();
    render(
      <AiApprovalDialog
        toolName="file_operations" description="Read a file" input={{}}
        onApprove={vi.fn()} onReject={vi.fn()}
        intentBacked selfApprovalRequestId="ap-1" onIntentDecided={onIntentDecided}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /deny/i }));
    await waitFor(() => expect(onIntentDecided).toHaveBeenCalled());
    expect(decideIntentApproval).toHaveBeenCalledWith('ap-1', 'deny');
  });
});
```

(Adjust `@/lib/intentApprovals` to the alias style the test file already uses for mocks; if it mocks with relative paths, use `../../lib/intentApprovals`.)

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test --filter=@breeze/web -- AiApprovalDialog`
Expected: FAIL — no such buttons/props.

- [ ] **Step 3: Implement the component changes**

In `apps/web/src/components/ai/AiApprovalDialog.tsx`:

1. Imports: add `Fingerprint` to the lucide import; add:

```tsx
import { decideIntentApproval } from "@/lib/intentApprovals";
import { navigateTo } from "@/lib/navigation";
```

2. Props — extend the interface and update the CRITICAL-3 doc comment:

```tsx
  /**
   * True for Tier-3 durable action-intents (spec §6.1), decided on
   * action_intents via the approvals decide API — never via the legacy
   * sessions-approve endpoint (whole-branch review CRITICAL-3). When the
   * requester is NOT an eligible approver (multi-approver org), this card
   * shows a waiting state only. When the server fanned the approval row out
   * to the requester (sole-operator branch), selfApprovalRequestId is set
   * and the card offers an inline L3 self-approve: WebAuthn ceremony
   * (Touch ID / Windows Hello) + proof POST — satisfying, not bypassing,
   * the decide handler's assurance-level >= 3 gate.
   */
  intentBacked?: boolean;
  /** The viewer's own fanned-out approval row (sole-operator case). */
  selfApprovalRequestId?: string;
  /** Called after a successful inline decide so the parent clears pendingApproval. */
  onIntentDecided?: () => void;
```

3. Component state + handler (inside the component, after the `remainingMs` state):

```tsx
  const [intentDecideState, setIntentDecideState] = useState<
    "idle" | "deciding" | "needs_device"
  >("idle");
  const [intentError, setIntentError] = useState<string | null>(null);

  const canSelfDecide = Boolean(intentBacked && selfApprovalRequestId);

  const handleIntentDecision = async (decision: "approve" | "deny") => {
    if (!selfApprovalRequestId || intentDecideState === "deciding") return;
    setIntentDecideState("deciding");
    setIntentError(null);
    try {
      const outcome = await decideIntentApproval(selfApprovalRequestId, decision);
      if (outcome === "needs_device") {
        setIntentDecideState("needs_device");
        return;
      }
      onIntentDecided?.();
    } catch (err) {
      // Cancelled/failed ceremony or a server rejection (the latter already
      // toasted by runAction) — surface inline and let the user retry.
      setIntentError(
        err instanceof Error && err.message
          ? err.message
          : t("aiApprovalDialog.verificationFailed"),
      );
      setIntentDecideState("idle");
    }
  };
```

4. Render — replace the current bottom section (the `{!intentBacked && (...)}` buttons block at lines 265-288) with:

```tsx
      {/* Legacy (non-intent) Tier-2 path — unchanged. */}
      {!intentBacked && (
        <div className="mt-3 flex gap-2">
          {/* ...existing Approve/Reject buttons exactly as they are... */}
        </div>
      )}

      {/* Sole-operator inline self-approve: the server fanned the approval
          row out to the requester, so deciding it here is legitimate — the
          approve path attaches a WebAuthn L3 proof (Touch ID / Windows
          Hello), which is exactly what the decide handler's self-approve
          gate requires. Multi-approver intents never get these buttons
          (selfApprovalRequestId is undefined — four-eyes preserved). */}
      {canSelfDecide && intentDecideState !== "needs_device" && (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={intentDecideState === "deciding"}
            onClick={() => handleIntentDecision("approve")}
            className="flex items-center gap-1.5 rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-green-500 disabled:opacity-50"
          >
            <Fingerprint className="h-3.5 w-3.5" />
            {intentDecideState === "deciding"
              ? t("aiApprovalDialog.verifying")
              : t("aiApprovalDialog.approveVerify")}
          </button>
          <button
            type="button"
            disabled={intentDecideState === "deciding"}
            onClick={() => handleIntentDecision("deny")}
            className="flex items-center gap-1.5 rounded-md bg-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-300 disabled:opacity-50 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
          >
            <X className="h-3.5 w-3.5" />
            {t("aiApprovalDialog.deny")}
          </button>
        </div>
      )}

      {canSelfDecide && intentError && (
        <p role="alert" className="mt-2 text-xs text-red-500">
          {intentError}
        </p>
      )}

      {canSelfDecide && intentDecideState === "needs_device" && (
        <div className="mt-3 rounded-md bg-gray-100/60 px-3 py-2 text-xs text-gray-600 dark:bg-gray-800/60 dark:text-gray-300">
          {t("aiApprovalDialog.noApproverDevice")}{" "}
          <button
            type="button"
            onClick={() => navigateTo("/settings/profile")}
            className="font-medium text-blue-500 underline hover:text-blue-400"
          >
            {t("aiApprovalDialog.registerDevice")}
          </button>
        </div>
      )}
```

Also update the `pendingApproverDescription` paragraph condition so the "needs approval in the Approvals area or the mobile app" hint only shows when the viewer canNOT self-decide: change `{intentBacked && (` at line 246 to `{intentBacked && !canSelfDecide && (`.

- [ ] **Step 4: Add the i18n keys — ALL five locales in the same commit**

`apps/web/src/locales/en/ai.json`, inside `"aiApprovalDialog"`:

```json
    "approveVerify": "Verify & Approve",
    "verifying": "Waiting for verification…",
    "deny": "Deny",
    "verificationFailed": "Verification failed. Try again.",
    "noApproverDevice": "Approving your own request requires Touch ID / Windows Hello.",
    "registerDevice": "Register this device",
    "decideFailed": "Failed to submit the decision",
    "approvedToast": "Action approved",
    "deniedToast": "Action denied"
```

Then add translated equivalents to `de-DE`, `es-419`, `fr-FR`, `pt-BR` `ai.json` under the same key path (translate properly; e.g. de-DE `"approveVerify": "Bestätigen & genehmigen"`, `"deny": "Ablehnen"`, fr-FR `"approveVerify": "Vérifier et approuver"`, `"deny": "Refuser"`, es-419 `"approveVerify": "Verificar y aprobar"`, `"deny": "Denegar"`, pt-BR `"approveVerify": "Verificar e aprovar"`, `"deny": "Negar"` — complete all nine keys per locale, matching the tone of neighboring keys in each file).

- [ ] **Step 5: Run to verify tests pass**

Run: `pnpm test --filter=@breeze/web -- AiApprovalDialog`
Expected: PASS, including the pre-existing intent-backed tests (the buttonless case now requires `selfApprovalRequestId` to be absent — if an old test renders `intentBacked` and asserts no buttons, it still passes because it passes no `selfApprovalRequestId`).
Also run any locale-parity test: `pnpm test --filter=@breeze/web -- i18n` (or whatever the parity suite is named; find with `ls apps/web/src/lib/__tests__/ | grep -i i18n`). Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/ai/AiApprovalDialog.tsx apps/web/src/components/ai/AiApprovalDialog.test.tsx apps/web/src/locales/*/ai.json
git commit -m "feat(web): inline Touch ID self-approve on intent-backed chat approvals"
```

---

### Task 6: Wire the parents + full verification

**Files:**
- Modify: `apps/web/src/components/ai/AiChatMessages.tsx` (props interface ~line 45 + the `AiApprovalDialog` render at 313-323)
- Modify: `apps/web/src/components/ai/AiChatSidebar.tsx` (~line 349)
- Modify: `apps/web/src/components/workspace/WorkspaceChatPanel.tsx` (its `AiChatMessages` usage)
- Modify: `apps/web/src/stores/aiStore.ts` (add `clearPendingApproval`), `apps/web/src/stores/workspaceStore.ts` (per-tab equivalent)
- Test: `apps/web/src/components/ai/AiChatMessages.test.tsx`

**Interfaces:**
- Consumes: `PendingApproval.selfApprovalRequestId` (Task 3); `AiApprovalDialog`'s `selfApprovalRequestId`/`onIntentDecided` props (Task 5).
- Produces: end-user-visible feature; no downstream consumers.

- [ ] **Step 1: Write the failing test**

In `apps/web/src/components/ai/AiChatMessages.test.tsx` (follow its existing harness for rendering with a `pendingApproval`):

```tsx
  it('passes selfApprovalRequestId and onIntentDecided through to the approval dialog', () => {
    const onIntentDecided = vi.fn();
    render(
      <AiChatMessages
        {/* ...existing required props from neighboring tests... */}
        pendingApproval={{
          executionId: 'e1', toolName: 'file_operations', input: {},
          description: 'Read a file', intentBacked: true, selfApprovalRequestId: 'ap-1',
        }}
        onIntentDecided={onIntentDecided}
      />,
    );
    // Task 5's dialog renders the biometric approve button only when the id is present:
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test --filter=@breeze/web -- AiChatMessages`
Expected: FAIL — `onIntentDecided` is not a prop / no approve button rendered.

- [ ] **Step 3: Implement the wiring**

1. `AiChatMessages.tsx` — add to its props interface: `onIntentDecided?: () => void;` and pass both through at the render site (lines 313-323):

```tsx
      {pendingApproval && (
        <AiApprovalDialog
          toolName={pendingApproval.toolName}
          description={pendingApproval.description}
          input={pendingApproval.input}
          deviceContext={pendingApproval.deviceContext}
          onApprove={() => onApprove(pendingApproval.executionId)}
          onReject={() => onReject(pendingApproval.executionId)}
          intentBacked={pendingApproval.intentBacked}
          selfApprovalRequestId={pendingApproval.selfApprovalRequestId}
          onIntentDecided={onIntentDecided}
        />
      )}
```

2. `aiStore.ts` — next to `approveExecution` (line 314), add a tiny action and expose it in the store interface (line ~63):

```ts
  /** Inline intent decide succeeded — the SSE stream carries the actual outcome; just drop the card. */
  clearPendingApproval: () => void;
```

```ts
  clearPendingApproval: () => set({ pendingApproval: null }),
```

3. `AiChatSidebar.tsx` (~line 349) — pull `clearPendingApproval` from the store alongside `approveExecution` and pass `onIntentDecided={clearPendingApproval}` to `AiChatMessages`.

4. `WorkspaceChatPanel.tsx` + `workspaceStore.ts` — same pattern per-tab: find how `WorkspaceChatPanel` renders `AiChatMessages` and how `workspaceStore.approveExecution(tabId, ...)` clears per-tab `pendingApproval` (line ~337); add `clearPendingApproval(tabId)` mirroring it and wire `onIntentDecided={() => clearPendingApproval(tabId)}`.

5. Check the third `approveExecution` owner: `apps/web/src/stores/scriptAiStore.ts:119`. Find what renders its approvals (`grep -rn "scriptAiStore\|useScriptAi" apps/web/src --include="*.tsx" -l | grep -v test`). If it renders `AiChatMessages`, wire it identically; if it has its own card that never receives intent-backed approvals (script sessions may not run Tier-3 device tools), leave it and note that in the commit message.

- [ ] **Step 4: Run the web suite**

Run: `pnpm test --filter=@breeze/web -- AiChatMessages AiChatSidebar processStreamEvent AiApprovalDialog`
Expected: PASS.

- [ ] **Step 5: Full verification**

```bash
pnpm --filter=@breeze/shared build   # or typecheck — whichever script exists
pnpm test --filter=@breeze/api
pnpm test --filter=@breeze/web
pnpm typecheck                        # root, if present (CI TypeCheck includes tests)
```

Expected: all green. Known unrelated flake: `AutomationTab` catalog test can be red on main — rerun once before treating as caused by this change.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/ai/AiChatMessages.tsx apps/web/src/components/ai/AiChatMessages.test.tsx apps/web/src/components/ai/AiChatSidebar.tsx apps/web/src/components/workspace/WorkspaceChatPanel.tsx apps/web/src/stores/aiStore.ts apps/web/src/stores/workspaceStore.ts
git commit -m "feat(web): wire inline intent self-approve through chat + workspace panels"
```

---

## Manual E2E check (post-implementation, before PR)

On a dev stack (`worktree-stack` skill) with a seeded sole-operator org:

1. Settings → Profile → register an approver device (Touch ID / Windows Hello / virtual authenticator in Chrome DevTools → WebAuthn panel).
2. Open AI chat, ask for a Tier-3 action on a device (e.g. *read* a file — `list` is Tier 2 after Task 1, so use `read` to exercise the approval path).
3. Card shows **Verify & Approve** / **Deny** → Approve → authenticator prompt → tool executes in-chat within the 5-minute window.
4. Unregister the device, repeat → card shows the register-device CTA after clicking approve; nothing was POSTed.
5. With a second eligible approver in the org, repeat → card shows the waiting state (no buttons) — four-eyes preserved.

## Self-review notes

- Spec coverage: sole-operator inline approve (Tasks 2-6), tier recalibration (Task 1), no server-side gate weakened (no `approvals.ts` change anywhere in the plan), multi-approver web queue explicitly out of scope (separate follow-up: web `/approvals` page).
- The legacy `onApprove`/`onReject` (sessions-approve endpoint) path is intentionally untouched — Tier-2 `per_step` approvals still use it.
- `approvals.ts` decide handler, assurance service, and registration routes: zero changes — verified against `approvals.ts:601-615` (self-approve gate reads `decidedAssuranceLevel >= 3`, satisfied by the `webauthn_platform` proof the ceremony produces).
