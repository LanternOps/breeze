import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { getTableName, is, Table } from 'drizzle-orm';

// Hold a configurable partner-settings value the mocked select chain returns.
// Each test mutates this before calling app.request().
let mockPartnerSettings: unknown = {};

// A fully chainable, table-aware query-builder stub. Every chain method
// (from/innerJoin/where/orderBy/limit) returns the same node so any call
// shape core.ts's GET /devices/:id handler exercises (hardware, network
// interfaces, metrics, memberships, site, org, partner settings) resolves
// without throwing, instead of crashing partway through on an unmocked
// chain shape (which previously meant the GET handler never reached the
// launcher-availability code at all -- see #3402). The only query that
// needs a real answer is the partner-settings lookup keyed off `.from(partners)`;
// everything else safely resolves to an empty array.
function makeSelectMock() {
  return vi.fn(() => {
    let fromTableName: string | null = null;
    const resolveRows = (): unknown[] =>
      fromTableName === 'partners' ? [{ settings: mockPartnerSettings }] : [];
    const node: any = {
      from: vi.fn((table: unknown) => {
        try {
          fromTableName = is(table, Table) ? getTableName(table as Table) : null;
        } catch {
          fromTableName = null;
        }
        return node;
      }),
      innerJoin: vi.fn(() => node),
      where: vi.fn(() => node),
      orderBy: vi.fn(() => node),
      limit: vi.fn(async () => resolveRows()),
      then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(resolveRows()).then(resolve, reject),
    };
    return node;
  });
}

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: makeSelectMock(),
  }
}));

vi.mock('../../db/schema', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual };
});

// Wraps the REAL decryptForColumn so existing behavior (encrypt-at-rest
// no-op for plaintext) is unchanged, while letting tests assert on whether
// it was invoked at all -- the whole point of #3402's availability/issuance
// split.
vi.mock('../../services/secretCrypto', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, decryptForColumn: vi.fn(actual.decryptForColumn as (...args: unknown[]) => unknown) };
});

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: '11111111-1111-1111-1111-111111111111', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: 'org-123',
      partnerId: null,
      accessibleOrgIds: ['org-123'],
      // This route is reached by a person clicking Connect, so the mocked
      // context carries the same discriminator the real one would. The
      // per-technician provider preference is gated on it.
      principal: { kind: 'user_session' },
      canAccessOrg: (orgId: string) => orgId === 'org-123'
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  // Mirrors the real allowlist-of-one rather than stubbing a constant, so this
  // suite still exercises the gate it depends on.
  isInteractiveUserSession: vi.fn((a: any) => a?.principal?.kind === 'user_session'),
}));

vi.mock('./helpers', () => ({
  getPagination: vi.fn(() => ({ page: 1, limit: 50, offset: 0 })),
  getDeviceWithOrgCheck: vi.fn(),
  getDeviceWithOrgAndSiteCheck: vi.fn(),
  SITE_ACCESS_DENIED: Symbol('SITE_ACCESS_DENIED'),
  stripSensitiveDeviceFields: vi.fn((d: unknown) => d),
}));

vi.mock('../../services/remoteAccessPolicy', () => ({
  resolveRemoteAccessForDevice: vi.fn(async () => ({ policyId: null, policyName: null, settings: {} }))
}));

vi.mock('../../services/agentWs', () => ({
  sendCommandToAgent: vi.fn(),
  isAgentConnected: vi.fn(() => false)
}));

vi.mock('../../services/commandQueue', () => ({
  CommandTypes: {}
}));

vi.mock('../agents/enrollment', () => ({
  getGlobalEnrollmentSecret: vi.fn(() => null)
}));

vi.mock('../../services/enrollmentKeySecurity', () => ({
  hashEnrollmentKey: vi.fn((k: string) => `hash:${k}`)
}));

vi.mock('../../services/auditEvents', () => ({
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
  writeRouteAudit: vi.fn()
}));

vi.mock('../../services/sentry', () => ({
  captureException: vi.fn()
}));

