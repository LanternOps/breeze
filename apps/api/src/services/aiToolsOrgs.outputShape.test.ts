// A-W05 Task 5c: list_organizations offset-mode envelope + per-org site cap.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefaultPageFits, fixtureRow } from './aiToolOutputBudget.testkit';

const dbMock = vi.hoisted(() => {
  let orgRows: unknown[] = [];
  let siteRows: unknown[] = [];
  const select = vi.fn((cols?: Record<string, unknown>) => {
    if (cols && typeof cols === 'object' && 'orgId' in cols) {
      // site lookup: from().where().orderBy()
      return { from: () => ({ where: () => ({ orderBy: () => Promise.resolve(siteRows) }) }) };
    }
    return {
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: (n: number) => ({
              offset: (o: number) => Promise.resolve(orgRows.slice(o, o + n)),
            }),
          }),
        }),
      }),
    };
  });
  return {
    select,
    setOrgRows: (r: unknown[]) => { orgRows = r; },
    setSiteRows: (r: unknown[]) => { siteRows = r; },
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

const ORG_ROW = { id: 'id', name: 'medium', slug: 'short', status: 'short' } as const;
const auth = () => ({
  scope: 'partner', partnerId: 'p1', orgId: null, accessibleOrgIds: ['o1'],
  orgCondition: () => undefined, user: { id: 'u1' },
}) as never;

describe('list_organizations output shape (A-W05 5c)', () => {
  const tool = aiTools.get('list_organizations')!;
  beforeEach(() => { dbMock.setOrgRows([]); dbMock.setSiteRows([]); });

  it('declares limit/offset/cursor with the shared text', () => {
    const props = (tool.definition.input_schema as { properties: Record<string, { description: string }> }).properties;
    expect(props.limit!.description).toBe('Max results (default 25, max 100)');
    expect(props.offset!.description).toBe('Pagination offset (default 0)');
    expect(props.cursor!.description).toBe('nextCursor from a previous call with the same filters');
  });

  it('a default page of realistic rows fits the chat budget uncompacted and carries the envelope', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => fixtureRow(i, ORG_ROW));
    dbMock.setOrgRows(rows);
    const raw = await tool.handler({}, auth());
    const out = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(expect.arrayContaining(['organizations', 'showing', 'limit', 'offset', 'hasMore', 'nextCursor']));
    expectDefaultPageFits('list_organizations', raw);
  });

  it('caps sites per org at 20 and reports siteCount, without overflowing the budget', async () => {
    dbMock.setOrgRows([{ id: 'org-1', name: 'Acme', slug: 'acme', status: 'active' }]);
    dbMock.setSiteRows(Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, name: `Site ${i}`, orgId: 'org-1' })));
    const raw = await tool.handler({}, auth());
    const out = JSON.parse(raw) as { organizations: Array<{ sites: unknown[]; siteCount: number }> };
    expect(out.organizations[0]!.sites).toHaveLength(20);
    expect(out.organizations[0]!.siteCount).toBe(40);
  });
});
