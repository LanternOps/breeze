import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { FilterQueryTimeoutError } from '../filterEngine';
import {
  GROUP_CHECK_DOCUMENT_BUDGET_MS,
  GROUP_CHECK_MIN_STATEMENT_MS,
  GROUP_CHECK_STEP_BUDGET_MS,
  GroupCheckBudget,
  judgeFleetFilterGroup,
  judgeFleetFilterGroups,
  loadGatedGroups,
  MAX_GATED_GROUPS,
  type GatedGroup,
} from './fleetFilterGroupGate';

const G = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = '11111111-1111-4111-8111-111111111111';
/** A value the group routes would accept for the field. */
const valueFor = (field: string): unknown => (field === 'osType' ? 'windows' : 'x');
const rule = (field: string, value: unknown = valueFor(field), operator = 'equals') => ({ field, operator, value });
const dyn = (...conditions: unknown[]) => ({ operator: 'AND', conditions });
const group = (id: string, over: Partial<GatedGroup> = {}): GatedGroup => ({ id, type: 'dynamic', siteId: null, filterFieldsUsed: [], filterConditions: null, hasRuleMembers: false, ...over });
const loader = (...groups: GatedGroup[]) => vi.fn(async (ids: string[]) => groups.filter((g) => ids.includes(g.id)));
/** Never used up. */
const budget = new GroupCheckBudget(1_000, () => 0);
const judge = (...groups: GatedGroup[]) => judgeFleetFilterGroup(ORG, G(1), { load: loader(...groups), budget });
const classify = async (...groups: GatedGroup[]) => (await judge(...groups)).verdict;
async function members(...groups: GatedGroup[]) {
  const out = await judge(...groups);
  if (out.verdict !== 'ok') throw new Error(`expected ok, got ${out.verdict}`);
  return new PgDialect().sqlToQuery(out.members);
}

