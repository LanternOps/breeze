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

describe('ReportTemplates — MRR & renewals card', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimsState = { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p-1' } };
    grantedPermissions = new Set(['contracts:read']);
  });

  it('shows the card in the Business section for a user holding contracts:read', async () => {
    mockTemplatesFetch();
    render(<ReportTemplates />);
    const business = await screen.findByTestId('report-template-group-business');
    const card = within(business).getByTestId('report-template-card-mrr_renewals');
    expect(within(card).getByTestId('report-template-type-mrr_renewals')).toBeInTheDocument();
    expect(within(screen.getByTestId('report-template-group-general')).queryByTestId('report-template-card-mrr_renewals')).toBeNull();
  });

  it('hides the card without contracts:read', async () => {
    grantedPermissions = new Set(['tickets:read', 'time_entries:read', 'invoices:read', 'ai_sessions:read_all']);
    mockTemplatesFetch();
    render(<ReportTemplates />);
    const business = await screen.findByTestId('report-template-group-business');
    expect(within(business).queryByTestId('report-template-card-mrr_renewals')).toBeNull();
    expect(within(business).getByTestId('report-template-card-ticket_sla_attainment')).toBeInTheDocument();
  });

  it('describes the default range as the run date, not a period', async () => {
    mockTemplatesFetch();
    render(<ReportTemplates />);
    const card = await screen.findByTestId('report-template-card-mrr_renewals');
    expect(within(card).getByText(/as of run date/i)).toBeInTheDocument();
    expect(within(card).queryByText(/last full month/i)).toBeNull();
  });

  it('"Use" creates a monthly PDF report with only groupBy and renewalHorizonDays in the config', async () => {
    mockTemplatesFetch();
    render(<ReportTemplates />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('report-template-use-mrr_renewals'));
    await user.click(await screen.findByTestId('mrr-renewals-create-report'));

    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody()).toMatchObject({ type: 'mrr_renewals', schedule: 'monthly', format: 'pdf', orgId: 'org-1' });
    expect(postBody().config).toEqual({ groupBy: 'organization', renewalHorizonDays: 90 });
    for (const key of ['asOf', 'period', 'dateRange', 'filters', 'sites', 'orgId', 'orgIds', 'siteIds', 'deviceIds']) {
      expect(postBody().config, key).not.toHaveProperty(key);
    }
  });

  it('sends the chosen axis and horizon', async () => {
    mockTemplatesFetch();
    render(<ReportTemplates />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('report-template-use-mrr_renewals'));
    await user.selectOptions(await screen.findByTestId('mrr-renewals-group-by'), 'contract');
    await user.selectOptions(screen.getByTestId('mrr-renewals-horizon'), '30');
    await user.click(screen.getByTestId('mrr-renewals-create-report'));

    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody().config).toEqual({ groupBy: 'contract', renewalHorizonDays: 30 });
  });

  it("seeds the options form from a saved report's stored config", async () => {
    const config = { groupBy: 'contract', renewalHorizonDays: 180 };
    mockTemplatesFetch([{ id: 'saved-mrr', name: 'Saved MRR', type: 'mrr_renewals', config }]);
    render(<ReportTemplates />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('report-template-use-saved-mrr'));
    await user.click(await screen.findByTestId('mrr-renewals-create-report'));

    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody().config).toEqual(config);
  });
});
