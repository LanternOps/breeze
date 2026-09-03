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
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId' },
  alerts: { deviceId: 'alerts.deviceId', configItemName: 'alerts.configItemName', status: 'alerts.status', id: 'alerts.id', orgId: 'alerts.orgId', context: 'alerts.context', suppressedUntil: 'alerts.suppressedUntil' },
  configPolicyFeatureLinks: { featureType: 'configPolicyFeatureLinks.featureType', inlineSettings: 'configPolicyFeatureLinks.inlineSettings', configPolicyId: 'configPolicyFeatureLinks.configPolicyId' },
  configPolicyAssignments: { configPolicyId: 'configPolicyAssignments.configPolicyId', targetId: 'configPolicyAssignments.targetId', level: 'configPolicyAssignments.level', priority: 'configPolicyAssignments.priority' },
  configurationPolicies: { id: 'configurationPolicies.id', status: 'configurationPolicies.status', orgId: 'configurationPolicies.orgId', partnerId: 'configurationPolicies.partnerId' },
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

/**
 * The auto-resolve UPDATE is a compare-and-swap since #4094: it chains
 * `.returning({id})` and skips the `alert.resolved` publish when the result is
 * empty. `where(...)` must therefore still be awaitable (nothing else in this file
 * chains past it) AND expose `returning`.
 *
 * Defaults to a one-row winner so the existing auto-resolve assertions keep
 * asserting a publish; pass `[]` to model losing the race to another resolver.
 */
function casWhere(returning: unknown[] = [{ id: 'alert-1' }]) {
  return Object.assign(Promise.resolve(undefined), {
    returning: vi.fn().mockResolvedValue(returning),
  });
}

