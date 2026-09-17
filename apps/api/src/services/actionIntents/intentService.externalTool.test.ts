import { describe, expect, it, vi, beforeEach } from 'vitest';
import { canonicalizeArguments, computeArgumentDigest } from './canonicalize';

/**
 * Tool catalog W01 PR B (#5216), Task B2 — `createActionIntent` accepts an
 * EXTERNAL tool binding (`input.externalTool`): a Tier-3 BYO-MCP tool the
 * chat session resolved from `tool_source_tools`. Mock scaffolding copied
 * from `intentService.tier2Agent.test.ts` (same partial `../aiGuardrails`
 * mock), plus a `checkGuardrails` SPY so the suite can prove the core
 * classifier is never consulted for a `<slug>__<name>` tool.
 */

const { schema, dbState, authMock, guardrailAgentMock, aiToolsState, permState, pushState, notifyState, metricsMock, intentApproversState, effectDigestState, envMock, policyDecideMock } = vi.hoisted(() => {
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
      updateActionIntentsWheres: [] as unknown[],
      selectAgentRunsResults: [] as unknown[][],
      selectAgentsResults: [] as unknown[][],
      selectDevicesResults: [] as unknown[][],
    },
    authMock: { dbAccessContextFromAuth: vi.fn((auth: { scope: string; orgId: string | null; accessibleOrgIds: string[] | null; user: { id: string } }) => ({
      scope: auth.scope,
      orgId: auth.orgId,
      accessibleOrgIds: auth.accessibleOrgIds,
      userId: auth.user.id,
    })) },
    // checkGuardrails stays REAL (see header). Only checkAgentGuardrails —
    // the agent policy-authorization gate, unrelated to tier classification
    // — is mocked, so an agent-originated Tier-2 call never hits its
    // BREEZE_AI_AGENTS_ENABLED/kill-switch/allowlist machinery.
    guardrailAgentMock: { checkAgentGuardrails: vi.fn(), checkGuardrails: vi.fn() },
    aiToolsState: {
      tools: new Map<string, { definition: { description?: string } }>(),
      resolveWritableToolOrgId: vi.fn(),
      // Real checkGuardrails' base-tier lookup — same values
      // aiGuardrails.test.ts hard-codes for these two tools.
      getToolTier: vi.fn((toolName: string) => ({ manage_alerts: 1, query_devices: 1 } as Record<string, number | undefined>)[toolName]),
    },
    permState: {
      getUserPermissions: vi.fn(),
      userCanDecideApprovals: vi.fn((perms: { canDecide?: boolean } | null) => !!perms?.canDecide),
    },
    pushState: {
      getUserPushTokens: vi.fn(async () => []),
      dispatchApprovalPushToTokens: vi.fn(async () => ({ tokensFound: 0, dispatched: 0, errors: 0 })),
    },
    notifyState: {
      createNotification: vi.fn(async () => 'notif-1'),
    },
    metricsMock: { recordActionIntentEvent: vi.fn() },
    intentApproversState: {
      resolveIntentApprovers: vi.fn(async () => [] as string[]),
      resolveAgentIntentApprovers: vi.fn(async () => [] as string[]),
      resolveIntentTargetScope: vi.fn(async () => ({ kind: 'indirect' }) as unknown),
    },
    effectDigestState: {
      computeEffectDigestOutcome: vi.fn(async () => ({ kind: 'not_applicable' }) as { kind: string }),
    },
    envMock: { policyDecideEnabled: vi.fn(() => false), sweepActEnabled: vi.fn(() => false) },
    policyDecideMock: { attemptPolicyDecision: vi.fn(async () => {}) },
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
          return {
            returning: vi.fn(async () => dbState.insertApprovalRequestsResults.shift() ?? []),
          };
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
          if (table === schema.actionIntentsTbl) {
            return resultBox(() => dbState.selectActionIntentsResults.shift() ?? []);
          }
          if (table === schema.approvalRequestsTbl) {
            return resultBox(() => dbState.selectApprovalRequestsResults.shift() ?? []);
          }
          if (table === schema.aiAgentRunsTbl) {
            return resultBox(() => dbState.selectAgentRunsResults.shift() ?? []);
          }
          if (table === schema.aiAgentsTbl) {
            return resultBox(() => dbState.selectAgentsResults.shift() ?? []);
          }
          if (table === schema.devicesTbl) {
            return resultBox(() => dbState.selectDevicesResults.shift() ?? []);
          }
          throw new Error('unexpected select table in mock');
        }),
      })),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((setVals: Record<string, unknown>) => {
        if (table !== schema.actionIntentsTbl) throw new Error('unexpected update table in mock');
        dbState.updateActionIntentsSets.push(setVals);
        return {
          where: vi.fn((whereCond: unknown) => {
            dbState.updateActionIntentsWheres.push(whereCond);
            return {
              returning: vi.fn(async () => dbState.updateActionIntentsResults.shift() ?? []),
            };
          }),
        };
      }),
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

