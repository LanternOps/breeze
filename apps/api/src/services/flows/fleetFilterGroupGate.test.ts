import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { judgeFleetFilterGroup, MAX_GATED_GROUPS, type GatedGroup } from './fleetFilterGroupGate';

const G = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = '11111111-1111-4111-8111-111111111111';
/** A value the group routes would accept for the field. */
const valueFor = (field: string): unknown => (field === 'osType' ? 'windows' : 'x');
const rule = (field: string, value: unknown = valueFor(field), operator = 'equals') => ({ field, operator, value });
const dyn = (...conditions: unknown[]) => ({ operator: 'AND', conditions });
const group = (id: string, over: Partial<GatedGroup> = {}): GatedGroup => ({ id, type: 'dynamic', siteId: null, filterFieldsUsed: [], filterConditions: null, hasRuleMembers: false, ...over });
const loader = (...groups: GatedGroup[]) => vi.fn(async (ids: string[]) => groups.filter((g) => ids.includes(g.id)));
const judge = (...groups: GatedGroup[]) => judgeFleetFilterGroup(ORG, G(1), loader(...groups));
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
    expect((await judgeFleetFilterGroup(ORG, G(1), load)).verdict).toBe('refused');
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
