import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

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

describe('ConfigPolicyList Features column (#2950)', () => {
  const withLinks: ConfigPolicy = {
    ...orgOwned,
    featureLinks: [
      { id: 'link-1', featureType: 'alert_rule' },
      { id: 'link-2', featureType: 'onedrive_helper' },
    ],
  };

  it('renders a badge per feature link using the editor tab labels', () => {
    render(<ConfigPolicyList policies={[withLinks]} />);

    const badges = screen.getAllByTestId('config-policy-feature-badge');
    expect(badges.map((b) => b.textContent)).toEqual(['Alerts', 'OneDrive Helper']);
    expect(screen.queryByTestId('config-policy-features-empty')).toBeNull();
  });

  it('labels feature types the old local map never covered', () => {
    // sensitive_data / peripheral_control / vulnerability were 3 of the 10
    // canonical types missing from the removed featureTypeLabels map — they
    // used to render as raw enum values.
    render(
      <ConfigPolicyList
        policies={[
          {
            ...orgOwned,
            featureLinks: [
              { id: 'l1', featureType: 'sensitive_data' },
              { id: 'l2', featureType: 'peripheral_control' },
              { id: 'l3', featureType: 'vulnerability' },
            ],
          },
        ]}
      />,
    );

    expect(
      screen.getAllByTestId('config-policy-feature-badge').map((b) => b.textContent),
    ).toEqual(['Data Discovery', 'Peripheral Control', 'Vulnerability Scanning']);
  });

  it('falls back to the raw feature type for an unknown value rather than blanking the cell', () => {
    render(
      <ConfigPolicyList
        policies={[{ ...orgOwned, featureLinks: [{ id: 'l1', featureType: 'future_feature' }] }]}
      />,
    );

    expect(screen.getByTestId('config-policy-feature-badge')).toHaveTextContent('future_feature');
  });

  it('shows the empty marker only when a policy genuinely has no feature links', () => {
    render(<ConfigPolicyList policies={[{ ...orgOwned, featureLinks: [] }]} />);

    const empty = screen.getByTestId('config-policy-features-empty');
    expect(empty).toBeInTheDocument();
    // Present-and-empty is a real answer, so it is safe to announce "None".
    expect(empty).toHaveTextContent('None');
    expect(screen.queryByTestId('config-policy-feature-badge')).toBeNull();
  });

  it('does NOT claim "None" when the endpoint omitted featureLinks entirely', () => {
    // web deployed ahead of api: the field is absent, not empty. Announcing
    // "None" would assert something we do not know — every row would tell a
    // screen-reader user their policies have no features attached.
    render(<ConfigPolicyList policies={[{ ...orgOwned, featureLinks: undefined }]} />);

    expect(screen.queryByTestId('config-policy-features-empty')).toBeNull();
    const unknown = screen.getByTestId('config-policy-features-unknown');
    expect(unknown).toHaveAttribute('aria-hidden', 'true');
    expect(unknown).not.toHaveTextContent('None');
  });
});

describe('ConfigPolicyList action buttons (#2950)', () => {
  it('gives each row action an accessible name that names the policy', () => {
    render(<ConfigPolicyList policies={[orgOwned]} />);

    expect(screen.getByTestId('config-policy-edit-button')).toHaveAccessibleName(
      'Edit: Default Workstation Policy',
    );
    expect(screen.getByTestId('config-policy-delete-button')).toHaveAccessibleName(
      'Delete: Default Workstation Policy',
    );
  });

  it('addresses one row per policy so E2E can target a specific row by testid', () => {
    render(<ConfigPolicyList policies={[partnerWide, orgOwned]} />);

    const rows = screen.getAllByTestId('config-policy-row');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveAttribute('data-policy-id', orgOwned.id);
    expect(screen.getAllByTestId('config-policy-edit-button')).toHaveLength(2);
  });

  it('invokes the row handler with that row own policy', async () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const user = userEvent.setup();
    render(
      <ConfigPolicyList policies={[partnerWide, orgOwned]} onEdit={onEdit} onDelete={onDelete} />,
    );

    await user.click(screen.getAllByTestId('config-policy-edit-button')[1]);
    await user.click(screen.getAllByTestId('config-policy-delete-button')[0]);

    expect(onEdit).toHaveBeenCalledWith(orgOwned);
    expect(onDelete).toHaveBeenCalledWith(partnerWide);
  });

  it('labels the icon-only pagination controls', () => {
    const many: ConfigPolicy[] = Array.from({ length: 3 }, (_, i) => ({
      ...orgOwned,
      id: `policy-${i}`,
      name: `Policy ${i}`,
    }));
    render(<ConfigPolicyList policies={many} pageSize={2} />);

    // Pager controls, not navigation verbs — "Back" would be the wrong thing
    // to announce here.
    expect(screen.getByTestId('config-policy-prev-page')).toHaveAccessibleName('Previous page');
    expect(screen.getByTestId('config-policy-next-page')).toHaveAccessibleName('Next page');
  });

  it('pages through rows and disables the controls at both boundaries', async () => {
    const user = userEvent.setup();
    const many: ConfigPolicy[] = Array.from({ length: 3 }, (_, i) => ({
      ...orgOwned,
      id: `policy-${i}`,
      name: `Policy ${i}`,
    }));
    render(<ConfigPolicyList policies={many} pageSize={2} />);

    const prev = screen.getByTestId('config-policy-prev-page');
    const next = screen.getByTestId('config-policy-next-page');
    expect(prev).toBeDisabled();
    expect(screen.getAllByTestId('config-policy-row')).toHaveLength(2);

    await user.click(next);

    // Page 2 holds the single remaining row, and Next is now the boundary.
    expect(screen.getAllByTestId('config-policy-row')).toHaveLength(1);
    expect(screen.getByTestId('config-policy-row')).toHaveAttribute('data-policy-id', 'policy-2');
    expect(next).toBeDisabled();
    expect(prev).toBeEnabled();
  });
});
