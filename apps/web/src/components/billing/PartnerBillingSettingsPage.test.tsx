import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '../../lib/i18n';

import PartnerBillingSettingsPage from './PartnerBillingSettingsPage';
import { fetchWithAuth } from '../../stores/auth';
import { partnerCurrencyCache } from '@/lib/partnerCurrencyCache';

// canManagePartnerWide mirrors /users/me (API's canManagePartnerWidePolicies); undefined = not yet known.
let canManagePartnerWide: boolean | undefined = true;
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (sel: (s: { user: { canManagePartnerWide?: boolean } }) => unknown) => sel({ user: { canManagePartnerWide } }),
}));
// Grants for the billing-write gate (invoices:write, same as the PATCH route).
let canWrite = true;
vi.mock('../../lib/permissions', () => ({ usePermissions: () => ({ can: () => canWrite }) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function renderPage() {
  return render(<I18nextProvider i18n={i18n}><PartnerBillingSettingsPage /></I18nextProvider>);
}

// OverflowTabs measures button widths via `offsetWidth`, which jsdom always
// reports as 0 — against a `clientWidth` of 0 that collapses to "fits 1 tab"
// (see computeVisible in OverflowTabs.tsx), so every tab past Defaults ends
// up inside the "More" dropdown in tests. Open it before selecting any tab
// other than the first.
async function selectTab(id: string) {
  const testId = id === 'payments' ? 'autopay-payments-tab' : `billing-settings-tab-${id}`;
  const visible = screen.queryByTestId(testId);
  if (visible?.getAttribute('role') === 'tab') {
    await userEvent.click(visible);
    return;
  }
  await userEvent.click(await screen.findByTestId('billing-settings-tab-more'));
  await userEvent.click(await screen.findByTestId(testId));
}

async function gotoDocumentsTab() {
  await selectTab('documents');
}

describe('PartnerBillingSettingsPage', () => {
it.each([false, true])('mounts Payments when autopayEnabled=%s', async autopayEnabled => {
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
      effective: fields, inherited: fields, autopayEnabled,
      values: { autopayOffsetDays: null, autopayOffsetRule: null, autopayCapEnabled: null, autopayCapAmount: null, autopayCapCurrency: null, achMode: null },
    });
    return json({ currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30 });
  });
  window.location.hash = '#payments';
  renderPage();
  expect(await screen.findByTestId('autopay-payments-shell')).toBeInTheDocument();
  expect(await screen.findByTestId('autopay-reminders-section')).toBeInTheDocument();
  expect(screen.queryByTestId('autopay-settings-section') !== null).toBe(autopayEnabled);
  expect(window.location.hash).toBe('#payments');
  await selectTab('defaults');
  await selectTab('payments');
  expect(await screen.findByTestId('autopay-reminders-section')).toBeInTheDocument();
});

  beforeEach(() => {
    vi.clearAllMocks();
    canWrite = true;
    canManagePartnerWide = true;
    window.location.hash = '';
  });

  it('has five tabs in order: Defaults, Documents, Rates, Payments, Connections (Documents onward behind "More" under jsdom)', async () => {
    fetchMock.mockResolvedValue(json({ currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30 }));
    renderPage();
    expect(await screen.findByTestId('billing-settings-tab-defaults')).toBeInTheDocument();
    await userEvent.click(await screen.findByTestId('billing-settings-tab-more'));
    expect(screen.getByTestId('billing-settings-tab-documents')).toBeInTheDocument();
    expect(screen.getByTestId('billing-settings-tab-connections')).toBeInTheDocument();
    const order = ['billing-settings-tab-defaults', ...['documents', 'rates'].map(id => `billing-settings-tab-${id}`), 'autopay-payments-tab', 'billing-settings-tab-connections'];
    expect(screen.getAllByRole('tab').map(tab => tab.getAttribute('data-testid'))).toEqual([order[0]]);
    expect(screen.getAllByRole('menuitem').map(item => item.getAttribute('data-testid'))).toEqual(order.slice(1));
  });

  it('the active tab\'s aria-controls resolves to a tabpanel labelled by that tab', async () => {
    fetchMock.mockResolvedValue(json({ currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30 }));
    renderPage();
    const tab = await screen.findByTestId('billing-settings-tab-defaults');
    const controls = tab.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    const panel = document.getElementById(controls!);
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute('role', 'tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', tab.id);
    expect(panel).toContainElement(screen.getByTestId('partner-billing-currency'));
  });

  it('renders AccessDenied (no Retry) when GET /orgs/partners/me is 403', async () => {
    fetchMock.mockResolvedValue(json({ error: 'forbidden' }, false, 403));
    renderPage();
    expect(await screen.findByTestId('partner-billing-denied')).toBeInTheDocument();
    expect(screen.queryByTestId('partner-billing-load-error')).not.toBeInTheDocument();
  });

  it('is read-only without invoices:write: inputs disabled, no Save, notice shown', async () => {
    canWrite = false;
    fetchMock.mockResolvedValue(json({ currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30 }));
    renderPage();
    const currency = await screen.findByTestId('partner-billing-currency');
    expect(currency).toBeDisabled();
    expect(screen.getByTestId('partner-billing-prefix')).toBeDisabled();
    expect(screen.queryByTestId('partner-billing-save')).not.toBeInTheDocument();
    expect(screen.getByTestId('partner-billing-readonly')).toBeInTheDocument();
    expect(screen.getByTestId('partner-billing-readonly')).not.toHaveTextContent(/all organizations/i);
  });

  it('shows the plain notice (not the partner-wide one) when both the grant and partner-wide access are missing', async () => {
    canWrite = false;
    canManagePartnerWide = false;
    fetchMock.mockResolvedValue(json({ currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30 }));
    renderPage();
    expect(await screen.findByTestId('partner-billing-readonly')).not.toHaveTextContent(/all organizations/i);
    expect(screen.getByTestId('partner-billing-currency')).toBeDisabled();
  });

  it('is read-only with a partner-wide-specific notice when invoices:write is held but partner-wide access is not (#7517)', async () => {
    canManagePartnerWide = false;
    fetchMock.mockResolvedValue(json({ currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30 }));
    renderPage();
    expect(await screen.findByTestId('partner-billing-currency')).toBeDisabled();
    expect(screen.queryByTestId('partner-billing-save')).not.toBeInTheDocument();
    expect(screen.getByTestId('partner-billing-readonly')).toHaveTextContent(/all organizations/i);
  });

  it('stays editable when partner-wide capability is not yet known (server still enforces)', async () => {
    canManagePartnerWide = undefined;
    fetchMock.mockResolvedValue(json({ currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30 }));
    renderPage();
    expect(await screen.findByTestId('partner-billing-currency')).toBeEnabled();
    expect(screen.getByTestId('partner-billing-save')).toBeEnabled();
  });

  it('keeps the form editable with a Save button when invoices:write is held', async () => {
    fetchMock.mockResolvedValue(json({ currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30 }));
    renderPage();
    expect(await screen.findByTestId('partner-billing-currency')).toBeEnabled();
    expect(screen.getByTestId('partner-billing-save')).toBeEnabled();
    expect(screen.queryByTestId('partner-billing-readonly')).not.toBeInTheDocument();
  });

  it('mounts Rates and its work types manager when selected, with row saves only', async () => {
    fetchMock.mockImplementation(async (url: string) => json(url === '/billing-profiles' ? { profiles: [] } : url.includes('work-types') ? { workTypes: [] } : { currencyCode: 'USD' }));
    renderPage();
    await selectTab('rates');
    expect(await screen.findByTestId('billing-rates-tab')).toBeInTheDocument();
    expect(await screen.findByTestId('work-types-card')).toBeInTheDocument();
    expect(screen.queryByTestId('partner-billing-save')).not.toBeInTheDocument();
    expect(window.location.hash).toBe('#rates');
  });

  it('mounts Rates from the hash', async () => {
    window.location.hash = 'rates';
    fetchMock.mockImplementation(async (url: string) => json(url === '/billing-profiles' ? { profiles: [] } : url.includes('work-types') ? { workTypes: [] } : { currencyCode: 'USD' }));
    renderPage();
    expect(await screen.findByTestId('billing-rates-tab')).toBeInTheDocument();
    // Rates is the active tab but collapsed behind "More" under jsdom; the
    // trigger relabels itself to the active overflow tab (see OverflowTabs).
    expect(await screen.findByTestId('billing-settings-tab-more')).toHaveTextContent('Rates');
  });

  it('one Save button submits the full payload regardless of which tab is active; markup moved to Catalog', async () => {
    fetchMock.mockResolvedValue(json({ currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30 }));
    renderPage();
    await gotoDocumentsTab();
    expect(screen.getByTestId('partner-billing-save')).toBeInTheDocument();
    expect(screen.queryByTestId('partner-billing-markup')).not.toBeInTheDocument();
    expect(screen.queryByTestId('partner-billing-auto-tax-hardware')).not.toBeInTheDocument();
    expect(screen.queryByTestId('partner-billing-ai-style')).not.toBeInTheDocument();
  });

  it('the Connections tab renders the real BillingConnectionsTab, not a placeholder (M6)', async () => {
    fetchMock.mockResolvedValue(json({ currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30 }));
    renderPage();
    await selectTab('connections');
    expect(await screen.findByTestId('billing-connections-tab')).toBeInTheDocument();
    expect(screen.queryByTestId('billing-connections-tab-placeholder')).not.toBeInTheDocument();
  });

  it('the Connections tab has no editable fields, so it must not render the Save button either (G2-3)', async () => {
    fetchMock.mockResolvedValue(json({ currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30 }));
    renderPage();
    await selectTab('connections');
    expect(await screen.findByTestId('billing-connections-tab')).toBeInTheDocument();
    expect(screen.queryByTestId('partner-billing-save')).not.toBeInTheDocument();
  });

  it('blank company name shows the partner name it falls back to on documents (sweep C3)', async () => {
    fetchMock.mockResolvedValue(json({
      currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30,
      name: 'Default Partner', billingCompanyName: null,
    }));
    renderPage();
    await gotoDocumentsTab();
    await waitFor(() =>
      expect(screen.getByTestId('partner-billing-company-name')).toHaveAttribute('placeholder', 'Default Partner'),
    );
    expect((screen.getByTestId('partner-billing-company-name') as HTMLInputElement).value).toBe('');
  });

  it('loads and shows the seller company name', async () => {
    fetchMock.mockResolvedValue(json({
      currencyCode: 'USD', defaultTaxRate: null, invoiceNumberPrefix: 'INV',
      invoiceTermsDays: 30, invoiceFooter: null,
      billingCompanyName: 'Acme MSP LLC',
      billingPhone: null, billingWebsite: null,
      billingAddressLine1: null, billingAddressLine2: null,
      billingAddressCity: null, billingAddressRegion: null,
      billingAddressPostalCode: null, billingAddressCountry: null,
      billingTermsAndConditions: null,
    }));
    renderPage();
    await gotoDocumentsTab();
    await waitFor(() =>
      expect((screen.getByTestId('partner-billing-company-name') as HTMLInputElement).value).toBe('Acme MSP LLC'),
    );
  });

  it('loads partner billing and shows the tax rate as a percentage', async () => {
    fetchMock.mockResolvedValue(json({
      currencyCode: 'EUR', defaultTaxRate: '0.085', invoiceNumberPrefix: 'EU',
      invoiceTermsDays: 14, invoiceFooter: 'Thanks',
    }));
    renderPage();
    await waitFor(() => expect(screen.getByTestId('partner-billing-settings')).toBeInTheDocument());
    expect((screen.getByTestId('partner-billing-currency') as HTMLInputElement).value).toBe('EUR');
    // 0.085 fraction -> 8.5 percent
    expect((screen.getByTestId('partner-billing-tax') as HTMLInputElement).value).toBe('8.5');
    expect((screen.getByTestId('partner-billing-prefix') as HTMLInputElement).value).toBe('EU');
  });

  /**
   * #3204 turned the free-text currency field into a <select>. A select whose
   * value is absent from its options silently reads back '' and would then be
   * SAVED as '' — wiping a partner's currency on any unrelated edit. Off-list
   * codes (historical, or set before the curated list existed) must survive.
   */
  it('keeps an off-list stored currency selectable instead of resetting it', async () => {
    fetchMock.mockResolvedValue(json({
      currencyCode: 'ISK', defaultTaxRate: null, invoiceNumberPrefix: 'INV',
      invoiceTermsDays: 30, invoiceFooter: null,
    }));
    renderPage();
    await waitFor(() => expect(screen.getByTestId('partner-billing-settings')).toBeInTheDocument());
    expect((screen.getByTestId('partner-billing-currency') as HTMLSelectElement).value).toBe('ISK');
  });

  it('saves, converting the percentage back to a fraction', async () => {
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (opts?.method === 'PATCH') return json({ data: {} });
      return json({ currencyCode: 'USD', defaultTaxRate: null, invoiceNumberPrefix: 'INV', invoiceTermsDays: 30, invoiceFooter: null });
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('partner-billing-settings')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('partner-billing-tax'), { target: { value: '7' } });
    fireEvent.click(screen.getByTestId('partner-billing-save'));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find((c) => c[0] === '/partner/billing-settings' && (c[1] as RequestInit)?.method === 'PATCH');
      expect(patch).toBeTruthy();
      expect(JSON.parse((patch![1] as RequestInit).body as string)).toMatchObject({ defaultTaxRate: 0.07, currencyCode: 'USD' });
    });
  });

  it('resets the cached partner currency on a successful save so stale money labels/totals cannot survive', async () => {
    fetchMock.mockImplementation(async (_input: string, opts?: RequestInit) => {
      if (opts?.method === 'PATCH') return json({ data: {} });
      return json({ currencyCode: 'USD', defaultTaxRate: null, invoiceNumberPrefix: 'INV', invoiceTermsDays: 30, invoiceFooter: null });
    });
    partnerCurrencyCache.value = 'USD';
    const generationBefore = partnerCurrencyCache.generation;

    renderPage();
    await waitFor(() => expect(screen.getByTestId('partner-billing-settings')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('partner-billing-currency'), { target: { value: 'EUR' } });
    fireEvent.click(screen.getByTestId('partner-billing-save'));

    await waitFor(() => expect(partnerCurrencyCache.value).toBeNull());
    expect(partnerCurrencyCache.generation).toBeGreaterThan(generationBefore);
  });

  it('#3205 W07: the appendix checkbox round-trips (Documents tab)', async () => {
    fetchMock.mockImplementation(async (_input: string, opts?: RequestInit) => {
      if (opts?.method === 'PATCH') return json({ data: {} });
      return json({
        currencyCode: 'USD', defaultTaxRate: null, invoiceNumberPrefix: 'INV', invoiceTermsDays: 30,
        invoiceDeviceAppendix: true, invoiceFooter: null,
      });
    });
    renderPage();
    await gotoDocumentsTab();
    const box = await screen.findByTestId('partner-billing-device-appendix') as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    fireEvent.click(screen.getByTestId('partner-billing-save'));
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find((c) => c[0] === '/partner/billing-settings' && (c[1] as RequestInit)?.method === 'PATCH');
      expect(JSON.parse((patch![1] as RequestInit).body as string)).toMatchObject({ invoiceDeviceAppendix: false });
    });
  });

  it('#6635: the on-behalf acceptance notice toggle loads off by default and round-trips', async () => {
    fetchMock.mockImplementation(async (_input: string, opts?: RequestInit) => {
      if (opts?.method === 'PATCH') return json({ data: {} });
      // Field absent from the payload (older API) must read as OFF, not ON.
      return json({
        currencyCode: 'USD', defaultTaxRate: null, invoiceNumberPrefix: 'INV', invoiceTermsDays: 30, invoiceFooter: null,
      });
    });
    renderPage();
    await gotoDocumentsTab();
    const box = await screen.findByTestId('partner-billing-notify-on-behalf-acceptance') as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    fireEvent.click(screen.getByTestId('partner-billing-save'));
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find((c) => c[0] === '/partner/billing-settings' && (c[1] as RequestInit)?.method === 'PATCH');
      expect(JSON.parse((patch![1] as RequestInit).body as string)).toMatchObject({ notifyCustomerOnBehalfAcceptance: true });
    });
  });

  it('#3205 W07: keeps an enabled appendix default on an unrelated settings save', async () => {
    fetchMock.mockImplementation(async (_input: string, opts?: RequestInit) => {
      if (opts?.method === 'PATCH') return json({ data: {} });
      return json({
        currencyCode: 'USD', defaultTaxRate: null, invoiceNumberPrefix: 'INV', invoiceTermsDays: 30,
        invoiceDeviceAppendix: true, invoiceFooter: null,
      });
    });
    renderPage();
    await gotoDocumentsTab();
    const box = await screen.findByTestId('partner-billing-device-appendix') as HTMLInputElement;
    expect(box.checked).toBe(true);

    // Edit an unrelated field on the OTHER tab — state is shared across tabs
    // in one form, so the appendix value set above must still ride along.
    await userEvent.click(screen.getByTestId('billing-settings-tab-defaults'));
    fireEvent.change(screen.getByTestId('partner-billing-prefix'), { target: { value: 'ACME' } });
    fireEvent.click(screen.getByTestId('partner-billing-save'));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find((c) => c[0] === '/partner/billing-settings' && (c[1] as RequestInit)?.method === 'PATCH');
      expect(patch).toBeTruthy();
      expect(JSON.parse((patch![1] as RequestInit).body as string)).toMatchObject({
        invoiceNumberPrefix: 'ACME',
        invoiceDeviceAppendix: true,
      });
    });
  });

  it('uppercases billingAddressCountry and normalizes whitespace-only address fields to null on save', async () => {
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (opts?.method === 'PATCH') return json({ data: {} });
      return json({
        currencyCode: 'USD', defaultTaxRate: null, invoiceNumberPrefix: 'INV', invoiceTermsDays: 30,
        invoiceFooter: null, billingCompanyName: null, billingPhone: null, billingWebsite: null,
        billingAddressLine1: '1 Main St', billingAddressLine2: null,
        billingAddressCity: null, billingAddressRegion: null, billingAddressPostalCode: null,
        billingAddressCountry: 'us', billingTermsAndConditions: null,
      });
    });
    renderPage();
    await gotoDocumentsTab();
    await waitFor(() => expect(screen.getByTestId('partner-billing-addr1')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('partner-billing-addr1'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('partner-billing-save'));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find((c) => c[0] === '/partner/billing-settings' && (c[1] as RequestInit)?.method === 'PATCH');
      expect(patch).toBeTruthy();
      const body = JSON.parse((patch![1] as RequestInit).body as string);
      expect(body).toMatchObject({ billingAddressCountry: 'US' });
      expect(body.billingAddressLine1).toBeNull();
    });
  });

  it('loads and shows the current document theme and page size, and PATCHes changes', async () => {
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (opts?.method === 'PATCH') return json({ data: {} });
      return json({
        currencyCode: 'USD', defaultTaxRate: null, invoiceNumberPrefix: 'INV', invoiceTermsDays: 30,
        invoiceFooter: null, documentTheme: 'condensed', documentPageSize: 'letter',
      });
    });
    renderPage();
    await gotoDocumentsTab();
    await waitFor(() => expect(screen.getByTestId('partner-billing-document-theme')).toBeInTheDocument());

    expect((screen.getByTestId('partner-billing-document-theme') as HTMLSelectElement).value).toBe('condensed');
    expect((screen.getByTestId('partner-billing-document-page-size') as HTMLSelectElement).value).toBe('letter');

    fireEvent.change(screen.getByTestId('partner-billing-document-theme'), { target: { value: 'classic' } });
    fireEvent.change(screen.getByTestId('partner-billing-document-page-size'), { target: { value: 'a4' } });
    fireEvent.click(screen.getByTestId('partner-billing-save'));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find((c) => c[0] === '/partner/billing-settings' && (c[1] as RequestInit)?.method === 'PATCH');
      expect(patch).toBeTruthy();
      expect(JSON.parse((patch![1] as RequestInit).body as string)).toMatchObject({
        documentTheme: 'classic', documentPageSize: 'a4',
      });
    });
  });

  // #3430 — this form PATCHes the FULL payload, so a legacy scheme-less
  // billingWebsite would 400 an unrelated edit with only a toast naming the
  // wire field. The inline guard points at the offending field first. Website
  // lives on the Documents tab now.
  describe('billingWebsite scheme guard', () => {
    const loaded = (billingWebsite: string | null) => json({
      currencyCode: 'USD', defaultTaxRate: null, invoiceNumberPrefix: 'INV',
      invoiceTermsDays: 30, invoiceFooter: null, billingWebsite,
    });

    it('flags a legacy scheme-less value loaded from the server and blocks the save', async () => {
      fetchMock.mockResolvedValue(loaded('acme.test'));
      renderPage();
      await gotoDocumentsTab();
      await waitFor(() => expect(screen.getByTestId('partner-billing-website')).toBeInTheDocument());

      expect(screen.getByTestId('partner-billing-website-error')).toBeInTheDocument();
      const input = screen.getByTestId('partner-billing-website');
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(input.getAttribute('aria-describedby')).toBe('pb-website-error');

      const saveBtn = screen.getByTestId('partner-billing-save') as HTMLButtonElement;
      expect(saveBtn.disabled).toBe(true);
      fireEvent.click(saveBtn);
      await waitFor(() => {
        const patch = fetchMock.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'PATCH');
        expect(patch).toBeFalsy();
      });
    });

    it.each(['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd'])(
      'flags %j typed into the field',
      async (value) => {
        fetchMock.mockResolvedValue(loaded(null));
        renderPage();
        await gotoDocumentsTab();
        await waitFor(() => expect(screen.getByTestId('partner-billing-website')).toBeInTheDocument());

        fireEvent.change(screen.getByTestId('partner-billing-website'), { target: { value } });
        expect(screen.getByTestId('partner-billing-website-error')).toBeInTheDocument();
        expect((screen.getByTestId('partner-billing-save') as HTMLButtonElement).disabled).toBe(true);
      },
    );

    it('clears the error and re-enables the save once corrected', async () => {
      fetchMock.mockResolvedValue(loaded('acme.test'));
      renderPage();
      await gotoDocumentsTab();
      await waitFor(() => expect(screen.getByTestId('partner-billing-website-error')).toBeInTheDocument());

      fireEvent.change(screen.getByTestId('partner-billing-website'), { target: { value: 'https://acme.test' } });
      expect(screen.queryByTestId('partner-billing-website-error')).toBeNull();
      expect((screen.getByTestId('partner-billing-save') as HTMLButtonElement).disabled).toBe(false);
    });

    it('does not flag an empty website', async () => {
      fetchMock.mockResolvedValue(loaded(null));
      renderPage();
      await gotoDocumentsTab();
      await waitFor(() => expect(screen.getByTestId('partner-billing-website')).toBeInTheDocument());
      expect(screen.queryByTestId('partner-billing-website-error')).toBeNull();
      expect((screen.getByTestId('partner-billing-save') as HTMLButtonElement).disabled).toBe(false);
    });
  });
});
