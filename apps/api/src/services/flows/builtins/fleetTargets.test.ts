import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * #12418 W02 — the run-org resolve of a `fleetFilter` selector. The query
 * itself is proven on real Postgres
 * (`__tests__/integration/flowFleetFilterParity.integration.test.ts`); here:
 * which context it runs in, which refusals come before it, that count and ids
 * come from ONE bounded statement, and what a cancelled statement becomes.
 */
const m = vi.hoisted(() => ({
  trace: [] as string[],
  groupRows: [] as Array<{ id: string; type: string; filterFieldsUsed: string[] | null; filterConditions: unknown }>,
  filterRows: [] as Array<{ id: string; total: unknown }>,
  captured: { where: undefined as unknown, limit: undefined as unknown, orderBy: undefined as unknown, columns: undefined as unknown, groupWhere: undefined as unknown },
  bound: vi.fn(),
  timeout: vi.fn(),
}));

/** Resolves like the drizzle chain: awaitable after `.where()` (group read) and after `.limit()` (device read). */
function chain(kind: 'group' | 'filter', columns: unknown) {
  const rows = kind === 'group' ? m.groupRows : m.filterRows;
  if (kind === 'filter') m.captured.columns = columns;
  const c: Record<string, unknown> = {
    from: () => c,
    where: (w: unknown) => { if (kind === 'filter') m.captured.where = w; else m.captured.groupWhere = w; return c; },
    orderBy: (o: unknown) => { m.captured.orderBy = o; return c; },
    limit: (n: unknown) => { m.captured.limit = n; return c; },
    then: (ok: (r: unknown) => unknown, bad: (e: unknown) => unknown) => {
      m.trace.push(`${kind}-query`);
      return Promise.resolve(rows).then(ok, bad);
    },
  };
  return c;
}

vi.mock('../../../db', () => ({
  db: { select: (columns: unknown) => chain('group', columns) },
  runOutsideDbContext: (fn: () => unknown) => { m.trace.push('outside'); return fn(); },
  withDbAccessContext: async (ctx: { scope: string; accessibleOrgIds: string[] }, fn: () => Promise<unknown>) => {
    m.trace.push(`context:${ctx.scope}:${ctx.accessibleOrgIds.join(',')}`);
    return fn();
  },
  withSystemDbAccessContext: async (fn: () => Promise<unknown>) => { m.trace.push('SYSTEM'); return fn(); },
}));
vi.mock('../../automationRuntime', () => ({ resolveAutomationTargetsDetailed: vi.fn() }));
vi.mock('../../filterPreviewTimeout', () => ({ reportFilterPreviewTimeout: m.timeout }));
vi.mock('../../filterEngine', async (orig) => ({
  ...(await orig<typeof import('../../filterEngine')>()),
  withFilterStatementTimeout: async (run: (tx: unknown) => Promise<unknown>) => {
    m.trace.push('bound');
    m.bound();
    return run({ select: (columns: unknown) => chain('filter', columns) });
  },
}));

import { FilterQueryTimeoutError } from '../../filterEngine';
import { FLEET_FILTER_TIMEOUT_PROBLEM, listFleetFilterDeviceIds, resolveFleetFilterOnce } from './fleetTargets';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const GROUP = '44444444-4444-4444-8444-444444444444';
const RUN = { orgId: ORG, partnerId: PARTNER };
const id = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rows = (n: number, total: unknown = String(n)) => Array.from({ length: n }, (_, i) => ({ id: id(i + 1), total }));
const render = (w: unknown) => new PgDialect().sqlToQuery(w as never);

beforeEach(() => {
  m.trace.length = 0;
  m.groupRows = [];
  m.filterRows = rows(2);
  m.captured = { where: undefined, limit: undefined, orderBy: undefined, columns: undefined, groupWhere: undefined };
  m.bound.mockReset();
  m.timeout.mockReset();
});

describe('listFleetFilterDeviceIds', () => {
  it('returns total and at most limit ids from one bounded statement', async () => {
    m.filterRows = rows(11, '37');
    const out = await listFleetFilterDeviceIds({ orgId: ORG, filter: { osType: 'windows' }, limit: 10 });
    expect(out).toEqual({ total: 37, ids: rows(10).map((r) => r.id) });
    expect(m.trace).toEqual(['bound', 'filter-query']);
    expect(m.captured.limit).toBe(11);
    expect(render((m.captured.columns as { total: unknown }).total).sql).toMatch(/count\(\*\) over \(\)/i);
  });

  it('no matching row is total 0', async () => {
    m.filterRows = [];
    expect(await listFleetFilterDeviceIds({ orgId: ORG, filter: { osType: 'windows' }, limit: 10 })).toEqual({ total: 0, ids: [] });
  });

  it('the WHERE holds the run org, the tech-facing exclusions and the compiled filter', async () => {
    await listFleetFilterDeviceIds({ orgId: ORG, filter: { osType: 'windows' }, limit: 10 });
    const q = render(m.captured.where);
    expect(q.sql).toMatch(/"org_id" = \$\d/);
    expect(q.params).toContain(ORG);
    expect(q.sql).toMatch(/decommissioned/);
    expect(q.sql).toMatch(/"is_ephemeral" = /);
    expect(q.sql).toMatch(/unassigned_pool/);
    expect(q.params).toContain('windows');
  });
});

