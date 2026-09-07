import '@/lib/i18n';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceQueuedActions from './DeviceQueuedActions';
import { fetchWithAuth } from '@/stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

// runAction calls showToast for the cancel outcome; mock it so we can assert
// feedback surfaces without rendering a real toast.
vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const showToastMock = vi.mocked(showToast);

const deviceId = '11111111-1111-1111-1111-111111111111';

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

function queuedCommand(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cmd-1',
    type: 'reboot',
    createdAt: '2026-09-01T00:00:00.000Z',
    deliverBy: '2026-09-08T00:00:00.000Z',
    createdBy: 'user-1',
    ...overrides,
  };
}

describe('DeviceQueuedActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders one row per pending command with type label, requester, and expiry', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      jsonResponse({ data: [queuedCommand()], pagination: { page: 1, limit: 50, total: 1 } }),
    );

    render(<DeviceQueuedActions deviceId={deviceId} />);

    const section = await screen.findByTestId('device-queued-actions');
    expect(section).toBeTruthy();
    const rows = screen.getAllByTestId('queued-action-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Reboot');
    expect(rows[0].textContent).toMatch(/Requested by user-1/);
    expect(rows[0].textContent).toMatch(/Expires/);

    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      `/devices/${deviceId}/commands?status=pending&limit=50`,
    );
  });

  it('shows "System" as the requester when createdBy is null', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      jsonResponse({ data: [queuedCommand({ createdBy: null })] }),
    );

    render(<DeviceQueuedActions deviceId={deviceId} />);

    const row = await screen.findByTestId('queued-action-row');
    expect(row.textContent).toMatch(/Requested by System/);
  });

  it('is hidden entirely when the list is empty', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(jsonResponse({ data: [] }));

    const { container } = render(<DeviceQueuedActions deviceId={deviceId} />);

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('device-queued-actions')).toBeNull();
  });

  it('swallows a 401 from the list fetch — no rows, no toast (auth redirect owns it)', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, 401));

    const { container } = render(<DeviceQueuedActions deviceId={deviceId} />);

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it('cancel calls the endpoint through runAction and removes the row on success', async () => {
    fetchWithAuthMock.mockImplementation(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/commands/cmd-1/cancel') && method === 'POST') {
        return jsonResponse({ id: 'cmd-1', status: 'cancelled' });
      }
      return jsonResponse({ data: [queuedCommand()] });
    });

    render(<DeviceQueuedActions deviceId={deviceId} />);
    await screen.findByTestId('queued-action-row');

    fireEvent.click(screen.getByTestId('queued-action-cancel'));

    await waitFor(() => expect(screen.queryByTestId('queued-action-row')).toBeNull());
    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      `/devices/${deviceId}/commands/cmd-1/cancel`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success' }),
    );
    // The whole section unmounts once its only row is gone.
    expect(screen.queryByTestId('device-queued-actions')).toBeNull();
  });

  it('reloads the list on a 409 (agent claimed it between load and click) instead of leaving a dead Cancel button', async () => {
    let cancelAttempts = 0;
    fetchWithAuthMock.mockImplementation(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/commands/cmd-1/cancel') && method === 'POST') {
        cancelAttempts += 1;
        return jsonResponse({ error: 'Command is not pending' }, 409);
      }
      // The reload after the 409 finds the command already claimed —
      // the list comes back empty.
      return jsonResponse({ data: cancelAttempts > 0 ? [] : [queuedCommand()] });
    });

    render(<DeviceQueuedActions deviceId={deviceId} />);
    await screen.findByTestId('queued-action-row');

    fireEvent.click(screen.getByTestId('queued-action-cancel'));

    await waitFor(() => expect(screen.queryByTestId('device-queued-actions')).toBeNull());
    // GET list (initial) + POST cancel + GET list (reload after 409).
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(3);
  });
});
