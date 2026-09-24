import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '../../lib/i18n';
import BillingDocumentsTab from './BillingDocumentsTab';

function renderTab(overrides: Partial<Parameters<typeof BillingDocumentsTab>[0]> = {}) {
  const props = {
    autoEmailInvoice: true, setAutoEmailInvoice: vi.fn(),
    notifyOnBehalfAcceptance: false, setNotifyOnBehalfAcceptance: vi.fn(),
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

  it('#6635: renders the on-behalf acceptance notice toggle unchecked by default and wires its setter', () => {
    const props = renderTab();
    const box = screen.getByTestId('partner-billing-notify-on-behalf-acceptance') as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByText(i18n.t('billing:partnerBillingSettings.defaults.notifyOnBehalfAcceptance'))).toBeInTheDocument();
    fireEvent.click(box);
    expect(props.setNotifyOnBehalfAcceptance).toHaveBeenCalledWith(true);
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

  describe('company-details fallback (#6228)', () => {
    it('shows the inherited phone/website as placeholders when the override is blank', () => {
      renderTab({ inheritedPhone: '555-0100', inheritedWebsite: 'https://acme.test' });
      expect(screen.getByTestId('partner-billing-phone')).toHaveAttribute('placeholder', '555-0100');
      expect(screen.getByTestId('partner-billing-website')).toHaveAttribute('placeholder', 'https://acme.test');
    });

    it('shows "same as company details" when every address override field is blank and a company address exists', () => {
      renderTab({
        inheritedAddress: { line1: '1 Company Rd', line2: null, city: 'Company City', region: null, postalCode: null, country: 'CA' },
      });
      expect(screen.getByTestId('partner-billing-address-inherited-note')).toBeInTheDocument();
      expect(screen.queryByTestId('partner-billing-use-company-address')).not.toBeInTheDocument();
    });

    it('shows a "Use company address" reset once any address override field is non-blank', () => {
      renderTab({
        addr1: '1 Override St',
        inheritedAddress: { line1: '1 Company Rd', line2: null, city: 'Company City', region: null, postalCode: null, country: 'CA' },
      });
      expect(screen.getByTestId('partner-billing-use-company-address')).toBeInTheDocument();
    });

    it('"Use company address" clears every address override field', () => {
      const props = renderTab({
        addr1: '1 Override St', city: 'Override City',
        inheritedAddress: { line1: '1 Company Rd', line2: null, city: 'Company City', region: null, postalCode: null, country: 'CA' },
      });
      fireEvent.click(screen.getByTestId('partner-billing-use-company-address'));
      expect(props.setAddr1).toHaveBeenCalledWith('');
      expect(props.setAddr2).toHaveBeenCalledWith('');
      expect(props.setCity).toHaveBeenCalledWith('');
      expect(props.setRegion).toHaveBeenCalledWith('');
      expect(props.setPostal).toHaveBeenCalledWith('');
      expect(props.setCountry).toHaveBeenCalledWith('');
    });
  });
});
