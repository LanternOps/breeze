import { describe, expect, it, vi, beforeEach } from 'vitest';
import { canonicalizeArguments, computeArgumentDigest } from './canonicalize';

/**
 * P2-1 (Task 3, #4188) — Tier-2 `supervised` intents for the `ai_agent`
 * principal. Mock scaffolding copied from the nearest existing test,
 * `intentService.test.ts` (its `vi.mock('../../db', …)` transaction stub and
 * `makeAgentAuth`/`queueAgentContext` fixtures), with ONE deliberate
 * departure: `../aiGuardrails` is a PARTIAL mock (`importOriginal`) that
 * keeps the real `checkGuardrails` — the function whose `TIER2_ACTIONS`
 * classification this suite exists to prove — and only swaps out
 * `checkAgentGuardrails` (the agent policy-authorization engine, already
 * exhaustively covered by `aiGuardrails.agentPrincipal.contract.test.ts` and
 * orthogonal to what this suite tests). `../aiTools` stays mocked exactly
 * like `intentService.test.ts`, plus a `getToolTier` stub (same tiers
 * `aiGuardrails.test.ts` already hard-codes for these two tools) — real
 * `checkGuardrails` calls it BEFORE any TIER2_ACTIONS/TIER1_ACTIONS lookup,
 * so an unmocked `undefined` would misclassify both tools as tier 4
 * "unknown tool" before ever reaching the escalation tables this suite
 * exercises.
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
    guardrailAgentMock: { checkAgentGuardrails: vi.fn() },
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
    envMock: { policyDecideEnabled: vi.fn(() => false) },
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

vi.mock('../../db/schema/approvals', () => ({
  approvalRequests: schema.approvalRequestsTbl,
}));

vi.mock('./intentApprovers', () => ({
  resolveIntentApprovers: intentApproversState.resolveIntentApprovers,
  resolveAgentIntentApprovers: intentApproversState.resolveAgentIntentApprovers,
  resolveIntentTargetScope: intentApproversState.resolveIntentTargetScope,
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

import { createActionIntent, ActionIntentTierError, type CreateActionIntentInput } from './intentService';

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

describe('Tier-2 intents from the ai_agent principal (P2-1)', () => {
  it('creates a supervised, human_required, riskTier 2 intent for manage_alerts:suppress', async () => {
    queueAgentContext();
    intentApproversState.resolveAgentIntentApprovers.mockResolvedValueOnce([APPROVER_1]);
    dbState.insertActionIntentsResults.push(echoInsertedIntent());
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-1' }]);

    const snapshot = await createActionIntent(makeAgentAuth(), agentInput());

    expect(dbState.insertedActionIntentValues).toHaveLength(1);
    const inserted = dbState.insertedActionIntentValues[0];
    expect(inserted?.approvalScope).toBe('supervised');
    expect(inserted?.riskTier).toBe(2);
    expect(inserted?.policyDecisionState).toBe('human_required');
    expect(snapshot.status).toBe('pending_approval');
    // Fanned out to agentEligibleApprovers (the existing requester-less
    // branch at ~465-480) — one approval row, owned by the mocked
    // agent-eligible approver, not some other user.
    expect(dbState.insertedApprovalRequestsValues.length).toBeGreaterThan(0);
    const insertedApprovals = dbState.insertedApprovalRequestsValues[0] as Array<{ userId: string; riskTier: string }>;
    expect(insertedApprovals.map((r) => r.userId)).toEqual([APPROVER_1]);
    // IMPORTANT 2 (fix round 1): the approval row's `riskTier` LABEL (distinct
    // from the intent's smallint `riskTier` column asserted above) maps
    // guardrail.tier 2 -> 'medium', which floors assurance at L2
    // (DEFAULT_ASSURANCE_FLOOR.medium, @breeze/shared) — deliberate per the
    // controller's ruling, see the comment on this mapping in intentService.ts.
    expect(insertedApprovals[0]?.riskTier).toBe('medium');
  });

  it('still rejects Tier-2 tools for user principals', async () => {
    await expect(createActionIntent(makeAuth(), {
      toolName: 'manage_alerts',
      input: { action: 'suppress', alertId: ALERT_ID },
      source: 'chat',
    })).rejects.toMatchObject({ code: 'tool_not_tier3' });
    expect(dbState.insertedActionIntentValues).toHaveLength(0);
  });

  it('still rejects Tier-1 tools for the ai_agent principal', async () => {
    await expect(createActionIntent(makeAgentAuth(), {
      toolName: 'query_devices',
      input: {},
      source: 'ai_agent',
      orgId: ORG_ID,
    })).rejects.toMatchObject({ code: 'tool_not_tier3' });
    expect(dbState.insertedActionIntentValues).toHaveLength(0);
  });

  // IMPORTANT 1 (fix round 1): without this test, `envMock.policyDecideEnabled`
  // is pinned `false` in every OTHER test in this file (see beforeEach), so
  // `resolvePolicyDecisionState`'s `if (!policyDecideEnabled()) return
  // 'human_required'` short-circuits before ever reaching the new
  // `if (args.guardrail.tier < 3) return 'human_required'` line — the
  // 'creates a supervised...' test above asserts human_required but does NOT
  // discriminate whether the tier<3 guard is the reason. This test flips the
  // flag on AND puts the run in `mode: 'act'` (the other two preconditions
  // 'unattempted' needs — see resolvePolicyDecisionState's doc comment),
  // isolating the tier<3 guard as the ONLY thing standing between this fixture
  // and 'unattempted'. Verified to actually discriminate: temporarily
  // commenting out `if (args.guardrail.tier < 3) return 'human_required';` in
  // intentService.ts turns this test red (see task-3-report.md's fix-round-1
  // section for the exact red output), confirming it is not vacuous.
  it('flag on + agent-originated + Tier-2 (supervised, act mode) -> still human_required, never triggers attemptPolicyDecision', async () => {
    envMock.policyDecideEnabled.mockReturnValue(true);
    queueAgentContext({ run: agentRunRowWithMode('act') });
    intentApproversState.resolveAgentIntentApprovers.mockResolvedValueOnce([APPROVER_1]);
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-tier2-policy-decide' }));
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-1' }]);

    const snapshot = await createActionIntent(makeAgentAuth(), agentInput());

    const inserted = dbState.insertedActionIntentValues[0];
    expect(inserted?.policyDecisionState).toBe('human_required');
    expect(snapshot.status).toBe('pending_approval');
    // 'unattempted' is the only decisionState that skips ordinary human
    // fan-out (see createActionIntent's runHumanFanout gating) — proving the
    // fan-out still ran is a second, independent signal (beyond the state
    // string itself) that this took the human_required path, not unattempted.
    expect(dbState.insertedApprovalRequestsValues.length).toBeGreaterThan(0);
    expect(policyDecideMock.attemptPolicyDecision).not.toHaveBeenCalled();
  });
});
