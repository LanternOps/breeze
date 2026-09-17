import { describe, it, expect, vi, beforeEach } from 'vitest';

const { listReliabilityDevicesMock } = vi.hoisted(() => ({
  listReliabilityDevicesMock: vi.fn(),
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('./reliabilityScoring', () => ({
  listReliabilityDevices: (...args: unknown[]) => listReliabilityDevicesMock(...args),
}));
vi.mock('./userRiskScoring', () => ({
  assignSecurityTraining: vi.fn(),
  getUserRiskDetail: vi.fn(),
  getUserRiskOrgMembership: vi.fn(),
  listUserRiskScores: vi.fn(),
}));

import { registerUserRiskTools } from './aiToolsUserRisk';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerUserRiskTools(reg);
  const tool = reg.get(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool.handler;
}

function makeAuth(opts: { allowedDeviceIds?: string[]; allowedSiteIds?: string[] }): AuthContext {
  const { allowedDeviceIds, allowedSiteIds } = opts;
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedDeviceIds,
    allowedSiteIds,
    canAccessSite: allowedSiteIds
      ? (s: string | null | undefined) => !!s && allowedSiteIds.includes(s)
      : undefined,
  } as unknown as AuthContext;
}

function row(deviceId: string, score: number) {
  return {
    deviceId,
    orgId: 'org-1',
    siteId: 'site-1',
    hostname: `${deviceId}-host`,
    osType: 'windows',
    status: 'online',
    reliabilityScore: score,
    trendDirection: 'degrading',
    trendConfidence: 1,
    uptime30d: 99,
    crashCount30d: 0,
  };
}

describe('get_fleet_health — exact-device axis (finding 8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listReliabilityDevicesMock.mockResolvedValue({
      total: 2,
      rows: [row('dev-2', 20), row('dev-1', 60)],
    });
  });

  it('device-bound caller (site + device axes) does NOT see a sibling device at the same site', async () => {
    const raw = await handlerFor('get_fleet_health')(
      {},
      makeAuth({ allowedDeviceIds: ['dev-1'], allowedSiteIds: ['site-1'] }),
    );
    const parsed = JSON.parse(raw);
    expect(parsed.error).toBeUndefined();
    expect(parsed.devices.map((d: any) => d.deviceId)).toEqual(['dev-1']);
    expect(parsed.total).toBe(1);
    expect(parsed.summary.criticalDevices).toBe(0);
  });

  it('device-bound caller still sees its own device (no over-blocking)', async () => {
    const raw = await handlerFor('get_fleet_health')(
      {},
      makeAuth({ allowedDeviceIds: ['dev-1'], allowedSiteIds: ['site-1'] }),
    );
    const parsed = JSON.parse(raw);
    expect(parsed.devices).toHaveLength(1);
    expect(parsed.devices[0].hostname).toBe('dev-1-host');
    expect(parsed.summary.averageScore).toBe(60);
  });

  it('device-LESS analysis shape (no site axis) also cannot see the sibling device', async () => {
    const raw = await handlerFor('get_fleet_health')({}, makeAuth({ allowedDeviceIds: ['dev-1'] }));
    const parsed = JSON.parse(raw);
    expect(parsed.devices.map((d: any) => d.deviceId)).toEqual(['dev-1']);
    expect(parsed.total).toBe(1);
  });

  it('unrestricted caller sees the whole fleet (no narrowing)', async () => {
    const raw = await handlerFor('get_fleet_health')({}, makeAuth({}));
    const parsed = JSON.parse(raw);
    expect(parsed.devices.map((d: any) => d.deviceId)).toEqual(['dev-2', 'dev-1']);
    expect(parsed.total).toBe(2);
    expect(parsed.summary.criticalDevices).toBe(1);
  });
});
