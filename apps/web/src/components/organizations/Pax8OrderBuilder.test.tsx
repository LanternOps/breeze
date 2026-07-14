import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Pax8ProvisioningForm } from './Pax8ProvisioningForm';
import {
  PAX8_BILLING_TERM_I18N_KEYS,
  PAX8_ORDER_ACTION_I18N_KEYS,
  PAX8_ORDER_STATUS_I18N_KEYS,
  PAX8_SUBMIT_STATE_I18N_KEYS,
  extractPax8PreflightErrors,
} from './pax8OrderUi';
import Pax8OrderBuilder from './Pax8OrderBuilder';
import type { Pax8OrderBundle } from '../../lib/api/pax8Orders';
import { getProductDependencies, getProvisionDetails, preflightPax8Order, submitPax8Order } from '../../lib/api/pax8Orders';
import es419 from '../../locales/es-419/settings.json';
import { i18n, loadLocale } from '../../lib/i18n';

vi.mock('../../lib/api/pax8Orders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/pax8Orders')>();
  return {
    ...actual,
    preflightPax8Order: vi.fn(),
    submitPax8Order: vi.fn(),
    getProvisionDetails: vi.fn(),
    getProductDependencies: vi.fn(),
  };
});

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage('en');
});

afterEach(async () => {
  await act(() => i18n.changeLanguage('en'));
});

const product = {
  pax8ProductId: 'prod-1', catalogItemId: 'cat-1', catalogName: 'Microsoft 365', catalogSku: null,
  catalogDescription: null, productName: 'Microsoft 365', vendorSkuId: null,
  billingFrequency: 'monthly', commitmentTermMonths: null,
};

function orderBundle({
  source = 'direct',
  status = 'draft',
  submitStates = ['pending'],
}: {
  source?: 'direct' | 'quote';
  status?: Pax8OrderBundle['order']['status'];
  submitStates?: Pax8OrderBundle['lines'][number]['submitState'][];
} = {}): Pax8OrderBundle {
  return {
    order: {
      id: '44444444-4444-4444-8444-444444444444', integrationId: 'integration-1',
      partnerId: 'partner-1', orgId: 'org-1', pax8CompanyId: 'company-1', status, source,
      sourceQuoteId: source === 'quote' ? 'quote-1' : null, pax8OrderId: null, error: null,
      submittedAt: null, createdAt: '2026-07-14T00:00:00Z', updatedAt: '2026-07-14T00:00:00Z',
    },
    lines: submitStates.map((submitState, index) => ({
      id: `line-${index + 1}`, orderId: '44444444-4444-4444-8444-444444444444',
      action: 'new_subscription', submitState, pax8ProductId: 'prod-1', catalogItemId: 'cat-1',
      billingTerm: 'Monthly', commitmentTermId: null, quantity: '1.00', provisioningDetails: [],
      targetSubscriptionId: null, resultSubscriptionId: null, contractLineId: `contract-${index + 1}`,
      sourceQuoteLineId: source === 'quote' ? `quote-line-${index + 1}` : null, error: null, sortOrder: index,
    })),
  };
}

describe('Pax8 provisioning details', () => {
  it('renders Single-Value fields with exactly the Pax8 possible values', () => {
    render(
      <Pax8ProvisioningForm
        fields={[{
          key: 'region',
          label: 'Region',
          description: null,
          valueType: 'Single-Value',
          possibleValues: ['US', 'CA'],
        }]}
        value={[]}
        onChange={vi.fn()}
      />,
    );

    const select = screen.getByTestId('pax8-provision-region') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(['US', 'CA']);
    expect(select.required).toBe(false);
  });

  it('clears an optional Single-Value field without adding a synthetic select option', async () => {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState<Array<{ key: string; values: string[] }>>([]);
      return <Pax8ProvisioningForm
        fields={[{ key: 'region', label: 'Region', description: null, valueType: 'Single-Value', possibleValues: ['US', 'CA'] }]}
        value={value}
        onChange={(next) => { setValue(next); onChange(next); }}
      />;
    }
    render(<Harness />);

    const select = screen.getByTestId('pax8-provision-region') as HTMLSelectElement;
    await userEvent.selectOptions(select, 'CA');
    expect([...select.options].map((option) => option.value)).toEqual(['US', 'CA']);
    await userEvent.click(screen.getByRole('button', { name: /clear region/i }));

    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(select.value).toBe('');
    expect([...select.options].map((option) => option.value)).toEqual(['US', 'CA']);
  });

  it('keeps every field optional and supports an accessible native multiselect', async () => {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState<Array<{ key: string; values: string[] }>>([]);
      return <Pax8ProvisioningForm fields={[
        { key: 'alias', label: 'Alias', description: null, valueType: 'Input', possibleValues: [] },
        { key: 'features', label: 'Features', description: null, valueType: 'Multi-Value', possibleValues: ['A', 'B'] },
      ]} value={value} onChange={(next) => { setValue(next); onChange(next); }} />;
    }
    render(<Harness />);

    expect(screen.getByTestId('pax8-provision-alias')).not.toBeRequired();
    const multi = screen.getByTestId('pax8-provision-features') as HTMLSelectElement;
    expect(multi.multiple).toBe(true);
    expect(multi).not.toBeRequired();
    await userEvent.selectOptions(multi, ['A', 'B']);
    expect(onChange).toHaveBeenCalledWith(expect.arrayContaining([
      { key: 'features', values: ['A', 'B'] },
    ]));
  });
});