// W04 (#5612): the script lane's evaluator is a sibling decision path this
// suite does not exercise; mocked wholesale so its transitive imports (agent
// policy resolver, maintenance gate) never reach the partial schema mocks here.
// W04 (#5612): the post-commit `ai.script.unattended_run` audit write. Mocked
// so auditService's whole-schema import never reaches the partial schema
// mocks in this file; the write itself is asserted in
// intentService.scriptReviewer.test.ts.
vi.mock('../auditService', () => ({ createAuditLogAsync: vi.fn(async () => {}) }));
vi.mock('./scriptReviewerAutonomy', () => ({
  evaluateScriptReviewerAutonomy: vi.fn(async () => ({ granted: false, reason: 'lane_disabled' })),
  revalidateScriptReviewerEvidence: vi.fn(async () => ({ ok: false, reason: 'lane_disabled' })),
}));
vi.mock('../../db/schema/approvals', () => ({
  approvalRequests: schema.approvalRequestsTbl,
}));

vi.mock('./intentApprovers', () => ({
  resolveIntentApprovers: intentApproversState.resolveIntentApprovers,
  resolveAgentIntentApprovers: intentApproversState.resolveAgentIntentApprovers,
  resolveIntentTargetScope: intentApproversState.resolveIntentTargetScope,
  // Org-wide governance classifier (audit §1.1) — REAL semantics, not a
  // constant, so the fan-out filter flag is driven by the same tool/action
  // shape production uses. Literals: vi.mock factories are hoisted.
  isOrgWideGovernanceIntent: (toolName: string, args: Record<string, unknown> | null | undefined) =>
    toolName === 'manage_ai_agents' && args?.action === 'authorize_supervised_key',
}));

vi.mock('../../middleware/auth', () => ({
  dbAccessContextFromAuth: authMock.dbAccessContextFromAuth,
}));

vi.mock('../aiTools', () => ({
  aiTools: aiToolsState.tools,
  resolveWritableToolOrgId: aiToolsState.resolveWritableToolOrgId,
  getToolTier: aiToolsState.getToolTier,
}));

// PARTIAL mock — see file header. Real checkGuardrails (and everything else
// the real module exports, e.g. TIER2_ACTIONS) is kept; only
// checkAgentGuardrails is swapped for a controlled test double.
vi.mock('../aiGuardrails', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../aiGuardrails')>();
  return {
    ...actual,
    checkAgentGuardrails: guardrailAgentMock.checkAgentGuardrails,
    // Spied, NOT stubbed: the core classifier must never be consulted for an
    // external tool (it would answer tier 4 "unknown tool" for a `__` name
    // and kill the intent). The spy delegates to the real function so every
    // non-external test in this file keeps the real classification.
    checkGuardrails: guardrailAgentMock.checkGuardrails.mockImplementation(actual.checkGuardrails),
  };
});

vi.mock('../../db/schema/aiAgents', () => ({
  aiAgents: schema.aiAgentsTbl,
  aiAgentRuns: schema.aiAgentRunsTbl,
}));

vi.mock('../../db/schema/devices', () => ({
  devices: schema.devicesTbl,
}));

