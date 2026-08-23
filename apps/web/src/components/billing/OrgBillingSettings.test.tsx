import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import OrgBillingSettings from './OrgBillingSettings';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

// The org GET the billing tab loads from. Callers override individual fields.
const orgPayload = (over: Record<string, unknown> = {}) => json({
  taxId: null, taxExempt: false, taxRate: null, currencyCode: 'USD',
  billingContact: null,
  billingAddressLine1: null, billingAddressLine2: null, billingAddressCity: null,
  billingAddressRegion: null, billingAddressPostalCode: null, billingAddressCountry: null,
  ...over,
});
const findPatch = () =>
  fetchMock.mock.calls.find((c) => c[0] === '/orgs/org-1/billing-settings' && (c[1] as RequestInit)?.method === 'PATCH');

describe('OrgBillingSettings — billing contact', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads and shows the saved billing contact email + name', async () => {
    fetchMock.mockResolvedValue(orgPayload({ billingContact: { email: 'ap@customer.example', name: 'AP Dept' } }));
    render(<OrgBillingSettings orgId="org-1" />);
    await waitFor(() =>
      expect((screen.getByTestId('org-billing-contact-email') as HTMLInputElement).value).toBe('ap@customer.example'));
    expect((screen.getByTestId('org-billing-contact-name') as HTMLInputElement).value).toBe('AP Dept');
  });

  it('sends billingContactEmail/Name in the PATCH body when filled', async () => {
    fetchMock.mockImplementation(async (_input: string, opts?: RequestInit) =>
      opts?.method === 'PATCH' ? json({ data: {} }) : orgPayload());
    render(<OrgBillingSettings orgId="org-1" />);
    await waitFor(() => expect(screen.getByTestId('org-billing-settings')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('org-billing-contact-email'), { target: { value: 'billing@customer.example' } });
    fireEvent.change(screen.getByTestId('org-billing-contact-name'), { target: { value: 'Accounts Payable' } });
    fireEvent.click(screen.getByTestId('org-billing-save'));

    await waitFor(() => {
      const patch = findPatch();
      expect(patch).toBeTruthy();
      expect(JSON.parse((patch![1] as RequestInit).body as string)).toMatchObject({
        billingContactEmail: 'billing@customer.example', billingContactName: 'Accounts Payable',
      });
    });
  });

  it('blocks save on a client-invalid contact email (guards the round-trip)', async () => {
    fetchMock.mockImplementation(async (_input: string, opts?: RequestInit) =>
      opts?.method === 'PATCH' ? json({ data: {} }) : orgPayload());
    render(<OrgBillingSettings orgId="org-1" />);
    await waitFor(() => expect(screen.getByTestId('org-billing-settings')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('org-billing-contact-email'), { target: { value: 'not-an-email' } });

    // Inline error shows and the Save button is disabled…
    expect(screen.getByTestId('org-billing-contact-email-error')).toBeInTheDocument();
    expect(screen.getByTestId('org-billing-save')).toBeDisabled();
    // …and even clicking it issues no PATCH (save() early-returns).
    fireEvent.click(screen.getByTestId('org-billing-save'));
    expect(findPatch()).toBeUndefined();

    // Correcting the address clears the error and re-enables save.
    fireEvent.change(screen.getByTestId('org-billing-contact-email'), { target: { value: 'ap@customer.example' } });
    expect(screen.queryByTestId('org-billing-contact-email-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('org-billing-save')).not.toBeDisabled();
  });

  it('serializes a cleared contact email to null (never "") so the schema does not 400', async () => {
    // The linchpin of the design: orgBillingSettingsSchema rejects '' via .email();
    // clearing the field must send null. Mirrors PartnerBillingSettings' address test.
    fetchMock.mockImplementation(async (_input: string, opts?: RequestInit) =>
      opts?.method === 'PATCH' ? json({ data: {} }) : orgPayload({ billingContact: { email: 'ap@customer.example', name: 'AP' } }));
    render(<OrgBillingSettings orgId="org-1" />);
    await waitFor(() =>
      expect((screen.getByTestId('org-billing-contact-email') as HTMLInputElement).value).toBe('ap@customer.example'));

    // Clear the email to whitespace-only, then save.
    fireEvent.change(screen.getByTestId('org-billing-contact-email'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('org-billing-save'));

    await waitFor(() => {
      const patch = findPatch();
      expect(patch).toBeTruthy();
      expect(JSON.parse((patch![1] as RequestInit).body as string).billingContactEmail).toBeNull();
    });
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
    orgDefaultRate: { configured: true, rateCurrency: 'USD', willStopApplying: true },
    categoryRatesSkipped: 2,
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
          orgDefaultRate: { configured: false, rateCurrency: null, willStopApplying: false },
          categoryRatesSkipped: 0,
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
    expect(screen.getByTestId('org-billing-currency-warning-categories')).toHaveTextContent('2');
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
