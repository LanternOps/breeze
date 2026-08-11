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

// The shared capability gate (#2135). Mocked rather than driven through a forged
// JWT because the real hook reads useAuthStore out of the auth module this file
// already replaces — and because the rule itself is tested in
// hooks/useDefaultOwnerScope.test.ts, not here.
const ownerScopeState: {
  isPartnerScope: boolean;
  defaultOwnerScope: 'organization' | 'partner';
} = { isPartnerScope: false, defaultOwnerScope: 'organization' };

vi.mock('@/hooks/useDefaultOwnerScope', () => ({
  useDefaultOwnerScope: () => ownerScopeState
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
  partnerId: null,
  name: 'CIS Windows L1',
  osType: 'windows',
  level: 'l1',
  benchmarkVersion: '1.0.0',
  isActive: true,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z'
};

const partnerWide: Baseline = {
  ...existing,
  id: 'baseline-2',
  orgId: null,
  partnerId: 'partner-1'
};

/** Fills the two required fields so a create can actually submit. */
function fillRequiredFields(): void {
  fireEvent.change(screen.getByLabelText(/name/i), { target: { value: 'Win L1' } });
  fireEvent.change(screen.getByLabelText(/benchmark version/i), { target: { value: '3.0.0' } });
}

describe('CisBaselineForm org scoping', () => {
  beforeEach(() => {
    orgStoreState.currentOrgId = 'org-1';
    orgStoreState.organizations = [{ id: 'org-1', name: 'Acme' }];
    ownerScopeState.isPartnerScope = false;
    ownerScopeState.defaultOwnerScope = 'organization';
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

// Ownership axis (#2135): cis_baselines is now org XOR partner owned.
describe('CisBaselineForm ownership scope', () => {
  beforeEach(() => {
    orgStoreState.currentOrgId = 'org-1';
    orgStoreState.organizations = [{ id: 'org-1', name: 'Acme' }];
    ownerScopeState.isPartnerScope = true;
    ownerScopeState.defaultOwnerScope = 'organization';
    fetchWithAuthMock.mockResolvedValue(okResponse());
  });

  // The server derives the partner from the caller's token and ignores orgId on
  // a partner-wide create, so sending one would misrepresent what we asked for.
  it('sends ownerScope partner and no orgId for an all-orgs create', async () => {
    render(<CisBaselineForm baseline={null} onClose={vi.fn()} onSaved={vi.fn()} />);

    fillRequiredFields();
    fireEvent.click(screen.getByTestId('cis-baseline-owner-partner'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));
    expect(submittedBody()).toMatchObject({ ownerScope: 'partner' });
    expect(submittedBody()).not.toHaveProperty('orgId');
  });

  // Regression guard for the multi-org 400 fix: adding the selector must not
  // cost the org-owned path its explicit org.
  it('still sends the selected org when the creator picks this-organization-only', async () => {
    ownerScopeState.defaultOwnerScope = 'partner';
    render(<CisBaselineForm baseline={null} onClose={vi.fn()} onSaved={vi.fn()} />);

    fillRequiredFields();
    fireEvent.click(screen.getByTestId('cis-baseline-owner-org'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));
    expect(submittedBody()).toMatchObject({ ownerScope: 'organization', orgId: 'org-1' });
  });

  // Ownership is immutable server-side; offering a control that silently does
  // nothing is worse than offering none.
  it('hides the selector when editing and never sends ownerScope on an update', async () => {
    render(<CisBaselineForm baseline={existing} onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(screen.queryByTestId('cis-baseline-owner')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));
    expect(submittedBody()).not.toHaveProperty('ownerScope');
  });

  // A partner-wide row has no org at all. Falling back to the header selection
  // would claim an ownership the row does not have.
  it('omits orgId when editing a partner-wide baseline', async () => {
    render(<CisBaselineForm baseline={partnerWide} onClose={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));
    expect(submittedBody()).toMatchObject({ id: 'baseline-2' });
    expect(submittedBody()).not.toHaveProperty('orgId');
  });

  // Without the capability the partner option is not merely rejected server-
  // side, it is never offered — and the wire shape stays exactly as it was.
  it('hides the selector without the partner-wide capability', async () => {
    ownerScopeState.isPartnerScope = false;
    render(<CisBaselineForm baseline={null} onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(screen.queryByTestId('cis-baseline-owner')).not.toBeInTheDocument();

    fillRequiredFields();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(1));
    expect(submittedBody()).toMatchObject({ orgId: 'org-1' });
    expect(submittedBody()).not.toHaveProperty('ownerScope');
  });

  // Fleet view has no org to own the baseline, and the API only auto-resolves
  // one for a single-org partner — so the org-owned branch is a dead end there.
  it('blocks an org-owned create with no org in a multi-org fleet view', () => {
    orgStoreState.currentOrgId = null;
    orgStoreState.organizations = [{ id: 'org-1', name: 'Acme' }, { id: 'org-2', name: 'Globex' }];
    ownerScopeState.defaultOwnerScope = 'partner';
    render(<CisBaselineForm baseline={null} onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();

    fireEvent.click(screen.getByTestId('cis-baseline-owner-org'));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
