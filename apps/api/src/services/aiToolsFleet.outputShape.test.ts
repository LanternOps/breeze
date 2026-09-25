// A-W05 Task 5a: manage_patches (list) offset-mode envelope.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefaultPageFits, fixtureRow } from './aiToolOutputBudget.testkit';

const dbMock = vi.hoisted(() => {
  let rows: unknown[] = [];
  const chain = () => ({
    innerJoin: () => ({
      where: () => ({
        orderBy: () => ({
          limit: (n: number) => ({
            offset: (o: number) => Promise.resolve(rows.slice(o, o + n)),
          }),
        }),
      }),
    }),
  });
  return {
    select: vi.fn(() => ({ from: chain })),
    selectDistinct: vi.fn(() => ({ from: chain })),
    setRows: (r: unknown[]) => { rows = r; },
  };
});
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: dbMock,
}));

import { aiTools } from './aiToolNames';
import './aiTools';

const PATCH_ROW = {
  id: 'id', source: 'short', externalId: 'short', title: 'medium', severity: 'short',
  category: 'short', releaseDate: 'ts', requiresReboot: 'bool', createdAt: 'ts',
} as const;
const auth = () => ({
  scope: 'organization', partnerId: null, orgId: 'o1', accessibleOrgIds: ['o1'],
  orgCondition: () => undefined, allowedSiteIds: undefined, allowedDeviceIds: null,
  user: { id: 'u1' },
}) as never;

describe('manage_patches (list) output shape (A-W05)', () => {
  const tool = aiTools.get('manage_patches')!;
  beforeEach(() => { dbMock.setRows([]); });

  it('declares limit/offset/cursor with the shared text', () => {
    const props = (tool.definition.input_schema as { properties: Record<string, { description: string }> }).properties;
    expect(props.limit!.description).toBe('Max results (default 25, max 100)');
    expect(props.offset!.description).toBe('Pagination offset (default 0)');
    expect(props.cursor!.description).toBe('nextCursor from a previous call with the same filters');
  });

  it('a default page of realistic rows fits the chat budget uncompacted and carries the envelope', async () => {
    dbMock.setRows(Array.from({ length: 25 }, (_, i) => fixtureRow(i, PATCH_ROW)));
    const raw = await tool.handler({ action: 'list' }, auth());
    const out = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(expect.arrayContaining(['patches', 'showing', 'limit', 'offset', 'hasMore', 'nextCursor', 'scope']));
    expect(out.limit).toBe(25);
    expect(out.offset).toBe(0);
    expectDefaultPageFits('manage_patches', raw);
  });

  it('refuses a cursor minted for different filters', async () => {
    dbMock.setRows(Array.from({ length: 26 }, (_, i) => fixtureRow(i, PATCH_ROW)));
    const first = JSON.parse(await tool.handler({ action: 'list' }, auth())) as { nextCursor: string | null };
    const second = JSON.parse(await tool.handler({ action: 'list', severity: 'critical', cursor: first.nextCursor ?? 'x' }, auth())) as { code?: string };
    expect(second.code).toBe('CURSOR_MISMATCH');
  });
});
