import { describe, expect, it, vi } from 'vitest';
import { classifyFleetFilterGroup, MAX_GATED_GROUPS, type GatedGroup } from './fleetFilterGroupGate';

const G = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rule = (field: string, value: unknown = 'x', operator = 'equals') => ({ field, operator, value });
const dyn = (...conditions: unknown[]) => ({ operator: 'AND', conditions });
const group = (id: string, over: Partial<GatedGroup> = {}): GatedGroup => ({ id, type: 'dynamic', filterFieldsUsed: [], filterConditions: null, ...over });
const loader = (...groups: GatedGroup[]) => vi.fn(async (ids: string[]) => groups.filter((g) => ids.includes(g.id)));
const classify = (...groups: GatedGroup[]) => classifyFleetFilterGroup(G(1), loader(...groups));

describe('classifyFleetFilterGroup', () => {
  it('a static group, and a dynamic group on allowed fields, pass', async () => {
    expect(await classify(group(G(1), { type: 'static' }))).toBe('ok');
    expect(await classify(group(G(1), { filterFieldsUsed: ['osType'], filterConditions: dyn(rule('osType'), dyn(rule('siteId'))) }))).toBe('ok');
    expect(await classify(group(G(1), { filterFieldsUsed: null }))).toBe('ok');
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

  it('references are followed to any depth, and a cycle ends', async () => {
    const link = (a: number, b: number) => group(G(a), { filterConditions: dyn(rule('groupId', G(b))) });
    expect(await classify(link(1, 2), link(2, 3), group(G(3), { filterConditions: dyn(rule('tags')) }))).toBe('refused');
    expect(await classify(link(1, 2), link(2, 1))).toBe('ok');
  });

  it('a static group\'s leftover rules are not live, so they are not followed', async () => {
    expect(await classify(group(G(1), { type: 'static', filterConditions: dyn(rule('hostname')) }))).toBe('ok');
  });

  it.each([['a string', 'x'], ['an array', []], ['no conditions', {}], ['a null condition', dyn(null)], ['a condition with no field', dyn({ operator: 'equals' })],
    ['a non-string group reference', dyn(rule('groupId', 5))], ['a malformed group id', dyn(rule('groupId', 'nope'))],
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
});
