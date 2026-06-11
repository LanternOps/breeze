import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Regression test for #800 Layer C / #861 / #862 — the amber
// "Agent silent (watchdog OK)" badge on the devices list relies on the API
// returning `watchdogStatus` and `mainAgentSilentSince` in the GET /devices
// response. Both fields are selected from the database in core.ts but
// were being dropped by the response mapper, so the UI never received them
// and the badge never rendered.
//
// This test asserts the response body contains both keys with the values
// from the DB row — a check the existing permission tests didn't make.

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    execute: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../db/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/schema')>();
  return { ...actual };
});

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'a@b.c', name: 'A' },
      scope: 'organization',
      orgId: 'org-1',
      partnerId: null,
      accessibleOrgIds: ['org-1'],
      canAccessOrg: (orgId: string) => orgId === 'org-1',
      orgCondition: () => undefined,
      token: { mfa: false },
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    c.set('permissions', {
      permissions: [{ resource, action }],
      partnerId: null,
      orgId: 'org-1',
      roleId: 'role-1',
      scope: 'organization',
    });
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../services/remoteAccessPolicy', () => ({
  resolveRemoteAccessForDevice: vi.fn().mockResolvedValue({ policyId: null, settings: {} }),
}));
vi.mock('../../services/remoteAccessLauncher', () => ({
  resolveRemoteAccessLaunch: vi.fn().mockReturnValue({ launchUrl: null, skipReason: 'no_provider_configured' }),
}));
vi.mock('../agentWs', () => ({
  sendCommandToAgent: vi.fn(),
  isAgentConnected: vi.fn().mockReturnValue(false),
}));
vi.mock('../../services/commandQueue', () => ({
  CommandTypes: { SELF_UNINSTALL: 'self_uninstall' },
  queueCommandForExecution: vi.fn(),
}));
vi.mock('../agents/enrollment', () => ({
  getGlobalEnrollmentSecret: vi.fn().mockReturnValue(null),
}));

import { coreRoutes } from './core';
import { db } from '../../db';

function rigDeviceListRows(rows: unknown[]) {
  const offset = vi.fn().mockResolvedValue(rows);
  const limit = vi.fn().mockReturnValue({ offset });
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ orderBy });
  const leftJoin = vi.fn().mockReturnValue({ where });
  const from = vi.fn().mockReturnValue({ leftJoin });
  vi.mocked(db.select).mockReturnValue({ from } as never);
  vi.mocked(db.execute).mockResolvedValue([] as never);
}

describe('GET /devices — response shape', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', coreRoutes);
  });

  it('includes watchdogStatus and mainAgentSilentSince in each list row (regression for #862 amber badge)', async () => {
    const silentSince = new Date('2026-05-26T19:24:57.519Z');
    rigDeviceListRows([
      {
        id: '33333333-3333-4333-8333-333333333333',
        orgId: 'org-1',
        siteId: 'site-1',
        agentId: 'agent-win-02',
        hostname: 'WIN-FILESERVER-02',
        displayName: 'File Server',
        osType: 'windows',
        deviceRole: 'unknown',
        deviceRoleSource: 'auto',
        osVersion: '10.0.20348',
        osBuild: null,
        architecture: 'x64',
        agentVersion: 'v0.67.0',
        status: 'offline',
        watchdogStatus: 'connected',
        mainAgentSilentSince: silentSince,
        lastSeenAt: new Date('2026-05-26T19:19:57.519Z'),
        enrolledAt: new Date('2026-04-26T19:39:57.519Z'),
        tags: ['e2e'],
        customFields: {},
        desktopAccess: null,
        lastUser: null,
        uptimeSeconds: null,
        isHeadless: false,
        createdAt: new Date('2026-05-26T19:39:57.519Z'),
        updatedAt: new Date('2026-05-26T19:41:26.390Z'),
        cpuModel: null,
        cpuCores: null,
        ramTotalMb: null,
        diskTotalGb: null,
      },
    ]);

    const res = await app.request('/devices?limit=50', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    const row = body.data[0];

    // The two fields the response mapper was silently dropping.
    expect(row).toHaveProperty('watchdogStatus', 'connected');
    expect(row).toHaveProperty('mainAgentSilentSince', silentSince.toISOString());
  });

  it('returns null watchdogStatus / mainAgentSilentSince for healthy rows (still present in shape)', async () => {
    rigDeviceListRows([
      {
        id: '11111111-1111-4111-8111-111111111111',
        orgId: 'org-1',
        siteId: 'site-1',
        agentId: 'agent-mac-01',
        hostname: 'macbook-test-01.local',
        displayName: null,
        osType: 'macos',
        deviceRole: 'workstation',
        deviceRoleSource: 'auto',
        osVersion: '14.5.0',
        osBuild: null,
        architecture: 'arm64',
        agentVersion: 'v0.67.0',
        status: 'online',
        watchdogStatus: null,
        mainAgentSilentSince: null,
        lastSeenAt: new Date(),
        enrolledAt: new Date(),
        tags: [],
        customFields: {},
        desktopAccess: null,
        lastUser: null,
        uptimeSeconds: null,
        isHeadless: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        cpuModel: null,
        cpuCores: null,
        ramTotalMb: null,
        diskTotalGb: null,
      },
    ]);

    const res = await app.request('/devices?limit=50', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.data[0];

    // Keys must exist on the shape even when null — UI distinguishes
    // "field absent" (older API) from "field present, value null"
    // (healthy device on a new API).
    expect(Object.prototype.hasOwnProperty.call(row, 'watchdogStatus')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(row, 'mainAgentSilentSince')).toBe(true);
    expect(row.watchdogStatus).toBeNull();
    expect(row.mainAgentSilentSince).toBeNull();
  });
});
