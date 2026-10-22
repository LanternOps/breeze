import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

// #8909: deleting an update ring that config policies still link to must warn
// first and list the policies; a ring with no links deletes without a prompt.
const showToast = vi.fn();
vi.mock('../../components/shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

import PatchesPage from './PatchesPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../stores/orgStore', () => {
  const read = () => ({ currentOrgId: null, organizations: [] });
  return { useOrgStore: Object.assign(read, { getState: read }) };
});
vi.mock('../../lib/authScope', () => {
  const claims = () => ({ scope: 'partner', partnerId: 'p1', orgId: null });
  return { getJwtClaims: claims, useJwtClaims: () => ({ status: 'resolved' as const, claims: claims() }) };
});
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: () => true }),
  hasPermission: () => true,
}));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function setup(linked: Array<{ id: string; name: string; orgId: string | null }>) {
  fetchMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = (init as RequestInit | undefined)?.method ?? 'GET';
    if (url === '/update-rings') {
      return json({ data: [{ id: 'ring-1', name: 'Pilot', ringOrder: 1, deferralDays: 0, enabled: true }] });
    }
    if (url === '/update-rings/ring-1/linked-policies') {
      return json({ linkedPolicies: linked, linkedPolicyCount: linked.length });
    }
    if (url === '/update-rings/ring-1' && method === 'DELETE') {
      return json({ success: true, linkedPolicies: linked, linkedPolicyCount: linked.length });
    }
    if (url.startsWith('/patches')) return json({ data: [] });
    return json({}, false, 404);
  });
}

const deleteCalls = () =>
  fetchMock.mock.calls.filter(([u, i]) => String(u) === '/update-rings/ring-1' && (i as RequestInit | undefined)?.method === 'DELETE');

describe('PatchesPage — ring delete warns about linked policies (#8909)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/#rings');
  });

  it('lists linked policies in a confirm dialog and only deletes after confirming', async () => {
    setup([
      { id: 'pol-1', name: 'Workstation patching', orgId: null },
      { id: 'pol-2', name: 'Acme servers', orgId: 'org-1' },
    ]);
    render(<PatchesPage />);

    fireEvent.click(await screen.findByLabelText('Delete Pilot'));

    expect(await screen.findByText('Workstation patching')).toBeInTheDocument();
    expect(screen.getByText('Acme servers')).toBeInTheDocument();
    expect(screen.getByText(/2 policies will stop scheduled patching/i)).toBeInTheDocument();
    expect(deleteCalls()).toHaveLength(0);

    fireEvent.click(screen.getByTestId('confirm-delete-ring'));
    await waitFor(() => expect(deleteCalls()).toHaveLength(1));
  });

  it('cancelling the dialog does not delete', async () => {
    setup([{ id: 'pol-1', name: 'Workstation patching', orgId: null }]);
    render(<PatchesPage />);

    fireEvent.click(await screen.findByLabelText('Delete Pilot'));
    await screen.findByText('Workstation patching');
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(deleteCalls()).toHaveLength(0);
  });

  it('deletes straight away when no policy links the ring', async () => {
    setup([]);
    render(<PatchesPage />);

    fireEvent.click(await screen.findByLabelText('Delete Pilot'));

    await waitFor(() => expect(deleteCalls()).toHaveLength(1));
    expect(screen.queryByTestId('confirm-delete-ring')).not.toBeInTheDocument();
  });

  it('does not delete when the lookup response is malformed (fail closed)', async () => {
    setup([]);
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) =>
      String(input) === '/update-rings/ring-1/linked-policies' ? json({ unexpected: true }) : base(input, init));
    render(<PatchesPage />);

    fireEvent.click(await screen.findByLabelText('Delete Pilot'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(deleteCalls()).toHaveLength(0);
  });

  it('does not delete when the linked-policy lookup fails', async () => {
    setup([]);
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) =>
      String(input) === '/update-rings/ring-1/linked-policies' ? json({}, false, 500) : base(input, init));
    render(<PatchesPage />);

    fireEvent.click(await screen.findByLabelText('Delete Pilot'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(deleteCalls()).toHaveLength(0);
  });
});
