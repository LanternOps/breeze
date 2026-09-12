import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * AI script authoring W04 (#5612) — `createActionIntent`'s creation-transaction
 * SCRIPT-LANE WIRING: given a decision from `evaluateScriptReviewerAutonomy`
 * (mocked wholesale here — its fourteen-invariant truth table is unit-tested
 * in scriptReviewerAutonomy.test.ts), does creation correctly stamp
 * `status: 'approved'` / `decidedVia: 'script_reviewer'` / evidence, skip the
 * human fan-out, publish `intent_approved`, and abort on a lost proposal CAS.
 *
 * Harness copied from intentService.ticketAutonomy.test.ts, which documents
 * the mock scaffolding:
 *
 * P2-4 Task A3 (#4191) — `createActionIntent`'s creation-transaction
 * ticket-autonomy WIRING: given a decision from `evaluateTicketAutonomy`
 * (mocked wholesale here — its own five-gate truth table is unit-tested in
 * isolation, `ticketAutonomy.test.ts`), does creation correctly:
 *   - bake `status: 'approved'` / `decidedVia: 'ticket_autonomy'` /
 *     `decidedAt` / `decidedByUserId: null` / `releaseBy` into the INSERT;
 *   - skip the human fan-out (no approval_requests rows);
 *   - write BOTH the `intent_created` AND `intent_approved` outbox rows;
 *   - on denial, silently degrade to the ordinary human_required path with
 *     an `autonomyDenied` breadcrumb on `result`, fan-out intact.
 *
 * Mock scaffolding is the `intentService.scope.test.ts` shape (device
 * scope), widened with a `tickets` table stub for the scoped-ticket
 * existence check and a wholesale `./ticketAutonomy` mock.
 */

const { schema, dbState, authMock, guardrailMock, aiToolsState, permState, pushState, notifyState, metricsMock, intentApproversState, effectDigestState, envMock, policyDecideMock, ticketAutonomyState, scriptLaneState } = vi.hoisted(() => {
  const col = (name: string) => ({ name });
  const actionIntentsTbl = {
    id: col('id'),
    orgId: col('org_id'),
    idempotencyKey: col('idempotency_key'),
    status: col('status'),
    expiresAt: col('expires_at'),
    releaseBy: col('release_by'),
    approvalExpiresAt: col('approval_expires_at'),
  };
  const approvalRequestsTbl = { id: col('id'), intentId: col('intent_id'), userId: col('user_id') };
  const intentOutboxTbl = { id: col('id'), intentId: col('intent_id') };
  const aiAgentRunsTbl = {
    id: col('id'),
    agentId: col('agent_id'),
    orgId: col('org_id'),
    deviceId: col('device_id'),
    policySnapshot: col('policy_snapshot'),
  };
  const aiAgentsTbl = { id: col('id'), name: col('name') };
  const devicesTbl = { id: col('id'), orgId: col('org_id'), siteId: col('site_id') };
  const ticketsTbl = { id: col('id'), orgId: col('org_id') };

  return {
    schema: { actionIntentsTbl, approvalRequestsTbl, intentOutboxTbl, aiAgentRunsTbl, aiAgentsTbl, devicesTbl, ticketsTbl },
    dbState: {
      insertActionIntentsResults: [] as Array<unknown[] | ((values: Record<string, unknown>) => unknown[])>,
      insertApprovalRequestsResults: [] as unknown[][],
      selectActionIntentsResults: [] as unknown[][],
      selectApprovalRequestsResults: [] as unknown[][],
      insertedActionIntentValues: [] as Record<string, unknown>[],
      insertedApprovalRequestsValues: [] as unknown[],
      insertedOutboxValues: [] as Record<string, unknown>[],
      selectAgentRunsResults: [] as unknown[][],
      selectAgentsResults: [] as unknown[][],
      selectDevicesResults: [] as unknown[][],
      selectTicketsResults: [] as unknown[][],
    },
    authMock: { dbAccessContextFromAuth: vi.fn((auth: { scope: string; orgId: string | null; accessibleOrgIds: string[] | null; user: { id: string } }) => ({
      scope: auth.scope,
      orgId: auth.orgId,
      accessibleOrgIds: auth.accessibleOrgIds,
      userId: auth.user.id,
    })) },
    guardrailMock: { checkGuardrails: vi.fn(), checkAgentGuardrails: vi.fn() },
    aiToolsState: {
      tools: new Map<string, { definition: { description?: string } }>(),
      resolveWritableToolOrgId: vi.fn(),
    },
    permState: {
      getUserPermissions: vi.fn(),
      userCanDecideApprovals: vi.fn((perms: { canDecide?: boolean } | null) => !!perms?.canDecide),
    },
    pushState: {
      getUserPushTokens: vi.fn(async () => []),
      dispatchApprovalPushToTokens: vi.fn(async () => ({ tokensFound: 0, dispatched: 0, errors: 0 })),
    },
    notifyState: { createNotification: vi.fn(async () => 'notif-1') },
    metricsMock: { recordActionIntentEvent: vi.fn() },
    intentApproversState: {
      resolveIntentApprovers: vi.fn(async () => [] as string[]),
      resolveAgentIntentApprovers: vi.fn(async () => [] as string[]),
      resolveIntentTargetScope: vi.fn(async () => ({ kind: 'indirect' }) as unknown),
    },
    effectDigestState: {
      computeEffectDigestOutcome: vi.fn(async () => ({ kind: 'not_applicable' }) as { kind: string }),
    },
    envMock: { policyDecideEnabled: vi.fn(() => false) },
    policyDecideMock: { attemptPolicyDecision: vi.fn(async () => {}) },
    ticketAutonomyState: {
      evaluateTicketAutonomy: vi.fn(async () => ({ granted: false, reason: 'not_requested' }) as
        { granted: true } | { granted: false; reason: string }),
    },
    scriptLaneState: {
      evaluateScriptReviewerAutonomy: vi.fn(async () => ({ granted: false, reason: 'lane_disabled' }) as
        { granted: true; evidence: Record<string, unknown> } | { granted: false; reason: string }),
      consumeProposalForIntent: vi.fn(async () => true),
      loadProposalForRelease: vi.fn(async () => ({ id: 'prop-1', orgId: '11111111-1111-4111-8111-111111111111' })),
      latestCompletedReview: vi.fn(async () => ({ id: 'rev-1' })),
      loadProposalGuardrailContext: vi.fn(async () => ({ proposal: { riskTier: 'low', strictHits: [] } })),
    },
  };
});

function resultBox(getResult: () => unknown) {
  return {
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(getResult()).then(res, rej),
    catch: (rej: (e: unknown) => unknown) => Promise.resolve(getResult()).catch(rej),
    limit: vi.fn(() => resultBox(getResult)),
  };
}

vi.mock('../../db', () => ({
  db: {
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => {
        if (table === schema.actionIntentsTbl) {
          const insertedValues = values as Record<string, unknown>;
          dbState.insertedActionIntentValues.push(insertedValues);
          return {
            onConflictDoNothing: vi.fn(() => ({
              returning: vi.fn(async () => {
                const queued = dbState.insertActionIntentsResults.shift();
                if (typeof queued === 'function') return queued(insertedValues);
                return queued ?? [];
              }),
            })),
          };
        }
        if (table === schema.approvalRequestsTbl) {
          dbState.insertedApprovalRequestsValues.push(values);
          return { returning: vi.fn(async () => dbState.insertApprovalRequestsResults.shift() ?? []) };
        }
        if (table === schema.intentOutboxTbl) {
          dbState.insertedOutboxValues.push(values as Record<string, unknown>);
          return Promise.resolve(undefined);
        }
        throw new Error('unexpected insert table in mock');
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => {
          if (table === schema.actionIntentsTbl) return resultBox(() => dbState.selectActionIntentsResults.shift() ?? []);
          if (table === schema.approvalRequestsTbl) return resultBox(() => dbState.selectApprovalRequestsResults.shift() ?? []);
          if (table === schema.aiAgentRunsTbl) return resultBox(() => dbState.selectAgentRunsResults.shift() ?? []);
          if (table === schema.aiAgentsTbl) return resultBox(() => dbState.selectAgentsResults.shift() ?? []);
          if (table === schema.devicesTbl) return resultBox(() => dbState.selectDevicesResults.shift() ?? []);
          if (table === schema.ticketsTbl) return resultBox(() => dbState.selectTicketsResults.shift() ?? []);
          throw new Error('unexpected select table in mock');
        }),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => []) })) })),
    })),
  },
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn(<T,>(fn: () => T): T => fn()),
}));

