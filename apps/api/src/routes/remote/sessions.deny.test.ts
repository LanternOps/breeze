import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

/**
 * POST /remote/sessions/:id/deny — consent-denial / bypass verdict ingestion.
 *
 * The handler mirrors `/answer`'s guards (scope + ownership + `connecting`
 * state) but finalizes the session as `denied` and audits the consent decision:
 *   - reason `user` | `timeout` → `session_consent_denied`
 *   - any other reason          → `session_consent_bypassed`
 *
 * It also revokes any viewer token so a lingering token can't resurrect the
 * denied session. These tests mock the DB + helpers so they run under the unit
 * `test-api` job (no DB needed).
 */

const {
  getSessionWithOrgCheck,
  hasSessionOrTransferOwnership,
  logSessionAudit,
  revokeViewerSession,
} = vi.hoisted(() => ({
  getSessionWithOrgCheck: vi.fn(),
  hasSessionOrTransferOwnership: vi.fn(() => true),
  logSessionAudit: vi.fn(() => Promise.resolve()),
  revokeViewerSession: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../db', () => ({
  db: { select: vi.fn(), update: vi.fn() },
}));

vi.mock('../../db/schema', () => ({
  remoteSessions: { id: 'remoteSessions.id' },
  devices: { id: 'devices.id', orgId: 'devices.orgId' },
  deviceHardware: {},
  users: { id: 'users.id', name: 'users.name', email: 'users.email' },
  organizations: { id: 'organizations.id', name: 'organizations.name' },
}));

vi.mock('../../middleware/auth', () => ({
  requireScope: vi.fn(() => async (c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: 'org-111',
      accessibleOrgIds: ['org-111'],
      canAccessOrg: (id: string) => id === 'org-111',
    });
    return next();
  }),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: { DEVICES_READ: { resource: 'devices', action: 'read' } },
  canAccessSite: () => true,
}));

vi.mock('./helpers', () => ({
  getPagination: vi.fn(() => ({ page: 1, limit: 50, offset: 0 })),
  getIceServers: vi.fn(() => []),
  getDeviceWithOrgCheck: vi.fn(),
  getSessionWithOrgCheck,
  hasSessionOrTransferOwnership,
  checkSessionRateLimit: vi.fn(() => Promise.resolve({ allowed: true, currentCount: 0 })),
  checkUserSessionRateLimit: vi.fn(() => Promise.resolve({ allowed: true, currentCount: 0 })),
  logSessionAudit,
  // Pure classifier — mirror the real impl so the deny route resolves the audit
  // action; its taxonomy is unit-tested against the real fn in helpers.test.ts.
  classifyConsentDenyAction: (reason: string) =>
    reason === 'user' || reason === 'timeout' ? 'session_consent_denied' : 'session_consent_bypassed',
  resolveRemoteSessionPromptConfig: vi.fn(() =>
    Promise.resolve({
      mode: 'consent',
      consentUnavailableBehavior: 'proceed',
      notifyOnEnd: true,
      showIndicator: true,
      identityLevel: 'name_email',
    })
  ),
  buildTechnicianDisplay: vi.fn(() => ({ name: null, email: null, orgName: null })),
  MAX_ACTIVE_REMOTE_SESSIONS_PER_ORG: 10,
  MAX_ACTIVE_REMOTE_SESSIONS_PER_USER: 5,
}));

