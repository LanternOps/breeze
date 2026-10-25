import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// #8729 — POST /devices/:id/force-reboot. The interactive-session and MFA
// gates are the REAL implementations (partial middleware mock, as in
// commands.test.ts); only transport and authorization stubs are mocked.

vi.mock('../../services/stepUpActorAssurance', () => ({ lockActorAssurance: vi.fn(async () => true) }));

const { enable2faState, authState, assertDeviceExecuteAllowedMock, dispatchDeviceCommandMock, deliverMock } = vi.hoisted(() => ({
  enable2faState: { value: true },
  authState: { principalKind: 'user_session' as string, mfa: true as boolean, sid: 'sid-1' as string | undefined },
  assertDeviceExecuteAllowedMock: vi.fn(async () => undefined),
  deliverMock: vi.fn(async () => ({ ok: true })),
  dispatchDeviceCommandMock: vi.fn(),
}));

vi.mock('../../routes/auth/schemas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../routes/auth/schemas')>();
  return { ...actual, get ENABLE_2FA() { return enable2faState.value; } };
});

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  runAfterDbContextCommit: vi.fn(),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), transaction: vi.fn() },
}));

vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  return {
    ...actual,
    authMiddleware: vi.fn((c: any, next: any) => {
      c.set('auth', {
        principal: { kind: authState.principalKind, id: 'principal-1' },
        token: { mfa: authState.mfa, sid: authState.sid },
        user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
        scope: 'organization',
        orgId: 'org-123',
        partnerId: null,
        accessibleOrgIds: ['org-123'],
        canAccessOrg: (orgId: string) => orgId === 'org-123',
      });
      return next();
    }),
    requireScope: vi.fn(() => async (_c: any, next: any) => next()),
    requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
      if (c.req.header('x-deny-execute') === 'true') return c.json({ error: 'Permission denied' }, 403);
      c.set('permissions', {
        permissions: [{ resource, action }],
        partnerId: null,
        orgId: 'org-123',
        roleId: 'role-123',
        scope: 'organization',
        ...(c.req.header('x-site-restricted') === 'true' ? { allowedSiteIds: ['site-other'] } : {}),
      });
      return next();
    }),
  };
});

vi.mock('./helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./helpers')>()),
  getDeviceWithOrgCheck: vi.fn(),
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

vi.mock('../../services/partnerTrust.commands', async () => ({
  ...(await vi.importActual<typeof import('../../services/partnerTrust.commands')>('../../services/partnerTrust.commands')),
  assertDeviceExecuteAllowed: assertDeviceExecuteAllowedMock,
}));

vi.mock('../../services/dispatchDeviceCommand', () => ({ dispatchDeviceCommand: dispatchDeviceCommandMock }));

vi.mock('../../services/mfaStepUpGrant', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/mfaStepUpGrant')>();
  return { ...actual, validateStepUpGrant: vi.fn(async () => true), consumeStepUpGrant: vi.fn(async () => true) };
});

vi.mock('../../services/authEpochs', () => ({ getUserEpochs: vi.fn(async () => ({ authEpoch: 1, mfaEpoch: 1 })) }));

import { forceRebootRoutes } from './forceReboot';
import { runAfterDbContextCommit, withDbTransaction } from '../../db';
import { getDeviceWithOrgCheck } from './helpers';
import { writeRouteAudit } from '../../services/auditEvents';
import { TrustDeniedError } from '../../services/partnerTrust.commands';
import { consumeStepUpGrant, forceRebootResourceDigest, validateStepUpGrant } from '../../services/mfaStepUpGrant';
import { lockActorAssurance } from '../../services/stepUpActorAssurance';
import { MIN_AGENT_VERSION_FORCE_REBOOT } from '../../services/forceReboot';

const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const GRANT = '11111111-1111-4111-8111-111111111111';

const deviceRow = (over: Record<string, unknown> = {}) => ({
  id: DEVICE_ID,
  orgId: 'org-123',
  siteId: 'site-allowed',
  hostname: 'LAPTOP-07',
  status: 'online',
  osType: 'windows',
  agentVersion: MIN_AGENT_VERSION_FORCE_REBOOT,
  ...over,
});