vi.mock('../../db/schema/actionIntents', () => ({
  actionIntents: schema.actionIntentsTbl,
  intentOutbox: schema.intentOutboxTbl,
}));
vi.mock('../../db/schema/approvals', () => ({ approvalRequests: schema.approvalRequestsTbl }));
vi.mock('./intentApprovers', () => ({
  resolveIntentApprovers: intentApproversState.resolveIntentApprovers,
  resolveAgentIntentApprovers: intentApproversState.resolveAgentIntentApprovers,
  resolveIntentTargetScope: intentApproversState.resolveIntentTargetScope,
}));
vi.mock('../../middleware/auth', () => ({ dbAccessContextFromAuth: authMock.dbAccessContextFromAuth }));
vi.mock('../aiTools', () => ({
  aiTools: aiToolsState.tools,
  resolveWritableToolOrgId: aiToolsState.resolveWritableToolOrgId,
}));
vi.mock('../aiGuardrails', () => ({
  checkGuardrails: guardrailMock.checkGuardrails,
  checkAgentGuardrails: guardrailMock.checkAgentGuardrails,
}));
vi.mock('../../db/schema/aiAgents', () => ({
  aiAgents: schema.aiAgentsTbl,
  aiAgentRuns: schema.aiAgentRunsTbl,
}));
vi.mock('../../db/schema/devices', () => ({ devices: schema.devicesTbl }));
vi.mock('../../db/schema/portal', () => ({ tickets: schema.ticketsTbl }));
vi.mock('../permissions', () => ({
  getUserPermissions: permState.getUserPermissions,
  userCanDecideApprovals: permState.userCanDecideApprovals,
}));
vi.mock('../expoPush', () => ({
  getUserPushTokens: pushState.getUserPushTokens,
  dispatchApprovalPushToTokens: pushState.dispatchApprovalPushToTokens,
}));
vi.mock('../userNotifications', () => ({ createNotification: notifyState.createNotification }));
vi.mock('./metrics', () => ({ recordActionIntentEvent: metricsMock.recordActionIntentEvent }));
vi.mock('./effectDigest', () => ({ computeEffectDigestOutcome: effectDigestState.computeEffectDigestOutcome }));
vi.mock('../../config/env', () => ({ policyDecideEnabled: envMock.policyDecideEnabled }));
vi.mock('./policyDecide', () => ({ attemptPolicyDecision: policyDecideMock.attemptPolicyDecision }));
vi.mock('./ticketAutonomy', () => ({ evaluateTicketAutonomy: ticketAutonomyState.evaluateTicketAutonomy }));
vi.mock('./scriptReviewerAutonomy', () => ({
  evaluateScriptReviewerAutonomy: scriptLaneState.evaluateScriptReviewerAutonomy,
}));
vi.mock('../scriptProposals', () => ({
  consumeProposalForIntent: scriptLaneState.consumeProposalForIntent,
  loadProposalForRelease: scriptLaneState.loadProposalForRelease,
  latestCompletedReview: scriptLaneState.latestCompletedReview,
  loadProposalGuardrailContext: scriptLaneState.loadProposalGuardrailContext,
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ op: 'eq', args })),
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  inArray: vi.fn((...args: unknown[]) => ({ op: 'inArray', args })),
  sql: vi.fn(() => ({ op: 'sql' })),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { createActionIntent, type CreateActionIntentInput } from './intentService';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const REQUESTER_ID = '22222222-2222-4222-8222-222222222222';
