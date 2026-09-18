import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@/lib/i18n';
import type { Organization } from '@/components/settings/organizationTypes';
import type { AccountReadinessResponse } from '@/lib/orgReadiness';
import { fetchWithAuth } from '@/stores/auth';
import OrganizationsBoardPage from './OrganizationsBoardPage';

// Same mocking convention as W02's page tests. If W02's boardTestKit.ts exports a
// fetch router (`mockBoardApi` or similar), use it instead of `mockApi` below so
// the org-list and readiness fixtures have one definition.
vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn(), handleSessionExpired: vi.fn() }));
// orgStore.ts calls registerOrgIdProvider() from '@/stores/auth' at import time; the
// mock above has no such export, so the real store must never load (same pattern as
// OrganizationsBoardPage.render.test.tsx).
const store = vi.hoisted(() => ({
  currentOrgId: null as string | null,
  organizations: [] as Array<{ id: string; name: string }>,
  serviceManagementMode: 'native' as 'native' | 'external' | 'off',
  fetchOrganizations: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: Object.assign((selector?: (s: typeof store) => unknown) => (selector ? selector(store) : undefined), {
    getState: () => store,
  }),
}));
vi.mock('@/lib/authScope', () => ({
  useJwtClaims: () => ({ status: 'resolved' as const, claims: { scope: 'partner' as const, orgId: null, partnerId: 'partner-1' } }),
  getJwtClaims: () => ({ scope: 'partner' as const, orgId: null, partnerId: 'partner-1' }),
}));
vi.mock('@/lib/permissions', () => ({
  hasPermission: () => true,
  usePermissions: () => ({ permissions: [{ resource: '*', action: '*' }], can: () => true }),
}));
const fetchMock = vi.mocked(fetchWithAuth);

const A_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const B_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const ALPHA: Organization = { id: A_ID, name: 'Alpha Ltd', status: 'active', type: 'customer', createdAt: '2026-01-01T00:00:00Z' };
const BETA: Organization = { id: B_ID, name: 'Beta Inc', status: 'active', type: 'customer', createdAt: '2026-01-02T00:00:00Z' };

const CAPS = {
  sites: true, devices: true, policies: true, contacts: true, portalUsers: true,
  invoices: true, tickets: true, integrations: true, contracts: true, backup: true,
};

function orgRow(orgId: string, extra: Partial<AccountReadinessResponse['orgs'][number]> = {}): AccountReadinessResponse['orgs'][number] {
  return {
    orgId, type: 'customer', status: 'active',
    setup: { sites: 1, devices: 1, lastSeenAt: '2026-09-13T00:00:00.000Z', policyAssigned: true, backupApplicable: true, backupConfigured: true },
    account: { primaryContact: { name: 'Jo', email: 'jo@a.example', phone: '1', mobile: null }, billingRoleContact: true, billingAddress: true, pendingInvitations: 0, overdueInvoices: 0, activeContracts: 1 },
    tickets: { open: 0, awaitingCustomer: 0, slaBreached: 0 },
    integrations: [],
    ...extra,
  };
}

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

/**
 * Routes by URL: the org list (fetchAllOrganizations) and the readiness batches; everything else answers `{}`.
 * `readinessDelayMs` pushes the readiness response onto a later macrotask, mirroring the real component's
 * two-tick sequence (org list resolves -> row renders -> readiness effect fires -> chips render) so a test
 * that queries chip data must actually wait for it rather than getting lucky on microtask ordering.
 */
function mockApi(readiness: () => Omit<AccountReadinessResponse, 'partnerId'>, opts: { readinessDelayMs?: number } = {}) {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('/orgs/account-readiness')) {
      if (opts.readinessDelayMs) await new Promise((resolve) => setTimeout(resolve, opts.readinessDelayMs));
      return jsonResponse({ partnerId: 'p', ...readiness() });
    }
    if (url.includes('/orgs/organizations')) return jsonResponse({ data: [ALPHA, BETA], pagination: { page: 1, limit: 100, total: 2 } });
    return jsonResponse({});
  });
}

const fullReadiness = () => ({
  capabilities: CAPS,
  serviceManagementMode: 'native' as const,
  connectors: [{ system: 'quickbooks' as const, state: 'reauth_required' as const }, { system: 'pax8' as const, state: 'connected' as const }],
  orgs: [
    orgRow(A_ID, { integrations: [{ system: 'pax8', state: 'linked' }] }),
    orgRow(B_ID, {
      integrations: [],
      account: { ...orgRow(B_ID).account, activeContracts: 0 },
      setup: { ...orgRow(B_ID).setup, backupConfigured: false },
    }),
  ],
});

