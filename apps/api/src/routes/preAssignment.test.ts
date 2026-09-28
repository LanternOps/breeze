import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Each gate factory returns a middleware that records the request it ran for,
// so the tests can assert the gate is on EVERY route, not merely registered.
const { authState, gateHits, requirePermissionMock, requireMfaMock, enable2faState } = vi.hoisted(() => {
  const gateHits: string[] = [];
  return {
    authState: { current: null as any },
    gateHits,
    requirePermissionMock: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
      gateHits.push(`perm:${resource}:${action} ${c.req.method} ${c.req.path}`);
      return next();
    }),
    requireMfaMock: vi.fn(() => async (c: any, next: any) => {
      gateHits.push(`mfa ${c.req.method} ${c.req.path}`);
      return next();
    }),
    enable2faState: { value: true },
  };
});

// requireScope and requireInteractiveSession are the REAL middleware so the
// org-scope and machine-principal denials below test production code.
vi.mock('../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth')>();
  return {
    ...actual,
    authMiddleware: vi.fn(async (c: any, next: any) => {
      c.set('auth', authState.current);
      return next();
    }),
    requirePermission: requirePermissionMock,
    requireMfa: requireMfaMock,
  };
});

vi.mock('./auth/schemas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auth/schemas')>();
  return {
    ...actual,
    get ENABLE_2FA() {
      return enable2faState.value;
    },
  };
});

vi.mock('../services/mfaStepUpGrant', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/mfaStepUpGrant')>();
  return { ...actual, validateStepUpGrant: vi.fn(async () => true) };
});
vi.mock('../services/authEpochs', () => ({ getUserEpochs: vi.fn(async () => ({ authEpoch: 3, mfaEpoch: 4 })) }));
vi.mock('../services/unassignedPool/assignParkedDevice', () => ({
  assignParkedDevice: vi.fn(),
  assignParkedDevicesBulk: vi.fn(),
}));
vi.mock('../services/unassignedPool/parkedDeviceReads', () => ({ listParkedDevices: vi.fn(async () => []) }));
vi.mock('../services/unassignedPool/incidentActions', () => ({
  setDeployKeyEnrollmentSwitch: vi.fn(),
  expireDevicesParkedByDeployKey: vi.fn(),
}));
vi.mock('../services/auditEvents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/auditEvents')>();
  return { ...actual, writeAuditEvent: vi.fn() };
});
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

import { preAssignmentRoutes } from './preAssignment';
import { assignParkedDevice, assignParkedDevicesBulk } from '../services/unassignedPool/assignParkedDevice';
import { listParkedDevices } from '../services/unassignedPool/parkedDeviceReads';
import { expireDevicesParkedByDeployKey, setDeployKeyEnrollmentSwitch } from '../services/unassignedPool/incidentActions';
import { writeAuditEvent } from '../services/auditEvents';
import { validateStepUpGrant, parkedAssignResourceDigest, parkedBulkAssignResourceDigest, preAssignmentEnableResourceDigest } from '../services/mfaStepUpGrant';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { PERMISSIONS } from '../services/permissions';

const registeredPermissions = (requirePermissionMock.mock.calls as unknown as unknown[][]).map((c) => c.join(':'));

const PARTNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_PARTNER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEVICE = '44444444-4444-4444-8444-444444444444';
const DEVICE_2 = '55555555-5555-4555-8555-555555555555';
const ORG = '22222222-2222-4222-8222-222222222222';
const SITE = '33333333-3333-4333-8333-333333333333';
const GRANT = '99999999-9999-4999-8999-999999999999';
const DEPLOY_KEY = '66666666-6666-4666-8666-666666666666';

function authFor(overrides: Record<string, unknown> = {}) {
  return {
    scope: 'partner',
    partnerId: PARTNER,
    partnerOrgAccess: 'all',
    orgId: null,
    user: { id: 'user-1', email: 'admin@example.com' },
    principal: { kind: 'user_session' },
    token: { mfa: true, aep: 3, mep: 4, sid: 'sid-1' },
    canAccessOrg: () => true,
    ...overrides,
  };
}

const app = new Hono();
app.route('/pre-assignment', preAssignmentRoutes);
app.onError((err: any, c) => c.json({ error: err.message }, err.status ?? 500));

const assignBody = { orgId: ORG, siteId: SITE, stepUpGrant: GRANT, possessionConfirmed: true };
const bulkBody = {
  items: [{ deviceId: DEVICE, orgId: ORG, siteId: SITE }, { deviceId: DEVICE_2, orgId: ORG, siteId: SITE }],
  stepUpGrant: GRANT,
  possessionConfirmed: true,
};

