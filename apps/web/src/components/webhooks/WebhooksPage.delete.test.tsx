import '@/lib/i18n';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return { ...actual, fetchWithAuth: vi.fn(), handleSessionExpired: vi.fn() };
});
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import WebhooksPage from './WebhooksPage';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, statusText: 'X', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const WEBHOOK = {
  id: 'wh-1',
  orgId: 'org-1',
  name: 'Alert relay',
  url: 'https://hooks.example.com/alerts',
  events: ['alert.created'],
  status: 'active',
  hasSecret: true,
};

function routeFetch(mutation: { status: number; payload: unknown }) {
  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!init?.method && url === '/webhooks') return jsonResponse({ data: [WEBHOOK] });
    if (!init?.method && url.endsWith('/deliveries')) return jsonResponse({ data: [] });
    return jsonResponse(mutation.payload, mutation.status);
  });
}

const listFetches = () =>
  fetchMock.mock.calls.filter(([url, init]) => url === '/webhooks' && !init?.method).length;

async function openDeleteDialog() {
  render(<WebhooksPage />);
  await screen.findAllByText('Alert relay');
  fireEvent.click(screen.getByTitle('Delete webhook'));
  const heading = await screen.findByRole('heading', { name: 'Delete Webhook' });
  return within(heading.parentElement as HTMLElement).getByRole('button', { name: 'Delete' });
}

beforeEach(() => {
  fetchMock.mockReset();
  toastMock.mockReset();
});

describe('WebhooksPage delete confirmation (#3531)', () => {
  it('delete failure: toasts, keeps the modal open, does not refetch the list', async () => {
    routeFetch({ status: 500, payload: { error: 'Delete blew up' } });
    const confirm = await openDeleteDialog();
    expect(listFetches()).toBe(1);

    fireEvent.click(confirm);

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Delete blew up' })),
    );
    expect(fetchMock).toHaveBeenCalledWith('/webhooks/wh-1', expect.objectContaining({ method: 'DELETE' }));
    expect(screen.getByRole('heading', { name: 'Delete Webhook' })).toBeInTheDocument();
    expect(listFetches()).toBe(1);
  });

  it('delete success: refetches and closes the modal', async () => {
    routeFetch({ status: 200, payload: { success: true } });
    fireEvent.click(await openDeleteDialog());

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Delete Webhook' })).toBeNull());
    expect(listFetches()).toBe(2);
    expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });
});
