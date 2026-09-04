import { describe, it, expect, vi, beforeEach } from 'vitest';
import { canonicalizeArguments, computeArgumentDigest } from './canonicalize';
// Type-only (erased at runtime), so it is safe to reference inside vi.hoisted.
import type { EffectDigestOutcome } from './effectDigest';

// ---------------------------------------------------------------------------
// Hoisted shared mock state
// ---------------------------------------------------------------------------

const { schema, dbState, authMock, guardrailMock, aiToolsState, permState, pushState, notifyState, metricsMock, intentApproversState, effectDigestState, envMock, policyDecideMock } = vi.hoisted(() => {
  const col = (name: string) => ({ name });
  const actionIntentsTbl = {
    id: col('id'),
    orgId: col('org_id'),
    idempotencyKey: col('idempotency_key'),
    status: col('status'),
    expiresAt: col('expires_at'),
    releaseBy: col('release_by'),
    // Needed by transitionIntent's `requireNotExpired: 'approval'` branch —
    // without it the flattened SQL reads `COALESCE(undefined, expires_at)`
    // and the deadline-column assertions pass/fail on a phantom.
    approvalExpiresAt: col('approval_expires_at'),
  };
  // `userId` MUST be present here: createActionIntent projects
  // `approvalRequests.userId` on the idempotent-replay path and matches it
  // against the requester to derive `requesterApprovalRequestId`. Without the
  // column the projection key is `undefined` and every
  // requesterApprovalRequestId assertion below passes vacuously.
  const approvalRequestsTbl = { id: col('id'), intentId: col('intent_id'), userId: col('user_id') };
  const intentOutboxTbl = { id: col('id'), intentId: col('intent_id') };
  // Agent-branch (wave 3b) tables: loaded system-scoped inside
  // createActionIntent to verify the run and rebuild the guardrail policy.
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
      // Most entries are a plain queued row array (existing convention). A
      // few new scope/deadline tests instead queue a FUNCTION that receives
      // the actual `.values(...)` the service passed to db.insert(...) — so
      // the "returned" row echoes back whatever computeExpiresAt /
      // approvalScope the service really computed, instead of a value the
      // test pre-baked independently of production logic.
      insertActionIntentsResults: [] as Array<unknown[] | ((values: Record<string, unknown>) => unknown[])>,
      insertApprovalRequestsResults: [] as unknown[][],
      selectActionIntentsResults: [] as unknown[][],
      selectApprovalRequestsResults: [] as unknown[][],
      updateActionIntentsResults: [] as unknown[][],
      insertedActionIntentValues: [] as Record<string, unknown>[],
      insertedApprovalRequestsValues: [] as unknown[],
      insertedOutboxValues: [] as Record<string, unknown>[],
      // Set to inject a failure on the NEXT intent_outbox insert only (auto
      // clears itself) — proves the transaction-catch path in
      // cancelActionIntent without giving every other outbox-writing test a
      // footgun to forget to reset.
      outboxInsertError: null as Error | null,
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
    notifyState: {
      createNotification: vi.fn(async () => 'notif-1'),
    },
    metricsMock: { recordActionIntentEvent: vi.fn() },
    // CRITICAL-2: approver resolution is now a single opaque resolver call
    // (org + partner axis) instead of an organization_users select + N
    // getUserPermissions round-trips, so it's mocked wholesale here rather
    // than reconstructed from db-table mocks.
    intentApproversState: {
      resolveIntentApprovers: vi.fn(async () => [] as string[]),
      resolveAgentIntentApprovers: vi.fn(async () => [] as string[]),
      resolveIntentTargetScope: vi.fn(async () => ({ kind: 'indirect' }) as unknown),
    },
    // Task 7 (effect-digest pinning): effectDigest.ts has its own dedicated
    // unit suite (effectDigest.test.ts) covering the resolver map itself —
    // mocked wholesale here so this file stays a test of createActionIntent's
    // WIRING (calls it for EVERY tier-3 intent regardless of scope, persists a
    // digest only on `pinned`, audits the `unresolved` reasons) rather than
    // re-deriving script/quote/invoice/contract/org table mocks this suite has
    // no other reason to know about.
    effectDigestState: {
      computeEffectDigestOutcome: vi.fn(async () => ({ kind: 'not_applicable' }) as EffectDigestOutcome),
    },
    // Wave 5 Part B (#3827): defaults OFF, matching the real flag's default —
    // most of this suite must stay behaviorally identical whether or not
    // policyDecideEnabled is even imported, proving flag-off inertness.
    envMock: { policyDecideEnabled: vi.fn(() => false) },
    // The dynamic import() inside triggerPolicyDecisionAttempt resolves
    // through this mock exactly like a static import would — vi.mock
    // intercepts both. A no-op async fn by default so a triggered attempt
    // never rejects unhandled in a test that doesn't care about it.
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
          if (dbState.outboxInsertError) {
            const err = dbState.outboxInsertError;
            dbState.outboxInsertError = null;
            return Promise.reject(err);
          }
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
}));

vi.mock('../aiGuardrails', () => ({
  checkGuardrails: guardrailMock.checkGuardrails,
  checkAgentGuardrails: guardrailMock.checkAgentGuardrails,
}));

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
  // Flattens the tagged template to its static text, substituting each
  // interpolated column mock's `.name` — enough to assert which columns a
  // `sql\`...\`` fragment references without a real SQL builder.
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

import {
  createActionIntent,
  getActionIntent,
  cancelActionIntent,
  transitionIntent,
  waitForIntentDecision,
  runDeferredHumanFanout,
  ActionIntentError,
  ActionIntentTierError,
  ActionIntentNotFoundError,
  ActionIntentAuthorizationError,
  type CreateActionIntentInput,
} from './intentService';
import { db, withDbAccessContext } from '../../db';
import { computeEffectDigestOutcome } from './effectDigest';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const REQUESTER_ID = '22222222-2222-4222-8222-222222222222';
const APPROVER_1 = '33333333-3333-4333-8333-333333333333';
const APPROVER_2 = '44444444-4444-4444-8444-444444444444';
const PARTNER_ID = '55555555-5555-4555-8555-555555555555';
const AGENT_ID = '66666666-6666-4666-8666-666666666666';
const RUN_ID = '77777777-7777-4777-8777-777777777777';
const RUN_ID_2 = '88888888-8888-4888-8888-888888888888';
const DEVICE_ID = '99999999-9999-4999-8999-999999999999';
const SITE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ORG_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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

