import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { rows, resolveAlert, captureException, resolveAssignment } = vi.hoisted(() => ({
  rows: [] as unknown[][],
  resolveAlert: vi.fn(async () => true),
  captureException: vi.fn(),
  resolveAssignment: vi.fn(async () => null),
}));
vi.mock('../db', () => {
  const chain = (): unknown => new Proxy(() => {}, {
    get: (_target, key) => key === 'then'
      ? (resolve: (value: unknown) => void) => Promise.resolve(rows.shift() ?? []).then(resolve)
      : () => chain(),
  });
  return { db: { select: chain, selectDistinct: chain }, withSystemDbAccessContext: (fn: () => unknown) => fn() };
});
vi.mock('./alertService', () => ({ resolveAlert, RESOLVABLE_ALERT_STATUSES: ['active', 'acknowledged', 'suppressed'] }));
vi.mock('./sentry', () => ({ captureException }));
vi.mock('./featureConfigResolver', () => ({ resolveComplianceAssignmentForDevice: resolveAssignment }));
vi.mock('./configComplianceAlertBridge', () => ({ CONFIG_COMPLIANCE_ALERT_SOURCE: 'config', CONFIG_COMPLIANCE_RULE_PREFIX: 'config' }));
vi.mock('./policyAlertBridge', () => ({ POLICY_ALERT_SOURCE: 'policy', POLICY_RULE_PREFIX: 'policy' }));
vi.mock('./policyEvaluationService', () => ({ automationPolicyIsObserveOnly: vi.fn(), automationPolicyTargetedDeviceIds: vi.fn() }));

import { reconcileComplianceAlerts } from './complianceAlertReconcile';
const policyId = '11111111-1111-4111-8111-111111111111';
const alert = (id: string, deviceId: string | null) => ({
  id, deviceId, context: { configPolicyFeatureLinkId: 'link-1', configPolicyComplianceRuleName: 'rule-1' }, overrideSettings: {},
});

beforeEach(() => {
  rows.length = 0;
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('compliance alert ownership guard recovery', () => {
  it('reports a device-less page entry with scope and continues to the next device', async () => {
    rows.push([{ deviceId: null }, { deviceId: 'device-2' }], [alert('good-alert', 'device-2')], [], [], []);
    await expect(reconcileComplianceAlerts({ orgId: 'org-1' })).resolves.toMatchObject({ alertsResolved: 1, devicesChecked: 2 });
    expect(resolveAlert).toHaveBeenCalledWith('good-alert', expect.any(String), undefined, false, 'source_retired');
    expect(captureException).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/alert_has_no_device.*org-1/) }));
  });

  it('reports a malformed configuration alert by id and continues other rows', async () => {
    rows.push([{ deviceId: 'device-2' }], [alert('bad-config-alert', null), alert('good-config-alert', 'device-2')], [], [], []);
    await expect(reconcileComplianceAlerts({ orgId: 'org-1' })).resolves.toMatchObject({ alertsResolved: 1 });
    expect(resolveAlert).toHaveBeenCalledWith('good-config-alert', expect.any(String), undefined, false, 'source_retired');
    expect(captureException).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/bad-config-alert.*device-2/) }));
  });

  it('reports a malformed automation alert by id and continues other rows in the policy', async () => {
    rows.push([], [{ policyId }], [alert('bad-policy-alert', null), alert('good-policy-alert', 'device-2')], []);
    await expect(reconcileComplianceAlerts({ partnerId: 'partner-1' })).resolves.toMatchObject({ policiesChecked: 1, alertsResolved: 1 });
    expect(resolveAlert).toHaveBeenCalledWith('good-policy-alert', expect.any(String), undefined, false, 'source_retired');
    expect(captureException).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(new RegExp(`bad-policy-alert.*${policyId}`)) }));
  });
});
