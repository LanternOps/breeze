import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock shape mirrors routes/approvals.test.ts (the decide core this batches
// over is the very same code, just called N times instead of once) — the DB is
// a bare set of vi.fn()s and the two RLS context helpers are pass-throughs so
// the mocked db.select/db.transaction run inline.
vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
  runOutsideDbContext: (fn: any) => fn(),
  withSystemDbAccessContext: (fn: any) => fn(),
}));

vi.mock('../../db/schema/approvals', () => ({
  approvalRequests: { id: 'id', userId: 'user_id', intentId: 'intent_id', status: 'status' },
}));

vi.mock('../../db/schema/actionIntents', () => ({
  actionIntents: { id: 'id', orgId: 'org_id', status: 'status' },
  intentOutbox: { id: 'id', intentId: 'intent_id', eventType: 'event_type', payload: 'payload' },
}));

vi.mock('../../db/schema/elevations', () => ({
  elevationRequests: { id: 'id', orgId: 'org_id', status: 'status' },
  elevationAudit: { id: 'id', orgId: 'org_id', elevationRequestId: 'elevation_request_id' },
}));

vi.mock('../../db/schema/ai', () => ({
  aiToolExecutions: { id: 'id', sessionId: 'session_id', status: 'status' },
  aiSessions: { id: 'id', userId: 'user_id' },
}));

vi.mock('../../db/schema/aiAgents', () => ({
  aiAgentRuns: { id: 'id', deviceId: 'device_id' },
}));

vi.mock('../../db/schema/devices', () => ({
  devices: { id: 'id', orgId: 'org_id', hostname: 'hostname' },
}));

// Same allowlist-of-one rule as the real helper (middleware/auth.ts).
vi.mock('../../middleware/auth', () => ({
  isInteractiveUserSession: (auth: any) => auth?.principal?.kind === 'user_session',
}));

vi.mock('../actionIntents/intentService', () => ({
  RELEASE_LEASE_MS: 10 * 60 * 1000,
}));

vi.mock('../actionIntents/metrics', () => ({
  recordActionIntentEvent: vi.fn(),
}));

vi.mock('../actionIntents/intentApprovers', () => ({
  resolveIntentApprovers: vi.fn(async () => []),
  isAgentIntentDecideAuthorized: vi.fn(async () => true),
}));

vi.mock('../actionIntents/actorContext', () => ({
  buildAuthContextForIntent: vi.fn(async () => null),
}));

vi.mock('../aiGuardrails', () => ({
  checkToolPermission: vi.fn(async () => null),
}));

vi.mock('../authenticatorPolicy', () => ({
  loadPartnerPolicy: vi.fn(async () => null),
  isEnforcing: vi.fn(() => false),
}));

vi.mock('../permissions', () => ({
  getUserPermissions: vi.fn(async () => ({ scope: 'organization', orgId: 'org-9' })),
  userCanDecideApprovals: vi.fn(() => true),
  canAccessOrg: vi.fn(() => true),
}));

vi.mock('../authenticatorAssurance', () => ({
  resolveApprovalAssurance: vi.fn(() => ({
    requiredLevel: 1,
    decidedAssuranceLevel: 1,
    decidedVia: 'session_tap',
    authenticatorDeviceId: null,
  })),
  assertApprovalAssurance: vi.fn(async () => ({
    requiredLevel: 2,
    decidedAssuranceLevel: 3,
    decidedVia: 'webauthn_platform',
    authenticatorDeviceId: 'authdev-1',
  })),
  // Real classes so the batch path's `instanceof` mapping resolves.
  StepUpRequiredError: class StepUpRequiredError extends Error {
    constructor(public requiredLevel: number, public achievedLevel: number) {
      super('step-up required');
      this.name = 'StepUpRequiredError';
    }
  },
  ReauthRequiredError: class ReauthRequiredError extends Error {
    constructor() {
      super('reauth required');
      this.name = 'ReauthRequiredError';
    }
  },
}));

import { db } from '../../db';
import { approvalRequests } from '../../db/schema/approvals';
import { actionIntents } from '../../db/schema/actionIntents';
import { assertApprovalAssurance, StepUpRequiredError } from '../authenticatorAssurance';
import { isAgentIntentDecideAuthorized } from '../actionIntents/intentApprovers';
import { BATCH_MAX, batchAssertionKey, decideApprovalBatch } from './batchDecide';

const USER_ID = '00000000-0000-0000-0000-000000000001';

