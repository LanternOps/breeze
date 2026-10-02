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

const ALL = ['tickets:read', 'time_entries:read', 'invoices:read', 'ai_sessions:read_all'];

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

describe('ReportTemplates — AI usage by client card (#7608 W10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimsState = { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p-1' } };
    grantedPermissions = new Set(ALL);
  });

  it('shows the card in the Business section for a user holding invoices:read AND ai_sessions:read_all', async () => {
    mockTemplatesFetch();
    render(<ReportTemplates />);
    const business = await screen.findByTestId('report-template-group-business');
    const card = within(business).getByTestId('report-template-card-ai_usage_by_client');
    expect(within(card).getByTestId('report-template-type-ai_usage_by_client')).toBeInTheDocument();
    // Not duplicated into the general section.
    expect(within(screen.getByTestId('report-template-group-general')).queryByTestId('report-template-card-ai_usage_by_client')).toBeNull();
  });

  it.each([
    ['invoices:read', ['tickets:read', 'time_entries:read', 'ai_sessions:read_all']],
    ['ai_sessions:read_all', ['tickets:read', 'time_entries:read', 'invoices:read']],
  ])('hides the card when %s is missing', async (_missing, granted) => {
    grantedPermissions = new Set(granted);
    mockTemplatesFetch();
    render(<ReportTemplates />);
    const business = await screen.findByTestId('report-template-group-business');
    expect(within(business).queryByTestId('report-template-card-ai_usage_by_client')).toBeNull();
    expect(within(business).getByTestId('report-template-card-ticket_sla_attainment')).toBeInTheDocument();
  });

  it('describes the default range as the last full month, not "Custom"', async () => {
    mockTemplatesFetch();
    render(<ReportTemplates />);
    const card = await screen.findByTestId('report-template-card-ai_usage_by_client');
    expect(within(card).getByText(/last full month/i)).toBeInTheDocument();
    expect(within(card).queryByText(/^custom$/i)).toBeNull();
  });

  it('creates the report with the period only for Automatic grouping, and no refused selector keys', async () => {
    mockTemplatesFetch();
    render(<ReportTemplates />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('report-template-use-ai_usage_by_client'));
    await user.click(await screen.findByTestId('ai-usage-by-client-create-report'));

    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody()).toMatchObject({ type: 'ai_usage_by_client', schedule: 'monthly', format: 'pdf', orgId: 'org-1' });
    expect(postBody().config).toEqual({ period: { kind: 'last_full_month' } });
    for (const key of ['dateRange', 'filters', 'sites', 'orgId', 'orgIds', 'siteIds', 'deviceIds']) {
      expect(postBody().config, key).not.toHaveProperty(key);
    }
  });

  it('sends an explicit axis when the user picks one', async () => {
    mockTemplatesFetch();
    render(<ReportTemplates />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('report-template-use-ai_usage_by_client'));
    await user.selectOptions(await screen.findByTestId('ai-usage-by-client-group-by'), 'model');
    await user.click(screen.getByTestId('ai-usage-by-client-create-report'));

    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody().config).toEqual({ period: { kind: 'last_full_month' }, groupBy: 'model' });
  });

  it('seeds the options form from a saved report\'s stored config', async () => {
    const config = { period: { kind: 'last_quarter' }, groupBy: 'organization' };
    mockTemplatesFetch([{ id: 'saved-ai', name: 'Saved AI usage', type: 'ai_usage_by_client', config }]);
    render(<ReportTemplates />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('report-template-use-saved-ai'));
    await user.click(await screen.findByTestId('ai-usage-by-client-create-report'));

    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody().config).toEqual(config);
  });
});
