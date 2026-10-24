/**
 * Wisp W04 Task 3 — POST /ai/sessions accepts `wispGrantId`.
 *
 * Runs the REAL route and the REAL createSession (aiAgent.ts) over a mocked
 * Drizzle, with the three Wisp modules mocked at their contract boundary:
 * `services/wisp/sessionGrant` (validation; the WispSessionError class stays
 * real), `services/wisp/threads` (thread + seed + focus) and
 * `services/wisp/grantAuthority` (ceiling).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const h = vi.hoisted(() => ({
  auth: null as any,
  inserted: [] as Array<Record<string, unknown>>,
  deviceRows: [] as unknown[],
}));

const ORG_A = 'aaaaaaaa-1111-4222-8333-444455556666';
const ORG_B = 'bbbbbbbb-1111-4222-8333-444455556666';
const ORG_C = 'cccccccc-1111-4222-8333-444455556666';
const GRANT_ID = '99999999-1111-4222-8333-444455556666';
const DEVICE_ID = 'dddddddd-1111-4222-8333-444455556666';
const SESSION_ID = 'eeeeeeee-1111-4222-8333-444455556666';

vi.mock('../services/aiModels/sessionModel', () => ({
  resolveSessionTurn: vi.fn(),
  chooseSessionModel: vi.fn(async () => ({
    offeringId: 'off-1', offeringPartnerId: 'p1', options: null,
    model: 'claude-sonnet-4-6', billingSource: 'platform',
  })),
}));
vi.mock('../services/aiModels/modelTransition', async (orig) => ({
  ...(await orig<typeof import('../services/aiModels/modelTransition')>()),
  readPreviousTurn: vi.fn(async () => null),
  planModelTransition: vi.fn(async () => ({ kind: 'fresh' })),
  readSessionOfferingId: vi.fn(async () => undefined),
}));
vi.mock('../services/aiModels/candidateLoader', () => ({ readOrgPartnerId: vi.fn(async () => 'p1') }));
vi.mock('../services/llm/llmConfigResolver', () => ({
  LlmUnavailableError: class LlmUnavailableError extends Error {
    readonly status = 503;
    readonly code = 'ai_unavailable';
  },
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(() => ({
      from: () => ({ where: () => ({ limit: async () => h.deviceRows }) }),
    })),
    insert: vi.fn(() => ({
      values: (v: Record<string, unknown>) => {
        h.inserted.push(v);
        return { returning: async () => [{ id: SESSION_ID }] };
      },
    })),
    update: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  aiSessions: { id: 'aiSessions.id', orgId: 'aiSessions.orgId' },
  aiMessages: { id: 'aiMessages.id', sessionId: 'aiMessages.sessionId', createdAt: 'aiMessages.createdAt' },
  aiToolExecutions: { id: 'aiToolExecutions.id', sessionId: 'aiToolExecutions.sessionId', status: 'aiToolExecutions.status' },
  approvalRequests: { id: 'approvalRequests.id' },
  delegantM365Connections: {
    id: 'delegantM365Connections.id',
    orgId: 'delegantM365Connections.orgId',
    status: 'delegantM365Connections.status',
  },
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId' },
  auditLogs: { id: 'auditLogs.id' },
  aiActionPlans: { id: 'aiActionPlans.id' },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', h.auth);
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  withAuthDbAccessContext: vi.fn(async (_auth: unknown, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../services/effectiveSettings', () => ({
  getEffectiveAiBudget: vi.fn(async () => ({ maxTurnsPerSession: 50 })),
}));
vi.mock('../services/aiAgentSystemPrompt', () => ({ AI_SYSTEM_PROMPT_BASE: 'base', AI_SYSTEM_PROMPT_TAIL: 'tail' }));
vi.mock('../services/aiToolIndex', () => ({ composeStaticSystemPrompt: () => 'BASE PROMPT' }));
vi.mock('../services/aiAgentSdkTools', () => ({ listChatSurfaceToolNames: () => [] }));
vi.mock('../services/brainDeviceContext', () => ({ getActiveDeviceContext: vi.fn(async () => []) }));

vi.mock('../services/aiCostTracker', () => ({
  getSessionHistory: vi.fn(),
  getUsageSummary: vi.fn(),
  updateBudget: vi.fn(),
}));
vi.mock('../services/aiBudgetReservations', () => ({
  reserveAiBudget: vi.fn(),
  releaseUnusedAiBudgetReservation: vi.fn(),
  markAiBudgetReservationIndeterminate: vi.fn(),
  AiBudgetSessionBusyError: class AiBudgetSessionBusyError extends Error {},
}));
vi.mock('../services/streamingSessionManager', () => ({
  streamingSessionManager: {
    getOrCreate: vi.fn(), get: vi.fn(), remove: vi.fn(),
    tryTransitionToProcessing: vi.fn(), interrupt: vi.fn(), startTurnTimeout: vi.fn(),
  },
}));
vi.mock('../services/aiAgentSdk', () => ({
  runPreFlightChecks: vi.fn(),
  settleBlockedTurnForNewMessage: vi.fn(() => Promise.resolve('not_blocked_on_approvals')),
  abortActivePlan: vi.fn(),
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

// ---- Wisp contract boundary ------------------------------------------------
vi.mock('../services/wisp/sessionGrant', async (orig) => ({
  ...(await orig<typeof import('../services/wisp/sessionGrant')>()),
  validateWispGrantForSession: vi.fn(),
}));
vi.mock('../services/wisp/threads', () => ({
  getOrCreateThread: vi.fn(),
  attachSession: vi.fn(async () => undefined),
  seedContextForSession: vi.fn(async () => '## Wisp thread\nSEED'),
  setThreadFocus: vi.fn(async () => ({})),
}));
vi.mock('../services/wisp/grantAuthority', () => {
  class CeilingViolationError extends Error {
    constructor(public readonly code: string, message: string) { super(message); }
  }
  class GrantInactiveError extends Error {
    readonly code = 'grant_inactive';
    constructor(
      public readonly grantId: string,
      public readonly status: string,
      detail?: string,
      public readonly kind: string = 'paused',
    ) { super(`Wisp grant ${grantId} is not active (${status})${detail ? `: ${detail}` : ''}`); }
  }
  return {
    CeilingViolationError,
    GrantInactiveError,
    resolveGrantCeiling: vi.fn(),
    assertWithinCeiling: vi.fn(),
  };
});

import { aiRoutes } from './ai';
import { validateWispGrantForSession, WispSessionError, type WispSessionErrorCode } from '../services/wisp/sessionGrant';
import { attachSession, getOrCreateThread, seedContextForSession, setThreadFocus } from '../services/wisp/threads';
import {
  assertWithinCeiling,
  CeilingViolationError,
  GrantInactiveError,
  resolveGrantCeiling,
} from '../services/wisp/grantAuthority';
import { readOrgPartnerId } from '../services/aiModels/candidateLoader';
import { captureException } from '../services/sentry';

const CEILING = { grantId: GRANT_ID, revisionId: 'r1', partnerId: 'p1', status: 'active' } as never;

function partnerAuth(overrides: Record<string, unknown> = {}) {
  return {
    principal: 'user_session',
    user: { id: 'u1', email: 'u1@example.com', name: 'Una User' },
    scope: 'partner',
    partnerId: 'p1',
    orgId: undefined,
    accessibleOrgIds: [ORG_A, ORG_B, ORG_C],
    orgCondition: () => undefined,
    canAccessOrg: (id: string) => [ORG_A, ORG_B, ORG_C].includes(id),
    ...overrides,
  };
}

function orgTokenAuth() {
  return {
    principal: 'user_session',
    user: { id: 'u1', email: 'u1@example.com', name: 'Una User' },
    scope: 'organization',
    partnerId: null,
    orgId: ORG_A,
    accessibleOrgIds: [ORG_A],
    orgCondition: () => undefined,
    canAccessOrg: (id: string) => id === ORG_A,
  };
}

function thread(focusOrgId: string | null = null) {
  return {
    id: 't1', grantId: GRANT_ID, partnerId: 'p1', summary: '', summaryUpdatedAt: null,
    lastSessionId: null, focusOrgId, createdAt: new Date(), updatedAt: new Date(),
  };
}

function validated(orgId: string | null = null) {
  return { grantId: GRANT_ID, revisionId: 'r1', partnerId: 'p1', orgId };
}

function post(app: Hono, body: Record<string, unknown>) {
  return app.request('/ai/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
    body: JSON.stringify(body),
  });
}

describe('POST /ai/sessions — wispGrantId (Wisp W04 Task 3)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    h.auth = partnerAuth();
    h.inserted = [];
    h.deviceRows = [];
    vi.mocked(validateWispGrantForSession).mockResolvedValue(validated());
    vi.mocked(getOrCreateThread).mockResolvedValue(thread() as never);
    vi.mocked(resolveGrantCeiling).mockResolvedValue(CEILING);
    vi.mocked(assertWithinCeiling).mockImplementation(() => undefined);
    app = new Hono();
    app.route('/ai', aiRoutes);
  });

  it('POST /ai/sessions without wispGrantId is byte-identical to today (no wisp calls)', async () => {
    const res = await post(app, { orgId: ORG_A });

    expect(res.status).toBe(201);
    expect(validateWispGrantForSession).not.toHaveBeenCalled();
    expect(getOrCreateThread).not.toHaveBeenCalled();
    expect(resolveGrantCeiling).not.toHaveBeenCalled();
    expect(seedContextForSession).not.toHaveBeenCalled();
    expect(attachSession).not.toHaveBeenCalled();
    expect(h.inserted).toHaveLength(1);
    const values = h.inserted[0]!;
    expect(values).not.toHaveProperty('wispGrantId');
    expect(values).not.toHaveProperty('wispGrantRevisionId');
    expect(values.orgId).toBe(ORG_A);
    expect(String(values.systemPrompt)).not.toContain('Wisp');
    expect(String(values.systemPrompt).startsWith('BASE PROMPT')).toBe(true);
    expect(await res.json()).toEqual({
      id: SESSION_ID, orgId: ORG_A, delegantM365ConnectionId: null, wispThreadId: null, wispFocusOrgId: null,
    });
  });

  it('POST /ai/sessions with wispGrantId stores both grant columns, appends the seed to systemPrompt and attaches the session', async () => {
    const res = await post(app, { orgId: ORG_A, wispGrantId: GRANT_ID });

    expect(res.status).toBe(201);
    expect(validateWispGrantForSession).toHaveBeenCalledWith(h.auth, GRANT_ID, ORG_A);
    expect(getOrCreateThread).toHaveBeenCalledWith(GRANT_ID);
    expect(resolveGrantCeiling).toHaveBeenCalledWith(GRANT_ID, 'r1');
    expect(seedContextForSession).toHaveBeenCalledWith('t1', CEILING);
    expect(h.inserted).toHaveLength(1);
    const values = h.inserted[0]!;
    expect(values).toMatchObject({ orgId: ORG_A, wispGrantId: GRANT_ID, wispGrantRevisionId: 'r1' });
    // A Wisp session keeps the default ('general') type.
    expect(values).not.toHaveProperty('type');
    const prompt = String(values.systemPrompt);
    expect(prompt.startsWith('BASE PROMPT')).toBe(true);
    expect(prompt.endsWith('\n## Wisp thread\nSEED')).toBe(true);
    expect(attachSession).toHaveBeenCalledWith('t1', SESSION_ID);
    expect(await res.json()).toEqual({
      id: SESSION_ID, orgId: ORG_A, delegantM365ConnectionId: null, wispThreadId: 't1', wispFocusOrgId: null,
    });
  });

  it('an empty seed leaves the system prompt unchanged', async () => {
    vi.mocked(seedContextForSession).mockResolvedValueOnce('');
    await post(app, { orgId: ORG_A, wispGrantId: GRANT_ID });
    expect(String(h.inserted[0]!.systemPrompt).endsWith('\n')).toBe(false);
    expect(String(h.inserted[0]!.systemPrompt)).not.toContain('Wisp');
  });

  it('rejects a malformed wispGrantId at the schema (400, no createSession work)', async () => {
    const res = await post(app, { orgId: ORG_A, wispGrantId: 'not-a-uuid' });
    expect(res.status).toBe(400);
    expect(validateWispGrantForSession).not.toHaveBeenCalled();
    expect(h.inserted).toHaveLength(0);
  });

  it.each([
    ['wisp_disabled', 404],
    ['grant_not_found', 404],
    ['grant_not_yours', 403],
    ['grant_inactive', 409],
    ['entitlement_required', 403],
    ['grant_scope_mismatch', 400],
    ['focus_mismatch', 409],
  ] as Array<[WispSessionErrorCode, number]>)('maps WispSessionError %s to HTTP %d', async (code, status) => {
    const err = new WispSessionError(code, status as never);
    vi.mocked(validateWispGrantForSession).mockRejectedValueOnce(err);
    const res = await post(app, { orgId: ORG_A, wispGrantId: GRANT_ID });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: err.message, code });
    expect(h.inserted).toHaveLength(0);
    expect(attachSession).not.toHaveBeenCalled();
  });

  it('entitlement_required carries the locked plan copy', () => {
    expect(new WispSessionError('entitlement_required', 403).message).toBe('Wisp is available on Pro and higher plans.');
  });

  it('a grant that went inactive between validation and the ceiling read is a 409 grant_inactive, not a 500', async () => {
    vi.mocked(resolveGrantCeiling).mockRejectedValueOnce(new (GrantInactiveError as any)('g', 'paused'));
    const res = await post(app, { orgId: ORG_A, wispGrantId: GRANT_ID });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'grant_inactive' });
    expect(h.inserted).toHaveLength(0);
  });

  it('a CORRUPT grant pin at the ceiling read is a 500 grant_corrupt, logged and captured (not a quiet 409)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const corrupt = new (GrantInactiveError as any)(GRANT_ID, 'active', 'malformed ceiling snapshot', 'corrupt');
    vi.mocked(resolveGrantCeiling).mockRejectedValueOnce(corrupt);
    const res = await post(app, { orgId: ORG_A, wispGrantId: GRANT_ID });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ code: 'grant_corrupt', error: "This Wisp grant can't be used. Turn Wisp off and on again." });
    expect(captureException).toHaveBeenCalledWith(corrupt, undefined, expect.objectContaining({ grantId: GRANT_ID }));
    expect(errSpy.mock.calls.some((args) => String(args[0]).includes(GRANT_ID))).toBe(true);
    expect(h.inserted).toHaveLength(0);
    errSpy.mockRestore();
  });

  it('partner-wide grant with an org token anchors to the token org', async () => {
    h.auth = orgTokenAuth();
    vi.mocked(validateWispGrantForSession).mockResolvedValue(validated(null));

    const res = await post(app, { wispGrantId: GRANT_ID });

    expect(res.status).toBe(201);
    expect(validateWispGrantForSession).toHaveBeenCalledWith(h.auth, GRANT_ID, ORG_A);
    expect(h.inserted[0]).toMatchObject({ orgId: ORG_A, wispGrantId: GRANT_ID });
    expect(await res.json()).toMatchObject({ orgId: ORG_A, wispThreadId: 't1', wispFocusOrgId: null });
  });

  it('a focused thread anchors the session to focusOrgId when no orgId is sent, and returns wispFocusOrgId', async () => {
    h.auth = partnerAuth({ orgId: ORG_A });
    vi.mocked(getOrCreateThread).mockResolvedValue(thread(ORG_B) as never);

    const res = await post(app, { wispGrantId: GRANT_ID });

    expect(res.status).toBe(201);
    expect(assertWithinCeiling).toHaveBeenCalledWith(CEILING, { orgId: ORG_B });
    expect(h.inserted[0]).toMatchObject({ orgId: ORG_B, wispGrantId: GRANT_ID, wispGrantRevisionId: 'r1' });
    expect(readOrgPartnerId).toHaveBeenCalledWith(ORG_B);
    expect(setThreadFocus).not.toHaveBeenCalled();
    // attachSession records the join row's org from the inserted session, i.e. the focus.
    expect(attachSession).toHaveBeenCalledWith('t1', SESSION_ID);
    expect(await res.json()).toMatchObject({ orgId: ORG_B, wispFocusOrgId: ORG_B });
  });

  it('the focus outranks a device page anchor, and the page anchor is then not recorded as the write default', async () => {
    h.deviceRows = [{ orgId: ORG_A, siteId: null }];
    vi.mocked(getOrCreateThread).mockResolvedValue(thread(ORG_B) as never);

    const res = await post(app, {
      wispGrantId: GRANT_ID,
      pageContext: { type: 'device', id: DEVICE_ID, hostname: 'WS-01' },
    });

    expect(res.status).toBe(201);
    expect(h.inserted[0]).toMatchObject({ orgId: ORG_B });
    expect(h.inserted[0]!.contextSnapshot).not.toHaveProperty('orgAnchor');
  });

  it('an explicit orgId equal to the focus is accepted', async () => {
    vi.mocked(getOrCreateThread).mockResolvedValue(thread(ORG_B) as never);
    const res = await post(app, { orgId: ORG_B, wispGrantId: GRANT_ID });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ orgId: ORG_B, wispFocusOrgId: ORG_B });
  });

  it('an explicit orgId that differs from the focus is refused 409 focus_mismatch', async () => {
    vi.mocked(getOrCreateThread).mockResolvedValue(thread(ORG_B) as never);

    const res = await post(app, { orgId: ORG_A, wispGrantId: GRANT_ID });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'focus_mismatch' });
    expect(h.inserted).toHaveLength(0);
    expect(attachSession).not.toHaveBeenCalled();
    expect(setThreadFocus).not.toHaveBeenCalled();
  });

  it('a device-bound task in another org than the focus is refused 409 focus_mismatch', async () => {
    h.deviceRows = [{ id: DEVICE_ID, orgId: ORG_A, siteId: null }];
    vi.mocked(getOrCreateThread).mockResolvedValue(thread(ORG_B) as never);

    const res = await post(app, { deviceId: DEVICE_ID, wispGrantId: GRANT_ID });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'focus_mismatch' });
    expect(h.inserted).toHaveLength(0);
  });

  it('a focus the current sign-in cannot reach (org token) is refused 409 focus_mismatch, never re-anchored', async () => {
    h.auth = orgTokenAuth();
    vi.mocked(getOrCreateThread).mockResolvedValue(thread(ORG_B) as never);

    const res = await post(app, { wispGrantId: GRANT_ID });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'focus_mismatch' });
    expect(h.inserted).toHaveLength(0);
    expect(setThreadFocus).not.toHaveBeenCalled();
  });

  it('a focus outside the live ceiling is cleared (setThreadFocus null) and the ordinary chain anchors the session; response wispFocusOrgId is null', async () => {
    h.auth = partnerAuth({ orgId: ORG_A });
    vi.mocked(getOrCreateThread).mockResolvedValue(thread(ORG_B) as never);
    vi.mocked(assertWithinCeiling).mockImplementation(() => {
      throw new (CeilingViolationError as any)('org', 'org outside the ceiling');
    });

    const res = await post(app, { wispGrantId: GRANT_ID });

    expect(res.status).toBe(201);
    expect(setThreadFocus).toHaveBeenCalledWith('t1', null, CEILING);
    expect(vi.mocked(setThreadFocus).mock.invocationCallOrder[0]!)
      .toBeLessThan(vi.mocked(seedContextForSession).mock.invocationCallOrder[0]!);
    expect(h.inserted[0]).toMatchObject({ orgId: ORG_A, wispGrantId: GRANT_ID });
    expect(await res.json()).toMatchObject({ orgId: ORG_A, wispThreadId: 't1', wispFocusOrgId: null });
  });

  it('re-checks the grant scope against the FINAL (focus-anchored) org', async () => {
    // Defensive: an org-scoped grant whose org is not the focus must never
    // reach the insert (the DB guard trigger would refuse it with 23503).
    vi.mocked(validateWispGrantForSession).mockResolvedValue(validated(ORG_C));
    vi.mocked(getOrCreateThread).mockResolvedValue(thread(ORG_B) as never);

    const res = await post(app, { wispGrantId: GRANT_ID });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'grant_scope_mismatch' });
    expect(h.inserted).toHaveLength(0);
  });

  it('attaches the session only after the insert returned it', async () => {
    const { db } = await import('../db');
    await post(app, { orgId: ORG_A, wispGrantId: GRANT_ID });
    expect(vi.mocked(db.insert).mock.invocationCallOrder[0]!)
      .toBeLessThan(vi.mocked(attachSession).mock.invocationCallOrder[0]!);
  });
});
