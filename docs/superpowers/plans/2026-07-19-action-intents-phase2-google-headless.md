# Action-Intents Phase 2 — Headless Google Tier-3 Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the durable action-intents release worker execute session-aware Google Workspace Tier-3 tools headlessly (resolving the OAuth connection by `intent.orgId`), so an approved offboard/suspend/reset runs even after the requesting tech's chat session has ended.

**Architecture:** Extract each Tier-3 Google handler's API call into a pure `(ctx, input)` action fn shared by the inline handler and a new headless executor. The executor resolves the one-per-org Google connection by an explicit `orgId`. The release worker gains a Google-headless branch before its existing `requiresLiveSession` short-circuit. The shipped inline chat path is left byte-for-byte unchanged. M365 stays deferred.

**Tech Stack:** TypeScript, Hono API, Drizzle ORM, Postgres (RLS via `breeze_app`), Vitest (unit + real-Postgres integration), BullMQ worker.

**Spec:** `docs/superpowers/specs/2026-07-19-action-intents-phase2-google-headless-design.md`

## Global Constraints

- **Worker-only.** Do NOT modify `services/aiAgentSdkTools.ts` registration or `makeSessionAwareHandler`. The inline chat path must behave identically after this change — existing `aiToolsGoogle.test.ts` stays green.
- **Explicit allowlist, parity-tested.** The headless action map must cover EXACTLY the Tier-3 entries of `googleToolTiers` (`aiToolsGoogle.ts:40-66`) — the 20 tools listed in Task 2. A parity unit test enforces this (repo lesson: parity-list drift reds main).
- **Fail closed at execution.** The Google connection is loaded fresh under `intent.orgId`'s RLS context and re-authorized (`conn.orgId === intent.orgId && conn.status === 'active'`) at execution time. A revoked/rotated connection fails the intent with `connection_unavailable`, never executes stale.
- **M365 unchanged/deferred.** M365 session-aware intents must still fail `session_required` in the worker.
- **Integration test dual hand-list.** Any `*.integration.test.ts` MUST be added to BOTH `apps/api/vitest.integration.config.ts` (`include`) AND `apps/api/vitest.config.ts` (`exclude`). Miss either and it silently never runs (or reds the no-DB unit job on ECONNREFUSED).
- **Commit after every task.** Branch: `ToddHebebrand/action-intents-durability` (already checked out; do not create a new branch, do not merge).

---

## File Structure

- **Modify** `apps/api/src/services/aiToolsGoogle.ts` — add exported `GoogleToolContext` type + `resolveContextByOrg(orgId)`; keep `resolveContext(auth, sessionId)` as a thin wrapper; split each of the 20 Tier-3 handlers into an exported `xAction(ctx, input)` + a slim `xHandler` that delegates.
- **Create** `apps/api/src/services/googleToolsHeadless.ts` — `GOOGLE_HEADLESS_ACTIONS` map, `isHeadlessGoogleTool(name)`, `executeGoogleToolHeadless(name, args, orgId)`, `GoogleConnectionUnavailableError`.
- **Create** `apps/api/src/services/googleToolsHeadless.test.ts` — parity + dispatch + connection-unavailable unit tests.
- **Modify** `apps/api/src/jobs/intentReleaseWorker.ts` — Google-headless branch + `connection_unavailable` categorization.
- **Modify** `apps/api/src/jobs/intentReleaseWorker.test.ts` — worker branch unit tests.
- **Create** `apps/api/src/jobs/intentReleaseWorkerGoogleHeadless.integration.test.ts` — real-Postgres proof.
- **Modify** `apps/api/vitest.integration.config.ts` + `apps/api/vitest.config.ts` — register the integration test (dual hand-list).
- **Modify** memory `action_intents_durable_approval_review.md` + spec status — bookkeeping.

---

### Task 1: Refactor `aiToolsGoogle.ts` — org-keyed context + per-action fns

**Files:**
- Modify: `apps/api/src/services/aiToolsGoogle.ts`
- Test: `apps/api/src/services/aiToolsGoogle.test.ts` (existing — regression only)

**Interfaces:**
- Produces:
  - `export type GoogleToolContext = { conn: GoogleWorkspaceConnectionRow; keyJson: string }`
  - `export async function resolveContextByOrg(orgId: string): Promise<{ error: string } | GoogleToolContext>`
  - For each of the 20 Tier-3 tools, an exported `export async function <name>Action(ctx: GoogleToolContext, input: Record<string, unknown>): Promise<string>` (e.g. `googleSuspendUserAction`, `googleResetPasswordAction`, …).
