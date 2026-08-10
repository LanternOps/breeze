import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import CisBaselineForm from './CisBaselineForm';
import { fetchWithAuth } from '../../stores/auth';
import type { Baseline } from './types';

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
  name: 'CIS Windows L1',
  osType: 'windows',
  level: 'l1',
  benchmarkVersion: '1.0.0',
  isActive: true,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z'
};

describe('CisBaselineForm org scoping', () => {
  beforeEach(() => {
    orgStoreState.currentOrgId = 'org-1';
    fetchWithAuthMock.mockResolvedValue(okResponse());
  });

  // The bug: POST /cis/baselines takes its org from the JSON body only, and
  // requires an explicit one for a non-org-scoped token. fetchWithAuth's
  // auto-injected ?orgId= does not satisfy it, so a multi-org partner got
  // "orgId is required when partner has multiple organizations".
  it('sends the selected org when creating a baseline', async () => {
    render(<CisBaselineForm baseline={null} onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Win L1' } });
    fireEvent.change(screen.getByLabelText(/benchmark version/i), { target: { value: '3.0.0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));
    expect(submittedBody()).toMatchObject({ orgId: 'org-1', name: 'Win L1' });
  });

  // On edit the route matches on (id, orgId) and 404s if they diverge, so the
  // baseline's own org wins over the header selection.
  it('sends the baseline own org when editing, not the selected org', async () => {
    render(<CisBaselineForm baseline={existing} onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));
    expect(submittedBody()).toMatchObject({ id: 'baseline-1', orgId: 'org-other' });
  });

  // With no org in context, don't invent one — the API auto-resolves a
  // single-org partner, and that is the only case the tab lets through here.
  it('omits orgId when no org is in context', async () => {
    orgStoreState.currentOrgId = null;
    render(<CisBaselineForm baseline={null} onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Win L1' } });
    fireEvent.change(screen.getByLabelText(/benchmark version/i), { target: { value: '3.0.0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));
    expect(submittedBody()).not.toHaveProperty('orgId');
  });
});
