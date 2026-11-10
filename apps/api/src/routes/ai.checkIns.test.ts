/**
 * Wisp check-in timers W04 (#10995, feature #10991; spec §4) — fired
 * check-ins reach the model as a prefix of the grantor's next turn in
 * POST /ai/sessions/:id/messages, and are consumed only once that turn is
 * dispatched. A refused turn (402 budget, 409 turn_in_progress) consumes
 * nothing, so the next accepted turn still gets them. Harness copied from
 * ai.messagesStream.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// routes/ai.ts reaches the model registry (ticket-draft) -> candidateLoader,
// which this file's partial schema mock does not cover. Not under test here.
vi.mock('../services/aiModels/sessionModel', () => ({
  resolveSessionTurn: vi.fn(),
}));
import { Hono } from 'hono';

// #3127: depth of the (mocked) short per-phase DB contexts the message-send
// handler opens now that it no longer runs inside a request transaction.
const dbCtx = vi.hoisted(() => ({ depth: 0 }));

// Topology M4 turn harness (#6000 on #3127): the lazily-imported route half.
const topo = vi.hoisted(() => ({
  prepare: vi.fn(),
  abort: vi.fn(async () => undefined),
  cachedEventsDepth: [] as number[],
}));

vi.mock('./aiTopologyTurn', () => ({
  prepareTopologyTurn: topo.prepare,
  cachedTopologyEvents: vi.fn((explanation: unknown) => {
    topo.cachedEventsDepth.push(dbCtx.depth);
    return [
      { type: 'topology_progress', phase: 'validating' },
      { type: 'topology_explanation', explanation },
      { type: 'done' },
    ];
  }),
  topologyMcpServerFactory: vi.fn(),
}));

vi.mock('../config/validate', () => ({
  getConfig: vi.fn(() => ({
    MCP_LLM_PROVIDER: 'anthropic',
    MCP_LLM_BASE_URL: 'http://llm.example.test',
    MCP_LLM_API_KEY: 'k',
    MCP_LLM_PRICE_INPUT_PER_M_USD: 1,
    MCP_LLM_PRICE_OUTPUT_PER_M_USD: 1,
  })),
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  aiSessions: {
    id: 'aiSessions.id',
    orgId: 'aiSessions.orgId',
    flaggedAt: 'aiSessions.flaggedAt',
    flaggedBy: 'aiSessions.flaggedBy',
    flagReason: 'aiSessions.flagReason',
  },
  aiMessages: {
    id: 'aiMessages.id',
    sessionId: 'aiMessages.sessionId',
  },
  aiToolExecutions: {
    id: 'aiToolExecutions.id',
    sessionId: 'aiToolExecutions.sessionId',
    status: 'aiToolExecutions.status',
    toolName: 'aiToolExecutions.toolName',
    createdAt: 'aiToolExecutions.createdAt',
    durationMs: 'aiToolExecutions.durationMs',
    toolInput: 'aiToolExecutions.toolInput',
    approvedBy: 'aiToolExecutions.approvedBy',
    approvedAt: 'aiToolExecutions.approvedAt',
    errorMessage: 'aiToolExecutions.errorMessage',
    completedAt: 'aiToolExecutions.completedAt',
  },
  auditLogs: {
    id: 'auditLogs.id',
    orgId: 'auditLogs.orgId',
    action: 'auditLogs.action',
    timestamp: 'auditLogs.timestamp',
    actorType: 'auditLogs.actorType',
    actorEmail: 'auditLogs.actorEmail',
    resourceType: 'auditLogs.resourceType',
    resourceId: 'auditLogs.resourceId',
    result: 'auditLogs.result',
    errorMessage: 'auditLogs.errorMessage',
    details: 'auditLogs.details',
  },
  aiActionPlans: {
    id: 'aiActionPlans.id',
    status: 'aiActionPlans.status',
    approvedBy: 'aiActionPlans.approvedBy',
    approvedAt: 'aiActionPlans.approvedAt',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: 'org-111',
      accessibleOrgIds: ['org-111'],
      orgCondition: () => undefined,
      canAccessOrg: (id: string) => id === 'org-111',
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  withAuthDbAccessContext: vi.fn(async (_auth: unknown, fn: () => Promise<unknown>) => {
    dbCtx.depth += 1;
    try {
      return await fn();
    } finally {
      dbCtx.depth -= 1;
    }
  }),
}));

vi.mock('../services/aiAgent', () => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
  listSessions: vi.fn(),
  closeSession: vi.fn(),
  getSessionMessages: vi.fn(),
  handleApproval: vi.fn(),
  isIntentBackedExecution: vi.fn(),
  searchSessions: vi.fn(),
}));

vi.mock('../services/aiCostTracker', () => ({
  getSessionHistory: vi.fn(),
  getUsageSummary: vi.fn(),
  updateBudget: vi.fn(),
}));

vi.mock('../services/aiBudgetReservations', () => ({
  reserveAiBudget: vi.fn(async () => ({
    kind: 'unlimited',
    reservationId: '66666666-6666-4666-8666-666666666666',
    dailyPeriodKey: '2026-09-06',
    monthlyPeriodKey: '2026-09-01',
    status: 'active',
  })),
  releaseUnusedAiBudgetReservation: vi.fn(async () => ({
    kind: 'released', reservationId: '66666666-6666-4666-8666-666666666666',
  })),
  markAiBudgetReservationIndeterminate: vi.fn(async () => ({
    kind: 'indeterminate', reservationId: '66666666-6666-4666-8666-666666666666',
  })),
  AiBudgetSessionBusyError: class AiBudgetSessionBusyError extends Error {},
}));

vi.mock('../services/streamingSessionManager', () => ({
  streamingSessionManager: {
    getOrCreate: vi.fn(),
    get: vi.fn(),
    remove: vi.fn(),
    tryTransitionToProcessing: vi.fn(),
    interrupt: vi.fn(),
    startTurnTimeout: vi.fn(),
  },
}));

vi.mock('../services/aiAgentSdk', () => ({
  runPreFlightChecks: vi.fn(),
  settleBlockedTurnForNewMessage: vi.fn(() => Promise.resolve('not_blocked_on_approvals')),
  abortActivePlan: vi.fn(),
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

// W04 (#10995): the DB half of the check-in module is mocked; the renderer is the real one.
const ci = vi.hoisted(() => ({
  load: vi.fn(),
  consume: vi.fn(),
}));
// W05 continuation summary: only the DB read is mocked; the wrapper is real.
const cont = vi.hoisted(() => ({ load: vi.fn(async () => null as string | null) }));
vi.mock('../services/aiModels/continuation', async (orig) => ({
  ...(await orig<typeof import('../services/aiModels/continuation')>()),
  loadContinuationSummary: cont.load,
}));
vi.mock('../services/wisp/checkInTurn', async (orig) => ({
  ...(await orig<typeof import('../services/wisp/checkInTurn')>()),
  loadFiredCheckIns: ci.load,
  markCheckInsConsumed: ci.consume,
}));
// #10426: the lazily-imported standing-state half. Default: nothing to send.
const ss = vi.hoisted(() => ({
  forTurn: vi.fn(async (..._a: unknown[]) => null as { block: string; hash: string } | null),
  markSent: vi.fn(async (..._a: unknown[]) => undefined),
}));
vi.mock('../services/wisp/standingStateTurn', () => ({
  standingStateForTurn: ss.forTurn,
  markStandingStateSent: ss.markSent,
}));

// W05 (#7603): the transition gate. Typed against the real signatures (Codex
// review finding 21): an inferred `{ kind: string }` return would reject the
// later `reason` / `carriedRates` mocks.
const tr = vi.hoisted(() => ({
  readPreviousTurn: vi.fn<(...a: unknown[]) => Promise<import('../services/aiModels/modelTransition').PreviousTurn | null>>(async () => null),
  planModelTransition: vi.fn<(...a: unknown[]) => Promise<import('../services/aiModels/modelTransition').ModelTransition>>(async () => ({ kind: 'fresh' })),
  // undefined = no row: the route keeps the preflight snapshot.
  readSessionOfferingId: vi.fn<(...a: unknown[]) => Promise<string | null | undefined>>(async () => undefined),
}));
vi.mock('../services/aiModels/modelTransition', async (orig) => ({
  ...(await orig<typeof import('../services/aiModels/modelTransition')>()),
  readPreviousTurn: tr.readPreviousTurn,
  planModelTransition: tr.planModelTransition,
  readSessionOfferingId: tr.readSessionOfferingId,
}));

import { aiRoutes } from './ai';
import { db } from '../db';
import { streamingSessionManager } from '../services/streamingSessionManager';
import { runPreFlightChecks } from '../services/aiAgentSdk';
import { AiBudgetSessionBusyError, reserveAiBudget } from '../services/aiBudgetReservations';
import { captureException } from '../services/sentry';
import { makeResolvedModel } from '../services/aiModels/__fixtures__/resolvedModel';
import { SessionEventBus } from '../services/sessionEventBus';
import type { FiredCheckIn } from '../services/wisp/checkInTurn';

const ORG_ID = 'org-111';
const SESSION_ID = '11111111-1111-1111-1111-111111111111';
const GRANT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ROW_ID = '77777777-7777-4777-8777-777777777777';

const REVISION_ID = '88888888-8888-4888-8888-888888888888';

const DB_SESSION = {
  id: SESSION_ID, orgId: ORG_ID, sdkSessionId: null, maxTurns: 50, turnCount: 0,
  systemPrompt: 'sp', title: 'existing title', type: 'general', deviceId: null,
  wispGrantId: GRANT_ID, wispGrantRevisionId: REVISION_ID,
};

const STANDING = { block: '<wisp_standing_state as_of="2026-11-04 14:40 UTC">\nConcerns open: 1 high · 0 medium · 0 low\n</wisp_standing_state>', hash: 'h1' };

const FIRED: FiredCheckIn[] = [
  {
    id: 'ci-1', instruction: 'Verify no msiexec processes remain.',
    createdAt: new Date('2026-11-04T14:22:00Z'), firedAt: new Date('2026-11-04T14:32:00Z'), context: null,
  },
  {
    id: 'ci-2', instruction: 'Re-check the disk queue.',
    createdAt: new Date('2026-11-04T14:25:00Z'), firedAt: new Date('2026-11-04T14:35:00Z'), context: null,
  },
];

function makeActiveSession() {
  const active = {
    breezeSessionId: SESSION_ID,
    orgId: ORG_ID,
    state: 'processing',
    turnId: 'turn-1',
    turnUserMessageId: null as string | null,
    pendingRunResults: [] as unknown[],
    inputController: { pushMessage: vi.fn() },
    eventBus: new SessionEventBus(),
  } as any;
  active.inputController.pushMessage = vi.fn(() => active.eventBus.publish({ type: 'done' }));
  return active;
}

function post(app: Hono) {
  return app.request(`/ai/sessions/${SESSION_ID}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
    body: JSON.stringify({ content: 'hi there' }),
  });
}

describe('POST /ai/sessions/:id/messages — fired Wisp check-ins (#10995)', () => {
  let app: Hono;
  let insertValues: ReturnType<typeof vi.fn>;
  let active: ReturnType<typeof makeActiveSession>;
  const model = makeResolvedModel('anthropic_byok');

  function preflight(session: Record<string, unknown> = DB_SESSION) {
    vi.mocked(runPreFlightChecks).mockResolvedValue({
      ok: true, session: { ...session } as any,
      sanitizedContent: 'hi there', systemPrompt: 'sys', maxBudgetUsd: undefined, model,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/ai', aiRoutes);
    preflight();
    vi.mocked(streamingSessionManager.get).mockReturnValue(undefined);
    vi.mocked(streamingSessionManager.tryTransitionToProcessing).mockReturnValue(true);
    insertValues = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: USER_ROW_ID }]) });
    vi.mocked(db.insert).mockReturnValue({ values: insertValues } as any);
    active = makeActiveSession();
    vi.mocked(streamingSessionManager.getOrCreate).mockResolvedValue(active);
    ci.load.mockResolvedValue(FIRED);
    ci.consume.mockResolvedValue(FIRED.length);
  });

  afterEach(() => {
    vi.mocked(runPreFlightChecks).mockReset();
  });

  function pushed(): string {
    expect(active.inputController.pushMessage).toHaveBeenCalledTimes(1);
    return active.inputController.pushMessage.mock.calls[0][0] as string;
  }

  it('prepends fired check-ins to the pushed turn and stores the user row without them', async () => {
    const res = await post(app);
    expect(res.status).toBe(200);
    await res.text();

    expect(ci.load).toHaveBeenCalledWith(GRANT_ID, 'user-1');
    const turn = pushed();
    expect(turn.startsWith('<wisp_check_ins>\n[Wisp check-in fired 2026-11-04 14:32 UTC')).toBe(true);
    expect(turn).toContain('Instruction: Verify no msiexec processes remain.\n\n[Wisp check-in fired 2026-11-04 14:35 UTC');
    expect(turn).toContain('act on them as far as the user\'s message below asks');
    expect(turn.endsWith('\n\nhi there')).toBe(true);

    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ role: 'user', content: 'hi there' }));
    // Never the system prompt.
    const systemPromptArg = vi.mocked(streamingSessionManager.getOrCreate).mock.calls[0]![4];
    expect(systemPromptArg).toBe('sys');
  });

  it('reads the check-ins before the budget reservation', async () => {
    await (await post(app)).text();
    expect(ci.load.mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(reserveAiBudget).mock.invocationCallOrder[0]!);
  });

  it('analysis results come first, then check-ins, then the user text', async () => {
    active.pendingRunResults = [{
      runId: 'run-1', status: 'completed', summary: 'All clear.', artifacts: [],
    }];
    await (await post(app)).text();
    const turn = pushed();
    const runAt = turn.indexOf('[breeze:analysis-results]');
    const checkInAt = turn.indexOf('<wisp_check_ins>');
    const userAt = turn.lastIndexOf('hi there');
    expect(runAt).toBe(0);
    expect(checkInAt).toBeGreaterThan(runAt);
    expect(userAt).toBeGreaterThan(turn.indexOf('</wisp_check_ins>'));
  });

  it('marks them consumed only after the turn is dispatched', async () => {
    await (await post(app)).text();
    expect(ci.consume).toHaveBeenCalledTimes(1);
    expect(ci.consume).toHaveBeenCalledWith({ grantId: GRANT_ID, ids: ['ci-1', 'ci-2'] });
    expect(ci.consume.mock.invocationCallOrder[0]!)
      .toBeGreaterThan(active.inputController.pushMessage.mock.invocationCallOrder[0]!);
  });

  it('consumes nothing when the budget reservation is denied (402)', async () => {
    vi.mocked(reserveAiBudget).mockResolvedValueOnce({ kind: 'denied', message: 'Daily AI budget exceeded' } as any);
    const res = await post(app);
    expect(res.status).toBe(402);
    expect(ci.consume).not.toHaveBeenCalled();
    expect(active.inputController.pushMessage).not.toHaveBeenCalled();
  });

  it('consumes nothing when the processing slot is lost (409 turn_in_progress)', async () => {
    vi.mocked(streamingSessionManager.tryTransitionToProcessing).mockReturnValue(false);
    const res = await post(app);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'turn_in_progress' });
    expect(ci.consume).not.toHaveBeenCalled();
    expect(active.inputController.pushMessage).not.toHaveBeenCalled();
  });

  it('consumes nothing when the user row cannot be stored (500)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    insertValues.mockReturnValue({ returning: vi.fn().mockRejectedValue(new Error('db down')) });
    const res = await post(app);
    expect(res.status).toBe(500);
    expect(ci.consume).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it('a session without wispGrantId never reads check-ins', async () => {
    preflight({ ...DB_SESSION, wispGrantId: null });
    await (await post(app)).text();
    expect(ci.load).not.toHaveBeenCalled();
    expect(ci.consume).not.toHaveBeenCalled();
    expect(pushed()).toBe('hi there');
  });

  it('nothing fired: the turn is pushed unprefixed and nothing is consumed', async () => {
    ci.load.mockResolvedValue([]);
    await (await post(app)).text();
    expect(pushed()).toBe('hi there');
    expect(ci.consume).not.toHaveBeenCalled();
  });

  it('a read failure is reported and the turn is pushed unprefixed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const boom = new Error('read failed');
    ci.load.mockRejectedValue(boom);
    const res = await post(app);
    expect(res.status).toBe(200);
    await res.text();
    expect(pushed()).toBe('hi there');
    expect(captureException).toHaveBeenCalledWith(
      boom, expect.anything(), { wisp_check_in_phase: 'read' }, { fingerprint: ['wisp-check-in-turn', 'read'] },
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('check-ins'), expect.objectContaining({ grantId: GRANT_ID }));
    expect(ci.consume).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a consume failure is reported and the response still streams', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const boom = new Error('update failed');
    ci.consume.mockRejectedValue(boom);
    const res = await post(app);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('event: done');
    expect(captureException).toHaveBeenCalledWith(
      boom, expect.anything(), { wisp_check_in_phase: 'consume' }, { fingerprint: ['wisp-check-in-turn', 'consume'] },
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('consumed'), expect.objectContaining({ grantId: GRANT_ID, ids: ['ci-1', 'ci-2'] }));
    warn.mockRestore();
  });

  it('a consume that matches no row says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    ci.consume.mockResolvedValue(0);
    await (await post(app)).text();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no Wisp check-in was marked consumed'), expect.objectContaining({ ids: ['ci-1', 'ci-2'] }));
    warn.mockRestore();
  });

  it('check-ins come before a continuation summary, and the user text stays last', async () => {
    preflight({ ...DB_SESSION, continuedFromSessionId: '33333333-3333-4333-8333-333333333333' });
    cont.load.mockResolvedValueOnce('Earlier: the disk was full.');
    await (await post(app)).text();
    const turn = pushed();
    const checkInEnd = turn.indexOf('</wisp_check_ins>');
    const summaryAt = turn.indexOf('<prior_conversation_summary>');
    expect(turn.startsWith('<wisp_check_ins>')).toBe(true);
    expect(summaryAt).toBeGreaterThan(checkInEnd);
    expect(turn.endsWith('\n\nhi there')).toBe(true);
    // Neither block appears anywhere else the model reads from.
    for (const arg of vi.mocked(streamingSessionManager.getOrCreate).mock.calls[0]!) {
      expect(JSON.stringify(arg ?? null)).not.toContain('wisp_check_ins');
    }
  });

  it('a topology turn never reads or prepends check-ins', async () => {
    preflight({ ...DB_SESSION, type: 'topology' });
    topo.prepare.mockResolvedValueOnce({
      ok: true,
      prepared: { kind: 'live', runtime: { abort: topo.abort }, prompt: 'TOPOLOGY PROMPT', systemPrompt: 'TOPOLOGY SYSTEM', allowedMcpTools: [] },
    });
    await (await post(app)).text();
    expect(ci.load).not.toHaveBeenCalled();
    expect(ci.consume).not.toHaveBeenCalled();
    expect(pushed()).toBe('TOPOLOGY PROMPT');
  });

  it('consumes nothing when the budget lock reports the session busy (409)', async () => {
    vi.mocked(reserveAiBudget).mockRejectedValueOnce(new AiBudgetSessionBusyError('busy'));
    const res = await post(app);
    expect(res.status).toBe(409);
    expect(ci.consume).not.toHaveBeenCalled();
  });

  it('consumes nothing when the session cannot be created (409 wisp_session_unavailable, or a throw)', async () => {
    vi.mocked(streamingSessionManager.getOrCreate).mockRejectedValueOnce(
      Object.assign(new Error('grant paused'), { code: 'wisp_session_unavailable' }),
    );
    const res = await post(app);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'wisp_session_unavailable' });

    vi.mocked(streamingSessionManager.getOrCreate).mockRejectedValueOnce(new Error('sdk exploded'));
    const res2 = await post(app);
    expect(res2.status).toBe(500);
    expect(ci.consume).not.toHaveBeenCalled();
  });

  describe('the standing-state block (#10426)', () => {
    beforeEach(() => {
      ss.forTurn.mockResolvedValue(STANDING);
    });

    it('a Wisp turn opens with the standing state, before the check-ins, and the user text stays last', async () => {
      await (await post(app)).text();
      expect(ss.forTurn).toHaveBeenCalledWith({ grantId: GRANT_ID, revisionId: REVISION_ID, sessionId: SESSION_ID, auth: expect.objectContaining({ user: expect.objectContaining({ id: 'user-1' }) }) });
      const turn = pushed();
      expect(turn.startsWith('<wisp_standing_state')).toBe(true);
      expect(turn.indexOf('<wisp_check_ins>')).toBeGreaterThan(turn.indexOf('</wisp_standing_state>'));
      expect(turn.endsWith('\n\nhi there')).toBe(true);
      // The stored user row and the system prompt never carry it.
      expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ role: 'user', content: 'hi there' }));
      for (const arg of vi.mocked(streamingSessionManager.getOrCreate).mock.calls[0]!) {
        expect(JSON.stringify(arg ?? null)).not.toContain('wisp_standing_state');
      }
    });

    it('without fired check-ins the standing state sits directly before the user text', async () => {
      ci.load.mockResolvedValue([]);
      await (await post(app)).text();
      expect(pushed()).toBe(`${STANDING.block}\n\nhi there`);
    });

    it('is read before the budget reservation and recorded as sent only after dispatch', async () => {
      await (await post(app)).text();
      expect(ss.forTurn.mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(reserveAiBudget).mock.invocationCallOrder[0]!);
      expect(ss.markSent).toHaveBeenCalledWith(SESSION_ID, 'h1');
      expect(ss.markSent.mock.invocationCallOrder[0]!)
        .toBeGreaterThan(active.inputController.pushMessage.mock.invocationCallOrder[0]!);
    });

    it('analysis results stay outermost: results, standing state, check-ins, user text', async () => {
      active.pendingRunResults = [{ runId: 'run-1', status: 'completed', summary: 'All clear.', artifacts: [] }];
      await (await post(app)).text();
      const turn = pushed();
      const runAt = turn.indexOf('[breeze:analysis-results]');
      const standingAt = turn.indexOf('<wisp_standing_state');
      const checkInAt = turn.indexOf('<wisp_check_ins>');
      expect(runAt).toBe(0);
      expect(standingAt).toBeGreaterThan(runAt);
      expect(checkInAt).toBeGreaterThan(standingAt);
      expect(turn.endsWith('\n\nhi there')).toBe(true);
    });

    it('instruction capture (#10428) gets only the technician text, never the blocks Wisp adds to the turn', async () => {
      active.pendingRunResults = [{ runId: 'run-1', status: 'completed', summary: 'All clear.', artifacts: [] }];
      preflight({ ...DB_SESSION, continuedFromSessionId: '33333333-3333-4333-8333-333333333333' });
      cont.load.mockResolvedValueOnce('Earlier: the disk was full.');
      await (await post(app)).text();
      // Every injected block really is on the turn the model reads...
      const turn = pushed();
      for (const marker of ['[breeze:analysis-results]', '<wisp_standing_state', '<wisp_check_ins>', '<prior_conversation_summary>']) {
        expect(turn).toContain(marker);
      }
      // ...and none of them reaches the turn record the capture reads.
      const opts = vi.mocked(streamingSessionManager.tryTransitionToProcessing).mock.calls[0]![2]!;
      expect(opts.userMessage).toBe('hi there');
    });

    it('a topology turn hands instruction capture nothing', async () => {
      preflight({ ...DB_SESSION, type: 'topology' });
      topo.prepare.mockResolvedValueOnce({
        ok: true,
        prepared: { kind: 'live', runtime: { abort: topo.abort }, prompt: 'TOPOLOGY PROMPT', systemPrompt: 'TOPOLOGY SYSTEM', allowedMcpTools: [] },
      });
      await (await post(app)).text();
      const opts = vi.mocked(streamingSessionManager.tryTransitionToProcessing).mock.calls[0]![2]!;
      expect(opts).not.toHaveProperty('userMessage');
    });

    it('a failure to record it after dispatch still streams the turn', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      ss.markSent.mockRejectedValueOnce(new Error('unexpected'));
      const res = await post(app);
      expect(res.status).toBe(200);
      await res.text();
      expect(pushed().startsWith('<wisp_standing_state')).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('standing state as sent'), expect.objectContaining({ sessionId: SESSION_ID }));
      warn.mockRestore();
    });

    it('a session that cannot be created (409 wisp_session_unavailable) records nothing', async () => {
      vi.mocked(streamingSessionManager.getOrCreate).mockRejectedValueOnce(
        Object.assign(new Error('grant paused'), { code: 'wisp_session_unavailable' }),
      );
      expect((await post(app)).status).toBe(409);
      expect(ss.markSent).not.toHaveBeenCalled();
    });

    it('a refused turn (402) records nothing, so the next turn still carries it', async () => {
      vi.mocked(reserveAiBudget).mockResolvedValueOnce({ kind: 'denied', message: 'Daily AI budget exceeded' } as any);
      expect((await post(app)).status).toBe(402);
      expect(ss.markSent).not.toHaveBeenCalled();
    });

    it('nothing new to say: the turn is unchanged and nothing is recorded', async () => {
      ss.forTurn.mockResolvedValue(null);
      ci.load.mockResolvedValue([]);
      await (await post(app)).text();
      expect(pushed()).toBe('hi there');
      expect(ss.markSent).not.toHaveBeenCalled();
    });

    it('a non-Wisp turn never reads it and is byte-for-byte unchanged', async () => {
      preflight({ ...DB_SESSION, wispGrantId: null, wispGrantRevisionId: null });
      await (await post(app)).text();
      expect(ss.forTurn).not.toHaveBeenCalled();
      expect(pushed()).toBe('hi there');
    });

    it('a session with no revision pin reads nothing', async () => {
      preflight({ ...DB_SESSION, wispGrantRevisionId: null });
      ci.load.mockResolvedValue([]);
      await (await post(app)).text();
      expect(ss.forTurn).not.toHaveBeenCalled();
      expect(pushed()).toBe('hi there');
    });

    it('a failure to load it is reported and the turn goes out without it', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const boom = new Error('module load failed');
      ss.forTurn.mockRejectedValue(boom);
      ci.load.mockResolvedValue([]);
      const res = await post(app);
      expect(res.status).toBe(200);
      await res.text();
      expect(pushed()).toBe('hi there');
      expect(captureException).toHaveBeenCalledWith(boom, expect.anything(), { wisp_standing_state_phase: 'read' });
      warn.mockRestore();
    });

    it('a topology turn never reads it', async () => {
      preflight({ ...DB_SESSION, type: 'topology' });
      topo.prepare.mockResolvedValueOnce({
        ok: true,
        prepared: { kind: 'live', runtime: { abort: topo.abort }, prompt: 'TOPOLOGY PROMPT', systemPrompt: 'TOPOLOGY SYSTEM', allowedMcpTools: [] },
      });
      await (await post(app)).text();
      expect(ss.forTurn).not.toHaveBeenCalled();
      expect(pushed()).toBe('TOPOLOGY PROMPT');
    });
  });
});
