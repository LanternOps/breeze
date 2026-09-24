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

const monitorsMock = vi.hoisted(() => ({ listMonitorDefinitions: vi.fn() }));
vi.mock('./monitors/monitorService', () => monitorsMock);

import { aiTools } from './aiToolNames';
import './aiTools';

const MONITOR_ROW = {
  id: 'id', name: 'medium', kind: 'short', severity: 'short', enabled: 'bool', orgId: 'id',
} as const;
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
    monitorsMock.listMonitorDefinitions.mockResolvedValue(
      Array.from({ length: 25 }, (_, i) => fixtureRow(i, MONITOR_ROW)),
    );
    const raw = await tool.handler({}, auth());
    const out = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(expect.arrayContaining(['monitors', 'total', 'totalMode', 'showing', 'limit', 'offset', 'hasMore', 'nextCursor']));
    expect(out.limit).toBe(25);
    expect(out.offset).toBe(0);
    expect(out.total).toBe(25);
    expectDefaultPageFits('list_monitors', raw);
  });

  it('refuses a cursor minted for different filters', async () => {
    monitorsMock.listMonitorDefinitions.mockResolvedValue(
      Array.from({ length: 26 }, (_, i) => fixtureRow(i, MONITOR_ROW)),
    );
    const first = JSON.parse(await tool.handler({}, auth())) as { nextCursor: string | null };
    const second = JSON.parse(await tool.handler({ kind: 'metric', cursor: first.nextCursor ?? 'x' }, auth())) as { code?: string };
    expect(second.code).toBe('CURSOR_MISMATCH');
  });
});
