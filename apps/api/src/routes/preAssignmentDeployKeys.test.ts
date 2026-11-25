import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Each gate factory returns a middleware that records the request it ran for,
// so the tests can assert the gate is on EVERY deploy-key route.
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

// requireScope and requireInteractiveSession are the REAL middleware.
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
vi.mock('../services/deployKeys/manage', () => ({
  listDeployKeys: vi.fn(),
  mintDeployKey: vi.fn(),
  rotateDeployKey: vi.fn(),
  revokeDeployKey: vi.fn(),
}));
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
import { listDeployKeys, mintDeployKey, revokeDeployKey, rotateDeployKey } from '../services/deployKeys/manage';
import { expireDevicesParkedByDeployKey } from '../services/unassignedPool/incidentActions';
import { writeAuditEvent } from '../services/auditEvents';
import {
  deployKeyMintResourceDigest,
  deployKeyRotateResourceDigest,
  validateStepUpGrant,
} from '../services/mfaStepUpGrant';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';
import { PERMISSIONS } from '../services/permissions';

const PARTNER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_PARTNER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY = '66666666-6666-4666-8666-666666666666';
const NEW_KEY = '77777777-7777-4777-8777-777777777777';
const GRANT = '99999999-9999-4999-8999-999999999999';
const PLAINTEXT = `bdk_${'ab'.repeat(32)}`;

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

function keyView(overrides: Record<string, unknown> = {}) {
  return {
    id: KEY,
    partnerId: PARTNER,
    name: 'Front desk',
    imageLabel: 'win11',
    status: 'active',
    createdBy: 'user-1',
    createdAt: new Date('2026-11-25T00:00:00Z'),
    expiresAt: new Date('2027-11-25T00:00:00Z'),
    maxUsage: 100,
    usageCount: 0,
    maxParked: 10,
    revokedAt: null,
    revokedBy: null,
    rotatedFromId: null,
    lastUsedAt: null,
    lastUsedIp: null,
    sourceCidrs: null,
    expired: false,
    ...overrides,
  } as any;
}

const app = new Hono();
app.route('/pre-assignment', preAssignmentRoutes);
app.onError((err: any, c) => c.json({ error: err.message }, err.status ?? 500));

