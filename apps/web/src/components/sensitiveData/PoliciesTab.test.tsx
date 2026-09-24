import '@/lib/i18n';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), handleSessionExpired: vi.fn() }));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null }) => unknown) => selector({ currentOrgId: 'org-1' }),
}));
vi.mock('@/hooks/useDefaultOwnerScope', () => ({
  useDefaultOwnerScope: () => ({ isPartnerScope: false, defaultOwnerScope: 'organization' }),
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import PoliciesTab from './PoliciesTab';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);

const jsonRes = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

const POLICY = {
  id: 'sdp-1',
  orgId: 'org-1',
  name: 'Find credentials',
  detectionClasses: ['credential'],
  isActive: true,
  schedule: { type: 'manual' },
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

function routeFetch(del: { status: number; payload: unknown }) {
  fetchMock.mockImplementation(async (rawUrl: string | URL | Request, init?: RequestInit) => {
    const url = String(rawUrl);
    if (!init?.method && url === '/sensitive-data/policies') return jsonRes({ data: [POLICY] });
    if (init?.method === 'DELETE' && url === '/sensitive-data/policies/sdp-1') return jsonRes(del.payload, del.status);
    return jsonRes({});
  });
}

const listFetches = () =>
  fetchMock.mock.calls.filter(([url, init]) => url === '/sensitive-data/policies' && !init?.method).length;

async function openDeleteDialog() {
  render(<PoliciesTab />);
  const nameCell = await screen.findByText('Find credentials');
  const row = nameCell.closest('tr') as HTMLElement;
  const buttons = row.querySelectorAll('button');
  fireEvent.click(buttons[buttons.length - 1]);
  return screen.findByRole('button', { name: 'Delete Policy' });
}

beforeEach(() => {
  fetchMock.mockReset();
  toastMock.mockReset();
});

describe('sensitive-data PoliciesTab delete confirmation (#3531)', () => {
  it('delete failure: toasts, keeps the dialog open, does not refetch the list', async () => {
    routeFetch({ status: 500, payload: { error: 'Delete blew up' } });
    const confirm = await openDeleteDialog();
    expect(listFetches()).toBe(1);

    fireEvent.click(confirm);

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Delete blew up' })),
    );
    expect(screen.getByText('Delete Scan Policy')).toBeInTheDocument();
    expect(listFetches()).toBe(1);
  });

  it('delete success: refetches, closes the dialog and toasts success', async () => {
    routeFetch({ status: 200, payload: { success: true } });
    fireEvent.click(await openDeleteDialog());

    await waitFor(() => expect(screen.queryByText('Delete Scan Policy')).toBeNull());
    expect(listFetches()).toBe(2);
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });
});
