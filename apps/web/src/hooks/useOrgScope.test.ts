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
    ...partial,
  });
}

describe('useOrgScope / getOrgScope', () => {
  beforeEach(() => {
    seed({});
  });

  it('is not ready when nothing is selected and All-orgs was not chosen (transient null)', () => {
    const { result } = renderHook(() => useOrgScope());
    expect(result.current).toEqual({ ready: false, scope: null, orgId: null, org: null });
    expect(getOrgScope().ready).toBe(false);
  });

  it('is fleet scope when the user explicitly chose All organizations', () => {
    seed({ allOrgs: true });
    const { result } = renderHook(() => useOrgScope());
    expect(result.current).toEqual({ ready: true, scope: 'all', orgId: null, org: null });
    expect(getOrgScope()).toEqual({ ready: true, scope: 'all', orgId: null, org: null });
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
