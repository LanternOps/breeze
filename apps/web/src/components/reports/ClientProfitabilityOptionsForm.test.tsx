import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

let partnerCurrency: { currency: string | null; loading: boolean; failed: boolean; retry: () => void } = {
  currency: null, loading: true, failed: false, retry: () => {},
};
vi.mock('@/lib/usePartnerCurrency', () => ({
  usePartnerCurrency: () => partnerCurrency,
}));

import {
  DEFAULT_CLIENT_PROFITABILITY_OPTIONS,
  ClientProfitabilityOptionsFields,
  ClientProfitabilityOptionsForm,
  clientProfitabilityConfigFromOptions,
  clientProfitabilityOptionsFromConfig,
  isClientProfitabilityOptionsValid,
  type ClientProfitabilityOptions,
} from './ClientProfitabilityOptionsForm';

const enabled = (amount: string, currency = 'USD'): ClientProfitabilityOptions => ({
  ...DEFAULT_CLIENT_PROFITABILITY_OPTIONS,
  laborCostEnabled: true,
  laborCostAmount: amount,
  laborCostCurrency: currency,
});

beforeEach(() => {
  partnerCurrency = { currency: null, loading: true, failed: false, retry: () => {} };
});

describe('client profitability options mapping', () => {
  it('defaults: scope-default grouping, labor rate off, USD placeholder currency', () => {
    expect(DEFAULT_CLIENT_PROFITABILITY_OPTIONS.groupBy).toBeNull();
    expect(DEFAULT_CLIENT_PROFITABILITY_OPTIONS.laborCostEnabled).toBe(false);
    expect(DEFAULT_CLIENT_PROFITABILITY_OPTIONS.laborCostCurrency).toBe('USD');
  });

  it('stores no defaults: groupBy null and a disabled labor rate leave their keys absent', () => {
    const config = clientProfitabilityConfigFromOptions(DEFAULT_CLIENT_PROFITABILITY_OPTIONS);
    expect(config).toEqual({ period: DEFAULT_CLIENT_PROFITABILITY_OPTIONS.period });
    expect(config).not.toHaveProperty('groupBy');
    expect(config).not.toHaveProperty('laborCostPerHour');
  });

  it('a disabled rate never leaks a typed amount', () => {
    const config = clientProfitabilityConfigFromOptions({
      ...DEFAULT_CLIENT_PROFITABILITY_OPTIONS, laborCostAmount: '45', laborCostCurrency: 'EUR',
    });
    expect(config).not.toHaveProperty('laborCostPerHour');
  });

  it('an enabled rate emits { amount, currencyCode } and a chosen groupBy', () => {
    const config = clientProfitabilityConfigFromOptions({ ...enabled('45', 'EUR'), groupBy: 'source' });
    expect(config).toMatchObject({ groupBy: 'source', laborCostPerHour: { amount: '45', currencyCode: 'EUR' } });
  });

  it('round-trips a stored config, and the stored currency wins', () => {
    const stored = { period: { kind: 'last_30_days' }, groupBy: 'organization', laborCostPerHour: { amount: '60.5', currencyCode: 'GBP' } };
    const options = clientProfitabilityOptionsFromConfig(stored);
    expect(options).toMatchObject({ groupBy: 'organization', laborCostEnabled: true, laborCostAmount: '60.5', laborCostCurrency: 'GBP' });
    expect(clientProfitabilityConfigFromOptions(options)).toEqual(stored);
  });

  it('an empty or malformed config maps to the defaults', () => {
    expect(clientProfitabilityOptionsFromConfig({})).toEqual(DEFAULT_CLIENT_PROFITABILITY_OPTIONS);
    expect(clientProfitabilityOptionsFromConfig({ groupBy: 'device', laborCostPerHour: 'x' })).toEqual(DEFAULT_CLIENT_PROFITABILITY_OPTIONS);
  });
});

describe('isClientProfitabilityOptionsValid', () => {
  it('is valid with the labor rate off, whatever the amount field holds', () => {
    expect(isClientProfitabilityOptionsValid({ ...DEFAULT_CLIENT_PROFITABILITY_OPTIONS, laborCostAmount: 'abc' })).toBe(true);
  });

  it.each(['', 'abc', '0', '0.00', '-5', '12345678', '1.234', '1,5', ' 45'])('rejects %j when enabled', (amount) => {
    expect(isClientProfitabilityOptionsValid(enabled(amount))).toBe(false);
  });

  it.each(['45', '45.5', '0.25', '1234567.99'])('accepts %j when enabled', (amount) => {
    expect(isClientProfitabilityOptionsValid(enabled(amount))).toBe(true);
  });

  it('rejects a fractional amount for a zero-decimal currency, accepts a whole one', () => {
    expect(isClientProfitabilityOptionsValid(enabled('4500.5', 'JPY'))).toBe(false);
    expect(isClientProfitabilityOptionsValid(enabled('4500', 'JPY'))).toBe(true);
    expect(isClientProfitabilityOptionsValid(enabled('4500.00', 'JPY'))).toBe(true);
  });
});

