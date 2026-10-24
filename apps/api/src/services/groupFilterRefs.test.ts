import { describe, it, expect } from 'vitest';
import { collectGroupRefs, findGroupFilterCycle } from './groupFilterRefs';

const A = '4d68e998-1048-48d6-a267-e1aacf2f556e';
const B = '0b2f6c1e-5d7a-4c3b-9e8f-1a2b3c4d5e6f';
const C = '7a1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';

const cond = (operator: string, value: unknown) =>
  ({ operator: 'AND', conditions: [{ field: 'groupId', operator, value }] }) as any;

describe('collectGroupRefs', () => {
  it('collects ids from equals/notEquals/in/notIn, nested, deduped', () => {
    const f = {
      operator: 'AND',
      conditions: [
        { field: 'groupId', operator: 'notEquals', value: A },
        { operator: 'OR', conditions: [{ field: 'groupId', operator: 'notIn', value: [B, A] }, { field: 'osType', operator: 'equals', value: 'windows' }] },
      ],
    } as any;
    expect([...collectGroupRefs(f)].sort()).toEqual([A, B].sort());
  });
  it('returns empty for filters without groupId', () => {
    expect(collectGroupRefs({ operator: 'AND', conditions: [{ field: 'osType', operator: 'equals', value: 'windows' }] } as any).size).toBe(0);
  });
});

describe('findGroupFilterCycle', () => {
  it('flags a group referencing itself', () => {
    expect(findGroupFilterCycle(A, new Set([A]), new Map())).toEqual([A, A]);
  });
  it('flags a two-group cycle', () => {
    const others = new Map([[B, new Set([A])]]);
    expect(findGroupFilterCycle(A, new Set([B]), others)).toEqual([A, B, A]);
  });
  it('flags a longer cycle', () => {
    const others = new Map([[B, new Set([C])], [C, new Set([A])]]);
    expect(findGroupFilterCycle(A, new Set([B]), others)).toEqual([A, B, C, A]);
  });
  it('allows a DAG and static/unknown referenced groups', () => {
    const others = new Map([[B, new Set([C])]]);
    expect(findGroupFilterCycle(A, new Set([B, C]), others)).toBeNull();
  });
});
