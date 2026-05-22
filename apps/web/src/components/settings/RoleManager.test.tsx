import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import RoleManager, { PermissionMatrix, RoleFormModal, type PermissionCatalog, type Permission, type Role } from './RoleManager';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const navigateToMock = vi.fn();
vi.mock('@/lib/navigation', () => ({
  navigateTo: (...args: unknown[]) => navigateToMock(...args)
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

// A small, representative catalog matching the shape of what the API returns.
// Includes the asymmetric edge cases that issue #801 exposed:
//   - `alerts` has `acknowledge` (unique to that resource)
//   - `remote` has only `access` (single-cell row)
//   - actions vary across resources (sparse matrix)
const sampleCatalog: PermissionCatalog = {
  permissions: [
    { resource: 'devices', action: 'read' },
    { resource: 'devices', action: 'write' },
    { resource: 'devices', action: 'execute' },
    { resource: 'alerts', action: 'read' },
    { resource: 'alerts', action: 'acknowledge' },
    { resource: 'remote', action: 'access' }
  ],
  resourceLabels: {
    devices: 'Devices',
    alerts: 'Alerts',
    remote: 'Remote Access'
  },
  actionLabels: {
    read: 'Read',
    write: 'Write',
    execute: 'Execute',
    acknowledge: 'Acknowledge',
    access: 'Access'
  }
};

describe('RoleManager — catalog-driven matrix (issue #801)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/permissions/catalog') {
        return makeJsonResponse(sampleCatalog);
      }
      return makeJsonResponse({ permissions: [] });
    });
  });

  it('fetches the catalog on mount', async () => {
    render(<RoleManager roles={[]} />);
    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith('/permissions/catalog');
    });
  });
});

describe('RoleManager — catalog fetch failure handling (Todd review on #802)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigateToMock.mockReset();
  });

  it('Create modal shows an inline error + Retry button when catalog fetch returns 500', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      if (String(input) === '/permissions/catalog') {
        return makeJsonResponse({}, false, 500);
      }
      return makeJsonResponse({});
    });

    render(<RoleFormModal isOpen mode="create" onSubmit={() => {}} onCancel={() => {}} />);

    // Wait for the error UI instead of the spinner.
    await screen.findByText((t) => t.startsWith('Failed to load permissions'));
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();

    // Spinner row must be gone.
    expect(screen.queryByText('Loading permissions...')).toBeNull();
  });

  it('Create button is disabled while the catalog has not loaded (protects against silent zero-permission role creation)', async () => {
    // Never resolve the catalog fetch so the matrix stays in the loading state.
    fetchWithAuthMock.mockImplementation(async (input) => {
      if (String(input) === '/permissions/catalog') {
        return new Promise<Response>(() => {});
      }
      return makeJsonResponse({});
    });

    render(<RoleFormModal isOpen mode="create" onSubmit={() => {}} onCancel={() => {}} />);

    // Type a name so the !name.trim() condition is not the one disabling submit.
    const nameInput = await screen.findByLabelText('Name');
    fireEvent.change(nameInput, { target: { value: 'Tech' } });

    const submitButton = screen.getByRole('button', { name: 'Create Role' }) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);
  });

  it('Retry re-fetches the catalog and renders the matrix on the second attempt', async () => {
    let attempt = 0;
    fetchWithAuthMock.mockImplementation(async (input) => {
      if (String(input) === '/permissions/catalog') {
        attempt += 1;
        if (attempt === 1) return makeJsonResponse({}, false, 503);
        return makeJsonResponse(sampleCatalog);
      }
      return makeJsonResponse({});
    });

    render(<RoleFormModal isOpen mode="create" onSubmit={() => {}} onCancel={() => {}} />);

    const retry = await screen.findByRole('button', { name: 'Retry' });
    fireEvent.click(retry);

    // After retry, the matrix headers must render.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Read' })).toBeTruthy();
    });
    expect(attempt).toBe(2);
  });

  it('on 401 the modal redirects to /login and does NOT set the error state', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      if (String(input) === '/permissions/catalog') {
        return makeJsonResponse({}, false, 401);
      }
      return makeJsonResponse({});
    });

    render(<RoleFormModal isOpen mode="create" onSubmit={() => {}} onCancel={() => {}} />);

    await waitFor(() => {
      expect(navigateToMock).toHaveBeenCalledWith('/login', { replace: true });
    });

    // Error UI should NOT be shown when we're redirecting.
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('expansion row in the table shows the error UI when catalog fetch fails', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/permissions/catalog') {
        return makeJsonResponse({}, false, 500);
      }
      if (url.startsWith('/roles/')) {
        return makeJsonResponse({ permissions: [{ resource: 'devices', action: 'read' }] });
      }
      return makeJsonResponse({});
    });

    const systemRole: Role = {
      id: 'sys-1',
      name: 'Administrator',
      description: null,
      scope: 'system',
      isSystem: true,
      userCount: 1,
      createdAt: '2026-05-21T00:00:00Z',
      updatedAt: '2026-05-21T00:00:00Z'
    };

    render(<RoleManager roles={[systemRole]} />);

    // Wait for the catalog fetch failure to register.
    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith('/permissions/catalog');
    });

    // Click the system role row to expand it.
    const adminRow = screen.getByText('Administrator').closest('tr');
    expect(adminRow).toBeTruthy();
    fireEvent.click(adminRow!);

    await screen.findByText((t) => t.startsWith('Failed to load permissions'));
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});