const PARTNER_ID = '55555555-5555-4555-8555-555555555555';
const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const EVIDENCE = { proposalId: 'prop-1', reviewId: 'rev-1', checkpointRequired: false };

function makeUserAuth() {
  return {
    principal: { kind: 'user' },
    user: { id: REQUESTER_ID, email: 'tech@example.com', name: 'Tech' },
    orgId: ORG_ID,
    partnerId: PARTNER_ID,
    scope: 'organization' as const,
    accessibleOrgIds: [ORG_ID],
  } as unknown as Parameters<typeof createActionIntent>[0];
}

function echoInsertedIntent(overrides?: Record<string, unknown>) {
  return (values: Record<string, unknown>) => [
    {
      id: 'intent-echo',
      partnerId: PARTNER_ID,
      requestedByUserId: REQUESTER_ID,
      status: 'pending_approval',
      createdAt: new Date(),
      result: null,
      errorCode: null,
      ...values,
      ...overrides,
    },
  ];
}

function proposalRunInput(overrides?: Partial<CreateActionIntentInput>): CreateActionIntentInput {
  return {
    toolName: 'run_script',
    input: { proposalId: 'prop-1', deviceIds: [DEVICE_ID] },
    source: 'chat',
    orgId: ORG_ID,
    guardrailContext: { proposal: { riskTier: 'low', strictHits: [] } },
    ...overrides,
  };
}

