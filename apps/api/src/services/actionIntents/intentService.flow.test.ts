import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Tool catalog W04 (#5219), plan Task A5 — flow-origin action intents.
 *
 * A Tier-3 flow step that is not pre-approved becomes an intent with
 * `source: 'flow'`, `origin_principal_kind: 'flow'`, `requesting_flow_run_id`
 * and no human requester. Fan-out is the agent-origin branch (supervised ⇒
 * action-and-target pool, four_eyes ⇒ approvals:decide pool) with NEW
 * four-eyes exclusions: the publication's delegator and a manual run's
 * triggerer, both read from the server (`loadFlowIntentRun`), never trusted
 * from the caller.
 *
 * Mock scaffolding copied from intentService.tier2Agent.test.ts; departures:
 * `checkGuardrails` is a controlled double (the approval scope is the input
 * under test), and `../flows/intentRun` / `../flows/wake` are mocked at the
 * module boundary.
 */

const { schema, dbState, authMock, guardrailState, aiToolsState, permState, pushState, notifyState, metricsMock, intentApproversState, effectDigestState, envMock, policyDecideMock, flowState } = vi.hoisted(() => {
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
  const aiAgentRunsTbl = { id: col('id') };
  const aiAgentsTbl = { id: col('id'), name: col('name') };
  const devicesTbl = { id: col('id'), siteId: col('site_id') };

  return {
    schema: { actionIntentsTbl, approvalRequestsTbl, intentOutboxTbl, aiAgentRunsTbl, aiAgentsTbl, devicesTbl },
    dbState: {
      insertActionIntentsResults: [] as Array<unknown[] | ((values: Record<string, unknown>) => unknown[])>,
      insertApprovalRequestsResults: [] as unknown[][],
      selectActionIntentsResults: [] as unknown[][],
      selectApprovalRequestsResults: [] as unknown[][],
      updateActionIntentsResults: [] as unknown[][],
      insertedActionIntentValues: [] as Record<string, unknown>[],
      insertedApprovalRequestsValues: [] as unknown[],
      insertedOutboxValues: [] as Record<string, unknown>[],
      updateActionIntentsSets: [] as Record<string, unknown>[],
    },
    authMock: { dbAccessContextFromAuth: vi.fn(() => ({ scope: 'organization' })) },
    guardrailState: { checkGuardrails: vi.fn(), checkAgentGuardrails: vi.fn() },
    aiToolsState: {
      tools: new Map<string, { definition: { description?: string } }>(),
      resolveWritableToolOrgId: vi.fn(),
      getToolTier: vi.fn(() => 3),
    },
    permState: { getUserPermissions: vi.fn(), userCanDecideApprovals: vi.fn(() => false) },
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
    effectDigestState: { computeEffectDigestOutcome: vi.fn(async () => ({ kind: 'not_applicable' }) as { kind: string }) },
    envMock: { policyDecideEnabled: vi.fn(() => false), sweepActEnabled: vi.fn(() => false), flowApprovalTtlHours: vi.fn(() => 24) },
    policyDecideMock: { attemptPolicyDecision: vi.fn(async () => {}) },
    flowState: { loadFlowIntentRun: vi.fn(), scheduleFlowRunWake: vi.fn() },
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
          throw new Error('unexpected select table in mock');
        }),
      })),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((setVals: Record<string, unknown>) => {
        if (table !== schema.actionIntentsTbl) throw new Error('unexpected update table in mock');
        dbState.updateActionIntentsSets.push(setVals);
        return { where: vi.fn(() => ({ returning: vi.fn(async () => dbState.updateActionIntentsResults.shift() ?? []) })) };
      }),
    })),
  },
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn(<T,>(fn: () => T): T => fn()),
}));

