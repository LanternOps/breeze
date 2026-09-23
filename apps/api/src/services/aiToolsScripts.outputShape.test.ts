// A-W05 Task 5a: list_scripts offset-mode envelope.
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

const SCRIPT_ROW = {
  id: 'id', name: 'medium', description: 'long', language: 'short', osTypes: 'medium',
  category: 'short', createdAt: 'ts',
} as const;
const auth = () => ({
  scope: 'partner', partnerId: 'p1', orgId: null, accessibleOrgIds: ['o1'],
  orgCondition: () => undefined, allowedSiteIds: null, allowedDeviceIds: null,
  user: { id: 'u1' },
}) as never;

describe('list_scripts output shape (A-W05)', () => {
  const tool = aiTools.get('list_scripts')!;
  beforeEach(() => { dbMock.setRows([]); });

  it('declares limit/offset/cursor with the shared text', () => {
    const props = (tool.definition.input_schema as { properties: Record<string, { description: string }> }).properties;
    expect(props.limit!.description).toBe('Max results (default 15, max 50)');
    expect(props.offset!.description).toBe('Pagination offset (default 0)');
    expect(props.cursor!.description).toBe('nextCursor from a previous call with the same filters');
  });

  it('a default page of realistic rows fits the chat budget uncompacted and carries the envelope', async () => {
    dbMock.setRows(Array.from({ length: 15 }, (_, i) => fixtureRow(i, SCRIPT_ROW)));
    const raw = await tool.handler({}, auth());
    const out = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(expect.arrayContaining(['scripts', 'count', 'showing', 'limit', 'offset', 'hasMore', 'nextCursor']));
    expect(out.limit).toBe(15);
    expect(out.offset).toBe(0);
    expectDefaultPageFits('list_scripts', raw);
  });

  it('refuses a cursor minted for different filters', async () => {
    dbMock.setRows(Array.from({ length: 16 }, (_, i) => fixtureRow(i, SCRIPT_ROW)));
    const first = JSON.parse(await tool.handler({ language: 'bash' }, auth())) as { nextCursor: string | null };
    const second = JSON.parse(await tool.handler({ language: 'python', cursor: first.nextCursor ?? 'x' }, auth())) as { code?: string };
    expect(second.code).toBe('CURSOR_MISMATCH');
  });
});
