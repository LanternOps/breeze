import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/lib/i18n';
import PolicyHeader from './PolicyHeader';

type Props = React.ComponentProps<typeof PolicyHeader>;

const baseProps: Props = {
  name: 'Standard Workstation',
  description: 'Workstations everywhere',
  status: 'active',
  orgId: 'org-1',
  orgName: 'Acme',
  parentPolicy: null,
  childPolicies: [],
  canOpenParent: true,
  readOnly: false,
  readOnlyReason: null,
  onEditDetails: vi.fn(),
};

describe('PolicyHeader (#12469)', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('the header shows Based on, Parent of and Managed by facts', () => {
    render(
      <PolicyHeader
        {...baseProps}
        parentPolicy={{ id: 'parent-1', name: 'Baseline', orgId: 'org-1' }}
        childPolicies={[
          { id: 'c-1', name: 'Child One' },
          { id: 'c-2', name: 'Child Two' },
        ]}
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Standard Workstation' })).toBeInTheDocument();
    expect(screen.getByText('Workstations everywhere')).toBeInTheDocument();
    expect(screen.getByTestId('config-policy-status-pill')).toHaveTextContent('Active');

    const basedOn = screen.getByTestId('config-policy-based-on');
    expect(basedOn).toHaveTextContent('Based on');
    expect(within(basedOn).getByRole('link', { name: 'Baseline' })).toHaveAttribute('href', '/configuration-policies/parent-1');

    const parentOf = screen.getByTestId('config-policy-parent-of');
    expect(parentOf).toHaveTextContent('Parent of 2 policies');
    fireEvent.click(within(parentOf).getByText('Parent of 2 policies'));
    expect(within(parentOf).getByRole('link', { name: 'Child Two' })).toHaveAttribute('href', '/configuration-policies/c-2');

    expect(screen.getByTestId('config-policy-managed-by')).toHaveTextContent('Managed by Acme');
  });

  it('an MSP-managed policy shows no Managed-by line; a parent the caller cannot open is named, not linked', () => {
    render(
      <PolicyHeader
        {...baseProps}
        orgId={null}
        orgName={null}
        parentPolicy={{ id: 'parent-1', name: 'MSP Baseline', orgId: null }}
        canOpenParent={false}
      />,
    );
    expect(screen.queryByTestId('config-policy-managed-by')).toBeNull();
    const basedOn = screen.getByTestId('config-policy-based-on');
    expect(within(basedOn).queryByRole('link')).toBeNull();
    expect(basedOn).toHaveTextContent('MSP Baseline');
    expect(basedOn).toHaveTextContent('Managed by your MSP');
    expect(screen.queryByTestId('config-policy-parent-of')).toBeNull();
  });

  it('Edit details opens the details form', () => {
    const onEditDetails = vi.fn();
    render(<PolicyHeader {...baseProps} onEditDetails={onEditDetails} />);
    fireEvent.click(screen.getByTestId('config-policy-edit-details'));
    expect(onEditDetails).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('config-policy-read-only')).toBeNull();
  });

  it('a read-only viewer sees the reason before any click', () => {
    render(
      <PolicyHeader {...baseProps} orgId={null} readOnly readOnlyReason="msp_managed_org_user" onEditDetails={undefined} />,
    );
    expect(screen.getByTestId('config-policy-read-only')).toHaveTextContent(
      'View only. Your MSP manages this policy, so only your MSP can change it.',
    );
    // No mutation control is rendered, not merely disabled.
    expect(screen.queryByTestId('config-policy-edit-details')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('a read-only viewer with an unknown reason still sees that the page is view only', () => {
    render(<PolicyHeader {...baseProps} readOnly readOnlyReason={null} onEditDetails={undefined} />);
    expect(screen.getByTestId('config-policy-read-only')).toHaveTextContent('View only.');
  });

  it.each([
    ['msp_managed_limited_access', 'View only. Your MSP manages this policy, and your access covers only some organizations.'],
    ['site_restricted', 'View only. Your access is limited to some sites, and this policy reaches beyond them.'],
    ['no_write_permission', 'View only. Your role can view configuration policies but not change them.'],
    ['not_editable', 'View only. You can view this policy but not change it.'],
  ] as const)('explains %s', (reason, text) => {
    render(<PolicyHeader {...baseProps} readOnly readOnlyReason={reason} onEditDetails={undefined} />);
    expect(screen.getByTestId('config-policy-read-only')).toHaveTextContent(text);
  });
});

describe('PolicyHeader: Copy (#12309, plan W05b K3)', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('a locked owner offers Copy beside the reason', () => {
    const onCopy = vi.fn();
    render(<PolicyHeader {...baseProps} showFixedNote onCopy={onCopy} />);

    const note = screen.getByTestId('config-policy-owner-fixed');
    expect(note).toHaveTextContent('Managed by and Based on were fixed when this policy was first saved.');
    fireEvent.click(within(note).getByRole('button', { name: 'Copy with a different owner or parent' }));
    expect(onCopy).toHaveBeenCalledTimes(1);
  });

  it('the header offers Copy, also to a read-only viewer', () => {
    const onCopy = vi.fn();
    render(<PolicyHeader {...baseProps} orgId={null} readOnly readOnlyReason="msp_managed_org_user" onEditDetails={undefined} onCopy={onCopy} />);

    fireEvent.click(screen.getByTestId('config-policy-copy'));
    expect(onCopy).toHaveBeenCalledTimes(1);
  });

  it('offers no Copy when the page passes no handler', () => {
    render(<PolicyHeader {...baseProps} showFixedNote />);
    expect(screen.queryByTestId('config-policy-copy')).toBeNull();
    expect(within(screen.getByTestId('config-policy-owner-fixed')).queryByRole('button')).toBeNull();
  });
});
