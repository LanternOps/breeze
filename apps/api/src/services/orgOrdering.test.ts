import { describe, it, expect } from 'vitest';
import { applyOrganizationOrder, sanitizeOrganizationOrder } from './orgOrdering';

const orgs = [
  { id: 'a', name: 'Alpha' },
  { id: 'b', name: 'Bravo' },
  { id: 'c', name: 'Charlie' },
  { id: 'd', name: 'Delta' },
];

describe('applyOrganizationOrder', () => {
  it('returns input unchanged when preferred order is undefined', () => {
    expect(applyOrganizationOrder(orgs, undefined).map((o) => o.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns input unchanged when preferred order is null', () => {
    expect(applyOrganizationOrder(orgs, null).map((o) => o.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns input unchanged when preferred order is empty', () => {
    expect(applyOrganizationOrder(orgs, []).map((o) => o.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('reorders matching orgs in the preferred order', () => {
    expect(applyOrganizationOrder(orgs, ['c', 'a', 'd', 'b']).map((o) => o.id)).toEqual([
      'c', 'a', 'd', 'b',
    ]);
  });

  it('appends orgs missing from preferred order in original order', () => {
    expect(applyOrganizationOrder(orgs, ['c', 'a']).map((o) => o.id)).toEqual([
      'c', 'a', 'b', 'd',
    ]);
  });

  it('ignores stale ids in preferred order that no longer match an org', () => {
    expect(applyOrganizationOrder(orgs, ['stale', 'd', 'b']).map((o) => o.id)).toEqual([
      'd', 'b', 'a', 'c',
    ]);
  });

  it('ignores duplicates in preferred order', () => {
    expect(applyOrganizationOrder(orgs, ['b', 'b', 'a']).map((o) => o.id)).toEqual([
      'b', 'a', 'c', 'd',
    ]);
  });

  it('handles a single-org list', () => {
    expect(applyOrganizationOrder([{ id: 'x' }], ['x']).map((o) => o.id)).toEqual(['x']);
  });

  it('does not mutate the input array', () => {
    const input = [...orgs];
    applyOrganizationOrder(input, ['d', 'a']);
    expect(input.map((o) => o.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('sanitizeOrganizationOrder', () => {
  it('keeps only ids that are in the valid set', () => {
    expect(sanitizeOrganizationOrder(['a', 'stale', 'c'], ['a', 'b', 'c'])).toEqual(['a', 'c']);
  });

  it('preserves the caller order', () => {
    expect(sanitizeOrganizationOrder(['c', 'a', 'b'], ['a', 'b', 'c'])).toEqual(['c', 'a', 'b']);
  });

  it('drops duplicates while preserving first occurrence', () => {
    expect(sanitizeOrganizationOrder(['a', 'b', 'a', 'c', 'b'], ['a', 'b', 'c'])).toEqual([
      'a', 'b', 'c',
    ]);
  });

  it('returns empty array when nothing valid', () => {
    expect(sanitizeOrganizationOrder(['x', 'y'], ['a', 'b'])).toEqual([]);
  });

  it('returns empty array on empty input', () => {
    expect(sanitizeOrganizationOrder([], ['a', 'b'])).toEqual([]);
  });
});
