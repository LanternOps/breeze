import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
// Mutable so individual tests can exercise the All-organizations view (null).
let currentOrgId: string | null = 'org-1';
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId }) }));
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
    currentOrgId = 'org-1';
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

  it('describes each business card\'s real default range instead of "Custom" (#3198 W03)', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
    render(<ReportTemplates />);

    const business = await screen.findByTestId('report-template-group-business');
    // These two report a full calendar month, so "Custom" would misdescribe
    // them; they have no ad-hoc dateRange at all (the server refuses one).
    for (const id of ['ticket_sla_attainment', 'technician_time_billability']) {
      const card = within(business).getByTestId(`report-template-card-${id}`);
      expect(within(card).getByText(/last full month/i)).toBeInTheDocument();
      expect(within(card).queryByText(/^custom$/i)).toBeNull();
    }
    // AR aging has no period at all — it is a balance as of a date.
    const arCard = within(business).getByTestId('report-template-card-ar_aging');
    expect(within(arCard).getByText(/as of run date/i)).toBeInTheDocument();
    expect(within(arCard).queryByText(/^custom$/i)).toBeNull();
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

  // ── ownerScope (Task 4 / ruling W5) ──────────────────────────────────────

  it('posts ownerScope partner and NO orgId anywhere when All organizations is chosen', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-6' } }) }));
    render(<ReportTemplates />);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('report-template-use-ar_aging'));
    // org-1 is focused, so the selector opens on the organization option.
    expect(screen.getByTestId('report-owner-scope-org')).toBeChecked();
    await user.click(screen.getByTestId('report-owner-scope-partner'));
    await user.click(screen.getByTestId('ar-aging-create-report'));

    await waitFor(() => expect(postBody()).toBeDefined());
    // The partner id is derived server-side from auth.partnerId; an orgId
    // beside ownerScope:'partner' is a 400 (orgId: z.never()).
    expect(postBody()).toEqual({
      name: 'AR aging',
      type: 'ar_aging',
      schedule: 'monthly',
      format: 'pdf',
      ownerScope: 'partner',
      config: { groupBy: 'organization', includePaidInPeriod: false },
    });
  });

  it('defaults to All organizations on the All-organizations view and posts no orgId', async () => {
    currentOrgId = null;
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-7' } }) }));
    render(<ReportTemplates />);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('report-template-use-technician_time_billability'));
    expect(screen.getByTestId('report-owner-scope-partner')).toBeChecked();
    await user.click(screen.getByTestId('technician-time-create-report'));

    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody()).toEqual({
      name: expect.any(String),
      type: 'technician_time_billability',
      schedule: expect.any(String),
      format: expect.any(String),
      ownerScope: 'partner',
      config: { period: { kind: 'last_full_month' }, groupBy: 'technician', weeklyCapacityHours: 40 },
    });
    expect(postBody()).not.toHaveProperty('orgId');
    expect(postBody()).not.toHaveProperty('partnerId');
  });

  it('posts ownerScope organization with the focused orgId when the organization option is kept', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-8' } }) }));
    render(<ReportTemplates />);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('report-template-use-ticket_sla_attainment'));
    await user.click(await screen.findByTestId('ticket-sla-create-report'));

    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody()).toEqual({
      name: expect.any(String),
      type: 'ticket_sla_attainment',
      schedule: expect.any(String),
      format: expect.any(String),
      ownerScope: 'organization',
      orgId: 'org-1',
      config: { period: { kind: 'last_full_month' }, includeNoSla: true },
    });
  });

  it('switching back to the organization option restores the focused orgId', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-9' } }) }));
    render(<ReportTemplates />);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('report-template-use-ar_aging'));
    await user.click(screen.getByTestId('report-owner-scope-partner'));
    await user.click(screen.getByTestId('report-owner-scope-org'));
    await user.click(screen.getByTestId('ar-aging-create-report'));

    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody()).toMatchObject({ ownerScope: 'organization', orgId: 'org-1' });
  });

  it('never posts a stale ownerScope:"partner" once canChoose has gone false after the modal opened', async () => {
    // No org focused, so the selector opens on "All organizations" by default.
    currentOrgId = null;
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-11' } }) }));
    const { rerender } = render(<ReportTemplates />);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('report-template-use-ar_aging'));
    expect(screen.getByTestId('report-owner-scope-partner')).toBeChecked();

    // Simulate the auth token being demoted to org-scope mid-session (e.g. a
    // refresh mid-flow) WITHOUT the user touching the radio again — the
    // `ownerScope` component state still holds the stale 'partner' value.
    claimsState = { status: 'resolved', claims: { scope: 'organization', orgId: 'org-1', partnerId: 'p-1' } };
    rerender(<ReportTemplates />);

    // The selector disappears (org-scope tokens never get to choose)...
    expect(screen.queryByTestId('report-owner-scope')).toBeNull();
    // ...but the options form (and its stale-state submit) is still reachable.
    await user.click(screen.getByTestId('ar-aging-create-report'));

    await waitFor(() => expect(postBody()).toBeDefined());
    // Must fall back to 'organization', never leak the stale 'partner' value
    // a de-privileged token can no longer legally submit.
    expect(postBody()).toMatchObject({ ownerScope: 'organization' });
  });

  it('keeps the non-business create body unchanged: no ownerScope, no owner-scope selector', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-10' } }) }));
    render(<ReportTemplates />);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('report-template-use-security_compliance_posture'));
    expect(screen.queryByTestId('report-owner-scope')).toBeNull();
    await user.click(screen.getByRole('button', { name: /create report/i }));

    await waitFor(() => expect(postBody()).toBeDefined());
    expect(postBody()).not.toHaveProperty('ownerScope');
    expect(postBody()).toMatchObject({ type: 'security_compliance_posture', orgId: 'org-1' });
  });

  it('files a renamed saved business report under Business by its type', async () => {
    fetchWithAuth.mockImplementation((url: string) => {
      if (url === '/reports/templates') {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: [{ id: 'saved-ar-1', name: 'Receivables for the board', type: 'ar_aging', config: {} }],
            }),
        });
      }
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    });
    render(<ReportTemplates />);

    const business = await screen.findByTestId('report-template-group-business');
    await waitFor(() =>
      expect(within(business).getByTestId('report-template-card-saved-ar-1')).toBeInTheDocument(),
    );
    const general = screen.getByTestId('report-template-group-general');
    expect(within(general).queryByTestId('report-template-card-saved-ar-1')).toBeNull();
  });
});
