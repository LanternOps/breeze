import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceTicketsTab from './DeviceTicketsTab';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../stores/auth')>()),
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));

describe('DeviceTicketsTab', () => {
  beforeEach(() => {
    fetchWithAuth.mockReset();
    fetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
  });

  // #11644: the tab is pinned to one device, so its request must carry the
  // device's own org — not the org switcher's ambient org, which would AND to
  // zero rows for a device in a different org.
  it('pins the tickets request to the device org, not the ambient switcher org', async () => {
    render(<DeviceTicketsTab deviceId="dev-1" orgId="org-device" />);
    await waitFor(() => expect(screen.getByTestId('device-tickets-empty')).toBeInTheDocument());

    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    const [url, options] = fetchWithAuth.mock.calls[0];
    expect(url).toBe('/tickets?deviceId=dev-1&limit=50&sort=newest');
    expect(options).toMatchObject({ orgIdOverride: 'org-device' });
  });

  it('does not pin an org when the device org is unknown', async () => {
    render(<DeviceTicketsTab deviceId="dev-1" />);
    await waitFor(() => expect(screen.getByTestId('device-tickets-empty')).toBeInTheDocument());
    const [, options] = fetchWithAuth.mock.calls[0];
    expect(options?.orgIdOverride).toBeUndefined();
  });
});
