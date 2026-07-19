import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted shared mock state
// ---------------------------------------------------------------------------

const { schema, dbState, intentServiceMock, actorContextMock, tenantStatusMock, aiToolsMock, aiGuardrailsMock, authMock, auditMock, metricsMock, sentryMock, toolTimeoutsMock, googleHeadlessMock } = vi.hoisted(() => {
  const col = (name: string) => ({ name });
  const actionIntentsTbl = { id: col('id') };
  const approvalRequestsTbl = { id: col('id'), intentId: col('intent_id'), status: col('status') };

  return {
    schema: { actionIntentsTbl, approvalRequestsTbl },
    dbState: {
      selectActionIntentsResults: [] as unknown[][],
      selectApprovalRequestsResults: [] as unknown[][],
    },
    intentServiceMock: { transitionIntent: vi.fn() },
    actorContextMock: { buildAuthContextForIntent: vi.fn() },
    tenantStatusMock: { getActiveOrgTenant: vi.fn() },
    aiToolsMock: { getToolTier: vi.fn(), executeTool: vi.fn(), requiresLiveSession: vi.fn() },
    aiGuardrailsMock: { checkToolPermission: vi.fn() },
    authMock: { dbAccessContextFromAuth: vi.fn((auth: unknown) => ({ mock: 'dbContext', auth })) },
    auditMock: {
      writeAuditEvent: vi.fn(),
      requestLikeFromSnapshot: vi.fn((..._args: unknown[]) => ({ req: { header: () => undefined } })),
    },
    metricsMock: {
      recordActionIntentEvent: vi.fn(),
      recordActionIntentMetric: vi.fn(),
    },
    sentryMock: { captureException: vi.fn() },
    // getToolTimeout is mocked (per-test override); withToolTimeout is kept
    // REAL (see vi.mock below) so the timeout test's timer actually fires.
    toolTimeoutsMock: { getToolTimeout: vi.fn() },
    googleHeadlessMock: {
      isHeadlessGoogleTool: vi.fn(() => false),
      executeGoogleToolHeadless: vi.fn(),
    },
  };
});

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => {
            if (table === schema.actionIntentsTbl) {
              return Promise.resolve(dbState.selectActionIntentsResults.shift() ?? []);
            }
            if (table === schema.approvalRequestsTbl) {
              return Promise.resolve(dbState.selectApprovalRequestsResults.shift() ?? []);
            }
            throw new Error('unexpected select table in mock');
          }),
        })),
      })),
    })),
  },
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema/actionIntents', () => ({ actionIntents: schema.actionIntentsTbl }));
vi.mock('../db/schema/approvals', () => ({ approvalRequests: schema.approvalRequestsTbl }));

vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('../services/sentry', () => ({ captureException: sentryMock.captureException }));
vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: auditMock.writeAuditEvent,
  requestLikeFromSnapshot: auditMock.requestLikeFromSnapshot,
}));
vi.mock('../services/actionIntents/metrics', () => ({
  recordActionIntentEvent: metricsMock.recordActionIntentEvent,
  recordActionIntentMetric: metricsMock.recordActionIntentMetric,
}));
vi.mock('../services/actionIntents/intentService', () => ({
  transitionIntent: intentServiceMock.transitionIntent,
}));
vi.mock('../services/actionIntents/actorContext', () => ({
  buildAuthContextForIntent: actorContextMock.buildAuthContextForIntent,
}));
vi.mock('../services/tenantStatus', () => ({
  getActiveOrgTenant: tenantStatusMock.getActiveOrgTenant,
}));
vi.mock('../services/aiTools', () => ({
  getToolTier: aiToolsMock.getToolTier,
  executeTool: aiToolsMock.executeTool,
  requiresLiveSession: aiToolsMock.requiresLiveSession,
}));
vi.mock('../services/aiGuardrails', () => ({
  checkToolPermission: aiGuardrailsMock.checkToolPermission,
}));
vi.mock('../middleware/auth', () => ({
  dbAccessContextFromAuth: authMock.dbAccessContextFromAuth,
}));
vi.mock('../services/googleToolsHeadless', () => ({
  isHeadlessGoogleTool: googleHeadlessMock.isHeadlessGoogleTool,
  executeGoogleToolHeadless: googleHeadlessMock.executeGoogleToolHeadless,
  GoogleConnectionUnavailableError: class GoogleConnectionUnavailableError extends Error {
    constructor(public readonly toolResult: string) { super('unavailable'); }
  },
}));
// Partial mock: getToolTimeout is stubbed per-test, withToolTimeout stays the
// REAL implementation so its setTimeout-based rejection genuinely fires.
vi.mock('../services/toolTimeouts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/toolTimeouts')>();
  return { ...actual, getToolTimeout: toolTimeoutsMock.getToolTimeout };
});

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ op: 'eq', args })),
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
}));

