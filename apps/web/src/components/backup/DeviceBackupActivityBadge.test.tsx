import { act, render, screen } from '@testing-library/react';
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
