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
      resolveIntentApprovers: vi.fn(async (_orgId?: string, _opts?: unknown) => [] as string[]),
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
    envMock: { policyDecideEnabled: vi.fn(() => false), sweepActEnabled: vi.fn(() => false) },
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
  // The identity-tenant helpdesk tools are WHOLE-TOOL entries in the real map
  // (no `action` discriminator at all) — mirrored here, since the raise gate
  // below keys off this classifier. Real membership is pinned by
  // orgWideGovernanceCoverage.contract.test.ts.
  isOrgWideGovernanceIntent: (toolName: string, args: Record<string, unknown> | null | undefined) =>
    (toolName === 'manage_ai_agents' && args?.action === 'authorize_supervised_key')
    || ['m365_disable_user', 'm365_reset_password', 'google_suspend_user', 'google_reset_password']
      .includes(toolName),
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
  EffectDigestUnresolvableError: class EffectDigestUnresolvableError extends Error {},
}));

vi.mock('../../config/env', () => ({
  policyDecideEnabled: envMock.policyDecideEnabled,
  // #4442 W04 sub-flag, default OFF (dark-ship).
  sweepActEnabled: envMock.sweepActEnabled,
}));

vi.mock('./policyDecide', () => ({
  attemptPolicyDecision: policyDecideMock.attemptPolicyDecision,
}));

// #5106: real implementation wrapped in a spy so tests can assert what
// intentService.ts actually PASSES to buildActionLabel (deviceHostname in
// particular) without hand-duplicating actionLabel.ts's own substitution
// logic (already covered by actionLabel.test.ts).
vi.mock('./actionLabel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./actionLabel')>();
  // Spread the real module: intentService also imports `hasDeviceIdStub`
  // (#5363), and a mock that returns only `buildActionLabel` would hand it
  // `undefined` at call time.
  return { ...actual, buildActionLabel: vi.fn(actual.buildActionLabel) };
});

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

// Caller verification W05 (#6354): the two protected M365 tools resolve their
// canonical target (lazy `../aiToolsM365` import) and run the gate in `check`
// mode before anything is minted. Both collaborators are mocked at the module
// boundary; this suite pins the WIRING (what is passed, what is inserted, that
// a refusal mints nothing). Defaults pass, so every pre-W05 test is unchanged.
const callerState = vi.hoisted(() => ({
  resolveM365CallerTarget: vi.fn(),
  requireCallerVerification: vi.fn(async () => undefined),
  getEffectivePolicy: vi.fn(async () => ({ requiredTierResetPassword: 3, requiredTierDisableUser: 2 })),
}));
vi.mock('../aiToolsM365', () => ({ resolveM365CallerTarget: callerState.resolveM365CallerTarget }));
vi.mock('../callerVerification/gate', () => ({ requireCallerVerification: callerState.requireCallerVerification }));
vi.mock('../callerVerification/policy', () => ({ getEffectivePolicy: callerState.getEffectivePolicy }));

// ---------------------------------------------------------------------------
// Wisp W05 Task 8 — `ai.intent.decided` emitted by transitionIntent
// ---------------------------------------------------------------------------

const eventBusMock = vi.hoisted(() => ({ publishEvent: vi.fn(async (..._a: unknown[]) => 'evt-1') }));
vi.mock('../eventBus', () => ({ publishEvent: eventBusMock.publishEvent }));
const sentryMock = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../sentry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  captureException: sentryMock.captureException,
}));

import { transitionIntent } from './intentService';

const INTENT = {
  id: 'intent-1',
  orgId: 'org-1',
  toolName: 'manage_devices',
  requestingAgentRunId: 'run-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  eventBusMock.publishEvent.mockImplementation(async () => 'evt-1');
  dbState.updateActionIntentsResults.length = 0;
  dbState.updateActionIntentsSets.length = 0;
  dbState.selectAgentRunsResults.length = 0;
});

describe('transitionIntent publishes ai.intent.decided', () => {
  it('publishes once on approved with the run grant id', async () => {
    dbState.updateActionIntentsResults.push([INTENT]);
    dbState.selectAgentRunsResults.push([{ grantId: 'grant-1' }]);
    await expect(transitionIntent('intent-1', 'pending_approval', 'approved')).resolves.toBe(true);
    expect(eventBusMock.publishEvent).toHaveBeenCalledTimes(1);
    expect(eventBusMock.publishEvent).toHaveBeenCalledWith(
      'ai.intent.decided',
      'org-1',
      {
        intentId: 'intent-1',
        orgId: 'org-1',
        toolName: 'manage_devices',
        decision: 'approved',
        requestingAgentRunId: 'run-1',
        grantId: 'grant-1',
      },
      'action-intents',
    );
  });

  it.each(['rejected', 'expired', 'cancelled'] as const)('publishes for %s', async (to) => {
    dbState.updateActionIntentsResults.push([INTENT]);
    dbState.selectAgentRunsResults.push([{ grantId: null }]);
    await transitionIntent('intent-1', 'pending_approval', to);
    expect(eventBusMock.publishEvent).toHaveBeenCalledWith(
      'ai.intent.decided', 'org-1',
      expect.objectContaining({ decision: to, grantId: null }),
      'action-intents',
    );
  });

  it('has grantId null and reads no run when the intent has no requesting run', async () => {
    dbState.updateActionIntentsResults.push([{ ...INTENT, requestingAgentRunId: null }]);
    await transitionIntent('intent-1', 'pending_approval', 'approved');
    expect(eventBusMock.publishEvent).toHaveBeenCalledWith(
      'ai.intent.decided', 'org-1',
      expect.objectContaining({ requestingAgentRunId: null, grantId: null }),
      'action-intents',
    );
  });

  it.each(['executing', 'completed', 'failed'] as const)('publishes nothing for -> %s', async (to) => {
    dbState.updateActionIntentsResults.push([INTENT]);
    await transitionIntent('intent-1', 'approved', to);
    expect(eventBusMock.publishEvent).not.toHaveBeenCalled();
  });

  it('publishes nothing on a CAS miss', async () => {
    dbState.updateActionIntentsResults.push([]);
    await expect(transitionIntent('intent-1', 'pending_approval', 'approved')).resolves.toBe(false);
    expect(eventBusMock.publishEvent).not.toHaveBeenCalled();
  });

  it('does not reject transitionIntent when publishEvent rejects', async () => {
    dbState.updateActionIntentsResults.push([INTENT]);
    dbState.selectAgentRunsResults.push([{ grantId: 'grant-1' }]);
    const down = new Error('redis down');
    eventBusMock.publishEvent.mockImplementation(async () => { throw down; });
    await expect(transitionIntent('intent-1', 'pending_approval', 'approved')).resolves.toBe(true);
    expect(eventBusMock.publishEvent).toHaveBeenCalledTimes(1);
    // The lost wake is reported, not only logged.
    await vi.waitFor(() => expect(sentryMock.captureException).toHaveBeenCalledWith(
      down, undefined, { component: 'actionIntents', op: 'publish_intent_decided' },
    ));
  });

  it('does not reject transitionIntent when publishEvent throws synchronously', async () => {
    dbState.updateActionIntentsResults.push([INTENT]);
    dbState.selectAgentRunsResults.push([{ grantId: null }]);
    eventBusMock.publishEvent.mockImplementation(() => { throw new Error('boom'); });
    await expect(transitionIntent('intent-1', 'pending_approval', 'approved')).resolves.toBe(true);
  });
});
