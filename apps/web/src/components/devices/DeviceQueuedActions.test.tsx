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

// A realistic user id — the API never returns a friendly string like
// "user-1" here (device_commands.created_by is a bare uuid FK with no name
// join on this endpoint), so the fixture has to look like the real shape or
// a test could pass while still asserting on a raw, meaningless UUID.
const REQUESTER_ID = '8400e6c1-c39f-4cf1-8d51-e6d6ce6d5f1e';

function queuedCommand(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cmd-1',
    type: 'reboot',
    createdAt: '2026-09-01T00:00:00.000Z',
    deliverBy: '2026-09-08T00:00:00.000Z',
    createdBy: REQUESTER_ID,
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
    // `createdBy` is a bare user id with no name join on this endpoint — the
    // row must NEVER print the raw UUID (meaningless to an operator); it can
    // only say a human (vs. system) requested it.
    expect(rows[0].textContent).toMatch(/Requested by a user/);
    expect(rows[0].textContent).not.toContain(REQUESTER_ID);
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

  // A non-401 failure must NEVER look identical to "nothing queued" — an
  // operator seeing an empty card has no way to tell "checked, empty" apart
  // from "couldn't check" unless the failure renders something.
  it('a non-401 list-fetch failure shows a visible error with Retry, not a silent empty card', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500));

    render(<DeviceQueuedActions deviceId={deviceId} />);

    await screen.findByTestId('device-queued-actions');
    expect(screen.queryByTestId('queued-action-row')).toBeNull();
    expect(screen.getByTestId('queued-actions-retry')).toBeTruthy();
  });

  it('a thrown fetch (network failure) shows the same visible error as an HTTP failure', async () => {
    fetchWithAuthMock.mockRejectedValueOnce(new Error('network down'));

    render(<DeviceQueuedActions deviceId={deviceId} />);

    await screen.findByTestId('device-queued-actions');
    expect(screen.getByTestId('queued-actions-retry')).toBeTruthy();
  });

  it('Retry re-fetches and replaces the error with the real list', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500))
      .mockResolvedValueOnce(jsonResponse({ data: [queuedCommand()] }));

    render(<DeviceQueuedActions deviceId={deviceId} />);
    await screen.findByTestId('queued-actions-retry');

    fireEvent.click(screen.getByTestId('queued-actions-retry'));

    await screen.findByTestId('queued-action-row');
    expect(screen.queryByTestId('queued-actions-retry')).toBeNull();
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
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

  it('a genuine cancel failure (500) leaves the row in place and surfaces an error toast, without reloading', async () => {
    fetchWithAuthMock.mockImplementation(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/commands/cmd-1/cancel') && method === 'POST') {
        return jsonResponse({ error: 'database unavailable' }, 500);
      }
      return jsonResponse({ data: [queuedCommand()] });
    });

    render(<DeviceQueuedActions deviceId={deviceId} />);
    await screen.findByTestId('queued-action-row');

    fireEvent.click(screen.getByTestId('queued-action-cancel'));

    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' }),
    ));
    // The row survives — a 500 is not "already claimed"; the user should be
    // able to retry the same Cancel click.
    expect(screen.getByTestId('queued-action-row')).toBeTruthy();
    const cancelButton = screen.getByTestId('queued-action-cancel') as HTMLButtonElement;
    expect(cancelButton.disabled).toBe(false);
    // Only the initial GET list + the failed POST cancel — no reload, unlike
    // the 409 case below.
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
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
