import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// #8318 wave 2-2 — POST /devices/:id/reattach and GET
// /devices/:id/reinstall-candidates. The scope, interactive-session and MFA
// gates are the REAL implementations (partial middleware mock); the services
// are mocked: requestIntent.test.ts pins the refusals and the step-up, and the
// integration suite drives both against real PostgreSQL and Redis.

const { enable2faState, authState, requestMock, readCandidatesMock, epochsMock } = vi.hoisted(() => ({
  enable2faState: { value: true },
  authState: {
    principalKind: 'user_session' as string,
    mfa: true as boolean,
    sid: 'sid-1' as string | undefined,
    scope: 'partner' as 'partner' | 'organization' | 'system',
  },
  requestMock: vi.fn(),
  readCandidatesMock: vi.fn(),
  epochsMock: vi.fn(async () => ({ authEpoch: 4, mfaEpoch: 5 }) as { authEpoch: number; mfaEpoch: number } | null),
}));

vi.mock('../../routes/auth/schemas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../routes/auth/schemas')>();
  return { ...actual, get ENABLE_2FA() { return enable2faState.value; } };
});

vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  return {
    ...actual,
    authMiddleware: vi.fn((c: any, next: any) => {
      c.set('auth', {
        principal: { kind: authState.principalKind, id: 'principal-1' },
        token: { mfa: authState.mfa, sid: authState.sid, scope: authState.scope },
        user: { id: 'user-123', email: 'tech@example.com', name: 'Tech' },
        scope: authState.scope,
        orgId: authState.scope === 'organization' ? 'org-123' : null,
        partnerId: 'partner-1',
        partnerOrgAccess: 'all',
        accessibleOrgIds: ['org-123'],
        canAccessOrg: (orgId: string) => orgId === 'org-123',
      });
      return next();
    }),
    requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
      const denied = (c.req.header('x-deny') ?? '').split(',');
      if (denied.includes(`${resource}:${action}`)) return c.json({ error: 'Permission denied' }, 403);
      return next();
    }),
  };
});

vi.mock('../../services/authEpochs', () => ({ getUserEpochs: epochsMock }));
vi.mock('../../services/deviceReattach/requestIntent', () => ({ requestDeviceReattach: requestMock }));
vi.mock('../../services/reinstallCandidates/viewer', () => ({ readReinstallCandidatesForViewer: readCandidatesMock }));
vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));

import { reattachRoutes } from './reattach';

const SOURCE = '33333333-3333-4333-8333-333333333333';
const TARGET = '44444444-4444-4444-8444-444444444444';
const GRANT = '11111111-1111-4111-8111-111111111111';
const VERSION = 'V'.repeat(43);

const body = (over: Record<string, unknown> = {}) => ({
  targetDeviceId: TARGET,
  targetVersion: VERSION,
  possessionConfirmed: true,
  confirmTargetName: 'PC-OLD',
  stepUpGrant: GRANT,
  ...over,
});

const intent = {
  id: 'intent-1',
  state: 'requested',
  sourceDeviceId: SOURCE,
  targetDeviceId: TARGET,
  evidenceLevel: 'hint',
  restoreDecommissioned: false,
  requestedAt: new Date('2026-11-11T10:00:00Z'),
  expiresAt: new Date('2026-11-11T11:00:00Z'),
};

