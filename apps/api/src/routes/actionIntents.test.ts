import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  selectMock,
  getUserPermissionsMock,
  canAccessOrgMock,
  userCanDecideApprovalsMock,
  writeRouteAuditMock,
  recordActionIntentEventMock,
  hasSealedMock,
  unsealMock,
  burnMock,
} = vi.hoisted(() => ({
  selectMock: vi.fn(),
  getUserPermissionsMock: vi.fn(),
  canAccessOrgMock: vi.fn(() => true),
  userCanDecideApprovalsMock: vi.fn(() => true),
  writeRouteAuditMock: vi.fn(),
  recordActionIntentEventMock: vi.fn(),
  hasSealedMock: vi.fn(() => true),
  unsealMock: vi.fn(() => 'Tmp-Pass-1234!'),
  burnMock: vi.fn(async () => true),
}));

vi.mock('../db', () => ({
  db: { select: selectMock },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../db/schema/actionIntents', () => ({
  actionIntents: { id: 'action_intents.id' },
}));
vi.mock('../middleware/auth', () => ({
  authMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../services/permissions', () => ({
  getUserPermissions: getUserPermissionsMock,
  canAccessOrg: canAccessOrgMock,
  userCanDecideApprovals: userCanDecideApprovalsMock,
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: writeRouteAuditMock }));
vi.mock('../services/actionIntents/metrics', () => ({
  recordActionIntentEvent: recordActionIntentEventMock,
}));
vi.mock('../services/actionIntents/resultSecrets', () => ({
  REVEAL_WINDOW_DAYS: 7,
  hasSealedTemporaryPassword: hasSealedMock,
  unsealTemporaryPassword: unsealMock,
  burnTemporaryPassword: burnMock,
}));

import { actionIntentsRoutes } from './actionIntents';

const INTENT_ID = '22222222-2222-4222-8222-222222222222';
const ORG_ID = '44444444-4444-4444-8444-444444444444';
const PLAINTEXT = 'Tmp-Pass-1234!';

function baseIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: INTENT_ID,
    orgId: ORG_ID,
    requestedByUserId: 'user-1',
    requestingApiKeyId: null,
    source: 'chat',
    actionName: 'm365_reset_password',
    argumentDigest: 'a'.repeat(64),
    status: 'completed',
    executedAt: new Date(), // inside the window
    result: {
      success: true,
      action: 'm365.user.reset_password',
      userId: 'target-user-1',
      temporaryPasswordEnc: 'enc:v3:x',
      forceChangeNextSignIn: true,
    },
    ...overrides,
  };
}

function mockIntentSelect(rows: unknown[]) {
  selectMock.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  });
}

function buildApp(userId = 'user-1'): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization',
      orgId: ORG_ID,
      partnerId: null,
      accessibleOrgIds: [ORG_ID],
      user: { id: userId, email: 'tech@example.com', name: 'Tech' },
      canAccessOrg: () => true,
      orgCondition: () => undefined,
    } as never);
    await next();
  });
  app.route('/action-intents', actionIntentsRoutes);
  return app;
}

function reveal(app: Hono, id = INTENT_ID) {
  return app.request(`/action-intents/${id}/reveal-secret`, { method: 'POST' });
}

beforeEach(() => {
  vi.clearAllMocks();
  hasSealedMock.mockReturnValue(true);
  unsealMock.mockReturnValue(PLAINTEXT);
  burnMock.mockResolvedValue(true);
  canAccessOrgMock.mockReturnValue(true);
  userCanDecideApprovalsMock.mockReturnValue(true);
});