function resetDbState() {
  for (const key of Object.keys(dbState) as Array<keyof typeof dbState>) {
    (dbState[key] as unknown[]).length = 0;
  }
}

beforeEach(() => {
  resetDbState();
  vi.clearAllMocks();
  aiToolsState.tools.clear();
  aiToolsState.resolveWritableToolOrgId.mockReturnValue({ orgId: ORG_ID });
  guardrailMock.checkGuardrails.mockReturnValue({
    tier: 3, allowed: true, requiresApproval: true, approvalScope: 'supervised', description: 'Run a script',
  });
  intentApproversState.resolveIntentApprovers.mockResolvedValue([REQUESTER_ID]);
  intentApproversState.resolveIntentTargetScope.mockResolvedValue({ kind: 'indirect' });
  permState.getUserPermissions.mockResolvedValue({ canDecide: true });
  effectDigestState.computeEffectDigestOutcome.mockResolvedValue({ kind: 'not_applicable' });
  envMock.policyDecideEnabled.mockReturnValue(false);
  ticketAutonomyState.evaluateTicketAutonomy.mockResolvedValue({ granted: false, reason: 'not_requested' });
  scriptLaneState.evaluateScriptReviewerAutonomy.mockResolvedValue({ granted: true, evidence: EVIDENCE });
  scriptLaneState.consumeProposalForIntent.mockResolvedValue(true);
  scriptLaneState.loadProposalForRelease.mockResolvedValue({ id: 'prop-1', orgId: ORG_ID });
  scriptLaneState.latestCompletedReview.mockResolvedValue({ id: 'rev-1' });
  dbState.insertApprovalRequestsResults.push([{ id: 'approval-1' }]);
});