vi.mock('../../db/schema/actionIntents', () => ({ actionIntents: schema.actionIntentsTbl, intentOutbox: schema.intentOutboxTbl }));
vi.mock('../auditService', () => ({ createAuditLogAsync: vi.fn(async () => {}) }));
vi.mock('./scriptReviewerAutonomy', () => ({
  evaluateScriptReviewerAutonomy: vi.fn(async () => ({ granted: false, reason: 'lane_disabled' })),
  revalidateScriptReviewerEvidence: vi.fn(async () => ({ ok: false, reason: 'lane_disabled' })),
}));
vi.mock('../../db/schema/approvals', () => ({ approvalRequests: schema.approvalRequestsTbl }));
vi.mock('./intentApprovers', () => ({
  resolveIntentApprovers: intentApproversState.resolveIntentApprovers,
  resolveAgentIntentApprovers: intentApproversState.resolveAgentIntentApprovers,
  resolveIntentTargetScope: intentApproversState.resolveIntentTargetScope,
  isOrgWideGovernanceIntent: () => false,
}));
vi.mock('../../middleware/auth', () => ({ dbAccessContextFromAuth: authMock.dbAccessContextFromAuth }));
vi.mock('../aiTools', () => ({
  aiTools: aiToolsState.tools,
  resolveWritableToolOrgId: aiToolsState.resolveWritableToolOrgId,
  getToolTier: aiToolsState.getToolTier,
}));
vi.mock('../aiGuardrails', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../aiGuardrails')>();
  return { ...actual, checkGuardrails: guardrailState.checkGuardrails, checkAgentGuardrails: guardrailState.checkAgentGuardrails };
});
vi.mock('../../db/schema/aiAgents', () => ({ aiAgents: schema.aiAgentsTbl, aiAgentRuns: schema.aiAgentRunsTbl }));
vi.mock('../../db/schema/devices', () => ({ devices: schema.devicesTbl }));
vi.mock('../permissions', () => ({ getUserPermissions: permState.getUserPermissions, userCanDecideApprovals: permState.userCanDecideApprovals }));
vi.mock('../expoPush', () => ({ getUserPushTokens: pushState.getUserPushTokens, dispatchApprovalPushToTokens: pushState.dispatchApprovalPushToTokens }));
vi.mock('../userNotifications', () => ({ createNotification: notifyState.createNotification }));
vi.mock('./metrics', () => ({ recordActionIntentEvent: metricsMock.recordActionIntentEvent }));
vi.mock('./effectDigest', () => ({ computeEffectDigestOutcome: effectDigestState.computeEffectDigestOutcome }));
vi.mock('../../config/env', () => ({
  policyDecideEnabled: envMock.policyDecideEnabled,
  sweepActEnabled: envMock.sweepActEnabled,
  flowApprovalTtlHours: envMock.flowApprovalTtlHours,
}));
vi.mock('./policyDecide', () => ({ attemptPolicyDecision: policyDecideMock.attemptPolicyDecision }));
vi.mock('../flows/intentRun', () => ({ loadFlowIntentRun: flowState.loadFlowIntentRun }));
vi.mock('../flows/wake', () => ({ scheduleFlowRunWake: flowState.scheduleFlowRunWake }));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ op: 'eq', args })),
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  inArray: vi.fn((...args: unknown[]) => ({ op: 'inArray', args })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ op: 'sql', text: strings.join('?'), values })),
}));

import { createActionIntent, type CreateActionIntentInput } from './intentService';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const APPROVER_1 = '33333333-3333-4333-8333-333333333333';
const DELEGATOR = '44444444-4444-4444-8444-444444444444';
const TRIGGERER = '45454545-4545-4545-8545-454545454545';
const PARTNER_ID = '55555555-5555-4555-8555-555555555555';
const FLOW_ID = '66666666-6666-4666-8666-666666666666';
const RUN_ID = '77777777-7777-4777-8777-777777777777';
const STEP_ROW_ID = '88888888-8888-4888-8888-888888888888';
const DEVICE_ID = '99999999-9999-4999-8999-999999999999';
const SCRIPT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function flowAuth(runId: string = RUN_ID) {
  return {
    principal: { kind: 'flow', flowId: FLOW_ID, runId },
    aiOrigin: { kind: 'flow', flowRunId: runId },
    user: { id: FLOW_ID, email: `flow+${FLOW_ID}@breeze.internal`, name: 'Disk cleanup' },
    token: null,
    orgId: ORG_ID,
    partnerId: PARTNER_ID,
    scope: 'organization' as const,
    accessibleOrgIds: [ORG_ID],
  } as unknown as Parameters<typeof createActionIntent>[0];
}