function baseInput(overrides?: Partial<CreateActionIntentInput>): CreateActionIntentInput {
  return {
    toolName: 'run_script',
    input: { scriptId: 'script-1', deviceIds: ['device-1'] },
    source: 'chat',
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
  dbState.outboxInsertError = null;
  dbState.updateActionIntentsSets.length = 0;
  dbState.updateActionIntentsWheres.length = 0;
  dbState.selectAgentRunsResults.length = 0;
  dbState.selectAgentsResults.length = 0;
  dbState.selectDevicesResults.length = 0;
}

function makeIntentRow(overrides?: Record<string, unknown>) {
  return {
    id: 'intent-1',
    orgId: ORG_ID,
    partnerId: null,
    requestedByUserId: REQUESTER_ID,
    requestingApiKeyId: null,
    source: 'chat',
    requestingClientLabel: 'Breeze AI',
    actionName: 'run_script',
    actionVersion: 1,
    arguments: { scriptId: 'script-1', deviceIds: ['device-1'] },
    argumentDigest: computeArgumentDigest(canonicalizeArguments({ scriptId: 'script-1', deviceIds: ['device-1'] })),
    targetSummary: 'run_script(...)',
    impactSummary: 'Execute run_script',
    reason: null,
    riskTier: 3,
    connectionId: null,
    tenantId: null,
    idempotencyKey: 'idem-1',
    correlationId: 'corr-1',
    // Defaults mirror the schema DEFAULT ('four_eyes' / classificationVersion
    // 0) — tests exercising the tier3-supervised-four-eyes split override
    // these explicitly (see createIntentWith / echoInsertedIntent below).
    approvalScope: 'four_eyes',
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

/**
 * Queues a `db.insert(actionIntents).values(...).returning()` result that
 * echoes back whatever the service actually computed (approvalScope,
 * approvalExpiresAt/expiresAt, classificationVersion, ...) instead of a value
 * the test pre-baked independently — so assertions on the returned snapshot
 * genuinely exercise computeExpiresAt / the approvalScope resolution in
 * intentService.ts, not just the id plumbing.
 */
function echoInsertedIntent(overrides?: Record<string, unknown>) {
  return (values: Record<string, unknown>) => [
    { ...makeIntentRow(), ...values, id: 'intent-echo', ...overrides },
  ];
}

function msUntil(date: Date): number {
  return date.getTime() - Date.now();
}

// ---------------------------------------------------------------------------
// ai_agent branch fixtures (wave 3b)
// ---------------------------------------------------------------------------

function makeAgentAuth(runId: string = RUN_ID) {
  return {
    principal: { kind: 'ai_agent', agentId: AGENT_ID, runId },
    // Attribution-only synthetic user (buildAgentAuthContext): id is the
    // AGENT id — the requester-less write path must never stamp it into
    // requestedByUserId nor derive the default idempotency key from it.
    user: { id: AGENT_ID, email: `agent+${AGENT_ID}@breeze.internal`, name: 'Patch agent' },
    orgId: ORG_ID,
    partnerId: PARTNER_ID,
    scope: 'organization' as const,
    accessibleOrgIds: [ORG_ID],
  } as unknown as Parameters<typeof createActionIntent>[0];
}

function agentInput(overrides?: Partial<CreateActionIntentInput>): CreateActionIntentInput {
  return {
    toolName: 'manage_services',
    input: { deviceId: DEVICE_ID, action: 'restart', serviceName: 'spooler' },
    source: 'ai_agent',
    ...overrides,
  };
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
      kind: 'patch',
      effective: {
        enabled: true,
        mode: 'shadow',
        toolAllowlist: ['manage_services'],
        protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
      },
      provenance: {},
      resolvedAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

function makeAgentRow(overrides?: Record<string, unknown>) {
  return { id: AGENT_ID, orgId: ORG_ID, partnerId: null, name: 'Patch agent', kind: 'patch', ...overrides };
}

/** Queues the run → agent → device system-context loads the agent branch performs. */
function queueAgentContext(opts?: { run?: Record<string, unknown>; agent?: Record<string, unknown> }) {
  const run = makeRunRow(opts?.run);
  dbState.selectAgentRunsResults.push([run]);
  dbState.selectAgentsResults.push([makeAgentRow(opts?.agent)]);
  if (run.deviceId) {
    dbState.selectDevicesResults.push([{ id: run.deviceId, siteId: SITE_ID }]);
  }
}

/**
 * A full run row (same shape `makeRunRow` returns) with the policy snapshot's
 * `effective.mode` overridden. `makeRunRow`'s own `overrides` param is a
 * shallow spread, so passing `{ policySnapshot: {...} }` there would REPLACE
 * the whole snapshot rather than patch one field — this deep-clones instead.
 * Used by the Wave 5 Part B (#3827) mode-gate tests below, which need
 * `effective.mode` to actually be `'act'` — `makeRunRow`'s own default is
 * `'shadow'` (the wave-3b baseline every OTHER test in this file relies on).
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

beforeEach(() => {
  resetDbState();
  vi.clearAllMocks();
  aiToolsState.tools.clear();
  aiToolsState.resolveWritableToolOrgId.mockReturnValue({ orgId: ORG_ID });
  guardrailMock.checkGuardrails.mockReturnValue({
    tier: 3,
    allowed: true,
    requiresApproval: true,
    description: 'Run a script on one or more devices',
  });
  // Agent-branch defaults: 'propose' (the shadow-mode verdict createActionIntent
  // accepts); deny is opted into per test. Target scope resolves to the run
  // device's site; eligibility resolves to nobody unless a test opts in.
  guardrailMock.checkAgentGuardrails.mockReturnValue({
    tier: 3,
    allowed: false,
    requiresApproval: false,
    disposition: 'propose',
    description: 'Manage services on a device',
  });
  intentApproversState.resolveAgentIntentApprovers.mockResolvedValue([]);
  intentApproversState.resolveIntentTargetScope.mockResolvedValue({ kind: 'devices', siteIds: [SITE_ID] });
  permState.getUserPermissions.mockResolvedValue(null);
  permState.userCanDecideApprovals.mockImplementation((perms: { canDecide?: boolean } | null) => !!perms?.canDecide);
  pushState.getUserPushTokens.mockResolvedValue([]);
  pushState.dispatchApprovalPushToTokens.mockResolvedValue({ tokensFound: 0, dispatched: 0, errors: 0 });
  notifyState.createNotification.mockResolvedValue('notif-1');
  // No eligible approvers by default — tests that need a fan-out opt in via
  // mockResolvedValueOnce.
  intentApproversState.resolveIntentApprovers.mockResolvedValue([]);
  effectDigestState.computeEffectDigestOutcome.mockResolvedValue({ kind: 'not_applicable' });
  envMock.policyDecideEnabled.mockReturnValue(false);
  policyDecideMock.attemptPolicyDecision.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Tier gating
// ---------------------------------------------------------------------------

describe('createActionIntent — tier gating', () => {
  it('rejects a Tier <=2 tool as not-an-intent-path', async () => {
    guardrailMock.checkGuardrails.mockReturnValue({ tier: 2, allowed: true, requiresApproval: false });
    await expect(createActionIntent(makeAuth(), baseInput())).rejects.toMatchObject({
      code: 'tool_not_tier3',
    });
    await expect(createActionIntent(makeAuth(), baseInput())).rejects.toBeInstanceOf(ActionIntentTierError);
    expect(dbState.insertedActionIntentValues).toHaveLength(0);
  });

  it('refuses a Tier 4 (blocked) tool outright', async () => {
    guardrailMock.checkGuardrails.mockReturnValue({
      tier: 4,
      allowed: false,
      requiresApproval: false,
      reason: 'Unknown tool: delete_everything',
    });
    await expect(createActionIntent(makeAuth(), baseInput({ toolName: 'delete_everything' }))).rejects.toMatchObject({
      code: 'tool_blocked',
    });
    expect(dbState.insertedActionIntentValues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// P2-5 (#4192): manage_ai_agents's orgId ARGUMENT is pinned to the intent's org
// ---------------------------------------------------------------------------

describe('createActionIntent — manage_ai_agents orgId argument', () => {
  const promoteInput = (orgId?: unknown) => baseInput({
    toolName: 'manage_ai_agents',
    input: {
      action: 'authorize_supervised_key',
      kind: 'triage',
      opKey: 'manage_services:restart',
      ...(orgId === undefined ? {} : { orgId }),
    },
  });

  it('refuses an orgId argument that names a different organization', async () => {
    await expect(createActionIntent(makeAuth(), promoteInput(OTHER_ORG_ID))).rejects.toMatchObject({
      code: 'org_argument_mismatch',
    });
    expect(dbState.insertedActionIntentValues).toHaveLength(0);
  });

  it('refuses a missing orgId argument — the digest resolver has nothing to pin without it', async () => {
    await expect(createActionIntent(makeAuth(), promoteInput())).rejects.toMatchObject({
      code: 'org_argument_mismatch',
    });
    expect(dbState.insertedActionIntentValues).toHaveLength(0);
  });

  it('accepts the argument when it names the organization the intent resolved to', async () => {
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-promote' }));
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-promote' }]);

    const snap = await createActionIntent(
      makeAuth(),
      promoteInput(ORG_ID),
    );

    expect(snap.id).toBe('intent-promote');
    expect(dbState.insertedActionIntentValues).toHaveLength(1);
  });

  it('leaves the orgId argument of every OTHER tool alone', async () => {
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-other-tool' }));
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-other-tool' }]);

    const snap = await createActionIntent(
      makeAuth(),
      baseInput({ input: { scriptId: 'script-1', orgId: OTHER_ORG_ID } }),
    );

    expect(snap.id).toBe('intent-other-tool');
  });
});

// ---------------------------------------------------------------------------
// Digest stability
// ---------------------------------------------------------------------------

describe('createActionIntent — ai_agent branch (wave 3b)', () => {
  // Wave 3a's inert guard (agent_origin_unsupported) is gone: an ai_agent
  // principal now takes the requester-less branch. What replaces the guard is
  // the mutual source/principal pairing below plus in-service re-verification
  // of the run and its guardrail verdict — the caller is never trusted.

  function supervisedGuardrail() {
    guardrailMock.checkGuardrails.mockReturnValue({
      tier: 3,
      allowed: true,
      requiresApproval: true,
      description: 'Manage services on a device',
      approvalScope: 'supervised',
    });
  }

  it('creates a requester-less intent for an ai_agent principal', async () => {
    supervisedGuardrail();
    queueAgentContext();
    intentApproversState.resolveAgentIntentApprovers.mockResolvedValueOnce([APPROVER_1]);
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-agent' }));
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-agent-1' }]);

    const snap = await createActionIntent(makeAgentAuth(), agentInput());

    const inserted = dbState.insertedActionIntentValues[0]!;
    expect(inserted.requestedByUserId).toBeNull();
    expect(inserted.requestingAgentRunId).toBe(RUN_ID);
    expect(inserted.originPrincipalKind).toBe('ai_agent');
    expect(inserted.originPrincipalId).toBe(AGENT_ID);
    expect(inserted.source).toBe('ai_agent');
    // No requestingClientLabel in the input → the agent's display name.
    expect(inserted.requestingClientLabel).toBe('Patch agent');
    expect(snap.status).toBe('pending_approval');
    // There is no requester, so there is never a requester-owned row.
    expect(snap.requesterApprovalRequestId).toBeNull();
  });

  it('re-verifies the guardrail verdict in-service from the run snapshot (device pins from the RUN row)', async () => {
    supervisedGuardrail();
    queueAgentContext();
    intentApproversState.resolveAgentIntentApprovers.mockResolvedValueOnce([APPROVER_1]);
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-agent-verify' }));
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-agent-verify' }]);

    await createActionIntent(makeAgentAuth(), agentInput());

    expect(guardrailMock.checkAgentGuardrails).toHaveBeenCalledWith(
      'manage_services',
      expect.objectContaining({ action: 'restart' }),
      expect.objectContaining({
        enabled: true,
        mode: 'shadow',
        toolAllowlist: ['manage_services'],
        // Task 3 contract: deviceId/deviceSiteId come from the RUN row, never
        // from tool input; an absent deviceId fails validation and denies.
        deviceId: DEVICE_ID,
        deviceSiteId: SITE_ID,
      }),
    );
  });

  it('rejects an ai_agent principal whose source is not ai_agent', async () => {
    await expect(
      createActionIntent(makeAgentAuth(), agentInput({ source: 'chat' })),
    ).rejects.toMatchObject({ code: 'agent_source_mismatch' });
    expect(dbState.insertedActionIntentValues).toHaveLength(0);
  });

  it('rejects a human principal claiming source ai_agent', async () => {
    await expect(
      createActionIntent(makeAuth(), baseInput({ source: 'ai_agent' })),
    ).rejects.toMatchObject({ code: 'agent_source_mismatch' });
    expect(dbState.insertedActionIntentValues).toHaveLength(0);
  });

  it('rejects when the run does not belong to the principal', async () => {
    supervisedGuardrail();
    dbState.selectAgentRunsResults.push([
      makeRunRow({ agentId: '00000000-0000-4000-8000-00000000dead' }),
    ]);
    await expect(createActionIntent(makeAgentAuth(), agentInput())).rejects.toMatchObject({
      code: 'agent_run_invalid',
    });
    expect(dbState.insertedActionIntentValues).toHaveLength(0);
  });

  it('rejects a missing run and a cross-org run alike', async () => {
    supervisedGuardrail();
    dbState.selectAgentRunsResults.push([]);
    await expect(createActionIntent(makeAgentAuth(), agentInput())).rejects.toMatchObject({
      code: 'agent_run_invalid',
    });
    dbState.selectAgentRunsResults.push([
      makeRunRow({ orgId: '00000000-0000-4000-8000-0000000000bb' }),
    ]);
    await expect(createActionIntent(makeAgentAuth(), agentInput())).rejects.toMatchObject({
      code: 'agent_run_invalid',
    });
    expect(dbState.insertedActionIntentValues).toHaveLength(0);
  });

  it('rejects when the guardrail verdict is deny', async () => {
    supervisedGuardrail();
    queueAgentContext();
    guardrailMock.checkAgentGuardrails.mockReturnValue({
      tier: 3,
      allowed: false,
      requiresApproval: false,
      disposition: 'deny',
      reason: 'Tool "manage_services" is not in the agent allowlist',
    });
    await expect(createActionIntent(makeAgentAuth(), agentInput())).rejects.toMatchObject({
      code: 'agent_policy_denied',
    });
    expect(dbState.insertedActionIntentValues).toHaveLength(0);
  });

  it('gives ai_agent intents the explicit 24h agent expiry', async () => {
    supervisedGuardrail();
    queueAgentContext();
    intentApproversState.resolveAgentIntentApprovers.mockResolvedValueOnce([APPROVER_1]);
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-agent-expiry' }));
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-agent-expiry' }]);

    const snap = await createActionIntent(makeAgentAuth(), agentInput());

    expect(msUntil(snap.expiresAt)).toBeCloseTo(24 * 60 * 60 * 1000, -4);
    expect(msUntil(snap.approvalExpiresAt!)).toBeCloseTo(24 * 60 * 60 * 1000, -4);
  });

  it('fans a supervised agent intent out to action-and-target-eligible humans', async () => {
    supervisedGuardrail();
    queueAgentContext();
    intentApproversState.resolveAgentIntentApprovers.mockResolvedValueOnce([APPROVER_1, APPROVER_2]);
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-agent-fanout' }));
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-af-1' }, { id: 'approval-af-2' }]);

    const snap = await createActionIntent(makeAgentAuth(), agentInput());

    expect(intentApproversState.resolveIntentTargetScope).toHaveBeenCalledWith(
      'manage_services',
      expect.objectContaining({ action: 'restart' }),
      expect.objectContaining({ deviceId: DEVICE_ID }),
      // The intent org MUST be threaded through so the device resolution is
      // org-pinned (review finding 1).
      ORG_ID,
    );
    expect(intentApproversState.resolveAgentIntentApprovers).toHaveBeenCalledWith({
      orgId: ORG_ID,
      toolName: 'manage_services',
      input: expect.objectContaining({ action: 'restart' }),
      targetScope: { kind: 'devices', siteIds: [SITE_ID] },
    });
    const inserted = dbState.insertedApprovalRequestsValues[0] as Array<{ userId: string }>;
    expect(inserted.map((r) => r.userId)).toEqual([APPROVER_1, APPROVER_2]);
    expect(snap.fanOutUserIds).toEqual([APPROVER_1, APPROVER_2]);
    expect(snap.requesterApprovalRequestId).toBeNull();
  });

  it('cancels no_eligible_approvers when nobody is eligible', async () => {
    supervisedGuardrail();
    queueAgentContext();
    intentApproversState.resolveAgentIntentApprovers.mockResolvedValueOnce([]);
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-agent-none' }));
    dbState.updateActionIntentsResults.push([
      makeIntentRow({
        id: 'intent-agent-none',
        source: 'ai_agent',
        status: 'cancelled',
        errorCode: 'no_eligible_approvers',
      }),
    ]);

    const snap = await createActionIntent(makeAgentAuth(), agentInput());

    expect(snap.status).toBe('cancelled');
    expect(snap.errorCode).toBe('no_eligible_approvers');
    expect(dbState.insertedApprovalRequestsValues).toHaveLength(0);
    // A cancelled agent intent notifies nobody, widened gate or not.
    expect(notifyState.createNotification).not.toHaveBeenCalled();
    expect(pushState.dispatchApprovalPushToTokens).not.toHaveBeenCalled();
  });

  it('two runs of the same agent with identical args get DISTINCT intents (run-scoped idempotency key)', async () => {
    supervisedGuardrail();
    intentApproversState.resolveAgentIntentApprovers.mockResolvedValue([APPROVER_1]);

    queueAgentContext();
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-run-a' }));
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-run-a' }]);
    await createActionIntent(makeAgentAuth(RUN_ID), agentInput());

    queueAgentContext({ run: { id: RUN_ID_2 } });
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-run-b' }));
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-run-b' }]);
    await createActionIntent(makeAgentAuth(RUN_ID_2), agentInput());

    const [first, second] = dbState.insertedActionIntentValues;
    expect(first!.idempotencyKey).toBeTruthy();
    expect(second!.idempotencyKey).toBeTruthy();
    expect(first!.idempotencyKey).not.toBe(second!.idempotencyKey);
    expect(first!.requestingAgentRunId).toBe(RUN_ID);
    expect(second!.requestingAgentRunId).toBe(RUN_ID_2);
  });

  it('a replay hit that mismatches source/run/digest throws idempotency_conflict', async () => {
    supervisedGuardrail();
    queueAgentContext();
    // Conflict on (org_id, idempotency_key)…
    dbState.insertActionIntentsResults.push([]);
    // …but the live row belongs to ANOTHER run (identical args, so the digest
    // matches — only the run attribution differs). Returning it would hand
    // run A an intent immutably attributed to run B, whose policy snapshot
    // the release path would then evaluate.
    dbState.selectActionIntentsResults.push([
      makeIntentRow({
        id: 'foreign-run-intent',
        source: 'ai_agent',
        requestedByUserId: null,
        requestingAgentRunId: RUN_ID_2,
        argumentDigest: computeArgumentDigest(canonicalizeArguments(agentInput().input)),
      }),
    ]);

    await expect(
      createActionIntent(makeAgentAuth(), agentInput({ idempotencyKey: 'collide-key' })),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('a replay hit matching source/run/digest converges on the existing intent', async () => {
    supervisedGuardrail();
    queueAgentContext();
    dbState.insertActionIntentsResults.push([]);
    dbState.selectActionIntentsResults.push([
      makeIntentRow({
        id: 'same-run-intent',
        source: 'ai_agent',
        actionName: 'manage_services',
        requestedByUserId: null,
        requestingAgentRunId: RUN_ID,
        argumentDigest: computeArgumentDigest(canonicalizeArguments(agentInput().input)),
      }),
    ]);
    dbState.selectApprovalRequestsResults.push([{ id: 'approval-existing', userId: APPROVER_1 }]);

    const snap = await createActionIntent(
      makeAgentAuth(),
      agentInput({ idempotencyKey: 'replay-key' }),
    );

    expect(snap.id).toBe('same-run-intent');
    expect(snap.requesterApprovalRequestId).toBeNull();
    expect(dbState.insertedApprovalRequestsValues).toHaveLength(0);
    expect(metricsMock.recordActionIntentEvent).not.toHaveBeenCalled();
  });

  it('a replay hit for a DIFFERENT tool under the same explicit key throws idempotency_conflict', async () => {
    // Review finding 2: the replay check must bind the key to the action
    // name. With an explicit caller-supplied key, two different tools can
    // collide with byte-identical canonical arguments (the default key embeds
    // actionName, an explicit one need not) — same source, same run, same
    // digest, different tool. Treating tool B as a replay of tool A would
    // silently drop proposal B: no second intent, no fan-out, no error.
    supervisedGuardrail();
    queueAgentContext();
    dbState.insertActionIntentsResults.push([]);
    dbState.selectActionIntentsResults.push([
      makeIntentRow({
        id: 'other-tool-intent',
        source: 'ai_agent',
        actionName: 'execute_command', // ≠ agentInput().toolName ('manage_services')
        requestedByUserId: null,
        requestingAgentRunId: RUN_ID,
        argumentDigest: computeArgumentDigest(canonicalizeArguments(agentInput().input)),
      }),
    ]);

    await expect(
      createActionIntent(makeAgentAuth(), agentInput({ idempotencyKey: 'shared-key' })),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(dbState.insertedApprovalRequestsValues).toHaveLength(0);
  });

  it('audits agent creation as ai_agent with run details', async () => {
    supervisedGuardrail();
    queueAgentContext();
    intentApproversState.resolveAgentIntentApprovers.mockResolvedValueOnce([APPROVER_1]);
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-agent-audit' }));
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-agent-audit' }]);

    await createActionIntent(makeAgentAuth(), agentInput());

    expect(metricsMock.recordActionIntentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'created',
        actorType: 'ai_agent',
        details: expect.objectContaining({ agentId: AGENT_ID, agentRunId: RUN_ID }),
      }),
    );
    const createdCall = metricsMock.recordActionIntentEvent.mock.calls.find(
      (call) => (call[0] as { outcome: string }).outcome === 'created',
    )![0] as { actorId?: string };
    expect(createdCall.actorId).toBeUndefined();
  });

  it('notifies supervised agent-intent approvers (gate widened past four_eyes)', async () => {
    supervisedGuardrail();
    queueAgentContext();
    intentApproversState.resolveAgentIntentApprovers.mockResolvedValueOnce([APPROVER_1]);
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-agent-notify' }));
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-agent-notify' }]);

    await createActionIntent(makeAgentAuth(), agentInput());

    expect(notifyState.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: APPROVER_1,
        type: 'approval',
        link: '/approvals',
        message: expect.stringContaining('Patch agent'),
        dedupeKey: 'intent-approval:intent-agent-notify',
      }),
    );
    // Push is attempted for agent approvers too (headless: nobody is watching
    // a chat pane that would surface the proposal).
    expect(pushState.dispatchApprovalPushToTokens).toHaveBeenCalled();
  });
});

describe('createActionIntent — digest stability', () => {
  it('records the ORIGIN principal kind on the intent, not a derivation of it', async () => {
    // The release path must be able to prove what KIND of caller created this
    // intent. It cannot re-derive that later: requestedByUserId is written for
    // every intent (holding the key's CREATOR for API-key callers) and
    // requestingApiKeyId is never written at all.
    intentApproversState.resolveIntentApprovers.mockResolvedValueOnce([]);
    dbState.insertActionIntentsResults.push([makeIntentRow({ id: 'intent-h', status: 'cancelled', errorCode: 'no_eligible_approvers' })]);
    dbState.updateActionIntentsResults.push([makeIntentRow({ id: 'intent-h', status: 'cancelled', errorCode: 'no_eligible_approvers' })]);
    await createActionIntent(makeAuth(), baseInput({ idempotencyKey: 'key-human' }));

    expect(dbState.insertedActionIntentValues[0]?.originPrincipalKind).toBe('user_session');
    expect(dbState.insertedActionIntentValues[0]?.originPrincipalId).toBeNull();
  });

  it('records an api_key origin distinctly from a human, despite identical user.id', async () => {
    // The exact confusion this column exists to prevent: an API key carries
    // its creator's user id, so requestedByUserId is the SAME value in both
    // cases. Only the recorded origin distinguishes them.
    intentApproversState.resolveIntentApprovers.mockResolvedValueOnce([]);
    dbState.insertActionIntentsResults.push([makeIntentRow({ id: 'intent-k', status: 'cancelled', errorCode: 'no_eligible_approvers' })]);
    dbState.updateActionIntentsResults.push([makeIntentRow({ id: 'intent-k', status: 'cancelled', errorCode: 'no_eligible_approvers' })]);
    await createActionIntent(
      makeAuth({ principal: { kind: 'api_key', apiKeyId: 'key-77' } }),
      baseInput({ idempotencyKey: 'key-machine' }),
    );

    const row = dbState.insertedActionIntentValues[0];
    expect(row?.originPrincipalKind).toBe('api_key');
    expect(row?.originPrincipalId).toBe('key-77');
    // Same human id as the user_session case above — proving identity alone
    // cannot tell them apart.
    expect(row?.requestedByUserId).toBe(REQUESTER_ID);
  });

  it('computes the same argument_digest for canonically-equivalent input regardless of key order', async () => {
    const inputA = { b: 1, a: { z: 2, y: 3 } };
    const inputB = { a: { y: 3, z: 2 }, b: 1 };
    const expectedDigest = computeArgumentDigest(canonicalizeArguments(inputA));

    intentApproversState.resolveIntentApprovers.mockResolvedValueOnce([]);
    dbState.insertActionIntentsResults.push([makeIntentRow({ id: 'intent-a', status: 'cancelled', errorCode: 'no_eligible_approvers' })]);
    dbState.updateActionIntentsResults.push([makeIntentRow({ id: 'intent-a', status: 'cancelled', errorCode: 'no_eligible_approvers' })]);
    await createActionIntent(makeAuth(), baseInput({ input: inputA, idempotencyKey: 'key-a' }));
    expect(dbState.insertedActionIntentValues[0]?.argumentDigest).toBe(expectedDigest);

    intentApproversState.resolveIntentApprovers.mockResolvedValueOnce([]);
    dbState.insertActionIntentsResults.push([makeIntentRow({ id: 'intent-b', status: 'cancelled', errorCode: 'no_eligible_approvers' })]);
    dbState.updateActionIntentsResults.push([makeIntentRow({ id: 'intent-b', status: 'cancelled', errorCode: 'no_eligible_approvers' })]);
    await createActionIntent(makeAuth(), baseInput({ input: inputB, idempotencyKey: 'key-b' }));
    expect(dbState.insertedActionIntentValues[1]?.argumentDigest).toBe(expectedDigest);
  });
});

// ---------------------------------------------------------------------------
// Connection binding (M365 comms — design §5.2 sender pinning)
// ---------------------------------------------------------------------------

describe('createActionIntent binding', () => {
  it('persists connectionId and tenantId when binding is supplied', async () => {
    intentApproversState.resolveIntentApprovers.mockResolvedValueOnce([]);
    dbState.insertActionIntentsResults.push([makeIntentRow({ id: 'intent-bind', status: 'cancelled', errorCode: 'no_eligible_approvers' })]);
    dbState.updateActionIntentsResults.push([makeIntentRow({ id: 'intent-bind', status: 'cancelled', errorCode: 'no_eligible_approvers' })]);
    await createActionIntent(makeAuth(), baseInput({
      toolName: 'm365_send_mail',
      input: { to: ['a@example.com'], subject: 's', bodyText: 'b' },
      binding: {
        connectionId: '11111111-1111-4111-8111-111111111111',
        tenantId: '22222222-2222-4222-8222-222222222222',
      },
    }));
    const captured = dbState.insertedActionIntentValues[0];
    expect(captured?.connectionId).toBe('11111111-1111-4111-8111-111111111111');
    expect(captured?.tenantId).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('leaves both columns null when binding is omitted', async () => {
    intentApproversState.resolveIntentApprovers.mockResolvedValueOnce([]);
    dbState.insertActionIntentsResults.push([makeIntentRow({ id: 'intent-nobind', status: 'cancelled', errorCode: 'no_eligible_approvers' })]);
    dbState.updateActionIntentsResults.push([makeIntentRow({ id: 'intent-nobind', status: 'cancelled', errorCode: 'no_eligible_approvers' })]);
    await createActionIntent(makeAuth(), baseInput({
      toolName: 'execute_command',
      input: { command: 'whoami' },
    }));
    const captured = dbState.insertedActionIntentValues[0];
    expect(captured?.connectionId).toBeNull();
    expect(captured?.tenantId).toBeNull();
  });

  it('rejects a non-canonical tenantId before it reaches the uuid column', async () => {
    // action_intents.tenant_id is a Postgres `uuid`; an uppercase or malformed
    // GUID raises 22P02 at INSERT. Fail in the service with a typed error.
    await expect(createActionIntent(makeAuth(), baseInput({
      toolName: 'm365_send_mail',
      input: { to: ['a@example.com'], subject: 's', bodyText: 'b' },
      binding: {
        connectionId: '11111111-1111-4111-8111-111111111111',
        tenantId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      },
    }))).rejects.toThrow(/binding\.tenantId must be a canonical lowercase UUID/);
    expect(dbState.insertedActionIntentValues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('createActionIntent — idempotency', () => {
  it('returns the existing snapshot on a conflicting (org_id, idempotency_key) instead of creating a duplicate', async () => {
    // onConflictDoNothing().returning() → [] signals a conflict.
    dbState.insertActionIntentsResults.push([]);
    const existing = makeIntentRow({ id: 'existing-intent', status: 'approved' });
    dbState.selectActionIntentsResults.push([existing]);
    dbState.selectApprovalRequestsResults.push([{ id: 'approval-existing', userId: REQUESTER_ID }]);

    const snapshot = await createActionIntent(makeAuth(), baseInput({ idempotencyKey: 'fixed-key' }));

    expect(snapshot.id).toBe('existing-intent');
    expect(snapshot.status).toBe('approved');
    expect(snapshot.approvalRequestIds).toEqual(['approval-existing']);
    expect(snapshot.requesterApprovalRequestId).toBe('approval-existing');
    // No new approver resolution or fan-out happened.
    expect(dbState.insertedApprovalRequestsValues).toHaveLength(0);
    expect(dbState.insertedOutboxValues).toHaveLength(0);
    expect(permState.getUserPermissions).not.toHaveBeenCalled();
    // No push/audit noise on a pure replay.
    expect(pushState.dispatchApprovalPushToTokens).not.toHaveBeenCalled();
    expect(metricsMock.recordActionIntentEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Approver fan-out
// ---------------------------------------------------------------------------

describe('createActionIntent — approver fan-out', () => {
  it('excludes the requester from the fanned-out approval rows', async () => {
    dbState.insertActionIntentsResults.push([makeIntentRow()]);
    // resolveIntentApprovers returns the full eligible set (both axes,
    // possibly including the requester); createActionIntent excludes the
    // requester before fanning out.
    intentApproversState.resolveIntentApprovers.mockResolvedValueOnce([
      REQUESTER_ID,
      APPROVER_1,
      APPROVER_2,
    ]);
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-1' }, { id: 'approval-2' }]);

    const snapshot = await createActionIntent(makeAuth(), baseInput());

    expect(snapshot.status).toBe('pending_approval');
    expect(snapshot.approvalRequestIds).toEqual(['approval-1', 'approval-2']);
    expect(snapshot.requesterApprovalRequestId).toBeNull();
    const inserted = dbState.insertedApprovalRequestsValues[0] as Array<{ userId: string }>;
    expect(inserted.map((r) => r.userId)).toEqual([APPROVER_1, APPROVER_2]);
    expect(inserted.every((r) => r.userId !== REQUESTER_ID)).toBe(true);

    expect(dbState.insertedOutboxValues).toHaveLength(1);
    expect(dbState.insertedOutboxValues[0]).toMatchObject({
      intentId: 'intent-1',
      eventType: 'intent_created',
    });
    expect(metricsMock.recordActionIntentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'created', intentId: 'intent-1' }),
    );
  });

  it('creates a single sole-operator row when the requester is the only eligible approver', async () => {
    dbState.insertActionIntentsResults.push([makeIntentRow()]);
    // Only the requester is eligible → sole-operator single-row fan-out.
    intentApproversState.resolveIntentApprovers.mockResolvedValueOnce([REQUESTER_ID]);
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-solo' }]);

    const snapshot = await createActionIntent(makeAuth(), baseInput());

    expect(snapshot.status).toBe('pending_approval');
    expect(snapshot.approvalRequestIds).toEqual(['approval-solo']);
    expect(snapshot.requesterApprovalRequestId).toBe('approval-solo');
    const inserted = dbState.insertedApprovalRequestsValues[0] as Array<{ userId: string }>;
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.userId).toBe(REQUESTER_ID);
    expect(metricsMock.recordActionIntentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ soleOperator: true }) }),
    );
  });

  it('creates the intent then immediately cancels it when no one is eligible (not even the requester)', async () => {
    dbState.insertActionIntentsResults.push([makeIntentRow()]);
    // Nobody is eligible — not even the requester.
    intentApproversState.resolveIntentApprovers.mockResolvedValueOnce([]);
    dbState.updateActionIntentsResults.push([
      makeIntentRow({ status: 'cancelled', errorCode: 'no_eligible_approvers' }),
    ]);

    const snapshot = await createActionIntent(makeAuth(), baseInput());

    expect(snapshot.status).toBe('cancelled');
    expect(snapshot.errorCode).toBe('no_eligible_approvers');
    expect(snapshot.approvalRequestIds).toEqual([]);
    expect(snapshot.requesterApprovalRequestId).toBeNull();
    expect(dbState.insertedApprovalRequestsValues).toHaveLength(0);
    expect(dbState.updateActionIntentsSets[0]).toMatchObject({
      status: 'cancelled',
      errorCode: 'no_eligible_approvers',
    });
    // Outbox row is still written (creation itself still happened).
    expect(dbState.insertedOutboxValues).toHaveLength(1);
    // No push for a cancelled intent.
    expect(pushState.dispatchApprovalPushToTokens).not.toHaveBeenCalled();
    expect(metricsMock.recordActionIntentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'cancelled',
        details: expect.objectContaining({ errorCode: 'no_eligible_approvers' }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Wave 5 Part A (#3827) — policy_decision_state stamping. resolvePolicyDecisionState
// is a PR-A stub that always returns 'human_required'; these tests pin that the
// column lands correctly on the INSERT itself (not a follow-up UPDATE) and that
// an idempotent replay never touches an existing row's state. Every fan-out
// behavior test above/below this block passing UNCHANGED is the inertness proof
// for the runHumanFanout extraction — this block only covers the new column.
// ---------------------------------------------------------------------------

describe('createActionIntent — policy decision state (Wave 5 Part A, inert)', () => {
  it('stamps policyDecisionState human_required as part of the INSERT values on a new intent', async () => {
    dbState.insertActionIntentsResults.push([makeIntentRow()]);
    intentApproversState.resolveIntentApprovers.mockResolvedValueOnce([REQUESTER_ID]);
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-solo' }]);

    await createActionIntent(makeAuth(), baseInput());

    expect(dbState.insertedActionIntentValues).toHaveLength(1);
    expect(dbState.insertedActionIntentValues[0]?.policyDecisionState).toBe('human_required');
  });

  it('still fans out to approvers (unconditional today — the stub always defers to human_required)', async () => {
    dbState.insertActionIntentsResults.push([makeIntentRow()]);
    intentApproversState.resolveIntentApprovers.mockResolvedValueOnce([REQUESTER_ID, APPROVER_1]);
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-1' }]);

    const snapshot = await createActionIntent(makeAuth(), baseInput());

    expect(snapshot.status).toBe('pending_approval');
    expect(dbState.insertedApprovalRequestsValues).toHaveLength(1);
  });

  it('does not touch policyDecisionState on an idempotent replay — no second insert, no update', async () => {
    // onConflictDoNothing().returning() → [] signals a conflict; the existing
    // row (with whatever state it was originally stamped with) is returned
    // as-is. This is the only path resolvePolicyDecisionState's output never
    // reaches — proving the computed value from THIS call is simply discarded.
    dbState.insertActionIntentsResults.push([]);
    const existing = makeIntentRow({ id: 'existing-intent', status: 'approved' });
    dbState.selectActionIntentsResults.push([existing]);
    dbState.selectApprovalRequestsResults.push([{ id: 'approval-existing', userId: REQUESTER_ID }]);

    const snapshot = await createActionIntent(makeAuth(), baseInput({ idempotencyKey: 'fixed-key' }));

    expect(snapshot.id).toBe('existing-intent');
    // The INSERT attempt still carries the computed value in its `.values()`
    // call (Postgres discards it on conflict) — but no UPDATE ever runs, and
    // no second insert happens.
    expect(dbState.insertedActionIntentValues).toHaveLength(1);
    expect(dbState.updateActionIntentsSets).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Wave 5 Part B (#3827) — the REAL resolvePolicyDecisionState + post-commit
// trigger. The suite above (Part A, inert) covers flag-OFF byte-identical
// behavior implicitly (envMock.policyDecideEnabled defaults false in
// beforeEach) — these tests cover flag-ON.
// ---------------------------------------------------------------------------

describe('createActionIntent — resolvePolicyDecisionState (Wave 5 Part B, real)', () => {
  it('flag on + agent-originated + supervised -> unattempted, skips fan-out, still writes outbox, triggers the attempt post-commit', async () => {
    envMock.policyDecideEnabled.mockReturnValue(true);
    guardrailMock.checkGuardrails.mockReturnValue({
      tier: 3,
      allowed: true,
      requiresApproval: true,
      description: 'Manage services on a device',
      approvalScope: 'supervised',
    });
    // Task 5 (#3827): policy-decide requires the run's OWN policy snapshot to
    // read mode 'act' — makeRunRow's default ('shadow') is deliberately used
    // by every other test in this file, so this is the one case that opts in.
    queueAgentContext({ run: agentRunRowWithMode('act') });
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-unattempted' }));

    const snap = await createActionIntent(makeAgentAuth(), agentInput());

    expect(dbState.insertedActionIntentValues[0]?.policyDecisionState).toBe('unattempted');
    expect(snap.status).toBe('pending_approval');
    // No human fan-out: resolveAgentIntentApprovers/resolveIntentTargetScope
    // are never even consulted for the fan-out decision when the state is
    // 'unattempted' (they ARE still called upstream for target validation —
    // see intentService.ts — but no approval_requests rows are inserted).
    expect(dbState.insertedApprovalRequestsValues).toHaveLength(0);
    // Outbox intent_created is unconditional regardless of decisionState.
    expect(dbState.insertedOutboxValues).toHaveLength(1);
    expect(dbState.insertedOutboxValues[0]).toMatchObject({ intentId: 'intent-unattempted' });

    await vi.waitFor(() => {
      expect(policyDecideMock.attemptPolicyDecision).toHaveBeenCalledWith('intent-unattempted');
    });
  });

  it('flag on + agent-originated + four_eyes -> human_required, ordinary fan-out runs, no attempt triggered', async () => {
    envMock.policyDecideEnabled.mockReturnValue(true);
    guardrailMock.checkGuardrails.mockReturnValue({
      tier: 3,
      allowed: true,
      requiresApproval: true,
      description: 'Manage services on a device',
      approvalScope: 'four_eyes',
    });
    queueAgentContext();
    intentApproversState.resolveIntentApprovers.mockResolvedValueOnce([APPROVER_1]);
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-fe-agent' }));
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-fe-agent' }]);

    const snap = await createActionIntent(makeAgentAuth(), agentInput());

    expect(dbState.insertedActionIntentValues[0]?.policyDecisionState).toBe('human_required');
    expect(snap.status).toBe('pending_approval');
    expect(dbState.insertedApprovalRequestsValues).toHaveLength(1);
    expect(policyDecideMock.attemptPolicyDecision).not.toHaveBeenCalled();
  });

  it("flag on + agent-originated + supervised + run's mode is 'shadow' (not 'act') -> human_required, ordinary fan-out runs, no attempt triggered (locked quorum decision, Task 5 #3827)", async () => {
    // The primary enforcement point is policyDecide.ts's own live re-check
    // (defense in depth, since the operator can flip act->shadow AFTER
    // creation); this is the creation-time half — an intent whose run was
    // never even in act mode must never reach 'unattempted' in the first
    // place. makeRunRow's default mode is 'shadow', so this needs no override.
    envMock.policyDecideEnabled.mockReturnValue(true);
    guardrailMock.checkGuardrails.mockReturnValue({
      tier: 3,
      allowed: true,
      requiresApproval: true,
      description: 'Manage services on a device',
      approvalScope: 'supervised',
    });
    queueAgentContext();
    intentApproversState.resolveAgentIntentApprovers.mockResolvedValueOnce([APPROVER_1]);
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-shadow-mode' }));
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-shadow-mode' }]);

    const snap = await createActionIntent(makeAgentAuth(), agentInput());

    expect(dbState.insertedActionIntentValues[0]?.policyDecisionState).toBe('human_required');
    expect(snap.status).toBe('pending_approval');
    expect(dbState.insertedApprovalRequestsValues).toHaveLength(1);
    expect(policyDecideMock.attemptPolicyDecision).not.toHaveBeenCalled();
  });

  it('flag on + human-originated (chat) + supervised -> human_required (agent-origination is required, not just scope)', async () => {
    envMock.policyDecideEnabled.mockReturnValue(true);
    guardrailMock.checkGuardrails.mockReturnValue({
      tier: 3,
      allowed: true,
      requiresApproval: true,
      description: 'Run a script on one or more devices',
      approvalScope: 'supervised',
    });
    intentApproversState.resolveIntentApprovers.mockResolvedValueOnce([]);
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-human-sv' }));
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-human-sv' }]);

    await createActionIntent(makeAuth(), baseInput());

    expect(dbState.insertedActionIntentValues[0]?.policyDecisionState).toBe('human_required');
    expect(policyDecideMock.attemptPolicyDecision).not.toHaveBeenCalled();
  });

  it('flag off + agent-originated + supervised -> human_required, byte-identical to Part A (attempt never triggered)', async () => {
    envMock.policyDecideEnabled.mockReturnValue(false);
    guardrailMock.checkGuardrails.mockReturnValue({
      tier: 3,
      allowed: true,
      requiresApproval: true,
      description: 'Manage services on a device',
      approvalScope: 'supervised',
    });
    queueAgentContext();
    intentApproversState.resolveAgentIntentApprovers.mockResolvedValueOnce([APPROVER_1]);
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-flag-off' }));
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-flag-off' }]);

    await createActionIntent(makeAgentAuth(), agentInput());

    expect(dbState.insertedActionIntentValues[0]?.policyDecisionState).toBe('human_required');
    expect(dbState.insertedApprovalRequestsValues).toHaveLength(1);
    expect(policyDecideMock.attemptPolicyDecision).not.toHaveBeenCalled();
  });

  it('does not trigger an attempt on an idempotent replay, even with the flag on', async () => {
    envMock.policyDecideEnabled.mockReturnValue(true);
    guardrailMock.checkGuardrails.mockReturnValue({
      tier: 3,
      allowed: true,
      requiresApproval: true,
      description: 'Manage services on a device',
      approvalScope: 'supervised',
    });
    dbState.insertActionIntentsResults.push([]);
    const agentArgs = { deviceId: DEVICE_ID, action: 'restart', serviceName: 'spooler' };
    const existing = makeIntentRow({
      id: 'existing-unattempted',
      source: 'ai_agent',
      requestedByUserId: null,
      requestingAgentRunId: RUN_ID,
      actionName: 'manage_services',
      arguments: agentArgs,
      argumentDigest: computeArgumentDigest(canonicalizeArguments(agentArgs)),
      approvalScope: 'supervised',
      policyDecisionState: 'unattempted',
    });
    dbState.selectActionIntentsResults.push([existing]);
    dbState.selectApprovalRequestsResults.push([]);
    queueAgentContext();

    const snap = await createActionIntent(makeAgentAuth(), agentInput({ idempotencyKey: 'fixed-agent-key' }));

    expect(snap.id).toBe('existing-unattempted');
    expect(policyDecideMock.attemptPolicyDecision).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Wave 5 Part B (#3827) — runDeferredHumanFanout, the unattempted ->
// human_required degrade path attemptPolicyDecision (policyDecide.ts) calls
// for every deterministic refusal. Unit-tested directly here (not only
// through createActionIntent) since it is its own exported entry point with
// its own CAS/idempotence contract.
// ---------------------------------------------------------------------------

describe('runDeferredHumanFanout', () => {
  function queuedDeferredIntent(overrides?: Record<string, unknown>) {
    return makeIntentRow({
      id: 'intent-deferred',
      source: 'ai_agent',
      requestedByUserId: null,
      requestingAgentRunId: RUN_ID,
      approvalScope: 'supervised',
      policyDecisionState: 'unattempted',
      requestingClientLabel: 'Patch agent',
      ...overrides,
    });
  }

  it('CASes unattempted -> human_required and fans out to action-and-target-eligible humans', async () => {
    dbState.selectActionIntentsResults.push([queuedDeferredIntent()]);
    dbState.selectAgentRunsResults.push([makeRunRow()]);
    intentApproversState.resolveIntentTargetScope.mockResolvedValueOnce({ kind: 'devices', siteIds: [SITE_ID] });
    intentApproversState.resolveAgentIntentApprovers.mockResolvedValueOnce([APPROVER_1, APPROVER_2]);
    dbState.updateActionIntentsResults.push([
      queuedDeferredIntent({ policyDecisionState: 'human_required' }),
    ]);
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-d1' }, { id: 'approval-d2' }]);

    await runDeferredHumanFanout('intent-deferred');

    expect(dbState.updateActionIntentsSets[0]).toEqual({ policyDecisionState: 'human_required' });
    const insertedRows = dbState.insertedApprovalRequestsValues[0] as Array<{ userId: string }>;
    expect(insertedRows.map((r) => r.userId)).toEqual([APPROVER_1, APPROVER_2]);
    expect(notifyState.createNotification).toHaveBeenCalledTimes(2);
    expect(metricsMock.recordActionIntentEvent).not.toHaveBeenCalled();
  });

  it('cancels no_eligible_approvers when nobody is eligible, and notifies nobody', async () => {
    dbState.selectActionIntentsResults.push([queuedDeferredIntent()]);
    dbState.selectAgentRunsResults.push([makeRunRow()]);
    intentApproversState.resolveIntentTargetScope.mockResolvedValueOnce({ kind: 'devices', siteIds: [SITE_ID] });
    intentApproversState.resolveAgentIntentApprovers.mockResolvedValueOnce([]);
    dbState.updateActionIntentsResults.push([
      queuedDeferredIntent({ policyDecisionState: 'human_required' }),
    ]);
    dbState.updateActionIntentsResults.push([
      queuedDeferredIntent({ status: 'cancelled', errorCode: 'no_eligible_approvers' }),
    ]);

    await runDeferredHumanFanout('intent-deferred');

    expect(dbState.insertedApprovalRequestsValues).toHaveLength(0);
    expect(notifyState.createNotification).not.toHaveBeenCalled();
    expect(metricsMock.recordActionIntentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'cancelled',
        actorType: 'ai_agent',
        details: expect.objectContaining({ errorCode: 'no_eligible_approvers' }),
      }),
    );
  });

  it('double-attempt idempotence: a lost CAS writes nothing and notifies nobody', async () => {
    dbState.selectActionIntentsResults.push([queuedDeferredIntent()]);
    dbState.selectAgentRunsResults.push([makeRunRow()]);
    intentApproversState.resolveIntentTargetScope.mockResolvedValueOnce({ kind: 'devices', siteIds: [SITE_ID] });
    intentApproversState.resolveAgentIntentApprovers.mockResolvedValueOnce([APPROVER_1]);
    // Empty .returning() — a concurrent caller already won the CAS.
    dbState.updateActionIntentsResults.push([]);

    await runDeferredHumanFanout('intent-deferred');

    expect(dbState.insertedApprovalRequestsValues).toHaveLength(0);
    expect(notifyState.createNotification).not.toHaveBeenCalled();
    expect(metricsMock.recordActionIntentEvent).not.toHaveBeenCalled();
  });

  it('no-ops when the intent no longer exists', async () => {
    dbState.selectActionIntentsResults.push([]);

    await runDeferredHumanFanout('intent-gone');

    expect(dbState.updateActionIntentsSets).toHaveLength(0);
    expect(dbState.insertedApprovalRequestsValues).toHaveLength(0);
  });

  it('no-ops on a non-agent-originated intent (structural guard)', async () => {
    dbState.selectActionIntentsResults.push([
      queuedDeferredIntent({ requestingAgentRunId: null, requestedByUserId: REQUESTER_ID }),
    ]);

    await runDeferredHumanFanout('intent-deferred');

    expect(dbState.updateActionIntentsSets).toHaveLength(0);
    expect(dbState.insertedApprovalRequestsValues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tier3 supervised/four_eyes split — scope-aware creation, fan-out, deadlines
// (spec docs/superpowers/specs/ai-mcp/2026-08-05-tier3-supervised-four-eyes-split-design.md)
// ---------------------------------------------------------------------------

describe('createActionIntent — supervised/four_eyes scope', () => {
  it('supervised intent fans out a single requester-owned row and skips push', async () => {
    guardrailMock.checkGuardrails.mockReturnValue({
      tier: 3,
      allowed: true,
      requiresApproval: true,
      description: 'Run a script on one or more devices',
      approvalScope: 'supervised',
    });
    // Nobody is eligible — not even the requester (no approvals:decide at
    // all). Supervised must still create the requester's own row: it does
    // not require approvals:decide.
    intentApproversState.resolveIntentApprovers.mockResolvedValueOnce([]);
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-supervised' }));
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-supervised' }]);

    const snap = await createActionIntent(makeAuth(), baseInput({ idempotencyKey: 'key-supervised' }));

    expect(snap.status).toBe('pending_approval');
    expect(snap.requesterApprovalRequestId).toBeDefined();
    expect(snap.requesterApprovalRequestId).toBe('approval-supervised');
    expect(snap.fanOutUserIds).toEqual([REQUESTER_ID]);
    expect(pushState.dispatchApprovalPushToTokens).not.toHaveBeenCalled();
  });

  // Sole-operator audit-signal scope gate: a supervised intent's single
  // fan-out row is ALWAYS requester-owned (Task 4's short-circuit), which is
  // the ordinary supervised shape, not a four_eyes "only eligible approver
  // happened to be the requester" self-approval. `details.soleOperator` on
  // the `created` event must stay four_eyes-only or it pollutes the
  // sole-operator audit signal with every supervised creation — see the
  // sibling four_eyes assertion below ('four_eyes with no other active
  // approver keeps sole-operator fallback') for the case this must NOT be
  // confused with.
  it('never sets details.soleOperator on a supervised intent creation, even though the row is requester-owned', async () => {
    guardrailMock.checkGuardrails.mockReturnValue({
      tier: 3,
      allowed: true,
      requiresApproval: true,
      description: 'Run a script on one or more devices',
      approvalScope: 'supervised',
    });
    intentApproversState.resolveIntentApprovers.mockResolvedValueOnce([]);
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-supervised-sole' }));
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-supervised-sole' }]);

    await createActionIntent(makeAuth(), baseInput({ idempotencyKey: 'key-supervised-sole' }));

    expect(metricsMock.recordActionIntentEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'created',
        details: expect.objectContaining({ soleOperator: false }),
      }),
    );
  });

  it('four_eyes chat intent gets a 60-minute approval deadline; supervised keeps 5', async () => {
    guardrailMock.checkGuardrails.mockReturnValue({
      tier: 3,
      allowed: true,
      requiresApproval: true,
      description: 'Run a script on one or more devices',
      approvalScope: 'four_eyes',
    });
    intentApproversState.resolveIntentApprovers.mockResolvedValueOnce([REQUESTER_ID]);
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-fe-deadline' }));
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-fe-deadline' }]);
    const fe = await createActionIntent(
      makeAuth(),
      baseInput({ source: 'chat', idempotencyKey: 'key-fe-deadline' }),
    );

    guardrailMock.checkGuardrails.mockReturnValue({
      tier: 3,
      allowed: true,
      requiresApproval: true,
      description: 'Run a script on one or more devices',
      approvalScope: 'supervised',
    });
    intentApproversState.resolveIntentApprovers.mockResolvedValueOnce([]);
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-sv-deadline' }));
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-sv-deadline' }]);
    const sv = await createActionIntent(
      makeAuth(),
      baseInput({ source: 'chat', idempotencyKey: 'key-sv-deadline' }),
    );

    expect(msUntil(fe.approvalExpiresAt!)).toBeCloseTo(60 * 60 * 1000, -4);
    expect(msUntil(sv.approvalExpiresAt!)).toBeCloseTo(5 * 60 * 1000, -4);
  });

  it('THE FIX: an approver with NO phone is still notified in-app', async () => {
    // Before wave 2 the only approver channel was mobile push, and
    // getUserPushTokens reads mobile_devices exclusively — so an approver who
    // had never enrolled a phone was notified by NOTHING, with the push
    // failure swallowed to console.error. That is the bug this wave fixes.
    guardrailMock.checkGuardrails.mockReturnValue({
      tier: 3,
      allowed: true,
      requiresApproval: true,
      description: 'Run a script on one or more devices',
      approvalScope: 'four_eyes',
    });
    intentApproversState.resolveIntentApprovers.mockResolvedValueOnce(['approver-1']);
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-fe-notify' }));
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-fe-notify' }]);
    // No enrolled device: zero tokens, exactly the phoneless approver's case.
    pushState.getUserPushTokens.mockResolvedValueOnce([]);

    await createActionIntent(makeAuth(), baseInput({ idempotencyKey: 'key-fe-notify' }));

    expect(notifyState.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'approver-1',
        type: 'approval',
        link: '/approvals',
        // Idempotent across outbox/BullMQ redelivery.
        dedupeKey: 'intent-approval:intent-fe-notify',
      }),
    );
  });

  it('notifies in-app even when the push dispatch throws', async () => {
    // The in-app row must not be downstream of the phone lookup — that is what
    // made the old path fail silently for the people it most affected.
    guardrailMock.checkGuardrails.mockReturnValue({
      tier: 3,
      allowed: true,
      requiresApproval: true,
      description: 'Run a script on one or more devices',
      approvalScope: 'four_eyes',
    });
    intentApproversState.resolveIntentApprovers.mockResolvedValueOnce(['approver-1']);
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-fe-pushfail' }));
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-fe-pushfail' }]);
    pushState.getUserPushTokens.mockRejectedValueOnce(new Error('mobile_devices unreachable'));

    await expect(
      createActionIntent(makeAuth(), baseInput({ idempotencyKey: 'key-fe-pushfail' })),
    ).resolves.toBeTruthy();

    expect(notifyState.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'approver-1', type: 'approval' }),
    );
  });

  it('a failed in-app notification never fails intent creation', async () => {
    guardrailMock.checkGuardrails.mockReturnValue({
      tier: 3,
      allowed: true,
      requiresApproval: true,
      description: 'Run a script on one or more devices',
      approvalScope: 'four_eyes',
    });
    intentApproversState.resolveIntentApprovers.mockResolvedValueOnce(['approver-1']);
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-fe-notiffail' }));
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-fe-notiffail' }]);
    notifyState.createNotification.mockRejectedValueOnce(new Error('notify boom'));

    const snapshot = await createActionIntent(
      makeAuth(),
      baseInput({ idempotencyKey: 'key-fe-notiffail' }),
    );

    expect(snapshot.status).toBe('pending_approval');
    // Push still attempted — one channel failing must not suppress the other.
    expect(pushState.dispatchApprovalPushToTokens).toHaveBeenCalled();
  });

  it('supervised intents notify NOBODY in-app, same as push', async () => {
    // The sole row belongs to the requester, who is already watching the chat
    // response that created it.
    guardrailMock.checkGuardrails.mockReturnValue({
      tier: 3,
      allowed: true,
      requiresApproval: true,
      description: 'Run a script on one or more devices',
      approvalScope: 'supervised',
    });
    intentApproversState.resolveIntentApprovers.mockResolvedValueOnce([]);
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-sv-nonotify' }));
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-sv-nonotify' }]);

    await createActionIntent(makeAuth(), baseInput({ idempotencyKey: 'key-sv-nonotify' }));

    expect(notifyState.createNotification).not.toHaveBeenCalled();
    expect(pushState.dispatchApprovalPushToTokens).not.toHaveBeenCalled();
  });

  it('four_eyes with no other active approver keeps sole-operator fallback', async () => {
    guardrailMock.checkGuardrails.mockReturnValue({
      tier: 3,
      allowed: true,
      requiresApproval: true,
      description: 'Run a script on one or more devices',
      approvalScope: 'four_eyes',
    });
    // Only the requester is eligible → sole-operator single-row fan-out,
    // same as the pre-split behavior (existing "creates a single
    // sole-operator row" test), now asserted explicitly under four_eyes.
    intentApproversState.resolveIntentApprovers.mockResolvedValueOnce([REQUESTER_ID]);
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-fe-solo' }));
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-fe-solo' }]);

    const snapshot = await createActionIntent(makeAuth(), baseInput({ idempotencyKey: 'key-fe-solo' }));

    expect(snapshot.status).toBe('pending_approval');
    expect(snapshot.approvalRequestIds).toEqual(['approval-fe-solo']);
    expect(snapshot.requesterApprovalRequestId).toBe('approval-fe-solo');
    expect(snapshot.fanOutUserIds).toEqual([REQUESTER_ID]);
    const inserted = dbState.insertedApprovalRequestsValues[0] as Array<{ userId: string }>;
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.userId).toBe(REQUESTER_ID);
    expect(metricsMock.recordActionIntentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ soleOperator: true }) }),
    );
  });

  it('persists approvalScope and classificationVersion on the inserted row', async () => {
    guardrailMock.checkGuardrails.mockReturnValue({
      tier: 3,
      allowed: true,
      requiresApproval: true,
      description: 'Run a script on one or more devices',
      approvalScope: 'supervised',
    });
    intentApproversState.resolveIntentApprovers.mockResolvedValueOnce([]);
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-persist' }));
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-persist' }]);

    await createActionIntent(makeAuth(), baseInput({ idempotencyKey: 'key-persist' }));

    const captured = dbState.insertedActionIntentValues[0];
    expect(captured?.approvalScope).toBe('supervised');
    expect(captured?.classificationVersion).toBe(2);
    // Dual-write compat: legacy `expiresAt` still carries the same value as
    // the new `approvalExpiresAt` column (Plan 3 removes the legacy write).
    expect(captured?.expiresAt).toEqual(captured?.approvalExpiresAt);
  });

  it('defaults an unclassified tool (no guardrail.approvalScope) to four_eyes, never the weaker supervised path', async () => {
    guardrailMock.checkGuardrails.mockReturnValue({
      tier: 3,
      allowed: true,
      requiresApproval: true,
      description: 'Run a script on one or more devices',
      // approvalScope intentionally omitted.
    });
    intentApproversState.resolveIntentApprovers.mockResolvedValueOnce([REQUESTER_ID]);
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-unclassified' }));
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-unclassified' }]);

    await createActionIntent(makeAuth(), baseInput({ idempotencyKey: 'key-unclassified' }));

    expect(dbState.insertedActionIntentValues[0]?.approvalScope).toBe('four_eyes');
  });
});

// ---------------------------------------------------------------------------
// Effect-digest pinning wiring (spec
// docs/superpowers/specs/ai-mcp/2026-08-05-tier3-supervised-four-eyes-split-design.md
// §4.1). computeEffectDigestOutcome itself is unit-tested in
// effectDigest.test.ts; this suite only asserts createActionIntent CALLS it
// correctly — for EVERY tier-3 intent regardless of approval scope, with the
// tool name/args/db it's supposed to — persists a digest ONLY on `pinned`,
// and makes the two `unresolved` outcomes observable via an audit event.
// ---------------------------------------------------------------------------

describe('createActionIntent — effect-digest pinning wiring', () => {
  const fourEyesGuardrail = {
    tier: 3,
    allowed: true,
    requiresApproval: true,
    description: 'Run a script on one or more devices',
    approvalScope: 'four_eyes' as const,
  };
  const supervisedGuardrail = { ...fourEyesGuardrail, approvalScope: 'supervised' as const };

  it('computes and persists the effect digest for a four_eyes intent', async () => {
    guardrailMock.checkGuardrails.mockReturnValue(fourEyesGuardrail);
    intentApproversState.resolveIntentApprovers.mockResolvedValueOnce([REQUESTER_ID]);
    effectDigestState.computeEffectDigestOutcome.mockResolvedValueOnce({
      kind: 'pinned',
      digest: 'd'.repeat(64),
    });
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-fe-digest' }));
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-fe-digest' }]);

    await createActionIntent(makeAuth(), baseInput({ idempotencyKey: 'key-fe-digest' }));

    expect(computeEffectDigestOutcome).toHaveBeenCalledWith(
      'run_script',
      { scriptId: 'script-1', deviceIds: ['device-1'] },
      db,
    );
    expect(dbState.insertedActionIntentValues[0]?.effectDigest).toBe('d'.repeat(64));
  });

  // THE regression this guards: pinning used to be gated on
  // `approvalScope === 'four_eyes'`, which made effectDigest.ts's own
  // motivating resolver (run_script — a SUPERVISED tool) unreachable dead
  // code and left the ~10-minute release lease open to a script-body edit.
  it('ALSO computes and persists the effect digest for a SUPERVISED intent (pinning is scope-independent)', async () => {
    guardrailMock.checkGuardrails.mockReturnValue(supervisedGuardrail);
    intentApproversState.resolveIntentApprovers.mockResolvedValueOnce([]);
    effectDigestState.computeEffectDigestOutcome.mockResolvedValueOnce({
      kind: 'pinned',
      digest: 'e'.repeat(64),
    });
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-sv-digest' }));
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-sv-digest' }]);

    await createActionIntent(makeAuth(), baseInput({ idempotencyKey: 'key-sv-digest' }));

    expect(computeEffectDigestOutcome).toHaveBeenCalledWith(
      'run_script',
      { scriptId: 'script-1', deviceIds: ['device-1'] },
      db,
    );
    expect(dbState.insertedActionIntentValues[0]?.effectDigest).toBe('e'.repeat(64));
  });

  it('stores a null effect digest for a tool/action with no resolver, and audits nothing', async () => {
    guardrailMock.checkGuardrails.mockReturnValue({ ...fourEyesGuardrail, description: 'Send an email' });
    intentApproversState.resolveIntentApprovers.mockResolvedValueOnce([REQUESTER_ID]);
    // Default beforeEach mock already resolves `not_applicable`.
    dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: 'intent-fe-unpinnable' }));
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-fe-unpinnable' }]);

    await createActionIntent(
      makeAuth(),
      baseInput({ toolName: 'm365_send_mail', input: { to: ['a@example.com'] }, idempotencyKey: 'key-fe-unpinnable' }),
    );

    expect(computeEffectDigestOutcome).toHaveBeenCalledWith('m365_send_mail', { to: ['a@example.com'] }, db);
    expect(dbState.insertedActionIntentValues[0]?.effectDigest).toBeNull();
    // `not_applicable` is the expected, correct case — it must NOT pollute the
    // unpinned signal.
    expect(metricsMock.recordActionIntentEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'effect_digest_unpinned' }),
    );
  });

  // The observability gap this closes: `unresolved` intents SHOULD have been
  // pinned and silently weren't, and the stored NULL is byte-identical to the
  // `not_applicable` case, so the audit event is the only thing that can
  // distinguish (and therefore count/alert on) them.
  for (const reason of ['missing_arg', 'target_absent'] as const) {
    it(`stores a null digest and audits effect_digest_unpinned when the resolver reports ${reason}`, async () => {
      guardrailMock.checkGuardrails.mockReturnValue(fourEyesGuardrail);
      intentApproversState.resolveIntentApprovers.mockResolvedValueOnce([REQUESTER_ID]);
      effectDigestState.computeEffectDigestOutcome.mockResolvedValueOnce({ kind: 'unresolved', reason });
      dbState.insertActionIntentsResults.push(echoInsertedIntent({ id: `intent-unresolved-${reason}` }));
      dbState.insertApprovalRequestsResults.push([{ id: `approval-unresolved-${reason}` }]);

      await createActionIntent(makeAuth(), baseInput({ idempotencyKey: `key-unresolved-${reason}` }));

      expect(dbState.insertedActionIntentValues[0]?.effectDigest).toBeNull();
      expect(metricsMock.recordActionIntentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          intentId: `intent-unresolved-${reason}`,
          actionName: 'run_script',
          outcome: 'effect_digest_unpinned',
          actorId: REQUESTER_ID,
          details: expect.objectContaining({ reason, approvalScope: 'four_eyes' }),
        }),
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Connection-hold regression (#1105 class) — approver resolution must not
// run inside the write transaction.
// ---------------------------------------------------------------------------

type MockLike = { mock: { calls: unknown[][]; invocationCallOrder: number[] } };

describe('createActionIntent — connection-hold (#1105)', () => {
  it('resolves the eligible-approver set before the write transaction inserts the intent row', async () => {
    dbState.insertActionIntentsResults.push([makeIntentRow()]);
    // Approver resolution now lives entirely in resolveIntentApprovers, which
    // opens its OWN system DB context (and closes it) before returning — so
    // intentService never holds a pooled connection across the membership
    // reads. This mock stands in for that resolver; the #1105 property we
    // assert is that it completes before the creation write transaction opens.
    intentApproversState.resolveIntentApprovers.mockResolvedValueOnce([
      REQUESTER_ID,
      APPROVER_1,
      APPROVER_2,
    ]);
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-1' }, { id: 'approval-2' }]);

    await createActionIntent(makeAuth(), baseInput());

    // Resolver ran exactly once, before the intent-row insert (invocationCallOrder
    // is a global counter shared across every vi.fn — safe to compare directly).
    const resolverMock = intentApproversState.resolveIntentApprovers as unknown as MockLike;
    expect(resolverMock.mock.invocationCallOrder).toHaveLength(1);
    const resolverOrder = resolverMock.mock.invocationCallOrder[0]!;

    const insertMock = db.insert as unknown as MockLike;
    const intentInsertIndex = insertMock.mock.calls.findIndex((call) => call[0] === schema.actionIntentsTbl);
    expect(intentInsertIndex).toBeGreaterThanOrEqual(0);
    const intentInsertOrder = insertMock.mock.invocationCallOrder[intentInsertIndex]!;
    expect(resolverOrder).toBeLessThan(intentInsertOrder);

    // Fan-out outcome itself is unchanged.
    const inserted = dbState.insertedApprovalRequestsValues[0] as Array<{ userId: string }>;
    expect(inserted.map((r) => r.userId)).toEqual([APPROVER_1, APPROVER_2]);
  });
});

// ---------------------------------------------------------------------------
// Outbox (same-transaction write)
// ---------------------------------------------------------------------------

describe('createActionIntent — transactional outbox', () => {
  it('writes exactly one intent_created outbox row carrying only ids, no argument content', async () => {
    dbState.insertActionIntentsResults.push([makeIntentRow()]);
    intentApproversState.resolveIntentApprovers.mockResolvedValueOnce([APPROVER_1]);
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-1' }]);

    await createActionIntent(makeAuth(), baseInput());

    expect(dbState.insertedOutboxValues).toHaveLength(1);
    const payload = dbState.insertedOutboxValues[0];
    expect(payload).toMatchObject({ intentId: 'intent-1', eventType: 'intent_created' });
    expect(payload?.payload).toEqual({ intentId: 'intent-1', orgId: ORG_ID });
  });
});

// ---------------------------------------------------------------------------
// transitionIntent CAS primitive
// ---------------------------------------------------------------------------

describe('transitionIntent', () => {
  it('returns true when the CAS update affects a row', async () => {
    dbState.updateActionIntentsResults.push([{ id: 'intent-1' }]);
    const ok = await transitionIntent('intent-1', 'pending_approval', 'approved');
    expect(ok).toBe(true);
    expect(dbState.updateActionIntentsSets[0]).toMatchObject({ status: 'approved' });
  });

  it('returns false (not throw) on a lost race — zero rows affected', async () => {
    dbState.updateActionIntentsResults.push([]);
    await expect(transitionIntent('intent-1', 'pending_approval', 'approved')).resolves.toBe(false);
  });

  it('accepts an array of starting states', async () => {
    dbState.updateActionIntentsResults.push([{ id: 'intent-1' }]);
    const ok = await transitionIntent('intent-1', ['pending_approval', 'approved'], 'cancelled');
    expect(ok).toBe(true);
  });

  it('applies a lifecycle patch alongside the status change', async () => {
    dbState.updateActionIntentsResults.push([{ id: 'intent-1' }]);
    await transitionIntent('intent-1', 'approved', 'executing', { executedAt: new Date('2026-01-01') });
    expect(dbState.updateActionIntentsSets[0]).toMatchObject({
      status: 'executing',
      executedAt: new Date('2026-01-01'),
    });
  });

  describe('requireNotExpired (deadline-phase CAS)', () => {
    const sqlConditionOf = (index = 0) => {
      const whereArgs = (dbState.updateActionIntentsWheres[index] as { args: unknown[] }).args;
      return whereArgs.find(
        (c): c is { op: string; text: string } =>
          typeof c === 'object' && c !== null && (c as { op?: string }).op === 'sql',
      );
    };

    it("'release' folds COALESCE(release_by, expires_at) > now() into the where clause — not approval_expires_at", async () => {
      dbState.updateActionIntentsResults.push([{ id: 'intent-1' }]);
      await transitionIntent(
        'intent-1',
        'approved',
        'executing',
        { executedAt: null },
        { requireNotExpired: 'release' },
      );

      const sqlCondition = sqlConditionOf();
      expect(sqlCondition).toBeDefined();
      // The 59:59 trap: this MUST be release_by (falling back to
      // expires_at), never approval_expires_at — approval_expires_at stops
      // governing an intent the moment it is approved (see
      // jobs/intentExpiryReaper.ts's header).
      expect(sqlCondition!.text).toContain('COALESCE(release_by, expires_at)');
      expect(sqlCondition!.text).not.toContain('approval_expires_at');
      expect(sqlCondition!.text).toContain('> now()');
    });

    // Backward compatibility: the two call sites that still pass the old
    // boolean live in files owned by another workstream
    // (jobs/intentReleaseWorker.ts, services/aiAgentSdk.ts). `true` must keep
    // meaning exactly what it meant before — the RELEASE deadline.
    it("accepts the deprecated boolean `true` as an alias for 'release'", async () => {
      dbState.updateActionIntentsResults.push([{ id: 'intent-1' }]);
      await transitionIntent('intent-1', 'approved', 'executing', { executedAt: null }, { requireNotExpired: true });

      expect(sqlConditionOf()!.text).toContain('COALESCE(release_by, expires_at)');
      expect(sqlConditionOf()!.text).not.toContain('approval_expires_at');
    });

    it("'approval' folds COALESCE(approval_expires_at, expires_at) > now() instead", async () => {
      dbState.updateActionIntentsResults.push([{ id: 'intent-1' }]);
      await transitionIntent(
        'intent-1',
        'pending_approval',
        'cancelled',
        undefined,
        { requireNotExpired: 'approval' },
      );

      const sqlCondition = sqlConditionOf();
      expect(sqlCondition).toBeDefined();
      expect(sqlCondition!.text).toContain('COALESCE(approval_expires_at, expires_at)');
      expect(sqlCondition!.text).not.toContain('release_by');
      expect(sqlCondition!.text).toContain('> now()');
    });

    // Misuse must be unrepresentable rather than silently checking the wrong
    // column — the pre-change boolean applied the RELEASE deadline to ANY
    // from-status, and was correct only because both callers passed
    // `from: 'approved'`.
    it("throws when the requested phase doesn't govern the from-status", async () => {
      await expect(
        transitionIntent('intent-1', 'pending_approval', 'cancelled', undefined, { requireNotExpired: 'release' }),
      ).rejects.toThrow(/not the deadline phase governing/);
      expect(dbState.updateActionIntentsWheres).toHaveLength(0);
    });

    it('throws on a mixed-phase from list (no single correct deadline column)', async () => {
      await expect(
        transitionIntent('intent-1', ['pending_approval', 'approved'], 'cancelled', undefined, {
          requireNotExpired: 'release',
        }),
      ).rejects.toThrow(/not the deadline phase governing/);
      expect(dbState.updateActionIntentsWheres).toHaveLength(0);
    });

    it('throws when a terminal from-status is combined with an expiry check', async () => {
      await expect(
        transitionIntent('intent-1', 'completed', 'failed', undefined, { requireNotExpired: 'release' }),
      ).rejects.toThrow(/not the deadline phase governing/);
      expect(dbState.updateActionIntentsWheres).toHaveLength(0);
    });

    it('omits the expiry condition when requireNotExpired is not set', async () => {
      dbState.updateActionIntentsResults.push([{ id: 'intent-1' }]);
      await transitionIntent('intent-1', 'pending_approval', 'cancelled');

      const whereArgs = (dbState.updateActionIntentsWheres[0] as { args: unknown[] }).args;
      const sqlCondition = whereArgs.find(
        (c) => typeof c === 'object' && c !== null && (c as { op?: string }).op === 'sql',
      );
      expect(sqlCondition).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// getActionIntent
// ---------------------------------------------------------------------------

describe('getActionIntent', () => {
  it('returns null when the intent does not exist (or is invisible under RLS)', async () => {
    dbState.selectActionIntentsResults.push([]);
    const result = await getActionIntent(makeAuth(), 'missing-intent');
    expect(result).toBeNull();
  });

  it('returns a snapshot with approval request ids when found', async () => {
    dbState.selectActionIntentsResults.push([makeIntentRow({ id: 'intent-1' })]);
    // Rows carry userId in production (the select projects it); a fixture that
    // omits it makes the requesterApprovalRequestId derivation unfalsifiable.
    dbState.selectApprovalRequestsResults.push([
      { id: 'approval-1', userId: APPROVER_1 },
      { id: 'approval-2', userId: APPROVER_2 },
    ]);
    const result = await getActionIntent(makeAuth(), 'intent-1');
    expect(result?.id).toBe('intent-1');
    expect(result?.approvalRequestIds).toEqual(['approval-1', 'approval-2']);
  });

  it('requesterApprovalRequestId is the CALLER’s row (the one they may self-approve)', async () => {
    // Caller-derived, matching the idempotent-replay path. Keying on the
    // intent's requestedByUserId would hand an approver reading somebody
    // else's intent a row id that is not theirs to decide.
    dbState.selectActionIntentsResults.push([
      makeIntentRow({ id: 'intent-1', requestedByUserId: APPROVER_1 }),
    ]);
    dbState.selectApprovalRequestsResults.push([
      { id: 'approval-other', userId: APPROVER_1 },
      { id: 'approval-mine', userId: REQUESTER_ID },
    ]);
    const result = await getActionIntent(makeAuth(), 'intent-1');
    expect(result?.requesterApprovalRequestId).toBe('approval-mine');
  });

  it('requesterApprovalRequestId is null when every row belongs to someone else', async () => {
    dbState.selectActionIntentsResults.push([
      makeIntentRow({ id: 'intent-1', requestedByUserId: REQUESTER_ID }),
    ]);
    dbState.selectApprovalRequestsResults.push([
      { id: 'approval-1', userId: APPROVER_1 },
      { id: 'approval-2', userId: APPROVER_2 },
    ]);
    const result = await getActionIntent(makeAuth(), 'intent-1');
    expect(result?.requesterApprovalRequestId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// cancelActionIntent
// ---------------------------------------------------------------------------

describe('cancelActionIntent', () => {
  it('throws ActionIntentNotFoundError when the intent does not exist', async () => {
    dbState.selectActionIntentsResults.push([]);
    await expect(cancelActionIntent(makeAuth(), 'missing')).rejects.toBeInstanceOf(ActionIntentNotFoundError);
  });

  it('allows the requester to cancel their own pending intent', async () => {
    dbState.selectActionIntentsResults.push([makeIntentRow({ id: 'intent-1', requestedByUserId: REQUESTER_ID })]);
    dbState.updateActionIntentsResults.push([{ id: 'intent-1' }]);
    const result = await cancelActionIntent(makeAuth(), 'intent-1');
    expect(result).toEqual({ ok: true, status: 'cancelled' });
  });

  it('rejects a non-requester without approvals:decide', async () => {
    dbState.selectActionIntentsResults.push([makeIntentRow({ id: 'intent-1', requestedByUserId: APPROVER_1 })]);
    permState.getUserPermissions.mockResolvedValue(null);
    await expect(cancelActionIntent(makeAuth(), 'intent-1')).rejects.toBeInstanceOf(ActionIntentAuthorizationError);
  });

  it('allows an eligible approver (non-requester) to cancel', async () => {
    dbState.selectActionIntentsResults.push([makeIntentRow({ id: 'intent-1', requestedByUserId: APPROVER_1 })]);
    permState.getUserPermissions.mockResolvedValue({ canDecide: true });
    dbState.updateActionIntentsResults.push([{ id: 'intent-1' }]);
    const result = await cancelActionIntent(makeAuth(), 'intent-1');
    expect(result).toEqual({ ok: true, status: 'cancelled' });
  });

  it('lets an approvals:decide holder cancel an agent-originated intent', async () => {
    // Owner decision 2026-08-23 (wave 3b): an agent intent has NO requester,
    // so "requester or approver" deliberately collapses to "any
    // approvals:decide holder in the org" — a human can dismiss an agent
    // proposal without approving it.
    dbState.selectActionIntentsResults.push([
      makeIntentRow({
        id: 'intent-1',
        requestedByUserId: null,
        source: 'ai_agent',
        requestingAgentRunId: RUN_ID,
        approvalScope: 'supervised',
      }),
    ]);
    permState.getUserPermissions.mockResolvedValue({ canDecide: true });
    dbState.updateActionIntentsResults.push([{ id: 'intent-1' }]);
    const result = await cancelActionIntent(makeAuth(), 'intent-1');
    expect(result).toEqual({ ok: true, status: 'cancelled' });
  });

  it('denies cancel to a user with neither requester identity nor approvals:decide', async () => {
    dbState.selectActionIntentsResults.push([
      makeIntentRow({
        id: 'intent-1',
        requestedByUserId: null,
        source: 'ai_agent',
        requestingAgentRunId: RUN_ID,
        approvalScope: 'supervised',
      }),
    ]);
    permState.getUserPermissions.mockResolvedValue(null);
    await expect(cancelActionIntent(makeAuth(), 'intent-1')).rejects.toBeInstanceOf(ActionIntentAuthorizationError);
  });

  it('reports the lost race with the current status when the CAS affects zero rows', async () => {
    dbState.selectActionIntentsResults.push([makeIntentRow({ id: 'intent-1', requestedByUserId: REQUESTER_ID })]);
    dbState.updateActionIntentsResults.push([]); // CAS lost
    dbState.selectActionIntentsResults.push([{ status: 'completed' }]); // re-read
    const result = await cancelActionIntent(makeAuth(), 'intent-1');
    expect(result).toEqual({ ok: false, status: 'completed' });
  });

  // #4798: a requester who already received the "approved and now running"
  // outcome notification was never told a subsequent cancel happened — the
  // CAS committed with no outbox row, so intentReleaseWorker.ts had nothing
  // to deliver. Mirrors createActionIntent's intent_created/intent_approved
  // outbox write: an event row in the SAME successful-CAS branch, ids only.
  it('writes an intent_cancelled outbox row when the CAS succeeds', async () => {
    dbState.selectActionIntentsResults.push([
      makeIntentRow({ id: 'intent-1', orgId: ORG_ID, requestedByUserId: REQUESTER_ID }),
    ]);
    dbState.updateActionIntentsResults.push([{ id: 'intent-1' }]);
    const result = await cancelActionIntent(makeAuth(), 'intent-1');
    expect(result).toEqual({ ok: true, status: 'cancelled' });
    expect(dbState.insertedOutboxValues).toEqual([
      { intentId: 'intent-1', eventType: 'intent_cancelled', payload: { intentId: 'intent-1', orgId: ORG_ID } },
    ]);
  });

  // Mirrors the "reports the lost race" test above: a lost CAS must not
  // write an outbox row for a cancellation that never actually happened.
  it('writes no outbox row when the CAS loses the race', async () => {
    dbState.selectActionIntentsResults.push([makeIntentRow({ id: 'intent-1', requestedByUserId: REQUESTER_ID })]);
    dbState.updateActionIntentsResults.push([]); // CAS lost
    dbState.selectActionIntentsResults.push([{ status: 'completed' }]); // re-read
    await cancelActionIntent(makeAuth(), 'intent-1');
    expect(dbState.insertedOutboxValues).toEqual([]);
  });

  // Review finding (#4798): a failed outbox insert must surface as a typed,
  // logged failure — same posture as createActionIntent's transaction catch
  // — rather than a bare exception. The CAS and the insert share ONE
  // withSystemDbAccessContext transaction, so Postgres would roll the status
  // flip back with it; nothing here claims otherwise.
  it('wraps a failed outbox insert as a typed ActionIntentError, not a bare exception', async () => {
    dbState.selectActionIntentsResults.push([makeIntentRow({ id: 'intent-1', requestedByUserId: REQUESTER_ID })]);
    dbState.updateActionIntentsResults.push([{ id: 'intent-1' }]);
    dbState.outboxInsertError = new Error('connection reset');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(cancelActionIntent(makeAuth(), 'intent-1')).rejects.toMatchObject({
        message: expect.stringContaining('Failed to cancel action intent'),
        code: 'cancel_failed',
      });
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[intentService] cancel action intent transaction failed (rolled back):',
        expect.any(Error),
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// waitForIntentDecision — chat SDK's blocking poll (spec §6.1)
// ---------------------------------------------------------------------------

describe('waitForIntentDecision', () => {
  it('returns promptly, without sleeping, once the status leaves pending_approval', async () => {
    dbState.selectActionIntentsResults.push([{ status: 'approved' }]);
    const result = await waitForIntentDecision('intent-1', 5000);
    expect(result).toBe('approved');
  });

  it('returns each of the non-pending terminal-ish statuses verbatim', async () => {
    for (const status of ['rejected', 'expired', 'cancelled', 'executing', 'completed', 'failed'] as const) {
      dbState.selectActionIntentsResults.push([{ status }]);
      // eslint-disable-next-line no-await-in-loop
      await expect(waitForIntentDecision('intent-1', 5000)).resolves.toBe(status);
    }
  });

  it('never mutates the intent — only ever reads via db.select', async () => {
    dbState.selectActionIntentsResults.push([{ status: 'rejected' }]);
    await waitForIntentDecision('intent-1', 5000);
    expect(dbState.updateActionIntentsSets).toHaveLength(0);
  });

  it('polls again on pending_approval and returns the last-read status when the timeout elapses', async () => {
    vi.useFakeTimers();
    try {
      // Every poll still observes pending_approval — plenty of reads queued
      // so the loop never runs dry before the timeout fires.
      for (let i = 0; i < 10; i++) {
        dbState.selectActionIntentsResults.push([{ status: 'pending_approval' }]);
      }
      const promise = waitForIntentDecision('intent-1', 1200);
      await vi.advanceTimersByTimeAsync(2000);
      const result = await promise;
      expect(result).toBe('pending_approval');
      // More than one read happened — it actually polled, not just checked once.
      expect(dbState.selectActionIntentsResults.length).toBeLessThan(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops polling immediately and returns the last-read (initial) status when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await waitForIntentDecision('intent-1', 5000, controller.signal);
    expect(result).toBe('pending_approval');
    // Aborted before the first read — no db call made.
    expect(dbState.selectActionIntentsResults).toHaveLength(0);
  });

  it('returns the pending_approval default when the intent row cannot be found', async () => {
    dbState.selectActionIntentsResults.push([]);
    const result = await waitForIntentDecision('missing-intent', 5000);
    expect(result).toBe('pending_approval');
  });
});
