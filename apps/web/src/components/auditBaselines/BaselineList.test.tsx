import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import BaselineList from './BaselineList';
import type { Baseline } from './BaselineFormModal';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

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