function userAuth() {
  return {
    principal: { kind: 'user_session' },
    user: { id: APPROVER_1, email: 'u@example.com', name: 'U' },
    orgId: ORG_ID,
    partnerId: PARTNER_ID,
    scope: 'organization' as const,
    accessibleOrgIds: [ORG_ID],
  } as unknown as Parameters<typeof createActionIntent>[0];
}

function flowRunInput(over: Partial<NonNullable<CreateActionIntentInput['flowRun']>> = {}): NonNullable<CreateActionIntentInput['flowRun']> {
  return {
    runId: RUN_ID,
    stepRowId: STEP_ROW_ID,
    delegatorUserId: DELEGATOR,
    triggeredByUserId: null,
    flowName: 'Disk cleanup',
    stepId: 'cleanup',
    ...over,
  };
}

function flowInput(over: Partial<CreateActionIntentInput> = {}): CreateActionIntentInput {
  return {
    toolName: 'run_script',
    input: { scriptId: SCRIPT_ID, deviceIds: [DEVICE_ID] },
    source: 'flow',
    orgId: ORG_ID,
    flowRun: flowRunInput(),
    ...over,
  };
}

function serverRun(over: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID,
    orgId: ORG_ID,
    flowId: FLOW_ID,
    flowName: 'Disk cleanup',
    status: 'running',
    delegatorUserId: DELEGATOR,
    triggeredByUserId: null,
    step: { id: STEP_ROW_ID, stepId: 'cleanup', status: 'running' },
    ...over,
  };
}

function echoInsertedIntent() {
  return (values: Record<string, unknown>) => [{
    status: 'pending_approval', errorCode: null, result: null, decidedVia: null, ...values, id: 'intent-flow-1',
  }];
}

function scope(approvalScope: 'supervised' | 'four_eyes') {
  guardrailState.checkGuardrails.mockReturnValue({
    tier: 3, allowed: true, requiresApproval: true, readOnly: false, approvalScope, description: 'Run a script',
  });
}

beforeEach(() => {
  for (const list of Object.values(dbState)) (list as unknown[]).length = 0;
  vi.clearAllMocks();
  aiToolsState.resolveWritableToolOrgId.mockReturnValue({ orgId: ORG_ID });
  scope('supervised');
  intentApproversState.resolveIntentApprovers.mockResolvedValue([]);
  intentApproversState.resolveAgentIntentApprovers.mockResolvedValue([]);
  intentApproversState.resolveIntentTargetScope.mockResolvedValue({ kind: 'devices', siteIds: ['site-1'] });
  effectDigestState.computeEffectDigestOutcome.mockResolvedValue({ kind: 'not_applicable' });
  envMock.flowApprovalTtlHours.mockReturnValue(24);
  flowState.loadFlowIntentRun.mockResolvedValue(serverRun());
  pushState.getUserPushTokens.mockResolvedValue([]);
  notifyState.createNotification.mockResolvedValue('notif-1');
});

