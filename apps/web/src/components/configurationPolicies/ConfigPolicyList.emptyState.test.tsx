import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import ConfigPolicyList, { type ListViewFilters } from './ConfigPolicyList';

const atRest: ListViewFilters = { search: '', status: 'all', notApplied: false, org: 'all' };

// #3992 — a tenant with no policies was told to "try adjusting your search"
// when it had never searched, which hides the only useful next step. "No
// results" and "nothing exists yet" are different states. With server filters
// the line is: the server's total is 0 AND nothing narrows the list.
describe('ConfigPolicyList — zero-data vs no-search-results', () => {
  it('offers the create action when the total is 0 and no filter is active', () => {
    render(<ConfigPolicyList policies={[]} total={0} filters={atRest} />);

    expect(screen.queryByText(/adjusting your search/i)).not.toBeInTheDocument();
    // Assert the SENTENCE, not just the absence of the old one: without this a
    // missing or empty `noPoliciesYet` value still satisfies the test.
    expect(screen.getByText(/no configuration policies yet/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /new policy/i })).toHaveAttribute(
      'href',
      '/configuration-policies/new',
    );
  });

  it.each([
    ['a search', { ...atRest, search: 'zzzznomatch' }],
    ['a status filter', { ...atRest, status: 'archived' as const }],
    ['the not-applied filter', { ...atRest, notApplied: true }],
    ['an organization filter', { ...atRest, org: '11111111-2222-4333-8444-555555555555' }],
  ])('says "adjust your search" when %s matched nothing', (_label, filters) => {
    render(<ConfigPolicyList policies={[]} total={0} filters={filters} />);

    expect(screen.getByText(/adjusting your search/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /new policy/i })).not.toBeInTheDocument();
  });
});
