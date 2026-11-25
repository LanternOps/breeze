import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { eq } from 'drizzle-orm';

const m = vi.hoisted(() => ({ stats: vi.fn(), fleet: vi.fn(), page: vi.fn() }));

vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn() },
  runOutsideDbContext: (fn: any) => fn(),
  withSystemDbAccessContext: (fn: any) => fn(),
  withDbAccessContext: (_ctx: any, fn: any) => fn(),
}));
vi.mock('./brainDeviceContext', () => ({
  getActiveDeviceContext: vi.fn(),
  getAllDeviceContext: vi.fn(),
  createDeviceContext: vi.fn(),
  resolveDeviceContext: vi.fn(),
}));
vi.mock('./aiTools', () => ({ verifyDeviceAccess: vi.fn() }));
vi.mock('./deviceStats', () => ({ queryDeviceStats: m.stats, queryFleetDeviceStats: m.fleet, pageFleetDevices: m.page }));

import { registerDeviceTools } from './aiToolsDevice';
import { toolInputSchemas } from './aiToolSchemas';
import { devices } from '../db/schema';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';
import { MAX_OFFSET } from './aiToolPagination';
import { encodePageCursor, PAGE_RESUME_KEY } from './aiToolPageResume';

const NAME = 'get_fleet_device_stats';
const ORG = '11111111-1111-4111-8111-111111111111';
const counts = { total: 3, online: 2, offline: 1, byStatus: { online: 2, offline: 1 }, migrationRequiredCount: 0 };

function setup() {
  const tools = new Map<string, AiTool>();
  registerDeviceTools(tools);
  return tools.get(NAME)!;
}
const authFor = (over: Record<string, unknown> = {}) =>
  ({
    scope: 'partner',
    orgCondition: vi.fn(() => undefined),
    canAccessOrg: vi.fn(() => true),
    ...over,
  }) as unknown as AuthContext;

const render = (scope: unknown) => new PgDialect().sqlToQuery(scope as any);
const scopeSentTo = () => m.stats.mock.calls[0]![0];

describe(NAME, () => {
  beforeEach(() => {
    m.stats.mockReset();
    m.stats.mockResolvedValue(counts);
    m.fleet.mockReset();
    m.page.mockReset();
  });

  it('is a registered tier-1 devices read', () => {
    expect(setup()).toMatchObject({ tier: 1, domain: 'devices' });
  });

  it('returns the shared exact counts', async () => {
    const out = JSON.parse(await setup().handler({}, authFor()));
    expect(out).toEqual(counts);
    expect(m.stats).toHaveBeenCalledTimes(1);
  });

  it('denies an inaccessible orgId without querying', async () => {
    const auth = authFor({ canAccessOrg: vi.fn(() => false) });
    const out = JSON.parse(await setup().handler({ orgId: ORG }, auth));
    expect(out.error).toMatch(/denied/i);
    expect(m.stats).not.toHaveBeenCalled();
  });

  it('validates input', () => {
    const schema = toolInputSchemas[NAME]!;
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ orgId: ORG }).success).toBe(true);
    expect(schema.safeParse({ orgId: 'nope' }).success).toBe(false);
  });

  it('narrows to the requested org', async () => {
    await setup().handler({ orgId: ORG }, authFor());
    const q = render(scopeSentTo());
    expect(q.sql).toContain('"org_id"');
    expect(q.params).toContain(ORG);
  });

  it('applies the caller org condition', async () => {
    const auth = authFor({ orgCondition: vi.fn(() => eq(devices.orgId, ORG)) });
    await setup().handler({}, auth);
    expect(render(scopeSentTo()).params).toContain(ORG);
  });

  it('narrows a site-restricted caller to its allowed sites', async () => {
    await setup().handler({}, authFor({ allowedSiteIds: ['site-a'] }));
    const q = render(scopeSentTo());
    expect(q.sql).toContain('"site_id"');
    expect(q.params).toContain('site-a');
  });

  it('narrows a device-bound run to its frozen device set', async () => {
    await setup().handler({}, authFor({ allowedDeviceIds: ['dev-1'] }));
    const q = render(scopeSentTo());
    expect(q.sql).toContain('"id" in');
    expect(q.params).toContain('dev-1');
  });

  it('denies all devices for an empty site allowlist (no leak)', async () => {
    await setup().handler({}, authFor({ allowedSiteIds: [] }));
    expect(render(scopeSentTo()).sql).toMatch(/false/);
  });

  it('passes no narrowing for an unrestricted caller', async () => {
    await setup().handler({}, authFor());
    expect(scopeSentTo()).toBeUndefined();
  });
});