const AUTH = {
  principal: { kind: 'user_session' },
  scope: 'partner',
  partnerId: 'partner-123',
  orgId: null,
  user: { id: USER_ID, email: 't@example.com', name: 'Test User', isPlatformAdmin: false },
  accessibleOrgIds: [],
  canAccessOrg: () => false,
  orgCondition: () => undefined,
} as any;

function buildIntent(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `intent-${n}`,
    orgId: 'org-9',
    actionName: 'manage_services',
    arguments: { deviceId: `dev-${n}`, action: 'restart', service: 'spooler' },
    argumentDigest: `digest-${n}`,
    source: 'ai_agent',
    status: 'pending_approval',
    approvalScope: 'supervised',
    requestedByUserId: null,
    requestingAgentRunId: 'run-sweep-1',
    requestingClientLabel: 'Patch Hygiene Agent',
    // An explicit device scope keeps `resolveTargetDevices` on its
    // no-run-lookup path (one `devices` read, which the stub answers empty).
    scopeKind: 'device',
    scopeDeviceId: `dev-${n}`,
    ...overrides,
  };
}

function buildApproval(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `appr-${n}`,
    userId: USER_ID,
    requestingClientLabel: 'Patch Hygiene Agent',
    requestingMachineLabel: null,
    requestingClientId: null,
    actionLabel: `Restart spooler on dev-${n}`,
    actionToolName: 'manage_services',
    actionArguments: { deviceId: `dev-${n}`, action: 'restart', service: 'spooler' },
    riskTier: 'medium',
    riskSummary: 'Restarts a Windows service.',
    status: 'pending',
    expiresAt: new Date(Date.now() + 300_000),
    decidedAt: null,
    decisionReason: null,
    executionId: null,
    elevationRequestId: null,
    intentId: `intent-${n}`,
    boundArgumentDigest: `digest-${n}`,
    isRecursive: false,
    createdAt: new Date(),
    ...overrides,
  };
}

/**
 * Table-dispatched `db.select` stub. Every read in this path is
 * `db.select(...).from(<table>)` followed by either `.leftJoin(...).where(...)`
 * (the batch load) or `.where(...)`, so dispatching on the table identity —
 * rather than on a fragile global call-order queue — keeps the per-row reads
 * independent of how many rows the batch happens to contain.
 */
function mockDb(opts: {
  batchRows: Array<{ approval: unknown; intent: unknown }>;
  /** Per-row pre-fetch overrides, keyed by approval id. Defaults to the row
   *  from `batchRows` (i.e. nothing changed between load and decide). */
  prefetchById?: Record<string, unknown>;
}) {
  const byId = new Map(
    opts.batchRows.map((r) => [(r.approval as { id: string }).id, r]),
  );
  const prefetchOrder = opts.batchRows.map((r) => (r.approval as { id: string }).id);
  let prefetchCursor = 0;
  // The intent load is a per-row FOLLOW-UP to that row's own pre-fetch, and a
  // row can return early (409/410) before ever reaching it — so the intent
  // stub tracks the row the pre-fetch last handed out rather than keeping an
  // independent cursor that would silently drift out of lockstep.
  let currentRowId: string | undefined;

  vi.mocked(db.select).mockImplementation(
    () =>
      ({
        from: (table: unknown) => {
          if (table === approvalRequests) {
            return {
              leftJoin: () => ({ where: async () => opts.batchRows }),
              where: async () => {
                const id = prefetchOrder[prefetchCursor++]!;
                currentRowId = id;
                const override = opts.prefetchById?.[id];
                return [override ?? byId.get(id)!.approval];
              },
            };
          }
          if (table === actionIntents) {
            return {
              where: async () => [byId.get(currentRowId!)!.intent],
            };
          }
          // devices / ai_agent_runs target lookups — never resolve a device.
          return { where: async () => [] };
        },
      }) as any,
  );
}

/** The decide-write transaction: approval CAS, intent CAS, sibling expiry,
 *  outbox insert — the intent-linked shape every batched row takes. */
