import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import Pax8OrgTab, { Pax8SubscriptionTable } from './Pax8OrgTab';
import {
  listPax8Companies,
  listPax8Orders,
  listPax8Products,
  listPax8Subscriptions,
  getProductDependencies,
  addPax8OrderLine,
} from '../../lib/api/pax8Orders';

vi.mock('../../lib/api/pax8Orders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/pax8Orders')>();
  return {
    ...actual,
    listPax8Companies: vi.fn(),
    listPax8Orders: vi.fn(),
    listPax8Products: vi.fn(),
    listPax8Subscriptions: vi.fn(),
    getProductDependencies: vi.fn(),
    addPax8OrderLine: vi.fn(),
  };
});

const response = (payload: unknown) => Promise.resolve(new Response(JSON.stringify(payload), {
  status: 200, headers: { 'content-type': 'application/json' },
}));

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = '#pax8';
});

describe('Pax8 subscription ledger display', () => {
  it('uses Breeze quantity as primary and never invents Pax8 zero', () => {
    render(
      <Pax8SubscriptionTable
        subscriptions={[
          {
            id: 'snapshot-1', pax8SubscriptionId: 'sub-1', productId: 'product-1',
            productName: 'Microsoft 365', status: 'Active', breezeQuantity: '12.00',
            quantity: '0.00', quantityKnown: false, lastSeenAt: '2026-07-14T12:00:00Z',
          },
        ]}
        onChangeQuantity={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByTestId('pax8-breeze-quantity-snapshot-1')).toHaveTextContent('12');
    expect(screen.getByTestId('pax8-reported-quantity-snapshot-1')).toHaveTextContent('Not reported');
    expect(screen.queryByTestId('pax8-drift-snapshot-1')).not.toBeInTheDocument();
  });

  it('shows drift only when Pax8 reported a known disagreement', () => {
    render(
      <Pax8SubscriptionTable
        subscriptions={[
          {
            id: 'snapshot-2', pax8SubscriptionId: 'sub-2', productId: 'product-2',
            productName: 'SentinelOne', status: 'Active', breezeQuantity: '9.00',
            quantity: '8.00', quantityKnown: true, lastSeenAt: '2026-07-14T12:00:00Z',
          },
        ]}
        onChangeQuantity={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByTestId('pax8-drift-snapshot-2')).toBeInTheDocument();
  });
});

describe('Pax8 organization mapping state', () => {
  it('teaches the next mapping action when the org is unmapped', async () => {
    vi.mocked(listPax8Companies).mockImplementation(() => response({
      data: [{
        pax8CompanyId: 'company-1', pax8CompanyName: 'Acme', status: 'Active',
        mappedOrgId: null, mappedOrgName: null, ignored: false, lastSeenAt: null,
      }],
      integrationId: 'integration-1',
    }));
    vi.mocked(listPax8Subscriptions).mockImplementation(() => response({ data: [], integrationId: 'integration-1' }));
    vi.mocked(listPax8Orders).mockImplementation(() => response({ data: [] }));
    vi.mocked(listPax8Products).mockImplementation(() => response({ data: [] }));

    render(<Pax8OrgTab orgId="org-1" />);

    expect(await screen.findByTestId('pax8-mapping-empty')).toHaveTextContent(/map this organization/i);
    expect(screen.getByRole('combobox', { name: /pax8 company/i })).toBeInTheDocument();
    expect(screen.getByTestId('pax8-new-order')).toBeDisabled();
  });

  it('blocks a quantity increase when the active commitment forbids it', async () => {
    vi.mocked(listPax8Companies).mockImplementation(() => response({
      data: [{
        pax8CompanyId: 'company-1', pax8CompanyName: 'Acme', status: 'Active',
        mappedOrgId: 'org-1', mappedOrgName: 'Acme', ignored: false, lastSeenAt: null,
      }], integrationId: 'integration-1',
    }));
    vi.mocked(listPax8Subscriptions).mockImplementation(() => response({
      data: [{
        id: 'snapshot-1', pax8SubscriptionId: 'sub-1', productId: 'prod-1', productName: 'Microsoft 365',
        status: 'Active', breezeQuantity: '5.00', quantity: '5.00', quantityKnown: true,
        lastSeenAt: '2026-07-14T00:00:00Z', contractLineId: 'contract-line-1',
      }], integrationId: 'integration-1',
    }));
    vi.mocked(listPax8Orders).mockImplementation(() => response({ data: [] }));
    vi.mocked(listPax8Products).mockImplementation(() => response({ data: [{
      pax8ProductId: 'prod-1', catalogItemId: 'cat-1', catalogName: 'Microsoft 365',
    }] }));
    vi.mocked(getProductDependencies).mockImplementation(() => response({ data: { commitments: [{
      id: 'commit-1', term: 'Annual', allowForQuantityIncrease: false,
      allowForQuantityDecrease: true, allowForEarlyCancellation: true, cancellationFeeApplied: false,
    }] } }));

    render(<Pax8OrgTab orgId="org-1" />);
    const quantity = await screen.findByRole('spinbutton', { name: /target quantity/i });
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '6');
    await userEvent.click(screen.getByRole('button', { name: /stage change/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/does not allow quantity increases/i);
    expect(addPax8OrderLine).not.toHaveBeenCalled();
  });
});
