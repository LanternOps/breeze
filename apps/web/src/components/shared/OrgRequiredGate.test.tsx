import { render, screen } from '@testing-library/react';
import '../../lib/i18n';
import { describe, it, expect, beforeEach } from 'vitest';
import { OrgRequiredGate } from './OrgRequiredGate';
import { useOrgStore, type Organization } from '@/stores/orgStore';

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
    partners: [],
    ...partial,
  });
}

const Child = () => <div data-testid="gated-child">data</div>;

describe('OrgRequiredGate', () => {
  beforeEach(() => seed({}));

  it('renders a skeleton (not children) while the context is still resolving', () => {
    render(<OrgRequiredGate><Child /></OrgRequiredGate>);
    expect(screen.getByTestId('org-context-skeleton')).toBeTruthy();
    expect(screen.queryByTestId('gated-child')).toBeNull();
  });

  it('renders the retry card (not a blank page) when the org context failed to load', () => {
    seed({ error: 'Failed to fetch organizations' });
    render(<OrgRequiredGate><Child /></OrgRequiredGate>);
    expect(screen.getByTestId('org-load-failed-state')).toBeTruthy();
    expect(screen.queryByTestId('gated-child')).toBeNull();
  });

  it('prompts for an org in explicit fleet view', () => {
    seed({ allOrgs: true });
    render(<OrgRequiredGate><Child /></OrgRequiredGate>);
    expect(screen.getByTestId('org-required-state')).toBeTruthy();
    expect(screen.queryByTestId('gated-child')).toBeNull();
  });

  it('prompts for an org when the list resolved with zero orgs', () => {
    seed({ organizationsLoaded: true, organizations: [] });
    render(<OrgRequiredGate><Child /></OrgRequiredGate>);
    expect(screen.getByTestId('org-required-state')).toBeTruthy();
  });

  it('renders children once a concrete org is selected', () => {
    seed({ currentOrgId: 'org-1', organizations: [acme] });
    render(<OrgRequiredGate><Child /></OrgRequiredGate>);
    expect(screen.getByTestId('gated-child')).toBeTruthy();
    expect(screen.queryByTestId('org-required-state')).toBeNull();
  });
});