const post = (path: string, body: unknown) => app.request(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const ROUTES: Array<[string, () => Response | Promise<Response>]> = [
  ['GET /devices', () => app.request('/pre-assignment/devices')],
  ['POST /devices/:id/assign', () => post(`/pre-assignment/devices/${DEVICE}/assign`, assignBody)],
  ['POST /devices/assign-bulk', () => post('/pre-assignment/devices/assign-bulk', bulkBody)],
  ['POST /switch', () => post('/pre-assignment/switch', { enabled: false })],
  ['POST /deploy-keys/:id/expire-devices', () => post(`/pre-assignment/deploy-keys/${DEPLOY_KEY}/expire-devices`, {})],
];

beforeEach(() => {
  vi.clearAllMocks();
  gateHits.length = 0;
  enable2faState.value = true;
  authState.current = authFor();
  vi.mocked(validateStepUpGrant).mockResolvedValue(true);
  vi.mocked(assignParkedDevice).mockResolvedValue({ ok: true, deviceId: DEVICE, targetOrgId: ORG, targetSiteId: SITE, ledgerEventId: 'l1' });
  vi.mocked(assignParkedDevicesBulk).mockResolvedValue({ ok: true, results: [] });
  vi.mocked(setDeployKeyEnrollmentSwitch).mockResolvedValue({ previous: true, enabled: false });
  vi.mocked(expireDevicesParkedByDeployKey).mockResolvedValue({ matched: 0, expired: 0, skipped: 0, failed: 0 });
});

describe('pre-assignment route gates', () => {
  it('registers devices:write + organizations:write', () => {
    expect(registeredPermissions).toEqual(expect.arrayContaining([
      `${PERMISSIONS.DEVICES_WRITE.resource}:${PERMISSIONS.DEVICES_WRITE.action}`,
      `${PERMISSIONS.ORGS_WRITE.resource}:${PERMISSIONS.ORGS_WRITE.action}`,
    ]));
  });

  it.each(ROUTES)('%s runs the MFA gate and both permission gates', async (_name, call) => {
    await call();
    const request = gateHits.find((h) => h.startsWith('mfa '))?.slice(4);
    expect(request, 'MFA gate ran').toBeTruthy();
    expect(gateHits).toEqual(expect.arrayContaining([
      `mfa ${request}`,
      `perm:${PERMISSIONS.DEVICES_WRITE.resource}:${PERMISSIONS.DEVICES_WRITE.action} ${request}`,
      `perm:${PERMISSIONS.ORGS_WRITE.resource}:${PERMISSIONS.ORGS_WRITE.action} ${request}`,
    ]));
  });

  it.each(ROUTES)('%s refuses a selected-org partner user with the partner-wide 403', async (_name, call) => {
    authState.current = authFor({ partnerOrgAccess: 'selected' });
    const res = await call();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(PARTNER_WIDE_WRITE_DENIED_MESSAGE);
    expect(listParkedDevices).not.toHaveBeenCalled();
    expect(assignParkedDevice).not.toHaveBeenCalled();
    expect(assignParkedDevicesBulk).not.toHaveBeenCalled();
    expect(setDeployKeyEnrollmentSwitch).not.toHaveBeenCalled();
    expect(expireDevicesParkedByDeployKey).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('%s refuses an organization-scope user', async (_name, call) => {
    authState.current = authFor({ scope: 'organization', orgId: ORG, partnerOrgAccess: undefined });
    const res = await call();
    expect(res.status).toBe(403);
    expect(listParkedDevices).not.toHaveBeenCalled();
    expect(assignParkedDevice).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('%s refuses a non-interactive principal (API key)', async (_name, call) => {
    authState.current = authFor({ principal: { kind: 'api_key' } });
    const res = await call();
    expect(res.status).toBe(403);
    expect(assignParkedDevice).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('%s requires an explicit partnerId for system scope', async (_name, call) => {
    authState.current = authFor({ scope: 'system', partnerId: null, partnerOrgAccess: undefined });
    const res = await call();
    expect(res.status).toBe(400);
  });

  it('a partner caller cannot name another partner', async () => {
    const res = await app.request(`/pre-assignment/devices?partnerId=${OTHER_PARTNER}`);
    expect(res.status).toBe(403);
    expect(listParkedDevices).not.toHaveBeenCalled();
  });
});

describe('GET /pre-assignment/devices', () => {
  it("lists the caller's partner and labels device-reported fields", async () => {
    vi.mocked(listParkedDevices).mockResolvedValueOnce([{ id: DEVICE, hostname: 'h' } as any]);
    const res = await app.request('/pre-assignment/devices');
    expect(res.status).toBe(200);
    expect(listParkedDevices).toHaveBeenCalledWith(PARTNER);
    const body = await res.json();
    expect(body.devices).toEqual([{ id: DEVICE, hostname: 'h' }]);
    expect(body.deviceReportedFields).toEqual(expect.arrayContaining(['hostname', 'serialNumber', 'primaryMacAddress']));
    expect(body.notice).toMatch(/reported by the device/i);
  });

  it('system scope lists the partner it names', async () => {
    authState.current = authFor({ scope: 'system', partnerId: null, partnerOrgAccess: undefined });
    const res = await app.request(`/pre-assignment/devices?partnerId=${OTHER_PARTNER}`);
    expect(res.status).toBe(200);
    expect(listParkedDevices).toHaveBeenCalledWith(OTHER_PARTNER);
  });
});

describe('POST /pre-assignment/devices/:id/assign', () => {
  it('requires possessionConfirmed: true', async () => {
    const res = await post(`/pre-assignment/devices/${DEVICE}/assign`, { ...assignBody, possessionConfirmed: false });
    expect(res.status).toBe(400);
    const missing = await post(`/pre-assignment/devices/${DEVICE}/assign`, { orgId: ORG, siteId: SITE, stepUpGrant: GRANT });
    expect(missing.status).toBe(400);
    expect(assignParkedDevice).not.toHaveBeenCalled();
  });

  it('validates a single-assignment grant bound to exactly this device and destination', async () => {
    const res = await post(`/pre-assignment/devices/${DEVICE}/assign`, assignBody);
    expect(res.status).toBe(200);
    const expectedBinding = {
      userId: 'user-1',
      operation: 'parked_device_assign',
      authEpoch: 3,
      mfaEpoch: 4,
      sid: 'sid-1',
      resourceDigest: parkedAssignResourceDigest({ deviceId: DEVICE, targetOrgId: ORG, targetSiteId: SITE }),
    };
    expect(validateStepUpGrant).toHaveBeenCalledWith(GRANT, expectedBinding);
    expect(assignParkedDevice).toHaveBeenCalledWith(expect.objectContaining({
      actor: { auth: authState.current, partnerId: PARTNER, allowedSiteIds: undefined },
      item: { deviceId: DEVICE, targetOrgId: ORG, targetSiteId: SITE, acceptIdentityCollision: false },
      stepUp: { grantId: GRANT, binding: expectedBinding },
    }));
  });

  it('answers 403 STEP_UP_REQUIRED for a missing or non-validating grant, before the service', async () => {
    const noGrant = await post(`/pre-assignment/devices/${DEVICE}/assign`, { orgId: ORG, siteId: SITE, possessionConfirmed: true });
    expect(noGrant.status).toBe(403);
    expect((await noGrant.json()).code).toBe('STEP_UP_REQUIRED');
    vi.mocked(validateStepUpGrant).mockResolvedValueOnce(false);
    const bad = await post(`/pre-assignment/devices/${DEVICE}/assign`, assignBody);
    expect(bad.status).toBe(403);
    expect(assignParkedDevice).not.toHaveBeenCalled();
  });

  it('with 2FA off, passes no step-up binding', async () => {
    enable2faState.value = false;
    const res = await post(`/pre-assignment/devices/${DEVICE}/assign`, { orgId: ORG, siteId: SITE, possessionConfirmed: true });
    expect(res.status).toBe(200);
    expect(assignParkedDevice).toHaveBeenCalledWith(expect.objectContaining({ stepUp: null }));
  });

  it.each([
    ['DEVICE_NOT_FOUND', 404],
    ['DEVICE_NOT_PARKED', 409],
    ['DEVICE_NOT_ASSIGNABLE', 409],
    ['DEVICE_PARKING_EXPIRED', 409],
    ['TARGET_ORG_INVALID', 400],
    ['TARGET_SITE_INVALID', 400],
    ['DEVICE_IDENTITY_COLLISION', 409],
    ['PARTNER_DEVICE_LIMIT_REACHED', 409],
    ['STEP_UP_REQUIRED', 403],
    ['POOL_MEMBERSHIP_REFUSED', 409],
    ['TICKET_MOVE_CURRENCY_BLOCKED', 409],
    ['PAM_DEVICE_MOVE_BLOCKED', 409],
    ['DELIVERABLE_TICKET_PINNED', 409],
  ])('maps %s to %i with its code', async (code, status) => {
    vi.mocked(assignParkedDevice).mockResolvedValueOnce({ ok: false, deviceId: DEVICE, code: code as any, message: 'm' });
    const res = await post(`/pre-assignment/devices/${DEVICE}/assign`, assignBody);
    expect(res.status).toBe(status);
    expect((await res.json()).code).toBe(code);
  });

  it('answers a lost lock race with 409 ASSIGNMENT_BUSY and Retry-After', async () => {
    vi.mocked(assignParkedDevice).mockResolvedValueOnce({ ok: false, deviceId: DEVICE, code: 'ASSIGNMENT_BUSY' as any, message: 'm' });
    const res = await post(`/pre-assignment/devices/${DEVICE}/assign`, assignBody);
    expect(res.status).toBe(409);
    expect(res.headers.get('Retry-After')).toBe('2');
    expect((await res.json()).code).toBe('ASSIGNMENT_BUSY');
  });

  it('answers 500 without detail when the service throws', async () => {
    vi.mocked(assignParkedDevice).mockRejectedValueOnce(new Error('db exploded'));
    const res = await post(`/pre-assignment/devices/${DEVICE}/assign`, assignBody);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('exploded');
  });
});

describe('POST /pre-assignment/devices/assign-bulk', () => {
  it('validates one grant bound to the whole batch and returns per-item results', async () => {
    vi.mocked(assignParkedDevicesBulk).mockResolvedValueOnce({
      ok: true,
      results: [
        { ok: true, deviceId: DEVICE, targetOrgId: ORG, targetSiteId: SITE, ledgerEventId: 'l1' },
        { ok: false, deviceId: DEVICE_2, code: 'DEVICE_IDENTITY_COLLISION', message: 'm' },
      ],
    });
    const res = await post('/pre-assignment/devices/assign-bulk', bulkBody);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [
        { deviceId: DEVICE, ok: true },
        { deviceId: DEVICE_2, ok: false, code: 'DEVICE_IDENTITY_COLLISION' },
      ],
    });
    const items = bulkBody.items.map((i) => ({ deviceId: i.deviceId, targetOrgId: i.orgId, targetSiteId: i.siteId }));
    expect(validateStepUpGrant).toHaveBeenCalledWith(GRANT, expect.objectContaining({
      operation: 'parked_device_assign_bulk',
      resourceDigest: parkedBulkAssignResourceDigest(items),
    }));
    expect(assignParkedDevicesBulk).toHaveBeenCalledWith(expect.objectContaining({
      items: items,
      stepUp: expect.objectContaining({ grantId: GRANT }),
    }));
  });

  it('refuses an empty batch, more than 50 items, and duplicate devices', async () => {
    expect((await post('/pre-assignment/devices/assign-bulk', { ...bulkBody, items: [] })).status).toBe(400);
    const many = Array.from({ length: 51 }, (_, i) => ({
      deviceId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, orgId: ORG, siteId: SITE,
    }));
    expect((await post('/pre-assignment/devices/assign-bulk', { ...bulkBody, items: many })).status).toBe(400);
    const dup = [bulkBody.items[0], bulkBody.items[0]];
    expect((await post('/pre-assignment/devices/assign-bulk', { ...bulkBody, items: dup })).status).toBe(400);
    expect(assignParkedDevicesBulk).not.toHaveBeenCalled();
  });

  it('requires possessionConfirmed: true', async () => {
    expect((await post('/pre-assignment/devices/assign-bulk', { ...bulkBody, possessionConfirmed: false })).status).toBe(400);
  });

  it('answers 403 STEP_UP_REQUIRED when the batch grant is burned', async () => {
    vi.mocked(assignParkedDevicesBulk).mockResolvedValueOnce({ ok: false, code: 'STEP_UP_REQUIRED' });
    const res = await post('/pre-assignment/devices/assign-bulk', bulkBody);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('STEP_UP_REQUIRED');
  });
});

describe('POST /pre-assignment/switch', () => {
  it('turning it ON requires a step-up grant bound to this partner; none -> 403, service untouched', async () => {
    const res = await post('/pre-assignment/switch', { enabled: true });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('STEP_UP_REQUIRED');
    expect(setDeployKeyEnrollmentSwitch).not.toHaveBeenCalled();
  });

  it('turning it ON validates and hands the grant to the service to consume in its transaction', async () => {
    vi.mocked(setDeployKeyEnrollmentSwitch).mockResolvedValueOnce({ previous: false, enabled: true });
    const res = await post('/pre-assignment/switch', { enabled: true, stepUpGrant: GRANT });
    expect(res.status).toBe(200);
    const binding = {
      userId: 'user-1', operation: 'pre_assignment_enable', authEpoch: 3, mfaEpoch: 4, sid: 'sid-1',
      resourceDigest: preAssignmentEnableResourceDigest({ partnerId: PARTNER }),
    };
    expect(validateStepUpGrant).toHaveBeenCalledWith(GRANT, binding);
    expect(setDeployKeyEnrollmentSwitch).toHaveBeenCalledWith({
      partnerId: PARTNER, enabled: true, stepUp: { grantId: GRANT, binding, auth: expect.objectContaining({ partnerId: PARTNER }) },
    });
  });

  it('turning it ON answers 403 when the grant is spent inside the transaction', async () => {
    vi.mocked(setDeployKeyEnrollmentSwitch).mockResolvedValueOnce('STEP_UP_REQUIRED');
    const res = await post('/pre-assignment/switch', { enabled: true, stepUpGrant: GRANT });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('STEP_UP_REQUIRED');
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });

  it('turning it OFF is instant: no step-up asked or checked', async () => {
    const res = await post('/pre-assignment/switch', { enabled: false });
    expect(res.status).toBe(200);
    expect(validateStepUpGrant).not.toHaveBeenCalled();
    expect(setDeployKeyEnrollmentSwitch).toHaveBeenCalledWith({ partnerId: PARTNER, enabled: false, stepUp: null });
  });

  it("sets the caller's partner switch and audits the change", async () => {
    const res = await post('/pre-assignment/switch', { enabled: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, previous: true });
    expect(setDeployKeyEnrollmentSwitch).toHaveBeenCalledWith({ partnerId: PARTNER, enabled: false, stepUp: null });
    expect(writeAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: null,
      action: 'partner.pre_assignment_switch.update',
      resourceType: 'partner',
      resourceId: PARTNER,
      actorId: 'user-1',
      details: expect.objectContaining({ partnerId: PARTNER, enabled: false, previous: true }),
    }));
  });

  it('requires a boolean', async () => {
    expect((await post('/pre-assignment/switch', {})).status).toBe(400);
    expect((await post('/pre-assignment/switch', { enabled: 'no' })).status).toBe(400);
    expect(setDeployKeyEnrollmentSwitch).not.toHaveBeenCalled();
  });

  it('system scope sets the partner it names', async () => {
    authState.current = authFor({ scope: 'system', partnerId: null, partnerOrgAccess: undefined });
    const res = await post(`/pre-assignment/switch?partnerId=${OTHER_PARTNER}`, { enabled: true, stepUpGrant: GRANT });
    expect(res.status).toBe(200);
    expect(setDeployKeyEnrollmentSwitch).toHaveBeenCalledWith(expect.objectContaining({ partnerId: OTHER_PARTNER, enabled: true }));
    expect(validateStepUpGrant).toHaveBeenCalledWith(GRANT, expect.objectContaining({
      resourceDigest: preAssignmentEnableResourceDigest({ partnerId: OTHER_PARTNER }),
    }));
  });

  it('answers 404 for an unknown partner', async () => {
    vi.mocked(setDeployKeyEnrollmentSwitch).mockResolvedValueOnce(null);
    const res = await post('/pre-assignment/switch', { enabled: false });
    expect(res.status).toBe(404);
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });
});

describe('POST /pre-assignment/deploy-keys/:deployKeyId/expire-devices', () => {
  it("expires the key's still-parked devices for the caller's partner and returns counts", async () => {
    vi.mocked(expireDevicesParkedByDeployKey).mockResolvedValueOnce({ matched: 3, expired: 2, skipped: 1, failed: 0 });
    const res = await post(`/pre-assignment/deploy-keys/${DEPLOY_KEY}/expire-devices`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ matched: 3, expired: 2, skipped: 1, failed: 0 });
    expect(expireDevicesParkedByDeployKey).toHaveBeenCalledWith({ partnerId: PARTNER, deployKeyId: DEPLOY_KEY, actorUserId: 'user-1' });
    expect(writeAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'partner.pre_assignment.expire_devices_by_key',
      resourceType: 'partner',
      resourceId: PARTNER,
      details: expect.objectContaining({ deployKeyId: DEPLOY_KEY, matched: 3, expired: 2 }),
    }));
  });

  it('rejects a malformed key id', async () => {
    const res = await post('/pre-assignment/deploy-keys/not-a-uuid/expire-devices', {});
    expect(res.status).toBe(400);
    expect(expireDevicesParkedByDeployKey).not.toHaveBeenCalled();
  });
});