describe(`${NAME} filter, groupBy and device page (#12418 W01)`, () => {
  const fleetCounts = { ...counts, total: 12 };
  const pageRows = [
    { id: 'd1', hostname: 'a', displayName: null, status: 'online', osType: 'windows', siteId: 's1', lastSeenAt: null },
    { id: 'd2', hostname: 'b', displayName: null, status: 'offline', osType: 'windows', siteId: 's2', lastSeenAt: null },
  ];
  beforeEach(() => {
    m.stats.mockReset();
    m.fleet.mockReset();
    m.page.mockReset();
    m.fleet.mockResolvedValue(fleetCounts);
    m.page.mockResolvedValue(pageRows);
  });

  it('without filter or groupBy the result equals today\'s counts exactly and the fleet queries never run', async () => {
    m.stats.mockResolvedValue(counts);
    const raw = await setup().handler({ limit: 50, offset: 10 }, authFor());
    expect(raw).toBe(JSON.stringify(counts));
    expect(m.fleet).not.toHaveBeenCalled();
    expect(m.page).not.toHaveBeenCalled();
  });

  it('passes filter and groupBy through and composes the scope with the org narrowing', async () => {
    const auth = authFor({ orgCondition: vi.fn(() => eq(devices.orgId, ORG)), allowedSiteIds: ['site-a'] });
    await setup().handler({ orgId: ORG, filter: { osType: 'linux' }, groupBy: 'siteId' }, auth);
    expect(m.stats).not.toHaveBeenCalled();
    const call = m.fleet.mock.calls[0]![0];
    expect(call.filter).toEqual({ osType: 'linux' });
    expect(call.groupBy).toBe('siteId');
    const q = render(call.scope);
    expect(q.params).toContain(ORG);
    expect(q.params).toContain('site-a');
    // The page runs over the very same scope and filter.
    expect(render(m.page.mock.calls[0]![0].scope)).toEqual(q);
    expect(m.page.mock.calls[0]![0].filter).toEqual({ osType: 'linux' });
  });

  it('groupBy alone returns the grouped counts with no device page and no filter block', async () => {
    const groups = { by: 'osType', rows: [{ key: 'windows', count: 12 }], otherCount: 0 };
    m.fleet.mockResolvedValue({ ...fleetCounts, groups });
    const out = JSON.parse(await setup().handler({ groupBy: 'osType' }, authFor()));
    expect(out).toEqual({ ...fleetCounts, groups });
    expect(m.page).not.toHaveBeenCalled();
  });

  it('with a filter returns the device page in the offset envelope, default limit 10, total exact', async () => {
    const out = JSON.parse(await setup().handler({ filter: { pendingPatches: true } }, authFor()));
    expect(m.page.mock.calls[0]![0]).toMatchObject({ limit: 10, offset: 0 });
    expect(out).toMatchObject({ ...fleetCounts, showing: 2, limit: 10, offset: 0, hasMore: true, total: 12, totalMode: 'exact' });
    expect(out.devices).toEqual(pageRows);
    expect(typeof out.nextCursor).toBe('string');
    expect(out.filter).toEqual({ fieldsUsed: ['patches.pending'], executionRefusedFields: [] });
  });

  it('a software filter is labelled execution-refused in the result', async () => {
    const out = JSON.parse(await setup().handler({ filter: { softwareInstalled: '7-Zip', osType: 'windows' } }, authFor()));
    expect(out.filter).toEqual({ fieldsUsed: ['osType', 'software.installed'], executionRefusedFields: ['software.installed'] });
  });

  it('the nextCursor resumes the same query at the next offset', async () => {
    const first = JSON.parse(await setup().handler({ filter: { osType: 'windows' }, limit: 2 }, authFor()));
    m.page.mockClear();
    await setup().handler({ filter: { osType: 'windows' }, limit: 2, cursor: first.nextCursor }, authFor());
    expect(m.page.mock.calls[0]![0]).toMatchObject({ limit: 2, offset: 2 });
  });

  it('a cursor minted for a different filter is refused with CURSOR_MISMATCH, not reset to page 1', async () => {
    const first = JSON.parse(await setup().handler({ filter: { osType: 'windows' } }, authFor()));
    m.fleet.mockClear();
    m.page.mockClear();
    const out = JSON.parse(await setup().handler({ filter: { osType: 'linux' }, cursor: first.nextCursor }, authFor()));
    expect(out.code).toBe('CURSOR_MISMATCH');
    expect(out.error).toMatch(/different query/);
    expect(m.fleet).not.toHaveBeenCalled();
    expect(m.page).not.toHaveBeenCalled();
  });

  it('a cursor minted for a different groupBy is refused too', async () => {
    const first = JSON.parse(await setup().handler({ filter: { osType: 'windows' } }, authFor()));
    const out = JSON.parse(await setup().handler({ filter: { osType: 'windows' }, groupBy: 'status', cursor: first.nextCursor }, authFor()));
    expect(out.code).toBe('CURSOR_MISMATCH');
  });

  it('an offset above MAX_OFFSET is clamped and the envelope carries maxOffset', async () => {
    m.fleet.mockResolvedValue({ ...fleetCounts, total: 50_000 });
    const out = JSON.parse(await setup().handler({ filter: { osType: 'windows' }, offset: 99_999 }, authFor()));
    expect(m.page.mock.calls[0]![0].offset).toBe(MAX_OFFSET);
    expect(out.offset).toBe(MAX_OFFSET);
    expect(out[PAGE_RESUME_KEY]).toMatchObject({ mode: 'offset', offset: MAX_OFFSET, maxOffset: MAX_OFFSET });
    // A forged cursor past the bound is clamped the same way.
    m.page.mockClear();
    const fp = JSON.parse(Buffer.from(out.nextCursor, 'base64url').toString('utf8')).f;
    await setup().handler({ filter: { osType: 'windows' }, cursor: encodePageCursor({ f: fp, o: 77_777 }) }, authFor());
    expect(m.page.mock.calls[0]![0].offset).toBe(MAX_OFFSET);
  });

  it('a groupId or siteId filter is passed alongside the caller scope, never instead of it', async () => {
    // The ids are only a filter: the caller's org scope still reaches the
    // query. The zero count itself is proven against Postgres in
    // aiToolsFleetDeviceStatsFilter.integration.test.ts.
    m.fleet.mockResolvedValue({ ...counts, total: 0, online: 0, offline: 0, byStatus: {} });
    m.page.mockResolvedValue([]);
    const OTHER = '33333333-3333-4333-8333-333333333333';
    const auth = authFor({ orgCondition: vi.fn(() => eq(devices.orgId, ORG)) });
    const out = JSON.parse(await setup().handler({ filter: { groupId: OTHER, siteId: OTHER } }, auth));
    const call = m.fleet.mock.calls[0]![0];
    expect(render(call.scope).params).toContain(ORG);
    expect(call.filter).toEqual({ groupId: OTHER, siteId: OTHER });
    expect(out).toMatchObject({ total: 0, devices: [], showing: 0, hasMore: false, nextCursor: null });
  });

  it('a filter that fails the typed schema is refused before any query', async () => {
    const out = JSON.parse(await setup().handler({ filter: { hostname: 'x' } }, authFor()));
    expect(out.error).toMatch(/filter/i);
    expect(m.fleet).not.toHaveBeenCalled();
    expect(m.stats).not.toHaveBeenCalled();
  });

  it('denies an inaccessible orgId before any fleet query', async () => {
    const out = JSON.parse(await setup().handler({ orgId: ORG, filter: { osType: 'linux' } }, authFor({ canAccessOrg: vi.fn(() => false) })));
    expect(out.error).toMatch(/denied/i);
    expect(m.fleet).not.toHaveBeenCalled();
  });

  it('the registry schema refuses an unknown filter key and an unknown groupBy, accepts a full call', () => {
    const s = toolInputSchemas[NAME]!;
    expect(s.safeParse({ filter: { hostname: 'x' } }).success).toBe(false);
    expect(s.safeParse({ groupBy: 'software' }).success).toBe(false);
    expect(s.safeParse({ limit: 101 }).success).toBe(false);
    expect(s.safeParse({ filter: { softwareVersionBelow: { name: '7-Zip', version: 'latest' } } }).success).toBe(false);
    expect(s.safeParse({ filter: { osType: 'linux' }, groupBy: 'osVersion', limit: 100 }).success).toBe(true);
    expect(s.safeParse({ orgId: ORG, filter: { osType: 'linux' }, groupBy: 'osVersion', limit: 5, offset: 10, cursor: 'abc' }).success).toBe(true);
  });

  it('the registry JSON schema declares filter, groupBy and the page params', () => {
    const props = (setup().definition.input_schema as { properties: Record<string, any> }).properties;
    expect(Object.keys(props)).toEqual(['orgId', 'filter', 'groupBy', 'limit', 'offset', 'cursor']);
    expect(props.filter.additionalProperties).toBe(false);
    expect(Object.keys(props.filter.properties)).toHaveLength(15);
    expect(props.groupBy.enum).toEqual(['status', 'osType', 'osVersion', 'siteId', 'agentVersion', 'deviceRole', 'architecture']);
    expect(props.limit.description).toBe('Max results (default 10, max 100)');
  });

  it('the description is the plan\'s exact copy and fits the 300-char budget', () => {
    const d = setup().definition.description ?? '';
    expect(d).toBe('Exact live fleet device counts (total, online, offline, byStatus, migration and log-shipping counts), optionally narrowed by a typed filter, grouped by one dimension, with a paged device sample. Use instead of paging query_devices to count. Excludes decommissioned, parked and Quick Support devices.');
    expect(d.length).toBeLessThanOrEqual(300);
  });
});

