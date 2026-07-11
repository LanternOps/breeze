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

const { listStatusRowsMock } = vi.hoisted(() => ({ listStatusRowsMock: vi.fn() }));

vi.mock('./helpers', async () => {
  const actual = await vi.importActual<any>('./helpers');
  return { ...actual, listStatusRows: listStatusRowsMock };
});

vi.mock('../../services/securityPosture', () => ({ getSecurityPostureTrend: vi.fn(async () => []) }));

import { db } from '../../db';
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

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization', orgId: null, partnerId: null,
      accessibleOrgIds: [], user: { id: 'u' },
      orgCondition: () => undefined, canAccessOrg: () => true,
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
  beforeEach(() => vi.clearAllMocks());

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
});
