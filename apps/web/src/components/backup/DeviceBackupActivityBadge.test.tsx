import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceBackupActivityBadge from './DeviceBackupActivityBadge';
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

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

const URL = '/backup/jobs?deviceId=device-1&status=running';

describe('DeviceBackupActivityBadge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders badge when a running job exists', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ data: [{ id: 'job-1', status: 'running' }] }));

    render(<DeviceBackupActivityBadge deviceId="device-1" />);
    await act(async () => {
      await flush();
    });

    expect(fetchMock).toHaveBeenCalledWith(URL);
    const badge = screen.getByTestId('device-backup-running-badge');
    expect(badge.textContent).toContain('Backup running');
    expect(badge.getAttribute('href')).toBe('#backup');
  });

  it('renders nothing on 403', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ error: 'Forbidden' }, false, 403));

    const { container } = render(<DeviceBackupActivityBadge deviceId="device-1" />);
    await act(async () => {
      await flush();
    });

    expect(container.innerHTML).toBe('');
  });

  it('renders nothing on an empty result or a fetch error', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ data: [] }));
    const empty = render(<DeviceBackupActivityBadge deviceId="device-1" />);
    await act(async () => {
      await flush();
    });
    expect(empty.container.innerHTML).toBe('');
    empty.unmount();

    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const failed = render(<DeviceBackupActivityBadge deviceId="device-1" />);
    await act(async () => {
      await flush();
    });
    expect(failed.container.innerHTML).toBe('');
  });

  it('re-polls every 30 s while running and stops once the backup ends', async () => {
    fetchMock
      .mockResolvedValueOnce(makeJsonResponse({ data: [{ id: 'job-1', status: 'running' }] }))
      .mockResolvedValueOnce(makeJsonResponse({ data: [] }));

    render(<DeviceBackupActivityBadge deviceId="device-1" />);
    await act(async () => {
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('device-backup-running-badge')).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('navigates to the Backup tab through a real hashchange, not a bare anchor (#4229)', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ data: [{ id: 'job-1', status: 'running' }] }));
    window.location.hash = '';

    try {
      render(<DeviceBackupActivityBadge deviceId="device-1" />);
      await act(async () => {
        await flush();
      });

      // Astro's ClientRouter pushStates a bare fragment link, which fires no
      // hashchange. Only a handler that sets location.hash itself calls
      // preventDefault, so fireEvent.click returns false for HashLink.
      const notPrevented = fireEvent.click(screen.getByTestId('device-backup-running-badge'));
      expect(notPrevented).toBe(false);
      expect(window.location.hash).toBe('#backup');
    } finally {
      window.location.hash = '';
    }
  });

  it('keeps checking after a transient failure while running, and the badge returns', async () => {
    fetchMock
      .mockResolvedValueOnce(makeJsonResponse({ data: [{ id: 'job-1', status: 'running' }] }))
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce(makeJsonResponse({ data: [{ id: 'job-1', status: 'running' }] }));

    render(<DeviceBackupActivityBadge deviceId="device-1" />);
    await act(async () => {
      await flush();
    });
    expect(screen.getByTestId('device-backup-running-badge')).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await flush();
    });
    expect(screen.queryByTestId('device-backup-running-badge')).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('device-backup-running-badge')).toBeTruthy();
  });

  it('does not poll when the first request fails', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ error: 'Forbidden' }, false, 403));

    render(<DeviceBackupActivityBadge deviceId="device-1" />);
    await act(async () => {
      await flush();
      await vi.advanceTimersByTimeAsync(90_000);
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not poll when nothing is running', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ data: [] }));

    render(<DeviceBackupActivityBadge deviceId="device-1" />);
    await act(async () => {
      await flush();
      await vi.advanceTimersByTimeAsync(90_000);
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
