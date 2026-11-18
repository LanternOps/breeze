import { describe, expect, it } from 'vitest';
import { orderAccessibleOrgIds } from './accessibleOrgOrder';

describe('orderAccessibleOrgIds (#9529)', () => {
  it('sorts by case-insensitive slug', () => {
    expect(
      orderAccessibleOrgIds([
        { id: 'c', slug: 'charlie', type: 'customer' },
        { id: 'a', slug: 'Alpha', type: 'customer' },
        { id: 'b', slug: 'bravo', type: 'internal' },
      ]),
    ).toEqual(['a', 'b', 'c']);
  });

  it('puts the hidden Quick Support org after every customer org, whatever its slug', () => {
    expect(
      orderAccessibleOrgIds([
        { id: 'qs', slug: 'a-quick-support', type: 'quick_support' },
        { id: 'z', slug: 'zulu', type: 'customer' },
      ]),
    ).toEqual(['z', 'qs']);
  });

  it('breaks ties on id, so the result never depends on input order', () => {
    const rows = [
      { id: 'org-2', slug: null, type: null },
      { id: 'org-1', slug: null, type: null },
      { id: 'org-3', slug: 'same', type: 'customer' },
      { id: 'org-0', slug: 'SAME', type: 'customer' },
    ];
    const expected = ['org-1', 'org-2', 'org-0', 'org-3'];
    expect(orderAccessibleOrgIds(rows)).toEqual(expected);
    expect(orderAccessibleOrgIds([...rows].reverse())).toEqual(expected);
  });

  it('does not mutate its input', () => {
    const rows = [{ id: 'b', slug: 'b' }, { id: 'a', slug: 'a' }];
    orderAccessibleOrgIds(rows);
    expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
  });
});
