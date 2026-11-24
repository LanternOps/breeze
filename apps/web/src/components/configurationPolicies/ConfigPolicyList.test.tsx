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
  hasPartnerWideAssignment: true,
};

const orgOwned: ConfigPolicy = {
  id: '22222222-2222-2222-2222-222222222222',
  name: 'Default Workstation Policy',
  status: 'active',
  orgId: '44444444-4444-4444-4444-444444444444',
  orgName: 'Fabrikam MSP',
};

describe('ConfigPolicyList status filter select accessible name (#7156)', () => {
  it('gives the status filter select a real accessible name', () => {
    render(<ConfigPolicyList policies={[]} />);
    expect(screen.getByRole('combobox', { name: 'Status' })).toBeInTheDocument();
  });
});

const summary = (over: Record<string, unknown> = {}) => ({
  assignmentCount: 0,
  allOrganizations: false,
  targets: [] as unknown[],
  childPolicyCount: 0,
  ...over,
});
const orgTarget = (id: string, name: string) => ({
  assignmentId: id,
  level: 'organization',
  targetId: `org-${id}`,
  name,
  roleFilter: null,
  osFilter: null,
});

describe('ConfigPolicyList Copy (#12309, plan W05b K3)', () => {
  it('each row offers Copy for that policy', async () => {
    const onCopy = vi.fn();
    render(<ConfigPolicyList policies={[partnerWide, { ...orgOwned, name: 'Servers' }]} onCopy={onCopy} />);

    await userEvent.click(screen.getByRole('button', { name: 'Copy: Servers' }));
    expect(onCopy).toHaveBeenCalledWith(expect.objectContaining({ id: orgOwned.id }));
  });

  it('no handler, no Copy control', () => {
    render(<ConfigPolicyList policies={[orgOwned]} />);
    expect(screen.queryByTestId('config-policy-copy-button')).toBeNull();
  });
});

describe('ConfigPolicyList Applies to column (#12306)', () => {
  it('sits between Name and Status', () => {
    render(<ConfigPolicyList policies={[orgOwned]} />);
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers.slice(0, 3)).toEqual(['Name', 'Applies to', 'Status']);
  });

  it('shows the first targets and +N in the Applies to cell', () => {
    render(
      <ConfigPolicyList
        policies={[
          {
            ...partnerWide,
            appliesTo: summary({
              assignmentCount: 5,
              targets: [orgTarget('a', 'Acme'), orgTarget('b', 'Birch'), orgTarget('c', 'Cedar')],
            }),
          },
        ]}
      />,
    );
    const cell = screen.getByTestId('config-policy-applies-to-cell');
    expect(cell).toHaveTextContent('Acme');
    expect(cell).toHaveTextContent('Birch');
    expect(cell).toHaveTextContent('Cedar');
    expect(cell).toHaveTextContent('+2');
    expect(screen.queryByTestId('config-policy-not-applied-badge')).toBeNull();
  });

  it('names a partner-level row All organizations', () => {
    render(
      <ConfigPolicyList
        policies={[
          {
            ...partnerWide,
            appliesTo: summary({
              assignmentCount: 1,
              allOrganizations: true,
              targets: [{ ...orgTarget('p', ''), level: 'partner', name: null }],
            }),
          },
        ]}
      />,
    );
    expect(screen.getByTestId('config-policy-applies-to-cell')).toHaveTextContent('All organizations');
  });

  it('marks an active unassigned policy with no children with a warning chip', () => {
    render(<ConfigPolicyList policies={[{ ...partnerWide, appliesTo: summary() }]} />);
    const chip = screen.getByTestId('config-policy-not-applied-badge');
    expect(chip).toHaveTextContent('Not applied');
    expect(chip).toHaveAttribute('data-tone', 'warning');
  });

  it('marks an inactive unassigned policy with a neutral chip and an archived one with none', () => {
    const { rerender } = render(
      <ConfigPolicyList policies={[{ ...partnerWide, status: 'inactive', appliesTo: summary() }]} />,
    );
    expect(screen.getByTestId('config-policy-not-applied-badge')).toHaveAttribute('data-tone', 'neutral');
    rerender(<ConfigPolicyList policies={[{ ...partnerWide, status: 'archived', appliesTo: summary() }]} />);
    expect(screen.queryByTestId('config-policy-not-applied-badge')).toBeNull();
  });

  it('marks a parent with children In use through N policies, not Not applied', () => {
    render(<ConfigPolicyList policies={[{ ...partnerWide, appliesTo: summary({ childPolicyCount: 3 }) }]} />);
    expect(screen.getByTestId('config-policy-in-use-badge')).toHaveTextContent('In use through 3 policies');
    expect(screen.queryByTestId('config-policy-not-applied-badge')).toBeNull();
  });

  it('never says Not applied when rows exist that the caller may not list', () => {
    render(<ConfigPolicyList policies={[{ ...partnerWide, appliesTo: summary({ assignmentCount: 2 }) }]} />);
    expect(screen.queryByTestId('config-policy-not-applied-badge')).toBeNull();
    expect(screen.getByTestId('config-policy-applies-to-cell')).toHaveTextContent('+2');
  });

  it('renders an em dash and no chip when appliesTo is absent', () => {
    render(<ConfigPolicyList policies={[partnerWide, { ...orgOwned, appliesTo: { assignmentCount: 'x' } }]} />);
    const cells = screen.getAllByTestId('config-policy-applies-to-cell');
    expect(cells).toHaveLength(2);
    for (const cell of cells) expect(cell).toHaveTextContent('—');
    expect(screen.queryByTestId('config-policy-not-applied-badge')).toBeNull();
    expect(screen.queryByTestId('config-policy-in-use-badge')).toBeNull();
  });

  it('shows Managed by <org> only on org-managed rows', () => {
    render(<ConfigPolicyList policies={[partnerWide, orgOwned]} />);
    const managed = screen.getAllByTestId('config-policy-managed-by');
    expect(managed).toHaveLength(1);
    expect(managed[0]).toHaveTextContent('Managed by Fabrikam MSP');
  });

  it('no longer renders the Partner-wide or Partner policy badges', () => {
    render(<ConfigPolicyList policies={[partnerWide, { ...partnerWide, id: 'p2', hasPartnerWideAssignment: false }, orgOwned]} />);
    expect(screen.queryByTestId('partner-wide-badge')).toBeNull();
    expect(screen.queryByTestId('partner-policy-badge')).toBeNull();
    expect(screen.queryByTestId('org-badge')).toBeNull();
  });

  it('keeps the empty-state row spanning every column', () => {
    render(<ConfigPolicyList policies={[]} />);
    const columns = screen.getAllByRole('columnheader').length;
    const cell = screen.getByText(/No configuration policies yet/i).closest('td');
    expect(cell).toHaveAttribute('colspan', String(columns));
  });
});

