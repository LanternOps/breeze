import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Spread the actual db module so unrelated helpers pulled in transitively
// (e.g. commandQueue's use of runOutsideDbContext) keep working; only the
// `db` client itself is replaced with a selectDistinct-only stub.
vi.mock('../../db', async () => {
  const actual = await vi.importActual<any>('../../db');
  return { ...actual, db: { selectDistinct: vi.fn() } };
});

// Spread the actual schema so unrelated modules pulled in transitively (e.g.
// auth middleware -> permissions -> configurationPolicy, which reference
// other schema tables like backupConfigs) keep their real exports; only
// deviceRecoveryKeys is swapped for a minimal column stub.
vi.mock('../../db/schema', async () => {
  const actual = await vi.importActual<any>('../../db/schema');
  return { ...actual, deviceRecoveryKeys: { deviceId: 'drk.deviceId', status: 'drk.status' } };
});

vi.mock('../../middleware/auth', async () => {
  const actual = await vi.importActual<any>('../../middleware/auth');
  return { ...actual, requireScope: vi.fn(() => async (_c: any, next: any) => next()) };
});

const { listStatusRowsMock, getUserPermissionsMock } = vi.hoisted(() => ({
  listStatusRowsMock: vi.fn(),
  getUserPermissionsMock: vi.fn(),
}));

vi.mock('../../services/permissions', async () => {
  const actual = await vi.importActual<any>('../../services/permissions');
  return { ...actual, getUserPermissions: getUserPermissionsMock };
});

vi.mock('./helpers', async () => {
  const actual = await vi.importActual<any>('./helpers');
  return { ...actual, listStatusRows: listStatusRowsMock };
});

vi.mock('../../services/securityPosture', () => ({ getSecurityPostureTrend: vi.fn(async () => []) }));

import { db } from '../../db';
import { getSecurityPostureTrend } from '../../services/securityPosture';
import { complianceRoutes } from './compliance';

const DEV_ESCROWED = '11111111-1111-4111-8111-111111111111';
const DEV_BARE = '22222222-2222-4222-8222-222222222222';

// Full StatusRow shape consumed by toStatusResponse — copy field defaults
// from listStatusRows' mapping in helpers.ts:234.
function statusRow(overrides: Record<string, unknown>) {
  return {
    deviceId: DEV_BARE, orgId: '33333333-3333-4333-8333-333333333333',
    deviceName: 'pc', os: 'windows', deviceState: 'online',
    provider: 'windows_defender', providerVersion: null, definitionsVersion: null,
    definitionsDate: null, realTimeProtection: true, threatCount: 0,
    firewallEnabled: true, encryptionStatus: 'encrypted', encryptionDetails: null,
    localAdminSummary: null, passwordPolicySummary: null, gatekeeperEnabled: null,
    lastScan: null, lastScanType: null,
    ...overrides,
  };
}

function buildApp(authOverrides: Record<string, unknown> = {}) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization', orgId: null, partnerId: null,
      accessibleOrgIds: [], user: { id: 'u' },
      orgCondition: () => undefined, canAccessOrg: () => true,
      ...authOverrides,
    } as any);
    await next();
  });
  app.route('/', complianceRoutes);
  return app;
}

function mockEscrowRows(deviceIds: string[]) {
  (db.selectDistinct as ReturnType<typeof vi.fn>).mockReturnValue({
    from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(deviceIds.map((deviceId) => ({ deviceId }))) }),
  });
}

