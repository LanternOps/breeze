// #5317: `roles.force_mfa` was invisible in Settings → Roles. The list must
// flag it and the create/edit/clone form must expose and submit it.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import RoleManager, { RoleFormModal, type PermissionCatalog, type Role } from './RoleManager';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const catalog: PermissionCatalog = {
  permissions: [{ resource: 'devices', action: 'read' }],
  resourceLabels: { devices: 'Devices' },
  actionLabels: { read: 'Read' }
};

const baseRole: Role = {
  id: 'role-mfa',
  name: 'Partner Admin',
  description: null,
  scope: 'partner',
  isSystem: true,
  forceMfa: true,
  permissions: [],
  userCount: 0,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01'
};

const TOGGLE = { name: 'Require MFA for this role' };

describe('Roles — force MFA (#5317)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockImplementation(async (input) => {
      if (String(input) === '/permissions/catalog') return makeJsonResponse(catalog);
      return makeJsonResponse({});
    });
  });

  it('shows the "MFA required" badge only on roles that force MFA', () => {
    render(
      <RoleManager
        roles={[
          baseRole,
          { ...baseRole, id: 'role-plain', name: 'Technician', isSystem: false, forceMfa: false }
        ]}
      />
    );

    const adminRow = screen.getByText('Partner Admin').closest('tr')!;
    const badge = within(adminRow).getByTestId('role-mfa-required-badge');
    expect(badge).toHaveTextContent('MFA required');
    const techRow = screen.getByText('Technician').closest('tr')!;
    expect(within(techRow).queryByTestId('role-mfa-required-badge')).toBeNull();
  });

  it('create mode: toggle defaults off and submits forceMfa once ticked', async () => {
    const onSubmit = vi.fn();
    render(<RoleFormModal isOpen mode="create" onSubmit={onSubmit} onCancel={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Read' })).toBeTruthy());

    const toggle = screen.getByRole('checkbox', TOGGLE);
    expect(toggle).not.toBeChecked();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Tech' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Role' }));
    expect(onSubmit.mock.calls[0][0].forceMfa).toBe(false);

    fireEvent.click(toggle);
    expect(toggle).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Create Role' }));
    expect(onSubmit.mock.calls[1][0].forceMfa).toBe(true);
  });

  it('edit mode pre-fills the toggle from the role and submits the change', async () => {
    const onSubmit = vi.fn();
    render(
      <RoleFormModal
        isOpen
        mode="edit"
        role={{ ...baseRole, isSystem: false, name: 'Tech' }}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Read' })).toBeTruthy());

    const toggle = screen.getByRole('checkbox', TOGGLE);
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(onSubmit.mock.calls[0][0].forceMfa).toBe(false);
  });

  it('clone mode pre-fills the toggle from the source role', async () => {
    render(<RoleFormModal isOpen mode="clone" role={baseRole} onSubmit={vi.fn()} onCancel={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Read' })).toBeTruthy());

    expect(screen.getByRole('checkbox', TOGGLE)).toBeChecked();
  });

  it('a role payload without forceMfa (older API) renders the toggle off, not crashed', async () => {
    const { forceMfa: _omit, ...legacy } = baseRole;
    render(<RoleFormModal isOpen mode="clone" role={legacy as Role} onSubmit={vi.fn()} onCancel={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Read' })).toBeTruthy());

    expect(screen.getByRole('checkbox', TOGGLE)).not.toBeChecked();
  });
});