describe('POST /devices/:id/reattach (#8318 §8)', () => {
  let app: Hono;
  const post = (payload: unknown, headers: Record<string, string> = {}, id = SOURCE) =>
    app.request(`/${id}/reattach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    });

  beforeEach(() => {
    vi.clearAllMocks();
    enable2faState.value = true;
    Object.assign(authState, { principalKind: 'user_session', mfa: true, sid: 'sid-1', scope: 'partner' });
    epochsMock.mockResolvedValue({ authEpoch: 4, mfaEpoch: 5 });
    requestMock.mockResolvedValue({ ok: true, intent });
    app = new Hono();
    app.route('/', reattachRoutes);
  });

  it('requests a hint reattach with the step-up the route built, and answers 202 with the intent', async () => {
    const res = await post(body({ restoreDecommissioned: true, acknowledgeOsChange: true }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      intent: {
        id: 'intent-1',
        state: 'requested',
        sourceDeviceId: SOURCE,
        targetDeviceId: TARGET,
        evidenceLevel: 'hint',
        restoreDecommissioned: false,
        requestedAt: '2026-11-11T10:00:00.000Z',
        expiresAt: '2026-11-11T11:00:00.000Z',
      },
    });
    expect(requestMock).toHaveBeenCalledWith({
      actor: { userId: 'user-123' },
      sourceDeviceId: SOURCE,
      targetDeviceId: TARGET,
      targetVersion: VERSION,
      evidenceLevel: 'hint',
      restoreDecommissioned: true,
      acknowledgeOsChange: true,
      confirmTargetName: 'PC-OLD',
      stepUp: { kind: 'grant', grantId: GRANT, auth: expect.objectContaining({ user: expect.objectContaining({ id: 'user-123' }) }), binding: { authEpoch: 4, mfaEpoch: 5, sid: 'sid-1' } },
    });
  });

  it('defaults restoreDecommissioned and acknowledgeOsChange to false, and passes a missing grant to the service (which answers after its refusals)', async () => {
    await post(body({ stepUpGrant: undefined }));
    expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({
      restoreDecommissioned: false,
      acknowledgeOsChange: false,
      stepUp: expect.objectContaining({ kind: 'grant', grantId: null }),
    }));
  });

  it('folds uuid case so the step-up binding and the rows agree', async () => {
    await post(body({ targetDeviceId: TARGET.toUpperCase() }), {}, SOURCE.toUpperCase());
    expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({ sourceDeviceId: SOURCE, targetDeviceId: TARGET }));
  });

  it('asks for no step-up when two-factor authentication is off on the deployment', async () => {
    enable2faState.value = false;
    await post(body());
    expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({ stepUp: { kind: 'not_required' } }));
    expect(epochsMock).not.toHaveBeenCalled();
  });

  it('answers 503 when the session epochs cannot be read', async () => {
    epochsMock.mockResolvedValueOnce(null);
    expect((await post(body())).status).toBe(503);
    expect(requestMock).not.toHaveBeenCalled();
  });

  describe('gates', () => {
    it('refuses a customer-org user: only the partner reattaches', async () => {
      authState.scope = 'organization';
      expect((await post(body())).status).toBe(403);
      expect(requestMock).not.toHaveBeenCalled();
    });

    it('refuses system scope', async () => {
      authState.scope = 'system';
      expect((await post(body())).status).toBe(403);
      expect(requestMock).not.toHaveBeenCalled();
    });

    it.each(['api_key', 'oauth_grant', 'ai_agent', 'client_user'])('refuses a %s principal (interactive sessions only)', async (kind) => {
      authState.principalKind = kind;
      expect((await post(body())).status).toBe(403);
      expect(requestMock).not.toHaveBeenCalled();
    });

    it('refuses a session without satisfied MFA', async () => {
      authState.mfa = false;
      expect((await post(body())).status).toBe(403);
      expect(requestMock).not.toHaveBeenCalled();
    });

    it.each(['devices:write', 'devices:delete'])('refuses without %s', async (perm) => {
      expect((await post(body(), { 'x-deny': perm })).status).toBe(403);
      expect(requestMock).not.toHaveBeenCalled();
    });
  });

  describe('body', () => {
    it.each([
      ['no possessionConfirmed', { possessionConfirmed: undefined }],
      ['possessionConfirmed false', { possessionConfirmed: false }],
      ['a non-uuid target', { targetDeviceId: 'nope' }],
      ['a non-uuid grant', { stepUpGrant: 'nope' }],
      // The server decides the evidence level; a client cannot raise it.
      ['an evidenceLevel field', { evidenceLevel: 'tpm_continuity' }],
      ['an unknown field', { force: true }],
      ['no targetVersion', { targetVersion: undefined }],
      ['a malformed targetVersion', { targetVersion: 'short' }],
      // The raw install identifiers are never part of the contract.
      ['a raw targetAgentId', { targetAgentId: 'agent-1' }],
    ])('refuses %s with 400', async (_label, over) => {
      expect((await post(body(over))).status).toBe(400);
      expect(requestMock).not.toHaveBeenCalled();
    });

    it('refuses a non-uuid source id with 400', async () => {
      expect((await post(body(), {}, 'not-a-uuid')).status).toBe(400);
      expect(requestMock).not.toHaveBeenCalled();
    });
  });

  // Every §8 refusal reaches the client with its status and code unchanged.
  it.each([
    [409, 'target_changed'],
    [409, 'target_alive'],
    [409, 'liveness_unknown'],
    [409, 'device_quarantined'],
    [409, 'device_suspended'],
    [409, 'target_ephemeral'],
    [409, 'target_retired'],
    [409, 'target_decommissioned'],
    [409, 'org_draining'],
    [409, 'os_changed'],
    [409, 'rebind_unsupported'],
    [409, 'device_in_open_intent'],
    [409, 'partner_mismatch'],
    [409, 'target_ineligible'],
    [409, 'source_decommissioned'],
    [409, 'source_ineligible'],
    [403, 'full_admin_required'],
    [403, 'org_access_denied'],
    [403, 'permission_denied'],
    [403, 'not_partner_user'],
    [403, 'user_inactive'],
    [403, 'STEP_UP_REQUIRED'],
    [400, 'confirm_target_name_required'],
    [400, 'confirm_target_name_mismatch'],
    [400, 'same_device'],
    [404, 'device_not_found'],
  ] as const)('maps a %i %s refusal onto the response', async (status, code) => {
    requestMock.mockResolvedValueOnce({ ok: false, status, code, message: `refused: ${code}` });
    const res = await post(body());
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: `refused: ${code}`, code });
  });

  it('answers 500 when the service throws', async () => {
    requestMock.mockRejectedValueOnce(new Error('boom'));
    expect((await post(body())).status).toBe(500);
  });
});

describe('GET /devices/:id/reinstall-candidates (#8318 §7.3)', () => {
  let app: Hono;
  const get = (id = SOURCE, headers: Record<string, string> = {}) => app.request(`/${id}/reinstall-candidates`, { headers });

  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(authState, { principalKind: 'user_session', mfa: true, sid: 'sid-1', scope: 'partner' });
    app = new Hono();
    app.route('/', reattachRoutes);
  });

  it('answers the view for the caller', async () => {
    readCandidatesMock.mockResolvedValueOnce({ source: { deviceId: SOURCE }, candidates: [], reviewPending: true, openIntent: null, evidenceNotice: 'x' });
    const res = await get(SOURCE.toUpperCase());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reviewPending: true, candidates: [] });
    expect(readCandidatesMock).toHaveBeenCalledWith({ sourceDeviceId: SOURCE, viewer: expect.objectContaining({ scope: 'partner' }) });
  });

  it('answers 404 for a source the caller may not see, exactly like a missing device', async () => {
    readCandidatesMock.mockResolvedValueOnce(null);
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Device not found' });
  });

  it('needs devices:read', async () => {
    expect((await get(SOURCE, { 'x-deny': 'devices:read' })).status).toBe(403);
    expect(readCandidatesMock).not.toHaveBeenCalled();
  });

  it('is read by organization users too (they learn only that a review is pending)', async () => {
    authState.scope = 'organization';
    readCandidatesMock.mockResolvedValueOnce({ source: { deviceId: SOURCE }, candidates: [], reviewPending: true, openIntent: null, evidenceNotice: 'x' });
    expect((await get()).status).toBe(200);
  });

  it('refuses system scope', async () => {
    authState.scope = 'system';
    expect((await get()).status).toBe(403);
  });

  it('refuses a non-uuid id with 400', async () => {
    expect((await get('nope')).status).toBe(400);
  });
});
