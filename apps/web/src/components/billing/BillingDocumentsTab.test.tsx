import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '../../lib/i18n';
import BillingDocumentsTab from './BillingDocumentsTab';

function renderTab(overrides: Partial<Parameters<typeof BillingDocumentsTab>[0]> = {}) {
  const props = {
    autoEmailInvoice: true, setAutoEmailInvoice: vi.fn(),
    deviceAppendix: false, setDeviceAppendix: vi.fn(),
    footer: '', setFooter: vi.fn(),
    documentTheme: 'classic' as const, setDocumentTheme: vi.fn(),
    documentPageSize: 'letter' as const, setDocumentPageSize: vi.fn(),
    companyName: '', setCompanyName: vi.fn(),
    phone: '', setPhone: vi.fn(),
    website: '', setWebsite: vi.fn(), websiteInvalid: false,
    addr1: '', setAddr1: vi.fn(), addr2: '', setAddr2: vi.fn(),
    city: '', setCity: vi.fn(), region: '', setRegion: vi.fn(),
    postal: '', setPostal: vi.fn(), country: '', setCountry: vi.fn(),
    terms: '', setTerms: vi.fn(),
    ...overrides,
  };
  render(<I18nextProvider i18n={i18n}><BillingDocumentsTab {...props} /></I18nextProvider>);
  return props;
}

describe('BillingDocumentsTab', () => {
  it('renders auto-email, device appendix, document theme/size, footer, and the Company card', () => {
    renderTab();
    expect(screen.getByTestId('partner-billing-auto-email-invoice')).toBeInTheDocument();
    expect(screen.getByTestId('partner-billing-device-appendix')).toBeInTheDocument();
    expect(screen.getByTestId('partner-billing-document-theme')).toBeInTheDocument();
    expect(screen.getByTestId('partner-billing-document-page-size')).toBeInTheDocument();
    expect(screen.getByTestId('partner-billing-footer')).toBeInTheDocument();
    expect(screen.getByTestId('partner-billing-company-name')).toBeInTheDocument();
    expect(screen.getByTestId('partner-billing-website')).toBeInTheDocument();
  });

  it('shows the website error when websiteInvalid is true', () => {
    renderTab({ websiteInvalid: true });
    expect(screen.getByTestId('partner-billing-website-error')).toBeInTheDocument();
  });

  it('calls the setter when the company name input changes', () => {
    const props = renderTab();
    fireEvent.change(screen.getByTestId('partner-billing-company-name'), { target: { value: 'Acme MSP' } });
    expect(props.setCompanyName).toHaveBeenCalledWith('Acme MSP');
  });
});
