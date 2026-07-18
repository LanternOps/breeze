import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useOrgScope, getOrgScope } from './useOrgScope';
import { useOrgStore, type Organization } from '../stores/orgStore';

const acme: Organization = {
  id: 'org-1',
  partnerId: 'p-1',
  name: 'Acme Corp',
  status: 'active',
  createdAt: '2026-01-01T00:00:00Z',
};

function seed(partial: Partial<ReturnType<typeof useOrgStore.getState>>) {
  useOrgStore.setState({
    currentOrgId: null,
    allOrgs: false,
    organizations: [],
    organizationsLoaded: false,
    error: null,
    ...partial,
  });
}

describe('useOrgScope / getOrgScope', () => {
  beforeEach(() => {
    seed({});
  });

  it('is loading when nothing is selected, All-orgs not chosen, and the list has not resolved (transient null)', () => {
    const { result } = renderHook(() => useOrgScope());
    expect(result.current).toEqual({
      ready: false,
      status: 'loading',
      scope: null,
      orgId: null,
      org: null,
      error: null,
    });
    expect(getOrgScope().ready).toBe(false);
  });

  it('is error when the org list failed to load and nothing is selected', () => {
    seed({ error: 'Failed to fetch organizations' });
    const scope = getOrgScope();
    expect(scope.ready).toBe(false);
    expect(scope.status).toBe('error');
    expect(scope.error).toBe('Failed to fetch organizations');
  });

  it('is empty when the list resolved with zero orgs', () => {
    seed({ organizationsLoaded: true, organizations: [] });
    const scope = getOrgScope();
    expect(scope.ready).toBe(false);
    expect(scope.status).toBe('empty');
  });

  it('a concrete selection beats a lingering error (selection stays usable)', () => {
    seed({ currentOrgId: 'org-1', organizations: [acme], error: 'stale failure' });
    expect(getOrgScope().scope).toBe('org');
  });

  it('is fleet scope when the user explicitly chose All organizations', () => {
    seed({ allOrgs: true });
    const { result } = renderHook(() => useOrgScope());
    expect(result.current).toEqual({
      ready: true,
      status: 'resolved',
      scope: 'all',
      orgId: null,
      org: null,
      error: null,
    });
    expect(getOrgScope()).toEqual({
      ready: true,
      status: 'resolved',
      scope: 'all',
      orgId: null,
      org: null,
      error: null,
    });
  });

  it('is org scope with the resolved org record when one is selected', () => {
    seed({ currentOrgId: 'org-1', organizations: [acme] });
    const { result } = renderHook(() => useOrgScope());
    expect(result.current.ready).toBe(true);
    expect(result.current.scope).toBe('org');
    expect(result.current.orgId).toBe('org-1');
    expect(result.current.org?.name).toBe('Acme Corp');
  });

  it('org scope wins over a stale allOrgs flag (selection is authoritative)', () => {
    seed({ currentOrgId: 'org-1', allOrgs: true, organizations: [acme] });
    expect(getOrgScope().scope).toBe('org');
  });

  it('handles a selected org missing from the fetched list (org: null, still ready)', () => {
    seed({ currentOrgId: 'org-gone', organizations: [acme] });
    const scope = getOrgScope();
    expect(scope.ready).toBe(true);
    expect(scope.scope).toBe('org');
    expect(scope.org).toBeNull();
  });
});