describe('Pax8 preflight errors', () => {
  it('preserves raw 422 details and assigns lineItemNumber messages inline', () => {
    const parsed = extractPax8PreflightErrors({
      details: [
        { lineItemNumber: 2, message: 'Tenant domain must be supplied.' },
        { message: 'Company billing contact is incomplete.' },
      ],
    });

    expect(parsed.byLine.get(2)).toEqual(['Tenant domain must be supplied.']);
    expect(parsed.order).toEqual(['Company billing contact is incomplete.']);
  });

  it('renders raw 422 messages against the line and never calls submit', async () => {
    vi.mocked(preflightPax8Order).mockResolvedValue(new Response(JSON.stringify({
      details: [{ lineItemNumber: 1, message: 'Tenant domain must be supplied.' }],
    }), { status: 422, headers: { 'content-type': 'application/json' } }));

    render(<Pax8OrderBuilder
      bundle={{
        order: {
          id: '44444444-4444-4444-8444-444444444444', integrationId: 'integration-1',
          partnerId: 'partner-1', orgId: 'org-1', pax8CompanyId: 'company-1',
          status: 'draft', source: 'quote', sourceQuoteId: 'quote-1', pax8OrderId: null,
          error: null, submittedAt: null, createdAt: '2026-07-14T00:00:00Z', updatedAt: '2026-07-14T00:00:00Z',
        },
        lines: [{
          id: 'line-1', orderId: '44444444-4444-4444-8444-444444444444', action: 'new_subscription', submitState: 'pending',
          pax8ProductId: 'prod-1', catalogItemId: 'cat-1', billingTerm: 'Monthly', commitmentTermId: null,
          quantity: '1.00', provisioningDetails: [], targetSubscriptionId: null, resultSubscriptionId: null,
          contractLineId: 'contract-line-1', sourceQuoteLineId: 'quote-line-1', error: null, sortOrder: 0,
        }],
      }}
      products={[{
        pax8ProductId: 'prod-1', catalogItemId: 'cat-1', catalogName: 'Microsoft 365', catalogSku: null,
        catalogDescription: null, productName: 'Microsoft 365', vendorSkuId: null,
        billingFrequency: 'monthly', commitmentTermMonths: null,
      }]}
      onReload={vi.fn()}
      onBack={vi.fn()}
    />);

    await userEvent.click(screen.getByTestId('pax8-submit'));
    expect(await screen.findByTestId('pax8-line-error-line-1')).toHaveTextContent('Tenant domain must be supplied.');
    expect(submitPax8Order).not.toHaveBeenCalled();
  });

  it('correlates a raw lineItemNumber 2 error to the second sorted line', async () => {
    vi.mocked(preflightPax8Order).mockResolvedValue(new Response(JSON.stringify({
      details: [{ lineItemNumber: 2, message: 'Second line needs a tenant domain.' }],
    }), { status: 422, headers: { 'content-type': 'application/json' } }));

    const line = (id: string, sortOrder: number) => ({
      id, orderId: '44444444-4444-4444-8444-444444444444', action: 'new_subscription' as const,
      submitState: 'pending' as const, pax8ProductId: 'prod-1', catalogItemId: 'cat-1', billingTerm: 'Monthly',
      commitmentTermId: null, quantity: '1.00', provisioningDetails: [], targetSubscriptionId: null,
      resultSubscriptionId: null, contractLineId: `contract-${id}`, sourceQuoteLineId: null,
      error: null, sortOrder,
    });
    render(<Pax8OrderBuilder
      bundle={{
        order: {
          id: '44444444-4444-4444-8444-444444444444', integrationId: 'integration-1',
          partnerId: 'partner-1', orgId: 'org-1', pax8CompanyId: 'company-1', status: 'draft',
          source: 'direct', sourceQuoteId: null, pax8OrderId: null, error: null, submittedAt: null,
          createdAt: '2026-07-14T00:00:00Z', updatedAt: '2026-07-14T00:00:00Z',
        },
        lines: [line('line-1', 0), line('line-2', 1)],
      }}
      products={[{
        pax8ProductId: 'prod-1', catalogItemId: 'cat-1', catalogName: 'Microsoft 365', catalogSku: null,
        catalogDescription: null, productName: 'Microsoft 365', vendorSkuId: null,
        billingFrequency: 'monthly', commitmentTermMonths: null,
      }]}
      onReload={vi.fn()}
      onBack={vi.fn()}
    />);

    await userEvent.click(screen.getByTestId('pax8-submit'));
    expect(await screen.findByTestId('pax8-line-error-line-2')).toHaveTextContent('Second line needs a tenant domain.');
    expect(screen.queryByTestId('pax8-line-error-line-1')).not.toBeInTheDocument();
    expect(submitPax8Order).not.toHaveBeenCalled();
  });
});