vi.mock('../../services/viewerTokenRevocation', () => ({ revokeViewerSession }));
vi.mock('../../services/remoteSessionTeardown', () => ({
  teardownDisconnectedSessions: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock('../../services/remoteAccessPolicy', () => ({
  checkRemoteAccess: vi.fn(() => Promise.resolve({ allowed: true })),
  resolveDesktopSessionPolicy: vi.fn(() =>
    Promise.resolve({ clipboard: 'both', idleTimeoutMinutes: 0, maxSessionDurationHours: 0 })
  ),
}));
vi.mock('../agentWs', () => ({ sendCommandToAgent: vi.fn(() => true) }));
vi.mock('../../services/remoteSessionAuth', () => ({
  createDesktopConnectCode: vi.fn(),
  createWsTicket: vi.fn(),
}));
vi.mock('../../services/clientIp', () => ({
  getTrustedClientIp: vi.fn(() => '10.0.0.1'),
  getTrustedClientIpOrUndefined: vi.fn(() => '10.0.0.1'),
}));
vi.mock('./recordingUrl', () => ({ normalizeRecordingUrl: vi.fn((u: unknown) => u) }));

import { sessionRoutes } from './sessions';
import { db } from '../../db';

const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '11111111-1111-4111-8111-111111111111';

function sessionRow(status: string) {
  return {
    session: { id: SESSION_ID, deviceId: DEVICE_ID, userId: 'user-1', type: 'desktop', status },
    device: { id: DEVICE_ID, orgId: 'org-111', siteId: 'site-a', agentId: 'agent-1' },
  };
}

function rigDenyUpdate() {
  const returning = vi
    .fn()
    .mockResolvedValue([{ id: SESSION_ID, status: 'denied', endedAt: new Date('2026-01-01T00:00:00Z') }]);
  vi.mocked(db.update).mockReturnValueOnce({
    set: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({ returning }) }),
  } as never);
  return { returning };
}

function denyReq(reason: string) {
  return new Request(`http://local/remote/sessions/${SESSION_ID}/deny`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
}

describe('POST /remote/sessions/:id/deny', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.update).mockReset();
    getSessionWithOrgCheck.mockReset();
    hasSessionOrTransferOwnership.mockReturnValue(true);
    logSessionAudit.mockResolvedValue(undefined);
    revokeViewerSession.mockResolvedValue(undefined);
    app = new Hono();
    app.route('/remote', sessionRoutes);
  });

  it('marks the session denied and audits session_consent_denied for reason=user', async () => {
    getSessionWithOrgCheck.mockResolvedValue(sessionRow('connecting'));
    rigDenyUpdate();

    const res = await app.request(denyReq('user'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('denied');

    expect(revokeViewerSession).toHaveBeenCalledWith(SESSION_ID);
    expect(logSessionAudit).toHaveBeenCalledWith(
      'session_consent_denied',
      'user-1',
      'org-111',
      expect.objectContaining({ sessionId: SESSION_ID, reason: 'user' }),
      '10.0.0.1'
    );
  });

  it('audits session_consent_denied for reason=timeout', async () => {
    getSessionWithOrgCheck.mockResolvedValue(sessionRow('connecting'));
    rigDenyUpdate();

    const res = await app.request(denyReq('timeout'));
    expect(res.status).toBe(200);
    expect(logSessionAudit).toHaveBeenCalledWith(
      'session_consent_denied',
      'user-1',
      'org-111',
      expect.objectContaining({ reason: 'timeout' }),
      '10.0.0.1'
    );
  });

  it('audits session_consent_bypassed for a non-deny reason (helper_absent)', async () => {
    getSessionWithOrgCheck.mockResolvedValue(sessionRow('connecting'));
    rigDenyUpdate();

    const res = await app.request(denyReq('helper_absent'));
    expect(res.status).toBe(200);
    expect(logSessionAudit).toHaveBeenCalledWith(
      'session_consent_bypassed',
      'user-1',
      'org-111',
      expect.objectContaining({ reason: 'helper_absent' }),
      '10.0.0.1'
    );
  });

  it('rejects a deny on a non-connecting session with 400', async () => {
    getSessionWithOrgCheck.mockResolvedValue(sessionRow('active'));

    const res = await app.request(denyReq('user'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.status).toBe('active');
    expect(db.update).not.toHaveBeenCalled();
    expect(logSessionAudit).not.toHaveBeenCalled();
  });

  it('returns 404 when the session is not found / not in the caller org', async () => {
    getSessionWithOrgCheck.mockResolvedValue(null);

    const res = await app.request(denyReq('user'));
    expect(res.status).toBe(404);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller does not own the session', async () => {
    getSessionWithOrgCheck.mockResolvedValue(sessionRow('connecting'));
    hasSessionOrTransferOwnership.mockReturnValue(false);

    const res = await app.request(denyReq('user'));
    expect(res.status).toBe(403);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('rejects an unknown reason with a 400 validation error', async () => {
    getSessionWithOrgCheck.mockResolvedValue(sessionRow('connecting'));

    const res = await app.request(denyReq('bogus'));
    expect(res.status).toBe(400);
  });
});