const expectedBinding = {
  userId: 'user-123',
  operation: 'device_force_reboot',
  authEpoch: 1,
  mfaEpoch: 1,
  sid: 'sid-1',
  resourceDigest: forceRebootResourceDigest({ deviceId: DEVICE_ID }),
};

describe('POST /devices/:id/force-reboot (#8729)', () => {
  let app: Hono;

  const post = (body: Record<string, unknown> = { stepUpGrant: GRANT }, headers: Record<string, string> = {}) =>
    app.request(`/devices/${DEVICE_ID}/force-reboot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token', ...headers },
      body: JSON.stringify(body),
    });

  /** Nothing irreversible happened: no grant spent, nothing queued, nothing audited. */
  const expectNoEffect = () => {
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
    expect(dispatchDeviceCommandMock).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    enable2faState.value = true;
    authState.principalKind = 'user_session';
    authState.mfa = true;
    authState.sid = 'sid-1';
    vi.clearAllMocks();
    vi.mocked(getDeviceWithOrgCheck).mockReset().mockResolvedValue(deviceRow() as never);
    vi.mocked(validateStepUpGrant).mockReset().mockResolvedValue(true);
    vi.mocked(consumeStepUpGrant).mockReset().mockResolvedValue(true);
    vi.mocked(lockActorAssurance).mockReset().mockResolvedValue(true);
    vi.mocked(withDbTransaction).mockReset().mockImplementation((async (fn: () => Promise<unknown>) => fn()) as never);
    assertDeviceExecuteAllowedMock.mockReset().mockResolvedValue(undefined);
    dispatchDeviceCommandMock.mockReset().mockImplementation(async ({ deviceId, type }: { deviceId: string; type: string }) => ({
      ok: true,
      command: { id: 'cmd-force-1', deviceId, type, status: 'pending', createdAt: new Date() },
      delivery: 'queued_live',
      deliverBy: new Date(Date.now() + 15 * 60 * 1000),
      deliver: deliverMock,
    }));
    app = new Hono();
    app.route('/devices', forceRebootRoutes);
  });

  it('queues force_reboot with a valid grant: consumes it with the device binding, audits force + argv, delivers after commit', async () => {
    const res = await post();
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      id: 'cmd-force-1',
      deviceId: DEVICE_ID,
      type: 'force_reboot',
      argv: ['shutdown', '/r', '/f', '/t', '0'],
    });

    expect(validateStepUpGrant).toHaveBeenCalledWith(GRANT, expectedBinding);
    expect(consumeStepUpGrant).toHaveBeenCalledWith(GRANT, expectedBinding);
    expect(dispatchDeviceCommandMock).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: DEVICE_ID,
      type: 'force_reboot',
      payload: {},
      userId: 'user-123',
      deferDelivery: true,
      // Codex review: capped at 15 minutes whatever the shared live_only setting.
      offlinePolicy: { kind: 'queue', deliverWithinMs: 15 * 60 * 1000 },
    }));
    // One savepoint: lock the actor, queue the row, consume the grant LAST
    // (Redis GETDEL cannot be rolled back, so nothing that can refuse may
    // follow it).
    expect(withDbTransaction).toHaveBeenCalledTimes(1);
    const order = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0]!;
    expect(order(vi.mocked(lockActorAssurance))).toBeLessThan(order(dispatchDeviceCommandMock));
    expect(order(dispatchDeviceCommandMock)).toBeLessThan(order(vi.mocked(consumeStepUpGrant)));

    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: 'org-123',
      action: 'agent.command.force_reboot',
      resourceType: 'device',
      resourceId: DEVICE_ID,
      resourceName: 'LAPTOP-07',
      details: expect.objectContaining({
        commandId: 'cmd-force-1',
        type: 'force_reboot',
        force: true,
        osType: 'windows',
        argv: ['shutdown', '/r', '/f', '/t', '0'],
        stepUp: 'device_force_reboot',
      }),
    }));

    expect(runAfterDbContextCommit).toHaveBeenCalledTimes(1);
    const [, deliver] = vi.mocked(runAfterDbContextCommit).mock.calls[0]!;
    await (deliver as () => Promise<unknown>)();
    expect(deliverMock).toHaveBeenCalledTimes(1);
  });

  it('records the unforced argv on macOS and Linux, where force changes nothing', async () => {
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue(deviceRow({ osType: 'macos' }) as never);
    const res = await post();
    expect(res.status).toBe(201);
    expect((await res.json()).argv).toEqual(['shutdown', '-r', '+0']);
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      details: expect.objectContaining({ osType: 'macos', argv: ['shutdown', '-r', '+0'] }),
    }));
  });

  // ---- who may ask

  it.each(['api_key', 'oauth_grant', 'ai_agent', 'client_user'])('refuses a %s principal before any lookup', async (kind) => {
    authState.principalKind = kind;
    const res = await post();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Interactive user session required' });
    expect(getDeviceWithOrgCheck).not.toHaveBeenCalled();
    expectNoEffect();
  });

  it('refuses a session that has not satisfied MFA', async () => {
    authState.mfa = false;
    const res = await post();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });
    expectNoEffect();
  });

  it('refuses without devices:execute', async () => {
    const res = await post(undefined, { 'x-deny-execute': 'true' });
    expect(res.status).toBe(403);
    expectNoEffect();
  });

  it('rejects a body with anything but stepUpGrant', async () => {
    const res = await post({ stepUpGrant: GRANT, delay: 5 });
    expect(res.status).toBe(400);
    expectNoEffect();
  });

  // ---- the step-up grant

  it('refuses with no grant', async () => {
    const res = await post({});
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Step-up required', code: 'STEP_UP_REQUIRED' });
    expect(validateStepUpGrant).not.toHaveBeenCalled();
    expectNoEffect();
  });

  it('refuses a grant bound to another device, indistinguishably from a missing one', async () => {
    // The binding the route checks is THIS device's digest, so a grant minted
    // for another device fails validation.
    vi.mocked(validateStepUpGrant).mockResolvedValue(false);
    const res = await post();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Step-up required', code: 'STEP_UP_REQUIRED' });
    expect(validateStepUpGrant).toHaveBeenCalledWith(GRANT, expectedBinding);
    expectNoEffect();
  });

  it('refuses a replayed (already consumed) grant and rolls the queued row back', async () => {
    vi.mocked(consumeStepUpGrant).mockResolvedValue(false);
    let savepoint: Promise<unknown> | undefined;
    vi.mocked(withDbTransaction).mockImplementation(((fn: () => Promise<unknown>) => (savepoint = fn())) as never);
    const res = await post();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Step-up required', code: 'STEP_UP_REQUIRED' });
    // The savepoint body THREW (so the real savepoint rolls back the row it
    // queued); it did not return normally.
    await expect(savepoint).rejects.toBeInstanceOf(Error);
    expect(writeRouteAudit).not.toHaveBeenCalled();
    expect(runAfterDbContextCommit).not.toHaveBeenCalled();
  });

  it('refuses when the actor assurance moved since the grant (password/MFA change, sign-out)', async () => {
    vi.mocked(lockActorAssurance).mockResolvedValue(false);
    const res = await post();
    expect(res.status).toBe(403);
    expect(dispatchDeviceCommandMock).not.toHaveBeenCalled();
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
  });

  it('needs no grant when 2FA is disabled for the deployment, but still needs a human session', async () => {
    enable2faState.value = false;
    const res = await post({});
    expect(res.status).toBe(201);
    expect(validateStepUpGrant).not.toHaveBeenCalled();
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
    expect(lockActorAssurance).not.toHaveBeenCalled();
    expect(withDbTransaction).toHaveBeenCalledTimes(1);

    authState.principalKind = 'api_key';
    expect((await post({})).status).toBe(403);
  });

  // ---- the device (every refusal leaves the grant unspent)

  it('404s a device the caller cannot see', async () => {
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue(null as never);
    expect((await post()).status).toBe(404);
    expectNoEffect();
  });

  it('403s a device in a site the caller cannot access', async () => {
    const res = await post(undefined, { 'x-site-restricted': 'true' });
    expect(res.status).toBe(403);
    expectNoEffect();
  });

  it('refuses a decommissioned device', async () => {
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue(deviceRow({ status: 'decommissioned' }) as never);
    expect((await post()).status).toBe(400);
    expectNoEffect();
  });

  it.each(['offline', 'maintenance', 'updating', 'pending', 'quarantined'])(
    'refuses a device that is %s with DEVICE_OFFLINE ("now" means now)',
    async (status) => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValue(deviceRow({ status }) as never);
      const res = await post();
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'DEVICE_OFFLINE' });
      expectNoEffect();
    },
  );

  it.each(['0.124.0', '', 'dev', null])(
    'refuses agent version %j with AGENT_UPGRADE_REQUIRED, before the grant is spent',
    async (agentVersion) => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValue(deviceRow({ agentVersion }) as never);
      const res = await post();
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code: 'AGENT_UPGRADE_REQUIRED',
        minAgentVersion: MIN_AGENT_VERSION_FORCE_REBOOT,
      });
      expectNoEffect();
    },
  );

  // Review fix: the device checks answer on the FIRST submit (no grant), so
  // the technician is never asked for a factor for a device that cannot do it.
  it.each([
    ['an agent that is too old', { agentVersion: '0.124.0' }, 'AGENT_UPGRADE_REQUIRED'],
    ['a device that is not online', { status: 'offline' }, 'DEVICE_OFFLINE'],
  ])('refuses %s before asking for the step-up', async (_label, over, code) => {
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue(deviceRow(over) as never);
    const res = await post({});
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code });
    expect(validateStepUpGrant).not.toHaveBeenCalled();
    expectNoEffect();
  });

  it('refuses a trust denial before asking for the step-up', async () => {
    assertDeviceExecuteAllowedMock.mockRejectedValue(
      new TrustDeniedError('TRUST_PROBATION', 'Partner verification is required.', DEVICE_ID, 'force_reboot'),
    );
    const res = await post({});
    expect(res.status).toBe(403);
    expect(await res.json()).not.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(validateStepUpGrant).not.toHaveBeenCalled();
  });

  // Review fix: force_reboot is a live_only QUEUE type, so a device that goes
  // offline after the route's check is not refused by the seam; it would sit
  // queued for 15 minutes. The route drops the row instead.
  it('refuses with DEVICE_OFFLINE and rolls back when the seam would only queue the command offline', async () => {
    dispatchDeviceCommandMock.mockResolvedValue({
      ok: true,
      command: { id: 'cmd-late', deviceId: DEVICE_ID, type: 'force_reboot', status: 'pending', createdAt: new Date() },
      delivery: 'queued_offline',
      deliverBy: new Date(Date.now() + 15 * 60 * 1000),
    });
    let savepoint: Promise<unknown> | undefined;
    vi.mocked(withDbTransaction).mockImplementation(((fn: () => Promise<unknown>) => (savepoint = fn())) as never);
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'DEVICE_OFFLINE' });
    await expect(savepoint).rejects.toBeInstanceOf(Error);
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
    expect(runAfterDbContextCommit).not.toHaveBeenCalled();
  });

  it('refuses when partner trust denies device execution, before the grant is spent', async () => {
    assertDeviceExecuteAllowedMock.mockRejectedValue(
      new TrustDeniedError('TRUST_PROBATION', 'Partner verification is required.', DEVICE_ID, 'force_reboot'),
    );
    const res = await post();
    expect(res.status).toBe(403);
    expect(assertDeviceExecuteAllowedMock).toHaveBeenCalledWith(DEVICE_ID, 'force_reboot', 'user-123');
    expectNoEffect();
  });

  it.each([
    ['device_offline', 409, 'DEVICE_OFFLINE'],
    ['device_pending_assignment', 409, undefined],
    ['device_decommissioned', 400, undefined],
  ] as const)('maps a %s refusal from the enqueue seam, leaving the grant unspent', async (code, status, bodyCode) => {
    dispatchDeviceCommandMock.mockResolvedValue({ ok: false, code, error: 'refused' });
    const res = await post();
    expect(res.status).toBe(status);
    if (bodyCode) expect(await res.json()).toMatchObject({ code: bodyCode });
    expect(consumeStepUpGrant).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });
});