describe('Pax8 order mutation affordances', () => {
  it('keeps accepted-quote lines immutable while allowing provisioning edits', async () => {
    vi.mocked(getProvisionDetails).mockResolvedValue(new Response(JSON.stringify({ data: [] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.mocked(getProductDependencies).mockResolvedValue(new Response(JSON.stringify({ data: { commitments: [] } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    render(<Pax8OrderBuilder bundle={orderBundle({ source: 'quote' })} products={[product]} onReload={vi.fn()} onBack={vi.fn()} />);

    expect(screen.queryByTestId('pax8-product-select')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove line/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /edit details/i }));
    expect(await screen.findByTestId('pax8-staged-line-editor')).toBeInTheDocument();
  });

  it('keeps add and remove controls for mutable direct orders', () => {
    render(<Pax8OrderBuilder bundle={orderBundle()} products={[product]} onReload={vi.fn()} onBack={vi.fn()} />);

    expect(screen.getByTestId('pax8-product-select')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove line/i })).toBeEnabled();
  });

  it.each([
    ['a needs-reconcile line', 'draft', ['needs_reconcile']],
    ['an in-flight line', 'draft', ['in_flight']],
    ['a submitting order whose lines are all pending', 'submitting', ['pending', 'pending']],
  ] as const)('offers recovery for %s', (_label, status, submitStates) => {
    render(<Pax8OrderBuilder bundle={orderBundle({ status, submitStates: [...submitStates] })} products={[product]} onReload={vi.fn()} onBack={vi.fn()} />);

    expect(screen.getByTestId('pax8-reconcile')).toBeEnabled();
    expect(screen.queryByTestId('pax8-submit')).not.toBeInTheDocument();
  });

  it('does not offer false recovery for submitting orders with a completed line', () => {
    render(<Pax8OrderBuilder bundle={orderBundle({ status: 'submitting', submitStates: ['pending', 'succeeded'] })} products={[product]} onReload={vi.fn()} onBack={vi.fn()} />);

    expect(screen.queryByTestId('pax8-reconcile')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pax8-submit')).not.toBeInTheDocument();
  });
});

describe('Pax8 wire-enum localization', () => {
  it('maps every wire value to a translated key without changing the request values', () => {
    expect(Object.keys(PAX8_ORDER_STATUS_I18N_KEYS)).toEqual([
      'draft', 'awaiting_details', 'ready', 'submitting', 'completed', 'partially_failed', 'failed', 'cancelled', 'needs_reconcile',
    ]);
    expect(Object.keys(PAX8_ORDER_ACTION_I18N_KEYS)).toEqual(['new_subscription', 'change_quantity', 'cancel']);
    expect(Object.keys(PAX8_SUBMIT_STATE_I18N_KEYS)).toEqual(['pending', 'in_flight', 'succeeded', 'failed', 'needs_reconcile']);
    expect(Object.keys(PAX8_BILLING_TERM_I18N_KEYS)).toEqual(['Monthly', 'Annual', '2-Year', '3-Year', 'One-Time', 'Trial', 'Activation']);

    const translated = es419.pax8.enums;
    expect(translated.orderStatus.awaitingDetails).toBe('Esperando detalles');
    expect(translated.lineAction.newSubscription).toBe('Nueva suscripción');
    expect(translated.submitState.inFlight).toBe('En curso');
    expect(translated.billingTerm.oneTime).toBe('Pago único');
    expect(PAX8_BILLING_TERM_I18N_KEYS['One-Time']).toBe('pax8.enums.billingTerm.oneTime');
  });

  it('renders localized labels while retaining exact Pax8 billing values', async () => {
    await loadLocale('es-419');
    await act(() => i18n.changeLanguage('es-419'));
    render(<Pax8OrderBuilder
      bundle={orderBundle({ status: 'awaiting_details', submitStates: ['in_flight'] })}
      products={[product]}
      onReload={vi.fn()}
      onBack={vi.fn()}
    />);

    expect(screen.getByText('Esperando detalles')).toBeInTheDocument();
    expect(screen.getByText('Nueva suscripción')).toBeInTheDocument();
    expect(screen.getByText('En curso')).toBeInTheDocument();
    const terms = screen.getByRole('combobox', { name: 'Plazo de facturación' }) as HTMLSelectElement;
    expect([...terms.options].map((option) => option.value)).toEqual([
      'Monthly', 'Annual', '2-Year', '3-Year', 'One-Time', 'Trial', 'Activation',
    ]);
    expect([...terms.options].map((option) => option.text)).toContain('Pago único');
  });
});