describe('GET /encryption', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'read' }],
      allowedSiteIds: undefined,
    });
  });

  it('reports real escrow status, not the old heuristic', async () => {
    listStatusRowsMock.mockResolvedValue([
      statusRow({ deviceId: DEV_ESCROWED, deviceName: 'has-key' }),
      statusRow({ deviceId: DEV_BARE, deviceName: 'no-key' }),
    ]);
    mockEscrowRows([DEV_ESCROWED]);
    const res = await buildApp().request('/encryption');
    expect(res.status).toBe(200);
    const json = await res.json();
    const byName = Object.fromEntries(json.data.map((d: any) => [d.deviceName, d]));
    expect(byName['has-key'].recoveryKeyEscrowed).toBe(true);
    expect(byName['no-key'].recoveryKeyEscrowed).toBe(false); // encrypted windows, old heuristic said true
    expect(json.summary.recoveryKeysEscrowed).toBe(1);
  });

  it('escrow=missing filters to devices without active keys', async () => {
    listStatusRowsMock.mockResolvedValue([
      statusRow({ deviceId: DEV_ESCROWED, deviceName: 'has-key' }),
      statusRow({ deviceId: DEV_BARE, deviceName: 'no-key' }),
    ]);
    mockEscrowRows([DEV_ESCROWED]);
    const res = await buildApp().request('/encryption?escrow=missing');
    const json = await res.json();
    expect(json.data).toHaveLength(1);
    expect(json.data[0].deviceName).toBe('no-key');
  });

  it('uses real agent-reported volumes when present, synthesized fallback otherwise', async () => {
    listStatusRowsMock.mockResolvedValue([
      statusRow({
        deviceId: DEV_ESCROWED, deviceName: 'real-vols',
        encryptionDetails: { source: 'bitlocker', volumes: [{ mount: 'C:', method: 'xtsaes128', protected: true, status: 'FullyEncrypted', percentEncrypted: 100 }] },
      }),
      statusRow({ deviceId: DEV_BARE, deviceName: 'fallback' }),
    ]);
    mockEscrowRows([]);
    const res = await buildApp().request('/encryption');
    const json = await res.json();
    const byName = Object.fromEntries(json.data.map((d: any) => [d.deviceName, d]));
    expect(byName['real-vols'].volumes[0]).toEqual({ drive: 'C:', encrypted: true, method: 'xtsaes128', status: 'FullyEncrypted', percentEncrypted: 100 });
    expect(byName['fallback'].volumes[0].drive).toBe('C:');
    expect(byName['fallback'].volumes[0].status).toBeNull();
    expect(byName['fallback'].volumes[0]).not.toHaveProperty('size');
  });

  // #9607: Breeze does not collect TPM state, and the method must come from
  // what the agent reported — not from the OS name.
  it('never fabricates TPM presence or an OS-derived method', async () => {
    listStatusRowsMock.mockResolvedValue([
      statusRow({
        deviceId: DEV_ESCROWED, deviceName: 'win-reported',
        encryptionDetails: { source: 'bitlocker', volumes: [{ mount: 'C:', method: '6', protected: true, status: '1', percentEncrypted: 100 }] },
      }),
      statusRow({ deviceId: DEV_BARE, deviceName: 'win-no-details' }),
      statusRow({
        deviceId: '55555555-5555-4555-8555-555555555555', deviceName: 'win-empty-volumes',
        encryptionDetails: { source: 'bitlocker', volumes: [] },
      }),
      statusRow({ deviceId: '44444444-4444-4444-8444-444444444444', deviceName: 'mac-unencrypted', os: 'macos', encryptionStatus: 'unencrypted' }),
    ]);
    mockEscrowRows([]);
    const res = await buildApp().request('/encryption');
    const json = await res.json();
    const byName = Object.fromEntries(json.data.map((d: any) => [d.deviceName, d]));

    for (const d of json.data) expect(d.tpmPresent).toBeNull();

    expect(byName['win-reported'].encryptionMethod).toBe('bitlocker');
    expect(byName['win-reported'].volumes[0]).toMatchObject({ method: 'xtsaes128', status: 'FullyEncrypted' });
    expect(byName['win-no-details'].encryptionMethod).toBe('unknown');
    expect(byName['win-no-details'].volumes[0].method).toBe('Unknown');
    expect(byName['mac-unencrypted'].encryptionMethod).toBe('none');
    // Reported BitLocker with no volume rows: the synthesized volume agrees
    // with the device-level method instead of contradicting it.
    expect(byName['win-empty-volumes'].encryptionMethod).toBe('bitlocker');
    expect(byName['win-empty-volumes'].volumes[0].method).toBe('BitLocker');

    expect(json.summary.methodCounts).toEqual({ bitlocker: 2, filevault: 0, luks: 0, none: 1, unknown: 1 });
  });
});

describe('GET /encryption summary (#9609)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'read' }],
      allowedSiteIds: undefined,
    });
  });

  it('state tiles and method tiles are computed from the same filtered set', async () => {
    const details = { source: 'bitlocker', volumes: [{ mount: 'C:', method: '6', protected: true, status: '1', percentEncrypted: 100 }] };
    listStatusRowsMock.mockResolvedValue([
      statusRow({ deviceId: DEV_ESCROWED, deviceName: 'has-key', encryptionDetails: details }),
      statusRow({ deviceId: DEV_BARE, deviceName: 'no-key', encryptionDetails: details }),
    ]);
    mockEscrowRows([DEV_ESCROWED]);
    const res = await buildApp().request('/encryption?escrow=missing');
    const json = await res.json();
    expect(json.summary.methodCounts.bitlocker).toBe(1);
    expect(json.summary.fullyEncrypted).toBe(1);
    expect(json.summary.total).toBe(1);
    expect(json.summary.recoveryKeysEscrowed).toBe(0);
  });
});

