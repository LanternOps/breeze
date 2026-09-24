import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  handleSessionExpired: vi.fn(),
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import QuarantinedDevices from './QuarantinedDevices';
import { fetchWithAuth } from '@/stores/auth';
import { showToast } from '../shared/Toast';

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, statusText: 'X', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const DEVICE = {
  id: 'dev-1',
  agentId: 'agent-abc',
  hostname: 'ROGUE-LAPTOP',
  osType: 'windows',
  quarantinedAt: '2026-09-01T00:00:00.000Z',
  quarantinedReason: 'unknown_enrollment',
};

function routeFetch(mutation: { status: number; payload: unknown }) {
  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method && String(input) === '/agents/quarantined') {
      return jsonResponse({ devices: [DEVICE] });
    }
    return jsonResponse(mutation.payload, mutation.status);
  });
}

const listFetches = () =>
  fetchMock.mock.calls.filter(([url, init]) => url === '/agents/quarantined' && !init?.method).length;

async function openDenyDialog() {
  render(<QuarantinedDevices />);
  await screen.findByText('ROGUE-LAPTOP');
  fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
  return screen.findByRole('button', { name: 'Deny & Decommission' });
}

beforeEach(() => {
  fetchMock.mockReset();
  toastMock.mockReset();
});

describe('QuarantinedDevices deny confirmation (#3531)', () => {
  it('deny failure: toasts, keeps the modal open, does not refetch the list', async () => {
    routeFetch({ status: 500, payload: { error: 'Deny blew up' } });
    const confirm = await openDenyDialog();
    expect(listFetches()).toBe(1);

    fireEvent.click(confirm);

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Deny blew up' })),
    );
    expect(fetchMock).toHaveBeenCalledWith('/agents/dev-1/deny', expect.objectContaining({ method: 'POST' }));
    expect(screen.getByText('Deny Device')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Deny & Decommission' })).not.toBeDisabled());
    expect(listFetches()).toBe(1);
  });

  it('deny failure (403) toasts the server reason', async () => {
    routeFetch({ status: 403, payload: { error: 'Insufficient permissions' } });
    fireEvent.click(await openDenyDialog());

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: 'Insufficient permissions' }),
      ),
    );
    expect(screen.getByText('Deny Device')).toBeInTheDocument();
    expect(listFetches()).toBe(1);
  });

  it('deny success: closes the modal and refetches', async () => {
    routeFetch({ status: 200, payload: { success: true } });
    fireEvent.click(await openDenyDialog());

    await waitFor(() => expect(screen.queryByText('Deny Device')).toBeNull());
    await waitFor(() => expect(listFetches()).toBe(2));
    expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('approve failure: toasts and does not refetch', async () => {
    routeFetch({ status: 500, payload: { error: 'Approve blew up' } });
    render(<QuarantinedDevices />);
    await screen.findByText('ROGUE-LAPTOP');

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Approve blew up' })),
    );
    expect(listFetches()).toBe(1);
  });
});
