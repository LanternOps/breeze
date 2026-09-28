import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import SsoProviderForm, { type Role } from './SsoProviderForm';

const ROLES: Role[] = [
  { id: 'org-role', name: 'Org Technician', scope: 'organization' },
  { id: 'partner-role', name: 'Partner Technician', scope: 'partner' },
];

// SR2-10 Fix 1: a built-in system role can never be resolved by SSO JIT
// provisioning (its org_id/partner_id are always NULL), so config time now
// 400s it — the dropdown must not offer it in the first place.
const ROLES_WITH_SYSTEM: Role[] = [
  ...ROLES,
  { id: 'system-org-role', name: 'Built-in Org Admin', scope: 'organization', isSystem: true },
  { id: 'system-partner-role', name: 'Built-in Partner Admin', scope: 'partner', isSystem: true },
];

describe('SsoProviderForm ownership selector', () => {
  it('shows the ownership selector on create for partner-scope users', () => {
    render(<SsoProviderForm showOwnerScope roles={ROLES} />);
    expect(screen.getByTestId('sso-provider-owner')).toBeTruthy();
    expect(screen.getByTestId('sso-provider-owner-org')).toBeTruthy();
    expect(screen.getByTestId('sso-provider-owner-partner')).toBeTruthy();
  });

  it('hides the selector when not partner-scope', () => {
    render(<SsoProviderForm showOwnerScope={false} roles={ROLES} />);
    expect(screen.queryByTestId('sso-provider-owner')).toBeNull();
  });

  it('hides the selector on edit (create-only)', () => {
    render(<SsoProviderForm showOwnerScope isEditing roles={ROLES} />);
    expect(screen.queryByTestId('sso-provider-owner')).toBeNull();
  });

  it('defaults to organization scope and shows org roles', () => {
    render(<SsoProviderForm showOwnerScope roles={ROLES} />);
    const orgRadio = screen.getByTestId('sso-provider-owner-org') as HTMLInputElement;
    expect(orgRadio.checked).toBe(true);
    expect(screen.getByRole('option', { name: 'Org Technician' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Partner Technician' })).toBeNull();
  });

  it('filters the default-role dropdown to partner roles when partner scope is selected', () => {
    render(<SsoProviderForm showOwnerScope roles={ROLES} />);
    fireEvent.click(screen.getByTestId('sso-provider-owner-partner'));
    expect(screen.getByRole('option', { name: 'Partner Technician' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Org Technician' })).toBeNull();
  });

  it('submits ownerScope: "partner" in the payload when the partner radio is selected', async () => {
    const onSubmit = vi.fn();
    render(<SsoProviderForm showOwnerScope roles={ROLES} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText(/Provider name/i), { target: { value: 'Acme Okta' } });
    fireEvent.click(screen.getByTestId('sso-provider-owner-partner'));
    fireEvent.click(screen.getByRole('button', { name: /save provider/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ ownerScope: 'partner' }));
  });

  it('submits ownerScope: "organization" on the default (unchanged) path', async () => {
    const onSubmit = vi.fn();
    render(<SsoProviderForm showOwnerScope roles={ROLES} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText(/Provider name/i), { target: { value: 'Acme Okta' } });
    fireEvent.click(screen.getByRole('button', { name: /save provider/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ ownerScope: 'organization' }));
  });

  // SR2-10 Fix 1: the API now 400s a defaultRoleId that isn't scoped to the
  // provider's own org/partner — a built-in system role never is (its
  // org_id/partner_id are always NULL). Filtering it out of the dropdown means
  // an admin literally cannot select a role guaranteed to fail.
  it('excludes isSystem roles from the org default-role dropdown', () => {
    render(<SsoProviderForm showOwnerScope roles={ROLES_WITH_SYSTEM} />);
    expect(screen.getByRole('option', { name: 'Org Technician' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Built-in Org Admin' })).toBeNull();
  });

  it('excludes isSystem roles from the partner default-role dropdown', () => {
    render(<SsoProviderForm showOwnerScope roles={ROLES_WITH_SYSTEM} />);
    fireEvent.click(screen.getByTestId('sso-provider-owner-partner'));
    expect(screen.getByRole('option', { name: 'Partner Technician' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Built-in Partner Admin' })).toBeNull();
  });
});

// #7252: in the All-organizations (fleet) view there is no org for an
// org-owned provider to belong to — POST /sso/providers with ownerScope
// 'organization' and no org is guaranteed to 400. The form must never default
// to (or allow) that option there.
describe('SsoProviderForm in the All-organizations view (#7252)', () => {
  it('defaults a full-partner admin to partner scope and disables "This organization"', async () => {
    const onSubmit = vi.fn();
    render(
      <SsoProviderForm showOwnerScope noOrgSelected canManagePartnerWide roles={ROLES} onSubmit={onSubmit} />
    );

    const orgRadio = screen.getByTestId('sso-provider-owner-org') as HTMLInputElement;
    const partnerRadio = screen.getByTestId('sso-provider-owner-partner') as HTMLInputElement;
    expect(partnerRadio.checked).toBe(true);
    expect(partnerRadio.disabled).toBe(false);
    expect(orgRadio.checked).toBe(false);
    expect(orgRadio.disabled).toBe(true);
    expect(screen.getByTestId('sso-provider-owner-org-hint')).toBeTruthy();
    // Partner roles are offered because the form starts on the partner axis.
    expect(screen.getByRole('option', { name: 'Partner Technician' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Provider name/i), { target: { value: 'Authentik' } });
    fireEvent.click(screen.getByRole('button', { name: /save provider/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ ownerScope: 'partner' }));
  });

  it('blocks a selected-org partner user (no partner-wide rights) from submitting a request that must fail', async () => {
    const onSubmit = vi.fn();
    render(
      <SsoProviderForm
        showOwnerScope
        noOrgSelected
        canManagePartnerWide={false}
        roles={ROLES}
        onSubmit={onSubmit}
      />
    );

    const orgRadio = screen.getByTestId('sso-provider-owner-org') as HTMLInputElement;
    const partnerRadio = screen.getByTestId('sso-provider-owner-partner') as HTMLInputElement;
    expect(orgRadio.disabled).toBe(true);
    expect(partnerRadio.disabled).toBe(true);
    expect(screen.getByTestId('sso-provider-owner-blocked').textContent).toMatch(/select an organization/i);

    const save = screen.getByRole('button', { name: /save provider/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Provider name/i), { target: { value: 'Authentik' } });
    // A disabled button can't be clicked, but Enter in a field still submits the form.
    fireEvent.submit(save.closest('form')!);
    // Give react-hook-form's async submit a chance to run before asserting the negative.
    await new Promise((r) => setTimeout(r, 50));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('moves off "This organization" if the org selection is cleared while the form is open', async () => {
    const onSubmit = vi.fn();
    const { rerender } = render(
      <SsoProviderForm showOwnerScope canManagePartnerWide roles={ROLES} onSubmit={onSubmit} />
    );
    expect((screen.getByTestId('sso-provider-owner-org') as HTMLInputElement).checked).toBe(true);

    rerender(
      <SsoProviderForm showOwnerScope noOrgSelected canManagePartnerWide roles={ROLES} onSubmit={onSubmit} />
    );
    await waitFor(() =>
      expect((screen.getByTestId('sso-provider-owner-partner') as HTMLInputElement).checked).toBe(true)
    );

    fireEvent.change(screen.getByLabelText(/Provider name/i), { target: { value: 'Authentik' } });
    fireEvent.click(screen.getByRole('button', { name: /save provider/i }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ ownerScope: 'partner' }));
  });

  it('with an org selected, a selected-org partner user keeps "This organization" and cannot pick partner', () => {
    render(<SsoProviderForm showOwnerScope canManagePartnerWide={false} roles={ROLES} />);
    const orgRadio = screen.getByTestId('sso-provider-owner-org') as HTMLInputElement;
    const partnerRadio = screen.getByTestId('sso-provider-owner-partner') as HTMLInputElement;
    expect(orgRadio.checked).toBe(true);
    expect(orgRadio.disabled).toBe(false);
    expect(partnerRadio.disabled).toBe(true);
    expect(screen.queryByTestId('sso-provider-owner-blocked')).toBeNull();
    expect((screen.getByRole('button', { name: /save provider/i }) as HTMLButtonElement).disabled).toBe(false);
  });
});
