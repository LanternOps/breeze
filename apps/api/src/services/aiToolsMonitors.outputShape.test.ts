// A-W05 Task 5a: list_monitors offset-mode envelope.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefaultPageFits, fixtureRow } from './aiToolOutputBudget.testkit';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(() => ({
      from: () => ({ where: () => ({ groupBy: () => Promise.resolve([]) }) }),
    })),
    insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn(),
  },
}));

const monitorsMock = vi.hoisted(() => ({
  listMonitorDefinitions: vi.fn(),
  countMonitorDefinitions: vi.fn(),
}));
vi.mock('./monitors/monitorService', () => monitorsMock);

import { aiTools } from './aiToolNames';
import './aiTools';

const MONITOR_ROW = {
  id: 'id', name: 'medium', kind: 'short', severity: 'short', enabled: 'bool', orgId: 'id',
} as const;
/**
 * Stand in for the DB: `count` answers COUNT(*) over the whole visible set and
 * `list` honours the SQL LIMIT/OFFSET it is handed (#6735), so the handler can
 * only report a correct envelope if it passes the page to the service.
 */
function seedMonitors(n: number): void {
  const all = Array.from({ length: n }, (_, i) => fixtureRow(i, MONITOR_ROW));
  monitorsMock.countMonitorDefinitions.mockResolvedValue(n);
  monitorsMock.listMonitorDefinitions.mockImplementation(
    async (_auth: unknown, _filters: unknown, page?: { limit: number; offset: number }) =>
      page ? all.slice(page.offset, page.offset + page.limit) : all,
  );
}

const auth = () => ({
  scope: 'partner', partnerId: 'p1', orgId: null, accessibleOrgIds: ['o1'],
  orgCondition: () => undefined, allowedSiteIds: null, allowedDeviceIds: null,
  user: { id: 'u1' },
}) as never;

describe('list_monitors output shape (A-W05)', () => {
  const tool = aiTools.get('list_monitors')!;
  beforeEach(() => { vi.clearAllMocks(); });

  it('declares limit/offset/cursor with the shared text', () => {
    const props = (tool.definition.input_schema as { properties: Record<string, { description: string }> }).properties;
    expect(props.limit!.description).toBe('Max results (default 25, max 100)');
    expect(props.offset!.description).toBe('Pagination offset (default 0)');
    expect(props.cursor!.description).toBe('nextCursor from a previous call with the same filters');
  });

  it('a default page of realistic rows fits the chat budget uncompacted and carries the envelope', async () => {
    seedMonitors(25);
    const raw = await tool.handler({}, auth());
    const out = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(expect.arrayContaining(['monitors', 'total', 'totalMode', 'showing', 'limit', 'offset', 'hasMore', 'nextCursor']));
    expect(out.limit).toBe(25);
    expect(out.offset).toBe(0);
    expect(out.total).toBe(25);
    expectDefaultPageFits('list_monitors', raw);
  });

  it('refuses a cursor minted for different filters', async () => {
    seedMonitors(26);
    const first = JSON.parse(await tool.handler({}, auth())) as { nextCursor: string | null };
    const second = JSON.parse(await tool.handler({ kind: 'metric', cursor: first.nextCursor ?? 'x' }, auth())) as { code?: string };
    expect(second.code).toBe('CURSOR_MISMATCH');
  });
});

describe('list_monitors pages in SQL, not in memory (#6735)', () => {
  const tool = aiTools.get('list_monitors')!;
  beforeEach(() => { vi.clearAllMocks(); });

  type Envelope = { monitors: unknown[]; total: number; showing: number; hasMore: boolean; nextCursor: string | null };
  const call = async (input: Record<string, unknown>) => JSON.parse(await tool.handler(input, auth())) as Envelope;

  it('hands limit/offset and the filters to the service, and counts with the same filters', async () => {
    seedMonitors(60);
    await call({ kind: 'cpu', enabled: true, limit: 10, offset: 20 });
    expect(monitorsMock.listMonitorDefinitions).toHaveBeenCalledTimes(1);
    expect(monitorsMock.listMonitorDefinitions).toHaveBeenCalledWith(
      expect.anything(), { kind: 'cpu', enabled: true }, { limit: 10, offset: 20 },
    );
    expect(monitorsMock.countMonitorDefinitions).toHaveBeenCalledWith(
      expect.anything(), { kind: 'cpu', enabled: true },
    );
  });

  it('total is the COUNT, not the length of the page', async () => {
    seedMonitors(60);
    const out = await call({});
    expect(out.showing).toBe(25);
    expect(out.monitors).toHaveLength(25);
    expect(out.total).toBe(60);
    expect(out.hasMore).toBe(true);
    expect(out.nextCursor).toEqual(expect.any(String));
  });

  it('hasMore is true one row short of the end and false on the last page', async () => {
    seedMonitors(60);
    const middle = await call({ limit: 25, offset: 25 });
    expect(middle).toMatchObject({ showing: 25, total: 60, hasMore: true });

    const last = await call({ limit: 25, offset: 50 });
    expect(last).toMatchObject({ showing: 10, total: 60, hasMore: false, nextCursor: null });

    const exact = await call({ limit: 20, offset: 40 });
    expect(exact).toMatchObject({ showing: 20, total: 60, hasMore: false, nextCursor: null });

    const shortOfEnd = await call({ limit: 19, offset: 40 });
    expect(shortOfEnd).toMatchObject({ showing: 19, total: 60, hasMore: true });
  });

  it('an offset past the end returns an empty page that still reports the real total', async () => {
    seedMonitors(3);
    const out = await call({ offset: 50 });
    expect(out).toMatchObject({ showing: 0, total: 3, hasMore: false, nextCursor: null });
  });

  it('following nextCursor walks every row exactly once', async () => {
    seedMonitors(53);
    const seen: unknown[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const out: Envelope = await call(cursor ? { cursor } : {});
      seen.push(...out.monitors.map((m) => (m as { id: unknown }).id));
      cursor = out.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(53);
    expect(new Set(seen).size).toBe(53);
  });
});