- Consumes: existing `loadGoogleConnection`, `authorizeGoogleConnection`, `decryptConnectionKey` (`googleHelpers.ts`), `getDirectoryClient`/`getGmailClient` (`googleClient.ts`), `errorString`, `requireString`, `googleError`, `GoogleWorkspaceConnectionRow` (`db/schema/google`).

**The 20 Tier-3 tools (must all get an `Action` fn):** `googleResetPassword`, `googleSuspendUser`, `googleRestoreUser`, `googleSignout`, `googleSetForwarding`, `googleDisableForwarding`, `googleSetVacation`, `googleUpdateUser`, `googleShareCalendar`, `googleOffboardUser`, `googleWipeMobileDevice`, `googleAddToGroup`, `googleRemoveFromGroup`, `googleMoveOu`, `googleRenameUser`, `googleReset2sv`, `googleAddMailDelegate`, `googleRemoveMailDelegate`, `googleAssignLicense`, `googleRemoveLicense`. (These are the `tier === 3` entries of `googleToolTiers`, `aiToolsGoogle.ts:40-66`.)

- [ ] **Step 1: Extract the org-keyed context resolver**

Replace the current `resolveContext` (`aiToolsGoogle.ts:188-212`) with a named context type, an org-keyed resolver, and a thin session wrapper that preserves today's behavior exactly:

```ts
export type GoogleToolContext = { conn: GoogleWorkspaceConnectionRow; keyJson: string };

type ResolvedContext = { error: string } | GoogleToolContext;

/** Resolve + decrypt the org's Google connection by orgId (no session). */
export async function resolveContextByOrg(orgId: string): Promise<ResolvedContext> {
  const conn = await loadGoogleConnection(orgId);
  const authz = authorizeGoogleConnection(conn, orgId);
  if (!authz.ok) {
    return {
      error: errorString(
        'no_google_connection',
        'No active Google Workspace connection for this organization. Connect one in settings first.',
      ),
    };
  }
  let keyJson: string;
  try {
    keyJson = decryptConnectionKey(authz.conn);
  } catch (err) {
    return { error: errorString('connection_key_error', (err as Error).message) };
  }
  return { conn: authz.conn, keyJson };
}

/** Inline (session) path: derive orgId from the live AI session, unchanged behavior. */
async function resolveContext(_auth: AuthContext, sessionId: string): Promise<ResolvedContext> {
  const session = await loadSession(sessionId);
  if (!session) return { error: errorString('session_not_found', 'AI session not found.') };
  return resolveContextByOrg(session.orgId);
}
```

- [ ] **Step 2: Split each Tier-3 handler into `xAction(ctx, input)` + slim `xHandler`**

Apply this UNIFORM transformation to each of the 20 Tier-3 handlers. The `xAction` fn contains everything the handler did after resolving `ctx` (including the `reason`/other `requireString` input checks and the `try/catch` API call). The handler shrinks to `resolveContext + delegate`.

Worked example A — `googleSuspendUser` (single-input):

```ts
export async function googleSuspendUserAction(
  ctx: GoogleToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const reason = requireString(input, 'reason');
  if (!reason) return errorString('missing_reason', 'A reason is required for this action.');
  const email = requireString(input, 'userEmail');
  if (!email) return errorString('missing_user', 'A user email is required.');
  try {
    const dir = getDirectoryClient(ctx.keyJson, ctx.conn.adminEmail);
    await dir.users.update({ userKey: email, requestBody: { suspended: true } });
    return `Suspended Google Workspace user ${email}.`;
  } catch (err) {
    return googleError(err);
  }
}

export async function googleSuspendUserHandler(
  input: Record<string, unknown>,
  auth: AuthContext,
  sessionId: string,
): Promise<string> {
  const ctx = await resolveContext(auth, sessionId);
  if ('error' in ctx) return ctx.error;
  return googleSuspendUserAction(ctx, input);
}
```

Worked example B — `googleAddToGroup` (multi-input, shows all input validation moves into the Action fn):

