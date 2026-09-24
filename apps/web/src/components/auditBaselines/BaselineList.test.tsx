import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import BaselineList from './BaselineList';
import type { Baseline } from './BaselineFormModal';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  handleSessionExpired: vi.fn()
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const orgStoreState: {
  currentOrgId: string | null;
  organizations: unknown[];
  organizationsLoaded: boolean;
  allOrgs: boolean;
  error: string | null;
} = {
  currentOrgId: 'org-1',
  organizations: [{ id: 'org-1', name: 'Acme' }],
  organizationsLoaded: true,
  allOrgs: false,
  error: null
};

vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector?: (s: typeof orgStoreState) => unknown) =>
    selector ? selector(orgStoreState) : orgStoreState
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const existing: Baseline = {
  id: 'baseline-1',
  orgId: 'org-other',
  name: 'Windows CIS L1',
  osType: 'windows',
  profile: 'cis_l1',
  settings: {},
  isActive: true,
  createdBy: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z'
};

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function postBody(): Record<string, unknown> {
  const call = fetchWithAuthMock.mock.calls.find(
    ([, init]) => (init as RequestInit | undefined)?.method === 'POST'
  );
  if (!call) throw new Error('no POST request was made');
  return JSON.parse(String((call[1] as RequestInit).body));
}

describe('BaselineList active toggle org scoping', () => {
  beforeEach(() => {
    orgStoreState.currentOrgId = 'org-1';
    fetchWithAuthMock.mockImplementation(async (_url, init) =>
      (init as RequestInit | undefined)?.method === 'POST'
        ? jsonResponse({})
        : jsonResponse({ data: [existing] })
    );
  });

  // Toggling sends `id`, so it takes the same (id, orgId) update path as the
  // form — the header selection would 404 the row it is displaying.
  it('sends the baseline own org, not the selected org', async () => {
    render(<BaselineList />);

    const toggle = await screen.findByRole('button', { name: 'Active' });
    await userEvent.click(toggle);

    await waitFor(() => expect(postBody()).toMatchObject({ id: 'baseline-1', orgId: 'org-other' }));
  });

  it('still sends the baseline own org from fleet view', async () => {
    orgStoreState.currentOrgId = null;
    render(<BaselineList />);

    const toggle = await screen.findByRole('button', { name: 'Active' });
    await userEvent.click(toggle);

    await waitFor(() => expect(postBody()).toMatchObject({ id: 'baseline-1', orgId: 'org-other' }));
  });
});

describe('BaselineList delete confirmation (#3531)', () => {
  const toastMock = vi.mocked(showToast);
  const listFetches = () =>
    fetchWithAuthMock.mock.calls.filter(
      ([url, init]) => String(url).startsWith('/audit-baselines?') && !(init as RequestInit | undefined)?.method
    ).length;

  function route(deleteStatus: number, deleteBody: unknown) {
    fetchWithAuthMock.mockReset();
    toastMock.mockReset();
    orgStoreState.currentOrgId = 'org-1';
    fetchWithAuthMock.mockImplementation(async (_url, init) => {
      if ((init as RequestInit | undefined)?.method === 'DELETE') {
        return { ok: deleteStatus < 400, status: deleteStatus, json: async () => deleteBody } as unknown as Response;
      }
      return jsonResponse({ data: [existing] });
    });
  }

  async function openAndConfirm() {
    render(<BaselineList />);
    await screen.findByText('Windows CIS L1');
    await userEvent.click(screen.getByTitle('Delete'));
    const heading = await screen.findByRole('heading', { name: 'Delete Baseline' });
    const dialog = heading.parentElement as HTMLElement;
    const confirm = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Delete')!;
    await userEvent.click(confirm);
  }

  it.each([
    [500, { error: 'Delete blew up' }, 'Delete blew up'],
    [403, { error: 'Insufficient permissions' }, 'Insufficient permissions'],
  ])('%i: toasts, keeps the modal open, does not refetch the list', async (status, body, message) => {
    route(status, body);
    await openAndConfirm();

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message }))
    );
    expect(fetchWithAuthMock).toHaveBeenCalledWith(
      '/audit-baselines/baseline-1',
      expect.objectContaining({ method: 'DELETE' })
    );
    expect(screen.getByRole('heading', { name: 'Delete Baseline' })).toBeInTheDocument();
    expect(listFetches()).toBe(1);
  });

  it('success: refetches and closes the modal', async () => {
    route(200, { success: true });
    await openAndConfirm();

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Delete Baseline' })).toBeNull());
    expect(listFetches()).toBe(2);
    expect(toastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });
});
