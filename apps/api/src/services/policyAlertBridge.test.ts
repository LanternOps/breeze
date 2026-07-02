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
}));

vi.mock('./alertService', () => ({
  createAlert: vi.fn().mockResolvedValue('alert-created-1'),
  resolveAlert: vi.fn(),
}));

vi.mock('./eventBus', () => ({
  getEventBus: vi.fn(),
}));

import { db } from '../db';
import { createAlert } from './alertService';
import { handlePolicyViolation } from './policyAlertBridge';

function mockSelectOnce(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
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
    // 1) policy lookup, 2) ensureRule's alertRules lookup (existing rule, so
    // ensureTemplate/insert paths are never reached).
    mockSelectOnce([{ id: POLICY_ID, orgId: 'org-1', partnerId: null }]);
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
    // org's partnerId, 3) ensureRule's alertRules lookup (existing rule).
    mockSelectOnce([{ id: POLICY_ID, orgId: null, partnerId: 'partner-1' }]);
    mockSelectOnce([{ partnerId: 'partner-1' }]);
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
