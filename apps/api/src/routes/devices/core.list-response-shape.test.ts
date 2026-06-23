import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Regression test for #800 Layer C / #861 / #862 — the amber
// "Agent silent (watchdog OK)" badge on the devices list relies on the API
// returning watchdog health fields in the GET /devices response. These fields
// are selected from the database in core.ts but
// were being dropped by the response mapper, so the UI never received them
// and the badge never rendered.
//
// This test asserts the response body contains both keys with the values
// from the DB row — a check the existing permission tests didn't make.
//
// Extended for #1273: the "Reboot pending" list badge has the identical
// failure mode — `pendingReboot` is selected from the DB in core.ts but was
// omitted by the same response mapper, so the list/grid badge never rendered
// (the device-detail page worked because it returns the full row).

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
vi.mock('../../services/agentUpdateTargets', () => ({
  buildDeviceUpdateMetadata: vi.fn(async (devices: Array<{ id: string }>) => new Map(devices.map((device) => [device.id, {
    agentUpdate: {
      available: false,
      currentVersion: null,
      targetVersion: null,
      mode: 'manual',
      autoInstall: false,
      pinned: false,
      reason: 'current',
    },
    watchdogUpdate: {
      available: false,
      currentVersion: null,
      targetVersion: null,
      mode: 'manual',
      autoInstall: false,
      pinned: false,
      reason: 'current',
    },
  }]))),
}));

import { coreRoutes } from './core';
import { db } from '../../db';
import { buildDeviceUpdateMetadata } from '../../services/agentUpdateTargets';

function rigDeviceListRows(rows: unknown[], componentCommandRows: unknown[] = []) {
  const offset = vi.fn().mockResolvedValue(rows);
  const limit = vi.fn().mockReturnValue({ offset });
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ orderBy });
  // Two chained leftJoins (deviceHardware, then deviceReliability #1720), so
  // each leftJoin returns a thenable that also exposes the next leftJoin.
  const chain: Record<string, unknown> = {};
  const leftJoin = vi.fn().mockReturnValue(chain);
  chain.leftJoin = leftJoin;
  chain.where = where;
  const from = vi.fn().mockReturnValue({ leftJoin });

  const commandOrderBy = vi.fn().mockResolvedValue(componentCommandRows);
  const commandWhere = vi.fn().mockReturnValue({ orderBy: commandOrderBy });
  const commandFrom = vi.fn().mockReturnValue({ where: commandWhere });

  vi.mocked(db.select).mockImplementation((fields?: Record<string, unknown>) => {
    if (fields?.type && fields?.payload && fields?.status && fields?.createdAt) {
      return { from: commandFrom } as never;
    }
    return { from } as never;
  });
  vi.mocked(db.execute).mockResolvedValue([] as never);
}

