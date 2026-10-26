import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  useAuthStore: (selector: (s: { user: { canManagePartnerWide?: boolean } }) => unknown) =>
    selector({ user: { canManagePartnerWide: undefined } }),
}));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: 'org-1' }) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/usePartnerCurrency', () => ({
  usePartnerCurrency: () => ({ currency: 'USD', loading: false, failed: false, retry: () => {} }),
}));

let claimsState: unknown = { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p-1' } };
vi.mock('@/lib/authScope', () => ({
  useJwtClaims: () => claimsState,
  getJwtClaims: () => (claimsState as { claims?: unknown }).claims ?? { scope: null, orgId: null, partnerId: null },
}));

let grantedPermissions = new Set<string>();
vi.mock('@/lib/permissions', () => ({
  usePermissions: () => ({
    permissions: undefined,
    can: (resource: string, action: string) => grantedPermissions.has(`${resource}:${action}`),
  }),
}));

import ReportTemplates from './ReportTemplates';

function mockTemplatesFetch(saved: unknown[] = []) {
  fetchWithAuth.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === '/reports/templates') {
      return Promise.resolve(saved.length
        ? { ok: true, json: () => Promise.resolve({ data: saved }) }
        : { ok: false, json: () => Promise.resolve({}) });
    }
    if (url === '/reports' && init?.method === 'POST') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-1' } }) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

function postBody() {
  const call = fetchWithAuth.mock.calls.find(
    ([url, init]) => url === '/reports' && (init as { method?: string } | undefined)?.method === 'POST',
  );
  return call ? JSON.parse((call[1] as { body: string }).body) : undefined;
}

describe('ReportTemplates — Client profitability card', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimsState = { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p-1' } };
    grantedPermissions = new Set(['invoices:read', 'time_entries:read']);
  });

  it('shows the card in the Business section with both grants', async () => {
    mockTemplatesFetch();
    render(<ReportTemplates />);
    const business = await screen.findByTestId('report-template-group-business');
    const card = within(business).getByTestId('report-template-card-client_profitability');
    expect(within(card).getByTestId('report-template-type-client_profitability')).toBeInTheDocument();
    expect(within(card).getAllByText('Client profitability').length).toBeGreaterThan(0);
    expect(within(screen.getByTestId('report-template-group-general')).queryByTestId('report-template-card-client_profitability')).toBeNull();
  });

  it.each([['invoices:read'], ['time_entries:read']])('hides the card with only %s', async (grant) => {
    // tickets:read keeps the Business group rendered so the absence is the gate's doing.
    grantedPermissions = new Set([grant, 'tickets:read']);
    mockTemplatesFetch();
    render(<ReportTemplates />);
    const business = await screen.findByTestId('report-template-group-business');
    expect(within(business).queryByTestId('report-template-card-client_profitability')).toBeNull();
  });

  it('"Use" creates a monthly PDF report with only the period when nothing optional is chosen', async () => {
    mockTemplatesFetch();
    render(<ReportTemplates />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('report-template-use-client_profitability'));
    await user.click(await screen.findByTestId('client-profitability-create-report'));

    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody()).toMatchObject({ type: 'client_profitability', schedule: 'monthly', format: 'pdf', orgId: 'org-1' });
    expect(postBody().config).toEqual({ period: { kind: 'last_full_month' } });
    for (const key of ['groupBy', 'laborCostPerHour', 'dateRange', 'filters', 'sites', 'orgId', 'orgIds', 'siteIds', 'deviceIds']) {
      expect(postBody().config, key).not.toHaveProperty(key);
    }
  });

  it('sends the labor rate and chosen axis', async () => {
    mockTemplatesFetch();
    render(<ReportTemplates />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('report-template-use-client_profitability'));
    await user.selectOptions(await screen.findByTestId('client-profitability-group-by'), 'source');
    await user.click(screen.getByTestId('client-profitability-labor-enabled'));
    await user.type(screen.getByTestId('client-profitability-labor-amount'), '45');
    await user.click(screen.getByTestId('client-profitability-create-report'));

    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody().config).toEqual({
      period: { kind: 'last_full_month' },
      groupBy: 'source',
      laborCostPerHour: { amount: '45', currencyCode: 'USD' },
    });
  });

  it('an invalid labor amount disables Create', async () => {
    mockTemplatesFetch();
    render(<ReportTemplates />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('report-template-use-client_profitability'));
    await user.click(await screen.findByTestId('client-profitability-labor-enabled'));
    expect(screen.getByTestId('client-profitability-create-report')).toBeDisabled();
    await user.type(screen.getByTestId('client-profitability-labor-amount'), '1.234');
    expect(screen.getByTestId('client-profitability-create-report')).toBeDisabled();
  });

  it("seeds the options form from a saved report's stored config", async () => {
    const config = { period: { kind: 'last_30_days' }, groupBy: 'organization', laborCostPerHour: { amount: '60', currencyCode: 'GBP' } };
    mockTemplatesFetch([{ id: 'saved-cp', name: 'Saved profitability', type: 'client_profitability', config }]);
    render(<ReportTemplates />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('report-template-use-saved-cp'));
    await user.click(await screen.findByTestId('client-profitability-create-report'));

    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody().config).toEqual(config);
  });
});
