import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PartnerBillingSettings from './PartnerBillingSettings';
import { fetchWithAuth } from '../../stores/auth';
import { partnerCurrencyCache } from '@/lib/partnerCurrencyCache';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

describe('PartnerBillingSettings', () => {
  beforeEach(() => vi.clearAllMocks());

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
    render(<PartnerBillingSettings />);
    await waitFor(() =>
      expect((screen.getByTestId('partner-billing-company-name') as HTMLInputElement).value).toBe('Acme MSP LLC'),
    );
  });

  it('loads partner billing and shows the tax rate as a percentage', async () => {
    fetchMock.mockResolvedValue(json({
      currencyCode: 'EUR', defaultTaxRate: '0.085', invoiceNumberPrefix: 'EU',
      invoiceTermsDays: 14, invoiceFooter: 'Thanks',
    }));
    render(<PartnerBillingSettings />);
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
    render(<PartnerBillingSettings />);
    await waitFor(() => expect(screen.getByTestId('partner-billing-settings')).toBeInTheDocument());
    expect((screen.getByTestId('partner-billing-currency') as HTMLSelectElement).value).toBe('ISK');
  });

  it('saves, converting the percentage back to a fraction', async () => {
    fetchMock.mockImplementation(async (input: string, opts?: RequestInit) => {
      if (opts?.method === 'PATCH') return json({ data: {} });
      return json({ currencyCode: 'USD', defaultTaxRate: null, invoiceNumberPrefix: 'INV', invoiceTermsDays: 30, invoiceFooter: null });
    });
    render(<PartnerBillingSettings />);
    await waitFor(() => expect(screen.getByTestId('partner-billing-settings')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('partner-billing-tax'), { target: { value: '7' } });
    fireEvent.click(screen.getByTestId('partner-billing-save'));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find((c) => c[0] === '/partner/billing-settings' && (c[1] as RequestInit)?.method === 'PATCH');
      expect(patch).toBeTruthy();
      expect(JSON.parse((patch![1] as RequestInit).body as string)).toMatchObject({ defaultTaxRate: 0.07, currencyCode: 'USD' });
    });
  });

  /**
   * The partner reporting currency is cached module-wide (partnerCurrencyCache)
   * and the approximate-total cache is bound to its generation. Without a reset
   * on save, an admin who switches the reporting currency keeps reading the old
   * currency — labels AND converted "≈ approximate" totals — until logout.
   */
  it('resets the cached partner currency on a successful save so stale money labels/totals cannot survive', async () => {
    fetchMock.mockImplementation(async (_input: string, opts?: RequestInit) => {
      if (opts?.method === 'PATCH') return json({ data: {} });
      return json({ currencyCode: 'USD', defaultTaxRate: null, invoiceNumberPrefix: 'INV', invoiceTermsDays: 30, invoiceFooter: null });
    });
    partnerCurrencyCache.value = 'USD';
    const generationBefore = partnerCurrencyCache.generation;

    render(<PartnerBillingSettings />);
    await waitFor(() => expect(screen.getByTestId('partner-billing-settings')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('partner-billing-currency'), { target: { value: 'EUR' } });
    fireEvent.click(screen.getByTestId('partner-billing-save'));

    await waitFor(() => expect(partnerCurrencyCache.value).toBeNull());
    expect(partnerCurrencyCache.generation).toBeGreaterThan(generationBefore);
  });

  it('sends autoTaxHardware in the PATCH body and toggles it via checkbox', async () => {
    fetchMock.mockImplementation(async (_input: string, opts?: RequestInit) => {
      if (opts?.method === 'PATCH') return json({ data: {} });
      return json({
        currencyCode: 'USD', defaultTaxRate: null, invoiceNumberPrefix: 'INV', invoiceTermsDays: 30,
        autoTaxHardware: true, invoiceFooter: null,
      });
    });
    render(<PartnerBillingSettings />);
    await waitFor(() => expect(screen.getByTestId('partner-billing-settings')).toBeInTheDocument());

    // Checkbox should start checked (loaded true from server)
    const checkbox = screen.getByTestId('partner-billing-auto-tax-hardware') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    // Uncheck it and save — PATCH body must carry autoTaxHardware: false
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByTestId('partner-billing-save'));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find((c) => c[0] === '/partner/billing-settings' && (c[1] as RequestInit)?.method === 'PATCH');
      expect(patch).toBeTruthy();
      expect(JSON.parse((patch![1] as RequestInit).body as string)).toMatchObject({ autoTaxHardware: false });
    });
  });

  it('#3205 W07: the appendix checkbox round-trips', async () => {
    fetchMock.mockImplementation(async (_input: string, opts?: RequestInit) => {
      if (opts?.method === 'PATCH') return json({ data: {} });
      return json({
        currencyCode: 'USD', defaultTaxRate: null, invoiceNumberPrefix: 'INV', invoiceTermsDays: 30,
        invoiceDeviceAppendix: true, invoiceFooter: null,
      });
    });
    render(<PartnerBillingSettings />);
    const box = await screen.findByTestId('partner-billing-device-appendix') as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    fireEvent.click(screen.getByTestId('partner-billing-save'));
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find((c) => c[0] === '/partner/billing-settings' && (c[1] as RequestInit)?.method === 'PATCH');
      expect(JSON.parse((patch![1] as RequestInit).body as string)).toMatchObject({ invoiceDeviceAppendix: false });
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
    render(<PartnerBillingSettings />);
    await waitFor(() => expect(screen.getByTestId('partner-billing-settings')).toBeInTheDocument());

    // Clear addr1 to whitespace-only (should serialize as null); country is uppercased on change
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
    render(<PartnerBillingSettings />);
    await waitFor(() => expect(screen.getByTestId('partner-billing-settings')).toBeInTheDocument());

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
  // wire field. The inline guard points at the offending field first.
  describe('billingWebsite scheme guard', () => {
    const loaded = (billingWebsite: string | null) => json({
      currencyCode: 'USD', defaultTaxRate: null, invoiceNumberPrefix: 'INV',
      invoiceTermsDays: 30, invoiceFooter: null, billingWebsite,
    });

    it('flags a legacy scheme-less value loaded from the server and blocks the save', async () => {
      fetchMock.mockResolvedValue(loaded('acme.test'));
      render(<PartnerBillingSettings />);
      await waitFor(() => expect(screen.getByTestId('partner-billing-settings')).toBeInTheDocument());

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
        render(<PartnerBillingSettings />);
        await waitFor(() => expect(screen.getByTestId('partner-billing-settings')).toBeInTheDocument());

        fireEvent.change(screen.getByTestId('partner-billing-website'), { target: { value } });
        expect(screen.getByTestId('partner-billing-website-error')).toBeInTheDocument();
        expect((screen.getByTestId('partner-billing-save') as HTMLButtonElement).disabled).toBe(true);
      },
    );

    it('clears the error and re-enables the save once corrected', async () => {
      fetchMock.mockResolvedValue(loaded('acme.test'));
      render(<PartnerBillingSettings />);
      await waitFor(() => expect(screen.getByTestId('partner-billing-settings')).toBeInTheDocument());
      expect(screen.getByTestId('partner-billing-website-error')).toBeInTheDocument();

      fireEvent.change(screen.getByTestId('partner-billing-website'), { target: { value: 'https://acme.test' } });
      expect(screen.queryByTestId('partner-billing-website-error')).toBeNull();
      expect((screen.getByTestId('partner-billing-save') as HTMLButtonElement).disabled).toBe(false);
    });

    it('does not flag an empty website', async () => {
      fetchMock.mockResolvedValue(loaded(null));
      render(<PartnerBillingSettings />);
      await waitFor(() => expect(screen.getByTestId('partner-billing-settings')).toBeInTheDocument());
      expect(screen.queryByTestId('partner-billing-website-error')).toBeNull();
      expect((screen.getByTestId('partner-billing-save') as HTMLButtonElement).disabled).toBe(false);
    });
  });
});