describe('createActionIntent — script_reviewer autonomy (#5612 W04)', () => {
  it('is not consulted for run_script WITHOUT a proposalId', async () => {
    dbState.insertActionIntentsResults.push(echoInsertedIntent());
    await createActionIntent(makeUserAuth(), proposalRunInput({ input: { scriptId: 's-1', deviceIds: [DEVICE_ID] }, guardrailContext: undefined }));
    expect(scriptLaneState.evaluateScriptReviewerAutonomy).not.toHaveBeenCalled();
    expect(scriptLaneState.loadProposalForRelease).not.toHaveBeenCalled();
  });

  it('is not consulted for another tool that happens to carry a proposalId', async () => {
    dbState.insertActionIntentsResults.push(echoInsertedIntent());
    await createActionIntent(makeUserAuth(), proposalRunInput({ toolName: 'restart_service', input: { proposalId: 'prop-1', deviceId: DEVICE_ID }, guardrailContext: undefined }));
    expect(scriptLaneState.evaluateScriptReviewerAutonomy).not.toHaveBeenCalled();
  });

  it('a grant inserts an APPROVED intent with the lane decision stamped, and hands the evaluator the proposal + latest review', async () => {
    dbState.insertActionIntentsResults.push(echoInsertedIntent());
    await createActionIntent(makeUserAuth(), proposalRunInput());
    const inserted = dbState.insertedActionIntentValues[0]!;
    expect(inserted).toMatchObject({
      status: 'approved',
      decidedVia: 'script_reviewer',
      decidedByUserId: null,
      scriptReviewerEvidence: EVIDENCE,
      result: null,
    });
    expect(inserted.releaseBy).toBeInstanceOf(Date);
    expect(inserted.decidedAt).toBeInstanceOf(Date);
    expect(scriptLaneState.loadProposalForRelease).toHaveBeenCalledWith(expect.anything(), 'prop-1', ORG_ID);
    expect(scriptLaneState.evaluateScriptReviewerAutonomy).toHaveBeenCalledWith(expect.objectContaining({
      intentDraft: expect.objectContaining({ orgId: ORG_ID, approvalScope: 'supervised', agentRun: null }),
      proposal: { id: 'prop-1', orgId: ORG_ID },
      review: { id: 'rev-1' },
    }));
  });

  it('a grant writes NO approval_requests rows and an intent_approved outbox row', async () => {
    dbState.insertActionIntentsResults.push(echoInsertedIntent());
    const snap = await createActionIntent(makeUserAuth(), proposalRunInput());
    expect(dbState.insertedApprovalRequestsValues).toHaveLength(0);
    expect(snap.approvalRequestIds).toEqual([]);
    expect(dbState.insertedOutboxValues.map((o) => o.eventType)).toEqual(['intent_created', 'intent_approved']);
  });

  it('a grant CONSUMES the proposal for exactly this intent', async () => {
    dbState.insertActionIntentsResults.push(echoInsertedIntent());
    const snap = await createActionIntent(makeUserAuth(), proposalRunInput());
    expect(scriptLaneState.consumeProposalForIntent).toHaveBeenCalledWith(expect.anything(), 'prop-1', snap.id);
  });

  it('a LOST consumption race ABORTS the whole transaction — no half-consumed approved intent', async () => {
    dbState.insertActionIntentsResults.push(echoInsertedIntent());
    scriptLaneState.consumeProposalForIntent.mockResolvedValue(false);
    await expect(createActionIntent(makeUserAuth(), proposalRunInput())).rejects.toMatchObject({ code: 'proposal_not_runnable' });
    expect(dbState.insertedOutboxValues).toHaveLength(0);
  });

  it('a refusal falls through to the human path unchanged, with the reason as a breadcrumb', async () => {
    dbState.insertActionIntentsResults.push(echoInsertedIntent());
    scriptLaneState.evaluateScriptReviewerAutonomy.mockResolvedValue({ granted: false, reason: 'hourly_cap' });
    const snap = await createActionIntent(makeUserAuth(), proposalRunInput());
    const inserted = dbState.insertedActionIntentValues[0]!;
    expect(inserted.status).toBeUndefined();
    expect(inserted.decidedVia).toBeUndefined();
    expect(inserted.scriptReviewerEvidence).toBeUndefined();
    expect(inserted.result).toEqual({ scriptLaneRefusal: 'hourly_cap' });
    expect(dbState.insertedApprovalRequestsValues.length).toBeGreaterThan(0);
    expect(snap.approvalRequestIds.length).toBeGreaterThan(0);
    expect(dbState.insertedOutboxValues.map((o) => o.eventType)).toEqual(['intent_created']);
    // The proposal is still claimed by the (pending) intent — W01b's CAS.
    expect(scriptLaneState.consumeProposalForIntent).toHaveBeenCalledWith(expect.anything(), 'prop-1', snap.id);
  });

  it('a missing proposal is a proposal_not_runnable breadcrumb and the evaluator is never called', async () => {
    dbState.insertActionIntentsResults.push(echoInsertedIntent());
    scriptLaneState.loadProposalForRelease.mockResolvedValue(null);
    // W01b's CAS then refuses the claim — the intent never commits.
    scriptLaneState.consumeProposalForIntent.mockResolvedValue(false);
    await expect(createActionIntent(makeUserAuth(), proposalRunInput())).rejects.toMatchObject({ code: 'proposal_not_runnable' });
    expect(scriptLaneState.evaluateScriptReviewerAutonomy).not.toHaveBeenCalled();
  });
});
