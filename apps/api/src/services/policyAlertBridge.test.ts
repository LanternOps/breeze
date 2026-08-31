import { describe, it, expect, vi, beforeEach } from 'vitest';

// #2149: automation_policies became dual-ownership (org_id XOR partner_id).
// handlePolicyViolation resolves an org-owned policy against the event's
// device org directly, but a partner-wide policy (org_id NULL) resolves
// against the device org's *partner* instead. This app-layer axis check has
// no other coverage in the unit suite (only real-DB integration tests, which
// don't run in the required CI job) — see PR #2149 review.

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  automationPolicies: {
    id: 'id',
    orgId: 'org_id',
    partnerId: 'partner_id',
  },
  organizations: {
    id: 'id',
    partnerId: 'partner_id',
  },
  alertRules: {
    id: 'id',
    orgId: 'org_id',
    name: 'name',
  },
  alertTemplates: {
    id: 'id',
    orgId: 'org_id',
    name: 'name',
  },
  alerts: {
    id: 'id',
    ruleId: 'rule_id',
    deviceId: 'device_id',
    status: 'status',
  },
  automationPolicyCompliance: {
    policyId: 'policy_id',
    deviceId: 'device_id',
    status: 'status',
    updatedAt: 'updated_at',
  },
}));

vi.mock('./alertService', () => ({
  createAlert: vi.fn().mockResolvedValue('alert-created-1'),
  resolveAlert: vi.fn(),
}));

vi.mock('./eventBus', () => ({
  getEventBus: vi.fn(),
}));

import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { automationPolicyCompliance } from '../db/schema';
import { createAlert } from './alertService';
import {
  handlePolicyViolation,
  handlePolicyViolationEvent,
  handlePolicyCompliantEvent,
} from './policyAlertBridge';

function mockSelectOnce(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        // Most call sites go straight to `.limit()`; the reconcile query
        // (#4085 Task 10 + determinism fix) chains `.orderBy().limit()` —
        // support both without needing a second helper.
        limit,
        orderBy: vi.fn().mockReturnValue({ limit }),
      }),
    }),
  } as any);
}

const POLICY_ID = 'policy-1';
const DEVICE_ID = 'device-1';

function payload(overrides: Record<string, unknown> = {}) {
  return {
    policyId: POLICY_ID,
    policyName: 'Test Policy',
    deviceId: DEVICE_ID,
    hostname: 'TST-01',
    enforcement: 'enforce',
    ...overrides,
  };
}