vi.mock('../permissions', () => ({
  getUserPermissions: permState.getUserPermissions,
  userCanDecideApprovals: permState.userCanDecideApprovals,
}));

vi.mock('../expoPush', () => ({
  getUserPushTokens: pushState.getUserPushTokens,
  dispatchApprovalPushToTokens: pushState.dispatchApprovalPushToTokens,
}));

vi.mock('../userNotifications', () => ({
  createNotification: notifyState.createNotification,
}));

vi.mock('./metrics', () => ({
  recordActionIntentEvent: metricsMock.recordActionIntentEvent,
}));

vi.mock('./effectDigest', () => ({
  computeEffectDigestOutcome: effectDigestState.computeEffectDigestOutcome,
}));

vi.mock('../../config/env', () => ({
  policyDecideEnabled: envMock.policyDecideEnabled,
  // #4442 W04 sub-flag, default OFF (dark-ship).
  sweepActEnabled: envMock.sweepActEnabled,
}));

vi.mock('./policyDecide', () => ({
  attemptPolicyDecision: policyDecideMock.attemptPolicyDecision,
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ op: 'eq', args })),
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  inArray: vi.fn((...args: unknown[]) => ({ op: 'inArray', args })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    op: 'sql',
    text: strings.reduce(
      (acc, str, i) =>
        acc + str + (i < values.length ? String((values[i] as { name?: string })?.name ?? values[i]) : ''),
      '',
    ),
  })),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { createActionIntent, __resolvePolicyDecisionStateForTest, type CreateActionIntentInput } from './intentService';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const REQUESTER_ID = '22222222-2222-4222-8222-222222222222';
const APPROVER_1 = '33333333-3333-4333-8333-333333333333';
const PARTNER_ID = '55555555-5555-4555-8555-555555555555';
const AGENT_ID = '66666666-6666-4666-8666-666666666666';
const RUN_ID = '77777777-7777-4777-8777-777777777777';
const DEVICE_ID = '99999999-9999-4999-8999-999999999999';
const SITE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ALERT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function makeAuth(overrides?: { partnerId?: string | null; principal?: unknown }) {
  return {
    principal: overrides?.principal ?? { kind: 'user_session' },
    user: { id: REQUESTER_ID, email: 'req@example.com', name: 'Requester' },
    orgId: ORG_ID,
    partnerId: overrides?.partnerId ?? null,
    scope: 'organization' as const,
    accessibleOrgIds: [ORG_ID],
  } as unknown as Parameters<typeof createActionIntent>[0];
}

function makeAgentAuth(runId: string = RUN_ID) {
  return {
    principal: { kind: 'ai_agent', agentId: AGENT_ID, runId },
    user: { id: AGENT_ID, email: `agent+${AGENT_ID}@breeze.internal`, name: 'Verdict agent' },
    orgId: ORG_ID,
    partnerId: PARTNER_ID,
    scope: 'organization' as const,
    accessibleOrgIds: [ORG_ID],
  } as unknown as Parameters<typeof createActionIntent>[0];
}

