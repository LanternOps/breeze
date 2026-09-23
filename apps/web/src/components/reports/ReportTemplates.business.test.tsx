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

  it('creates the AR aging report directly with an empty config and no dateRange', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-1' } }) }));
    render(<ReportTemplates />);

    await userEvent.setup().click(await screen.findByTestId('report-template-use-ar_aging'));

    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody()).toMatchObject({ type: 'ar_aging', orgId: 'org-1' });
    expect(postBody().config).toEqual({});
    expect(postBody().config.dateRange).toBeUndefined();
  });

  it('creates the SLA attainment and technician time reports directly with no dateRange either', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-2' } }) }));
    render(<ReportTemplates />);

    await userEvent.setup().click(await screen.findByTestId('report-template-use-ticket_sla_attainment'));
    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody()).toMatchObject({ type: 'ticket_sla_attainment' });
    expect(postBody().config.dateRange).toBeUndefined();

    fetchWithAuth.mockClear();
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-3' } }) }));
    await userEvent.setup().click(await screen.findByTestId('report-template-use-technician_time_billability'));
    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody()).toMatchObject({ type: 'technician_time_billability' });
    expect(postBody().config.dateRange).toBeUndefined();
  });
});