describe('PermissionMatrix — renders sparsely from catalog', () => {
  it('renders only catalog actions in the header (no view/create/update)', () => {
    render(
      <PermissionMatrix
        catalog={sampleCatalog}
        permissions={[]}
        onChange={() => {}}
      />
    );

    // Header should NOT show the legacy UI verbs.
    expect(screen.queryByRole('button', { name: 'View' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull();

    // Header SHOULD show the catalog's actions.
    expect(screen.getByRole('button', { name: 'Read' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Access' })).toBeTruthy();
  });

  it('does not render checkboxes for (resource, action) pairs that are not in the catalog', () => {
    const { container } = render(
      <PermissionMatrix
        catalog={sampleCatalog}
        permissions={[]}
        onChange={() => {}}
      />
    );

    // Catalog has 6 permissions; only 6 cells should have a checkbox.
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes.length).toBe(6);
  });

  it('toggling a catalog cell calls onChange with the catalog-valid pair', () => {
    const onChange = vi.fn();
    render(
      <PermissionMatrix
        catalog={sampleCatalog}
        permissions={[]}
        onChange={onChange}
      />
    );

    // Find the row for "Remote Access" — its only action is "Access".
    const rows = screen.getAllByRole('row');
    const remoteRow = rows.find((r) => within(r).queryByRole('button', { name: 'Remote Access' }));
    expect(remoteRow).toBeTruthy();

    const checkbox = within(remoteRow!).getByRole('checkbox');
    fireEvent.click(checkbox);

    expect(onChange).toHaveBeenCalledTimes(1);
    const calledWith = onChange.mock.calls[0][0] as Permission[];
    expect(calledWith).toEqual([{ resource: 'remote', action: 'access' }]);
  });

  it('toggleRow only emits catalog-supported actions for that resource', () => {
    const onChange = vi.fn();
    render(
      <PermissionMatrix
        catalog={sampleCatalog}
        permissions={[]}
        onChange={onChange}
      />
    );

    // Click the "Alerts" row toggle.
    const alertsButton = screen.getByRole('button', { name: 'Alerts' });
    fireEvent.click(alertsButton);

    expect(onChange).toHaveBeenCalledTimes(1);
    const emitted = onChange.mock.calls[0][0] as Permission[];
    // alerts has read + acknowledge in the catalog. Nothing else.
    const keys = emitted.map((p) => `${p.resource}:${p.action}`).sort();
    expect(keys).toEqual(['alerts:acknowledge', 'alerts:read']);
  });
});

describe('RoleFormModal — submits catalog-valid pairs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/permissions/catalog') {
        return makeJsonResponse(sampleCatalog);
      }
      return makeJsonResponse({});
    });
  });

  it('renders the matrix from the fetched catalog and submits only catalog pairs', async () => {
    const onSubmit = vi.fn();

    render(
      <RoleFormModal
        isOpen
        mode="create"
        onSubmit={onSubmit}
        onCancel={() => {}}
      />
    );

    // Wait for catalog fetch and matrix render.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Read' })).toBeTruthy();
    });

    // Tick the (devices, write) cell.
    const rows = screen.getAllByRole('row');
    const devicesRow = rows.find((r) => within(r).queryByRole('button', { name: 'Devices' }));
    expect(devicesRow).toBeTruthy();
    const checkboxes = within(devicesRow!).getAllByRole('checkbox');
    // devices supports read, write, execute → 3 checkboxes. Pick the middle (write).
    expect(checkboxes.length).toBe(3);
    fireEvent.click(checkboxes[1]);

    // Fill name and submit.
    const nameInput = screen.getByLabelText('Name');
    fireEvent.change(nameInput, { target: { value: 'Test Role' } });

    const submitButton = screen.getByRole('button', { name: 'Create Role' });
    fireEvent.click(submitButton);

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const submitted = onSubmit.mock.calls[0][0] as { permissions: Permission[] };
    expect(submitted.permissions).toEqual([{ resource: 'devices', action: 'write' }]);
  });

  // Regression: previously the Edit modal opened with name="" description=""
  // and every permission unchecked because the reset hook used useState(() => {})
  // instead of useEffect. The initializer ran once on first mount (when role
  // was null) and never re-ran when role was later populated, so the form was
  // always blank. The fix in this commit re-runs the reset on [isOpen, role, mode].
  it('Edit mode loads the existing role: name, description, and matching cells are populated', async () => {
    const existingRole: Role = {
      id: 'role-test-1',
      name: 'Test',
      description: 'A test role with two permissions',
      scope: 'organization',
      isSystem: false,
      permissions: [
        { resource: 'devices', action: 'read' },
        { resource: 'alerts', action: 'acknowledge' }
      ],
      userCount: 0,
      createdAt: '2026-05-21T00:00:00Z',
      updatedAt: '2026-05-21T00:00:00Z'
    };

    // Mount with isOpen=false first so the modal hooks see role=null on initial
    // mount, then flip to isOpen=true. This reproduces the real RolesPage flow,
    // where the modal lives in the tree before the user clicks Edit.
    const { rerender } = render(
      <RoleFormModal
        isOpen={false}
        mode="edit"
        role={null}
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    );

    rerender(
      <RoleFormModal
        isOpen
        mode="edit"
        role={existingRole}
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    );

    // Name and description must be populated from the role.
    const nameInput = (await screen.findByLabelText('Name')) as HTMLInputElement;
    const descriptionInput = screen.getByLabelText('Description') as HTMLInputElement;
    expect(nameInput.value).toBe('Test');
    expect(descriptionInput.value).toBe('A test role with two permissions');

    // Wait for catalog fetch + matrix render.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Read' })).toBeTruthy();
    });

    // Exactly two checkboxes in the matrix should be checked: (devices,read)
    // and (alerts,acknowledge). The matrix renders 6 cells total per the
    // sample catalog.
    const rows = screen.getAllByRole('row');
    const devicesRow = rows.find((r) => within(r).queryByRole('button', { name: 'Devices' }));
    const alertsRow = rows.find((r) => within(r).queryByRole('button', { name: 'Alerts' }));
    expect(devicesRow).toBeTruthy();
    expect(alertsRow).toBeTruthy();

    // devices row: read should be checked, write + execute unchecked.
    const devicesBoxes = within(devicesRow!).getAllByRole('checkbox') as HTMLInputElement[];
    expect(devicesBoxes.length).toBe(3);
    expect(devicesBoxes[0].checked).toBe(true); // read
    expect(devicesBoxes[1].checked).toBe(false); // write
    expect(devicesBoxes[2].checked).toBe(false); // execute

    // alerts row: read unchecked, acknowledge checked.
    const alertsBoxes = within(alertsRow!).getAllByRole('checkbox') as HTMLInputElement[];
    expect(alertsBoxes.length).toBe(2);
    expect(alertsBoxes[0].checked).toBe(false); // read
    expect(alertsBoxes[1].checked).toBe(true); // acknowledge
  });

  // Belt-and-suspenders: also exercise the "open Edit for role A, close, then
  // open Edit for role B" flow. With the old useState() initializer the
  // second open would keep role A's state. With useEffect on [isOpen, role,
  // mode] each open re-populates from the new role.
  it('Edit mode repopulates when reopened for a different role', async () => {
    const roleA: Role = {
      id: 'role-a',
      name: 'Role A',
      description: 'A',
      scope: 'organization',
      isSystem: false,
      permissions: [{ resource: 'devices', action: 'read' }],
      userCount: 0,
      createdAt: '2026-05-21T00:00:00Z',
      updatedAt: '2026-05-21T00:00:00Z'
    };
    const roleB: Role = {
      id: 'role-b',
      name: 'Role B',
      description: 'B',
      scope: 'organization',
      isSystem: false,
      permissions: [{ resource: 'remote', action: 'access' }],
      userCount: 0,
      createdAt: '2026-05-21T00:00:00Z',
      updatedAt: '2026-05-21T00:00:00Z'
    };

    const { rerender } = render(
      <RoleFormModal isOpen={false} mode="edit" role={null} onSubmit={() => {}} onCancel={() => {}} />
    );

    rerender(<RoleFormModal isOpen mode="edit" role={roleA} onSubmit={() => {}} onCancel={() => {}} />);
    await waitFor(() => {
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Role A');
    });

    // Close, then open again for role B.
    rerender(<RoleFormModal isOpen={false} mode="edit" role={null} onSubmit={() => {}} onCancel={() => {}} />);
    rerender(<RoleFormModal isOpen mode="edit" role={roleB} onSubmit={() => {}} onCancel={() => {}} />);

    await waitFor(() => {
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Role B');
    });
    expect((screen.getByLabelText('Description') as HTMLInputElement).value).toBe('B');
  });
});
