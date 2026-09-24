import '@/lib/i18n';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  handleSessionExpired: vi.fn(),
}));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null; organizations: unknown[] }) => unknown) =>
    selector({ currentOrgId: 'org-1', organizations: [] }),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import ApiKeysPage from './ApiKeysPage';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, statusText: 'X', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const KEY = {
  id: 'key-1',
  name: 'CI deploy key',
  keyPrefix: 'brz_abc',
  scopes: ['devices:read'],
  status: 'active',
  createdAt: '2026-09-01T00:00:00.000Z',
};

type Mutation = { status: number; payload: unknown };

function routeFetch(mutation: Mutation) {
  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.startsWith('/api-keys')) {
      return jsonResponse({ data: [KEY], pagination: { page: 1, limit: 20, total: 1 } });
    }
    return jsonResponse(mutation.payload, mutation.status);
  });
}

const listFetches = () =>
  fetchMock.mock.calls.filter(([url, init]) => String(url).startsWith('/api-keys?') && !init?.method).length;

async function renderPage() {
  render(<ApiKeysPage />);
  await screen.findByText('CI deploy key');
}

beforeEach(() => {
  fetchMock.mockReset();
  toastMock.mockReset();
});

describe('ApiKeysPage destructive confirmations (#3531)', () => {
  it('revoke failure: toasts, keeps the modal open, does not refetch the list', async () => {
    routeFetch({ status: 500, payload: { error: 'Revoke blew up' } });
    await renderPage();
    expect(listFetches()).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke Key' }));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Revoke blew up' })),
    );
    expect(fetchMock).toHaveBeenCalledWith('/api-keys/key-1', expect.objectContaining({ method: 'DELETE' }));
    expect(screen.getByText('Revoke API Key')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke Key' })).not.toBeDisabled();
    expect(listFetches()).toBe(1);
  });

  it('revoke success: refetches and closes the modal', async () => {
    routeFetch({ status: 200, payload: { success: true } });
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke Key' }));

    await waitFor(() => expect(screen.queryByText('Revoke API Key')).toBeNull());
    expect(listFetches()).toBe(2);
    expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('rotate failure (403): toasts, keeps the modal open, does not refetch', async () => {
    routeFetch({ status: 403, payload: { error: 'Not allowed to rotate' } });
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Rotate Key' }));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Not allowed to rotate' })),
    );
    expect(screen.getByText('Rotate API Key')).toBeInTheDocument();
    expect(screen.queryByText('Your API Key')).toBeNull();
    expect(listFetches()).toBe(1);
  });

  it('rotate success: closes the modal and still shows the new key', async () => {
    routeFetch({ status: 200, payload: { key: 'brz_new_secret_value' } });
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Rotate Key' }));

    await screen.findByDisplayValue('brz_new_secret_value');
    expect(screen.queryByText('Rotate API Key')).toBeNull();
    expect(listFetches()).toBe(2);
  });

  it('create failure: toasts, keeps the form open, does not refetch', async () => {
    routeFetch({ status: 500, payload: { error: 'Create blew up' } });
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Create Key' }));
    const form = (await screen.findByPlaceholderText('My API Key')).closest('form')!;
    fireEvent.change(within(form).getByPlaceholderText('My API Key'), { target: { value: 'New key' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Select all' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Create Key' }));

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Create blew up' })),
    );
    expect(screen.getByPlaceholderText('My API Key')).toHaveValue('New key');
    expect(listFetches()).toBe(1);
  });

  it('create success: closes the form and shows the created key', async () => {
    routeFetch({ status: 201, payload: { key: 'brz_created_secret' } });
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Create Key' }));
    const form = (await screen.findByPlaceholderText('My API Key')).closest('form')!;
    fireEvent.change(within(form).getByPlaceholderText('My API Key'), { target: { value: 'New key' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Select all' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Create Key' }));

    await screen.findByDisplayValue('brz_created_secret');
    expect(screen.queryByPlaceholderText('My API Key')).toBeNull();
    const createCall = fetchMock.mock.calls.find(([url, init]) => url === '/api-keys' && init?.method === 'POST');
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({ name: 'New key', orgId: 'org-1' });
    expect(listFetches()).toBe(2);
  });
});