describe('judgeFleetFilterGroup', () => {
  it('a static group, and a dynamic group on allowed fields, pass', async () => {
    expect(await classify(group(G(1), { type: 'static' }))).toBe('ok');
    expect(await classify(group(G(1), { filterFieldsUsed: ['osType'], filterConditions: dyn(rule('osType'), dyn(rule('siteId'))) }))).toBe('ok');
    expect(await classify(group(G(1), { filterFieldsUsed: null }))).toBe('ok');
  });

  it('OR groups, at the root and nested, are read like AND groups', async () => {
    const or = (...c: unknown[]) => ({ operator: 'OR', conditions: c });
    expect(await classify(group(G(1), { filterConditions: or(rule('osType'), dyn(rule('siteId'))) }))).toBe('ok');
    expect(await classify(group(G(1), { filterConditions: dyn(rule('osType'), or(rule('osType'), rule('hostname'))) }))).toBe('refused');
  });

  it('a condition on an allowed field that also carries conditions is refused', async () => {
    expect(await classify(group(G(1), { filterConditions: dyn({ ...rule('osType'), conditions: [rule('hostname')] }) }))).toBe('refused');
  });

  it('a group reference in upper case finds the group', async () => {
    const outer = group(G(1), { filterConditions: dyn(rule('groupId', G(2).toUpperCase())) });
    expect(await classify(outer, group(G(2), { filterConditions: dyn(rule('osType')) }))).toBe('ok');
  });

  it('a group the loader does not return is missing', async () => {
    expect(await classify()).toBe('missing');
  });

  it('a refused stored field refuses, whatever the type', async () => {
    for (const type of ['static', 'dynamic'] as const) expect(await classify(group(G(1), { type, filterFieldsUsed: ['hostname'] }))).toBe('refused');
  });

  it.each([['empty', []], ['null', null], ['stale', ['osType']]] as Array<[string, string[] | null]>)(
    'a dynamic group whose live rules use a refused field is refused when the stored list is %s', async (_l, filterFieldsUsed) => {
      expect(await classify(group(G(1), { filterFieldsUsed, filterConditions: dyn(rule('osType'), dyn(rule('hostname'))) }))).toBe('refused');
      expect(await classify(group(G(1), { filterFieldsUsed, filterConditions: dyn(rule('custom.role')) }))).toBe('refused');
    });

  it.each(['equals', 'notEquals', 'in', 'notIn'])('a rule that names another group (%s) is judged by that group\'s rules', async (operator) => {
    const value = operator === 'in' || operator === 'notIn' ? [G(2), G(3)] : G(2);
    const outer = group(G(1), { filterFieldsUsed: ['groupId'], filterConditions: dyn(rule('groupId', value, operator)) });
    const fine = group(G(3), { type: 'static' });
    expect(await classify(outer, fine, group(G(2), { filterConditions: dyn(rule('hostname')) }))).toBe('refused');
    expect(await classify(outer, fine, group(G(2), { filterConditions: dyn(rule('osType')) }))).toBe('ok');
    // Not held by the run org (or deleted): its rules cannot be checked.
    expect(await classify(outer, fine)).toBe('refused');
  });

  it('references are followed to any depth, and a cycle is refused', async () => {
    const link = (a: number, b: number) => group(G(a), { filterConditions: dyn(rule('groupId', G(b))) });
    expect(await classify(link(1, 2), link(2, 3), group(G(3), { filterConditions: dyn(rule('tags')) }))).toBe('refused');
    expect(await classify(link(1, 2), link(2, 1))).toBe('refused');
    expect(await classify(link(1, 1))).toBe('refused');
    // Two paths to one group are not a cycle.
    const diamond = group(G(1), { filterConditions: dyn(rule('groupId', [G(2), G(3)], 'in')) });
    expect(await classify(diamond, link(2, 4), link(3, 4), group(G(4), { filterConditions: dyn(rule('osType')) }))).toBe('ok');
  });

  it('a static group\'s leftover rules are not live, so they are not followed', async () => {
    expect(await classify(group(G(1), { type: 'static', filterConditions: dyn(rule('hostname')) }))).toBe('ok');
  });

  it.each([['a string', 'x'], ['an array', []], ['no conditions', {}], ['a null condition', dyn(null)], ['a condition with no field', dyn({ operator: 'equals' })],
    ['a non-string group reference', dyn(rule('groupId', 5))], ['a malformed group id', dyn(rule('groupId', 'nope'))],
    // The engine renders these as "every device".
    ['an empty rule list', dyn()], ['an empty nested rule list', dyn(rule('osType'), dyn())],
    ['an empty group list', dyn(rule('groupId', [], 'notIn'))], ['an empty operand', dyn(rule('osType', [], 'notIn'))],
    ['no value', dyn({ field: 'osType', operator: 'equals' })], ['a null value', dyn(rule('osType', null))],
    ['a value the engine does not know', dyn(rule('osType', 'Windows'))], ['an operator the field does not have', dyn(rule('osType', 'windows', 'contains'))],
    // The engine reads a node by its operator; a node that fits both shapes, or neither, is not one the gate can read.
    ['a condition that also carries conditions', dyn({ ...rule('hostname', 'x', 'contains'), conditions: [] })],
    ['a group that also carries a field', dyn({ operator: 'AND', field: 'osType', conditions: [rule('osType')] })],
    ['a nested group with an unknown operator', dyn({ operator: 'XOR', conditions: [rule('osType')] })],
    ['a root that is a bare condition', rule('osType')],
    ['an unknown field', dyn(rule('agentId'))],
    ['a malformed custom field', dyn(rule('custom.a b'))]])(
    'rules that cannot be read are refused: %s', async (_l, filterConditions) => {
      expect(await classify(group(G(1), { filterConditions }))).toBe('refused');
    });

  it('more groups than the bound is refused, never partly checked', async () => {
    const many = Array.from({ length: MAX_GATED_GROUPS }, (_, i) => group(G(i + 2), { type: 'static' }));
    const outer = (n: number) => group(G(1), { filterConditions: dyn(rule('groupId', many.slice(0, n).map((g) => g.id), 'in')) });
    expect(await classify(outer(MAX_GATED_GROUPS - 1), ...many)).toBe('ok');
    expect(await classify(outer(MAX_GATED_GROUPS), ...many)).toBe('refused');
  });

  it('a static group with a member that was not added by hand is refused, named directly or by another group', async () => {
    const held = { type: 'static', hasRuleMembers: true } as const;
    expect(await classify(group(G(1), held))).toBe('refused');
    expect(await classify(group(G(1), { filterConditions: dyn(rule('groupId', G(2), 'notEquals')) }), group(G(2), held))).toBe('refused');
  });

  it.each([['notIn', G(2)], ['in', G(2)], ['notEquals', [G(2)]], ['equals', [G(2)]], ['contains', G(2)]] as Array<[string, unknown]>)('a reference (%s) whose operator and operand do not fit is refused', async (operator, value) => {
    expect(await classify(group(G(1), { filterConditions: dyn(rule('groupId', value, operator)) }), group(G(2), { type: 'static' }))).toBe('refused');
  });

  it('compiling is bounded where two paths meet again and again', async () => {
    const layer = (n: number) => [n, n + 100].map((i) => group(G(i), { filterConditions: dyn(rule('groupId', [G(n + 1), G(n + 101)], 'in')) }));
    const chain = (depth: number) => [group(G(1), { filterConditions: dyn(rule('groupId', [G(2), G(102)], 'in')) }),
      ...Array.from({ length: depth }, (_, i) => layer(i + 2)).flat(), group(G(depth + 2), { type: 'static' }), group(G(depth + 102), { type: 'static' })];
    expect(await classify(...chain(2))).toBe('ok');
    const load = loader(...chain(20));
    expect((await judgeFleetFilterGroup(ORG, G(1), { load, budget })).verdict).toBe('refused');
  });

  it('a dynamic group compiles to its rules within its site, or its pinned devices', async () => {
    const q = await members(group(G(1), { siteId: G(9), filterConditions: { operator: 'OR', conditions: [rule('osType'), rule('status', 'online')] } }));
    expect(q.sql).toBe('(("devices"."site_id" = $1 AND (("devices"."os_type" = $2) OR ("devices"."status" = $3))) OR EXISTS (SELECT 1 FROM "device_group_memberships" WHERE "device_group_memberships"."device_id" = "devices"."id" AND "device_group_memberships"."group_id" = $4 AND "device_group_memberships"."org_id" = $5 AND "device_group_memberships"."is_pinned" = $6))');
    expect(q.params).toEqual([G(9), 'windows', 'online', G(1), ORG, true]);
  });

  it('a dynamic group with no rules compiles to its pinned devices, a static one to those added by hand', async () => {
    expect((await members(group(G(1)))).sql).toMatch(/^EXISTS \(SELECT 1 FROM "device_group_memberships".*"is_pinned" = \$3\)$/);
    const q = await members(group(G(1), { type: 'static', filterConditions: dyn(rule('osType')) }));
    expect(q.sql).toMatch(/^EXISTS \(SELECT 1 FROM "device_group_memberships".*"added_by" = \$3\)$/);
    expect(q.params).toEqual([G(1), ORG, 'manual']);
  });

  it.each([['equals', G(2)], ['in', [G(2)]], ['notEquals', G(2)], ['notIn', [G(2)]]] as Array<[string, unknown]>)('a reference (%s) compiles the named group\'s rules in', async (operator, value) => {
    const q = await members(group(G(1), { filterConditions: dyn(rule('groupId', value, operator)) }), group(G(2), { filterConditions: dyn(rule('osType')) }));
    expect(q.sql).toContain('"os_type" = ');
    expect(/IS NOT TRUE/.test(q.sql)).toBe(operator.startsWith('not'));
    // The only stored rows read are pins.
    expect(q.sql.match(/device_group_memberships"\."group_id"/g)).toHaveLength(2);
    expect(q.sql.match(/is_pinned/g)).toHaveLength(2);
  });
});

describe('judgeFleetFilterGroups', () => {
  const link = (a: number, b: number) => group(G(a), { filterConditions: dyn(rule('groupId', G(b))) });
  const fine = (n: number) => group(G(n), { filterConditions: dyn(rule('osType')) });
  const verdicts = (out: Map<string, { verdict: string }>) => Object.fromEntries([...out].map(([id, v]) => [id, v.verdict]));

  it('reads each group once, level by level, whatever names it', async () => {
    const load = loader(link(1, 2), link(2, 3), fine(3), link(4, 2), fine(5));
    const out = await judgeFleetFilterGroups(ORG, [G(1), G(4), G(5), G(1).toUpperCase(), G(3)], { load, budget });
    expect(verdicts(out)).toEqual({ [G(1)]: 'ok', [G(4)]: 'ok', [G(5)]: 'ok', [G(3)]: 'ok' });
    expect(load.mock.calls).toEqual([[[G(1), G(4), G(5), G(3)]], [[G(2)]]]);
  });

  it('a verdict is each named group\'s own', async () => {
    const load = loader(link(1, 9), link(2, 3), group(G(3), { filterConditions: dyn(rule('hostname')) }), fine(4), link(5, 6), link(6, 5));
    const out = await judgeFleetFilterGroups(ORG, [G(9), G(1), G(2), G(3), G(4), G(5)], { load, budget });
    // Not held: `missing` where it is named, `refused` where another group's rules name it.
    expect(verdicts(out)).toEqual({ [G(9)]: 'missing', [G(1)]: 'refused', [G(2)]: 'refused', [G(3)]: 'refused', [G(4)]: 'ok', [G(5)]: 'refused' });
  });

  it('each named group has its own bound on the groups it reaches', async () => {
    const many = (from: number, n: number) => Array.from({ length: n }, (_, i) => group(G(from + i), { type: 'static' }));
    const naming = (id: number, groups: GatedGroup[]) => group(G(id), { filterConditions: dyn(rule('groupId', groups.map((g) => g.id), 'in')) });
    const [a, b] = [many(100, MAX_GATED_GROUPS - 1), many(200, MAX_GATED_GROUPS)];
    const out = await judgeFleetFilterGroups(ORG, [G(1), G(2)], { load: loader(naming(1, a), naming(2, b), ...a, ...b), budget });
    expect(verdicts(out)).toEqual({ [G(1)]: 'ok', [G(2)]: 'refused' });
  });

  it('two named groups compile to their own members', async () => {
    const out = await judgeFleetFilterGroups(ORG, [G(1), G(2)], { load: loader(fine(1), group(G(2), { filterConditions: dyn(rule('status', 'online')) })), budget });
    const sqlOf = (id: string) => { const v = out.get(id)!; return v.verdict === 'ok' ? new PgDialect().sqlToQuery(v.members).params : v.verdict; };
    expect(sqlOf(G(1))).toContain('windows');
    expect(sqlOf(G(2))).toContain('online');
    expect(sqlOf(G(2))).not.toContain('windows');
  });

  it('a chain takes at most one read per group the bound allows', async () => {
    const chain = Array.from({ length: MAX_GATED_GROUPS * 2 }, (_, i) => link(i + 1, i + 2));
    const load = loader(...chain);
    expect((await judgeFleetFilterGroup(ORG, G(1), { load, budget })).verdict).toBe('refused');
    expect(load).toHaveBeenCalledTimes(MAX_GATED_GROUPS);
  });

  it.each([1, 2, 3])('a budget used up during read %i of 3 is a time-out for every group, and nothing more is read', async (last) => {
    const clock = { ms: 0 };
    const inner = loader(link(1, 2), link(2, 3), fine(3));
    const load = vi.fn(async (ids: string[]) => {
      if (load.mock.calls.length === last) clock.ms = 100;
      return inner(ids);
    });
    // G(9) alone would be settled (`missing`) by the first read.
    await expect(judgeFleetFilterGroups(ORG, [G(1), G(9)], { load, budget: new GroupCheckBudget(100, () => clock.ms) })).rejects.toBeInstanceOf(FilterQueryTimeoutError);
    expect(load).toHaveBeenCalledTimes(last);
  });

  it('a budget used up while the groups are compiled is a time-out', async () => {
    let reads = 0;
    // Rows are judged on the first three looks at the clock (and the start); compiling takes the next.
    const budgetOf = (allowed: number) => new GroupCheckBudget(100, () => { reads += 1; return reads <= allowed ? 0 : 100; });
    const groups = [link(1, 2), link(2, 3), fine(3)];
    await expect(judgeFleetFilterGroup(ORG, G(1), { load: loader(...groups), budget: budgetOf(4) })).rejects.toBeInstanceOf(FilterQueryTimeoutError);
    expect(reads).toBe(5);
    reads = 0;
    expect((await judgeFleetFilterGroup(ORG, G(1), { load: loader(...groups), budget: budgetOf(7) })).verdict).toBe('ok');
  });
});

describe('GroupCheckBudget', () => {
  /** An executor whose every read takes `cost` ms, and what it was sent. */
  function fixture(total: number, cost: number, rows: unknown[][]) {
    const clock = { ms: 1_000 };
    const sent: string[] = [];
    const read = (): unknown => {
      const c: Record<string, unknown> = {
        from: () => c, where: () => c, innerJoin: () => c,
        then: (ok: (r: unknown) => unknown) => { sent.push('read'); clock.ms += cost; return Promise.resolve(rows.shift() ?? []).then(ok); },
      };
      return c;
    };
    const executor = {
      select: read, selectDistinct: read,
      execute: async (q: unknown) => { sent.push(String(new PgDialect().sqlToQuery(q as never).params[0])); },
    } as unknown as Parameters<typeof loadGatedGroups>[0];
    return { clock, sent, executor, budget: new GroupCheckBudget(total, () => clock.ms) };
  }
  const staticRow = { id: G(1), type: 'static', siteId: null, filterFieldsUsed: [], filterConditions: null };

  it('each statement may run for what is left, never longer than the bound for one statement', async () => {
    const f = fixture(700, 299.75, [[staticRow]]);
    expect(await loadGatedGroups(f.executor, ORG, [G(1)], f.budget)).toMatchObject([{ id: G(1), hasRuleMembers: false }]);
    expect(f.sent).toEqual(['500ms', 'read', '400ms', 'read', '100ms', 'read']);
    await expect(loadGatedGroups(f.executor, ORG, [G(1)], f.budget)).rejects.toBeInstanceOf(FilterQueryTimeoutError);
    expect(f.sent).toHaveLength(6);
  });

  it.each([[275.5], [299.5], [300]])('too little left (%f ms of 300 used) is nothing left: no statement is sent with a limit that short', async (cost) => {
    const f = fixture(300, cost, [[staticRow]]);
    await expect(loadGatedGroups(f.executor, ORG, [G(1)], f.budget)).rejects.toBeInstanceOf(FilterQueryTimeoutError);
    expect(f.sent).toEqual(['300ms', 'read']);
  });

  it('a statement is sent while the least time for one is left', async () => {
    const f = fixture(300, 275, [[staticRow]]);
    await expect(loadGatedGroups(f.executor, ORG, [G(1)], f.budget)).rejects.toBeInstanceOf(FilterQueryTimeoutError);
    expect(f.sent).toEqual(['300ms', 'read', `${GROUP_CHECK_MIN_STATEMENT_MS}ms`, 'read']);
  });

  it('a step has one statement\'s time; a document has a little more, and less than a held connection may take', () => {
    expect(GROUP_CHECK_STEP_BUDGET_MS).toBe(500);
    expect(GROUP_CHECK_DOCUMENT_BUDGET_MS).toBe(1_500);
  });
});
