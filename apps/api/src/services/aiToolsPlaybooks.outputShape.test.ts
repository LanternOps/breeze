// A-W05 Task 5c: list_playbooks offset-mode envelope + steps→stepCount/stepNames.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefaultPageFits, fixtureRow } from './aiToolOutputBudget.testkit';

const dbMock = vi.hoisted(() => {
  let rows: unknown[] = [];
  let lastOrderByArgs: unknown[] = [];
  const select = vi.fn(() => ({
    from: () => ({
      where: () => ({
        orderBy: (...args: unknown[]) => {
          lastOrderByArgs = args;
          return {
            limit: (n: number) => ({
              offset: (o: number) => Promise.resolve(rows.slice(o, o + n)),
            }),
          };
        },
      }),
    }),
  }));
  return { select, setRows: (r: unknown[]) => { rows = r; }, getLastOrderByArgs: () => lastOrderByArgs };
});
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: dbMock,
}));

import { aiTools } from './aiToolNames';
import './aiTools';

const auth = () => ({
  scope: 'partner', partnerId: 'p1', orgId: null, accessibleOrgIds: ['o1'],
  orgCondition: () => undefined, user: { id: 'u1' },
}) as never;

function playbookRow(i: number, stepCount: number) {
  const row = fixtureRow(i, { id: 'id', name: 'medium', description: 'short', category: 'short', isBuiltIn: 'bool', requiredPermissions: 'null' });
  return {
    ...row,
    steps: Array.from({ length: stepCount }, (_, s) => ({ name: `step-${s}`, type: 'run_script', toolInput: { big: 'x'.repeat(500) } })),
  };
}

describe('list_playbooks output shape (A-W05 5c)', () => {
  const tool = aiTools.get('list_playbooks')!;
  beforeEach(() => dbMock.setRows([]));

  it('declares limit/offset/cursor with the shared text', () => {
    const props = (tool.definition.input_schema as { properties: Record<string, { description: string }> }).properties;
    expect(props.limit!.description).toBe('Max results (default 25, max 100)');
    expect(props.offset!.description).toBe('Pagination offset (default 0)');
    expect(props.cursor!.description).toBe('nextCursor from a previous call with the same filters');
  });

  it('a default page of realistic rows fits the chat budget uncompacted and carries the envelope', async () => {
    dbMock.setRows(Array.from({ length: 25 }, (_, i) => playbookRow(i, 4)));
    const raw = await tool.handler({}, auth());
    const out = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(expect.arrayContaining(['playbooks', 'count', 'showing', 'limit', 'offset', 'hasMore', 'nextCursor']));
    expectDefaultPageFits('list_playbooks', raw);
  });

  it('replaces steps with stepCount/stepNames unless includeSteps is set', async () => {
    dbMock.setRows([playbookRow(0, 15)]);
    const withoutSteps = JSON.parse(await tool.handler({}, auth())) as { playbooks: Array<Record<string, unknown>> };
    expect(withoutSteps.playbooks[0]!.steps).toBeUndefined();
    expect(withoutSteps.playbooks[0]!.stepCount).toBe(15);
    expect((withoutSteps.playbooks[0]!.stepNames as string[]).length).toBe(10);

    dbMock.setRows([playbookRow(0, 15)]);
    const withSteps = JSON.parse(await tool.handler({ includeSteps: true }, auth())) as { playbooks: Array<{ steps: unknown[] }> };
    expect(withSteps.playbooks[0]!.steps).toHaveLength(15);
  });

  it('fix 6: orders by (category, name, id) so offset pagination has a unique tiebreaker', async () => {
    dbMock.setRows([]);
    await tool.handler({}, auth());
    // category/name alone are not guaranteed unique — two playbooks with the
    // same category and name would let offset pagination skip or duplicate
    // a row. `id` is the final tiebreaker.
    expect(dbMock.getLastOrderByArgs().length).toBe(3);
  });
});
