import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import BaselineFormModal, { type Baseline } from './BaselineFormModal';
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

function okResponse(): Response {
  return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
}

function submittedBody(): Record<string, unknown> {
  const [, init] = fetchWithAuthMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(String(init.body));
}

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

describe('BaselineFormModal org scoping', () => {
  beforeEach(() => {
    orgStoreState.currentOrgId = 'org-1';
    fetchWithAuthMock.mockResolvedValue(okResponse());
  });

  it('sends the selected org when creating a baseline', async () => {
    render(<BaselineFormModal baseline={null} onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New Baseline' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));
    expect(submittedBody()).toMatchObject({ orgId: 'org-1', name: 'New Baseline' });
  });

  // The bug: the update path matches on (id, orgId) and 404s when they diverge,
  // so sending the header selection breaks editing a baseline from another org.
  it('sends the baseline own org when editing, not the selected org', async () => {
    render(<BaselineFormModal baseline={existing} onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));
    expect(submittedBody()).toMatchObject({ id: 'baseline-1', orgId: 'org-other' });
  });

  // Fleet view (no org selected) is the other half of the same bug: the edit
  // used to send no orgId at all, so a multi-org partner got a 400/404.
  it('still sends the baseline own org when editing from fleet view', async () => {
    orgStoreState.currentOrgId = null;
    render(<BaselineFormModal baseline={existing} onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));
    expect(submittedBody()).toMatchObject({ id: 'baseline-1', orgId: 'org-other' });
  });

  // With no org in context and nothing to inherit, don't invent one — the API
  // auto-resolves a single-org partner.
  it('omits orgId when creating with no org in context', async () => {
    orgStoreState.currentOrgId = null;
    render(<BaselineFormModal baseline={null} onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New Baseline' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));
    expect(submittedBody()).not.toHaveProperty('orgId');
  });
});
