import { beforeEach, describe, expect, it, vi } from 'vitest';

// Exercise evaluateWarrantyAlerts through the real gating logic without a live DB.
// Drizzle's fluent builder is stubbed per-query in call order (see queueSelect).
const selectMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
    insert: (...args: unknown[]) => insertMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
  },
}));

vi.mock('../db/schema', () => ({
  deviceWarranty: { deviceId: 'deviceWarranty.deviceId' },
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId' },
  alerts: { deviceId: 'alerts.deviceId', configItemName: 'alerts.configItemName', status: 'alerts.status', id: 'alerts.id', orgId: 'alerts.orgId' },
  configPolicyFeatureLinks: { featureType: 'configPolicyFeatureLinks.featureType', inlineSettings: 'configPolicyFeatureLinks.inlineSettings', configPolicyId: 'configPolicyFeatureLinks.configPolicyId' },
  configPolicyAssignments: { configPolicyId: 'configPolicyAssignments.configPolicyId', targetId: 'configPolicyAssignments.targetId', level: 'configPolicyAssignments.level', priority: 'configPolicyAssignments.priority' },
  configurationPolicies: { id: 'configurationPolicies.id', status: 'configurationPolicies.status' },
  deviceGroupMemberships: { deviceId: 'deviceGroupMemberships.deviceId', groupId: 'deviceGroupMemberships.groupId' },
}));

const publishEventMock = vi.fn().mockResolvedValue(undefined);
vi.mock('./eventBus', () => ({ publishEvent: (...args: unknown[]) => publishEventMock(...args) }));

import { evaluateWarrantyAlerts } from './warrantyAlertEvaluator';

const DEVICE_ID = '44444444-4444-4444-4444-444444444444';
const ORG_ID = '11111111-1111-1111-1111-111111111111';

// A terminal-agnostic select chain: every chain method returns the same thenable
// stub, and awaiting / .limit() / .where() all resolve to `rows`. This tolerates
// the different terminal calls used across the evaluator's queries.
function queueSelect(rows: unknown[]) {
  const result = Promise.resolve(rows);
  const chain: any = {
    from: () => chain,
    where: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    limit: () => result,
    orderBy: () => result,
    then: (...a: unknown[]) => (result.then as any)(...a),
    catch: (...a: unknown[]) => (result.catch as any)(...a),
    finally: (...a: unknown[]) => (result.finally as any)(...a),
  };
  return chain;
}

/** Future date string (YYYY-MM-DD) `days` from now. */
function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

const baseWarranty = {
  deviceId: DEVICE_ID,
  orgId: ORG_ID,
  manufacturer: 'apple',
  serialNumber: 'ABC123',
  status: 'expiring' as const,
  warrantyEndDate: inDays(10), // within criticalDays
  isSubscription: false,
};

const baseDevice = {
  id: DEVICE_ID,
  orgId: ORG_ID,
  siteId: null,
  displayName: 'Test Mac',
  hostname: 'test-mac',
};

function captureInsert() {
  const returning = vi.fn().mockResolvedValue([{ id: 'alert-1' }]);
  const values = vi.fn().mockReturnValue({ returning });
  insertMock.mockReturnValue({ values });
  return { values, returning };
}

function stubAutoResolve() {
  // autoResolveWarrantyAlerts: select open alerts (resolves to []), then nothing to update.
  const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  updateMock.mockReturnValue({ set });
  return set;
}

