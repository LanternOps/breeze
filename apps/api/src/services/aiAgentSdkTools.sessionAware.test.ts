import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================
// Mocks — keep makeSessionAwareHandler isolated from DB + heavy deps.
// runOutsideDbContext / withDbAccessContext just invoke their callback so the
// enforcement ordering (preToolUse -> handler -> postToolUse) is observable.
// ============================================
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  db: {},
}));

vi.mock('./aiAgent', () => ({ waitForPlanApproval: vi.fn() }));

// Identity compaction so we can assert on the exact handler output text.
vi.mock('./aiToolOutput', () => ({
  compactToolResultForChat: vi.fn((_tool: string, raw: string) => raw),
}));

// The M365 handlers are imported by the module under test; stub them out — we
// inject our own sessionHandler into makeSessionAwareHandler.
// registerM365Tools is also imported transitively (by ./aiTools, which this
// file's `./aiTools` import pulls in) — stub it as a no-op so aiTools.ts's
// top-level registration call doesn't crash on an undefined mock export.
vi.mock('./aiToolsM365', () => ({
  m365LookupUserHandler: vi.fn(),
  m365RecentSigninsHandler: vi.fn(),
  m365ListGroupMembershipsHandler: vi.fn(),
  m365DisableUserHandler: vi.fn(),
  m365ResetPasswordHandler: vi.fn(),
  registerM365Tools: vi.fn(),
}));

import { withDbAccessContext } from '../db';
import { __test__, type PostToolUseCallback } from './aiAgentSdkTools';

const { makeSessionAwareHandler } = __test__;

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

// `user` and `partnerId` are part of the real AuthContext and are now load-
// bearing: the handler builds its DB context with `dbAccessContextFromAuth`
// (#2822), which reads `auth.user.id` and `auth.partnerId`. The previous stub
// omitted both, which was only survivable while the handler hand-rolled a
// partial DbAccessContext — the very defect #2822 fixes.
const fakeAuth = {
  scope: 'organization',
  orgId: 'org-1',
  accessibleOrgIds: ['org-1'],
  partnerId: 'partner-1',
  user: { id: 'user-1' },
} as any;
const fakeSession = { breezeSessionId: 'sess-123', auth: fakeAuth } as any;

// Aliases used by the secret-bearing-handler tests below, which construct
// their own getAuth/getActiveSession thunks inline rather than going through
// the beforeEach-scoped vi.fn() wrappers used by the enforcement-routing suite.
const authFixture = fakeAuth;
const sessionFixture = fakeSession;

const firstText = (res: ToolResult) => res.content[0]?.text ?? '';