describe('ConfigPolicyList inherits badge (#5080)', () => {
  it('shows an "inherits" badge on rows with parentPolicyId', () => {
    const child: ConfigPolicy = { ...orgOwned, parentPolicyId: 'parent-1' };
    render(<ConfigPolicyList policies={[partnerWide, child]} />);

    const badges = screen.getAllByTestId('config-policy-inherits-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent('Inherits');
  });

  it('does not show the badge on a policy with no parent', () => {
    render(<ConfigPolicyList policies={[orgOwned]} />);
    expect(screen.queryByTestId('config-policy-inherits-badge')).not.toBeInTheDocument();
  });
});

describe('ConfigPolicyList Features column (#2950)', () => {
  const withLinks: ConfigPolicy = {
    ...orgOwned,
    featureLinks: [
      { id: 'link-1', featureType: 'monitors' },
      { id: 'link-2', featureType: 'onedrive_helper' },
    ],
  };

  it('renders a badge per feature link using the editor tab labels', () => {
    render(<ConfigPolicyList policies={[withLinks]} />);

    const badges = screen.getAllByTestId('config-policy-feature-badge');
    expect(badges.map((b) => b.textContent)).toEqual(['Monitors', 'OneDrive Helper']);
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
    render(<ConfigPolicyList policies={many} total={3} pageSize={2} />);

    // Pager controls, not navigation verbs — "Back" would be the wrong thing
    // to announce here.
    expect(screen.getByTestId('config-policy-prev-page')).toHaveAccessibleName('Previous page');
    expect(screen.getByTestId('config-policy-next-page')).toHaveAccessibleName('Next page');
  });

  it('disables the pager controls at both boundaries of the server total', () => {
    const rowsOnPage: ConfigPolicy[] = Array.from({ length: 2 }, (_, i) => ({
      ...orgOwned,
      id: `policy-${i}`,
      name: `Policy ${i}`,
    }));
    const { rerender } = render(
      <ConfigPolicyList policies={rowsOnPage} total={3} page={1} pageSize={2} />,
    );
    expect(screen.getByTestId('config-policy-prev-page')).toBeDisabled();
    expect(screen.getByTestId('config-policy-next-page')).toBeEnabled();

    rerender(<ConfigPolicyList policies={[rowsOnPage[0]!]} total={3} page={2} pageSize={2} />);
    expect(screen.getByTestId('config-policy-next-page')).toBeDisabled();
    expect(screen.getByTestId('config-policy-prev-page')).toBeEnabled();
  });
});
