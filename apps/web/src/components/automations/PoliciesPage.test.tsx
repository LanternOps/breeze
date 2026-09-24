import '@/lib/i18n';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return { ...actual, fetchWithAuth: vi.fn(), handleSessionExpired: vi.fn() };
});
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import PoliciesPage from './PoliciesPage';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, statusText: 'X', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const POLICY = {
  id: 'policy-1',
  orgId: 'org-1',
  name: 'Require BitLocker',
  enforcementLevel: 'enforce',
  targetType: 'all',
  rulesCount: 1,
  compliance: { total: 4, compliant: 3, nonCompliant: 1, unknown: 0 },
  enabled: true,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

function routeFetch(mutation: { status: number; payload: unknown }) {
  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method && String(input) === '/policies') {
      return jsonResponse({ data: [POLICY] });
    }
    return jsonResponse(mutation.payload, mutation.status);
  });
}

const listFetches = () =>
  fetchMock.mock.calls.filter(([url, init]) => url === '/policies' && !init?.method).length;

async function openDeleteDialog() {
  render(<PoliciesPage />);
  await screen.findByText('Require BitLocker');
  fireEvent.click(screen.getByTitle('Delete'));
  const heading = await screen.findByRole('heading', { name: 'Delete Policy' });
  const dialog = heading.parentElement as HTMLElement;
  return within(dialog).getByRole('button', { name: 'Delete' });
}

beforeEach(() => {
  fetchMock.mockReset();
  toastMock.mockReset();
});

describe('PoliciesPage delete confirmation (#3531)', () => {
  it('delete failure: toasts, keeps the modal open, does not refetch the list', async () => {
    routeFetch({ status: 500, payload: { error: 'Delete blew up' } });
    const confirm = await openDeleteDialog();
    expect(listFetches()).toBe(1);

    fireEvent.click(confirm);

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Delete blew up' })),
    );
    expect(fetchMock).toHaveBeenCalledWith('/policies/policy-1', expect.objectContaining({ method: 'DELETE' }));
    expect(screen.getByRole('heading', { name: 'Delete Policy' })).toBeInTheDocument();
    expect(listFetches()).toBe(1);
  });

  it('delete failure (403) toasts the server reason and keeps the modal open', async () => {
    routeFetch({ status: 403, payload: { error: 'Insufficient permissions' } });
    fireEvent.click(await openDeleteDialog());

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: 'Insufficient permissions' }),
      ),
    );
    expect(screen.getByRole('heading', { name: 'Delete Policy' })).toBeInTheDocument();
    expect(listFetches()).toBe(1);
  });

  // The API removed PATCH/DELETE /policies/:id in favour of
  // /configuration-policies (routes/policyManagement/crud.ts), so today every
  // delete from this page 404s. It must say so rather than fail silently.
  it('delete against the removed route (404) toasts and keeps the modal open', async () => {
    routeFetch({ status: 404, payload: { error: 'Not Found' } });
    fireEvent.click(await openDeleteDialog());

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })),
    );
    expect(screen.getByRole('heading', { name: 'Delete Policy' })).toBeInTheDocument();
    expect(listFetches()).toBe(1);
  });

  it('toggle failure: toasts and leaves the switch in its previous state', async () => {
    routeFetch({ status: 500, payload: { error: 'Toggle blew up' } });
    render(<PoliciesPage />);
    await screen.findByText('Require BitLocker');
    const toggle = screen.getByRole('checkbox');
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Toggle blew up' })),
    );
    expect(fetchMock).toHaveBeenCalledWith('/policies/policy-1', expect.objectContaining({ method: 'PATCH' }));
    expect(screen.getByRole('checkbox')).toBeChecked();
  });
});