```ts
export async function googleAddToGroupAction(
  ctx: GoogleToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const reason = requireString(input, 'reason');
  if (!reason) return errorString('missing_reason', 'A reason is required for this action.');
  const email = requireString(input, 'userEmail');
  if (!email) return errorString('missing_user', 'A user email is required.');
  const groupEmail = requireString(input, 'groupEmail');
  if (!groupEmail) return errorString('missing_group', 'A group email is required.');
  const roleRaw = requireString(input, 'role');
  const role =
    roleRaw && ['MEMBER', 'MANAGER', 'OWNER'].includes(roleRaw.toUpperCase())
      ? roleRaw.toUpperCase()
      : 'MEMBER';
  try {
    const dir = getDirectoryClient(ctx.keyJson, ctx.conn.adminEmail);
    await dir.members.insert({ groupKey: groupEmail, requestBody: { email, role } });
    return `Added ${email} to group ${groupEmail} as ${role}.`;
  } catch (err) {
    return googleError(err);
  }
}

export async function googleAddToGroupHandler(
  input: Record<string, unknown>,
  auth: AuthContext,
  sessionId: string,
): Promise<string> {
  const ctx = await resolveContext(auth, sessionId);
  if ('error' in ctx) return ctx.error;
  return googleAddToGroupAction(ctx, input);
}
```

**Transformation rule (apply to all 20):** move every line of the original handler body that came AFTER `const ctx = await resolveContext(...)` (i.e. remaining `requireString` checks + the `try { getDirectoryClient(...) ... } catch { return googleError(err) }`) into `<name>Action(ctx, input)` verbatim; also move the leading `reason` check (which today precedes `resolveContext`) into the Action fn at the top. The handler becomes exactly the 3-line delegate shown above. **Leave the Tier-1 read handlers** (`googleLookupUserHandler`, `googleListUserGroupsHandler`, `googleListLicenses*`, `googleSecurityDrift*`, `googleEmailReport*`) **untouched** — they keep calling `resolveContext` directly and get no Action fn.

> Note: this moves input validation to AFTER connection resolution inside the handler. Both are pre-side-effect error returns (a missing `reason` still short-circuits before any Google API call), so behavior is functionally identical; only the relative precedence of a `no_google_connection` vs `missing_reason` error on a simultaneously-malformed-and-disconnected inline call changes. The existing suite (Step 3) is the guard.

- [ ] **Step 3: Run the existing Google suite to prove no inline regression**

Run: `cd apps/api && pnpm vitest run src/services/aiToolsGoogle.test.ts src/services/googleHelpers.test.ts`
Expected: PASS. If any test asserts `missing_reason` precedence with no connection present, update that one test to expect the connection-first ordering (functionally identical) — do not revert the refactor.

- [ ] **Step 4: Typecheck**

Run: `cd apps/api && pnpm tsc --noEmit`
Expected: no errors (all 20 Action fns exported, handlers still exported with unchanged signatures).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiToolsGoogle.ts apps/api/src/services/aiToolsGoogle.test.ts
git commit -m "refactor(intents): split Google Tier-3 handlers into org-keyed action fns

Extract resolveContextByOrg + per-tool xAction(ctx, input) fns shared by the
inline handler and the upcoming headless executor. Inline behavior unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `googleToolsHeadless.ts` — allowlist + headless executor

**Files:**
- Create: `apps/api/src/services/googleToolsHeadless.ts`
- Create: `apps/api/src/services/googleToolsHeadless.test.ts`

**Interfaces:**
- Consumes (from Task 1): `resolveContextByOrg`, `GoogleToolContext`, and the 20 `<name>Action` fns from `./aiToolsGoogle`; `googleToolTiers` from `./aiToolsGoogle`.
- Produces:
  - `export class GoogleConnectionUnavailableError extends Error { readonly toolResult: string }`
  - `export function isHeadlessGoogleTool(name: string): boolean`
  - `export async function executeGoogleToolHeadless(actionName: string, args: unknown, orgId: string): Promise<string>`

- [ ] **Step 1: Write the failing parity + dispatch + connection tests**

