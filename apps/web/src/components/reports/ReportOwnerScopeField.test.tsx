import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const claims = vi.hoisted(() => ({
  value: { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p-1' } } as unknown,
}));
vi.mock('@/lib/authScope', () => ({ useJwtClaims: () => claims.value }));
const org = vi.hoisted(() => ({ currentOrgId: null as string | null }));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: org.currentOrgId }) }));
// `user.canManagePartnerWide` (partnerOrgAccess 'all'); undefined = a session
// persisted before the field existed, treated as capable like every other
// partner-wide surface (the server gates every write regardless).
const authUser = vi.hoisted(() => ({ canManagePartnerWide: undefined as boolean | undefined }));
vi.mock('../../stores/auth', () => ({
  useAuthStore: (selector: (s: { user: { canManagePartnerWide?: boolean } }) => unknown) =>
    selector({ user: { canManagePartnerWide: authUser.canManagePartnerWide } }),
}));

import { ReportOwnerScopeField, useDefaultReportOwnerScope } from './ReportOwnerScopeField';

function Harness() {
  const { canChoose, defaultScope, needsOrganization } = useDefaultReportOwnerScope();
  return (
    <div
      data-testid="harness"
      data-can-choose={String(canChoose)}
      data-default={defaultScope}
      data-needs-org={String(needsOrganization)}
    />
  );
}

describe('report owner scope (#3198 W03)', () => {
  beforeEach(() => {
    claims.value = { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p-1' } };
    org.currentOrgId = null;
    authUser.canManagePartnerWide = undefined;
  });

  it('offers the choice to a partner-scope token and defaults to all organizations on the All-orgs view', () => {
    render(<Harness />);
    expect(screen.getByTestId('harness').dataset.canChoose).toBe('true');
    expect(screen.getByTestId('harness').dataset.default).toBe('partner');
  });

  it('defaults to the focused organization when one is selected', () => {
    org.currentOrgId = 'org-1';
    render(<Harness />);
    expect(screen.getByTestId('harness').dataset.canChoose).toBe('true');
    expect(screen.getByTestId('harness').dataset.default).toBe('organization');
  });

  it('never offers the choice to an organization-scope token', () => {
    // An org token carries a partnerId but never passes breeze_has_partner_access.
    claims.value = { status: 'resolved', claims: { scope: 'organization', orgId: 'org-1', partnerId: 'p-1' } };
    render(<Harness />);
    expect(screen.getByTestId('harness').dataset.canChoose).toBe('false');
    expect(screen.getByTestId('harness').dataset.default).toBe('organization');
  });

  it('fails closed while the token is still unresolved', () => {
    // Cold load: the access token is not in the store yet. "Unknown" must not
    // read as "partner" (#4010 is exactly that conflation).
    claims.value = { status: 'unresolved' };
    render(<Harness />);
    expect(screen.getByTestId('harness').dataset.canChoose).toBe('false');
    expect(screen.getByTestId('harness').dataset.default).toBe('organization');
  });

  it('reports the chosen scope', async () => {
    const onChange = vi.fn();
    render(<ReportOwnerScopeField value="organization" onChange={onChange} />);
    expect(screen.getByTestId('report-owner-scope-org')).toBeChecked();
    await userEvent.setup().click(screen.getByTestId('report-owner-scope-partner'));
    expect(onChange).toHaveBeenLastCalledWith('partner');
  });

  it('discloses the all-organizations coverage rules and the access requirement', () => {
    render(<ReportOwnerScopeField value="partner" onChange={() => {}} />);
    const hint = screen.getByTestId('report-owner-scope-partner-hint');
    expect(hint).toHaveTextContent(/every active and trial organization/i);
    expect(hint).toHaveTextContent(/listed in the report's notes/i);
    expect(hint).toHaveTextContent(/access to all organizations/i);
  });

  it('renders nothing at all for an organization-scope token', () => {
    claims.value = { status: 'resolved', claims: { scope: 'organization', orgId: 'org-1', partnerId: 'p-1' } };
    const { container } = render(<ReportOwnerScopeField value="organization" onChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the token is unresolved', () => {
    claims.value = { status: 'unresolved' };
    const { container } = render(<ReportOwnerScopeField value="organization" onChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('disables "one organization" and explains why when no organization is focused (#3198 W03)', () => {
    org.currentOrgId = null;
    render(<ReportOwnerScopeField value="partner" onChange={() => {}} />);
    expect(screen.getByTestId('report-owner-scope-org')).toBeDisabled();
    expect(screen.getByTestId('report-owner-scope-org-disabled-hint')).toHaveTextContent(
      /pick an organization in the (organization )?switcher/i
    );
  });

  it('leaves "one organization" enabled, with no disabled hint, once an organization is focused', () => {
    org.currentOrgId = 'org-1';
    render(<ReportOwnerScopeField value="organization" onChange={() => {}} />);
    expect(screen.getByTestId('report-owner-scope-org')).toBeEnabled();
    expect(screen.queryByTestId('report-owner-scope-org-disabled-hint')).toBeNull();
  });

  // Fix round (#3198 W03): partner-owned create requires partnerOrgAccess
  // 'all' (canManagePartnerWidePolicies) — a 'selected' partner user who picked
  // "All organizations" got a guaranteed 403.
  describe('a partner user without partner-wide access (orgAccess "selected")', () => {
    beforeEach(() => {
      authUser.canManagePartnerWide = false;
    });

    it('is never offered the choice and defaults to the organization', () => {
      org.currentOrgId = 'org-1';
      render(<Harness />);
      expect(screen.getByTestId('harness').dataset.canChoose).toBe('false');
      expect(screen.getByTestId('harness').dataset.default).toBe('organization');
      expect(screen.getByTestId('harness').dataset.needsOrg).toBe('false');
    });

    it('needs an organization focused on the All-organizations view', () => {
      org.currentOrgId = null;
      render(<Harness />);
      expect(screen.getByTestId('harness').dataset.canChoose).toBe('false');
      expect(screen.getByTestId('harness').dataset.default).toBe('organization');
      expect(screen.getByTestId('harness').dataset.needsOrg).toBe('true');
    });

    it('renders a pick-an-organization hint instead of the selector when no organization is focused', () => {
      org.currentOrgId = null;
      render(<ReportOwnerScopeField value="organization" onChange={() => {}} />);
      expect(screen.queryByTestId('report-owner-scope-partner')).toBeNull();
      expect(screen.getByTestId('report-owner-scope-needs-org')).toHaveTextContent(
        /pick an organization in the organization switcher/i,
      );
    });

    it('renders nothing once an organization is focused (the report is that organization\'s)', () => {
      org.currentOrgId = 'org-1';
      const { container } = render(<ReportOwnerScopeField value="organization" onChange={() => {}} />);
      expect(container).toBeEmptyDOMElement();
    });
  });

  it('never needs an organization for a user who can choose All organizations', () => {
    authUser.canManagePartnerWide = true;
    render(<Harness />);
    expect(screen.getByTestId('harness').dataset.canChoose).toBe('true');
    expect(screen.getByTestId('harness').dataset.needsOrg).toBe('false');
  });

  it('never needs an organization for an organization-scope token', () => {
    authUser.canManagePartnerWide = false;
    claims.value = { status: 'resolved', claims: { scope: 'organization', orgId: 'org-1', partnerId: 'p-1' } };
    render(<Harness />);
    expect(screen.getByTestId('harness').dataset.needsOrg).toBe('false');
  });
});
