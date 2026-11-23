import { describe, expect, it } from 'vitest';
import {
  buildPolicyListQuery,
  parseListHash,
  parsePolicyListResponse,
  serializeListHash,
  DEFAULT_LIST_STATE,
} from './policyListQuery';

const ORG = '11111111-2222-4333-8444-555555555555';

describe('buildPolicyListQuery', () => {
  it('sends only page and limit when nothing is filtered', () => {
    expect(buildPolicyListQuery({ page: 1, limit: 25 })).toBe('page=1&limit=25');
  });

  it('sends appliesToOrgId, never orgId', () => {
    const q = new URLSearchParams(buildPolicyListQuery({ page: 2, limit: 25, appliesToOrgId: ORG }));
    expect(q.get('appliesToOrgId')).toBe(ORG);
    expect(q.has('orgId')).toBe(false);
    expect(q.get('page')).toBe('2');
  });

  it('sends notApplied=true only when set, and trims search', () => {
    const on = new URLSearchParams(
      buildPolicyListQuery({ page: 1, limit: 25, notApplied: true, search: '  edr ', status: 'active' }),
    );
    expect(on.get('notApplied')).toBe('true');
    expect(on.get('search')).toBe('edr');
    expect(on.get('status')).toBe('active');
    const off = new URLSearchParams(
      buildPolicyListQuery({ page: 1, limit: 25, notApplied: false, search: '   ', appliesToOrgId: null }),
    );
    expect([...off.keys()].sort()).toEqual(['limit', 'page']);
  });
});

describe('parsePolicyListResponse', () => {
  const row = { id: 'a', name: 'A', status: 'active', orgId: null };

  it('reads the literal { data, pagination } shape', () => {
    expect(parsePolicyListResponse({ data: [row], pagination: { page: 2, limit: 25, total: 137 } })).toEqual({
      data: [row],
      page: 2,
      limit: 25,
      total: 137,
    });
  });

  it('rejects a body without pagination', () => {
    expect(parsePolicyListResponse({ data: [row] })).toBeNull();
  });

  it('rejects a string total', () => {
    expect(parsePolicyListResponse({ data: [row], pagination: { page: 1, limit: 25, total: '137' } })).toBeNull();
  });

  it('rejects negative or fractional counts', () => {
    expect(parsePolicyListResponse({ data: [], pagination: { page: 1, limit: 25, total: -1 } })).toBeNull();
    expect(parsePolicyListResponse({ data: [], pagination: { page: 1, limit: 25, total: 1.5 } })).toBeNull();
  });

  it('rejects a bare array body and non-objects', () => {
    expect(parsePolicyListResponse([row])).toBeNull();
    expect(parsePolicyListResponse(null)).toBeNull();
    expect(parsePolicyListResponse('x')).toBeNull();
    expect(parsePolicyListResponse({ data: 'nope', pagination: { page: 1, limit: 25, total: 0 } })).toBeNull();
  });

  it('accepts an empty page with total 0', () => {
    expect(parsePolicyListResponse({ data: [], pagination: { page: 1, limit: 25, total: 0 } })?.total).toBe(0);
  });
});

describe('list hash state', () => {
  it('defaults on an empty or unknown hash', () => {
    expect(parseListHash('')).toEqual(DEFAULT_LIST_STATE);
    expect(parseListHash('whatever')).toEqual(DEFAULT_LIST_STATE);
  });

  it('round-trips a full state', () => {
    const state = { status: 'active' as const, notApplied: true, org: ORG, search: 'a b&c', page: 3 };
    const hash = serializeListHash(state);
    expect(hash).toContain('status=active');
    expect(hash).toContain('notApplied=1');
    expect(parseListHash(hash)).toEqual(state);
    expect(parseListHash('#' + hash)).toEqual(state);
  });

  it('round-trips an explicit all-organizations choice distinct from the default', () => {
    const state = { ...DEFAULT_LIST_STATE, org: 'all' };
    expect(serializeListHash(state)).toBe('org=all');
    expect(parseListHash('org=all').org).toBe('all');
    expect(parseListHash('').org).toBeUndefined();
  });

  it('omits defaults', () => {
    expect(serializeListHash(DEFAULT_LIST_STATE)).toBe('');
  });

  it('falls back to defaults for invalid values', () => {
    expect(parseListHash('status=bogus&page=0&org=not-a-uuid&notApplied=maybe')).toEqual(DEFAULT_LIST_STATE);
    expect(parseListHash('page=abc').page).toBe(1);
    expect(parseListHash('page=2.5').page).toBe(1);
  });
});
