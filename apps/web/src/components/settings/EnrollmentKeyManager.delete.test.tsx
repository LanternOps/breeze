// Uses the REAL runAction (the sibling EnrollmentKeyManager.test.tsx mocks it as
// a pass-through, which cannot exercise the failure toast). #3531.
import '@/lib/i18n';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), handleSessionExpired: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../stores/orgStore', () => {
  const state: Record<string, unknown> = {
    currentOrgId: 'org-1',
    currentSiteId: null,
    sites: [],
    organizations: [],
    isLoading: false,
  };
  const useOrgStore = Object.assign(() => state, { getState: () => state });
  return { useOrgStore };
});

import EnrollmentKeyManager from './EnrollmentKeyManager';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);

const jsonRes = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

const ROW = {
  id: 'k-1',
  orgId: 'org-1',
  siteId: null,
  name: 'Prod key',
  shortCode: 'ABC123XYZ0',
  usageCount: 0,
  maxUsage: null,
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  createdBy: null,
  createdAt: new Date().toISOString(),
};

function routeFetch(del: { status: number; payload: unknown }) {
  fetchMock.mockImplementation(async (rawUrl: string | URL | Request, init?: RequestInit) => {
    const url = String(rawUrl);
    if (url.startsWith('/enrollment-keys?')) {
      return jsonRes({ data: [ROW], pagination: { page: 1, limit: 50, total: 1 } });
    }
    if (url === '/enrollment-keys/k-1' && init?.method === 'DELETE') {
      return jsonRes(del.payload, del.status);
    }
    return jsonRes({ data: [] });
  });
}

const listFetches = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/enrollment-keys?')).length;

async function openDeleteModal() {
  render(<EnrollmentKeyManager />);
  await screen.findByText('Prod key');
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  return screen.findByRole('button', { name: 'Delete Key' });
}

beforeEach(() => {
  fetchMock.mockReset();
  toastMock.mockReset();
});

describe('EnrollmentKeyManager delete confirmation (#3531)', () => {
  it('delete failure: toasts, keeps the modal open, does not refetch the list', async () => {
    routeFetch({ status: 500, payload: { error: 'Delete blew up' } });
    const confirm = await openDeleteModal();
    const before = listFetches();

    fireEvent.click(confirm);

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Delete blew up' })),
    );
    expect(screen.getByText('Delete Enrollment Key')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete Key' })).not.toBeDisabled());
    expect(listFetches()).toBe(before);
  });

  it('delete success: refetches, closes the modal and toasts success', async () => {
    routeFetch({ status: 200, payload: { success: true } });
    const confirm = await openDeleteModal();
    const before = listFetches();

    fireEvent.click(confirm);

    await waitFor(() => expect(screen.queryByText('Delete Enrollment Key')).toBeNull());
    expect(listFetches()).toBe(before + 1);
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });
});
