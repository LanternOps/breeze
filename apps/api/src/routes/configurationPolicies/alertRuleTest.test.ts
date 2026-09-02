import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Config-policy alert rules (`config_policy_alert_rules` rows) have no stable
// id — the read path strips it and the save path deletes-and-recreates the
// whole set — so the sibling `POST /alerts/rules/:id/test` endpoint (which
// addresses a rule BY id) is structurally unreachable from the policy editor.
// This endpoint takes the draft CONDITIONS directly instead (#3988).
//
// These tests pin the same honesty contract #3752/#3923 established for the
// standalone endpoint: a verdict must reflect the REAL evaluator run against
// the REAL device, `wouldTrigger` must fold in targeting (a rule whose
// conditions are met but that does not govern this device must never report
// true), and the response must never resurrect the old fabricated
// `success`/`message` fields. It also pins two tenancy gates the route
// enforces itself (the device's org via `auth.canAccessOrg`, and the device's
// site via `siteAccessCheck`) because the governance resolver runs in a
// system RLS context and cannot be trusted as the tenancy boundary.

const {
  authRef,
  selectQueue,
  policyRef,
  governingRef,
  evaluateConditionsMock,
} = vi.hoisted(() => ({
  authRef: { current: {} as any },
  selectQueue: [] as unknown[][],
  policyRef: { current: undefined as Record<string, unknown> | undefined },
  governingRef: {
    current: { outcome: 'unassigned' } as
      | { outcome: 'governs' }
      | { outcome: 'outranked'; winningPolicyId: string }
      | { outcome: 'unassigned' },
  },
  evaluateConditionsMock: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({
  requireScope: () => async (c: any, next: any) => { c.set('auth', authRef.current); await next(); },
  requirePermission: () => async (_c: any, next: any) => next(),
  siteAccessCheck: (allowed?: string[]) => (siteId?: string | null) =>
    !allowed ? true : (!siteId ? false : allowed.includes(siteId)),
}));

vi.mock('../../db/schema', () => ({
  devices: {
    id: 'device.id',
    orgId: 'device.orgId',
    siteId: 'device.siteId',
    hostname: 'device.hostname',
    osType: 'device.osType',
  },
}));

vi.mock('../../db', () => {
  const makeSelect = () => {
    const chain: any = {
      from: () => chain,
      where: () => chain,
      limit: () => chain,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(selectQueue.shift() ?? []).then(resolve),
    };
    return chain;
  };
  return {
    db: {
      select: vi.fn(() => makeSelect()),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  };
});

vi.mock('../../services/configurationPolicy', () => ({
  getConfigPolicy: vi.fn(async () => policyRef.current),
}));

vi.mock('../../services/featureConfigResolver', () => ({
  resolveGoverningAlertRulePolicyForDevice: vi.fn(async () => governingRef.current),
}));

vi.mock('../../services/alertConditions', () => ({
  evaluateConditions: evaluateConditionsMock,
}));

import { alertRuleTestRoutes } from './alertRuleTest';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_SITE_ID = '2a2a2a2a-2222-4222-8222-222222222222';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';
const POLICY_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_POLICY_ID = '5a5a5a5a-5555-4555-8555-555555555555';

const DEVICE = { id: DEVICE_ID, orgId: ORG_ID, siteId: SITE_ID, hostname: 'ws-01', osType: 'windows' };
const POLICY = { id: POLICY_ID, name: 'Fleet baseline' };
const VALID_BODY = {
  deviceId: DEVICE_ID,
  conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 80 }],
};

function app() {
  const instance = new Hono();
  instance.route('/configuration-policies', alertRuleTestRoutes);
  return instance;
}

async function runTest(body: unknown = VALID_BODY, policyId: string = POLICY_ID) {
  return app().request(`/configuration-policies/${policyId}/alert-rules/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /configuration-policies/:id/alert-rules/test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectQueue.length = 0;
    policyRef.current = POLICY;
    governingRef.current = { outcome: 'governs' };
    authRef.current = {
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      allowedSiteIds: undefined,
      canAccessOrg: () => true,
      user: { id: 'user-1' },
    };
    evaluateConditionsMock.mockResolvedValue({
      triggered: false,
      conditionsMet: [],
      conditionsNotMet: [],
      context: { deviceId: DEVICE_ID, evaluatedAt: '2026-08-25T00:00:00.000Z' },
    });
  });

  it('reports wouldTrigger true when the governing policy matches and the evaluator says triggered', async () => {
    selectQueue.push([DEVICE]);
    evaluateConditionsMock.mockResolvedValue({
      triggered: true,
      conditionsMet: ['cpu > 80'],
      conditionsNotMet: [],
      context: { deviceId: DEVICE_ID, evaluatedAt: '2026-08-25T00:00:00.000Z', metric: 'cpu', actualValue: 91, threshold: 80 },
    });

    const res = await runTest();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.wouldTrigger).toBe(true);
    expect(body.targetMatch).toBe(true);
    expect(body.conditionResults).toEqual([
      { condition: 'cpu > 80', result: true, reason: 'cpu > 80' },
    ]);
    expect(body.device).toEqual({ id: DEVICE_ID, hostname: 'ws-01', osType: 'windows' });
    expect(body.policy).toEqual({ id: POLICY_ID, name: 'Fleet baseline' });
    expect(body.evaluationContext).toEqual({
      deviceId: DEVICE_ID,
      evaluatedAt: '2026-08-25T00:00:00.000Z',
      metric: 'cpu',
      actualValue: 91,
      threshold: 80,
    });
  });

  it('reports wouldTrigger false and carries the unmet condition when the evaluator says not triggered, with no success/message fields', async () => {
    selectQueue.push([DEVICE]);
    evaluateConditionsMock.mockResolvedValue({
      triggered: false,
      conditionsMet: [],
      conditionsNotMet: ['cpu > 80'],
      context: { deviceId: DEVICE_ID, evaluatedAt: '2026-08-25T00:00:00.000Z' },
    });

    const res = await runTest();
    const body = await res.json();

    expect(body.wouldTrigger).toBe(false);
    expect(body.conditionResults).toEqual([
      { condition: 'cpu > 80', result: false, reason: 'cpu > 80' },
    ]);
    expect(body).not.toHaveProperty('success');
    expect(body).not.toHaveProperty('message');
  });

  it('reports wouldTrigger false and targetMatch false when conditions ARE met but another policy governs the device', async () => {
    selectQueue.push([DEVICE]);
    // Assigned to the device, but a closer/higher-priority policy wins.
    governingRef.current = { outcome: 'outranked', winningPolicyId: OTHER_POLICY_ID };
    evaluateConditionsMock.mockResolvedValue({
      triggered: true,
      conditionsMet: ['cpu > 80'],
      conditionsNotMet: [],
      context: { deviceId: DEVICE_ID, evaluatedAt: '2026-08-25T00:00:00.000Z' },
    });

    const res = await runTest();
    const body = await res.json();

    expect(body.wouldTrigger).toBe(false);
    expect(body.targetMatch).toBe(false);
    // The negative here is caused by targeting, not by the conditions — the
    // condition itself still reports as met.
    expect(body.conditionResults).toEqual([
      { condition: 'cpu > 80', result: true, reason: 'cpu > 80' },
    ]);
    expect(body.targetReason).toBeTruthy();
  });

  it('reports targetMatch false with a distinct reason when this policy is not assigned to the device', async () => {
    selectQueue.push([DEVICE]);
    governingRef.current = { outcome: 'outranked', winningPolicyId: OTHER_POLICY_ID };
    evaluateConditionsMock.mockResolvedValue({
      triggered: true,
      conditionsMet: ['cpu > 80'],
      conditionsNotMet: [],
      context: { deviceId: DEVICE_ID, evaluatedAt: '2026-08-25T00:00:00.000Z' },
    });
    const anotherPolicyGoverns = await (await runTest()).json();

    selectQueue.push([DEVICE]);
    governingRef.current = { outcome: 'unassigned' };
    const res = await runTest();
    const body = await res.json();

    expect(body.targetMatch).toBe(false);
    expect(body.wouldTrigger).toBe(false);
    expect(typeof body.targetReason).toBe('string');
    expect(body.targetReason.length).toBeGreaterThan(0);
    // A different-policy-governs negative and a no-policy-governs negative
    // must name different reasons — both being "targetMatch: false" is not
    // enough to tell the editor what to fix.
    expect(body.targetReason).not.toBe(anotherPolicyGoverns.targetReason);
  });

  it('getConfigPolicy returning undefined -> 404 without ever evaluating conditions', async () => {
    policyRef.current = undefined;

    const res = await runTest();
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'Configuration policy not found' });
    expect(evaluateConditionsMock).not.toHaveBeenCalled();
  });

  it('device row not found -> 404 without ever evaluating conditions', async () => {
    selectQueue.push([]);

    const res = await runTest();
    expect(res.status).toBe(404);
    expect(evaluateConditionsMock).not.toHaveBeenCalled();
  });

  it('device exists but auth.canAccessOrg denies -> 404 with the same message as a missing device (no tenant-existence oracle)', async () => {
    selectQueue.push([]);
    const notFoundRes = await runTest();
    const notFoundBody = await notFoundRes.json();

    selectQueue.push([DEVICE]);
    authRef.current.canAccessOrg = () => false;
    const deniedRes = await runTest();
    const deniedBody = await deniedRes.json();

    expect(deniedRes.status).toBe(404);
    expect(deniedBody).toEqual(notFoundBody);
    expect(evaluateConditionsMock).not.toHaveBeenCalled();
  });

  it('device exists, org accessible, but the device site is not in auth.allowedSiteIds -> 404', async () => {
    selectQueue.push([DEVICE]);
    authRef.current.allowedSiteIds = [OTHER_SITE_ID];

    const res = await runTest();
    expect(res.status).toBe(404);
    expect(evaluateConditionsMock).not.toHaveBeenCalled();
  });

  it('rejects an empty conditions array with 400 without evaluating', async () => {
    const res = await runTest({ deviceId: DEVICE_ID, conditions: [] });
    expect(res.status).toBe(400);
    expect(evaluateConditionsMock).not.toHaveBeenCalled();
  });

  it('rejects a retired condition type with 400 without evaluating', async () => {
    const res = await runTest({ deviceId: DEVICE_ID, conditions: [{ type: 'custom', value: 1 }] });
    expect(res.status).toBe(400);
    expect(evaluateConditionsMock).not.toHaveBeenCalled();
  });

  it('calls evaluateConditions with exactly the request conditions array and the device id', async () => {
    selectQueue.push([DEVICE]);

    await runTest();

    expect(evaluateConditionsMock).toHaveBeenCalledWith(VALID_BODY.conditions, DEVICE_ID);
  });
});