describe('createActionIntent — source flow (#5219)', () => {
  it("source 'flow' without flowRun ⇒ flow_source_mismatch", async () => {
    await expect(createActionIntent(flowAuth(), flowInput({ flowRun: undefined }))).rejects.toMatchObject({ code: 'flow_source_mismatch' });
    expect(dbState.insertedActionIntentValues).toHaveLength(0);
  });

  it('a flow principal may only write source flow, and source flow needs a flow principal', async () => {
    await expect(createActionIntent(flowAuth(), flowInput({ source: 'chat' }))).rejects.toMatchObject({ code: 'flow_source_mismatch' });
    await expect(createActionIntent(userAuth(), flowInput())).rejects.toMatchObject({ code: 'flow_source_mismatch' });
    expect(dbState.insertedActionIntentValues).toHaveLength(0);
  });

  it("refuses a flowRun whose runId is not the principal's run", async () => {
    await expect(createActionIntent(flowAuth('77777777-7777-4777-8777-000000000000'), flowInput()))
      .rejects.toMatchObject({ code: 'flow_source_mismatch' });
  });

  it('flowRun on a non-flow source is refused (no silent drop)', async () => {
    await expect(createActionIntent(userAuth(), flowInput({ source: 'chat' }))).rejects.toMatchObject({ code: 'flow_source_mismatch' });
  });

  it("flow intent writes requesting_flow_run_id and origin 'flow'", async () => {
    intentApproversState.resolveAgentIntentApprovers.mockResolvedValue([APPROVER_1]);
    dbState.insertActionIntentsResults.push(echoInsertedIntent());
    dbState.insertApprovalRequestsResults.push([{ id: 'ar-1' }]);

    const snapshot = await createActionIntent(flowAuth(), flowInput());

    const row = dbState.insertedActionIntentValues[0]!;
    expect(row.source).toBe('flow');
    expect(row.originPrincipalKind).toBe('flow');
    expect(row.originPrincipalId).toBe(FLOW_ID);
    expect(row.requestingFlowRunId).toBe(RUN_ID);
    expect(row.requestedByUserId).toBeNull();
    expect(row.requestingAgentRunId).toBeNull();
    expect(row.aiOriginKind).toBe('flow');
    expect(row.partnerId).toBe(PARTNER_ID);
    expect(snapshot.status).toBe('pending_approval');
    expect(flowState.loadFlowIntentRun).toHaveBeenCalledWith(RUN_ID, STEP_ROW_ID);
  });

  it('labels equal `Flow Disk cleanup` / `Step cleanup: run_script`', async () => {
    intentApproversState.resolveAgentIntentApprovers.mockResolvedValue([APPROVER_1]);
    dbState.insertActionIntentsResults.push(echoInsertedIntent());
    dbState.insertApprovalRequestsResults.push([{ id: 'ar-1' }]);

    await createActionIntent(flowAuth(), flowInput());

    expect(dbState.insertedActionIntentValues[0]!.requestingClientLabel).toBe('Flow Disk cleanup');
    const rows = dbState.insertedApprovalRequestsValues[0] as Array<{ requestingClientLabel: string; actionLabel: string }>;
    expect(rows[0]!.requestingClientLabel).toBe('Flow Disk cleanup');
    expect(rows[0]!.actionLabel).toBe('Step cleanup: run_script');
  });

  it('flow intent expires after FLOW_APPROVAL_TTL_HOURS (both scopes)', async () => {
    envMock.flowApprovalTtlHours.mockReturnValue(6);
    for (const s of ['supervised', 'four_eyes'] as const) {
      scope(s);
      intentApproversState.resolveAgentIntentApprovers.mockResolvedValue([APPROVER_1]);
      intentApproversState.resolveIntentApprovers.mockResolvedValue([APPROVER_1]);
      dbState.insertActionIntentsResults.push(echoInsertedIntent());
      dbState.insertApprovalRequestsResults.push([{ id: 'ar-1' }]);
      const before = Date.now();
      await createActionIntent(flowAuth(), flowInput());
      const row = dbState.insertedActionIntentValues.at(-1)!;
      const ms = (row.expiresAt as Date).getTime() - before;
      expect(ms).toBeGreaterThanOrEqual(6 * 3600_000 - 1_000);
      expect(ms).toBeLessThanOrEqual(6 * 3600_000 + 1_000);
      expect(row.approvalExpiresAt).toEqual(row.expiresAt);
    }
  });

  it('supervised flow intent fans out to the eligible pool including the delegator', async () => {
    intentApproversState.resolveAgentIntentApprovers.mockResolvedValue([DELEGATOR, APPROVER_1]);
    dbState.insertActionIntentsResults.push(echoInsertedIntent());
    dbState.insertApprovalRequestsResults.push([{ id: 'ar-1' }, { id: 'ar-2' }]);

    const snapshot = await createActionIntent(flowAuth(), flowInput());

    const rows = dbState.insertedApprovalRequestsValues[0] as Array<{ userId: string }>;
    expect(rows.map((r) => r.userId)).toEqual([DELEGATOR, APPROVER_1]);
    expect(snapshot.requesterApprovalRequestId).toBeNull();
    // The action-and-target pool, resolved against the step's own arguments
    // (the run has no device of its own).
    expect(intentApproversState.resolveIntentTargetScope).toHaveBeenCalledWith(
      'run_script', { scriptId: SCRIPT_ID, deviceIds: [DEVICE_ID] }, { deviceId: null }, ORG_ID,
    );
    // Headless: nobody watches a chat pane, so a supervised flow intent notifies.
    expect(notifyState.createNotification).toHaveBeenCalled();
  });

  it('four-eyes flow intent never routes to the delegator (nor the manual-run triggerer)', async () => {
    scope('four_eyes');
    flowState.loadFlowIntentRun.mockResolvedValue(serverRun({ triggeredByUserId: TRIGGERER }));
    intentApproversState.resolveIntentApprovers.mockResolvedValue([DELEGATOR, APPROVER_1, TRIGGERER]);
    dbState.insertActionIntentsResults.push(echoInsertedIntent());
    dbState.insertApprovalRequestsResults.push([{ id: 'ar-1' }]);

    await createActionIntent(flowAuth(), flowInput({ flowRun: flowRunInput({ triggeredByUserId: TRIGGERER }) }));

    const rows = dbState.insertedApprovalRequestsValues[0] as Array<{ userId: string }>;
    expect(rows.map((r) => r.userId)).toEqual([APPROVER_1]);
  });

  it('four-eyes flow intent whose only approver is the delegator is cancelled no_eligible_approvers', async () => {
    scope('four_eyes');
    intentApproversState.resolveIntentApprovers.mockResolvedValue([DELEGATOR]);
    dbState.insertActionIntentsResults.push(echoInsertedIntent());
    dbState.updateActionIntentsResults.push([{ id: 'intent-flow-1', status: 'cancelled', errorCode: 'no_eligible_approvers', source: 'flow', requestingFlowRunId: RUN_ID }]);

    const snapshot = await createActionIntent(flowAuth(), flowInput());

    expect(dbState.insertedApprovalRequestsValues).toHaveLength(0);
    expect(snapshot.status).toBe('cancelled');
    expect(snapshot.errorCode).toBe('no_eligible_approvers');
    expect(dbState.updateActionIntentsSets[0]).toMatchObject({ status: 'cancelled', errorCode: 'no_eligible_approvers' });
    // Terminal at creation: the existing cancel path publishes it, which wakes the run.
    expect(flowState.scheduleFlowRunWake).toHaveBeenCalledWith(RUN_ID);
  });

  it('the exclusions come from the server run, not the caller (a caller that disagrees is refused)', async () => {
    flowState.loadFlowIntentRun.mockResolvedValue(serverRun({ delegatorUserId: '44444444-4444-4444-8444-000000000000' }));
    await expect(createActionIntent(flowAuth(), flowInput())).rejects.toMatchObject({ code: 'flow_run_invalid' });
    expect(dbState.insertedActionIntentValues).toHaveLength(0);
  });

  it.each([
    ['missing run', null],
    ['run in another org', serverRun({ orgId: '11111111-1111-4111-8111-000000000000' })],
    ['run of another flow', serverRun({ flowId: '66666666-6666-4666-8666-000000000000' })],
    ['run not running', serverRun({ status: 'cancelled' })],
    ['step row of another step', serverRun({ step: { id: STEP_ROW_ID, stepId: 'other', status: 'running' } })],
    ['no step row', serverRun({ step: null })],
  ])('refuses %s with flow_run_invalid', async (_label, run) => {
    flowState.loadFlowIntentRun.mockResolvedValue(run);
    await expect(createActionIntent(flowAuth(), flowInput())).rejects.toMatchObject({ code: 'flow_run_invalid' });
    expect(dbState.insertedActionIntentValues).toHaveLength(0);
  });

  it('a flow principal is still held to the Tier-3-only contract', async () => {
    guardrailState.checkGuardrails.mockReturnValue({ tier: 2, allowed: true, requiresApproval: false, readOnly: false });
    await expect(createActionIntent(flowAuth(), flowInput())).rejects.toMatchObject({ code: 'tool_not_tier3' });
  });

  it('two attempts of the same step mint distinct idempotency keys (keyed on the step row)', async () => {
    intentApproversState.resolveAgentIntentApprovers.mockResolvedValue([APPROVER_1]);
    dbState.insertActionIntentsResults.push(echoInsertedIntent(), echoInsertedIntent());
    dbState.insertApprovalRequestsResults.push([{ id: 'ar-1' }], [{ id: 'ar-2' }]);
    await createActionIntent(flowAuth(), flowInput());
    const OTHER_STEP_ROW = '88888888-8888-4888-8888-000000000000';
    flowState.loadFlowIntentRun.mockResolvedValue(serverRun({ step: { id: OTHER_STEP_ROW, stepId: 'cleanup', status: 'running' } }));
    await createActionIntent(flowAuth(), flowInput({ flowRun: flowRunInput({ stepRowId: OTHER_STEP_ROW }) }));
    const [a, b] = dbState.insertedActionIntentValues;
    expect(a!.idempotencyKey).not.toBe(b!.idempotencyKey);
  });
});