describe('handlePolicyViolation (dual-axis policy check, #2149)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates an alert when the policy is org-owned and matches the event org', async () => {
    // 1) policy lookup, 2) reconcile compliance lookup (no row — proceeds,
    // #4085 Task 10), 3) ensureRule's alertRules lookup (existing rule, so
    // ensureTemplate/insert paths are never reached).
    mockSelectOnce([{ id: POLICY_ID, orgId: 'org-1', partnerId: null }]);
    mockSelectOnce([]);
    mockSelectOnce([{ id: 'rule-1' }]);

    await handlePolicyViolation('org-1', payload());

    expect(vi.mocked(createAlert)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createAlert)).toHaveBeenCalledWith(
      expect.objectContaining({
        ruleId: 'rule-1',
        deviceId: DEVICE_ID,
        orgId: 'org-1',
      })
    );
  });

  it('does not create an alert when the policy is org-owned but belongs to a different org', async () => {
    mockSelectOnce([{ id: POLICY_ID, orgId: 'org-1', partnerId: null }]);

    await handlePolicyViolation('org-2', payload());

    expect(vi.mocked(createAlert)).not.toHaveBeenCalled();
    // Only the policy lookup ran — no org lookup, no rule lookup.
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
  });

  it('creates an alert when the policy is partner-wide and the event org belongs to the same partner', async () => {
    // 1) policy lookup (org_id null), 2) organizations lookup for the event
    // org's partnerId, 3) reconcile compliance lookup (no row — proceeds),
    // 4) ensureRule's alertRules lookup (existing rule).
    mockSelectOnce([{ id: POLICY_ID, orgId: null, partnerId: 'partner-1' }]);
    mockSelectOnce([{ partnerId: 'partner-1' }]);
    mockSelectOnce([]);
    mockSelectOnce([{ id: 'rule-1' }]);

    await handlePolicyViolation('org-under-partner-1', payload());

    expect(vi.mocked(createAlert)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createAlert)).toHaveBeenCalledWith(
      expect.objectContaining({
        ruleId: 'rule-1',
        deviceId: DEVICE_ID,
        orgId: 'org-under-partner-1',
      })
    );
  });

  it('does not create an alert when the policy is partner-wide but the event org belongs to a different partner', async () => {
    mockSelectOnce([{ id: POLICY_ID, orgId: null, partnerId: 'partner-1' }]);
    mockSelectOnce([{ partnerId: 'partner-2' }]);

    await handlePolicyViolation('org-under-partner-2', payload());

    expect(vi.mocked(createAlert)).not.toHaveBeenCalled();
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(2);
  });

  it('does not create an alert when the partner-wide policy has no organization match at all (org not found)', async () => {
    mockSelectOnce([{ id: POLICY_ID, orgId: null, partnerId: 'partner-1' }]);
    mockSelectOnce([]);

    await handlePolicyViolation('org-unknown', payload());

    expect(vi.mocked(createAlert)).not.toHaveBeenCalled();
  });

  it('is a no-op when the payload is missing policyId or deviceId', async () => {
    await handlePolicyViolation('org-1', payload({ policyId: undefined }));
    await handlePolicyViolation('org-1', payload({ deviceId: undefined }));

    expect(vi.mocked(db.select)).not.toHaveBeenCalled();
    expect(vi.mocked(createAlert)).not.toHaveBeenCalled();
  });

  it('is a no-op when the policy does not exist', async () => {
    mockSelectOnce([]);

    await handlePolicyViolation('org-1', payload());

    expect(vi.mocked(createAlert)).not.toHaveBeenCalled();
  });
});

// #4085 Task 3: handlePolicyViolationEvent / handlePolicyCompliantEvent are the
// registry-registered subscriber ids (single `policy-alert-bridge` id, dispatched
// by event.type in services/eventSubscribers.ts). Both MUST throw on failure —
// the old subscribeToPolicyEvents wrapped each in a try/catch that logged and
// swallowed; that swallow now lives one layer up, in eventBus.ts's registry-aware
// local delivery.
describe('handlePolicyViolationEvent / handlePolicyCompliantEvent (durable registry contract)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function event(type: 'policy.violation' | 'policy.compliant', orgId: string, payloadOverrides = {}) {
    return {
      id: 'event-1',
      type,
      orgId,
      source: 'test',
      priority: 'normal' as const,
      payload: payload(payloadOverrides),
      metadata: { correlationId: 'c1', timestamp: new Date().toISOString() },
    } as never;
  }

  it('propagates a DB rejection out of handlePolicyViolationEvent', async () => {
    vi.mocked(db.select).mockImplementationOnce(() => {
      throw new Error('db exploded');
    });

    await expect(handlePolicyViolationEvent(event('policy.violation', 'org-1'))).rejects.toThrow('db exploded');
  });

  it('propagates a DB rejection out of handlePolicyCompliantEvent', async () => {
    vi.mocked(db.select).mockImplementationOnce(() => {
      throw new Error('db exploded');
    });

    await expect(handlePolicyCompliantEvent(event('policy.compliant', 'org-1'))).rejects.toThrow('db exploded');
  });

  it('handlePolicyViolationEvent creates an alert on the happy path', async () => {
    mockSelectOnce([{ id: POLICY_ID, orgId: 'org-1', partnerId: null }]);
    mockSelectOnce([]); // reconcile compliance lookup: no row — proceeds
    mockSelectOnce([{ id: 'rule-1' }]);

    await handlePolicyViolationEvent(event('policy.violation', 'org-1'));

    expect(vi.mocked(createAlert)).toHaveBeenCalledTimes(1);
  });
});