describe('GET /firewall — unknown firewall state (#8252)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'read' }],
      allowedSiteIds: undefined,
    });
  });

  it('reports an unknown reading as null, not disabled, and counts it separately', async () => {
    listStatusRowsMock.mockResolvedValue([
      statusRow({ deviceId: DEV_ESCROWED, deviceName: 'on', firewallEnabled: true }),
      statusRow({ deviceId: DEV_BARE, deviceName: 'unknown', firewallEnabled: null }),
      statusRow({ deviceId: '44444444-4444-4444-8444-444444444444', deviceName: 'off', firewallEnabled: false }),
    ]);
    const res = await buildApp().request('/firewall');
    expect(res.status).toBe(200);
    const json = await res.json();
    const byName = Object.fromEntries(json.data.map((d: any) => [d.deviceName, d]));
    expect(byName['unknown'].firewallEnabled).toBeNull();
    // No profile or rule data is fabricated for a device we know nothing about.
    expect(byName['unknown'].profiles).toEqual([]);
    expect(byName['unknown'].rulesCount).toBeNull();
    expect(byName['off'].firewallEnabled).toBe(false);
    expect(json.summary).toEqual({ total: 3, enabled: 1, disabled: 1, unknown: 1, coveragePercent: 33 });
  });

  it('status=disabled does not return unknown devices', async () => {
    listStatusRowsMock.mockResolvedValue([
      statusRow({ deviceId: DEV_BARE, deviceName: 'unknown', firewallEnabled: null }),
      statusRow({ deviceId: DEV_ESCROWED, deviceName: 'off', firewallEnabled: false }),
    ]);
    const res = await buildApp().request('/firewall?status=disabled');
    const json = await res.json();
    expect(json.data.map((d: any) => d.deviceName)).toEqual(['off']);
  });
});

// #9639: the header org switcher sends ?orgId=<selected org>. Trends must
// narrow to it (within the caller's accessible orgs), not aggregate the book.
describe('GET /trends — selected organization (#9639)', () => {
  const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const ORG_OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const partnerAuth = {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [ORG_A, ORG_B],
    canAccessOrg: (id: string) => id === ORG_A || id === ORG_B,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getUserPermissionsMock.mockResolvedValue({
      permissions: [{ resource: 'devices', action: 'read' }],
      allowedSiteIds: undefined,
    });
  });

  it('narrows the trend to the selected org', async () => {
    const res = await buildApp(partnerAuth).request(`/trends?period=7d&orgId=${ORG_A}`);

    expect(res.status).toBe(200);
    expect(getSecurityPostureTrend).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getSecurityPostureTrend).mock.calls[0]![0]).toMatchObject({ orgIds: [ORG_A], days: 7 });
  });

  it('returns 403 for an org outside the caller\'s access and reads nothing', async () => {
    const res = await buildApp(partnerAuth).request(`/trends?orgId=${ORG_OTHER}`);

    expect(res.status).toBe(403);
    expect(getSecurityPostureTrend).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed orgId', async () => {
    const res = await buildApp(partnerAuth).request('/trends?orgId=not-a-uuid');

    expect(res.status).toBe(400);
    expect(getSecurityPostureTrend).not.toHaveBeenCalled();
  });

  it('denies an org-scoped caller selecting another org (403)', async () => {
    const res = await buildApp({ orgId: ORG_A, accessibleOrgIds: [ORG_A], canAccessOrg: (id: string) => id === ORG_A })
      .request(`/trends?orgId=${ORG_B}`);

    expect(res.status).toBe(403);
    expect(getSecurityPostureTrend).not.toHaveBeenCalled();
  });

  it('keeps every accessible org when no org is selected', async () => {
    const res = await buildApp(partnerAuth).request('/trends');

    expect(res.status).toBe(200);
    expect(vi.mocked(getSecurityPostureTrend).mock.calls[0]![0]).toMatchObject({ orgIds: [ORG_A, ORG_B], days: 30 });
  });
});