```ts
// apps/api/src/services/googleToolsHeadless.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveMock = vi.fn();
vi.mock('./aiToolsGoogle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./aiToolsGoogle')>();
  return { ...actual, resolveContextByOrg: resolveMock };
});

import { googleToolTiers } from './aiToolsGoogle';
import {
  isHeadlessGoogleTool,
  executeGoogleToolHeadless,
  GoogleConnectionUnavailableError,
  GOOGLE_HEADLESS_ACTIONS,
} from './googleToolsHeadless';

beforeEach(() => resolveMock.mockReset());

describe('googleToolsHeadless parity', () => {
  it('map covers EXACTLY the tier-3 googleToolTiers entries', () => {
    const tier3 = Object.entries(googleToolTiers).filter(([, t]) => t === 3).map(([n]) => n).sort();
    expect(Object.keys(GOOGLE_HEADLESS_ACTIONS).sort()).toEqual(tier3);
  });
  it('isHeadlessGoogleTool: true for a tier-3 tool, false for tier-1 and unknown', () => {
    expect(isHeadlessGoogleTool('google_suspend_user')).toBe(true);
    expect(isHeadlessGoogleTool('google_lookup_user')).toBe(false);
    expect(isHeadlessGoogleTool('m365_disable_user')).toBe(false);
    expect(isHeadlessGoogleTool('not_a_tool')).toBe(false);
  });
});

describe('executeGoogleToolHeadless', () => {
  it('resolves by orgId and dispatches to the action fn', async () => {
    const fakeCtx = { conn: { adminEmail: 'a@x.com' }, keyJson: '{}' };
    resolveMock.mockResolvedValueOnce(fakeCtx);
    const spy = vi.spyOn(GOOGLE_HEADLESS_ACTIONS, 'google_suspend_user' as never)
      .mockResolvedValueOnce('Suspended Google Workspace user u@x.com.' as never);
    const out = await executeGoogleToolHeadless('google_suspend_user', { userEmail: 'u@x.com', reason: 'off' }, 'org-1');
    expect(resolveMock).toHaveBeenCalledWith('org-1');
    expect(spy).toHaveBeenCalledWith(fakeCtx, { userEmail: 'u@x.com', reason: 'off' });
    expect(out).toContain('Suspended');
  });
  it('throws GoogleConnectionUnavailableError when the connection cannot be resolved', async () => {
    resolveMock.mockResolvedValueOnce({ error: JSON.stringify({ error: 'no_google_connection', message: 'x' }) });
    await expect(
      executeGoogleToolHeadless('google_suspend_user', { userEmail: 'u@x.com', reason: 'off' }, 'org-1'),
    ).rejects.toBeInstanceOf(GoogleConnectionUnavailableError);
  });
  it('throws for a non-headless tool name (defensive; call site gates with isHeadlessGoogleTool)', async () => {
    await expect(executeGoogleToolHeadless('google_lookup_user', {}, 'org-1')).rejects.toThrow(/not a headless/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && pnpm vitest run src/services/googleToolsHeadless.test.ts`
Expected: FAIL — cannot find module `./googleToolsHeadless`.

- [ ] **Step 3: Implement the module**