const post = (path: string, body: unknown) => app.request(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const mintBody = { name: 'Front desk', imageLabel: 'win11', expiresInDays: 365, maxUsage: 100, maxParked: 10, stepUpGrant: GRANT };
const rotateBody = { expiresInDays: 90, stepUpGrant: GRANT };

const ROUTES: Array<[string, () => Response | Promise<Response>]> = [
  ['GET /deploy-keys', () => app.request('/pre-assignment/deploy-keys')],
  ['POST /deploy-keys', () => post('/pre-assignment/deploy-keys', mintBody)],
  ['POST /deploy-keys/:id/rotate', () => post(`/pre-assignment/deploy-keys/${KEY}/rotate`, rotateBody)],
  ['POST /deploy-keys/:id/revoke', () => post(`/pre-assignment/deploy-keys/${KEY}/revoke`, {})],
];

const serviceMocks = () => [listDeployKeys, mintDeployKey, rotateDeployKey, revokeDeployKey];

beforeEach(() => {
  vi.clearAllMocks();
  gateHits.length = 0;
  enable2faState.value = true;
  authState.current = authFor();
  vi.mocked(validateStepUpGrant).mockResolvedValue(true);
  vi.mocked(listDeployKeys).mockResolvedValue({ ok: true, keys: [keyView()] });
  vi.mocked(mintDeployKey).mockResolvedValue({ ok: true, key: keyView(), plaintextKey: PLAINTEXT });
  vi.mocked(rotateDeployKey).mockResolvedValue({
    ok: true,
    key: keyView({ id: NEW_KEY, rotatedFromId: KEY }),
    plaintextKey: PLAINTEXT,
    rotatedFrom: keyView(),
  });
  vi.mocked(revokeDeployKey).mockResolvedValue({
    ok: true,
    key: keyView({ status: 'revoked', revokedAt: new Date(), revokedBy: 'user-1' }),
    alreadyRevoked: false,
    expiry: { matched: 3, expired: 2, skipped: 1, failed: 0 },
  });
});

describe('deploy-key route gates', () => {
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
    for (const fn of serviceMocks()) expect(fn).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('%s refuses an organization-scope user', async (_name, call) => {
    authState.current = authFor({ scope: 'organization', orgId: '22222222-2222-4222-8222-222222222222', partnerOrgAccess: undefined });
    const res = await call();
    expect(res.status).toBe(403);
    for (const fn of serviceMocks()) expect(fn).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('%s refuses a non-interactive principal (API key)', async (_name, call) => {
    authState.current = authFor({ principal: { kind: 'api_key' } });
    const res = await call();
    expect(res.status).toBe(403);
    for (const fn of serviceMocks()) expect(fn).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('%s requires an explicit partnerId for system scope', async (_name, call) => {
    authState.current = authFor({ scope: 'system', partnerId: null, partnerOrgAccess: undefined });
    const res = await call();
    expect(res.status).toBe(400);
    for (const fn of serviceMocks()) expect(fn).not.toHaveBeenCalled();
  });

  it('a partner caller cannot name another partner', async () => {
    const res = await app.request(`/pre-assignment/deploy-keys?partnerId=${OTHER_PARTNER}`);
    expect(res.status).toBe(403);
    expect(listDeployKeys).not.toHaveBeenCalled();
  });

  it('system scope acts on the partner it names', async () => {
    authState.current = authFor({ scope: 'system', partnerId: null, partnerOrgAccess: undefined });
    const res = await app.request(`/pre-assignment/deploy-keys?partnerId=${OTHER_PARTNER}`);
    expect(res.status).toBe(200);
    expect(listDeployKeys).toHaveBeenCalledWith({ auth: authState.current, partnerId: OTHER_PARTNER });
  });

  it('keeps POST /deploy-keys/:id/expire-devices working beside the new routes', async () => {
    vi.mocked(expireDevicesParkedByDeployKey).mockResolvedValueOnce({ matched: 1, expired: 1, skipped: 0, failed: 0 });
    const res = await post(`/pre-assignment/deploy-keys/${KEY}/expire-devices`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ matched: 1, expired: 1, skipped: 0, failed: 0 });
    expect(revokeDeployKey).not.toHaveBeenCalled();
  });
});

describe('GET /pre-assignment/deploy-keys', () => {
  it('lists the caller\'s partner', async () => {
    const res = await app.request('/pre-assignment/deploy-keys');
    expect(res.status).toBe(200);
    expect(listDeployKeys).toHaveBeenCalledWith({ auth: authState.current, partnerId: PARTNER });
    const body = await res.json();
    expect(body.deployKeys).toHaveLength(1);
    expect(JSON.stringify(body)).not.toMatch(/keyHash|key_hash/);
  });
});

describe('POST /pre-assignment/deploy-keys (mint)', () => {
  it('validates a deploy_key_mint grant bound to the partner and the trimmed label, and returns the plaintext once', async () => {
    const res = await post('/pre-assignment/deploy-keys', { ...mintBody, imageLabel: '  win11  ', sourceCidrs: ['10.0.0.0/8'] });
    expect(res.status).toBe(201);
    expect(validateStepUpGrant).toHaveBeenCalledWith(GRANT, {
      userId: 'user-1',
      operation: 'deploy_key_mint',
      authEpoch: 3,
      mfaEpoch: 4,
      sid: 'sid-1',
      resourceDigest: deployKeyMintResourceDigest({ partnerId: PARTNER, imageLabel: 'win11' }),
    });
    expect(mintDeployKey).toHaveBeenCalledWith({
      actor: { auth: authState.current, partnerId: PARTNER },
      key: { name: 'Front desk', imageLabel: 'win11', expiresInDays: 365, maxUsage: 100, maxParked: 10, sourceCidrs: ['10.0.0.0/8'] },
      stepUp: { grantId: GRANT, binding: expect.objectContaining({ operation: 'deploy_key_mint' }) },
    });
    const body = await res.json();
    expect(body.key).toBe(PLAINTEXT);
    expect(body.notice).toMatch(/only time/);
  });

  it('audits the mint without the key or its hash', async () => {
    await post('/pre-assignment/deploy-keys', mintBody);
    expect(writeAuditEvent).toHaveBeenCalledTimes(1);
    const event = vi.mocked(writeAuditEvent).mock.calls[0]![1];
    expect(event).toMatchObject({
      action: 'partner.deploy_key.mint',
      resourceType: 'partner_deploy_key',
      resourceId: KEY,
      orgId: null,
      details: expect.objectContaining({ partnerId: PARTNER, deployKeyId: KEY, imageLabel: 'win11', maxUsage: 100, maxParked: 10, stepUp: 'grant' }),
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(PLAINTEXT);
    expect(serialized).not.toMatch(/keyHash|key_hash/);
  });

  it('refuses without a grant (or with a mismatched one) and never mints', async () => {
    const { stepUpGrant: _omit, ...noGrant } = mintBody;
    const missing = await post('/pre-assignment/deploy-keys', noGrant);
    expect(missing.status).toBe(403);
    expect((await missing.json()).code).toBe('STEP_UP_REQUIRED');
    vi.mocked(validateStepUpGrant).mockResolvedValueOnce(false);
    const mismatched = await post('/pre-assignment/deploy-keys', mintBody);
    expect(mismatched.status).toBe(403);
    expect(mintDeployKey).not.toHaveBeenCalled();
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });

  it('with two-factor authentication disabled, mints with no step-up', async () => {
    enable2faState.value = false;
    const { stepUpGrant: _omit, ...noGrant } = mintBody;
    const res = await post('/pre-assignment/deploy-keys', noGrant);
    expect(res.status).toBe(201);
    expect(validateStepUpGrant).not.toHaveBeenCalled();
    expect(vi.mocked(mintDeployKey).mock.calls[0]![0].stepUp).toBeNull();
    expect(vi.mocked(writeAuditEvent).mock.calls[0]![1].details).toMatchObject({ stepUp: 'disabled_2fa' });
  });

  it.each([
    ['a lifetime above 365 days', { expiresInDays: 366 }],
    ['more than 1000 uses', { maxUsage: 1001 }],
    ['more than 20 parked', { maxParked: 21 }],
    ['no uses', { maxUsage: 0 }],
    ['an invalid source CIDR', { sourceCidrs: ['10.0.0.0/40'] }],
    ['an unknown field', { status: 'active' }],
  ])('rejects %s with 400 before any step-up check', async (_label, patch) => {
    const res = await post('/pre-assignment/deploy-keys', { ...mintBody, ...patch });
    expect(res.status).toBe(400);
    expect(validateStepUpGrant).not.toHaveBeenCalled();
    expect(mintDeployKey).not.toHaveBeenCalled();
  });

  it.each([
    ['ACTIVE_KEY_LIMIT_REACHED', 409],
    ['DEPLOY_KEY_NOT_ELIGIBLE', 409],
    ['PARTNER_NOT_FOUND', 404],
    ['PARTNER_WIDE_WRITE_DENIED', 403],
  ] as const)('maps the service refusal %s to %i, unaudited', async (code, status) => {
    vi.mocked(mintDeployKey).mockResolvedValueOnce({
      ok: false,
      code,
      message: 'refused',
      ...(code === 'DEPLOY_KEY_NOT_ELIGIBLE' ? { reason: 'partner_not_trusted' as const } : {}),
    });
    const res = await post('/pre-assignment/deploy-keys', mintBody);
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body.code).toBe(code);
    if (code === 'DEPLOY_KEY_NOT_ELIGIBLE') expect(body.reason).toBe('partner_not_trusted');
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });

  it('maps a grant lost inside the transaction to the step-up body', async () => {
    vi.mocked(mintDeployKey).mockResolvedValueOnce({ ok: false, code: 'STEP_UP_REQUIRED', message: 'Step-up required' });
    const res = await post('/pre-assignment/deploy-keys', mintBody);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Step-up required', code: 'STEP_UP_REQUIRED' });
  });

  it('a service failure is a 500 that carries no key', async () => {
    vi.mocked(mintDeployKey).mockRejectedValueOnce(new Error('boom'));
    const res = await post('/pre-assignment/deploy-keys', mintBody);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('bdk_');
  });
});

describe('POST /pre-assignment/deploy-keys/:id/rotate', () => {
  it('validates a deploy_key_rotate grant bound to the partner and the key', async () => {
    const res = await post(`/pre-assignment/deploy-keys/${KEY}/rotate`, { ...rotateBody, maxParked: 5, sourceCidrs: null });
    expect(res.status).toBe(201);
    expect(validateStepUpGrant).toHaveBeenCalledWith(GRANT, expect.objectContaining({
      operation: 'deploy_key_rotate',
      resourceDigest: deployKeyRotateResourceDigest({ partnerId: PARTNER, deployKeyId: KEY }),
    }));
    expect(rotateDeployKey).toHaveBeenCalledWith({
      actor: { auth: authState.current, partnerId: PARTNER },
      deployKeyId: KEY,
      key: { expiresInDays: 90, name: undefined, maxUsage: undefined, maxParked: 5, sourceCidrs: null },
      stepUp: { grantId: GRANT, binding: expect.objectContaining({ operation: 'deploy_key_rotate' }) },
    });
    const body = await res.json();
    expect(body.key).toBe(PLAINTEXT);
    expect(body.deployKey.rotatedFromId).toBe(KEY);
    expect(body.rotatedFrom.id).toBe(KEY);
    expect(vi.mocked(writeAuditEvent).mock.calls[0]![1]).toMatchObject({
      action: 'partner.deploy_key.rotate',
      details: expect.objectContaining({ deployKeyId: NEW_KEY, rotatedFromId: KEY }),
    });
  });

  it('a mint grant does not authorize a rotation', async () => {
    vi.mocked(validateStepUpGrant).mockImplementation(async (_id, binding) => binding.operation === 'deploy_key_mint');
    const res = await post(`/pre-assignment/deploy-keys/${KEY}/rotate`, rotateBody);
    expect(res.status).toBe(403);
    expect(rotateDeployKey).not.toHaveBeenCalled();
  });

  it.each([
    ['DEPLOY_KEY_NOT_FOUND', 404],
    ['DEPLOY_KEY_REVOKED', 409],
    ['ACTIVE_KEY_LIMIT_REACHED', 409],
  ] as const)('maps %s to %i', async (code, status) => {
    vi.mocked(rotateDeployKey).mockResolvedValueOnce({ ok: false, code, message: 'refused' });
    const res = await post(`/pre-assignment/deploy-keys/${KEY}/rotate`, rotateBody);
    expect(res.status).toBe(status);
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid key id', async () => {
    const res = await post('/pre-assignment/deploy-keys/not-a-uuid/rotate', rotateBody);
    expect(res.status).toBe(400);
    expect(rotateDeployKey).not.toHaveBeenCalled();
  });
});

describe('POST /pre-assignment/deploy-keys/:id/revoke', () => {
  it('needs no step-up, revokes, and returns the expiry result', async () => {
    const res = await post(`/pre-assignment/deploy-keys/${KEY}/revoke`, {});
    expect(res.status).toBe(200);
    expect(validateStepUpGrant).not.toHaveBeenCalled();
    expect(revokeDeployKey).toHaveBeenCalledWith({ actor: { auth: authState.current, partnerId: PARTNER }, deployKeyId: KEY });
    const body = await res.json();
    expect(body.alreadyRevoked).toBe(false);
    expect(body.expiry).toEqual({ matched: 3, expired: 2, skipped: 1, failed: 0 });
    expect(vi.mocked(writeAuditEvent).mock.calls[0]![1]).toMatchObject({
      action: 'partner.deploy_key.revoke',
      resourceId: KEY,
      result: 'success',
      details: expect.objectContaining({ deployKeyId: KEY, expired: 2, matched: 3 }),
    });
  });

  it('audits a partial expiry as a failure', async () => {
    vi.mocked(revokeDeployKey).mockResolvedValueOnce({
      ok: true,
      key: keyView({ status: 'revoked' }),
      alreadyRevoked: true,
      expiry: { matched: 2, expired: 1, skipped: 0, failed: 1 },
    });
    const res = await post(`/pre-assignment/deploy-keys/${KEY}/revoke`, {});
    expect(res.status).toBe(200);
    expect(vi.mocked(writeAuditEvent).mock.calls[0]![1]).toMatchObject({ result: 'failure' });
  });

  it('maps a missing key to 404', async () => {
    vi.mocked(revokeDeployKey).mockResolvedValueOnce({ ok: false, code: 'DEPLOY_KEY_NOT_FOUND', message: 'Deploy key not found' });
    const res = await post(`/pre-assignment/deploy-keys/${KEY}/revoke`, {});
    expect(res.status).toBe(404);
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });
});