// #4085 Task 10: the event is a wake-up, not the truth. automation_policy_compliance
// (upserted by policyEvaluationService BEFORE the policy.violation/compliant events
// publish) holds the current per-(policy, device) status. A delayed/retried
// policy.violation that lands after a newer policy.compliant must not create a
// stale alert — FIFO can't guarantee this, since a failed violation delivery can
// retry after a later compliant already landed.
describe('handlePolicyViolation reconciles against persisted compliance state (#4085 Task 10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does NOT create an alert when the persisted compliance row says compliant (stale/reordered violation)', async () => {
    // 1) policy lookup, 2) reconcile compliance lookup (status: compliant —
    // the persisted state has already moved on).
    mockSelectOnce([{ id: POLICY_ID, orgId: 'org-1', partnerId: null }]);
    mockSelectOnce([{ status: 'compliant' }]);

    await handlePolicyViolation('org-1', payload());

    expect(vi.mocked(createAlert)).not.toHaveBeenCalled();
    // ensureRule's alertRules lookup never runs — the reconcile check short-circuits.
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(2);
  });

  it('proceeds when the persisted compliance row says non_compliant', async () => {
    mockSelectOnce([{ id: POLICY_ID, orgId: 'org-1', partnerId: null }]);
    mockSelectOnce([{ status: 'non_compliant' }]);
    mockSelectOnce([{ id: 'rule-1' }]);

    await handlePolicyViolation('org-1', payload());

    expect(vi.mocked(createAlert)).toHaveBeenCalledTimes(1);
  });

  it('proceeds when no compliance row exists at all (evaluation row deleted — keep today\'s behavior)', async () => {
    mockSelectOnce([{ id: POLICY_ID, orgId: 'org-1', partnerId: null }]);
    mockSelectOnce([]);
    mockSelectOnce([{ id: 'rule-1' }]);

    await handlePolicyViolation('org-1', payload());

    expect(vi.mocked(createAlert)).toHaveBeenCalledTimes(1);
  });

  it('pins the reconcile predicate to (policyId AND deviceId), not a lookalike (e.g. deviceId alone), and orders by most-recently-updated', async () => {
    const capturedWheres: unknown[] = [];
    const capturedOrderBys: unknown[] = [];

    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: POLICY_ID, orgId: 'org-1', partnerId: null }]),
          }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation((predicate: unknown) => {
            capturedWheres.push(predicate);
            return {
              orderBy: vi.fn().mockImplementation((orderByArg: unknown) => {
                capturedOrderBys.push(orderByArg);
                return { limit: vi.fn().mockResolvedValue([]) };
              }),
            };
          }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: 'rule-1' }]),
          }),
        }),
      } as any);

    await handlePolicyViolation('org-1', payload());

    expect(capturedWheres).toHaveLength(1);
    // Independently build the expected predicate from the SAME (mocked) column
    // refs and the SAME real drizzle-orm `and`/`eq`. If the implementation used
    // the wrong columns (e.g. just deviceId), an OR instead of AND, or swapped
    // the two values, the compiled query shape or bound params would diverge
    // and this deep-equal would fail — a plain "was .where() called" check
    // would pass regardless (vacuous-assertion trap, see repo memory).
    const expectedPredicate = and(
      eq(automationPolicyCompliance.policyId, POLICY_ID),
      eq(automationPolicyCompliance.deviceId, DEVICE_ID),
    );
    expect(capturedWheres[0]).toEqual(expectedPredicate);

    expect(capturedOrderBys).toHaveLength(1);
    // Same discipline for the ORDER BY: a duplicate (policy, device) compliance
    // row must not be picked arbitrarily — the most-recently-updated row wins.
    const expectedOrderBy = desc(automationPolicyCompliance.updatedAt);
    expect(capturedOrderBys[0]).toEqual(expectedOrderBy);
  });
});