function stubAutoResolve() {
  // autoResolveWarrantyAlerts: select open alerts (resolves to []), then nothing to update.
  const set = vi.fn().mockReturnValue({ where: vi.fn(() => casWhere()) });
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
    // 4: device org row (resolveWarrantySettings, for the partner axis) → no partner
    selectMock.mockReturnValueOnce(queueSelect([{ partnerId: null }]));
    // 5: device group memberships → none
    selectMock.mockReturnValueOnce(queueSelect([]));
    // 6: warranty feature links → NONE assigned ⇒ DISABLED_SETTINGS ⇒ gate trips
    selectMock.mockReturnValueOnce(queueSelect([]));
    // 7: disabled path now auto-resolves; open-alert select → none
    selectMock.mockReturnValueOnce(queueSelect([]));

    const result = await evaluateWarrantyAlerts(DEVICE_ID);

    expect(result).toBeNull();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('reports loudly when the device org row does not resolve, instead of silently degrading (#3963)', async () => {
    stubAutoResolve();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    // 1: warranty row  2: device row (evaluate)  3: device row (resolveWarrantySettings)
    selectMock.mockReturnValueOnce(queueSelect([baseWarranty]));
    selectMock.mockReturnValueOnce(queueSelect([baseDevice]));
    selectMock.mockReturnValueOnce(queueSelect([{ orgId: ORG_ID, siteId: null }]));
    // 4: device org row → EMPTY. Unreachable via the schema (devices.org_id is
    // NOT NULL with an FK to organizations.id), so it means an invariant broke.
    // Without the guard this degrades to exactly the org-only resolution #3963
    // fixes — silently, and indistinguishably from "no policy configured".
    selectMock.mockReturnValueOnce(queueSelect([]));
    // 5: device group memberships  6: warranty feature links  7: auto-resolve open alerts
    selectMock.mockReturnValueOnce(queueSelect([]));
    selectMock.mockReturnValueOnce(queueSelect([]));
    selectMock.mockReturnValueOnce(queueSelect([]));

    const result = await evaluateWarrantyAlerts(DEVICE_ID);

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(ORG_ID));
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('partner-wide'));
    // Resolution still completes rather than throwing — warranty alerting degrades.
    expect(result).toBeNull();
    consoleError.mockRestore();
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
    // 4: device org row (resolveWarrantySettings, for the partner axis) → no partner
    selectMock.mockReturnValueOnce(queueSelect([{ partnerId: null }]));
    // 5: device group memberships → none
    selectMock.mockReturnValueOnce(queueSelect([]));
    // 6: warranty feature link, enabled at org level
    selectMock.mockReturnValueOnce(
      queueSelect([{ inlineSettings: { enabled: true, warnDays: 90, criticalDays: 30 }, level: 'organization', priority: 0 }])
    );
    // 7: existing open warranty alert check → none
    selectMock.mockReturnValueOnce(queueSelect([]));
    // 8: dismissed warranty alert check → none
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
    // 4: device org row (resolveWarrantySettings, for the partner axis) → no partner
    selectMock.mockReturnValueOnce(queueSelect([{ partnerId: null }]));
    // 5: device group memberships → none
    selectMock.mockReturnValueOnce(queueSelect([]));
    // 6: warranty feature link present but enabled=false ⇒ gate trips
    selectMock.mockReturnValueOnce(
      queueSelect([{ inlineSettings: { enabled: false, warnDays: 90, criticalDays: 30 }, level: 'organization', priority: 0 }])
    );
    // 7: disabled path now auto-resolves; open-alert select → none
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
    const set = vi.fn().mockReturnValue({ where: vi.fn(() => casWhere()) });
    updateMock.mockReturnValue({ set });

    // 1: warranty row (expiring, fixed-term) → reaches policy resolution
    selectMock.mockReturnValueOnce(queueSelect([baseWarranty]));
    // 2: device row (evaluate)
    selectMock.mockReturnValueOnce(queueSelect([baseDevice]));
    // 3: device row (resolveWarrantySettings)
    selectMock.mockReturnValueOnce(queueSelect([{ orgId: ORG_ID, siteId: null }]));
    // 4: device org row (resolveWarrantySettings, for the partner axis) → no partner
    selectMock.mockReturnValueOnce(queueSelect([{ partnerId: null }]));
    // 5: device group memberships → none
    selectMock.mockReturnValueOnce(queueSelect([]));
    // 6: warranty feature links → NONE assigned ⇒ DISABLED_SETTINGS ⇒ gate trips
    selectMock.mockReturnValueOnce(queueSelect([]));
    // 7: autoResolveWarrantyAlerts open-alert select → an existing open (active) alert
    selectMock.mockReturnValueOnce(
      queueSelect([{ id: 'alert-stranded-1', orgId: ORG_ID, deviceId: DEVICE_ID, status: 'active', triggeredAt: new Date('2026-01-01T00:00:00.000Z') }])
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

  it('does NOT re-create an alert the user has DISMISSED (permanent dismissal)', async () => {
    // 1: warranty row (expiring, fixed-term)
    selectMock.mockReturnValueOnce(queueSelect([baseWarranty]));
    // 2: device row (evaluate)
    selectMock.mockReturnValueOnce(queueSelect([baseDevice]));
    // 3: device row (resolveWarrantySettings)
    selectMock.mockReturnValueOnce(queueSelect([{ orgId: ORG_ID, siteId: null }]));
    // 4: device org row (resolveWarrantySettings, for the partner axis) → no partner
    selectMock.mockReturnValueOnce(queueSelect([{ partnerId: null }]));
    // 5: device group memberships → none
    selectMock.mockReturnValueOnce(queueSelect([]));
    // 6: warranty feature link, enabled at org level
    selectMock.mockReturnValueOnce(
      queueSelect([{ inlineSettings: { enabled: true, warnDays: 90, criticalDays: 30 }, level: 'organization', priority: 0 }])
    );
    // 7: existing open warranty alert check → none (it was dismissed, not open)
    selectMock.mockReturnValueOnce(queueSelect([]));
    // 8: dismissed warranty alert check (scoped to this warranty end date) → HIT
    selectMock.mockReturnValueOnce(queueSelect([{ id: 'alert-dismissed-1' }]));

    const result = await evaluateWarrantyAlerts(DEVICE_ID);

    expect(result).toBeNull();
    expect(insertMock).not.toHaveBeenCalled();
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it('auto-resolves a stale TIMED-SUPPRESSED expiry alert when the device is now a subscription (#1320)', async () => {
    const set = vi.fn().mockReturnValue({ where: vi.fn(() => casWhere()) });
    updateMock.mockReturnValue({ set });

    // 1: warranty row flagged as a subscription → short-circuits to autoResolve
    selectMock.mockReturnValueOnce(
      queueSelect([{ ...baseWarranty, status: 'subscription_active', isSubscription: true, warrantyEndDate: inDays(28) }])
    );
    // 2: autoResolveWarrantyAlerts open-alert select → a stale TIMED-suppressed
    // alert (suppressedUntil set). Timed suppressions still auto-resolve; only
    // indefinite "Forever" suppressions (suppressedUntil NULL) are excluded from
    // this query — that carve-out is verified in the integration test since the
    // mock here ignores the WHERE predicate.
    selectMock.mockReturnValueOnce(
      queueSelect([{ id: 'alert-suppressed-1', orgId: ORG_ID, deviceId: DEVICE_ID, status: 'suppressed', suppressedUntil: new Date(Date.now() + 86_400_000), triggeredAt: new Date('2026-01-01T00:00:00.000Z') }])
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