```ts
// apps/api/src/services/googleToolsHeadless.ts
/**
 * Headless dispatch for Google Workspace Tier-3 tools, used by the durable
 * action-intents release worker. Resolves the one-per-org Google connection by
 * an explicit orgId (the immutable intent.orgId) — NO live SSE session — and
 * re-authorizes it (org match + active) at execution time via resolveContextByOrg.
 *
 * The action map is the effective allowlist: only these vetted Tier-3 mutations
 * ever run headless, and a parity test pins it to the tier-3 googleToolTiers set.
 */
import {
  resolveContextByOrg,
  googleToolTiers,
  googleResetPasswordAction,
  googleSuspendUserAction,
  googleRestoreUserAction,
  googleSignoutAction,
  googleSetForwardingAction,
  googleDisableForwardingAction,
  googleSetVacationAction,
  googleUpdateUserAction,
  googleShareCalendarAction,
  googleOffboardUserAction,
  googleWipeMobileDeviceAction,
  googleAddToGroupAction,
  googleRemoveFromGroupAction,
  googleMoveOuAction,
  googleRenameUserAction,
  googleReset2svAction,
  googleAddMailDelegateAction,
  googleRemoveMailDelegateAction,
  googleAssignLicenseAction,
  googleRemoveLicenseAction,
  type GoogleToolContext,
} from './aiToolsGoogle';

type GoogleAction = (ctx: GoogleToolContext, input: Record<string, unknown>) => Promise<string>;

/** Thrown when the org's Google connection is missing/rotated/inactive at release. */
export class GoogleConnectionUnavailableError extends Error {
  constructor(public readonly toolResult: string) {
    super('Google Workspace connection unavailable for headless release');
    this.name = 'GoogleConnectionUnavailableError';
  }
}

export const GOOGLE_HEADLESS_ACTIONS: Record<string, GoogleAction> = {
  google_reset_password: googleResetPasswordAction,
  google_suspend_user: googleSuspendUserAction,
  google_restore_user: googleRestoreUserAction,
  google_signout: googleSignoutAction,
  google_set_forwarding: googleSetForwardingAction,
  google_disable_forwarding: googleDisableForwardingAction,
  google_set_vacation: googleSetVacationAction,
  google_update_user: googleUpdateUserAction,
  google_share_calendar: googleShareCalendarAction,
  google_offboard_user: googleOffboardUserAction,
  google_wipe_mobile_device: googleWipeMobileDeviceAction,
  google_add_to_group: googleAddToGroupAction,
  google_remove_from_group: googleRemoveFromGroupAction,
  google_move_ou: googleMoveOuAction,
  google_rename_user: googleRenameUserAction,
  google_reset_2sv: googleReset2svAction,
  google_add_mail_delegate: googleAddMailDelegateAction,
  google_remove_mail_delegate: googleRemoveMailDelegateAction,
  google_assign_license: googleAssignLicenseAction,
  google_remove_license: googleRemoveLicenseAction,
};

// Defense-in-depth: the map must equal the tier-3 googleToolTiers set. The
// parity unit test is the real guard; this keeps the invariant visible here.
void googleToolTiers;

export function isHeadlessGoogleTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(GOOGLE_HEADLESS_ACTIONS, name);
}

export async function executeGoogleToolHeadless(
  actionName: string,
  args: unknown,
  orgId: string,
): Promise<string> {
  const action = GOOGLE_HEADLESS_ACTIONS[actionName];
  if (!action) {
    throw new Error(`executeGoogleToolHeadless: "${actionName}" is not a headless Google tool`);
  }
  const ctx = await resolveContextByOrg(orgId);
  if ('error' in ctx) {
    throw new GoogleConnectionUnavailableError(ctx.error);
  }
  return action(ctx, (args ?? {}) as Record<string, unknown>);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && pnpm vitest run src/services/googleToolsHeadless.test.ts`
