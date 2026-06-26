import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PartnerBillingSettings from './PartnerBillingSettings';
import { fetchWithAuth } from '../../stores/auth';

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
});