describe('resolveFleetFilterOnce', () => {
  it('a fleetFilter selector resolves inside the run-org DB context, never system scope', async () => {
    expect(await resolveFleetFilterOnce(RUN, { osType: 'windows' }, 10)).toEqual({ count: 2, deviceIds: [id(1), id(2)], problems: [] });
    expect(m.trace).toEqual(['outside', `context:organization:${ORG}`, 'bound', 'filter-query']);
  });

  it('above the limit the count is exact and no id is returned', async () => {
    m.filterRows = rows(11, '37');
    expect(await resolveFleetFilterOnce(RUN, { osType: 'windows' }, 10)).toEqual({ count: 37, deviceIds: [], problems: [] });
  });

  it.each([
    ['hostnameContains', { hostnameContains: 'srv' }, 'hostname'],
    ['tags', { tags: ['pci'] }, 'tags'],
    ['agentVersion', { agentVersion: '1.0.0' }, 'agentVersion'],
    ['softwareInstalled', { softwareInstalled: '7-Zip' }, 'software.installed'],
    ['softwareMissing', { softwareMissing: '7-Zip' }, 'software.notInstalled'],
    ['softwareVersionBelow', { softwareVersionBelow: { name: '7-Zip', version: '23' } }, 'software.version'],
  ])('execution-refused field %s is a problem without a query, even beside allowed fields', async (_name, refused, key) => {
    const out = await resolveFleetFilterOnce(RUN, { osType: 'windows', ...refused }, 10);
    expect(out).toMatchObject({ count: 0, deviceIds: [] });
    expect(out.problems).toEqual([expect.stringContaining(`(${key})`)]);
    expect(m.trace).toEqual([]);
  });

  it.each([['hostname'], ['software.installed'], ['custom.role']])(
    'a dynamic group whose rules changed to %s after save is a problem at resolve, with no device query',
    async (field) => {
      m.groupRows = [{ id: GROUP, type: 'dynamic', filterFieldsUsed: ['osType', field], filterConditions: null }];
      const out = await resolveFleetFilterOnce(RUN, { groupId: GROUP }, 10);
      expect(out).toMatchObject({ count: 0, deviceIds: [] });
      expect(out.problems).toEqual([expect.stringContaining('a script cannot be targeted by it')]);
      expect(m.trace).toEqual(['outside', `context:organization:${ORG}`, 'group-query']);
    },
  );

  it('a group the run org does not hold (partner-wide, another org\'s, deleted) is a problem, never an unchecked filter', async () => {
    m.groupRows = [];
    const out = await resolveFleetFilterOnce(RUN, { groupId: GROUP }, 10);
    expect(out).toMatchObject({ count: 0, deviceIds: [] });
    expect(out.problems).toHaveLength(1);
    expect(m.trace).not.toContain('filter-query');
    const q = render(m.captured.groupWhere);
    expect(q.params).toEqual(expect.arrayContaining([ORG, GROUP]));
  });

  it.each([[[]], [null], [['osType']]] as Array<[string[] | null]>)('a group with stored rule fields %j resolves', async (fields) => {
    m.groupRows = [{ id: GROUP, type: 'dynamic', filterFieldsUsed: fields, filterConditions: null }];
    expect(await resolveFleetFilterOnce(RUN, { groupId: GROUP }, 10)).toEqual({ count: 2, deviceIds: [id(1), id(2)], problems: [] });
  });

  it('a cancelled statement is one fixed problem, reported, never an empty or partial set', async () => {
    m.bound.mockImplementation(() => { throw new FilterQueryTimeoutError({ cause: Object.assign(new Error('canceling statement SELECT secret'), { code: '57014' }) }); });
    const out = await resolveFleetFilterOnce(RUN, { osType: 'windows' }, 10);
    expect(out).toEqual({ count: 0, deviceIds: [], problems: [FLEET_FILTER_TIMEOUT_PROBLEM] });
    expect(FLEET_FILTER_TIMEOUT_PROBLEM).toMatch(/Nothing was run/);
    expect(m.timeout).toHaveBeenCalledExactlyOnceWith(ORG);
  });

  it('any other failure propagates', async () => {
    m.bound.mockImplementation(() => { throw new Error('connection lost'); });
    await expect(resolveFleetFilterOnce(RUN, { osType: 'windows' }, 10)).rejects.toThrow('connection lost');
    expect(m.timeout).not.toHaveBeenCalled();
  });
});
