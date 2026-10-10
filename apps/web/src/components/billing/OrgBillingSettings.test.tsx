import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import OrgBillingSettings from './OrgBillingSettings';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));
const stepUpMint = vi.hoisted(() => vi.fn());
vi.mock('../../lib/mfaStepUp', () => ({ mintStepUpGrant: stepUpMint }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

// The org GET the billing tab loads from. Callers override individual fields.
const orgPayload = (over: Record<string, unknown> = {}) => json({
  taxId: null, taxExempt: false, taxRate: null, currencyCode: 'USD',
  billingContact: null,
  billingAddressLine1: null, billingAddressLine2: null, billingAddressCity: null,
  billingAddressRegion: null, billingAddressPostalCode: null, billingAddressCountry: null,
  // partners.invoice_terms_days is NOT NULL DEFAULT 30, so the API always sends a partner default.
  invoiceTermsDays: null, partnerDefaultInvoiceTermsDays: 30,
  ...over,
});
const findPatch = () =>
  fetchMock.mock.calls.find((c) => c[0] === '/orgs/org-1/billing-settings' && (c[1] as RequestInit)?.method === 'PATCH');

describe('OrgBillingSettings — billing contact', () => {
  // The Billing tab used to edit `billingContact` inline, and the API wrote
  // that into the org's PRIMARY contact — a technical contact's email was
  // overwritten with the billing address. Contact data now has one home, the
  // org record's Contacts tab: this card shows who invoices go to and links
  // there, and Save never sends contact fields.
  beforeEach(() => vi.clearAllMocks());

  it('shows the default recipient read-only and links to the org Contacts tab', async () => {
    fetchMock.mockResolvedValue(orgPayload({ billingContact: { email: 'ap@customer.example', name: 'AP Dept' } }));
    render(<OrgBillingSettings orgId="org-1" />);
    const recipient = await screen.findByTestId('org-billing-contact-recipient');
    expect(recipient).toHaveTextContent('AP Dept');
    expect(recipient).toHaveTextContent('ap@customer.example');
    // Read-only: there is no field to type a contact into.
    expect(screen.queryByTestId('org-billing-contact-email')).not.toBeInTheDocument();
    expect(screen.queryByTestId('org-billing-contact-name')).not.toBeInTheDocument();
    expect(screen.getByTestId('org-billing-contact-manage')).toHaveAttribute('href', '/organizations/org-1#contacts');
  });

  it('says so when no contact has the billing role', async () => {
    fetchMock.mockResolvedValue(orgPayload({ billingContact: null }));
    render(<OrgBillingSettings orgId="org-1" />);
    expect(await screen.findByTestId('org-billing-contact-none')).toBeInTheDocument();
    expect(screen.queryByTestId('org-billing-contact-recipient')).not.toBeInTheDocument();
    expect(screen.getByTestId('org-billing-contact-manage')).toHaveAttribute('href', '/organizations/org-1#contacts');
  });

  it('distinguishes a billing contact with no email address from no billing contact', async () => {
    fetchMock.mockResolvedValue(orgPayload({ billingContact: { name: 'AP Dept', email: null, phone: '555-0100' } }));
    render(<OrgBillingSettings orgId="org-1" />);
    const noEmail = await screen.findByTestId('org-billing-contact-no-email');
    expect(noEmail).toHaveTextContent('AP Dept');
    expect(screen.queryByTestId('org-billing-contact-none')).not.toBeInTheDocument();
  });

  it('never sends billing contact fields on Save', async () => {
    fetchMock.mockImplementation(async (_input: string, opts?: RequestInit) =>
      opts?.method === 'PATCH' ? json({ data: {} }) : orgPayload({ billingContact: { email: 'ap@customer.example', name: 'AP Dept' } }));
    render(<OrgBillingSettings orgId="org-1" />);
    await waitFor(() => expect(screen.getByTestId('org-billing-settings')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('org-billing-save'));

    await waitFor(() => expect(findPatch()).toBeTruthy());
    const body = JSON.parse((findPatch()![1] as RequestInit).body as string);
    expect(body).not.toHaveProperty('billingContactEmail');
    expect(body).not.toHaveProperty('billingContactName');
    // Positive control: the rest of the form is still saved.
    expect(body).toHaveProperty('taxExempt', false);
  });
});

// ---------------------------------------------------------------------------
// Settings rule 4 (blank = inherit, always show the inherited VALUE + source):
// a blank org tax rate must show the resolved partner-default percent in the
// placeholder, not just the word "Partner default" (sweep paper cut #15).
// ---------------------------------------------------------------------------

describe('OrgBillingSettings — tax rate inherited-value placeholder', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the partner default percent as the placeholder, not the words "Partner default"', async () => {
    fetchMock.mockResolvedValue(orgPayload({ taxRate: null, partnerDefaultTaxRate: '0.075' }));
    render(<OrgBillingSettings orgId="org-1" />);
    await waitFor(() => expect(screen.getByTestId('org-billing-settings')).toBeInTheDocument());

    const input = screen.getByTestId('org-billing-taxrate') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('7.5');
    const taxField = within(screen.getByTestId('org-billing-taxrate').parentElement as HTMLElement);
    expect(taxField.getByText(/inherits from partner default/i)).toBeInTheDocument();
  });

  it('shows a "no partner default configured" note when the partner has no default set', async () => {
    fetchMock.mockResolvedValue(orgPayload({ taxRate: null, partnerDefaultTaxRate: null }));
    render(<OrgBillingSettings orgId="org-1" />);
    await waitFor(() => expect(screen.getByTestId('org-billing-settings')).toBeInTheDocument());

    expect((screen.getByTestId('org-billing-taxrate') as HTMLInputElement).placeholder).toBe('');
    const taxField = within(screen.getByTestId('org-billing-taxrate').parentElement as HTMLElement);
    expect(taxField.getByText(/no partner default configured/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Multi-currency wave 6 (#3778): the org currency selector + change flow.
// Selecting a code NEVER mutates — it fetches the advisory impact preview and
// opens a confirmation panel. Only the panel's confirm button PATCHes, and it
// PATCHes a currency-ONLY payload (the service rejects anything else alongside
// currencyCode). A 409 ORG_CURRENCY_CHANGED re-renders the panel against the
// server's fresh summary rather than closing it.
// ---------------------------------------------------------------------------

const impactGroup = (currencyCode: string, over: Record<string, unknown> = {}) => ({
  currencyCode,
  documents: { draftInvoices: 2, draftQuotes: 1, sentQuotes: 0, viewedQuotes: 3 },
  contracts: { draft: 1, active: 4, paused: 0 },
  billables: {
    monetaryTimeSnapshots: 7, readyTimeEntries: 5, runningTimeEntries: 1,
    currentlyNonBillableTimeEntries: 1, missingRateTimeEntries: 2, laborAmount: '1200.00',
    monetaryPartSnapshots: 3, readyParts: 3, currentlyNonBillableParts: 0, partAmount: '99.50',
  },
  recovery: { kind: 'assemble_draft', currencyCode },
  ...over,
});

const impactPayload = (over: Record<string, unknown> = {}) => ({
  orgId: 'org-1',
  currentCurrencyCode: 'USD',
  targetCurrencyCode: 'EUR',
  changeRequired: true,
  impactsByCurrency: [impactGroup('USD')],
  configurationWarnings: {
    assignedBillingProfile: { id: 'silver', currencyCode: 'USD', currencyMismatch: true },
    orgCatalogOverridesSkipped: 4,
    rateLessTimeEntries: 0,
  },
  ...over,
});

const IMPACT_URL = '/orgs/org-1/billing-settings/currency-impact?currencyCode=EUR';

/** GET org → USD; GET impact → the supplied summary; PATCH → `patch`. */
function mockCurrencyFlow(opts: { impact?: unknown; patch?: () => Response } = {}) {
  fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
    if ((init as RequestInit | undefined)?.method === 'PATCH') {
      return opts.patch ? opts.patch() : json({ data: { currencyCode: 'EUR' } });
    }
    if (input.startsWith('/orgs/org-1/billing-settings/currency-impact')) {
      return json({ data: opts.impact ?? impactPayload() });
    }
    return orgPayload();
  });
}

const selectCurrency = (code: string) =>
  fireEvent.change(screen.getByTestId('org-billing-currency'), { target: { value: code } });

describe('OrgBillingSettings — currency selector and change flow', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the org\'s loaded currency as the selected option', async () => {
    // Bound to the FETCHED org — not an orphan <select> whose value reads '',
    // which would make this assertion vacuously true.
    fetchMock.mockResolvedValue(orgPayload({ currencyCode: 'EUR' }));
    render(<OrgBillingSettings orgId="org-1" />);
    await waitFor(() =>
      expect((screen.getByTestId('org-billing-currency') as HTMLSelectElement).value).toBe('EUR'));
  });

  it('reports rate-less unbilled time as its own line, never as a recovery group', async () => {
    mockCurrencyFlow({
      impact: impactPayload({
        impactsByCurrency: [],
        configurationWarnings: {
          assignedBillingProfile: { id: null, currencyCode: null, currencyMismatch: false },
          orgCatalogOverridesSkipped: 0,
          rateLessTimeEntries: 5,
        },
      }),
    });
    render(<OrgBillingSettings orgId="org-1" />);
    await waitFor(() => expect(screen.getByTestId('org-billing-settings')).toBeInTheDocument());

    selectCurrency('EUR');

    await waitFor(() => expect(screen.getByTestId('org-billing-currency-panel')).toBeInTheDocument());
    expect(screen.getByTestId('org-billing-currency-rate-less')).toHaveTextContent('5');
    // Nothing is stranded, so no group and no assemble-draft instruction.
    expect(screen.getByTestId('org-billing-currency-none')).toBeInTheDocument();
    expect(screen.queryByTestId('org-billing-currency-recovery-EUR')).toBeNull();
  });

  it('fetches the impact preview on change, renders it, and PATCHes nothing', async () => {
    mockCurrencyFlow();
    render(<OrgBillingSettings orgId="org-1" />);
    await waitFor(() => expect(screen.getByTestId('org-billing-settings')).toBeInTheDocument());

    selectCurrency('EUR');

    await waitFor(() => expect(screen.getByTestId('org-billing-currency-panel')).toBeInTheDocument());
    const impactCall = fetchMock.mock.calls.find((c) => c[0] === IMPACT_URL);
    expect(impactCall).toBeDefined();
    // The org is already in the path and the API's query schema is `.strict()`:
    // fetchWithAuth's automatic `&orgId=` injection would 400 the preview and
    // silently degrade the panel to its error copy. Regression guard for the
    // defect the wave-6 browser slice caught (#3778).
    expect((impactCall?.[1] as { skipOrgIdInjection?: boolean } | undefined)?.skipOrgIdInjection).toBe(true);
    // Per-currency counts, grouped by the ROW's own stamp.
    expect(screen.getByTestId('org-billing-impact-USD-draftInvoices')).toHaveTextContent('2');
    expect(screen.getByTestId('org-billing-impact-USD-activeContracts')).toHaveTextContent('4');
    expect(screen.getByTestId('org-billing-impact-USD-timeEntries')).toHaveTextContent('7');
    expect(screen.getByTestId('org-billing-impact-USD-parts')).toHaveTextContent('3');
    // Recovery instruction + the three configuration warnings + retention copy.
    expect(screen.getByTestId('org-billing-currency-recovery-USD')).toHaveTextContent('USD');
    expect(screen.getByTestId('org-billing-currency-warning-rate')).toBeInTheDocument();
    expect(screen.queryByTestId('org-billing-currency-warning-categories')).not.toBeInTheDocument();
    expect(screen.getByTestId('org-billing-currency-warning-overrides')).toHaveTextContent('4');
    // Rate-less time is NOT stranded by the change, so it never gets a
    // per-currency "assemble a draft in X" card (#3778, review 6).
    expect(screen.queryByTestId('org-billing-currency-rate-less')).toBeNull();
    expect(screen.getByTestId('org-billing-currency-retention')).toBeInTheDocument();
    // …and NOTHING was mutated.
    expect(findPatch()).toBeUndefined();
  });

  it('PATCHes exactly the currency-only payload on confirm', async () => {
    mockCurrencyFlow();
    render(<OrgBillingSettings orgId="org-1" />);
    await waitFor(() => expect(screen.getByTestId('org-billing-settings')).toBeInTheDocument());

    selectCurrency('EUR');
    await waitFor(() => expect(screen.getByTestId('org-billing-currency-panel')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('org-billing-currency-confirm'));

    await waitFor(() => expect(findPatch()).toBeTruthy());
    const body = JSON.parse((findPatch()![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(body).toEqual({
      currencyCode: 'EUR', expectedCurrentCurrencyCode: 'USD', confirmSnapshotRetention: true,
    });
    // The panel closes on success and the org is reloaded.
    await waitFor(() => expect(screen.queryByTestId('org-billing-currency-panel')).not.toBeInTheDocument());
  });

  it('re-renders the panel with the server summary on a 409 and keeps it open', async () => {
    const fresh = impactPayload({
      currentCurrencyCode: 'GBP',
      impactsByCurrency: [impactGroup('GBP', {
        documents: { draftInvoices: 9, draftQuotes: 0, sentQuotes: 0, viewedQuotes: 0 },
      })],
    });
    mockCurrencyFlow({
      patch: () => json({
        error: 'The organization currency changed since this summary was taken',
        code: 'ORG_CURRENCY_CHANGED',
        details: { currentCurrencyCode: 'GBP', expectedCurrentCurrencyCode: 'USD', impact: fresh },
      }, false, 409),
    });
    render(<OrgBillingSettings orgId="org-1" />);
    await waitFor(() => expect(screen.getByTestId('org-billing-settings')).toBeInTheDocument());

    selectCurrency('EUR');
    await waitFor(() => expect(screen.getByTestId('org-billing-currency-panel')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('org-billing-currency-confirm'));

    // Panel stays open, now showing the server's fresh summary + a stale notice.
    await waitFor(() => expect(screen.getByTestId('org-billing-currency-stale')).toBeInTheDocument());
    expect(screen.getByTestId('org-billing-currency-panel')).toBeInTheDocument();
    expect(screen.getByTestId('org-billing-impact-GBP-draftInvoices')).toHaveTextContent('9');
    expect(screen.queryByTestId('org-billing-impact-USD-draftInvoices')).not.toBeInTheDocument();

    // Re-confirming now carries the server's fresh current code, not the stale one.
    fireEvent.click(screen.getByTestId('org-billing-currency-confirm'));
    await waitFor(() => {
      const bodies = fetchMock.mock.calls
        .filter((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH')
        .map((c) => JSON.parse((c[1] as RequestInit).body as string) as Record<string, unknown>);
      expect(bodies).toHaveLength(2);
      expect(bodies[1].expectedCurrentCurrencyCode).toBe('GBP');
    });
  });

  it('reverts the select to the stored value on cancel', async () => {
    mockCurrencyFlow();
    render(<OrgBillingSettings orgId="org-1" />);
    await waitFor(() => expect(screen.getByTestId('org-billing-settings')).toBeInTheDocument());

    selectCurrency('EUR');
    await waitFor(() => expect(screen.getByTestId('org-billing-currency-panel')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('org-billing-currency-cancel'));

    expect(screen.queryByTestId('org-billing-currency-panel')).not.toBeInTheDocument();
    expect((screen.getByTestId('org-billing-currency') as HTMLSelectElement).value).toBe('USD');
    expect(findPatch()).toBeUndefined();
  });
});

const reminderPermissions = vi.hoisted(() => ({ canManagePayments: true }));
vi.mock('../../lib/permissions', () => ({ usePermissions: () => ({
  can: (resource: string, action: string) => resource === 'billing' && action === 'manage'
    ? reminderPermissions.canManagePayments : true,
}) }));
beforeEach(() => { reminderPermissions.canManagePayments = true; });
it.each([true, false])('preserves tax/address Save when payments cannot load (permission=%s)', async allowed => {
  reminderPermissions.canManagePayments = allowed;
  fetchMock.mockImplementation(async (url, init) => {
    if (String(url).endsWith('/billing/payment-settings')) return json({ error: 'Unavailable' }, false, 403);
    if (url === '/billing-profiles') return json({ profiles: [] });
    if (url === '/billing-profiles/work-types') return json({ workTypes: [] });
    if (String(url).endsWith('/billing-profile')) return json({ assignment: null });
    return orgPayload();
  });
  render(<OrgBillingSettings orgId="org-1" />);
  fireEvent.change(await screen.findByTestId('org-billing-taxid'), { target: { value: 'TEST-TAX' } });
  await waitFor(() => expect(screen.getByTestId('org-billing-save')).not.toBeDisabled());
  fireEvent.click(screen.getByTestId('org-billing-save'));
  await waitFor(() => expect(findPatch()).toBeDefined());
  expect(JSON.parse(findPatch()![1]!.body as string)).toMatchObject({ taxId: 'TEST-TAX' });
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
});


const standardProfile = { id: 'standard', name: 'Standard rates', currencyCode: 'USD', isActive: true, isDefault: true, baseCoverage: 'billable', baseHourlyRate: '150.00', baseMinimumMinutes: null, roundingIncrementMinutes: null, rules: [] };
function profileApi(assignment: string | null = null, currency = 'USD', failSave = false) {
  fetchMock.mockImplementation(async (url, init) => {
    if (url === '/billing-profiles') return json({ profiles: [standardProfile, { ...standardProfile, id: 'silver', name: 'Silver', isDefault: false, currencyCode: currency, baseCoverage: 'included' }] });
    if (url === '/billing-profiles/work-types') return json({ workTypes: [] });
    if (String(url).endsWith('/billing-profile')) {
      return json({ assignment: assignment ? { billingProfileId: assignment } : null });
    }
    if (init?.method === 'PATCH' && failSave) return json({ error: 'Cannot assign profile' }, false, 409);
    return orgPayload();
  });
}
describe('OrgBillingSettings billing profile', () => {
  beforeEach(() => vi.clearAllMocks());
  it('shows the inherited profile and its read-only base rate', async () => {
    profileApi();
    render(<OrgBillingSettings orgId="org-1" />);
    expect(await screen.findByTestId('org-billing-profile')).toHaveValue('');
    expect(screen.getByTestId('org-billing-profile-rates')).toHaveTextContent('150.00');
    expect(screen.getByTestId('org-billing-profile-rates')).toHaveTextContent('Standard rates');
  });
  it('stages the assignment and saves it with the other settings in one PATCH', async () => {
    profileApi();
    render(<OrgBillingSettings orgId="org-1" />);
    fireEvent.change(await screen.findByTestId('org-billing-profile'), { target: { value: 'silver' } });
    fireEvent.change(screen.getByTestId('org-billing-taxid'), { target: { value: 'VAT-123' } });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
    fireEvent.click(screen.getByTestId('org-billing-save'));
    await waitFor(() => expect(findPatch()).toBeDefined());
    expect(JSON.parse(findPatch()![1]!.body as string)).toMatchObject({ billingProfileId: 'silver', taxId: 'VAT-123' });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method)).toHaveLength(1);
    await waitFor(() => expect(screen.getByTestId('org-billing-save')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('org-billing-save'));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method)).toHaveLength(2));
    const lastPatch = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')[1];
    expect(JSON.parse(lastPatch[1]!.body as string)).not.toHaveProperty('billingProfileId');
  });
  it('clears an assignment with billingProfileId null in the page PATCH', async () => {
    profileApi('silver');
    render(<OrgBillingSettings orgId="org-1" />);
    fireEvent.change(await screen.findByTestId('org-billing-profile'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('org-billing-save'));
    await waitFor(() => expect(findPatch()).toBeDefined());
    expect(JSON.parse(findPatch()![1]!.body as string)).toHaveProperty('billingProfileId', null);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method)).toHaveLength(1);
  });
  it('shows currency mismatch and the fallback profile', async () => {
    profileApi('silver', 'EUR');
    render(<OrgBillingSettings orgId="org-1" />);
    expect(await screen.findByTestId('org-billing-profile-mismatch')).toBeInTheDocument();
    expect(screen.getByTestId('org-billing-profile-rates')).toHaveTextContent('Standard rates');
  });
  it('surfaces assignment failure through runAction', async () => {
    profileApi(null, 'USD', true);
    render(<OrgBillingSettings orgId="org-1" />);
    fireEvent.change(await screen.findByTestId('org-billing-profile'), { target: { value: 'silver' } });
    fireEvent.click(screen.getByTestId('org-billing-save'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'Cannot assign profile' })));
  });
});

describe('OrgBillingSettings assignment save consistency', () => {
  beforeEach(() => vi.clearAllMocks());
  it('locks the assignment selector while a page save is pending', async () => {
    profileApi();
    const base = fetchMock.getMockImplementation()!;
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation((url, init) => init?.method === 'PATCH'
      ? new Promise<Response>(resolve => { finish = resolve; }) : base(url, init));
    render(<OrgBillingSettings orgId="org-1" />);
    const selector = await screen.findByTestId('org-billing-profile');
    fireEvent.change(selector, { target: { value: 'silver' } });
    fireEvent.click(screen.getByTestId('org-billing-save'));
    await waitFor(() => expect(selector).toBeDisabled());
    finish(json({ assignment: { billingProfileId: 'silver' } }));
    await waitFor(() => expect(screen.getByTestId('org-billing-save')).not.toBeDisabled());
  });

  it('keeps the assignment staged after a failed atomic save and includes it on retry', async () => {
    profileApi(null, 'USD', true);
    render(<OrgBillingSettings orgId="org-1" />);
    fireEvent.change(await screen.findByTestId('org-billing-profile'), { target: { value: 'silver' } });
    fireEvent.click(screen.getByTestId('org-billing-save'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    await waitFor(() => expect(screen.getByTestId('org-billing-save')).not.toBeDisabled());
    expect(screen.queryByTestId('org-billing-partial-save')).not.toBeInTheDocument();
    expect(screen.getByTestId('org-billing-profile')).toHaveValue('silver');
    profileApi();
    fireEvent.click(screen.getByTestId('org-billing-save'));
    await waitFor(() => expect(screen.getByTestId('org-billing-save')).not.toBeDisabled());
    const mutations = fetchMock.mock.calls.filter(([, init]) => init?.method);
    expect(mutations).toHaveLength(2);
    for (const [url, init] of mutations) {
      expect(url).toBe('/orgs/org-1/billing-settings');
      expect(init?.method).toBe('PATCH');
      expect(JSON.parse(init!.body as string)).toHaveProperty('billingProfileId', 'silver');
    }
  });

  it('omits an unchanged assignment from the page PATCH', async () => {
    profileApi('silver');
    render(<OrgBillingSettings orgId="org-1" />);
    await screen.findByTestId('org-billing-profile');
    fireEvent.click(screen.getByTestId('org-billing-save'));
    await waitFor(() => expect(findPatch()).toBeDefined());
    expect(JSON.parse(findPatch()![1]!.body as string)).not.toHaveProperty('billingProfileId');
  });
});

// ---------------------------------------------------------------------------
// Settings consolidation W06 (#6229): org payment-terms override. Blank =
// inherit the partner default, shown as the placeholder VALUE (rule 4). Saved
// through the page Save (runAction); cleared sends null, never ''.
// ---------------------------------------------------------------------------

describe('OrgBillingSettings — payment terms override', () => {
  beforeEach(() => vi.clearAllMocks());

  const withPatch = (over: Record<string, unknown> = {}) =>
    fetchMock.mockImplementation(async (_input: string, opts?: RequestInit) =>
      opts?.method === 'PATCH' ? json({ data: {} }) : orgPayload(over));

  it('shows the partner default days as the placeholder when the org inherits', async () => {
    fetchMock.mockResolvedValue(orgPayload({ invoiceTermsDays: null, partnerDefaultInvoiceTermsDays: 30 }));
    render(<OrgBillingSettings orgId="org-1" />);
    await waitFor(() => expect(screen.getByTestId('org-billing-settings')).toBeInTheDocument());
    const input = screen.getByTestId('org-billing-terms-days') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('30');
  });

  it('loads a saved override of 0 as "0", not blank', async () => {
    fetchMock.mockResolvedValue(orgPayload({ invoiceTermsDays: 0, partnerDefaultInvoiceTermsDays: 30 }));
    render(<OrgBillingSettings orgId="org-1" />);
    await waitFor(() =>
      expect((screen.getByTestId('org-billing-terms-days') as HTMLInputElement).value).toBe('0'));
  });

  it('PATCHes the override as a number', async () => {
    withPatch({ invoiceTermsDays: null, partnerDefaultInvoiceTermsDays: 30 });
    render(<OrgBillingSettings orgId="org-1" />);
    await waitFor(() => expect(screen.getByTestId('org-billing-settings')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('org-billing-terms-days'), { target: { value: '14' } });
    fireEvent.click(screen.getByTestId('org-billing-save'));
    await waitFor(() => {
      const patch = findPatch();
      expect(patch).toBeTruthy();
      expect(JSON.parse((patch![1] as RequestInit).body as string).invoiceTermsDays).toBe(14);
    });
  });

  it('clearing the override sends null (inherit), never ""', async () => {
    withPatch({ invoiceTermsDays: 14, partnerDefaultInvoiceTermsDays: 30 });
    render(<OrgBillingSettings orgId="org-1" />);
    await waitFor(() =>
      expect((screen.getByTestId('org-billing-terms-days') as HTMLInputElement).value).toBe('14'));
    fireEvent.change(screen.getByTestId('org-billing-terms-days'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('org-billing-save'));
    await waitFor(() => {
      const patch = findPatch();
      expect(patch).toBeTruthy();
      expect(JSON.parse((patch![1] as RequestInit).body as string).invoiceTermsDays).toBeNull();
    });
  });

  it.each(['366', '-1', '2.5'])('blocks save on an out-of-range value %s', async (value) => {
    withPatch({ invoiceTermsDays: null, partnerDefaultInvoiceTermsDays: 30 });
    render(<OrgBillingSettings orgId="org-1" />);
    await waitFor(() => expect(screen.getByTestId('org-billing-settings')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('org-billing-terms-days'), { target: { value } });
    expect(screen.getByTestId('org-billing-terms-days-error')).toBeInTheDocument();
    expect(screen.getByTestId('org-billing-save')).toBeDisabled();
    fireEvent.click(screen.getByTestId('org-billing-save'));
    expect(findPatch()).toBeUndefined();
  });
});

describe('OrgBillingSettings resolved card AI usage', () => {
  beforeEach(() => vi.clearAllMocks());
  const aiApi = (assignment: string | null, ai: Record<string, unknown>) => {
    fetchMock.mockImplementation(async (url) => {
      if (url === '/billing-profiles') return json({ profiles: [
        { ...standardProfile, ...ai },
        { ...standardProfile, id: 'silver', name: 'Silver', isDefault: false, aiCoverage: 'included', aiMarkupPercent: null, aiRates: [] },
      ] });
      if (url === '/billing-profiles/work-types') return json({ workTypes: [] });
      if (String(url).endsWith('/billing-profile')) return json({ assignment: assignment ? { billingProfileId: assignment } : null });
      return orgPayload();
    });
  };

  it('shows the inherited default card AI terms read-only under the resolved card', async () => {
    aiApi(null, { aiCoverage: 'billable', aiMarkupPercent: '25.00', aiRates: [] });
    render(<OrgBillingSettings orgId="org-1" />);
    const line = await screen.findByTestId('org-billing-profile-ai');
    expect(line).toHaveTextContent('AI usage: Billable · cost +25%');
    expect(line.closest('[data-testid="org-billing-profile-rates"]')).not.toBeNull();
    expect(line.querySelector('input, select, button')).toBeNull();
  });

  it('describes a price-list card and follows a staged assignment without any request', async () => {
    aiApi(null, { aiCoverage: 'billable', aiMarkupPercent: null, aiRates: [
      { modelId: 'a', inputPricePerM: '3', outputPricePerM: '15', cacheReadPricePerM: '0.3', cacheWritePricePerM: '3.75' },
      { modelId: 'b', inputPricePerM: '1', outputPricePerM: '5', cacheReadPricePerM: '0.1', cacheWritePricePerM: '1.25' },
    ] });
    render(<OrgBillingSettings orgId="org-1" />);
    expect(await screen.findByTestId('org-billing-profile-ai')).toHaveTextContent('AI usage: Billable · price list (2 models)');
    fireEvent.change(screen.getByTestId('org-billing-profile'), { target: { value: 'silver' } });
    expect(screen.getByTestId('org-billing-profile-ai')).toHaveTextContent('AI usage: Included');
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
  });

  it('reads a profile without AI fields as Not billed', async () => {
    aiApi('standard', {});
    render(<OrgBillingSettings orgId="org-1" />);
    expect(await screen.findByTestId('org-billing-profile-ai')).toHaveTextContent('AI usage: Not billed');
  });
});

it('mounts org reminders independently of enrollment rollout', async () => {
  const fields = {
    autopayOffsetDays: { value: 0, source: 'default' }, autopayOffsetRule: { value: 'later', source: 'default' },
    autopayCap: { value: { enabled: false }, source: 'default' }, achMode: { value: 'ach_preferred', source: 'default' },
    cardFeeBps: { value: 0, source: 'default' }, achFeeAmount: { value: '0.00', source: 'default' }, feeAttested: false,
    remindersEnabled: { value: false, source: 'default' },
    reminderBeforeDueDays: { value: 3, source: 'default' },
    reminderRepeatDays: { value: null, source: 'default' },
    overdueReminderEveryDays: { value: 7, source: 'default' },
  };
  fetchMock.mockImplementation(async url => {
    if (String(url).endsWith('/billing/payment-settings')) return json({
      effective: fields, inherited: fields, autopayEnabled: false,
      values: { autopayOffsetDays: null, autopayOffsetRule: null, autopayCapEnabled: null, autopayCapAmount: null, autopayCapCurrency: null, achMode: null, cardFeeBps: null, achFeeAmount: null },
    });
    if (url === '/billing-profiles') return json({ profiles: [] });
    return json({ id: '11111111-1111-4111-8111-111111111111', currencyCode: 'USD', billingContact: null });
  });
  render(<OrgBillingSettings orgId="11111111-1111-4111-8111-111111111111" />);
  expect(await screen.findByTestId('autopay-payments-shell')).toBeInTheDocument();
  expect(await screen.findByTestId('autopay-reminders-section')).toBeInTheDocument();
  expect(screen.queryByTestId('autopay-settings-section')).toBeNull();
});

describe('OrgBillingSettings reminder Save integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const fields = {
      autopayOffsetDays: { value: 0, source: 'default' },
      autopayOffsetRule: { value: 'later', source: 'default' },
      autopayCap: { value: { enabled: false }, source: 'default' },
      achMode: { value: 'ach_preferred', source: 'default' },
      cardFeeBps: { value: 0, source: 'default' }, achFeeAmount: { value: '0.00', source: 'default' }, feeAttested: false,
      remindersEnabled: { value: false, source: 'default' },
      reminderBeforeDueDays: { value: 5, source: 'partner' },
      reminderRepeatDays: { value: null, source: 'default' },
      overdueReminderEveryDays: { value: 7, source: 'default' },
    };
    fetchMock.mockImplementation(async url => {
      if (String(url).endsWith('/billing/payment-settings')) return json({
        autopayEnabled: false, effective: fields, inherited: fields,
        values: { autopayOffsetDays: null, autopayOffsetRule: null, autopayCapEnabled: null,
          autopayCapAmount: null, autopayCapCurrency: null, achMode: null, cardFeeBps: null, achFeeAmount: null },
      });
      if (url === '/billing-profiles') return json({ profiles: [] });
      if (url === '/billing-profiles/work-types') return json({ workTypes: [] });
      if (String(url).endsWith('/billing-profile')) return json({ assignment: null });
      return orgPayload();
    });
  });

  it('saves reminder fields through the single page Save while enrollment is disabled', async () => {
    render(<OrgBillingSettings orgId="org-1" />);
    const before = await screen.findByTestId('autopay-reminders-before');
    expect(before).toHaveValue(null);
    expect(before).toHaveAttribute('placeholder', '5');
    expect(screen.queryByTestId('autopay-settings-save')).toBeNull();
    fireEvent.change(before, { target: { value: '9' } });
    fireEvent.change(screen.getByTestId('autopay-reminders-enabled'), { target: { value: 'false' } });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
    fireEvent.click(screen.getByTestId('org-billing-save'));
    await waitFor(() => expect(findPatch()).toBeDefined());
    const puts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0][0]).toBe('/orgs/org-1/billing/payment-settings');
    expect(JSON.parse(puts[0][1]!.body as string)).toEqual({
      remindersEnabled: false, reminderBeforeDueDays: 9, reminderRepeatDays: null, overdueReminderEveryDays: null,
    });
  });

  it('blocks both page mutations when a loaded reminder interval is invalid', async () => {
    render(<OrgBillingSettings orgId="org-1" />);
    fireEvent.change(await screen.findByTestId('autopay-reminders-before'), { target: { value: '32' } });
    expect(screen.getByTestId('org-billing-save')).toBeDisabled();
    fireEvent.click(screen.getByTestId('org-billing-save'));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
  });
});

function feeView(enabled=true){
  const effective={autopayOffsetDays:{value:0,source:'default'},autopayOffsetRule:{value:'later',source:'default'},
    autopayCap:{value:{enabled:false},source:'default'},achMode:{value:'ach_preferred',source:'default'},
    cardFeeBps:{value:300,source:'partner'},achFeeAmount:{value:'2.50',source:'partner'},feeAttested:true,
    remindersEnabled:{value:false,source:'default'},reminderBeforeDueDays:{value:3,source:'default'},
    reminderRepeatDays:{value:null,source:'default'},overdueReminderEveryDays:{value:7,source:'default'}};
  return {autopayEnabled:enabled,effective,inherited:effective,values:{autopayOffsetDays:null,autopayOffsetRule:null,
    autopayCapEnabled:null,autopayCapAmount:null,autopayCapCurrency:null,achMode:null,cardFeeBps:null,achFeeAmount:null}};
}

it('mounts inherited fees without partner attestation in the org page',async()=>{
  fetchMock.mockImplementation(async path=>String(path).endsWith('/payment-settings')?json(feeView()):
    String(path).endsWith('/autopay')?json({status:'not_requested',method:null}):orgPayload());
  render(<OrgBillingSettings orgId="11111111-1111-4111-8111-111111111111"/>);
  expect(await screen.findByTestId('autopay-org-fee-settings-page')).toBeInTheDocument();
  expect(await screen.findByTestId('autopay-card-fee-bps')).toHaveAttribute('placeholder','300');
  expect(screen.queryByTestId('autopay-attest-notified')).toBeNull();
});

// The org's own payment settings override the partner's: changing one asks for
// a second-factor confirmation, so a Save that changes none of them (a tax ID
// or address edit) must not send the payment-settings PUT at all.
describe('OrgBillingSettings payment-settings Save and second-factor confirmation', () => {
  const path = '/orgs/org-1/billing/payment-settings';
  const puts = () => fetchMock.mock.calls.filter(([url, init]) => url === path && init?.method === 'PUT')
    .map(([, init]) => JSON.parse(init!.body as string) as Record<string, unknown>);
  beforeEach(() => {
    vi.clearAllMocks();
    stepUpMint.mockResolvedValue('grant-org');
    const base = feeView();
    // Stored org overrides, so an untouched draft is not all-blank.
    const view = { ...base, values: { ...base.values, cardFeeBps: 150, autopayCapEnabled: true,
      autopayCapAmount: '500.00', autopayCapCurrency: 'USD' } };
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/users/me') return Response.json({ mfaEnabled: true, mfaMethod: 'totp' });
      if (url === '/auth/passkeys') return Response.json([]);
      if (url === path && init?.method === 'PUT') {
        const { stepUpGrant, ...settings } = JSON.parse(init.body as string);
        return stepUpGrant ? Response.json({ data: {} }) : Response.json({ error: 'Step-up required', code: 'STEP_UP_REQUIRED',
          stepUp: { operation: 'org_payment_settings_update', resource: { orgId: 'org-1', settings } } }, { status: 403 });
      }
      if (url === path) return json(view);
      if (String(url).endsWith('/autopay')) return json({ status: 'not_requested', method: null });
      if (init?.method === 'PATCH') return json({ data: {} });
      return orgPayload();
    });
  });

  it('sends no payment-settings PUT when only non-payment fields changed', async () => {
    render(<OrgBillingSettings orgId="org-1" />);
    await screen.findByTestId('autopay-card-fee-bps');
    fireEvent.change(screen.getByTestId('org-billing-taxid'), { target: { value: 'GB123' } });
    fireEvent.click(screen.getByTestId('org-billing-save'));
    await waitFor(() => expect(findPatch()).toBeDefined());
    expect(JSON.parse((findPatch()![1] as RequestInit).body as string)).toHaveProperty('taxId', 'GB123');
    expect(puts()).toHaveLength(0);
    expect(screen.queryByTestId('billing-stepup')).toBeNull();
    expect(stepUpMint).not.toHaveBeenCalled();
  });

  it('asks for a confirmation when a payment setting changed and resubmits the same values with the grant', async () => {
    render(<OrgBillingSettings orgId="org-1" />);
    fireEvent.change(await screen.findByTestId('autopay-card-fee-bps'), { target: { value: '300' } });
    fireEvent.click(screen.getByTestId('org-billing-save'));
    fireEvent.change(await screen.findByTestId('billing-stepup-code'), { target: { value: '333444' } });
    // Nothing else is saved while the confirmation is open.
    expect(findPatch()).toBeUndefined();
    fireEvent.click(screen.getByTestId('billing-stepup-confirm'));
    await waitFor(() => expect(findPatch()).toBeDefined());
    const [first, second] = puts();
    expect(first).toMatchObject({ cardFeeBps: 300, autopayCapAmount: '500.00' });
    expect(second).toEqual({ ...first, stepUpGrant: 'grant-org' });
    expect(stepUpMint).toHaveBeenCalledWith({ operation: 'org_payment_settings_update',
      resource: { orgId: 'org-1', settings: first }, reauth: { method: 'totp', code: '333444' } });
    await waitFor(() => expect(screen.queryByTestId('billing-stepup')).toBeNull());
  });

  it('saves nothing else when the confirmation is closed', async () => {
    render(<OrgBillingSettings orgId="org-1" />);
    fireEvent.change(await screen.findByTestId('autopay-card-fee-bps'), { target: { value: '300' } });
    fireEvent.change(screen.getByTestId('org-billing-taxid'), { target: { value: 'GB123' } });
    fireEvent.click(screen.getByTestId('org-billing-save'));
    fireEvent.click(await screen.findByTestId('billing-stepup-cancel'));
    await waitFor(() => expect(screen.getByTestId('org-billing-save')).not.toBeDisabled());
    expect(puts()).toHaveLength(1);
    expect(findPatch()).toBeUndefined();
    // The draft is kept for another try.
    expect(screen.getByTestId('autopay-card-fee-bps')).toHaveValue(300);
    expect(screen.getByTestId('org-billing-taxid')).toHaveValue('GB123');
  });
});