describe('GET /devices — response shape', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', coreRoutes);
  });

  it('includes watchdog health fields in each list row', async () => {
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
        watchdogVersion: 'v0.67.1',
        status: 'offline',
        watchdogStatus: 'connected',
        mainAgentSilentSince: silentSince,
        pendingReboot: true,
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
        reliabilityScore: 42,
        reliabilityTrend: 'degrading',
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

    // The fields the response mapper was silently dropping.
    expect(row).toHaveProperty('watchdogStatus', 'connected');
    expect(row).toHaveProperty('mainAgentSilentSince', silentSince.toISOString());
    expect(row).toHaveProperty('watchdogVersion', 'v0.67.1');
    // #1273 regression — pendingReboot must survive the mapper for the list badge.
    expect(row).toHaveProperty('pendingReboot', true);
    // #1720 — reliability score + trend surfaced for the list column.
    expect(row).toHaveProperty('reliabilityScore', 42);
    expect(row).toHaveProperty('reliabilityTrend', 'degrading');
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
        watchdogVersion: null,
        status: 'online',
        watchdogStatus: null,
        mainAgentSilentSince: null,
        pendingReboot: false,
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
        reliabilityScore: null,
        reliabilityTrend: null,
      },
    ]);

    const res = await app.request('/devices?limit=50', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.data[0];

    // #1720 — reliability keys present even with no computed score (null),
    // so the UI distinguishes "no score yet" (dash) from "field absent".
    expect(Object.prototype.hasOwnProperty.call(row, 'reliabilityScore')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(row, 'reliabilityTrend')).toBe(true);
    expect(row.reliabilityScore).toBeNull();
    expect(row.reliabilityTrend).toBeNull();

    // Keys must exist on the shape even when null — UI distinguishes
    // "field absent" (older API) from "field present, value null"
    // (healthy device on a new API).
    expect(Object.prototype.hasOwnProperty.call(row, 'watchdogStatus')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(row, 'mainAgentSilentSince')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(row, 'watchdogVersion')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(row, 'pendingReboot')).toBe(true);
    expect(row.watchdogStatus).toBeNull();
    expect(row.mainAgentSilentSince).toBeNull();
    expect(row.watchdogVersion).toBeNull();
    expect(row.pendingReboot).toBe(false);
  });

  it('marks online rows with pending component commands as updating with operation-specific labels', async () => {
    const deviceId = '22222222-2222-4222-8222-222222222222';
    vi.mocked(buildDeviceUpdateMetadata).mockResolvedValueOnce(new Map([[deviceId, {
      agentUpdate: {
        available: false,
        currentVersion: '0.82.1',
        targetVersion: '0.82.1',
        mode: 'manual',
        autoInstall: false,
        pinned: false,
        reason: 'current',
      },
      watchdogUpdate: {
        available: true,
        currentVersion: null,
        targetVersion: '0.82.1',
        mode: 'manual',
        autoInstall: false,
        pinned: false,
        missing: true,
        reason: 'manual',
      },
    }]]));

    rigDeviceListRows([
      {
        id: deviceId,
        orgId: 'org-1',
        siteId: 'site-1',
        agentId: 'agent-linux-01',
        hostname: 'linux-test-01',
        displayName: null,
        osType: 'linux',
        deviceRole: 'workstation',
        deviceRoleSource: 'auto',
        osVersion: 'Debian 12',
        osBuild: null,
        architecture: 'amd64',
        agentVersion: '0.82.1',
        watchdogVersion: null,
        status: 'online',
        watchdogStatus: null,
        mainAgentSilentSince: null,
        pendingReboot: false,
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
    ], [
      {
        deviceId,
        type: 'update_watchdog',
        payload: { component: 'watchdog', version: '0.82.1', reason: 'missing' },
        status: 'sent',
        createdAt: new Date(),
      },
    ]);

    const res = await app.request('/devices?limit=50', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.data[0];

    expect(row.status).toBe('updating');
    expect(row.componentUpdateStatusLabel).toBe('Installing watchdog');
    expect(row.componentUpdateStatusFullLabel).toBe('Installing watchdog');
  });

  it('does not mark a row as updating when a stale component command target is already installed', async () => {
    const deviceId = '44444444-4444-4444-8444-444444444444';
    vi.mocked(buildDeviceUpdateMetadata).mockResolvedValueOnce(new Map([[deviceId, {
      agentUpdate: {
        available: false,
        currentVersion: '0.82.1',
        targetVersion: '0.82.1',
        mode: 'manual',
        autoInstall: false,
        pinned: false,
        reason: 'current',
      },
      watchdogUpdate: {
        available: false,
        currentVersion: '0.82.1',
        targetVersion: '0.82.1',
        mode: 'manual',
        autoInstall: false,
        pinned: false,
        reason: 'current',
      },
    }]]));

    rigDeviceListRows([
      {
        id: deviceId,
        orgId: 'org-1',
        siteId: 'site-1',
        agentId: 'agent-mac-01',
        hostname: 'macbook-test-01',
        displayName: null,
        osType: 'macos',
        deviceRole: 'workstation',
        deviceRoleSource: 'auto',
        osVersion: '15.0',
        osBuild: null,
        architecture: 'arm64',
        agentVersion: '0.82.1',
        watchdogVersion: '0.82.1',
        status: 'online',
        watchdogStatus: 'connected',
        mainAgentSilentSince: null,
        pendingReboot: false,
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
    ], [
      {
        deviceId,
        type: 'update_agent',
        payload: { component: 'agent', version: '0.82.1' },
        status: 'sent',
        createdAt: new Date(),
      },
    ]);

    const res = await app.request('/devices?limit=50', {
      method: 'GET',
      headers: { Authorization: 'Bearer t' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const row = body.data[0];

    expect(row.status).toBe('online');
    expect(row.componentUpdateStatusLabel).toBeNull();
    expect(row.componentUpdateStatusFullLabel).toBeNull();
  });
});
