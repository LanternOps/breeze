import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import InstantBootStatus from './InstantBootStatus';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

describe('InstantBootStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the empty state when there are no active instant boots', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ data: [] }));

    render(<InstantBootStatus />);

    await screen.findByText(/No active instant boots/i);
    expect(fetchMock).toHaveBeenCalledWith('/backup/restore/instant-boot/active');
    expect(screen.queryByText(/Complete Migration/i)).toBeNull();
  });

  it('renders read-only instant boot status rows and hides unsupported completion controls', async () => {
    fetchMock.mockResolvedValueOnce(
      makeJsonResponse({
        data: [
          {
            id: 'boot-1',
            vmName: 'Recovered VM',
            status: 'running',
            hostDeviceId: 'device-1',
            hostDeviceName: 'hyperv-01',
            syncProgress: 42,
          },
        ],
      })
    );

    render(<InstantBootStatus />);

    await waitFor(() => expect(screen.getByText('Recovered VM')).toBeTruthy());
    expect(screen.getByText(/Background sync/i)).toBeTruthy();
    expect(screen.getByText(/Migration completion controls remain hidden/i)).toBeTruthy();
    expect(screen.queryByText(/Complete Migration/i)).toBeNull();
  });
});
