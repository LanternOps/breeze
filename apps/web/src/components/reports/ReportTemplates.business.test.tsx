import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: 'org-1' }) }));
const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...a: unknown[]) => navigateTo(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

// Mutable so individual tests can exercise unresolved / org-scope / partner-scope.
let claimsState: unknown = { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p-1' } };
vi.mock('@/lib/authScope', () => ({
  useJwtClaims: () => claimsState,
  getJwtClaims: () => (claimsState as { claims?: unknown }).claims ?? { scope: null, orgId: null, partnerId: null },
}));

// Mutable so individual tests can exercise missing permissions.
let grantedPermissions = new Set<string>(['tickets:read', 'time_entries:read', 'invoices:read']);
vi.mock('@/lib/permissions', () => ({
  usePermissions: () => ({
    permissions: undefined,
    can: (resource: string, action: string) => grantedPermissions.has(`${resource}:${action}`),
  }),
}));

import ReportTemplates from './ReportTemplates';

function mockTemplatesFetch(onPost: () => Promise<unknown>) {
  fetchWithAuth.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === '/reports/templates') return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    if (url === '/reports' && init?.method === 'POST') return onPost();
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

function postBody() {
  const call = fetchWithAuth.mock.calls.find(
    ([url, init]) => url === '/reports' && (init as { method?: string } | undefined)?.method === 'POST',
  );
  return call ? JSON.parse((call[1] as { body: string }).body) : undefined;
}

describe('ReportTemplates — Business group (#3198 W03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claimsState = { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p-1' } };
    grantedPermissions = new Set(['tickets:read', 'time_entries:read', 'invoices:read']);
  });

  it('renders the three business templates inside a labelled Business section for a partner-scope user with every permission', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
    render(<ReportTemplates />);

    const business = await screen.findByTestId('report-template-group-business');
    for (const id of ['ticket_sla_attainment', 'technician_time_billability', 'ar_aging']) {
      expect(within(business).getByTestId(`report-template-card-${id}`)).toBeInTheDocument();
    }
    // …and they are NOT duplicated into the general section.
    const general = screen.getByTestId('report-template-group-general');
    expect(within(general).queryByTestId('report-template-card-ar_aging')).toBeNull();
    // The existing curated cards keep their home.
    expect(within(general).getByTestId('report-template-card-identity_access_review')).toBeInTheDocument();
  });

  it('hides the Business section entirely for an org-scope user', async () => {
    claimsState = { status: 'resolved', claims: { scope: 'organization', orgId: 'org-1', partnerId: 'p-1' } };
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
    render(<ReportTemplates />);

    await screen.findByTestId('report-template-group-general');
    expect(screen.queryByTestId('report-template-group-business')).toBeNull();
  });

  it('hides the Business section while the JWT claims are unresolved', async () => {
    claimsState = { status: 'unresolved' };
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
    render(<ReportTemplates />);

    await screen.findByTestId('report-template-group-general');
    expect(screen.queryByTestId('report-template-group-business')).toBeNull();
  });

  it('hides only the cards a partner-scope user lacks permission for', async () => {
    grantedPermissions = new Set(['tickets:read']); // no invoices:read, no time_entries:read
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
    render(<ReportTemplates />);

    const business = await screen.findByTestId('report-template-group-business');
    expect(within(business).getByTestId('report-template-card-ticket_sla_attainment')).toBeInTheDocument();
    expect(within(business).queryByTestId('report-template-card-ar_aging')).toBeNull();
    expect(within(business).queryByTestId('report-template-card-technician_time_billability')).toBeNull();
  });

  it('hides the entire Business section when the user lacks every business permission', async () => {
    grantedPermissions = new Set();
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
    render(<ReportTemplates />);

    await screen.findByTestId('report-template-group-general');
    expect(screen.queryByTestId('report-template-group-business')).toBeNull();
  });

  const REFUSED_CONFIG_KEYS = ['dateRange', 'filters', 'sites', 'orgId', 'orgIds', 'siteIds', 'deviceIds'];
  const expectNoRefusedKeys = (config: Record<string, unknown>) => {
    for (const key of REFUSED_CONFIG_KEYS) expect(config, key).not.toHaveProperty(key);
  };

  it('opens the AR aging options modal instead of creating directly, and cancel creates nothing', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-1' } }) }));
    render(<ReportTemplates />);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('report-template-use-ar_aging'));
    expect(await screen.findByTestId('business-report-options-modal')).toBeInTheDocument();
    expect(screen.getByTestId('ar-aging-as-of')).toBeInTheDocument();
    expect(postBody()).toBeUndefined();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('business-report-options-modal')).toBeNull();
    expect(postBody()).toBeUndefined();
  });

  it('creates the AR aging report with the form config: asOf omitted when unset, no refused selector keys', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-1' } }) }));
    render(<ReportTemplates />);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('report-template-use-ar_aging'));
    await user.selectOptions(await screen.findByTestId('ar-aging-group-by'), 'currency');
    await user.click(screen.getByTestId('ar-aging-create-report'));

    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody()).toMatchObject({ type: 'ar_aging', schedule: 'monthly', format: 'pdf', orgId: 'org-1' });
    expect(postBody().config).toEqual({ groupBy: 'currency', includePaidInPeriod: false });
    expectNoRefusedKeys(postBody().config);
  });

  it('creates the SLA report with groupBy OMITTED for Automatic, and sends an explicit axis when chosen', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-2' } }) }));
    render(<ReportTemplates />);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('report-template-use-ticket_sla_attainment'));
    await user.click(await screen.findByTestId('ticket-sla-create-report'));
    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody()).toMatchObject({ type: 'ticket_sla_attainment' });
    expect(postBody().config).toEqual({ period: { kind: 'last_full_month' }, includeNoSla: true });
    expectNoRefusedKeys(postBody().config);

    fetchWithAuth.mockClear();
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-3' } }) }));
    await user.click(await screen.findByTestId('report-template-use-ticket_sla_attainment'));
    await user.selectOptions(await screen.findByTestId('ticket-sla-group-by'), 'technician');
    await user.click(screen.getByTestId('ticket-sla-create-report'));
    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody().config).toEqual({
      period: { kind: 'last_full_month' },
      groupBy: 'technician',
      includeNoSla: true,
    });
  });

  it('creates the technician time report with period, axis and capacity, and nothing else', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-4' } }) }));
    render(<ReportTemplates />);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('report-template-use-technician_time_billability'));
    await user.click(await screen.findByTestId('technician-time-create-report'));
    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody()).toMatchObject({ type: 'technician_time_billability' });
    expect(postBody().config).toEqual({
      period: { kind: 'last_full_month' },
      groupBy: 'technician',
      weeklyCapacityHours: 40,
    });
    expectNoRefusedKeys(postBody().config);
  });

  it('re-opens a business modal with fresh defaults rather than the last submission', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-5' } }) }));
    render(<ReportTemplates />);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('report-template-use-ticket_sla_attainment'));
    await user.selectOptions(await screen.findByTestId('ticket-sla-group-by'), 'category');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(await screen.findByTestId('report-template-use-ticket_sla_attainment'));
    expect(await screen.findByTestId('ticket-sla-group-by')).toHaveValue('');
  });
});