beforeEach(() => {
  window.location.hash = '';
  fetchMock.mockReset();
});
afterEach(() => {
  window.location.hash = '';
});

describe('OrganizationsBoardPage — W03', () => {
  it('shows the Integrations column, the Unlinked band cell and filter, and one QuickBooks repair line', async () => {
    mockApi(fullReadiness);
    render(<OrganizationsBoardPage />);
    await waitFor(() => expect(screen.getByTestId(`org-board-badge-${A_ID}-pax8`)).toBeInTheDocument());
    expect(screen.getByTestId(`org-board-badge-${B_ID}-pax8`)).toHaveTextContent('Pax8 not linked');
    // QuickBooks is reauth_required: no "QuickBooks not linked" on either org, one repair line in the band.
    expect(screen.queryByTestId(`org-board-badge-${A_ID}-quickbooks`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`org-board-badge-${B_ID}-quickbooks`)).not.toBeInTheDocument();
    expect(screen.getAllByTestId('org-board-repair-quickbooks')).toHaveLength(1);
    expect(screen.getByTestId('org-board-band-unlinked-count')).toHaveTextContent('1');
    expect(screen.getByTestId('org-board-filter-unlinked')).toBeInTheDocument();
  });

  it('the Unlinked filter keeps only rows with a not-linked badge, presses the band cell and writes the hash', async () => {
    mockApi(fullReadiness);
    render(<OrganizationsBoardPage />);
    await waitFor(() => expect(screen.getByTestId(`org-board-badge-${A_ID}-pax8`)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('org-board-filter-unlinked'));
    await waitFor(() => expect(screen.queryByTestId(`org-board-row-${A_ID}`)).not.toBeInTheDocument());
    expect(screen.getByTestId(`org-board-row-${B_ID}`)).toBeInTheDocument();
    expect(window.location.hash).toContain('filter=unlinked');
    expect(screen.getByTestId('org-board-band-unlinked')).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders the "No active contract" and "No backup configured" chips as repair links', async () => {
    mockApi(fullReadiness, { readinessDelayMs: 20 });
    render(<OrganizationsBoardPage />);
    await waitFor(() => expect(screen.getByTestId(`org-board-row-${B_ID}`)).toBeInTheDocument());
    const rowB = within(screen.getByTestId(`org-board-row-${B_ID}`));
    // Chips render only once the (separately-fetched) readiness batch lands — findByTestId waits for that,
    // where a synchronous getByTestId races the second fetch and flakes under load (issue #5862).
    const contract = await rowB.findByTestId('org-board-chip-noActiveContract');
    expect(contract).toHaveTextContent('No active contract');
    expect(contract).toHaveAttribute('href', `/organizations/${B_ID}#billing`);
    expect(contract).toHaveAttribute('title', 'Open the Billing tab for Beta Inc');
    const backup = await rowB.findByTestId('org-board-chip-noBackup');
    expect(backup).toHaveAttribute('href', '/backup');
    expect(backup).toHaveAttribute('title', 'Open backup for Beta Inc');
    expect(within(screen.getByTestId(`org-board-row-${A_ID}`)).queryByTestId('org-board-chip-noActiveContract')).not.toBeInTheDocument();
  });

  it('hides column, band cell, filter chip and repair lines when integrations are withheld', async () => {
    mockApi(() => ({
      capabilities: { ...CAPS, integrations: false },
      serviceManagementMode: 'native' as const,
      orgs: [orgRow(A_ID), orgRow(B_ID)],
    }));
    render(<OrganizationsBoardPage />);
    await waitFor(() => expect(screen.getByTestId(`org-board-row-${A_ID}`)).toBeInTheDocument());
    // The row itself renders from the org-list fetch alone, independent of readiness — waiting only for
    // it would make the absence assertions below vacuous (they'd equally pass before readiness has
    // loaded). Wait for a readiness-derived positive signal first (both default orgRow fixtures have no
    // outstanding chips, so ReadinessChips renders "complete" once its batch lands) to prove readiness
    // actually resolved with integrations withheld, not merely that it hasn't loaded yet.
    await waitFor(() => expect(screen.getAllByTestId('org-board-chips-complete').length).toBeGreaterThan(0));
    expect(screen.queryByTestId('org-board-col-integrations')).not.toBeInTheDocument();
    expect(screen.queryByTestId('org-board-band-unlinked')).not.toBeInTheDocument();
    expect(screen.queryByTestId('org-board-filter-unlinked')).not.toBeInTheDocument();
    expect(screen.queryByTestId('org-board-repairs')).not.toBeInTheDocument();
  });
});
