// #5317: the server copies force_mfa onto a clone; a toggle change in the
// clone modal must ride the existing clone→PATCH step (#822), an unchanged
// toggle must not trigger one, and edit must PATCH the toggle's value.
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import RolesPage from './RolesPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/hooks/useOrgScope', () => {
  const scope = { ready: true, status: 'resolved', scope: 'all', orgId: null, org: null, error: null };
  return { getOrgScope: () => scope, useOrgScope: () => scope };
});

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const TOGGLE = { name: 'Require MFA for this role' };

const systemRole = {
  id: 'src', name: 'Partner Admin', description: 'Full access', scope: 'partner', isSystem: true,
  forceMfa: true, parentRoleId: null, userCount: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01'
};
const customRole = { ...systemRole, id: 'cus', name: 'Technician', isSystem: false, forceMfa: false };

function mockApi() {
  fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
    if (input === '/roles/src/clone') {
      return json({ id: 'clone-1', name: 'Copy', description: null, scope: 'partner', isSystem: false, forceMfa: true, permissions: [] }, true, 201);
    }
    if (init?.method === 'PATCH') return json({ id: 'x' });
    if (input === '/roles/src') return json({ ...systemRole, permissions: [] });
    if (input === '/roles/cus') return json({ ...customRole, permissions: [] });
    if (input === '/roles') return json({ data: [systemRole, customRole] });
    if (input === '/permissions/catalog') return json({ permissions: [], resourceLabels: {}, actionLabels: {} });
    return json({}, false, 404);
  });
}

function patchCallTo(url: string) {
  return fetchMock.mock.calls.find(([u, i]) => u === url && (i as RequestInit | undefined)?.method === 'PATCH');
}

async function waitForListRefresh() {
  await waitFor(() => expect(fetchMock.mock.calls.filter(([u]) => u === '/roles').length).toBeGreaterThan(1));
}

describe('RolesPage — force-MFA toggle wiring (#5317)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi();
  });

  async function cloneSystemRole(flipToggle: boolean) {
    render(<RolesPage />);
    await waitFor(() => expect(screen.getByText('Partner Admin')).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole('button', { name: 'Clone' })[0]);

    fireEvent.change(await screen.findByPlaceholderText('e.g., Technician'), { target: { value: 'Copy' } });
    const toggle = screen.getByRole('checkbox', TOGGLE);
    expect(toggle).toBeChecked();
    if (flipToggle) fireEvent.click(toggle);

    const submit = await waitFor(() => {
      const btn = screen.getByRole('button', { name: 'Clone Role' });
      expect(btn).toBeEnabled();
      return btn;
    });
    fireEvent.click(submit);
    await waitForListRefresh();
  }

  it('clone: PATCHes forceMfa onto the new role when the toggle was changed', async () => {
    await cloneSystemRole(true);
    const patch = patchCallTo('/roles/clone-1');
    expect(patch).toBeTruthy();
    expect(JSON.parse((patch![1] as RequestInit).body as string).forceMfa).toBe(false);
  });

  it('clone: no follow-up PATCH when nothing (including the toggle) changed', async () => {
    await cloneSystemRole(false);
    expect(patchCallTo('/roles/clone-1')).toBeUndefined();
  });

  it('edit: PATCH body carries the toggle value', async () => {
    render(<RolesPage />);
    await waitFor(() => expect(screen.getByText('Technician')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    const toggle = await screen.findByRole('checkbox', TOGGLE);
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    const submit = await waitFor(() => {
      const btn = screen.getByRole('button', { name: 'Save Changes' });
      expect(btn).toBeEnabled();
      return btn;
    });
    fireEvent.click(submit);
    await waitForListRefresh();

    const patch = patchCallTo('/roles/cus');
    expect(patch).toBeTruthy();
    expect(JSON.parse((patch![1] as RequestInit).body as string).forceMfa).toBe(true);
  });

  it('system roles stay view-only: no Edit button, so the toggle is only reachable via Clone', async () => {
    render(<RolesPage />);
    await waitFor(() => expect(screen.getByText('Partner Admin')).toBeInTheDocument());
    // One Edit button — the custom role's. The system row offers Clone only.
    expect(screen.getAllByRole('button', { name: 'Edit' })).toHaveLength(1);
  });
});
