import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import ConfigPolicyList, { type ConfigPolicy } from './ConfigPolicyList';

const policy: ConfigPolicy = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Default Workstation Policy',
  status: 'active',
  orgId: null,
  partnerId: '33333333-3333-3333-3333-333333333333',
  orgName: null,
};

// #3992 — a tenant with no policies was told to "try adjusting your search"
// when it had never searched, which hides the only useful next step. "No
// results" and "nothing exists yet" are different states.
describe('ConfigPolicyList — zero-data vs no-search-results', () => {
  it('offers the create action when there are no policies and no search', () => {
    render(<ConfigPolicyList policies={[]} />);

    expect(screen.queryByText(/adjusting your search/i)).not.toBeInTheDocument();
    // Assert the SENTENCE, not just the absence of the old one: without this a
    // missing or empty `noPoliciesYet` value still satisfies the test.
    expect(screen.getByText(/no configuration policies yet/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /new policy/i })).toHaveAttribute(
      'href',
      '/configuration-policies/new',
    );
  });

  it('still says "adjust your search" when a search matched nothing', async () => {
    const user = userEvent.setup();
    render(<ConfigPolicyList policies={[policy]} />);

    // The policy renders first, so this proves the search is what emptied it.
    expect(screen.getByText('Default Workstation Policy')).toBeInTheDocument();

    await user.type(screen.getByRole('searchbox'), 'zzzznomatch');

    expect(screen.getByText(/adjusting your search/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /new policy/i })).not.toBeInTheDocument();
  });
});