function mockDecideTx() {
  vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
    const approvalSet = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn(async () => [{ ...buildApproval(0), status: 'approved' }]),
      }),
    });
    const intentSet = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: vi.fn(async () => [{ id: 'intent-1' }]) }),
    });
    const siblingSet = vi.fn().mockReturnValue({ where: vi.fn(async () => undefined) });
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ for: vi.fn(async () => [{ id: 'intent-1' }]) })),
        })),
      })),
      update: vi
        .fn()
        .mockReturnValueOnce({ set: approvalSet } as any)
        .mockReturnValueOnce({ set: intentSet } as any)
        .mockReturnValueOnce({ set: siblingSet } as any),
      insert: vi.fn(() => ({ values: vi.fn(async () => undefined) }) as any),
    };
    return fn(tx);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.select).mockReset();
  vi.mocked(db.transaction).mockReset();
  vi.mocked(assertApprovalAssurance).mockResolvedValue({
    requiredLevel: 2,
    decidedAssuranceLevel: 3,
    decidedVia: 'webauthn_platform',
    authenticatorDeviceId: 'authdev-1',
  });
  // Permissive default: the decider still holds action-and-target authority
  // over every row. The live-authorization test overrides it per row.
  vi.mocked(isAgentIntentDecideAuthorized).mockResolvedValue(true);
});

describe('batchAssertionKey', () => {
  it('is stable under id ORDER and duplicates, and varies with the decision', () => {
    const a = batchAssertionKey(['b', 'a', 'c'], 'approved');
    const b = batchAssertionKey(['c', 'a', 'b', 'a'], 'approved');
    expect(a).toBe(b);
    expect(a).toMatch(/^batch-approved-[0-9a-f]{64}$/);
    expect(batchAssertionKey(['a'], 'denied')).toMatch(/^batch-denied-[0-9a-f]{64}$/);
    expect(batchAssertionKey(['a'], 'denied')).not.toBe(batchAssertionKey(['a'], 'approved'));
  });
});