describe('ClientProfitabilityOptionsFields', () => {
  it('hides the rate inputs until the labor estimate is enabled, and states the blended-rate caveat', async () => {
    const onChange = vi.fn();
    render(<ClientProfitabilityOptionsFields value={DEFAULT_CLIENT_PROFITABILITY_OPTIONS} onChange={onChange} />);
    expect(screen.queryByTestId('client-profitability-labor-amount')).toBeNull();
    expect(screen.queryByTestId('client-profitability-labor-currency')).toBeNull();
    expect(screen.getByText('One blended rate for every technician. Figures using it are labelled as estimates.')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByTestId('client-profitability-labor-enabled'));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ laborCostEnabled: true, laborCostCurrency: 'USD' }));
  });

  it('enabling uses the partner currency once known, never a guess from report data', async () => {
    partnerCurrency = { currency: 'EUR', loading: false, failed: false, retry: () => {} };
    const onChange = vi.fn();
    render(<ClientProfitabilityOptionsFields value={DEFAULT_CLIENT_PROFITABILITY_OPTIONS} onChange={onChange} />);
    await userEvent.setup().click(screen.getByTestId('client-profitability-labor-enabled'));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ laborCostEnabled: true, laborCostCurrency: 'EUR' }));
  });

  it('enabled before the partner currency loads: the currency follows it once it resolves', async () => {
    function Harness() {
      const [v, setV] = useState(DEFAULT_CLIENT_PROFITABILITY_OPTIONS);
      return <ClientProfitabilityOptionsFields value={v} onChange={setV} />;
    }
    const { rerender } = render(<Harness />);
    await userEvent.setup().click(screen.getByTestId('client-profitability-labor-enabled'));
    expect(screen.getByTestId('client-profitability-labor-currency')).toHaveValue('USD');
    partnerCurrency = { currency: 'EUR', loading: false, failed: false, retry: () => {} };
    rerender(<Harness />);
    expect(screen.getByTestId('client-profitability-labor-currency')).toHaveValue('EUR');
  });

  it('a currency the user picked before the partner currency resolved is never overwritten', async () => {
    function Harness() {
      const [v, setV] = useState(DEFAULT_CLIENT_PROFITABILITY_OPTIONS);
      return <ClientProfitabilityOptionsFields value={v} onChange={setV} />;
    }
    const { rerender } = render(<Harness />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('client-profitability-labor-enabled'));
    await user.selectOptions(screen.getByTestId('client-profitability-labor-currency'), 'GBP');
    partnerCurrency = { currency: 'EUR', loading: false, failed: false, retry: () => {} };
    rerender(<Harness />);
    expect(screen.getByTestId('client-profitability-labor-currency')).toHaveValue('GBP');
  });

  it('a stored rate is never re-seeded when the partner currency resolves later', () => {
    function Harness() {
      const [v, setV] = useState(enabled('45', 'USD'));
      return <ClientProfitabilityOptionsFields value={v} onChange={setV} />;
    }
    const { rerender } = render(<Harness />);
    partnerCurrency = { currency: 'EUR', loading: false, failed: false, retry: () => {} };
    rerender(<Harness />);
    expect(screen.getByTestId('client-profitability-labor-currency')).toHaveValue('USD');
  });

  it('a stored currency outside the supported list falls back to the default instead of passing through', () => {
    const options = clientProfitabilityOptionsFromConfig({ laborCostPerHour: { amount: '45', currencyCode: 'XYZ' } });
    expect(options).toMatchObject({ laborCostEnabled: true, laborCostAmount: '45', laborCostCurrency: 'USD' });
  });

  it('an existing stored currency is left alone when the partner currency differs', () => {
    partnerCurrency = { currency: 'EUR', loading: false, failed: false, retry: () => {} };
    render(<ClientProfitabilityOptionsFields value={enabled('45', 'GBP')} onChange={() => {}} />);
    expect(screen.getByTestId('client-profitability-labor-currency')).toHaveValue('GBP');
    expect(screen.getByTestId('client-profitability-labor-amount')).toHaveValue('45');
  });

  it('reports group-by choices, the scope default as null', async () => {
    const onChange = vi.fn();
    render(<ClientProfitabilityOptionsFields value={DEFAULT_CLIENT_PROFITABILITY_OPTIONS} onChange={onChange} />);
    const select = screen.getByTestId('client-profitability-group-by');
    expect(select).toHaveValue('');
    await userEvent.setup().selectOptions(select, 'source');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: 'source' }));
  });

  it('reports a typed amount', async () => {
    const onChange = vi.fn();
    render(<ClientProfitabilityOptionsFields value={enabled('')} onChange={onChange} />);
    await userEvent.setup().type(screen.getByTestId('client-profitability-labor-amount'), '4');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ laborCostAmount: '4' }));
  });
});

describe('ClientProfitabilityOptionsForm', () => {
  const renderForm = (value: ClientProfitabilityOptions, onSubmit = vi.fn()) =>
    render(
      <ClientProfitabilityOptionsForm value={value} onChange={() => {}} submitLabel="Create" onSubmit={onSubmit} onCancel={() => {}} />,
    );

  it('submits from the create button', async () => {
    const onSubmit = vi.fn();
    renderForm(DEFAULT_CLIENT_PROFITABILITY_OPTIONS, onSubmit);
    await userEvent.setup().click(screen.getByTestId('client-profitability-create-report'));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('disables create while the enabled labor amount is invalid', () => {
    renderForm(enabled('0'));
    expect(screen.getByTestId('client-profitability-create-report')).toBeDisabled();
  });
});