Expected: PASS (all parity + dispatch + error tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/googleToolsHeadless.ts apps/api/src/services/googleToolsHeadless.test.ts
git commit -m "feat(intents): headless Google Tier-3 executor + parity-tested allowlist

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Worker Google-headless branch

**Files:**
- Modify: `apps/api/src/jobs/intentReleaseWorker.ts` (imports; branch at `250-289`)
- Test: `apps/api/src/jobs/intentReleaseWorker.test.ts`

**Interfaces:**
- Consumes (Task 2): `isHeadlessGoogleTool`, `executeGoogleToolHeadless`, `GoogleConnectionUnavailableError`.

- [ ] **Step 1: Add the failing worker unit tests**

Add a mock for the headless module and three tests to `intentReleaseWorker.test.ts`. The existing mock of `../services/aiTools` (with `requiresLiveSession`) stays. Add near the other `vi.mock` blocks:

```ts
const googleHeadlessMock = {
  isHeadlessGoogleTool: vi.fn(() => false),
  executeGoogleToolHeadless: vi.fn(),
};
vi.mock('../services/googleToolsHeadless', () => ({
  isHeadlessGoogleTool: googleHeadlessMock.isHeadlessGoogleTool,
  executeGoogleToolHeadless: googleHeadlessMock.executeGoogleToolHeadless,
  GoogleConnectionUnavailableError: class GoogleConnectionUnavailableError extends Error {
    constructor(public readonly toolResult: string) { super('unavailable'); }
  },
}));
```

Import the error class in the test file for `instanceof` construction:
```ts
import { GoogleConnectionUnavailableError } from '../services/googleToolsHeadless';
```

Add tests (reuse the existing `setupHappyPathThroughRevalidation(intent)` helper; set `googleHeadlessMock.isHeadlessGoogleTool` per case, and reset it in `beforeEach` to `() => false`):

```ts
describe('headless Google branch', () => {
  it('executes a headless Google tool and CASes to completed (not session_required)', async () => {
    const intent = makeIntent({ actionName: 'google_suspend_user' });
    setupHappyPathThroughRevalidation(intent);
    googleHeadlessMock.isHeadlessGoogleTool.mockReturnValue(true);
    googleHeadlessMock.executeGoogleToolHeadless.mockResolvedValueOnce('Suspended Google Workspace user u@x.com.');
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> completed

    await releaseApprovedIntent(intent.id);

    expect(googleHeadlessMock.executeGoogleToolHeadless).toHaveBeenCalledWith(
      'google_suspend_user', intent.arguments, intent.orgId,
    );
    expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id, 'executing', 'completed', expect.objectContaining({ executedAt: expect.any(Date) }),
    );
  });

  it('fails connection_unavailable when the headless executor throws GoogleConnectionUnavailableError', async () => {
    const intent = makeIntent({ actionName: 'google_suspend_user' });
    setupHappyPathThroughRevalidation(intent);
    googleHeadlessMock.isHeadlessGoogleTool.mockReturnValue(true);
    googleHeadlessMock.executeGoogleToolHeadless.mockRejectedValueOnce(
      new GoogleConnectionUnavailableError(JSON.stringify({ error: 'no_google_connection' })),
    );
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> failed

    await releaseApprovedIntent(intent.id);

    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id, 'executing', 'failed', expect.objectContaining({ errorCode: 'connection_unavailable' }),
    );
  });

  it('still fails session_required for a session-aware M365 tool (deferral intact)', async () => {
    const intent = makeIntent({ actionName: 'm365_disable_user' });
    setupHappyPathThroughRevalidation(intent);
    googleHeadlessMock.isHeadlessGoogleTool.mockReturnValue(false);
    aiToolsMock.requiresLiveSession.mockReturnValue(true);
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> failed

    await releaseApprovedIntent(intent.id);

    expect(googleHeadlessMock.executeGoogleToolHeadless).not.toHaveBeenCalled();
    expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id, 'executing', 'failed', expect.objectContaining({ errorCode: 'session_required' }),
    );
  });
});
```

> If `makeIntent` / `makeIntent({actionName})` isn't the existing factory name in the file, use whatever the file already uses to build an `ActionIntent` fixture and set its `actionName`/`orgId`/`arguments`. Match the existing `failIntent`→`transitionIntent('executing','failed', …)` assertion style already used by the "tool_returned_error" test (`intentReleaseWorker.test.ts:255-260`).

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd apps/api && pnpm vitest run src/jobs/intentReleaseWorker.test.ts -t "headless Google branch"`
Expected: FAIL — worker does not yet call `executeGoogleToolHeadless` / does not emit `connection_unavailable`.

- [ ] **Step 3: Implement the worker branch**

Add imports to `intentReleaseWorker.ts` (after line 14):
```ts
import {
  isHeadlessGoogleTool,
  executeGoogleToolHeadless,
  GoogleConnectionUnavailableError,
} from '../services/googleToolsHeadless';
```

Replace the block at `intentReleaseWorker.ts:250-289` (the `requiresLiveSession` short-circuit through the `executeTool` try/catch) with:

```ts
  // Phase-1 deferral: the headless worker still cannot run session-aware M365
  // tools (they need the control-plane customer-graph-actions executor, not yet
  // built). Google Tier-3 tools ARE headless-executable (org-keyed connection,
  // resolved by intent.orgId) as of Phase 2 — so gate the session_required fail
  // on "not a headless Google tool". See docs/superpowers/specs/
  // 2026-07-19-action-intents-phase2-google-headless-design.md.
  if (!isHeadlessGoogleTool(intent.actionName) && requiresLiveSession(intent.actionName)) {
    await failIntent(intent, 'session_required', { details: { actionName: intent.actionName } });
    return;
  }

  // Step 3: execute with the rebuilt context. Escape any inherited DB context,
  // then open the SAME org-scoped context a live request would use, bounded by
  // the same per-tool timeout. Headless Google tools resolve their per-tenant
  // OAuth connection by intent.orgId (fresh + re-authorized at execution);
  // everything else runs through executeTool.
  const invoke = isHeadlessGoogleTool(intent.actionName)
    ? () => executeGoogleToolHeadless(intent.actionName, intent.arguments, intent.orgId)
    : () => executeTool(intent.actionName, intent.arguments, auth);

  let rawResult: string;
  try {
    rawResult = await withToolTimeout(
      runOutsideDbContext(() =>
        withDbAccessContext(dbAccessContextFromAuth(auth), invoke),
      ),
      getToolTimeout(intent.actionName),
      intent.actionName,
    );
  } catch (err) {
    if (err instanceof GoogleConnectionUnavailableError) {
      // The org's Google connection is missing/rotated/inactive at release time
      // — no API call was made. Fail closed with a distinct, categorized code.
      await failIntent(intent, 'connection_unavailable', {
        details: { actionName: intent.actionName },
      });
      return;
    }
    console.error(`[IntentReleaseWorker] tool execution threw for intent ${intent.id}:`, err);
    await failIntent(intent, 'execution_error', {
      details: { error: err instanceof Error ? err.message : String(err) },
      executed: true,
    });
    return;
  }
```

(The Step-4-onward result handling — truncate / `isReturnedToolError` → `tool_returned_error` / `completed` — is unchanged and now serves both paths.)

- [ ] **Step 4: Run the full worker suite**

Run: `cd apps/api && pnpm vitest run src/jobs/intentReleaseWorker.test.ts`
Expected: PASS (new headless tests + all pre-existing tests, including the M365 `session_required` and `execution_error`/timeout cases).

- [ ] **Step 5: Typecheck + commit**

Run: `cd apps/api && pnpm tsc --noEmit` (expect clean), then:
```bash
git add apps/api/src/jobs/intentReleaseWorker.ts apps/api/src/jobs/intentReleaseWorker.test.ts
git commit -m "feat(intents): release worker executes headless Google Tier-3 tools

Gate session_required on !isHeadlessGoogleTool; run Google tools via
executeGoogleToolHeadless (org-keyed) under the same timeout/RLS wrapper;
categorize a missing/rotated connection as connection_unavailable. Also
dissolves the worker-wins-CAS false session_required race for Google.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Real-Postgres integration proof

**Files:**
- Create: `apps/api/src/jobs/intentReleaseWorkerGoogleHeadless.integration.test.ts`
- Modify: `apps/api/vitest.integration.config.ts` (add to `include`)
- Modify: `apps/api/vitest.config.ts` (add to `exclude`)

**Interfaces:**
- Consumes: `releaseApprovedIntent` (`./intentReleaseWorker`), `createActionIntent`/`transitionIntent` (`../services/actionIntents/intentService`), the integration harness (`../__tests__/integration/setup`: `getAppDb`, `getTestDb`, seed helpers), `google_workspace_connections` schema + `encryptForColumn`.

- [ ] **Step 1: Write the integration test (Google client mocked at the boundary; DB real)**

Mirror the harness in `apps/api/src/services/actionIntents/createIntentAtomicity.integration.test.ts` (imports `'../../__tests__/integration/setup'`, uses `getAppDb`/`getTestDb`, `withSystemDbAccessContext`, real `breeze_app` driver, and the org/user/role seed helpers). Mock ONLY the Google SDK client so the connection resolution, decryption, RLS context, and intent lifecycle all run for real:

```ts
import './../__tests__/integration/setup'; // adjust relative depth to match sibling integration tests
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';

// Mock the Google Directory client at construction — every Action fn calls
// getDirectoryClient(keyJson, adminEmail); the real connection load + decrypt
// still executes against Postgres.
const usersUpdate = vi.fn().mockResolvedValue({ data: {} });
vi.mock('../services/googleClient', () => ({
  getDirectoryClient: vi.fn(() => ({ users: { update: usersUpdate }, members: {}, groups: {} })),
  getGmailClient: vi.fn(() => ({})),
}));

import { db, withSystemDbAccessContext } from '../db';
import { googleWorkspaceConnections } from '../db/schema/google';
import { actionIntents } from '../db/schema/actionIntents';
import { encryptForColumn } from '../services/secretCrypto';
import { releaseApprovedIntent } from './intentReleaseWorker';
// + the integration seed helpers used by createIntentAtomicity.integration.test.ts
//   (org/user/role creation, and a helper to insert an approved intent).
```

Then implement three cases. Use the same approved-intent setup the other worker/decide integration tests use (seed org + user + `approvals:decide`, create a `google_suspend_user` intent, drive it to `approved` with a winning `approval_requests` row), then:

1. **Headless happy path** — insert an `active` `google_workspace_connections` row for the org with an `encryptForColumn('google_workspace_connections','service_account_key', '{"fake":"key"}')` value and `adminEmail`. Call `releaseApprovedIntent(intentId)`. Assert: `usersUpdate` was called once; the `action_intents` row is `status='completed'`, `error_code IS NULL`, `executed_at` set.
2. **Revoked after approval** — set the connection `status='inactive'` (or delete it) before release. Call `releaseApprovedIntent`. Assert: `usersUpdate` NOT called; intent `status='failed'`, `error_code='connection_unavailable'`.
3. **Worker-wins-CAS race** — the classic race: the intent is `approved` (no live session in the worker). Call `releaseApprovedIntent`. Assert it reaches `completed` (NOT `failed:session_required`) — proving the worker no longer false-fails a Google tool it could run.

Assert connection reads happen under the org's RLS context by reading the final row via `withSystemDbAccessContext` and checking `error_code`.

- [ ] **Step 2: Register in BOTH config hand-lists**

In `apps/api/vitest.integration.config.ts`, add to the `include` array:
```ts
'src/jobs/intentReleaseWorkerGoogleHeadless.integration.test.ts',
```
In `apps/api/vitest.config.ts`, add to the `exclude` array:
```ts
'src/jobs/intentReleaseWorkerGoogleHeadless.integration.test.ts',
```
(Match the exact string form the two sibling integration tests already use in each file — copy their style, e.g. `**/intentExpiryReaper.integration.test.ts` if that's the glob convention.)

- [ ] **Step 3: Run the integration test against the real DB**

Run: `cd apps/api && pnpm vitest run --config vitest.integration.config.ts src/jobs/intentReleaseWorkerGoogleHeadless.integration.test.ts`
Expected: PASS (needs the local Postgres on :5433 per `docs`/memory `test_integration_config_run_mechanics`). If ECONNREFUSED, start the integration DB first.

- [ ] **Step 4: Confirm the unit job still excludes it**

Run: `cd apps/api && pnpm vitest run src/jobs/intentReleaseWorker.test.ts` (no-DB unit job) — expect PASS and NO attempt to open :5433 (proves the `exclude` edit landed).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/intentReleaseWorkerGoogleHeadless.integration.test.ts apps/api/vitest.integration.config.ts apps/api/vitest.config.ts
git commit -m "test(intents): real-PG proof of headless Google release (happy/revoked/race)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Bookkeeping — memory + spec status

**Files:**
- Modify: `/Users/toddhebebrand/.claude/projects/-Users-toddhebebrand-breeze/memory/action_intents_durable_approval_review.md`
- Modify: `docs/superpowers/specs/2026-07-19-action-intents-phase2-google-headless-design.md` (flip Status)

- [ ] **Step 1: Update the memory note**

In `action_intents_durable_approval_review.md`, replace the "STILL OPEN — Phase 2" paragraph with: Phase 2 = **Google Tier-3 headless dispatch SHIPPED** on `action-intents-durability` (org-keyed via `intent.orgId`, worker-only, inline untouched; `connection_unavailable` on revoked connection; worker-wins-CAS race dissolved for Google). Record that the **Delegant connectionId-capture framing is CANCELLED** (Delegant being decommissioned per the control-plane design), and **M365 headless is folded into the future `customer-graph-actions` executor phase** (born org-keyed/headless-capable; `action_intents.connection_id`/`tenant_id` stay dormant). Link `[[project_m365_control_plane_state]]`.

- [ ] **Step 2: Flip the spec Status line**

Change the spec header `**Status:**` to `Implemented on ToddHebebrand/action-intents-durability`.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-07-19-action-intents-phase2-google-headless-design.md
git commit -m "docs(intents): mark Phase 2 Google headless implemented

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
(The memory file lives outside the repo; it is saved by the Write tool, not committed.)

---

## Final Verification

- [ ] `cd apps/api && pnpm tsc --noEmit` — clean.
- [ ] `cd apps/api && pnpm vitest run src/services/aiToolsGoogle.test.ts src/services/googleToolsHeadless.test.ts src/jobs/intentReleaseWorker.test.ts` — all green.
- [ ] `cd apps/api && pnpm vitest run --config vitest.integration.config.ts src/jobs/intentReleaseWorkerGoogleHeadless.integration.test.ts` — green against real PG.
- [ ] `cd apps/api && pnpm eslint src/services/aiToolsGoogle.ts src/services/googleToolsHeadless.ts src/jobs/intentReleaseWorker.ts` — 0 errors.
- [ ] Request an independent code review (high blast radius: durable execution of destructive Google mutations). Confirm: no inline-path behavior change, allowlist parity enforced, connection re-authorized at execution, M365 deferral intact.
