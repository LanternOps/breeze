// A-W05 Task 5c: list_configuration_policies offset-mode envelope.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefaultPageFits, fixtureRow } from './aiToolOutputBudget.testkit';

const dbMock = vi.hoisted(() => {
  let policyRows: unknown[] = [];
  let linkRows: unknown[] = [];
  const select = vi.fn((cols?: Record<string, unknown>) => {
    if (cols && typeof cols === 'object' && 'configPolicyId' in cols) {
      return { from: () => ({ where: () => Promise.resolve(linkRows) }) };
    }
    return {
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: (n: number) => ({
              offset: (o: number) => Promise.resolve(policyRows.slice(o, o + n)),
            }),
          }),
        }),
      }),
    };
  });
  return {
    select,
    setPolicyRows: (r: unknown[]) => { policyRows = r; },
    setLinkRows: (r: unknown[]) => { linkRows = r; },
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

const POLICY_ROW = {
  id: 'id', orgId: 'id', partnerId: 'null', name: 'medium', description: 'short',
  status: 'short', parentPolicyId: 'null', createdBy: 'id', createdAt: 'ts', updatedAt: 'ts',
} as const;
const auth = () => ({
  scope: 'partner', partnerId: 'p1', orgId: null, accessibleOrgIds: ['o1'],
  orgCondition: () => undefined, user: { id: 'u1' },
}) as never;

describe('list_configuration_policies output shape (A-W05 5c)', () => {
  const tool = aiTools.get('list_configuration_policies')!;
  beforeEach(() => { dbMock.setPolicyRows([]); dbMock.setLinkRows([]); });

  it('declares limit/offset/cursor with the shared text', () => {
    const props = (tool.definition.input_schema as { properties: Record<string, { description: string }> }).properties;
    expect(props.limit!.description).toBe('Max results (default 20, max 100)');
    expect(props.offset!.description).toBe('Pagination offset (default 0)');
    expect(props.cursor!.description).toBe('nextCursor from a previous call with the same filters');
  });

  it('a default page of realistic rows fits the chat budget uncompacted and carries the envelope', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ ...fixtureRow(i, POLICY_ROW), orgId: null, partnerId: 'p1', parentPolicyId: null }));
    dbMock.setPolicyRows(rows);
    const raw = await tool.handler({}, auth());
    const out = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(expect.arrayContaining(['policies', 'showing', 'limit', 'offset', 'hasMore', 'nextCursor']));
    expectDefaultPageFits('list_configuration_policies', raw);
  });
});
