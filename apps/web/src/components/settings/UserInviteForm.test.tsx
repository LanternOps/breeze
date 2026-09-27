import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import UserInviteForm from './UserInviteForm';

// The organization-access picker is shared with the Edit User modal (#7034);
// pin the invite form's contract so the extraction cannot regress it.

const ROLES = [{ id: 'role-tech-uuid', name: 'Partner Technician', scope: 'partner' }];
const ORGS = [
  { id: 'org-a-uuid', name: 'Acme Dental' },
  { id: 'org-b-uuid', name: 'Brightside Law' },
];

function fillIdentity() {
  fireEvent.change(screen.getByLabelText(/^Name$/), { target: { value: 'Tessa' } });
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'tessa@example.com' } });
}

describe('UserInviteForm — organization access', () => {
  it('submits the chosen specific organizations', async () => {
    const onSubmit = vi.fn();
    render(<UserInviteForm roles={ROLES} organizations={ORGS} showOrgAccess onSubmit={onSubmit} />);
    fillIdentity();

    fireEvent.change(screen.getByLabelText(/^Access level$/), { target: { value: 'selected' } });
    fireEvent.focus(screen.getByPlaceholderText(/search organizations/i));
    fireEvent.click(await screen.findByRole('button', { name: 'Brightside Law' }));
    fireEvent.click(screen.getByRole('button', { name: /send invite/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      name: 'Tessa',
      email: 'tessa@example.com',
      roleId: 'role-tech-uuid',
      orgAccess: 'selected',
      orgIds: 'org-b-uuid',
    });
  });

  it("blocks 'Specific organizations' with none chosen", async () => {
    const onSubmit = vi.fn();
    render(<UserInviteForm roles={ROLES} organizations={ORGS} showOrgAccess onSubmit={onSubmit} />);
    fillIdentity();

    fireEvent.change(screen.getByLabelText(/^Access level$/), { target: { value: 'selected' } });
    fireEvent.click(screen.getByRole('button', { name: /send invite/i }));

    expect(await screen.findByText(/at least one organization/i)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("defaults to 'All organizations'", async () => {
    const onSubmit = vi.fn();
    render(<UserInviteForm roles={ROLES} organizations={ORGS} showOrgAccess onSubmit={onSubmit} />);
    fillIdentity();
    fireEvent.click(screen.getByRole('button', { name: /send invite/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ orgAccess: 'all' });
  });
});