describe('POST /action-intents/:id/reveal-secret', () => {
  it('requester happy path: returns the password once, burns, audits without plaintext', async () => {
    mockIntentSelect([baseIntent()]);
    const res = await reveal(buildApp('user-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.temporaryPassword).toBe(PLAINTEXT);
    expect(body.data.userId).toBe('target-user-1');
    expect(body.data.forceChangeNextSignIn).toBe(true);

    expect(burnMock).toHaveBeenCalledWith(INTENT_ID, { revealedByUserId: 'user-1' });

    expect(writeRouteAuditMock).toHaveBeenCalledTimes(1);
    const audit = writeRouteAuditMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(audit.action).toBe('action_intent.temp_password.reveal');
    expect(audit.result).toBe('success');
    expect((audit.details as Record<string, unknown>).revealPath).toBe('requester');
    expect(JSON.stringify(audit)).not.toContain(PLAINTEXT);

    expect(recordActionIntentEventMock).toHaveBeenCalledTimes(1);
    const evt = recordActionIntentEventMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(evt.outcome).toBe('revealed');
    expect(JSON.stringify(evt)).not.toContain(PLAINTEXT);
  });

  it('a different user than the requester gets 403, burn never called, denial audited', async () => {
    mockIntentSelect([baseIntent()]);
    const res = await reveal(buildApp('someone-else'));
    expect(res.status).toBe(403);
    expect(burnMock).not.toHaveBeenCalled();
    expect(unsealMock).not.toHaveBeenCalled();
    const audit = writeRouteAuditMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(audit.result).toBe('denied');
  });

  it('API-key-requested intent: decide-holder with org access may reveal (admin_fallback)', async () => {
    mockIntentSelect([
      baseIntent({ requestedByUserId: null, requestingApiKeyId: 'key-1', source: 'mcp_api' }),
    ]);
    getUserPermissionsMock.mockResolvedValueOnce({ some: 'perms' });
    const res = await reveal(buildApp('admin-1'));
    expect(res.status).toBe(200);
    const audit = writeRouteAuditMock.mock.calls[0]![1] as Record<string, unknown>;
    expect((audit.details as Record<string, unknown>).revealPath).toBe('admin_fallback');
  });

  it('API-key-requested intent: user without approvals:decide gets 403', async () => {
    mockIntentSelect([baseIntent({ requestedByUserId: null, requestingApiKeyId: 'key-1' })]);
    getUserPermissionsMock.mockResolvedValueOnce({ some: 'perms' });
    userCanDecideApprovalsMock.mockReturnValue(false);
    const res = await reveal(buildApp('admin-1'));
    expect(res.status).toBe(403);
    expect(burnMock).not.toHaveBeenCalled();
  });

  it('API-key-requested intent: decide-holder without org access gets 403', async () => {
    mockIntentSelect([baseIntent({ requestedByUserId: null, requestingApiKeyId: 'key-1' })]);
    getUserPermissionsMock.mockResolvedValueOnce({ some: 'perms' });
    canAccessOrgMock.mockReturnValue(false);
    const res = await reveal(buildApp('admin-1'));
    expect(res.status).toBe(403);
  });

  it('unknown intent id (RLS-invisible) is a uniform 404', async () => {
    mockIntentSelect([]);
    const res = await reveal(buildApp());
    expect(res.status).toBe(404);
  });

  it('non-completed intent is a uniform 404', async () => {
    mockIntentSelect([baseIntent({ status: 'executing' })]);
    const res = await reveal(buildApp());
    expect(res.status).toBe(404);
  });

  it('completed intent without a secret is a uniform 404', async () => {
    hasSealedMock.mockReturnValue(false);
    mockIntentSelect([baseIntent({ result: { success: true } })]);
    const res = await reveal(buildApp());
    expect(res.status).toBe(404);
  });

  it('double reveal: burn CAS lost -> 410, response contains no password', async () => {
    mockIntentSelect([baseIntent()]);
    burnMock.mockResolvedValueOnce(false);
    const res = await reveal(buildApp());
    expect(res.status).toBe(410);
    expect(JSON.stringify(await res.json())).not.toContain(PLAINTEXT);
  });

  it('outside the 7-day window: 410 + lazy redact with the expired marker', async () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    mockIntentSelect([baseIntent({ executedAt: old })]);
    const res = await reveal(buildApp());
    expect(res.status).toBe(410);
    expect(burnMock).toHaveBeenCalledWith(INTENT_ID, { expired: true });
    expect(unsealMock).not.toHaveBeenCalled();
  });

  it('decrypt failure: 500 and the secret is NOT burned', async () => {
    mockIntentSelect([baseIntent()]);
    unsealMock.mockImplementationOnce(() => {
      throw new Error('AAD mismatch');
    });
    const res = await reveal(buildApp());
    expect(res.status).toBe(500);
    expect(burnMock).not.toHaveBeenCalled();
    expect(JSON.stringify(await res.json())).not.toContain(PLAINTEXT);
  });

  it('non-uuid id is rejected with 400 before any db access', async () => {
    const res = await reveal(buildApp(), 'not-a-uuid');
    expect(res.status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });
});