describe('makeSessionAwareHandler (M365 enforcement routing)', () => {
  let getAuth: any;
  let getActiveSession: any;
  let sessionHandler: any;
  let onPreToolUse: any;
  let onPostToolUse: any;

  beforeEach(() => {
    vi.clearAllMocks();
    getAuth = vi.fn(() => fakeAuth);
    getActiveSession = vi.fn(() => fakeSession);
    sessionHandler = vi.fn(async () => JSON.stringify({ data: { ok: true } }));
    onPreToolUse = vi.fn(async () => ({ allowed: true }));
    onPostToolUse = vi.fn(async () => undefined);
  });

  // (1) Approval / guardrail / RBAC gate runs BEFORE the handler.
  // On the old inline registration the handler was called directly with no
  // onPreToolUse, so a tier-3 approval denial / RBAC denial could never block it.
  it('blocks execution and returns the error when onPreToolUse denies (sessionHandler never runs)', async () => {
    onPreToolUse.mockResolvedValueOnce({ allowed: false, error: 'approval_required' });
    const handler = makeSessionAwareHandler(
      'm365_reset_password', getAuth, getActiveSession, sessionHandler, onPreToolUse, onPostToolUse,
    );

    const res = (await handler({ userIdentifier: 'u@x.com', reason: 'r' })) as ToolResult;

    expect(onPreToolUse).toHaveBeenCalledWith('m365_reset_password', { userIdentifier: 'u@x.com', reason: 'r' });
    expect(sessionHandler).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain('approval_required');
    // postToolUse still records the denied attempt (isError = true).
    expect(onPostToolUse).toHaveBeenCalledWith(
      'm365_reset_password', expect.any(Object), expect.stringContaining('approval_required'), true, 0, undefined,
    );
  });

  // (2) onPostToolUse runs on success — proves the audit-persistence path executes.
  // The old inline registration had NO onPostToolUse, so ai_tool_executions rows
  // and delegant_tool_call_id were never written.
  it('invokes onPostToolUse with toolName/args/result on success', async () => {
    sessionHandler.mockResolvedValueOnce(JSON.stringify({ data: { reset: true } }));
    const handler = makeSessionAwareHandler(
      'm365_disable_user', getAuth, getActiveSession, sessionHandler, onPreToolUse, onPostToolUse,
    );

    await handler({ userIdentifier: 'u@x.com', reason: 'r' });

    expect(onPostToolUse).toHaveBeenCalledTimes(1);
    expect(onPostToolUse).toHaveBeenCalledWith(
      'm365_disable_user',
      { userIdentifier: 'u@x.com', reason: 'r' },
      JSON.stringify({ data: { reset: true } }),
      false,
      expect.any(Number),
      undefined,
    );
  });

  // (3) preTool allowed -> handler runs once and its text is returned.
  it('calls sessionHandler once and returns its text when onPreToolUse allows', async () => {
    sessionHandler.mockResolvedValueOnce(JSON.stringify({ data: { display: 'Jane' } }));
    const handler = makeSessionAwareHandler(
      'm365_lookup_user', getAuth, getActiveSession, sessionHandler, onPreToolUse, onPostToolUse,
    );

    const res = (await handler({ userIdentifier: 'jane@x.com' })) as ToolResult;

    expect(onPreToolUse).toHaveBeenCalledTimes(1);
    expect(sessionHandler).toHaveBeenCalledTimes(1);
    // sessionHandler receives (args, auth, sessionId) — sessionId from active session.
    expect(sessionHandler).toHaveBeenCalledWith({ userIdentifier: 'jane@x.com' }, fakeAuth, 'sess-123');
    expect(res.isError).toBeUndefined();
    expect(firstText(res)).toBe(JSON.stringify({ data: { display: 'Jane' } }));
  });

  // (5) ROOT CAUSE REGRESSION GUARD (#2822). The handler used to hand
  // withDbAccessContext a hand-rolled literal carrying only scope/orgId/
  // accessibleOrgIds. `serializeAccessibleIds` maps an absent list to '' ->
  // ARRAY[]::uuid[] for any non-system scope, so `breeze_has_partner_access`
  // was FALSE and `breeze_current_partner_id()` NULL for EVERY AI tool call —
  // and because makeHandler calls runOutsideDbContext first, that literal was
  // the ONLY context Postgres saw. Partner-axis tables (scripts, alert
  // templates, catalog, update rings, integrations) all read as empty with a
  // 200, including for a partner-scope MSP admin entitled to the rows.
  //
  // Asserted with a PARTNER-scope auth on purpose: for organization scope
  // `computeAccessiblePartnerIds` legitimately returns [], so an org-scoped
  // fixture cannot tell the canonical builder apart from the broken literal.
  it('builds the tool DB context via dbAccessContextFromAuth, carrying the partner axis', async () => {
    const partnerAuth = {
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: null,
      partnerId: 'partner-1',
      user: { id: 'user-1' },
    } as any;
    getAuth = vi.fn(() => partnerAuth);
    getActiveSession = vi.fn(() => ({ breezeSessionId: 'sess-123', auth: partnerAuth }) as any);

    const handler = makeSessionAwareHandler(
      'm365_lookup_user', getAuth, getActiveSession, sessionHandler, onPreToolUse, onPostToolUse,
    );
    await handler({ userIdentifier: 'jane@x.com' });

    expect(withDbAccessContext).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'partner',
        accessiblePartnerIds: ['partner-1'],
        currentPartnerId: 'partner-1',
        userId: 'user-1',
      }),
      expect.any(Function),
    );
  });

  // (4) No active session -> no_active_session error, handler & enforcement skipped.
  it('returns no_active_session and skips handler when there is no active session', async () => {
    getActiveSession.mockReturnValueOnce(undefined);
    const handler = makeSessionAwareHandler(
      'm365_lookup_user', getAuth, getActiveSession, sessionHandler, onPreToolUse, onPostToolUse,
    );

    const res = (await handler({ userIdentifier: 'jane@x.com' })) as ToolResult;

    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain('no_active_session');
    expect(onPreToolUse).not.toHaveBeenCalled();
    expect(sessionHandler).not.toHaveBeenCalled();
  });
});

