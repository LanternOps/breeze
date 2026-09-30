import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import '@/lib/i18n';
vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
import { fetchWithAuth } from '@/stores/auth';
import { navigateTo } from '@/lib/navigation';
import { showToast } from '../../shared/Toast';
import TimeSyncActions from './TimeSyncActions';
const targets = [
  { deviceId: 'a', name: 'Device A' },
  { deviceId: 'b', name: 'Device B' },
];
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
beforeEach(() => {
  vi.clearAllMocks();
});
it('queues resync and apply through the single-device command route', async () => {
  vi.mocked(fetchWithAuth).mockImplementation(async () =>
    response({ command: { id: 'cmd', delivery: 'delivered' } }, 201),
  );
  render(<TimeSyncActions targets={[targets[0]!]} />);
  fireEvent.click(screen.getByTestId('time-sync-resync'));
  await waitFor(() =>
    expect(screen.getByTestId('time-sync-outcome-a').textContent).toContain(
      'Delivered — awaiting execution',
    ),
  );
  expect(fetchWithAuth).toHaveBeenLastCalledWith(
    '/devices/a/commands',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ type: 'time_resync', payload: {} }),
    }),
  );
  fireEvent.click(screen.getByTestId('time-sync-apply-policy'));
  await waitFor(() =>
    expect(fetchWithAuth).toHaveBeenLastCalledWith(
      '/devices/a/commands',
      expect.objectContaining({
        body: JSON.stringify({ type: 'time_apply_policy', payload: {} }),
      }),
    ),
  );
});
it('resolves a separate expected zone for each selected device and keeps partial failures', async () => {
  vi.mocked(fetchWithAuth).mockImplementation(async (url, options) => {
    if (!options?.method)
      return response({
        timezone: {
          expected: {
            windowsId: url.includes('/a/') ? 'UTC' : 'Eastern Standard Time',
          },
        },
      });
    return url.includes('/a/')
      ? response({ command: { id: 'cmd', delivery: 'queued_offline' } }, 201)
      : response({ error: 'Denied' }, 403);
  });
  render(<TimeSyncActions targets={targets} bulk />);
  fireEvent.click(screen.getByTestId('time-sync-select-a'));
  fireEvent.click(screen.getByTestId('time-sync-select-b'));
  fireEvent.click(screen.getByTestId('time-sync-set-timezone'));
  await waitFor(() =>
    expect(screen.getByTestId('time-sync-outcome-b').textContent).toContain(
      'Denied',
    ),
  );
  expect(screen.getByTestId('time-sync-outcome-a').textContent).toContain(
    'expires after 1 hour',
  );
  const posts = vi
    .mocked(fetchWithAuth)
    .mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(
    posts.map(([url, init]) => [url, JSON.parse(String(init!.body))]),
  ).toEqual([
    [
      '/devices/a/commands',
      { type: 'time_set_timezone', payload: { windowsId: 'UTC' } },
    ],
    [
      '/devices/b/commands',
      {
        type: 'time_set_timezone',
        payload: { windowsId: 'Eastern Standard Time' },
      },
    ],
  ]);
});
it('shows a skipped row when the server has no expected zone', async () => {
  vi.mocked(fetchWithAuth).mockImplementation(async () =>
    response({ timezone: { expected: null } }),
  );
  render(<TimeSyncActions targets={[targets[0]!]} />);
  fireEvent.click(screen.getByTestId('time-sync-set-timezone'));
  await waitFor(() =>
    expect(screen.getByTestId('time-sync-outcome-a').textContent).toContain(
      'Skipped — no expected timezone',
    ),
  );
  expect(fetchWithAuth).toHaveBeenCalledTimes(1);
});
it('surfaces an HTTP-200 failed body without calling it queued', async () => {
  vi.mocked(fetchWithAuth).mockImplementation(async () =>
    response({ success: false, error: 'Rejected' }),
  );
  render(<TimeSyncActions targets={[targets[0]!]} />);
  fireEvent.click(screen.getByTestId('time-sync-resync'));
  await waitFor(() =>
    expect(screen.getByTestId('time-sync-outcome-a').textContent).toContain(
      'Rejected',
    ),
  );
  expect(showToast).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'error' }),
  );
  expect(showToast).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: 'success' }),
  );
});
it('redirects on 401 and stops sending commands', async () => {
  vi.mocked(fetchWithAuth).mockImplementation(async () => response({}, 401));
  render(<TimeSyncActions targets={targets} bulk />);
  fireEvent.click(screen.getByTestId('time-sync-select-a'));
  fireEvent.click(screen.getByTestId('time-sync-select-b'));
  fireEvent.click(screen.getByTestId('time-sync-resync'));
  await waitFor(() =>
    expect(navigateTo).toHaveBeenCalledWith('/login', { replace: true }),
  );
  expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  expect(showToast).not.toHaveBeenCalled();
});
