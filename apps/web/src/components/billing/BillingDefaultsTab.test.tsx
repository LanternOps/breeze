import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '../../lib/i18n';
import BillingDefaultsTab from './BillingDefaultsTab';

function renderTab(overrides: Partial<Parameters<typeof BillingDefaultsTab>[0]> = {}) {
  const props = {
    currencyCode: 'USD', setCurrencyCode: vi.fn(),
    taxPercent: '', setTaxPercent: vi.fn(),
    prefix: 'INV', setPrefix: vi.fn(),
    termsDays: '30', setTermsDays: vi.fn(),
    ...overrides,
  };
  render(<I18nextProvider i18n={i18n}><BillingDefaultsTab {...props} /></I18nextProvider>);
  return props;
}

describe('BillingDefaultsTab', () => {
  it('renders currency, tax, prefix, and payment terms fields', () => {
    renderTab();
    expect(screen.getByTestId('partner-billing-currency')).toBeInTheDocument();
    expect(screen.getByTestId('partner-billing-tax')).toBeInTheDocument();
    expect(screen.getByTestId('partner-billing-prefix')).toBeInTheDocument();
    expect(screen.getByTestId('partner-billing-terms-days')).toBeInTheDocument();
  });

  it('does not render the markup/auto-tax/AI-style fields (moved to Catalog)', () => {
    renderTab();
    expect(screen.queryByTestId('partner-billing-markup')).not.toBeInTheDocument();
    expect(screen.queryByTestId('partner-billing-auto-tax-hardware')).not.toBeInTheDocument();
    expect(screen.queryByTestId('partner-billing-ai-style')).not.toBeInTheDocument();
  });

  it('calls the setter when the prefix input changes', () => {
    const props = renderTab();
    fireEvent.change(screen.getByTestId('partner-billing-prefix'), { target: { value: 'ACME' } });
    expect(props.setPrefix).toHaveBeenCalledWith('ACME');
  });
});
