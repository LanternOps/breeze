// A-W05 Task 5a: manage_tickets (list) offset-mode envelope.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefaultPageFits, fixtureRow } from './aiToolOutputBudget.testkit';

const dbMock = vi.hoisted(() => {
  let rows: unknown[] = [];
  const select = vi.fn(() => ({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: (n: number) => ({
            offset: (o: number) => Promise.resolve(rows.slice(o, o + n)),
          }),
        }),
      }),
    }),
  }));
  return { select, setRows: (r: unknown[]) => { rows = r; } };
});
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: dbMock,
}));

import { aiTools } from './aiToolNames';
import './aiTools';

const TICKET_ROW = {
  id: 'id', internalNumber: 'num', subject: 'medium', status: 'short', priority: 'short',
  assignedTo: 'id', orgId: 'id', deviceId: 'id', createdAt: 'ts',
} as const;
const auth = () => ({
  scope: 'partner', partnerId: 'p1', orgId: null, accessibleOrgIds: ['o1'],
  orgCondition: () => undefined, allowedSiteIds: null, allowedDeviceIds: null,
  user: { id: 'u1' },
}) as never;

describe('manage_tickets (list) output shape (A-W05)', () => {
  const tool = aiTools.get('manage_tickets')!;
  beforeEach(() => { dbMock.setRows([]); });

  it('declares limit/offset/cursor with the shared text', () => {
    const props = (tool.definition.input_schema as { properties: Record<string, { description: string }> }).properties;
    expect(props.limit!.description).toBe('Max results (default 20, max 100)');
    expect(props.offset!.description).toBe('Pagination offset (default 0)');
    expect(props.cursor!.description).toBe('nextCursor from a previous call with the same filters');
  });

  it('a default page of realistic rows fits the chat budget uncompacted and carries the envelope', async () => {
    dbMock.setRows(Array.from({ length: 20 }, (_, i) => fixtureRow(i, TICKET_ROW)));
    const raw = await tool.handler({ action: 'list' }, auth());
    const out = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(expect.arrayContaining(['tickets', 'showing', 'limit', 'offset', 'hasMore', 'nextCursor']));
    expect(out.limit).toBe(20);
    expect(out.offset).toBe(0);
    expectDefaultPageFits('manage_tickets', raw);
  });

  it('refuses a cursor minted for different filters', async () => {
    dbMock.setRows(Array.from({ length: 21 }, (_, i) => fixtureRow(i, TICKET_ROW)));
    const first = JSON.parse(await tool.handler({ action: 'list', status: 'open' }, auth())) as { nextCursor: string | null };
    const second = JSON.parse(await tool.handler({ action: 'list', status: 'closed', cursor: first.nextCursor ?? 'x' }, auth())) as { code?: string };
    expect(second.code).toBe('CURSOR_MISMATCH');
  });
});