function makeRunRow(overrides?: Record<string, unknown>) {
  return {
    id: RUN_ID,
    agentId: AGENT_ID,
    orgId: ORG_ID,
    deviceId: DEVICE_ID,
    policySnapshot: {
      schemaVersion: 1,
      agentId: AGENT_ID,
      kind: 'verdict',
      effective: {
        enabled: true,
        mode: 'shadow',
        toolAllowlist: ['manage_alerts'],
        protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
      },
      provenance: {},
      resolvedAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

function makeAgentRow(overrides?: Record<string, unknown>) {
  return { id: AGENT_ID, orgId: ORG_ID, partnerId: null, name: 'Verdict agent', kind: 'verdict', ...overrides };
}

/**
 * A full run row (same shape `makeRunRow` returns) with the policy snapshot's
 * `effective.mode` overridden — mirrors intentService.test.ts's identical
 * helper. `makeRunRow`'s own `overrides` param is a shallow spread, so
 * passing `{ policySnapshot: {...} }` there would REPLACE the whole snapshot
 * rather than patch one field; this deep-clones instead. Used by the P2-1
 * policy-decide-guard test below, which needs `effective.mode` to actually
 * be `'act'`.
 */
function agentRunRowWithMode(mode: string, overrides?: Record<string, unknown>) {
  const base = makeRunRow(overrides);
  return {
    ...base,
    policySnapshot: {
      ...base.policySnapshot,
      effective: { ...base.policySnapshot.effective, mode },
    },
  };
}

/** Queues the run → agent → device system-context loads the agent branch
 * performs. `opts.run` is shallow-merged onto makeRunRow's defaults, so
 * passing a COMPLETE row (e.g. from agentRunRowWithMode) works too — every
 * field, including the nested `policySnapshot`, is simply overwritten
 * wholesale by the full object's own value. */
function queueAgentContext(opts?: { run?: Record<string, unknown>; agent?: Record<string, unknown> }) {
  const run = makeRunRow(opts?.run);
  dbState.selectAgentRunsResults.push([run]);
  dbState.selectAgentsResults.push([makeAgentRow(opts?.agent)]);
  if (run.deviceId) {
    dbState.selectDevicesResults.push([{ id: run.deviceId, siteId: SITE_ID }]);
  }
}

function makeIntentRow(overrides?: Record<string, unknown>) {
  const args = { action: 'suppress', alertId: ALERT_ID, deviceId: DEVICE_ID, suppressDuration: 24 };
  return {
    id: 'intent-1',
    orgId: ORG_ID,
    partnerId: PARTNER_ID,
    requestedByUserId: null,
    requestingApiKeyId: null,
    source: 'ai_agent',
    requestingClientLabel: 'Verdict agent',
    actionName: 'manage_alerts',
    actionVersion: 1,
    arguments: args,
    argumentDigest: computeArgumentDigest(canonicalizeArguments(args)),
    targetSummary: 'manage_alerts(...)',
    impactSummary: 'Suppress an alert',
    reason: null,
    riskTier: 2,
    connectionId: null,
    tenantId: null,
    idempotencyKey: 'verdict-suggest-run-1',
    correlationId: 'corr-1',
    approvalScope: 'supervised',
    classificationVersion: 2,
    effectDigest: null,
    status: 'pending_approval',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 300_000),
    approvalExpiresAt: new Date(Date.now() + 300_000),
    releaseBy: null,
    decidedAt: null,
    decidedByUserId: null,
    decidedAssuranceLevel: null,
    decidedVia: null,
    executedAt: null,
    result: null,
    errorCode: null,
    ...overrides,
  };
}

/** Echoes back whatever the service actually computed (approvalScope,
 * riskTier, policyDecisionState, …) instead of a value the test pre-baked
 * independently — see intentService.test.ts's identical helper. */
function echoInsertedIntent(overrides?: Record<string, unknown>) {
  return (values: Record<string, unknown>) => [
    { ...makeIntentRow(), ...values, id: 'intent-echo', ...overrides },
  ];
}

function agentInput(overrides?: Partial<CreateActionIntentInput>): CreateActionIntentInput {
  return {
    toolName: 'manage_alerts',
    input: { action: 'suppress', alertId: ALERT_ID, deviceId: DEVICE_ID, suppressDuration: 24 },
    source: 'ai_agent',
    orgId: ORG_ID,
    idempotencyKey: 'verdict-suggest-run-1',
    ...overrides,
  };
}

function resetDbState() {
  dbState.insertActionIntentsResults.length = 0;
  dbState.insertApprovalRequestsResults.length = 0;
  dbState.selectActionIntentsResults.length = 0;
  dbState.selectApprovalRequestsResults.length = 0;
  dbState.updateActionIntentsResults.length = 0;
  dbState.insertedActionIntentValues.length = 0;
  dbState.insertedApprovalRequestsValues.length = 0;
  dbState.insertedOutboxValues.length = 0;
  dbState.updateActionIntentsSets.length = 0;
  dbState.updateActionIntentsWheres.length = 0;
  dbState.selectAgentRunsResults.length = 0;
  dbState.selectAgentsResults.length = 0;
  dbState.selectDevicesResults.length = 0;
}

beforeEach(() => {
  resetDbState();
  vi.clearAllMocks();
  aiToolsState.tools.clear();
  aiToolsState.resolveWritableToolOrgId.mockReturnValue({ orgId: ORG_ID });
  aiToolsState.getToolTier.mockImplementation(
    (toolName: string) => ({ manage_alerts: 1, query_devices: 1 } as Record<string, number | undefined>)[toolName],
  );
  // Non-deny by default — this suite is about intentService's OWN tier gate,
  // not aiGuardrails' agent policy-authorization engine (see file header).
  guardrailAgentMock.checkAgentGuardrails.mockReturnValue({
    tier: 2,
    allowed: false,
    requiresApproval: false,
    disposition: 'propose',
    description: 'Suppress an alert',
  });
  intentApproversState.resolveAgentIntentApprovers.mockResolvedValue([]);
  intentApproversState.resolveIntentTargetScope.mockResolvedValue({ kind: 'devices', siteIds: [SITE_ID] });
  permState.getUserPermissions.mockResolvedValue(null);
  permState.userCanDecideApprovals.mockImplementation((perms: { canDecide?: boolean } | null) => !!perms?.canDecide);
  pushState.getUserPushTokens.mockResolvedValue([]);
  pushState.dispatchApprovalPushToTokens.mockResolvedValue({ tokensFound: 0, dispatched: 0, errors: 0 });
  notifyState.createNotification.mockResolvedValue('notif-1');
  intentApproversState.resolveIntentApprovers.mockResolvedValue([]);
  effectDigestState.computeEffectDigestOutcome.mockResolvedValue({ kind: 'not_applicable' });
  envMock.policyDecideEnabled.mockReturnValue(false);
  policyDecideMock.attemptPolicyDecision.mockResolvedValue(undefined);
});


const TOOL_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function externalInput(overrides?: Partial<CreateActionIntentInput>): CreateActionIntentInput {
  return {
    toolName: 'hudu__create_asset',
    input: { name: 'Printer 3', companyId: 42 },
    source: 'chat',
    orgId: ORG_ID,
    externalTool: { toolSourceToolId: TOOL_ID, revision: 'rev-7', sourceName: 'Hudu' },
    ...overrides,
  };
}

describe('external (tenant tool-source) Tier-3 intents (tool catalog W01 PR B, #5216)', () => {
  it('creates a tier-3 supervised intent bound to the tool row + revision, without consulting checkGuardrails', async () => {
    intentApproversState.resolveIntentApprovers.mockResolvedValueOnce([APPROVER_1]);
    dbState.insertActionIntentsResults.push(echoInsertedIntent());
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-1' }]);

    const snapshot = await createActionIntent(makeAuth(), externalInput());

    expect(guardrailAgentMock.checkGuardrails).not.toHaveBeenCalled();
    expect(dbState.insertedActionIntentValues).toHaveLength(1);
    const inserted = dbState.insertedActionIntentValues[0]!;
    expect(inserted.actionName).toBe('hudu__create_asset');
    expect(inserted.riskTier).toBe(3);
    expect(inserted.approvalScope).toBe('supervised');
    expect(inserted.toolSourceToolId).toBe(TOOL_ID);
    expect(inserted.toolRevision).toBe('rev-7');
    expect(inserted.policyDecisionState).toBe('human_required');
    expect(inserted.targetSummary).toBe('hudu__create_asset (external tool from Hudu)');
    // The approver reads which arguments the remote call will carry.
    expect(inserted.impactSummary).toContain('companyId');
    expect(inserted.impactSummary).toContain('name');
    expect(snapshot.status).toBe('pending_approval');
  });

  it('writes NULL binding columns for a core intent (pairing CHECK)', async () => {
    aiToolsState.getToolTier.mockReturnValue(3);
    intentApproversState.resolveIntentApprovers.mockResolvedValueOnce([APPROVER_1]);
    dbState.insertActionIntentsResults.push(echoInsertedIntent());
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-1' }]);

    await createActionIntent(makeAuth(), {
      toolName: 'execute_command',
      input: { deviceId: DEVICE_ID, command: 'whoami' },
      source: 'chat',
      orgId: ORG_ID,
    });

    const inserted = dbState.insertedActionIntentValues[0]!;
    expect(inserted.toolSourceToolId).toBeNull();
    expect(inserted.toolRevision).toBeNull();
  });

  it('refuses an ai_agent principal (agents cannot mint external intents in W1)', async () => {
    queueAgentContext();
    await expect(
      createActionIntent(makeAgentAuth(), externalInput({ source: 'ai_agent', idempotencyKey: 'run-1' })),
    ).rejects.toMatchObject({ code: 'external_tool_not_allowed_for_agent' });
    expect(dbState.insertedActionIntentValues).toHaveLength(0);
  });

  it('rejects a binding whose tool id is not a canonical lowercase UUID', async () => {
    await expect(
      createActionIntent(makeAuth(), externalInput({
        externalTool: { toolSourceToolId: TOOL_ID.toUpperCase(), revision: 'rev-7', sourceName: 'Hudu' },
      })),
    ).rejects.toMatchObject({ code: 'invalid_external_tool' });
    await expect(
      createActionIntent(makeAuth(), externalInput({
        externalTool: { toolSourceToolId: TOOL_ID, revision: '', sourceName: 'Hudu' },
      })),
    ).rejects.toMatchObject({ code: 'invalid_external_tool' });
    expect(dbState.insertedActionIntentValues).toHaveLength(0);
  });

  it('rejects an external binding whose tool name is not a qualified <slug>__<name>', async () => {
    await expect(
      createActionIntent(makeAuth(), externalInput({ toolName: 'execute_command' })),
    ).rejects.toMatchObject({ code: 'invalid_external_tool' });
    expect(guardrailAgentMock.checkGuardrails).not.toHaveBeenCalled();
    expect(dbState.insertedActionIntentValues).toHaveLength(0);
  });

  it('refuses to reuse a live idempotency key whose external binding changed (rediscovered tool row)', async () => {
    // The tool was deleted and recreated under the same qualified name (new
    // uuid) — or rediscovered into a new revision — while an earlier intent
    // with identical args/actor is still pending. Reusing it would hand back a
    // binding release revalidation is going to refuse.
    dbState.insertActionIntentsResults.push([]); // ON CONFLICT DO NOTHING -> no row
    dbState.selectActionIntentsResults.push([
      {
        ...makeIntentRow({
          actionName: 'hudu__create_asset',
          source: 'chat',
          status: 'pending_approval',
          requestingAgentRunId: null,
          toolSourceToolId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          toolRevision: 'rev-6',
        }),
        argumentDigest: computeArgumentDigest(
          canonicalizeArguments({ name: 'Printer 3', companyId: 42 }),
        ),
      },
    ]);

    await expect(
      createActionIntent(makeAuth(), externalInput({ idempotencyKey: 'reuse-1' })),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('policy-decide can never authorize an external tool (qualified names are not decidable keys)', () => {
    // Asserted, not trusted: resolvePolicyDecisionState keys on
    // isPolicyDecidableKey(toolName), which can never match a `__` name.
    const state = __resolvePolicyDecisionStateForTest({
      guardrail: { tier: 3, allowed: true, requiresApproval: true, readOnly: false, approvalScope: 'supervised', description: 'x' },
      approvalScope: 'supervised',
      toolName: 'hudu__create_asset',
      input: { name: 'Printer 3' },
      agentRun: null,
      agentRunMode: undefined,
      scopeDeviceId: null,
      scopeTicketId: null,
      trigger: undefined,
      sweepAct: undefined,
    } as unknown as Parameters<typeof __resolvePolicyDecisionStateForTest>[0]);
    expect(state).toBe('human_required');
  });
});
