import { describe, it, expect, vi, beforeEach } from 'vitest';
import { canonicalizeArguments, computeArgumentDigest } from './canonicalize';

// ---------------------------------------------------------------------------
// Hoisted shared mock state
// ---------------------------------------------------------------------------

const { schema, dbState, authMock, guardrailMock, aiToolsState, permState, pushState, metricsMock } = vi.hoisted(() => {
  const col = (name: string) => ({ name });
  const actionIntentsTbl = {
    id: col('id'),
    orgId: col('org_id'),
    idempotencyKey: col('idempotency_key'),
    status: col('status'),
  };
  const approvalRequestsTbl = { id: col('id'), intentId: col('intent_id') };
  const organizationUsersTbl = { userId: col('user_id'), orgId: col('org_id') };
  const intentOutboxTbl = { id: col('id'), intentId: col('intent_id') };

  return {
    schema: { actionIntentsTbl, approvalRequestsTbl, organizationUsersTbl, intentOutboxTbl },
    dbState: {
      insertActionIntentsResults: [] as unknown[][],
      insertApprovalRequestsResults: [] as unknown[][],
      selectActionIntentsResults: [] as unknown[][],
      selectApprovalRequestsResults: [] as unknown[][],
      selectOrgUsersResults: [] as unknown[][],
      updateActionIntentsResults: [] as unknown[][],
      insertedActionIntentValues: [] as Record<string, unknown>[],
      insertedApprovalRequestsValues: [] as unknown[],
      insertedOutboxValues: [] as Record<string, unknown>[],
      updateActionIntentsSets: [] as Record<string, unknown>[],
      updateActionIntentsWheres: [] as unknown[],
    },
    authMock: { dbAccessContextFromAuth: vi.fn((auth: { scope: string; orgId: string | null; accessibleOrgIds: string[] | null; user: { id: string } }) => ({
      scope: auth.scope,
      orgId: auth.orgId,
      accessibleOrgIds: auth.accessibleOrgIds,
      userId: auth.user.id,
    })) },
    guardrailMock: { checkGuardrails: vi.fn() },
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
    metricsMock: { recordActionIntentEvent: vi.fn() },
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
          dbState.insertedActionIntentValues.push(values as Record<string, unknown>);
          return {
            onConflictDoNothing: vi.fn(() => ({
              returning: vi.fn(async () => dbState.insertActionIntentsResults.shift() ?? []),
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
          if (table === schema.organizationUsersTbl) {
            return resultBox(() => dbState.selectOrgUsersResults.shift() ?? []);
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
}));

vi.mock('../../db/schema/actionIntents', () => ({
  actionIntents: schema.actionIntentsTbl,
  intentOutbox: schema.intentOutboxTbl,
}));

vi.mock('../../db/schema/approvals', () => ({
  approvalRequests: schema.approvalRequestsTbl,
}));

vi.mock('../../db/schema/users', () => ({
  organizationUsers: schema.organizationUsersTbl,
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
}));

vi.mock('../permissions', () => ({
  getUserPermissions: permState.getUserPermissions,
  userCanDecideApprovals: permState.userCanDecideApprovals,
}));

vi.mock('../expoPush', () => ({
  getUserPushTokens: pushState.getUserPushTokens,
  dispatchApprovalPushToTokens: pushState.dispatchApprovalPushToTokens,
}));

vi.mock('./metrics', () => ({
  recordActionIntentEvent: metricsMock.recordActionIntentEvent,
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ op: 'eq', args })),
  and: vi.fn((...args: unknown[]) => ({ op: 'and', args })),
  inArray: vi.fn((...args: unknown[]) => ({ op: 'inArray', args })),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import {
  createActionIntent,
  getActionIntent,
  cancelActionIntent,
  transitionIntent,
  ActionIntentTierError,
  ActionIntentNotFoundError,
  ActionIntentAuthorizationError,
  type CreateActionIntentInput,
} from './intentService';
import { db, withDbAccessContext } from '../../db';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const REQUESTER_ID = '22222222-2222-4222-8222-222222222222';
const APPROVER_1 = '33333333-3333-4333-8333-333333333333';
const APPROVER_2 = '44444444-4444-4444-8444-444444444444';

function makeAuth() {
  return {
    user: { id: REQUESTER_ID, email: 'req@example.com', name: 'Requester' },
    orgId: ORG_ID,
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
  dbState.selectOrgUsersResults.length = 0;
  dbState.updateActionIntentsResults.length = 0;
  dbState.insertedActionIntentValues.length = 0;
  dbState.insertedApprovalRequestsValues.length = 0;
  dbState.insertedOutboxValues.length = 0;
  dbState.updateActionIntentsSets.length = 0;
  dbState.updateActionIntentsWheres.length = 0;
}

function makeIntentRow(overrides?: Record<string, unknown>) {
  return {
    id: 'intent-1',
    orgId: ORG_ID,
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
    status: 'pending_approval',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 300_000),
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
  permState.getUserPermissions.mockResolvedValue(null);
  permState.userCanDecideApprovals.mockImplementation((perms: { canDecide?: boolean } | null) => !!perms?.canDecide);
  pushState.getUserPushTokens.mockResolvedValue([]);
  pushState.dispatchApprovalPushToTokens.mockResolvedValue({ tokensFound: 0, dispatched: 0, errors: 0 });
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
// Digest stability
// ---------------------------------------------------------------------------

describe('createActionIntent — digest stability', () => {
  it('computes the same argument_digest for canonically-equivalent input regardless of key order', async () => {
    const inputA = { b: 1, a: { z: 2, y: 3 } };
    const inputB = { a: { y: 3, z: 2 }, b: 1 };
    const expectedDigest = computeArgumentDigest(canonicalizeArguments(inputA));

    dbState.selectOrgUsersResults.push([]);
    dbState.insertActionIntentsResults.push([makeIntentRow({ id: 'intent-a', status: 'cancelled', errorCode: 'no_eligible_approvers' })]);
    dbState.updateActionIntentsResults.push([makeIntentRow({ id: 'intent-a', status: 'cancelled', errorCode: 'no_eligible_approvers' })]);
    await createActionIntent(makeAuth(), baseInput({ input: inputA, idempotencyKey: 'key-a' }));
    expect(dbState.insertedActionIntentValues[0]?.argumentDigest).toBe(expectedDigest);

    dbState.selectOrgUsersResults.push([]);
    dbState.insertActionIntentsResults.push([makeIntentRow({ id: 'intent-b', status: 'cancelled', errorCode: 'no_eligible_approvers' })]);
    dbState.updateActionIntentsResults.push([makeIntentRow({ id: 'intent-b', status: 'cancelled', errorCode: 'no_eligible_approvers' })]);
    await createActionIntent(makeAuth(), baseInput({ input: inputB, idempotencyKey: 'key-b' }));
    expect(dbState.insertedActionIntentValues[1]?.argumentDigest).toBe(expectedDigest);
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
    dbState.selectApprovalRequestsResults.push([{ id: 'approval-existing' }]);

    const snapshot = await createActionIntent(makeAuth(), baseInput({ idempotencyKey: 'fixed-key' }));

    expect(snapshot.id).toBe('existing-intent');
    expect(snapshot.status).toBe('approved');
    expect(snapshot.approvalRequestIds).toEqual(['approval-existing']);
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
    dbState.selectOrgUsersResults.push([
      { userId: REQUESTER_ID },
      { userId: APPROVER_1 },
      { userId: APPROVER_2 },
    ]);
    permState.getUserPermissions.mockImplementation(async (userId: string) => ({ userId, canDecide: true }));
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-1' }, { id: 'approval-2' }]);

    const snapshot = await createActionIntent(makeAuth(), baseInput());

    expect(snapshot.status).toBe('pending_approval');
    expect(snapshot.approvalRequestIds).toEqual(['approval-1', 'approval-2']);
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
    dbState.selectOrgUsersResults.push([{ userId: REQUESTER_ID }]);
    permState.getUserPermissions.mockImplementation(async (userId: string) =>
      userId === REQUESTER_ID ? { userId, canDecide: true } : null,
    );
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-solo' }]);

    const snapshot = await createActionIntent(makeAuth(), baseInput());

    expect(snapshot.status).toBe('pending_approval');
    expect(snapshot.approvalRequestIds).toEqual(['approval-solo']);
    const inserted = dbState.insertedApprovalRequestsValues[0] as Array<{ userId: string }>;
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.userId).toBe(REQUESTER_ID);
    expect(metricsMock.recordActionIntentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ soleOperator: true }) }),
    );
  });

  it('creates the intent then immediately cancels it when no one is eligible (not even the requester)', async () => {
    dbState.insertActionIntentsResults.push([makeIntentRow()]);
    dbState.selectOrgUsersResults.push([{ userId: REQUESTER_ID }, { userId: APPROVER_1 }]);
    permState.getUserPermissions.mockResolvedValue(null); // nobody passes userCanDecideApprovals
    dbState.updateActionIntentsResults.push([
      makeIntentRow({ status: 'cancelled', errorCode: 'no_eligible_approvers' }),
    ]);

    const snapshot = await createActionIntent(makeAuth(), baseInput());

    expect(snapshot.status).toBe('cancelled');
    expect(snapshot.errorCode).toBe('no_eligible_approvers');
    expect(snapshot.approvalRequestIds).toEqual([]);
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
// Connection-hold regression (#1105 class) — approver resolution must not
// run inside the write transaction.
// ---------------------------------------------------------------------------

type MockLike = { mock: { calls: unknown[][]; invocationCallOrder: number[] } };

describe('createActionIntent — connection-hold (#1105)', () => {
  it('resolves every eligible-approver permission check before the write transaction inserts the intent row', async () => {
    dbState.insertActionIntentsResults.push([makeIntentRow()]);
    dbState.selectOrgUsersResults.push([
      { userId: REQUESTER_ID },
      { userId: APPROVER_1 },
      { userId: APPROVER_2 },
    ]);
    permState.getUserPermissions.mockImplementation(async (userId: string) => ({ userId, canDecide: true }));
    dbState.insertApprovalRequestsResults.push([{ id: 'approval-1' }, { id: 'approval-2' }]);

    await createActionIntent(makeAuth(), baseInput());

    // One getUserPermissions call per org member — confirms the approver
    // resolution actually ran (not vacuously skipped).
    expect(permState.getUserPermissions).toHaveBeenCalledTimes(3);

    const insertMock = db.insert as unknown as MockLike;
    const intentInsertIndex = insertMock.mock.calls.findIndex((call) => call[0] === schema.actionIntentsTbl);
    expect(intentInsertIndex).toBeGreaterThanOrEqual(0);
    const intentInsertOrder = insertMock.mock.invocationCallOrder[intentInsertIndex]!;

    // invocationCallOrder is a global counter shared across every vi.fn in
    // the test — safe to compare directly across mocks. Every permission
    // check's call site must precede the intent-row insert, proving
    // resolution completed before the write transaction opened (no pooled
    // connection held across the N sequential round-trips).
    const permCallOrders = (permState.getUserPermissions as unknown as MockLike).mock.invocationCallOrder;
    expect(Math.max(...permCallOrders)).toBeLessThan(intentInsertOrder);

    // withDbAccessContext must have opened a distinct (earlier) context for
    // the members read, separate from the one wrapping the creation write.
    const wrapMock = withDbAccessContext as unknown as MockLike;
    expect(wrapMock.mock.invocationCallOrder.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...permCallOrders)).toBeLessThan(wrapMock.mock.invocationCallOrder[1]!);

    // Fan-out outcome itself is unchanged by the reordering.
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
    dbState.selectOrgUsersResults.push([{ userId: APPROVER_1 }]);
    permState.getUserPermissions.mockResolvedValue({ canDecide: true });
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
    dbState.selectApprovalRequestsResults.push([{ id: 'approval-1' }, { id: 'approval-2' }]);
    const result = await getActionIntent(makeAuth(), 'intent-1');
    expect(result?.id).toBe('intent-1');
    expect(result?.approvalRequestIds).toEqual(['approval-1', 'approval-2']);
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

  it('reports the lost race with the current status when the CAS affects zero rows', async () => {
    dbState.selectActionIntentsResults.push([makeIntentRow({ id: 'intent-1', requestedByUserId: REQUESTER_ID })]);
    dbState.updateActionIntentsResults.push([]); // CAS lost
    dbState.selectActionIntentsResults.push([{ status: 'completed' }]); // re-read
    const result = await cancelActionIntent(makeAuth(), 'intent-1');
    expect(result).toEqual({ ok: false, status: 'completed' });
  });
});