describe('evaluateWarrantyAlerts gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    publishEventMock.mockResolvedValue(undefined);
  });

  it('does NOT fire when no warranty policy is assigned (opt-in default, #1320 Bug 1)', async () => {
    stubAutoResolve();
    // 1: warranty row (expiring, fixed-term) → passes the unknown/no-date/subscription guards
    selectMock.mockReturnValueOnce(queueSelect([baseWarranty]));
    // 2: device row (evaluate)
    selectMock.mockReturnValueOnce(queueSelect([baseDevice]));
    // 3: device row (resolveWarrantySettings)
    selectMock.mockReturnValueOnce(queueSelect([{ orgId: ORG_ID, siteId: null }]));
    // 4: device group memberships → none
    selectMock.mockReturnValueOnce(queueSelect([]));
    // 5: warranty feature links → NONE assigned ⇒ DISABLED_SETTINGS ⇒ gate trips
    selectMock.mockReturnValueOnce(queueSelect([]));
    // 6: disabled path now auto-resolves; open-alert select → none
    selectMock.mockReturnValueOnce(queueSelect([]));

    const result = await evaluateWarrantyAlerts(DEVICE_ID);

    expect(result).toBeNull();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('does NOT fire for an active AppleCare subscription even within threshold (#1320 Bug 2)', async () => {
    stubAutoResolve();
    // 1: warranty row flagged as a subscription whose end date rolls ~30 days out
    selectMock.mockReturnValueOnce(
      queueSelect([{ ...baseWarranty, status: 'subscription_active', isSubscription: true, warrantyEndDate: inDays(28) }])
    );
    // autoResolveWarrantyAlerts: select open alerts → none
    selectMock.mockReturnValueOnce(queueSelect([]));

    const result = await evaluateWarrantyAlerts(DEVICE_ID);

    expect(result).toBeNull();
    expect(insertMock).not.toHaveBeenCalled();
    // It must NOT reach the policy resolution (only the warranty + autoResolve selects ran)
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it('FIRES for fixed-term coverage within threshold when a warranty policy enables it', async () => {
    const { values } = captureInsert();
    // 1: warranty row (expiring, fixed-term, not a subscription)
    selectMock.mockReturnValueOnce(queueSelect([baseWarranty]));
    // 2: device row (evaluate)
    selectMock.mockReturnValueOnce(queueSelect([baseDevice]));
    // 3: device row (resolveWarrantySettings)
    selectMock.mockReturnValueOnce(queueSelect([{ orgId: ORG_ID, siteId: null }]));
    // 4: device group memberships → none
    selectMock.mockReturnValueOnce(queueSelect([]));
    // 5: warranty feature link, enabled at org level
    selectMock.mockReturnValueOnce(
      queueSelect([{ inlineSettings: { enabled: true, warnDays: 90, criticalDays: 30 }, level: 'organization', priority: 0 }])
    );
    // 6: existing open warranty alert check → none
    selectMock.mockReturnValueOnce(queueSelect([]));

    const result = await evaluateWarrantyAlerts(DEVICE_ID);

    expect(result).toBe('alert-1');
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ configItemName: 'warranty_expiry', deviceId: DEVICE_ID, severity: 'critical' })
    );
    expect(publishEventMock).toHaveBeenCalledWith(
      'alert.triggered',
      ORG_ID,
      expect.objectContaining({ source: 'warranty_evaluator' }),
      expect.any(String)
    );
  });

  it('does NOT fire for fixed-term coverage when the assigned policy disables warranty alerts', async () => {
    stubAutoResolve();
    // 1: warranty row (expiring, fixed-term)
    selectMock.mockReturnValueOnce(queueSelect([baseWarranty]));
    // 2: device row (evaluate)
    selectMock.mockReturnValueOnce(queueSelect([baseDevice]));
    // 3: device row (resolveWarrantySettings)
    selectMock.mockReturnValueOnce(queueSelect([{ orgId: ORG_ID, siteId: null }]));
    // 4: device group memberships → none
    selectMock.mockReturnValueOnce(queueSelect([]));
    // 5: warranty feature link present but enabled=false ⇒ gate trips
    selectMock.mockReturnValueOnce(
      queueSelect([{ inlineSettings: { enabled: false, warnDays: 90, criticalDays: 30 }, level: 'organization', priority: 0 }])
    );
    // 6: disabled path now auto-resolves; open-alert select → none
    selectMock.mockReturnValueOnce(queueSelect([]));

    const result = await evaluateWarrantyAlerts(DEVICE_ID);

    expect(result).toBeNull();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('auto-resolves a STRANDED open expiry alert when settings now resolve to disabled (#1320)', async () => {
    // Regression: warranty alerting is now opt-in, so a device with an open alert
    // created under the old enabled-by-default behavior must have it auto-resolved
    // once it resolves to disabled — otherwise the gate at `if (!settings.enabled)`
    // returns BEFORE the cleanup and the alert is stranded active forever.
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    updateMock.mockReturnValue({ set });

    // 1: warranty row (expiring, fixed-term) → reaches policy resolution
    selectMock.mockReturnValueOnce(queueSelect([baseWarranty]));
    // 2: device row (evaluate)
    selectMock.mockReturnValueOnce(queueSelect([baseDevice]));
    // 3: device row (resolveWarrantySettings)
    selectMock.mockReturnValueOnce(queueSelect([{ orgId: ORG_ID, siteId: null }]));
    // 4: device group memberships → none
    selectMock.mockReturnValueOnce(queueSelect([]));
    // 5: warranty feature links → NONE assigned ⇒ DISABLED_SETTINGS ⇒ gate trips
    selectMock.mockReturnValueOnce(queueSelect([]));
    // 6: autoResolveWarrantyAlerts open-alert select → an existing open (active) alert
    selectMock.mockReturnValueOnce(
      queueSelect([{ id: 'alert-stranded-1', orgId: ORG_ID, deviceId: DEVICE_ID, status: 'active' }])
    );

    const result = await evaluateWarrantyAlerts(DEVICE_ID);

    expect(result).toBeNull();
    expect(insertMock).not.toHaveBeenCalled();
    // The stranded alert was updated to resolved.
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: 'resolved' }));
    expect(publishEventMock).toHaveBeenCalledWith(
      'alert.resolved',
      ORG_ID,
      expect.objectContaining({ alertId: 'alert-stranded-1' }),
      expect.any(String)
    );
  });

  it('returns null and never resolves policy when there is no warranty record', async () => {
    selectMock.mockReturnValueOnce(queueSelect([])); // no warranty row

    const result = await evaluateWarrantyAlerts(DEVICE_ID);

    expect(result).toBeNull();
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('auto-resolves a STALE SUPPRESSED expiry alert when the device is now a subscription (#1320)', async () => {
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    updateMock.mockReturnValue({ set });

    // 1: warranty row flagged as a subscription → short-circuits to autoResolve
    selectMock.mockReturnValueOnce(
      queueSelect([{ ...baseWarranty, status: 'subscription_active', isSubscription: true, warrantyEndDate: inDays(28) }])
    );
    // 2: autoResolveWarrantyAlerts open-alert select → a stale SUPPRESSED alert.
    // Before the fix this status was excluded, so it would never clear yet still
    // block a fresh alert via the dedupe gate.
    selectMock.mockReturnValueOnce(
      queueSelect([{ id: 'alert-suppressed-1', orgId: ORG_ID, deviceId: DEVICE_ID, status: 'suppressed' }])
    );

    const result = await evaluateWarrantyAlerts(DEVICE_ID);

    expect(result).toBeNull();
    // The suppressed alert was updated to resolved.
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'resolved' })
    );
    expect(publishEventMock).toHaveBeenCalledWith(
      'alert.resolved',
      ORG_ID,
      expect.objectContaining({ alertId: 'alert-suppressed-1' }),
      expect.any(String)
    );
  });
});
