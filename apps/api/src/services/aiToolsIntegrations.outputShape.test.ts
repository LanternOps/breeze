// A-W05 Task 5c (survey miss): query_psa_status offset-mode envelope.
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
vi.mock('../workers/webhookDelivery', () => ({ getWebhookWorker: vi.fn() }));

import { aiTools } from './aiToolNames';
import './aiTools';

const auth = () => ({
  scope: 'partner', partnerId: 'p1', orgId: null, accessibleOrgIds: ['o1'],
  orgCondition: () => undefined, user: { id: 'u1' },
}) as never;

const CONNECTION_ROW = { id: 'id', provider: 'short', name: 'medium', enabled: 'bool', lastSyncStatus: 'short', lastSyncError: 'null', createdAt: 'ts' } as const;

describe('query_psa_status output shape (A-W05 5c)', () => {
  const tool = aiTools.get('query_psa_status')!;
  beforeEach(() => dbMock.setRows([]));

  it('declares limit/offset/cursor with the shared text', () => {
    const props = (tool.definition.input_schema as { properties: Record<string, { description: string }> }).properties;
    expect(props.limit!.description).toBe('Max results (default 25, max 100)');
    expect(props.offset!.description).toBe('Pagination offset (default 0)');
    expect(props.cursor!.description).toBe('nextCursor from a previous call with the same filters');
  });

  it('a default page of realistic rows fits the chat budget uncompacted and carries the envelope', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ ...fixtureRow(i, CONNECTION_ROW), enabled: true, lastSyncError: null }));
    dbMock.setRows(rows);
    const raw = await tool.handler({}, auth());
    const out = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(expect.arrayContaining(['connections', 'count', 'showing', 'limit', 'offset', 'hasMore', 'nextCursor']));
    expectDefaultPageFits('query_psa_status', raw);
  });
});
