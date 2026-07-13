import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceLinkedProfilesTab from './DeviceLinkedProfilesTab';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError } from '../../lib/runAction';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
}));

vi.mock('../../lib/runAction', () => ({
  runAction: vi.fn(async ({ request }: { request: () => Promise<Response> }) => {
    await request();
  }),
  handleActionError: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const runActionMock = vi.mocked(runAction);

const jsonResponse = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

describe('DeviceLinkedProfilesTab', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the empty state when the device is unlinked', async () => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse({ group: null, members: [] }));
    render(<DeviceLinkedProfilesTab deviceId="dev-1" />);
    await waitFor(() => expect(screen.getByTestId('linked-profiles-empty')).toBeInTheDocument());
  });

  it('renders linked profiles with agent version and last seen', async () => {
    fetchWithAuthMock.mockResolvedValue(
      jsonResponse({
        group: { id: 'g1', name: 'Todd ThinkPad' },
        members: [
          { deviceId: 'dev-1', hostname: 'tp-win', displayName: null, osType: 'windows', osVersion: '11', agentVersion: '1.2.3', status: 'online', lastSeenAt: '2026-06-01T00:00:00.000Z' },
          { deviceId: 'dev-2', hostname: 'tp-lin', displayName: null, osType: 'linux', osVersion: '22.04', agentVersion: '1.2.4', status: 'offline', lastSeenAt: null },
        ],
      }),
    );
    render(<DeviceLinkedProfilesTab deviceId="dev-1" />);

    await waitFor(() => expect(screen.getByTestId('linked-profiles-tab')).toBeInTheDocument());
    expect(screen.getByTestId('linked-profile-dev-1')).toBeInTheDocument();
    expect(screen.getByTestId('linked-profile-dev-2')).toBeInTheDocument();
    expect(screen.getByText('v1.2.3')).toBeInTheDocument();
  });

  it('shows an access-denied state (no Retry) on a 403', async () => {
    fetchWithAuthMock.mockResolvedValue(
      { ok: false, status: 403, json: vi.fn().mockResolvedValue({}) } as unknown as Response,
    );
    render(<DeviceLinkedProfilesTab deviceId="dev-1" />);
    await waitFor(() => expect(screen.getByTestId('linked-profiles-denied')).toBeInTheDocument());
    expect(screen.queryByText('Retry')).not.toBeInTheDocument();
  });

  it('renders every profile as a normal row when more than one is online (no conflict state — designed out)', async () => {
    fetchWithAuthMock.mockResolvedValue(
      jsonResponse({
        group: { id: 'g1', name: null },
        members: [
          { deviceId: 'dev-1', hostname: 'a', displayName: null, osType: 'windows', osVersion: '11', agentVersion: '1', status: 'online', lastSeenAt: null },
          { deviceId: 'dev-2', hostname: 'b', displayName: null, osType: 'linux', osVersion: '22', agentVersion: '1', status: 'online', lastSeenAt: null },
        ],
      }),
    );
    render(<DeviceLinkedProfilesTab deviceId="dev-1" />);
    await waitFor(() => expect(screen.getByTestId('linked-profiles-tab')).toBeInTheDocument());
    expect(screen.getByTestId('linked-profile-dev-1')).toBeInTheDocument();
    expect(screen.getByTestId('linked-profile-dev-2')).toBeInTheDocument();
    expect(screen.queryByTestId('linked-profiles-conflict')).not.toBeInTheDocument();
  });

  it('unlink-this-device PATCHes removeDeviceIds and reloads the panel', async () => {
    const groupPayload = {
      group: { id: 'g1', name: null },
      members: [
        { deviceId: 'dev-1', hostname: 'a', displayName: null, osType: 'windows', osVersion: '11', agentVersion: '1', status: 'online', lastSeenAt: null },
        { deviceId: 'dev-2', hostname: 'b', displayName: null, osType: 'linux', osVersion: '22', agentVersion: '1', status: 'offline', lastSeenAt: null },
      ],
    };
    fetchWithAuthMock
      .mockResolvedValueOnce(jsonResponse(groupPayload)) // initial load
      .mockResolvedValueOnce(jsonResponse({ id: 'g1', dissolved: true, members: [] })) // PATCH
      .mockResolvedValueOnce(jsonResponse({ group: null, members: [] })); // reload

    render(<DeviceLinkedProfilesTab deviceId="dev-1" />);
    await waitFor(() => expect(screen.getByTestId('linked-profiles-tab')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('linked-profiles-unlink-self'));

    await waitFor(() => expect(screen.getByTestId('linked-profiles-empty')).toBeInTheDocument());
    const patchCall = fetchWithAuthMock.mock.calls[1]!;
    expect(patchCall[0]).toBe('/devices/link-groups/g1');
    expect(patchCall[1]).toMatchObject({ method: 'PATCH' });
    expect(JSON.parse((patchCall[1] as RequestInit).body as string)).toEqual({ removeDeviceIds: ['dev-1'] });
  });

  describe('remove-link confirmation (#2429)', () => {
    const groupPayload = {
      group: { id: 'g1', name: null },
      members: [
        { deviceId: 'dev-1', hostname: 'a', displayName: null, osType: 'windows', osVersion: '11', agentVersion: '1', status: 'online', lastSeenAt: null },
        { deviceId: 'dev-2', hostname: 'b', displayName: null, osType: 'linux', osVersion: '22', agentVersion: '1', status: 'offline', lastSeenAt: null },
      ],
    };

    it('does NOT dissolve the group on the first click — it asks first', async () => {
      fetchWithAuthMock.mockResolvedValue(jsonResponse(groupPayload));

      render(<DeviceLinkedProfilesTab deviceId="dev-1" />);
      await waitFor(() => expect(screen.getByTestId('linked-profiles-tab')).toBeInTheDocument());
      expect(fetchWithAuthMock).toHaveBeenCalledTimes(1); // initial load only

      fireEvent.click(screen.getByTestId('linked-profiles-dissolve'));

      // The confirm step is up and nothing has been destroyed yet.
      await waitFor(() =>
        expect(screen.getByTestId('linked-profiles-dissolve-confirm')).toBeInTheDocument(),
      );
      expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
      expect(fetchWithAuthMock).not.toHaveBeenCalledWith(
        '/devices/link-groups/g1',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('closes the dialog on a FAILED dissolve so the error toast is not hidden behind it', async () => {
      // The Toast island and the Dialog portal are both z-50 and the portal is
      // appended later, so a modal left open paints over the only failure signal
      // runAction gives the user. Leaving it open turns a failed destructive
      // action into a silent no-op.
      fetchWithAuthMock.mockResolvedValueOnce(jsonResponse(groupPayload)); // initial load
      runActionMock.mockRejectedValueOnce(new Error('boom')); // DELETE fails

      render(<DeviceLinkedProfilesTab deviceId="dev-1" />);
      await waitFor(() => expect(screen.getByTestId('linked-profiles-tab')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('linked-profiles-dissolve'));
      fireEvent.click(await screen.findByTestId('linked-profiles-dissolve-confirm'));

      // Dialog is gone (toast is visible), the failure was handled, and the
      // group was NOT optimistically removed from the UI.
      await waitFor(() =>
        expect(screen.queryByTestId('linked-profiles-dissolve-confirm')).not.toBeInTheDocument(),
      );
      expect(handleActionError).toHaveBeenCalled();
      expect(screen.getByTestId('linked-profiles-tab')).toBeInTheDocument();
    });

    it('DELETEs the group and reloads the panel once confirmed', async () => {
      fetchWithAuthMock
        .mockResolvedValueOnce(jsonResponse(groupPayload)) // initial load
        .mockResolvedValueOnce(jsonResponse({ success: true })) // DELETE
        .mockResolvedValueOnce(jsonResponse({ group: null, members: [] })); // reload

      render(<DeviceLinkedProfilesTab deviceId="dev-1" />);
      await waitFor(() => expect(screen.getByTestId('linked-profiles-tab')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('linked-profiles-dissolve'));
      fireEvent.click(await screen.findByTestId('linked-profiles-dissolve-confirm'));

      await waitFor(() => expect(screen.getByTestId('linked-profiles-empty')).toBeInTheDocument());
      const deleteCall = fetchWithAuthMock.mock.calls[1]!;
      expect(deleteCall[0]).toBe('/devices/link-groups/g1');
      expect(deleteCall[1]).toMatchObject({ method: 'DELETE' });
    });
  });

  describe('vm_host groups (#2308)', () => {
    const vmPayload = {
      group: { id: 'g-vm', kind: 'vm_host', name: null },
      members: [
        { deviceId: 'dev-vm1', hostname: 'vm-web', displayName: null, osType: 'linux', osVersion: '22', agentVersion: '1', status: 'online', lastSeenAt: null, role: 'guest' },
        { deviceId: 'dev-host', hostname: 'hv-01', displayName: null, osType: 'windows', osVersion: '2022', agentVersion: '1', status: 'online', lastSeenAt: null, role: 'host' },
      ],
    };

    it('shows the vm_host heading, guest count, and a Role column with the host sorted first', async () => {
      fetchWithAuthMock.mockResolvedValue(jsonResponse(vmPayload));
      render(<DeviceLinkedProfilesTab deviceId="dev-vm1" />);
      await waitFor(() => expect(screen.getByTestId('linked-profiles-tab')).toBeInTheDocument());

      expect(screen.getByText('VM host + guests')).toBeInTheDocument();
      expect(screen.getByText('1 guests')).toBeInTheDocument();
      expect(screen.getByTestId('linked-profile-dev-host-role')).toHaveTextContent('Host');
      expect(screen.getByTestId('linked-profile-dev-vm1-role')).toHaveTextContent('Guest');
      // Host row sorted above the guest despite arriving second from the API.
      const rows = screen.getAllByTestId(/^linked-profile-dev-(host|vm1)$/);
      expect(rows[0]!.getAttribute('data-testid')).toBe('linked-profile-dev-host');
    });

    it('renders no Role column for multiboot groups', async () => {
      fetchWithAuthMock.mockResolvedValue(
        jsonResponse({
          group: { id: 'g1', kind: 'multiboot', name: null },
          members: [
            { deviceId: 'dev-1', hostname: 'a', displayName: null, osType: 'windows', osVersion: '11', agentVersion: '1', status: 'online', lastSeenAt: null, role: null },
            { deviceId: 'dev-2', hostname: 'b', displayName: null, osType: 'linux', osVersion: '22', agentVersion: '1', status: 'offline', lastSeenAt: null, role: null },
          ],
        }),
      );
      render(<DeviceLinkedProfilesTab deviceId="dev-1" />);
      await waitFor(() => expect(screen.getByTestId('linked-profiles-tab')).toBeInTheDocument());

      expect(screen.queryByText('Role')).not.toBeInTheDocument();
      expect(screen.queryByTestId('linked-profile-dev-1-role')).not.toBeInTheDocument();
      expect(screen.getByText('2 profiles')).toBeInTheDocument();
    });

    it('warns on the unlink button when the current device is the host', async () => {
      fetchWithAuthMock.mockResolvedValue(jsonResponse(vmPayload));
      render(<DeviceLinkedProfilesTab deviceId="dev-host" />);
      await waitFor(() => expect(screen.getByTestId('linked-profiles-tab')).toBeInTheDocument());

      const unlink = screen.getByTestId('linked-profiles-unlink-self');
      expect(unlink.getAttribute('title')).toContain('host');
    });
  });
});
