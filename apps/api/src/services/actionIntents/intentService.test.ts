import { describe, it, expect, vi, beforeEach } from 'vitest';
import { canonicalizeArguments, computeArgumentDigest } from './canonicalize';
// Type-only (erased at runtime), so it is safe to reference inside vi.hoisted.
import type { EffectDigestOutcome } from './effectDigest';

// ---------------------------------------------------------------------------
// Hoisted shared mock state
// ---------------------------------------------------------------------------

const { schema, dbState, authMock, guardrailMock, aiToolsState, permState, pushState, notifyState, metricsMock, intentApproversState, effectDigestState } = vi.hoisted(() => {
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

  return {
    schema: { actionIntentsTbl, approvalRequestsTbl, intentOutboxTbl },
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
    notifyState: {
      createNotification: vi.fn(async () => 'notif-1'),
    },
    metricsMock: { recordActionIntentEvent: vi.fn() },
    // CRITICAL-2: approver resolution is now a single opaque resolver call
    // (org + partner axis) instead of an organization_users select + N
    // getUserPermissions round-trips, so it's mocked wholesale here rather
    // than reconstructed from db-table mocks.
    intentApproversState: { resolveIntentApprovers: vi.fn(async () => [] as string[]) },
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

vi.mock('../userNotifications', () => ({
  createNotification: notifyState.createNotification,
}));

vi.mock('./metrics', () => ({
  recordActionIntentEvent: metricsMock.recordActionIntentEvent,
}));

vi.mock('./effectDigest', () => ({
  computeEffectDigestOutcome: effectDigestState.computeEffectDigestOutcome,
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
  dbState.updateActionIntentsSets.length = 0;
  dbState.updateActionIntentsWheres.length = 0;
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
  notifyState.createNotification.mockResolvedValue('notif-1');
  // No eligible approvers by default — tests that need a fan-out opt in via
  // mockResolvedValueOnce.
  intentApproversState.resolveIntentApprovers.mockResolvedValue([]);
  effectDigestState.computeEffectDigestOutcome.mockResolvedValue({ kind: 'not_applicable' });
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

  it('reports the lost race with the current status when the CAS affects zero rows', async () => {
    dbState.selectActionIntentsResults.push([makeIntentRow({ id: 'intent-1', requestedByUserId: REQUESTER_ID })]);
    dbState.updateActionIntentsResults.push([]); // CAS lost
    dbState.selectActionIntentsResults.push([{ status: 'completed' }]); // re-read
    const result = await cancelActionIntent(makeAuth(), 'intent-1');
    expect(result).toEqual({ ok: false, status: 'completed' });
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