describe('secret-bearing session-aware handler', () => {
  const prevKey = process.env.APP_ENCRYPTION_KEY;
  const prevKeyId = process.env.APP_ENCRYPTION_KEY_ID;

  afterEach(() => {
    if (prevKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = prevKey;
    if (prevKeyId === undefined) delete process.env.APP_ENCRYPTION_KEY_ID;
    else process.env.APP_ENCRYPTION_KEY_ID = prevKeyId;
  });

  it('returns only llmText to the model and hands sealedResult to postToolUse', async () => {
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    process.env.APP_ENCRYPTION_KEY_ID = 'test-key-1';
    const PW = 'Bz9!oVnL920blvsjqqMy';
    const post = vi.fn<PostToolUseCallback>(async () => {});

    const handler = makeSessionAwareHandler(
      'm365_reset_password',
      () => authFixture,
      () => sessionFixture,
      async () => ({
        kind: 'success' as const,
        llmText: 'Reset done; credential available for one-time reveal.',
        secrets: { temporaryPassword: PW },
      }),
      async () => ({ allowed: true, intentId: 'intent-1' }),
      post,
    );

    const res = await handler({ userIdentifier: 'a@b.com', reason: 'r' });

    expect(JSON.stringify(res)).not.toContain(PW);
    // The persistence-facing argument (ai_messages / ai_tool_executions / SSE)
    // matters just as much as the model-facing return — a regression that
    // leaked the carrier into ONLY this argument would otherwise pass every
    // other assertion in this test.
    expect(post.mock.calls[0]![2]).not.toContain(PW);
    const sealedArg = post.mock.calls[0]![5];
    expect(sealedArg?.intentId).toBe('intent-1');
    expect(sealedArg?.sealedResult.temporaryPasswordEnc).toMatch(/^enc:v3:/);
  });

  // Supersedes the pre-review "fails closed when a secret-bearing tool has no
  // intent to seal into" test: the guard now fires BEFORE sessionHandler runs
  // (see makeSessionAwareHandler), so this proves the call is refused outright
  // — the provider-side reset never happens — rather than happening and then
  // discarding the resulting credential.
  it('refuses a secret-bearing tool call before execution when there is no intent to seal into (fails closed pre-execution)', async () => {
    const PW = 'Bz9!oVnL920blvsjqqMy';
    const sessionHandler = vi.fn(async () => ({
      kind: 'success' as const,
      llmText: 'Reset done; credential available for one-time reveal.',
      secrets: { temporaryPassword: PW },
    }));
    const post = vi.fn<PostToolUseCallback>(async () => {});
    const handler = makeSessionAwareHandler(
      'm365_reset_password',
      () => authFixture,
      () => sessionFixture,
      sessionHandler,
      async () => ({ allowed: true }),          // no intentId
      post,
    );

    const res = (await handler({ userIdentifier: 'a@b.com', reason: 'r' })) as ToolResult;
    const text = res.content[0]!.text;

    // The whole point of moving the guard earlier: the provider-side reset
    // (sessionHandler) must never run when there's nowhere safe to seal the
    // resulting credential.
    expect(sessionHandler).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect(text).not.toContain(PW);
    // Distinct from SECRET_UNAVAILABLE_TEXT ("...could not be stored securely
    // and is unavailable...", which implies the reset DID happen) — this
    // wording must say the action was NOT performed.
    expect(text).toMatch(/not performed/i);
    expect(text).not.toMatch(/could not be stored securely/i);
    expect(post.mock.calls[0]![5]).toBeUndefined();
  });

  // Defense-in-depth: even if a future secret-bearing tool were added to
  // sessionHandler's call sites without being registered in
  // isSecretBearingTool's registry (so the new pre-execution guard above
  // can't recognize it), the post-execution split must still refuse to seal
  // a credential with no intentId rather than ever persist plaintext. This
  // exercises the `!intentId` branch inside the split directly by using a
  // toolName that isSecretBearingTool does NOT recognize, so the
  // pre-execution guard does not intercept the call and sessionHandler runs.
  it('defense-in-depth: substitutes SECRET_UNAVAILABLE_TEXT if a carrier reaches the post-execution split with no intentId', async () => {
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    process.env.APP_ENCRYPTION_KEY_ID = 'test-key-1';
    const PW = 'Bz9!oVnL920blvsjqqMy';
    const post = vi.fn<PostToolUseCallback>(async () => {});
    const handler = makeSessionAwareHandler(
      'm365_lookup_user', // NOT in the secret-bearing registry
      () => authFixture,
      () => sessionFixture,
      async () => ({
        kind: 'success' as const,
        llmText: 'Reset done; credential available for one-time reveal.',
        secrets: { temporaryPassword: PW },
      }),
      async () => ({ allowed: true }),          // no intentId
      post,
    );

    const res = (await handler({ userIdentifier: 'a@b.com', reason: 'r' })) as ToolResult;
    const text = res.content[0]!.text;

    expect(text).not.toContain(PW);
    expect(text).toMatch(/could not be stored securely|unavailable/i);
    expect(post.mock.calls[0]![5]).toBeUndefined();
  });
});
