import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Pax8ProvisioningForm } from './Pax8ProvisioningForm';
import { extractPax8PreflightErrors } from './pax8OrderUi';
import Pax8OrderBuilder from './Pax8OrderBuilder';
import { preflightPax8Order, submitPax8Order } from '../../lib/api/pax8Orders';

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

beforeEach(() => vi.clearAllMocks());

describe('Pax8 provisioning details', () => {
  it('renders Single-Value fields with exactly the Pax8 possible values', () => {
    render(
      <Pax8ProvisioningForm
        fields={[{
          key: 'region',
          label: 'Region',
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

  it('keeps every field optional and supports an accessible native multiselect', async () => {
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState<Array<{ key: string; values: string[] }>>([]);
      return <Pax8ProvisioningForm fields={[
        { key: 'alias', label: 'Alias', valueType: 'Input', possibleValues: [] },
        { key: 'features', label: 'Features', valueType: 'Multi-Value', possibleValues: ['A', 'B'] },
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
});