import { coreRoutes } from './core';
import { getDeviceWithOrgCheck, getDeviceWithOrgAndSiteCheck } from './helpers';
import { writeRouteAudit } from '../../services/auditEvents';
import { captureException } from '../../services/sentry';
import { requirePermission, requireMfa } from '../../middleware/auth';
import { decryptForColumn } from '../../services/secretCrypto';

// Snapshot mock.calls captured at module-load time (i.e. when core.ts ran its
// route registrations). beforeEach() clears mock state, so we cannot read these
// records inside a test body — they must be frozen here, before any test runs.
const requirePermissionCallsAtImport = vi
  .mocked(requirePermission)
  .mock.calls.map((c) => [...c]);
const requireMfaCallCountAtImport = vi.mocked(requireMfa).mock.calls.length;

const deviceId = '22222222-2222-2222-2222-222222222222';

function setPartnerSettings(settings: unknown) {
  mockPartnerSettings = settings;
}

describe('POST /devices/:id/remote-access-launch', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPartnerSettings = {};
    app = new Hono();
    app.route('/devices', coreRoutes);
  });

  // Registration-time gate test. The launcher POST issues URLs that may carry
  // substituted provider credentials, so it must share the gate used by the
  // WebRTC initiate flow (apps/api/src/routes/remote/index.ts:12):
  // requirePermission('remote', 'access') + requireMfa().
  it('is gated by remote:access permission and requireMfa at registration time', () => {
    expect(
      requirePermissionCallsAtImport.some((c) => c[0] === 'remote' && c[1] === 'access'),
    ).toBe(true);
    expect(requireMfaCallCountAtImport).toBeGreaterThan(0);
  });

  it('returns 404 when device does not exist', async () => {
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue(null as never);
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(null as never);
    const res = await app.request(`/devices/${deviceId}/remote-access-launch`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' }
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 with skipReason when no launcher provider is configured', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({
      id: deviceId,
      orgId: 'org-123',
      hostname: 'host-1',
      siteId: 'site-1',
      customFields: {}
    } as never);
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue({
      id: deviceId,
      orgId: 'org-123',
      hostname: 'host-1',
      customFields: {}
    } as never);
    setPartnerSettings({});
    const res = await app.request(`/devices/${deviceId}/remote-access-launch`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' }
    });
    expect(res.status).toBe(404);
    const body = await res.json() as { code?: string };
    expect(body.code).toBe('no_provider_configured');
    expect(writeRouteAudit).not.toHaveBeenCalled();
  });

  it('returns 200 with launchUrl on success and audits issuance', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({
      id: deviceId,
      orgId: 'org-123',
      hostname: 'host-1',
      siteId: 'site-1',
      customFields: { rustdesk_id: '294064193' }
    } as never);
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue({
      id: deviceId,
      orgId: 'org-123',
      hostname: 'host-1',
      customFields: { rustdesk_id: '294064193' }
    } as never);
    setPartnerSettings({
      remoteAccessProviders: {
        defaultProviderId: 'rustdesk',
        providers: [
          {
            id: 'rustdesk',
            name: 'RustDesk',
            urlTemplate: 'rustdesk://{id}?password={password}',
            customFieldKey: 'rustdesk_id',
            password: 'p#x',
            enabled: true,
          }
        ]
      }
    });

    const res = await app.request(`/devices/${deviceId}/remote-access-launch`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' }
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { launchUrl?: string; scheme?: string; providerId?: string };
    expect(body.launchUrl).toBe('rustdesk://294064193?password=p%23x');
    expect(body.scheme).toBe('rustdesk');
    expect(body.providerId).toBe('rustdesk');

    expect(writeRouteAudit).toHaveBeenCalledOnce();
    const auditCall = vi.mocked(writeRouteAudit).mock.calls[0]![1];
    expect(auditCall.action).toBe('device.remote_access_launch_url.issued');
    expect(auditCall.resourceType).toBe('device');
    expect(auditCall.resourceId).toBe(deviceId);
    expect(auditCall.orgId).toBe('org-123');
    expect(auditCall.details).toEqual({
      deviceId,
      providerId: 'rustdesk',
      scheme: 'rustdesk'
    });

    // CRITICAL: ensure the URL and password are NOT in the audit details
    const detailsStr = JSON.stringify(auditCall.details ?? {});
    expect(detailsStr).not.toContain('p#x');
    expect(detailsStr).not.toContain('p%23x');
    expect(detailsStr).not.toContain('294064193');
    expect(detailsStr).not.toContain('password');
    expect(detailsStr).not.toContain('rustdesk://');
  });

  it('returns 422 + audit event + Sentry capture when scheme rejected at substitution', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({
      id: deviceId,
      orgId: 'org-123',
      hostname: 'host-1',
      siteId: 'site-1',
      customFields: { k: 'avas' }
    } as never);
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue({
      id: deviceId,
      orgId: 'org-123',
      hostname: 'host-1',
      customFields: { k: 'avas' }
    } as never);
    setPartnerSettings({
      remoteAccessProviders: {
        defaultProviderId: 'sneaky',
        providers: [
          {
            id: 'sneaky',
            name: 'Sneaky',
            urlTemplate: 'j{id}cript:alert(1)',
            customFieldKey: 'k',
            enabled: true,
          }
        ]
      }
    });

    const res = await app.request(`/devices/${deviceId}/remote-access-launch`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' }
    });
    expect(res.status).toBe(422);
    const body = await res.json() as { code?: string };
    expect(body.code).toBe('scheme_not_allowed');

    expect(writeRouteAudit).toHaveBeenCalledOnce();
    const auditCall = vi.mocked(writeRouteAudit).mock.calls[0]![1];
    expect(auditCall.action).toBe('device.remote_access_launch_url.scheme_rejected');
    expect(auditCall.result).toBe('denied');
    expect(auditCall.details).toEqual({
      deviceId,
      providerId: 'sneaky'
    });
    // No URL or substituted value should appear anywhere in the audit row.
    const detailsStr = JSON.stringify(auditCall.details ?? {});
    expect(detailsStr).not.toContain('javascript');
    expect(detailsStr).not.toContain('alert');
    expect(detailsStr).not.toContain('avas');

    expect(captureException).toHaveBeenCalledOnce();
  });

  it('GET /devices/:id no longer exposes remoteAccessLaunchUrl', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({
      id: deviceId,
      orgId: 'org-123',
      hostname: 'host-1',
      siteId: 'site-1',
      customFields: {}
    } as never);
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValue({
      id: deviceId,
      orgId: 'org-123',
      hostname: 'host-1',
      siteId: 'site-1',
      customFields: { rustdesk_id: '294064193' }
    } as never);
    setPartnerSettings({
      remoteAccessProviders: {
        defaultProviderId: 'rustdesk',
        providers: [
          {
            id: 'rustdesk',
            name: 'RustDesk',
            urlTemplate: 'rustdesk://{id}?password={password}',
            customFieldKey: 'rustdesk_id',
            password: 'p#x',
            enabled: true,
          }
        ]
      }
    });

    const res = await app.request(`/devices/${deviceId}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });
    if (res.status === 200) {
      const body = await res.json() as Record<string, unknown>;
      expect(body).not.toHaveProperty('remoteAccessLaunchUrl');
    }
  });

  // -----------------------------------------------------------------------
  // #3402: GET /devices/:id must resolve `hasRemoteAccessLauncher` via the
  // availability-only path (no decrypt, no substitution), while POST
  // /devices/:id/remote-access-launch (issuance) still decrypts to build
  // the real launch URL. decryptForColumn is wrapped (not stubbed) at the
  // top of this file so real behavior is unchanged and we can assert on
  // invocation.
  // -----------------------------------------------------------------------
  describe('#3402 — availability (GET) never decrypts; issuance (POST) does', () => {
    const provider = {
      id: 'rustdesk',
      name: 'RustDesk',
      urlTemplate: 'rustdesk://{id}?password={password}',
      customFieldKey: 'rustdesk_id',
      password: 'p#x',
      enabled: true,
    };

    it('GET /devices/:id resolves hasRemoteAccessLauncher=true WITHOUT ever calling decryptForColumn', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({
        id: deviceId,
        orgId: 'org-123',
        hostname: 'host-1',
        siteId: 'site-1',
        customFields: { rustdesk_id: '294064193' }
      } as never);
      setPartnerSettings({
        remoteAccessProviders: { defaultProviderId: 'rustdesk', providers: [provider] }
      });

      const res = await app.request(`/devices/${deviceId}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { hasRemoteAccessLauncher?: boolean; remoteAccessLaunchSkipReason?: unknown };
      expect(body.hasRemoteAccessLauncher).toBe(true);
      expect(body.remoteAccessLaunchSkipReason).toBeNull();

      // The whole point of the split: the GET path must never touch the
      // password-bearing decrypt call.
      expect(decryptForColumn).not.toHaveBeenCalled();
    });

    it('GET /devices/:id sets skipReason=missing_device_identifier without decrypting, matching what POST would report', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({
        id: deviceId,
        orgId: 'org-123',
        hostname: 'host-1',
        siteId: 'site-1',
        customFields: {}
      } as never);
      setPartnerSettings({
        remoteAccessProviders: { defaultProviderId: 'rustdesk', providers: [provider] }
      });

      const res = await app.request(`/devices/${deviceId}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { hasRemoteAccessLauncher?: boolean; remoteAccessLaunchSkipReason?: unknown };
      expect(body.hasRemoteAccessLauncher).toBe(false);
      expect(body.remoteAccessLaunchSkipReason).toBe('missing_device_identifier');
      expect(decryptForColumn).not.toHaveBeenCalled();
    });

    it('POST /devices/:id/remote-access-launch (issuance) DOES call decryptForColumn to build the URL', async () => {
      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({
        id: deviceId,
        orgId: 'org-123',
        hostname: 'host-1',
        siteId: 'site-1',
        customFields: { rustdesk_id: '294064193' }
      } as never);
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValue({
        id: deviceId,
        orgId: 'org-123',
        hostname: 'host-1',
        customFields: { rustdesk_id: '294064193' }
      } as never);
      setPartnerSettings({
        remoteAccessProviders: { defaultProviderId: 'rustdesk', providers: [provider] }
      });

      const res = await app.request(`/devices/${deviceId}/remote-access-launch`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });
      expect(res.status).toBe(200);
      expect(decryptForColumn).toHaveBeenCalledWith('partners', 'settings', 'p#x');
    });

    it('GET availability and POST issuance agree on skip reason for the same missing-provider config', async () => {
      const missingConfig = { remoteAccessProviders: {} };

      vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({
        id: deviceId,
        orgId: 'org-123',
        hostname: 'host-1',
        siteId: 'site-1',
        customFields: { rustdesk_id: '294064193' }
      } as never);
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValue({
        id: deviceId,
        orgId: 'org-123',
        hostname: 'host-1',
        customFields: { rustdesk_id: '294064193' }
      } as never);
      setPartnerSettings(missingConfig);

      const getRes = await app.request(`/devices/${deviceId}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });
      expect(getRes.status).toBe(200);
      const getBody = await getRes.json() as { remoteAccessLaunchSkipReason?: unknown };
      expect(getBody.remoteAccessLaunchSkipReason).toBe('no_provider_configured');

      const postRes = await app.request(`/devices/${deviceId}/remote-access-launch`, {
        method: 'POST',
        headers: { Authorization: 'Bearer token' }
      });
      expect(postRes.status).toBe(404);
      const postBody = await postRes.json() as { code?: string };
      expect(postBody.code).toBe('no_provider_configured');
    });
  });
});
