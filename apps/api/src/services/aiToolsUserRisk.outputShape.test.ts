// #6745 (A-W05 follow-up): get_fleet_health offset-mode envelope + row shaping.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefaultPageFits, fixtureRow } from './aiToolOutputBudget.testkit';
import { compactToolResultForChat } from './aiToolOutput';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn() },
}));
const reliabilityMock = vi.hoisted(() => ({
  listReliabilityDevices: vi.fn(),
  summarizeReliabilityDevices: vi.fn(),
}));
vi.mock('./reliabilityScoring', () => reliabilityMock);
vi.mock('./userRiskScoring', () => ({
  assignSecurityTraining: vi.fn(), getUserRiskDetail: vi.fn(), getUserRiskOrgMembership: vi.fn(), listUserRiskScores: vi.fn(),
}));

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerUserRiskTools } from './aiToolsUserRisk';

function tool(): AiTool {
  const reg = new Map<string, AiTool>();
  registerUserRiskTools(reg);
  return reg.get('get_fleet_health')!;
}
const auth = (extra: Record<string, unknown> = {}) => ({
  user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
  token: {}, partnerId: null, orgId: 'org-1', scope: 'organization', accessibleOrgIds: ['org-1'],
  orgCondition: () => undefined, canAccessOrg: () => true, ...extra,
}) as unknown as AuthContext;

function reliabilityRow(i: number) {
  const f = fixtureRow(i, { deviceId: 'id', orgId: 'id', siteId: 'id', computedAt: 'ts' });
  return {
    ...f,
    hostname: `WKSTN-ACCOUNTING-${i}`, osType: 'windows', status: 'online',
    reliabilityScore: 40 + (i % 50), trendDirection: 'degrading', trendConfidence: 0.8765,
    uptime30d: 97.123, crashCount30d: 3, hangCount30d: 2, serviceFailureCount30d: 5, hardwareErrorCount30d: 1, mtbfHours: 123.45,
    topIssues: [
      { type: 'crashes', count: 3, severity: 'critical', lastOccurrence: '2026-09-19T08:00:00.000Z' },
      { type: 'services', count: 5, severity: 'error', lastOccurrence: '2026-09-19T09:00:00.000Z' },
      { type: 'hangs', count: 2, severity: 'warning', lastOccurrence: '2026-09-18T09:00:00.000Z' },
      { type: 'hardware', count: 1, severity: 'warning', lastOccurrence: '2026-09-17T09:00:00.000Z' },
    ],
  };
}
const FLEET_SUMMARY = { total: 480, averageScore: 71, criticalDevices: 40, poorDevices: 90, fairDevices: 150, goodDevices: 200, degradingDevices: 33 };

describe('get_fleet_health output shape (#6745)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reliabilityMock.listReliabilityDevices.mockImplementation(async (f: { limit: number; offset: number }) => ({
      total: 480,
      rows: Array.from({ length: f.limit }, (_, i) => reliabilityRow(f.offset + i)),
    }));
    reliabilityMock.summarizeReliabilityDevices.mockResolvedValue(FLEET_SUMMARY);
  });

  it('declares limit/offset/cursor with the shared text', () => {
    const props = (tool().definition.input_schema as { properties: Record<string, { description: string }> }).properties;
    expect(props.limit!.description).toBe('Max results (default 15, max 100)');
    expect(props.offset!.description).toBe('Pagination offset (default 0)');
    expect(props.cursor!.description).toBe('nextCursor from a previous call with the same filters');
  });

  it('a default page of realistic rows fits the budget, carries the envelope and omits topIssues', async () => {
    const raw = await tool().handler({}, auth());
    const out = JSON.parse(raw) as Record<string, any>;
    expect(reliabilityMock.listReliabilityDevices.mock.calls[0]![0]).toMatchObject({ limit: 15, offset: 0 });
    expect(Object.keys(out)).toEqual(expect.arrayContaining(['devices', 'showing', 'limit', 'offset', 'total', 'hasMore', 'nextCursor', 'summary']));
    expect(out.hasMore).toBe(true);
    expect(out.devices[0].topIssues).toBeUndefined();
    expect(out.devices[0].topIssueCount).toBe(4);
    expectDefaultPageFits('get_fleet_health', raw);
  });

  it('summary is the fleet-wide aggregate over the filtered set, not the page', async () => {
    const out = JSON.parse(await tool().handler({ limit: 2 }, auth())) as Record<string, any>;
    expect(out.summary).toMatchObject({ averageScore: 71, criticalDevices: 40, degradingDevices: 33 });
    expect(out.total).toBe(480);
  });

  it('the nextCursor fetches the next offset, and a cursor for other filters is refused', async () => {
    const first = JSON.parse(await tool().handler({}, auth())) as { nextCursor: string };
    await tool().handler({ cursor: first.nextCursor }, auth());
    expect(reliabilityMock.listReliabilityDevices.mock.calls[1]![0]).toMatchObject({ offset: 15 });
    const mismatch = JSON.parse(await tool().handler({ scoreRange: 'critical', cursor: first.nextCursor }, auth())) as { code?: string };
    expect(mismatch.code).toBe('CURSOR_MISMATCH');
  });

  it('includeTopIssues=true returns topIssues', async () => {
    const out = JSON.parse(await tool().handler({ includeTopIssues: true, limit: 1 }, auth())) as Record<string, any>;
    expect(out.devices[0].topIssues).toHaveLength(4);
  });

  it('pushes a frozen device set into the query so total/summary/paging are over that set', async () => {
    await tool().handler({}, auth({ allowedDeviceIds: ['d-1', 'd-2'] }));
    expect(reliabilityMock.listReliabilityDevices.mock.calls[0]![0]).toMatchObject({ deviceIds: ['d-1', 'd-2'] });
    expect(reliabilityMock.summarizeReliabilityDevices.mock.calls[0]![0]).toMatchObject({ deviceIds: ['d-1', 'd-2'] });
  });

  it('a worst-case page that compacts still carries hasMore/nextCursor', async () => {
    const raw = await tool().handler({ limit: 100, includeTopIssues: true }, auth());
    const compacted = JSON.parse(compactToolResultForChat('get_fleet_health', raw)) as Record<string, unknown>;
    expect(compacted.hasMore).toBe(true);
    expect(typeof compacted.nextCursor).toBe('string');
  });
});