describe('decideApprovalBatch', () => {
  // (a)
  it('approves three same-(org,tool,action) supervised agent cards with ONE ceremony', async () => {
    const batchRows = [1, 2, 3].map((n) => ({ approval: buildApproval(n), intent: buildIntent(n) }));
    mockDb({ batchRows });
    mockDecideTx();

    const res = await decideApprovalBatch(AUTH, {
      approvalRequestIds: ['appr-1', 'appr-2', 'appr-3'],
      decision: 'approved',
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.results.map((r) => r.httpStatus)).toEqual([200, 200, 200]);
    expect(res.results.map((r) => r.id)).toEqual(['appr-1', 'appr-2', 'appr-3']);

    // ONE ceremony for the whole set, keyed by the batch assertion key.
    expect(vi.mocked(assertApprovalAssurance)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(assertApprovalAssurance)).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: batchAssertionKey(['appr-1', 'appr-2', 'appr-3'], 'approved'),
        userId: USER_ID,
        riskTier: 'medium',
        decision: 'approved',
        partnerId: 'partner-123',
      }),
    );
    // Three rows decided → three decide transactions.
    expect(vi.mocked(db.transaction)).toHaveBeenCalledTimes(3);
  });

  // (b)
  it('422s batch_not_homogeneous for a card of a DIFFERENT tool, deciding nothing', async () => {
    const batchRows = [
      { approval: buildApproval(1), intent: buildIntent(1) },
      { approval: buildApproval(2), intent: buildIntent(2) },
      {
        approval: buildApproval(3, {
          actionToolName: 'execute_command',
          actionArguments: { deviceId: 'dev-3', action: 'restart' },
        }),
        intent: buildIntent(3, { actionName: 'execute_command' }),
      },
    ];
    mockDb({ batchRows });
    mockDecideTx();

    const res = await decideApprovalBatch(AUTH, {
      approvalRequestIds: ['appr-1', 'appr-2', 'appr-3'],
      decision: 'approved',
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.httpStatus).toBe(422);
    expect(res.body).toEqual({ error: 'batch_not_homogeneous', offending: ['appr-3'] });
    // Nothing decided, and no assertion ceremony consumed.
    expect(vi.mocked(assertApprovalAssurance)).not.toHaveBeenCalled();
    expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
  });

  // (b2) same tool, different multiplexed action
  it('422s for the same tool with a DIFFERENT multiplexed action', async () => {
    const batchRows = [
      { approval: buildApproval(1), intent: buildIntent(1) },
      {
        approval: buildApproval(2, {
          actionArguments: { deviceId: 'dev-2', action: 'stop', service: 'spooler' },
        }),
        intent: buildIntent(2),
      },
    ];
    mockDb({ batchRows });
    mockDecideTx();

    const res = await decideApprovalBatch(AUTH, {
      approvalRequestIds: ['appr-1', 'appr-2'],
      decision: 'approved',
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.httpStatus).toBe(422);
    expect(res.body).toEqual({ error: 'batch_not_homogeneous', offending: ['appr-2'] });
    expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
  });

  // (c)
  it('422s when a FOUR-EYES card is in the set', async () => {
    const batchRows = [
      { approval: buildApproval(1), intent: buildIntent(1) },
      {
        approval: buildApproval(2),
        intent: buildIntent(2, { approvalScope: 'four_eyes', requestedByUserId: USER_ID }),
      },
    ];
    mockDb({ batchRows });
    mockDecideTx();

    const res = await decideApprovalBatch(AUTH, {
      approvalRequestIds: ['appr-1', 'appr-2'],
      decision: 'approved',
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.httpStatus).toBe(422);
    expect(res.body).toEqual({ error: 'batch_not_homogeneous', offending: ['appr-2'] });
    expect(vi.mocked(assertApprovalAssurance)).not.toHaveBeenCalled();
    expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
  });

  // (c2) a HUMAN-originated supervised card is not agent-originated
  it('422s for a supervised card with no requesting agent run', async () => {
    const batchRows = [
      { approval: buildApproval(1), intent: buildIntent(1) },
      {
        approval: buildApproval(2),
        intent: buildIntent(2, { requestingAgentRunId: null, requestedByUserId: USER_ID }),
      },
    ];
    mockDb({ batchRows });
    mockDecideTx();

    const res = await decideApprovalBatch(AUTH, {
      approvalRequestIds: ['appr-1', 'appr-2'],
      decision: 'approved',
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.httpStatus).toBe(422);
    expect(res.body).toEqual({ error: 'batch_not_homogeneous', offending: ['appr-2'] });
    expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
  });

  // (d)
  it('403s step_up_required for the WHOLE batch, deciding nothing', async () => {
    const batchRows = [1, 2].map((n) => ({ approval: buildApproval(n), intent: buildIntent(n) }));
    mockDb({ batchRows });
    mockDecideTx();
    vi.mocked(assertApprovalAssurance).mockRejectedValue(new StepUpRequiredError(3, 1));

    const res = await decideApprovalBatch(AUTH, {
      approvalRequestIds: ['appr-1', 'appr-2'],
      decision: 'approved',
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.httpStatus).toBe(403);
    expect(res.body).toEqual({ error: 'step_up_required', requiredLevel: 3 });
    expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
  });

  // (e)
  it('returns 409 for a row decided by someone else and 200 for the rest', async () => {
    const batchRows = [1, 2].map((n) => ({ approval: buildApproval(n), intent: buildIntent(n) }));
    mockDb({
      batchRows,
      // Between the batch load and this row's own pre-fetch, someone else
      // approved it.
      prefetchById: { 'appr-1': buildApproval(1, { status: 'approved' }) },
    });
    mockDecideTx();

    const res = await decideApprovalBatch(AUTH, {
      approvalRequestIds: ['appr-1', 'appr-2'],
      decision: 'approved',
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.results[0]).toEqual({
      id: 'appr-1',
      httpStatus: 409,
      body: { error: 'Already approved', finalStatus: 'approved' },
    });
    expect(res.results[1]!.httpStatus).toBe(200);
    // The losing row did not stop the batch: exactly one decide transaction ran.
    expect(vi.mocked(db.transaction)).toHaveBeenCalledTimes(1);
  });

  // (f)
  it('400s more than BATCH_MAX ids without touching the database', async () => {
    mockDb({ batchRows: [] });
    mockDecideTx();

    const res = await decideApprovalBatch(AUTH, {
      approvalRequestIds: Array.from({ length: BATCH_MAX + 1 }, (_, i) => `appr-${i}`),
      decision: 'approved',
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.httpStatus).toBe(400);
    expect(res.body).toEqual({ error: 'batch_too_large', max: BATCH_MAX });
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
    expect(vi.mocked(assertApprovalAssurance)).not.toHaveBeenCalled();
  });

  // Non-human principals never decide — the same allowlist-of-one the
  // single-card core asserts, applied before any row is loaded.
  it('403s human_decision_required for a non-interactive principal', async () => {
    mockDb({ batchRows: [] });
    const res = await decideApprovalBatch(
      { ...AUTH, principal: { kind: 'ai_agent' } },
      { approvalRequestIds: ['appr-1'], decision: 'approved' },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.httpStatus).toBe(403);
    expect(res.body).toEqual({ error: 'human_decision_required' });
    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
  });

  // A row that is not the caller's simply is not returned by the load —
  // indistinguishable from "no such approval", and offending either way.
  it('422s when an id resolves to no row of the caller\'s', async () => {
    const batchRows = [{ approval: buildApproval(1), intent: buildIntent(1) }];
    mockDb({ batchRows });
    mockDecideTx();

    const res = await decideApprovalBatch(AUTH, {
      approvalRequestIds: ['appr-1', 'appr-404'],
      decision: 'approved',
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.httpStatus).toBe(422);
    expect(res.body).toEqual({ error: 'batch_not_homogeneous', offending: ['appr-404'] });
    expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
  });

  it('takes the MAX risk tier across the batch into the single ceremony', async () => {
    const batchRows = [
      { approval: buildApproval(1), intent: buildIntent(1) },
      { approval: buildApproval(2, { riskTier: 'high' }), intent: buildIntent(2) },
    ];
    mockDb({ batchRows });
    mockDecideTx();

    await decideApprovalBatch(AUTH, {
      approvalRequestIds: ['appr-1', 'appr-2'],
      decision: 'approved',
    });

    expect(vi.mocked(assertApprovalAssurance)).toHaveBeenCalledWith(
      expect.objectContaining({ riskTier: 'high' }),
    );
  });

  // Review fix round 1, Important 1: one unexpected throw must not discard the
  // decisions that already committed.
  it('reports a row that THROWS as 500 decide_failed and keeps going', async () => {
    const batchRows = [1, 2, 3].map((n) => ({ approval: buildApproval(n), intent: buildIntent(n) }));
    mockDb({ batchRows });
    mockDecideTx();
    // Row 2 blows up somewhere outside the decide core's own try/catch (its
    // pre-fetch, intent load, authority re-check and target resolution are all
    // unguarded) — modelled here on the per-row authority call.
    vi.mocked(isAgentIntentDecideAuthorized)
      .mockResolvedValueOnce(true) // the batch-load pass, row 1
      .mockResolvedValueOnce(true) // the batch-load pass, row 2
      .mockResolvedValueOnce(true) // the batch-load pass, row 3
      .mockResolvedValueOnce(true) // row 1's own decide
      .mockRejectedValueOnce(new Error('pool exhausted')) // row 2's own decide
      .mockResolvedValue(true);

    const res = await decideApprovalBatch(AUTH, {
      approvalRequestIds: ['appr-1', 'appr-2', 'appr-3'],
      decision: 'approved',
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // All three rows are accounted for — the loop reached row 3.
    expect(res.results.map((r) => [r.id, r.httpStatus])).toEqual([
      ['appr-1', 200],
      ['appr-2', 500],
      ['appr-3', 200],
    ]);
    expect(res.results[1]!.body).toEqual({ error: 'decide_failed', retryable: true });
    // The two healthy rows still committed.
    expect(vi.mocked(db.transaction)).toHaveBeenCalledTimes(2);
  });

  // Review fix round 1, minor: a demoted approver must not reach the ceremony
  // (nor, via the same loader, mint a batch challenge).
  it('422s a row the caller is no longer action-and-target authorized for', async () => {
    const batchRows = [1, 2].map((n) => ({ approval: buildApproval(n), intent: buildIntent(n) }));
    mockDb({ batchRows });
    mockDecideTx();
    vi.mocked(isAgentIntentDecideAuthorized).mockImplementation(
      async (_userId: string, intent: any) => intent.id !== 'intent-2',
    );

    const res = await decideApprovalBatch(AUTH, {
      approvalRequestIds: ['appr-1', 'appr-2'],
      decision: 'approved',
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.httpStatus).toBe(422);
    expect(res.body).toEqual({ error: 'batch_not_homogeneous', offending: ['appr-2'] });
    expect(vi.mocked(assertApprovalAssurance)).not.toHaveBeenCalled();
    expect(vi.mocked(db.transaction)).not.toHaveBeenCalled();
  });

  it('422s a row whose linked intent already settled', async () => {
    const batchRows = [
      { approval: buildApproval(1), intent: buildIntent(1) },
      { approval: buildApproval(2), intent: buildIntent(2, { status: 'approved' }) },
    ];
    mockDb({ batchRows });
    mockDecideTx();

    const res = await decideApprovalBatch(AUTH, {
      approvalRequestIds: ['appr-1', 'appr-2'],
      decision: 'approved',
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.httpStatus).toBe(422);
    expect(res.body).toEqual({ error: 'batch_not_homogeneous', offending: ['appr-2'] });
    expect(vi.mocked(assertApprovalAssurance)).not.toHaveBeenCalled();
  });
});