// bullmq is a real dependency we don't want to spin up — mock Worker/Job to
// inert stand-ins since these tests only exercise the exported functions,
// never `createWorker` itself.
vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({ on: vi.fn(), close: vi.fn() })),
  Job: class {},
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { releaseApprovedIntent, processIntentReleaseJob } from './intentReleaseWorker';
import type { ActionIntent } from '../db/schema/actionIntents';
import { GoogleConnectionUnavailableError } from '../services/googleToolsHeadless';

function baseIntent(overrides: Partial<ActionIntent> = {}): ActionIntent {
  return {
    id: 'intent-1',
    orgId: 'org-1',
    partnerId: null,
    requestedByUserId: 'user-1',
    requestingApiKeyId: null,
    source: 'chat',
    requestingClientLabel: null,
    actionName: 'run_script',
    actionVersion: 1,
    arguments: { scriptId: 'abc' },
    argumentDigest: 'digest-1',
    targetSummary: 'run_script(scriptId=abc)',
    impactSummary: 'Runs a script',
    reason: null,
    riskTier: 3,
    connectionId: null,
    tenantId: null,
    idempotencyKey: 'idem-1',
    correlationId: 'corr-1',
    status: 'executing',
    createdAt: new Date(),
    expiresAt: new Date(),
    decidedAt: new Date(),
    decidedByUserId: 'approver-1',
    decidedAssuranceLevel: 1,
    decidedVia: 'session_tap',
    executedAt: null,
    result: null,
    errorCode: null,
    ...overrides,
  } as ActionIntent;
}

const fakeAuth = {
  user: { id: 'user-1', email: 'a@b.com', name: 'A', isPlatformAdmin: false },
  token: {},
  partnerId: null,
  orgId: 'org-1',
  scope: 'organization' as const,
  accessibleOrgIds: ['org-1'],
  orgCondition: () => undefined,
  canAccessOrg: () => true,
};

function resetDbState() {
  dbState.selectActionIntentsResults.length = 0;
  dbState.selectApprovalRequestsResults.length = 0;
}

/** Sets up the common happy-path mocks through the last revalidation step, before executeTool. */
function primeThroughRevalidation(intent: ActionIntent) {
  intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // approved -> executing
  dbState.selectActionIntentsResults.push([intent]);
  dbState.selectApprovalRequestsResults.push([
    { id: 'approval-1', status: 'approved', boundArgumentDigest: intent.argumentDigest },
  ]);
  aiToolsMock.getToolTier.mockReturnValue(intent.riskTier);
  actorContextMock.buildAuthContextForIntent.mockResolvedValueOnce(fakeAuth);
  tenantStatusMock.getActiveOrgTenant.mockResolvedValueOnce({ orgId: intent.orgId, partnerId: 'partner-1' });
  aiGuardrailsMock.checkToolPermission.mockResolvedValueOnce(null);
  // Safe default so withToolTimeout's real timer never fires during tests
  // that aren't specifically exercising the timeout path.
  toolTimeoutsMock.getToolTimeout.mockReturnValue(60_000);
}