// W5 PR B (#5220, Decision 12): a Tier-3 built-in flow step (an http_request
// write) parks on a `source: 'flow'` intent carrying the built-in's name.
describe('createActionIntent — built-in flow steps (#5220)', () => {
  const POST_INPUT = { method: 'POST', url: 'https://api.example.com/tickets', body: { title: 'x' } };
  const builtinRun = (over: Record<string, unknown> = {}) => serverRun({
    step: { id: STEP_ROW_ID, stepId: 'cleanup', status: 'running', tool: 'http_request', toolSource: 'builtin', tier: 3 },
    ...over,
  });
  const builtinInput = (over: Partial<CreateActionIntentInput> = {}) => flowInput({
    toolName: 'http_request', input: POST_INPUT, flowRun: flowRunInput({ builtin: true }), ...over,
  });

  beforeEach(() => {
    flowState.loadFlowIntentRun.mockResolvedValue(builtinRun());
    intentApproversState.resolveAgentIntentApprovers.mockResolvedValue([APPROVER_1]);
  });

  it('builtin name accepted only for source flow with builtin true', async () => {
    // A flow intent naming a built-in without the flag.
    await expect(createActionIntent(flowAuth(), builtinInput({ flowRun: flowRunInput() }))).rejects.toMatchObject({ code: 'builtin_intent_invalid' });
    // The flag on a core tool.
    await expect(createActionIntent(flowAuth(), flowInput({ flowRun: flowRunInput({ builtin: true }) }))).rejects.toMatchObject({ code: 'builtin_intent_invalid' });
    // A human caller naming a built-in (no flow principal, no flowRun).
    await expect(createActionIntent(userAuth(), { toolName: 'http_request', input: POST_INPUT, source: 'chat', orgId: ORG_ID }))
      .rejects.toMatchObject({ code: 'builtin_intent_invalid' });
    expect(dbState.insertedActionIntentValues).toHaveLength(0);
  });

  it('builtin flow intent skips the core classifier, is supervised Tier 3 and never policy-decidable', async () => {
    dbState.insertActionIntentsResults.push(echoInsertedIntent());
    dbState.insertApprovalRequestsResults.push([{ id: 'ar-1' }]);
    await createActionIntent(flowAuth(), builtinInput());
    expect(guardrailState.checkGuardrails).not.toHaveBeenCalled();
    const row = dbState.insertedActionIntentValues[0]!;
    expect(row).toMatchObject({ actionName: 'http_request', approvalScope: 'supervised', riskTier: 3, policyDecisionState: 'human_required', source: 'flow' });
    expect(policyDecideMock.attemptPolicyDecision).not.toHaveBeenCalled();
  });

  it('builtin flow intent fans out to holders of its built-in permission over an indirect target', async () => {
    dbState.insertActionIntentsResults.push(echoInsertedIntent());
    dbState.insertApprovalRequestsResults.push([{ id: 'ar-1' }]);
    await createActionIntent(flowAuth(), builtinInput());
    expect(intentApproversState.resolveIntentTargetScope).not.toHaveBeenCalled();
    expect(intentApproversState.resolveAgentIntentApprovers).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'http_request', targetScope: { kind: 'indirect' }, requiredOverride: [{ resource: 'external_tools', action: 'write' }],
    }));
  });

  it('a built-in whose input is Tier 2 (a GET) is refused tool_not_tier3', async () => {
    await expect(createActionIntent(flowAuth(), builtinInput({ input: { method: 'GET', url: 'https://api.example.com/x' } })))
      .rejects.toMatchObject({ code: 'tool_not_tier3' });
  });

  // W6 (#5221, Decision 5): the fleet built-in's approval scope is derived
  // from the script (core run_script's classification), never hard-coded;
  // its digest is mandatory.
  describe('run_script_on_targets', () => {
    const FLEET_INPUT = { scriptId: SCRIPT_ID, whenOffline: 'queue', deviceIds: [DEVICE_ID] };
    const fleetRun = () => serverRun({
      step: { id: STEP_ROW_ID, stepId: 'cleanup', status: 'running', tool: 'run_script_on_targets', toolSource: 'builtin', tier: 3 },
    });
    const fleetInput = () => builtinInput({ toolName: 'run_script_on_targets', input: FLEET_INPUT });

    it('approval scope follows the script', async () => {
      flowState.loadFlowIntentRun.mockResolvedValue(fleetRun());
      effectDigestState.computeEffectDigestOutcome.mockResolvedValue({ kind: 'pinned', digest: 'a'.repeat(64) } as never);
      guardrailState.checkGuardrails.mockReturnValue({ tier: 3, allowed: true, requiresApproval: true, readOnly: false, approvalScope: 'four_eyes', description: 'x' } as never);
      dbState.insertActionIntentsResults.push(echoInsertedIntent());
      dbState.insertApprovalRequestsResults.push([{ id: 'ar-1' }]);
      await createActionIntent(flowAuth(), fleetInput());
      expect(guardrailState.checkGuardrails).toHaveBeenCalledWith('run_script', { scriptId: SCRIPT_ID, deviceIds: [DEVICE_ID] });
      expect(dbState.insertedActionIntentValues[0]).toMatchObject({ actionName: 'run_script_on_targets', approvalScope: 'four_eyes', riskTier: 3 });
    });

    it('missing digest refuses intent creation', async () => {
      flowState.loadFlowIntentRun.mockResolvedValue(fleetRun());
      guardrailState.checkGuardrails.mockReturnValue({ tier: 3, allowed: true, requiresApproval: true, readOnly: false, approvalScope: 'supervised', description: 'x' } as never);
      effectDigestState.computeEffectDigestOutcome.mockResolvedValue({ kind: 'unresolved', reason: 'target_absent' } as never);
      await expect(createActionIntent(flowAuth(), fleetInput())).rejects.toThrow();
      expect(dbState.insertedActionIntentValues).toHaveLength(0);
    });
  });

  it('the server step row must be this built-in, pinned Tier 3', async () => {
    flowState.loadFlowIntentRun.mockResolvedValue(builtinRun({ step: { id: STEP_ROW_ID, stepId: 'cleanup', status: 'running', tool: 'run_script', toolSource: 'core', tier: 3 } }));
    await expect(createActionIntent(flowAuth(), builtinInput())).rejects.toMatchObject({ code: 'flow_run_invalid' });
    flowState.loadFlowIntentRun.mockResolvedValue(builtinRun({ step: { id: STEP_ROW_ID, stepId: 'cleanup', status: 'running', tool: 'http_request', toolSource: 'builtin', tier: 2 } }));
    await expect(createActionIntent(flowAuth(), builtinInput())).rejects.toMatchObject({ code: 'flow_run_invalid' });
    expect(dbState.insertedActionIntentValues).toHaveLength(0);
  });
});
