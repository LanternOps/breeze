import { describe, it, expect, vi, beforeEach } from 'vitest';

const { listReliabilityDevicesMock, summarizeReliabilityDevicesMock } = vi.hoisted(() => ({
  listReliabilityDevicesMock: vi.fn(),
  summarizeReliabilityDevicesMock: vi.fn(),
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('./reliabilityScoring', () => ({
  listReliabilityDevices: (...args: unknown[]) => listReliabilityDevicesMock(...args),
  summarizeReliabilityDevices: (...args: unknown[]) => summarizeReliabilityDevicesMock(...args),
}));
vi.mock('./userRiskScoring', () => ({
  assignSecurityTraining: vi.fn(),
  getUserRiskDetail: vi.fn(),
  getUserRiskOrgMembership: vi.fn(),
  listUserRiskScores: vi.fn(),
}));

import { registerUserRiskTools } from './aiToolsUserRisk';
import { getUserRiskDetail } from './userRiskScoring';
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

const ALL_ROWS = [row('dev-2', 20), row('dev-1', 60)];

/**
 * Models the SQL: `deviceIds` (#6745) narrows the WHERE, so `total`, the page
 * and the summary are all computed over the caller's own devices.
 */
function sqlLike(filter: { deviceIds?: string[] }) {
  const rows = filter.deviceIds ? ALL_ROWS.filter((r) => filter.deviceIds!.includes(r.deviceId)) : ALL_ROWS;
  return rows;
}

describe('get_fleet_health — exact-device axis (finding 8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listReliabilityDevicesMock.mockImplementation(async (filter: { deviceIds?: string[] }) => {
      const rows = sqlLike(filter);
      return { total: rows.length, rows };
    });
    summarizeReliabilityDevicesMock.mockImplementation(async (filter: { deviceIds?: string[] }) => {
      const rows = sqlLike(filter);
      return {
        total: rows.length,
        averageScore: rows.length ? Math.round(rows.reduce((s, r) => s + r.reliabilityScore, 0) / rows.length) : 0,
        criticalDevices: rows.filter((r) => r.reliabilityScore <= 50).length,
        poorDevices: rows.filter((r) => r.reliabilityScore >= 51 && r.reliabilityScore <= 70).length,
        fairDevices: 0,
        goodDevices: 0,
        degradingDevices: rows.filter((r) => r.trendDirection === 'degrading').length,
      };
    });
  });

  it('device-bound caller (site + device axes) does NOT see a sibling device at the same site', async () => {
    const raw = await handlerFor('get_fleet_health')(
      {},
      makeAuth({ allowedDeviceIds: ['dev-1'], allowedSiteIds: ['site-1'] }),
    );
    const parsed = JSON.parse(raw);
    expect(parsed.error).toBeUndefined();
    expect(listReliabilityDevicesMock).toHaveBeenCalledWith(expect.objectContaining({ deviceIds: ['dev-1'] }));
    expect(summarizeReliabilityDevicesMock).toHaveBeenCalledWith(expect.objectContaining({ deviceIds: ['dev-1'] }));
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
    expect(listReliabilityDevicesMock).toHaveBeenCalledWith(expect.objectContaining({ deviceIds: ['dev-1'] }));
    expect(parsed.devices.map((d: any) => d.deviceId)).toEqual(['dev-1']);
    expect(parsed.total).toBe(1);
  });

  it('defense in depth: a sibling row that slips past the SQL filter is still dropped', async () => {
    listReliabilityDevicesMock.mockResolvedValue({ total: 1, rows: ALL_ROWS });
    const raw = await handlerFor('get_fleet_health')({}, makeAuth({ allowedDeviceIds: ['dev-1'] }));
    expect(JSON.parse(raw).devices.map((d: any) => d.deviceId)).toEqual(['dev-1']);
  });

  it('unrestricted caller sees the whole fleet (no narrowing)', async () => {
    const raw = await handlerFor('get_fleet_health')({}, makeAuth({}));
    const parsed = JSON.parse(raw);
    expect(listReliabilityDevicesMock.mock.calls[0]![0].deviceIds).toBeUndefined();
    expect(parsed.devices.map((d: any) => d.deviceId)).toEqual(['dev-2', 'dev-1']);
    expect(parsed.total).toBe(2);
    expect(parsed.summary.criticalDevices).toBe(1);
  });
});

describe('#6675 — device-page write default must not answer get_user_risk_detail', () => {
  const ORG_A = 'org-a';
  const ORG_B = 'org-b';

  function partnerAuthWithWriteDefault(): AuthContext {
    return {
      user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
      token: {} as any,
      partnerId: 'partner-1',
      orgId: null,
      scope: 'partner',
      accessibleOrgIds: [ORG_A, ORG_B],
      orgCondition: () => undefined,
      canAccessOrg: (id: string | null | undefined) => id === ORG_A || id === ORG_B,
      aiWriteDefaultOrgId: ORG_B,
    } as unknown as AuthContext;
  }

  it('does not silently resolve the ambiguous org to the write default when orgId is omitted', async () => {
    vi.clearAllMocks();
    const raw = await handlerFor('get_user_risk_detail')(
      { userId: 'user-1' },
      partnerAuthWithWriteDefault(),
    );
    const parsed = JSON.parse(raw);
    expect(parsed.error).toMatch(/orgId is required/i);
    expect(getUserRiskDetail).not.toHaveBeenCalled();
  });
});