describe('releaseApprovedIntent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbState();
    googleHeadlessMock.isHeadlessGoogleTool.mockReturnValue(false);
  });

  it('double delivery: CAS approved->executing returns false — exits without touching anything else', async () => {
    intentServiceMock.transitionIntent.mockResolvedValueOnce(false);

    await releaseApprovedIntent('intent-1');

    expect(intentServiceMock.transitionIntent).toHaveBeenCalledTimes(1);
    expect(intentServiceMock.transitionIntent).toHaveBeenCalledWith(
      'intent-1', 'approved', 'executing',
      expect.objectContaining({ executedAt: null, executionStartedAt: expect.any(Date) }),
      { requireNotExpired: true },
    );
    expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
    expect(actorContextMock.buildAuthContextForIntent).not.toHaveBeenCalled();
  });

  it('stamps execution_started_at when it claims the intent (approved -> executing)', async () => {
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // claim CAS
    dbState.selectActionIntentsResults.push([]); // short-circuit: intent row missing after CAS

    await releaseApprovedIntent('intent-3');

    expect(intentServiceMock.transitionIntent).toHaveBeenCalledWith(
      'intent-3', 'approved', 'executing',
      expect.objectContaining({ executedAt: null, executionStartedAt: expect.any(Date) }),
      { requireNotExpired: true },
    );
  });

  it('happy path: CAS -> revalidate -> executeTool -> CAS completed, with a JSON result', async () => {
    const intent = baseIntent();
    primeThroughRevalidation(intent);
    aiToolsMock.executeTool.mockResolvedValueOnce(JSON.stringify({ ok: true, message: 'done' }));
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> completed

    await releaseApprovedIntent(intent.id);

    expect(aiGuardrailsMock.checkToolPermission).toHaveBeenCalledWith(
      intent.actionName,
      intent.arguments,
      fakeAuth,
    );
    expect(aiToolsMock.executeTool).toHaveBeenCalledWith(intent.actionName, intent.arguments, fakeAuth);
    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id,
      'executing',
      'completed',
      expect.objectContaining({
        result: { ok: true, message: 'done' },
        executedAt: expect.any(Date),
      }),
    );
    expect(metricsMock.recordActionIntentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ intentId: intent.id, outcome: 'executed' }),
    );
    expect(auditMock.writeAuditEvent).not.toHaveBeenCalled();
  });

  it('returned tool error (JSON {error}) -> failed:tool_returned_error, not completed', async () => {
    const intent = baseIntent();
    primeThroughRevalidation(intent);
    // executeTool did not throw, but handed back an error body (e.g. device
    // access revoked after approval). Must be recorded as a FAILED release.
    aiToolsMock.executeTool.mockResolvedValueOnce(
      JSON.stringify({ error: 'Device not found or access denied' }),
    );
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> failed

    await releaseApprovedIntent(intent.id);

    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id,
      'executing',
      'failed',
      expect.objectContaining({
        errorCode: 'tool_returned_error',
        result: { error: 'Device not found or access denied' },
        executedAt: expect.any(Date),
      }),
    );
    // Failure audit written, and NOT recorded as an executed success.
    expect(auditMock.writeAuditEvent).toHaveBeenCalled();
    expect(metricsMock.recordActionIntentEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'executed' }),
    );
  });

  it('a JSON body with both {error} and {success} is treated as success (not a returned error)', async () => {
    const intent = baseIntent();
    primeThroughRevalidation(intent);
    aiToolsMock.executeTool.mockResolvedValueOnce(JSON.stringify({ success: true, error: null }));
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> completed

    await releaseApprovedIntent(intent.id);

    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id,
      'executing',
      'completed',
      expect.anything(),
    );
  });

  it('digest_mismatch: no winning approval row found -> failed, executeTool never called', async () => {
    const intent = baseIntent();
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true);
    dbState.selectActionIntentsResults.push([intent]);
    dbState.selectApprovalRequestsResults.push([]); // no approved row
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> failed

    await releaseApprovedIntent(intent.id);

    expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id,
      'executing',
      'failed',
      expect.objectContaining({ errorCode: 'digest_mismatch' }),
    );
    expect(auditMock.writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ result: 'failure', details: expect.objectContaining({ errorCode: 'digest_mismatch' }) }),
    );
    expect(metricsMock.recordActionIntentMetric).toHaveBeenCalledWith(intent.source, intent.actionName, 'executed');
  });

  it('digest_mismatch: winning approval digest no longer matches the intent', async () => {
    const intent = baseIntent();
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true);
    dbState.selectActionIntentsResults.push([intent]);
    dbState.selectApprovalRequestsResults.push([
      { id: 'approval-1', status: 'approved', boundArgumentDigest: 'stale-digest' },
    ]);
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true);

    await releaseApprovedIntent(intent.id);

    expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id,
      'executing',
      'failed',
      expect.objectContaining({ errorCode: 'digest_mismatch' }),
    );
  });

  it('tier_escalated: getToolTier increased since intent creation', async () => {
    const intent = baseIntent({ riskTier: 3 });
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true);
    dbState.selectActionIntentsResults.push([intent]);
    dbState.selectApprovalRequestsResults.push([
      { id: 'approval-1', status: 'approved', boundArgumentDigest: intent.argumentDigest },
    ]);
    aiToolsMock.getToolTier.mockReturnValue(4);
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true);

    await releaseApprovedIntent(intent.id);

    expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id,
      'executing',
      'failed',
      expect.objectContaining({ errorCode: 'tier_escalated' }),
    );
  });

  it('tier_escalated: tool no longer exists (getToolTier undefined)', async () => {
    const intent = baseIntent();
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true);
    dbState.selectActionIntentsResults.push([intent]);
    dbState.selectApprovalRequestsResults.push([
      { id: 'approval-1', status: 'approved', boundArgumentDigest: intent.argumentDigest },
    ]);
    aiToolsMock.getToolTier.mockReturnValue(undefined);
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true);

    await releaseApprovedIntent(intent.id);

    expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id,
      'executing',
      'failed',
      expect.objectContaining({ errorCode: 'tier_escalated' }),
    );
  });

  it('actor_invalid: buildAuthContextForIntent returns null', async () => {
    const intent = baseIntent();
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true);
    dbState.selectActionIntentsResults.push([intent]);
    dbState.selectApprovalRequestsResults.push([
      { id: 'approval-1', status: 'approved', boundArgumentDigest: intent.argumentDigest },
    ]);
    aiToolsMock.getToolTier.mockReturnValue(intent.riskTier);
    actorContextMock.buildAuthContextForIntent.mockResolvedValueOnce(null);
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true);

    await releaseApprovedIntent(intent.id);

    expect(tenantStatusMock.getActiveOrgTenant).not.toHaveBeenCalled();
    expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id,
      'executing',
      'failed',
      expect.objectContaining({ errorCode: 'actor_invalid' }),
    );
  });

  it('org_inactive: getActiveOrgTenant returns null', async () => {
    const intent = baseIntent();
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true);
    dbState.selectActionIntentsResults.push([intent]);
    dbState.selectApprovalRequestsResults.push([
      { id: 'approval-1', status: 'approved', boundArgumentDigest: intent.argumentDigest },
    ]);
    aiToolsMock.getToolTier.mockReturnValue(intent.riskTier);
    actorContextMock.buildAuthContextForIntent.mockResolvedValueOnce(fakeAuth);
    tenantStatusMock.getActiveOrgTenant.mockResolvedValueOnce(null);
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true);

    await releaseApprovedIntent(intent.id);

    expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id,
      'executing',
      'failed',
      expect.objectContaining({ errorCode: 'org_inactive' }),
    );
  });

  it('rbac_denied: actor is still an active org member but no longer holds the tool permission', async () => {
    const intent = baseIntent();
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // approved -> executing
    dbState.selectActionIntentsResults.push([intent]);
    dbState.selectApprovalRequestsResults.push([
      { id: 'approval-1', status: 'approved', boundArgumentDigest: intent.argumentDigest },
    ]);
    aiToolsMock.getToolTier.mockReturnValue(intent.riskTier);
    actorContextMock.buildAuthContextForIntent.mockResolvedValueOnce(fakeAuth);
    tenantStatusMock.getActiveOrgTenant.mockResolvedValueOnce({ orgId: intent.orgId, partnerId: 'partner-1' });
    aiGuardrailsMock.checkToolPermission.mockResolvedValueOnce(
      'Insufficient permissions: requires scripts.run',
    );
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> failed

    await releaseApprovedIntent(intent.id);

    expect(aiGuardrailsMock.checkToolPermission).toHaveBeenCalledWith(
      intent.actionName,
      intent.arguments,
      fakeAuth,
    );
    expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id,
      'executing',
      'failed',
      expect.objectContaining({ errorCode: 'rbac_denied' }),
    );
    expect(auditMock.writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        result: 'failure',
        details: expect.objectContaining({
          errorCode: 'rbac_denied',
          reason: 'Insufficient permissions: requires scripts.run',
        }),
      }),
    );
    expect(metricsMock.recordActionIntentMetric).toHaveBeenCalledWith(intent.source, intent.actionName, 'executed');
  });

  it('fails a session-aware tool with session_required and never calls executeTool', async () => {
    const intent = baseIntent({ id: 'intent-2', actionName: 'm365_disable_user' });
    primeThroughRevalidation(intent);
    aiToolsMock.requiresLiveSession.mockReturnValueOnce(true);
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> failed

    await releaseApprovedIntent('intent-2');

    expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
    expect(intentServiceMock.transitionIntent).toHaveBeenCalledWith(
      'intent-2',
      'executing',
      'failed',
      expect.objectContaining({ errorCode: 'session_required' }),
    );
  });

  it('executeTool throws -> failed:execution_error, with executedAt stamped', async () => {
    const intent = baseIntent();
    primeThroughRevalidation(intent);
    aiToolsMock.executeTool.mockRejectedValueOnce(new Error('boom'));
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> failed

    await releaseApprovedIntent(intent.id);

    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id,
      'executing',
      'failed',
      expect.objectContaining({ errorCode: 'execution_error', executedAt: expect.any(Date) }),
    );
    expect(auditMock.writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ details: expect.objectContaining({ error: 'boom' }) }),
    );
  });

  it('fails the intent with execution_error when the tool exceeds its timeout', async () => {
    const intent = baseIntent();
    primeThroughRevalidation(intent);
    toolTimeoutsMock.getToolTimeout.mockReturnValue(5); // tiny — real withToolTimeout fires fast
    aiToolsMock.executeTool.mockReturnValue(new Promise<string>(() => {})); // never settles
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> failed

    await releaseApprovedIntent(intent.id);

    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id,
      'executing',
      'failed',
      expect.objectContaining({ errorCode: 'execution_error', executedAt: expect.any(Date) }),
    );
  });

  it('result over 64 KiB is stored as {truncated:true}, and still completes', async () => {
    const intent = baseIntent();
    primeThroughRevalidation(intent);
    const hugeResult = JSON.stringify({ data: 'x'.repeat(70 * 1024) });
    aiToolsMock.executeTool.mockResolvedValueOnce(hugeResult);
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true);

    await releaseApprovedIntent(intent.id);

    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id,
      'executing',
      'completed',
      expect.objectContaining({ result: { truncated: true } }),
    );
    expect(metricsMock.recordActionIntentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ truncated: true }) }),
    );
  });

  it('non-JSON string result is wrapped as {raw: ...}', async () => {
    const intent = baseIntent();
    primeThroughRevalidation(intent);
    aiToolsMock.executeTool.mockResolvedValueOnce('plain text result');
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true);

    await releaseApprovedIntent(intent.id);

    expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
      intent.id,
      'executing',
      'completed',
      expect.objectContaining({ result: { raw: 'plain text result' } }),
    );
  });

  it('lost the executing->completed CAS after real execution: logs, does not throw', async () => {
    const intent = baseIntent();
    primeThroughRevalidation(intent);
    aiToolsMock.executeTool.mockResolvedValueOnce(JSON.stringify({ ok: true }));
    intentServiceMock.transitionIntent.mockResolvedValueOnce(false); // lost completed CAS

    await expect(releaseApprovedIntent(intent.id)).resolves.toBeUndefined();

    expect(sentryMock.captureException).toHaveBeenCalled();
    expect(metricsMock.recordActionIntentEvent).not.toHaveBeenCalled();
  });

  it('intent row missing after the CAS (unreachable in practice): logs and returns', async () => {
    intentServiceMock.transitionIntent.mockResolvedValueOnce(true);
    dbState.selectActionIntentsResults.push([]);

    await expect(releaseApprovedIntent('intent-missing')).resolves.toBeUndefined();
    expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
  });

  describe('headless Google branch', () => {
    it('executes a headless Google tool and CASes to completed (not session_required)', async () => {
      // orgId deliberately distinct from fakeAuth.orgId ('org-1') so the
      // executeGoogleToolHeadless assertion below can only pass if the worker
      // threads intent.orgId through — not auth.orgId.
      const intent = baseIntent({ actionName: 'google_suspend_user', orgId: 'org-2' });
      primeThroughRevalidation(intent);
      googleHeadlessMock.isHeadlessGoogleTool.mockReturnValue(true);
      // Real-world case is isHeadlessGoogleTool=true AND requiresLiveSession=true:
      // this proves the worker's `!isHeadlessGoogleTool(...) && requiresLiveSession(...)`
      // gate genuinely short-circuits on the headless clause rather than the
      // test passing only because requiresLiveSession defaulted to falsy.
      aiToolsMock.requiresLiveSession.mockReturnValue(true);
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
      const intent = baseIntent({ actionName: 'google_suspend_user' });
      primeThroughRevalidation(intent);
      googleHeadlessMock.isHeadlessGoogleTool.mockReturnValue(true);
      googleHeadlessMock.executeGoogleToolHeadless.mockRejectedValueOnce(
        new GoogleConnectionUnavailableError(JSON.stringify({ error: 'no_google_connection' })),
      );
      intentServiceMock.transitionIntent.mockResolvedValueOnce(true); // executing -> failed

      await releaseApprovedIntent(intent.id);

      expect(intentServiceMock.transitionIntent).toHaveBeenLastCalledWith(
        intent.id, 'executing', 'failed', expect.objectContaining({ errorCode: 'connection_unavailable' }),
      );
      expect(aiToolsMock.executeTool).not.toHaveBeenCalled();
    });

    it('still fails session_required for a session-aware M365 tool (deferral intact)', async () => {
      const intent = baseIntent({ actionName: 'm365_disable_user' });
      primeThroughRevalidation(intent);
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
});

describe('processIntentReleaseJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDbState();
  });

  it('ignores non intent_approved events without touching the intent', async () => {
    const result = await processIntentReleaseJob({ intentId: 'intent-1', eventType: 'intent_created' });

    expect(result).toEqual({ released: false });
    expect(intentServiceMock.transitionIntent).not.toHaveBeenCalled();
  });

  it('dispatches intent_approved to releaseApprovedIntent', async () => {
    intentServiceMock.transitionIntent.mockResolvedValueOnce(false); // exits immediately via double-delivery guard

    const result = await processIntentReleaseJob({ intentId: 'intent-1', eventType: 'intent_approved' });

    expect(result).toEqual({ released: true });
    expect(intentServiceMock.transitionIntent).toHaveBeenCalledWith(
      'intent-1', 'approved', 'executing',
      expect.objectContaining({ executedAt: null, executionStartedAt: expect.any(Date) }),
      { requireNotExpired: true },
    );
  });
});
