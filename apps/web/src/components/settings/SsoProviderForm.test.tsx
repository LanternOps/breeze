import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SsoProviderForm, { type Role } from './SsoProviderForm';

const ROLES: Role[] = [
  { id: 'org-role', name: 'Org Technician', scope: 'organization' },
  { id: 'partner-role', name: 'Partner Technician', scope: 'partner' },
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
});
