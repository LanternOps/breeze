import { describe, it, expect, vi } from 'vitest';
import { collectGroupRefs, findGroupFilterCycle, partnerGroupFilterRefusal, findPartnerGroupRefs } from './groupFilterRefs';

const { findPartnerOwnedGroupIds } = vi.hoisted(() => ({ findPartnerOwnedGroupIds: vi.fn() }));
vi.mock('./deviceGroupOwnership', () => ({ findPartnerOwnedGroupIds }));

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


describe('partner group filter references', () => {
  it('refuses groupId and orgId at any nesting depth, but accepts siteId', () => {
    const refusal = partnerGroupFilterRefusal({ conditions: [
      { field: 'orgId', value: A }, { conditions: [{ field: 'groupId', value: B }] },
    ] });
    expect(refusal).toMatchObject({ code: 'PARTNER_GROUP_FILTER_UNSUPPORTED', fields: ['orgId', 'groupId'] });
    expect(partnerGroupFilterRefusal({ conditions: [{ field: 'siteId', value: A }] })).toBeNull();
  });
  it('finds own-partner references in an org filter', async () => {
    findPartnerOwnedGroupIds.mockResolvedValueOnce([A]);
    expect(await findPartnerGroupRefs(cond('in', [A, B, A]))).toEqual([A]);
    expect(findPartnerOwnedGroupIds).toHaveBeenLastCalledWith([A, B]);
  });
  it('treats another partner group like an unknown id', async () => {
    findPartnerOwnedGroupIds.mockResolvedValue([]);
    expect(await findPartnerGroupRefs(cond('equals', B))).toEqual([]);
    expect(await findPartnerGroupRefs(cond('equals', C))).toEqual([]);
  });
});
