import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import ConfigPolicyList, { type ConfigPolicy } from './ConfigPolicyList';

const partnerWide: ConfigPolicy = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Default Workstation Policy',
  status: 'active',
  orgId: null,
  partnerId: '33333333-3333-3333-3333-333333333333',
  orgName: null,
};

const orgOwned: ConfigPolicy = {
  id: '22222222-2222-2222-2222-222222222222',
  name: 'Default Workstation Policy',
  status: 'active',
  orgId: '44444444-4444-4444-4444-444444444444',
  orgName: 'OliveTech',
};

describe('ConfigPolicyList ownership badges', () => {
  it('shows the Partner-wide badge only on partner-wide policies', () => {
    render(<ConfigPolicyList policies={[partnerWide, orgOwned]} />);

    const badges = screen.getAllByTestId('partner-wide-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent('Partner-wide');
  });

  it('shows an org badge with the owning org name on org-owned policies', () => {
    render(<ConfigPolicyList policies={[partnerWide, orgOwned]} />);

    const badges = screen.getAllByTestId('org-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent('OliveTech');
  });

  it('falls back to a generic label when the org name is missing', () => {
    render(<ConfigPolicyList policies={[{ ...orgOwned, orgName: undefined }]} />);

    expect(screen.getByTestId('org-badge')).toHaveTextContent('Organization');
  });
});
