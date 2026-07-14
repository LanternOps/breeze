import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Pax8OrgTab, { Pax8SubscriptionTable } from './Pax8OrgTab';
import {
  listPax8Companies,
  listPax8Orders,
  listPax8Products,
  listPax8Subscriptions,
  getProductDependencies,
  addPax8OrderLine,
  getPax8Order,
  preflightPax8Order,
  submitPax8Order,
} from '../../lib/api/pax8Orders';
import { i18n, loadLocale } from '../../lib/i18n';

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
    getPax8Order: vi.fn(),
    preflightPax8Order: vi.fn(),
    submitPax8Order: vi.fn(),
  };
});

const response = (payload: unknown) => Promise.resolve(new Response(JSON.stringify(payload), {
  status: 200, headers: { 'content-type': 'application/json' },
}));

const order = (id: string, orgId = 'org-1') => ({
  id,
  integrationId: 'integration-1',
  partnerId: 'partner-1',
  orgId,
  pax8CompanyId: 'company-1',
  status: 'draft',
  source: 'direct',
  sourceQuoteId: null,
  pax8OrderId: null,
  error: null,
  submittedAt: null,
  createdAt: '2026-07-14T00:00:00Z',
  updatedAt: '2026-07-14T00:00:00Z',
} as const);

beforeEach(async () => {
  vi.clearAllMocks();
  window.location.hash = '#pax8';
  await i18n.changeLanguage('en');
});

afterEach(async () => {
  await act(() => i18n.changeLanguage('en'));
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

  it('uses the snapshot active commitment when multiple dependency commitments exist', async () => {
    vi.mocked(listPax8Companies).mockImplementation(() => response({ data: [{
      pax8CompanyId: 'company-1', pax8CompanyName: 'Acme', status: 'Active', mappedOrgId: 'org-1',
      mappedOrgName: 'Acme', ignored: false, lastSeenAt: null, orderReady: true,
      primaryAdminReady: true, primaryBillingReady: true, primaryTechnicalReady: true,
    }], integrationId: 'integration-1' }));
    vi.mocked(listPax8Subscriptions).mockImplementation(() => response({ data: [{
      id: 'snapshot-1', pax8SubscriptionId: 'sub-1', productId: 'prod-1', productName: 'Microsoft 365',
      status: 'Active', breezeQuantity: '5.00', quantity: '5.00', quantityKnown: true,
      activeCommitmentId: 'active', activeCommitmentAmbiguous: false,
      lastSeenAt: '2026-07-14T00:00:00Z', contractLineId: 'contract-line-1',
    }], integrationId: 'integration-1' }));
    vi.mocked(listPax8Orders).mockImplementation(() => response({ data: [{
      id: '44444444-4444-4444-8444-444444444444', integrationId: 'integration-1', partnerId: 'partner-1',
      orgId: 'org-1', pax8CompanyId: 'company-1', status: 'draft', source: 'direct', sourceQuoteId: null,
      pax8OrderId: null, error: null, submittedAt: null, createdAt: '2026-07-14T00:00:00Z', updatedAt: '2026-07-14T00:00:00Z',
    }] }));
    vi.mocked(listPax8Products).mockImplementation(() => response({ data: [{
      pax8ProductId: 'prod-1', catalogItemId: 'cat-1', catalogName: 'Microsoft 365',
    }] }));
    vi.mocked(getProductDependencies).mockImplementation(() => response({ data: { commitments: [
      { id: 'other', term: 'Annual', allowForQuantityIncrease: false, allowForQuantityDecrease: false, allowForEarlyCancellation: false, cancellationFeeApplied: false },
      { id: 'active', term: 'Monthly', allowForQuantityIncrease: true, allowForQuantityDecrease: true, allowForEarlyCancellation: true, cancellationFeeApplied: false },
    ] } }));
    vi.mocked(addPax8OrderLine).mockImplementation(() => response({ data: { id: 'line-1' } }));

    render(<Pax8OrgTab orgId="org-1" />);
    const quantity = await screen.findByRole('spinbutton', { name: /target quantity/i });
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '6');
    await userEvent.click(screen.getByRole('button', { name: /stage change/i }));

    await vi.waitFor(() => expect(addPax8OrderLine).toHaveBeenCalledWith(
      '44444444-4444-4444-8444-444444444444',
      { action: 'change_quantity', targetSubscriptionId: 'sub-1', quantity: '6' },
    ));
  });

  it('fails closed when the snapshot active commitment forbids the requested action', async () => {
    vi.mocked(listPax8Companies).mockImplementation(() => response({ data: [{
      pax8CompanyId: 'company-1', pax8CompanyName: 'Acme', status: 'Active', mappedOrgId: 'org-1',
      mappedOrgName: 'Acme', ignored: false, lastSeenAt: null, orderReady: true,
      primaryAdminReady: true, primaryBillingReady: true, primaryTechnicalReady: true,
    }], integrationId: 'integration-1' }));
    vi.mocked(listPax8Subscriptions).mockImplementation(() => response({ data: [{
      id: 'snapshot-1', pax8SubscriptionId: 'sub-1', productId: 'prod-1', productName: 'Microsoft 365',
      status: 'Active', breezeQuantity: '5.00', quantity: '5.00', quantityKnown: true,
      activeCommitmentId: 'blocked', activeCommitmentAmbiguous: false,
      lastSeenAt: '2026-07-14T00:00:00Z', contractLineId: 'contract-line-1',
    }], integrationId: 'integration-1' }));
    vi.mocked(listPax8Orders).mockImplementation(() => response({ data: [] }));
    vi.mocked(listPax8Products).mockImplementation(() => response({ data: [] }));
    vi.mocked(getProductDependencies).mockImplementation(() => response({ data: { commitments: [
      { id: 'allowed', term: 'Annual', allowForQuantityIncrease: true, allowForQuantityDecrease: true, allowForEarlyCancellation: true, cancellationFeeApplied: false },
      { id: 'blocked', term: 'Monthly', allowForQuantityIncrease: false, allowForQuantityDecrease: true, allowForEarlyCancellation: true, cancellationFeeApplied: false },
    ] } }));

    render(<Pax8OrgTab orgId="org-1" />);
    const quantity = await screen.findByRole('spinbutton', { name: /target quantity/i });
    await userEvent.clear(quantity);
    await userEvent.type(quantity, '6');
    await userEvent.click(screen.getByRole('button', { name: /stage change/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/does not allow quantity increases/i);
    expect(addPax8OrderLine).not.toHaveBeenCalled();
  });

  it('stages cancellation by subscription identity without sending tenant linkage', async () => {
    vi.mocked(listPax8Companies).mockImplementation(() => response({ data: [{
      pax8CompanyId: 'company-1', pax8CompanyName: 'Acme', status: 'Active', mappedOrgId: 'org-1',
      mappedOrgName: 'Acme', ignored: false, lastSeenAt: null, orderReady: true,
      primaryAdminReady: true, primaryBillingReady: true, primaryTechnicalReady: true,
    }], integrationId: 'integration-1' }));
    vi.mocked(listPax8Subscriptions).mockImplementation(() => response({ data: [{
      id: 'snapshot-1', pax8SubscriptionId: 'sub-1', productId: 'prod-1', productName: 'Microsoft 365',
      status: 'Active', breezeQuantity: '5.00', quantity: '5.00', quantityKnown: true,
      activeCommitmentId: 'active', activeCommitmentAmbiguous: false,
      lastSeenAt: '2026-07-14T00:00:00Z', contractLineId: 'contract-line-1',
    }], integrationId: 'integration-1' }));
    vi.mocked(listPax8Orders).mockImplementation(() => response({ data: [order('44444444-4444-4444-8444-444444444444')] }));
    vi.mocked(listPax8Products).mockImplementation(() => response({ data: [{
      pax8ProductId: 'prod-1', catalogItemId: 'cat-1', catalogName: 'Microsoft 365',
    }] }));
    vi.mocked(getProductDependencies).mockImplementation(() => response({ data: { commitments: [{
      id: 'active', term: 'Monthly', allowForQuantityIncrease: true, allowForQuantityDecrease: true,
      allowForEarlyCancellation: true, cancellationFeeApplied: false,
    }] } }));
    vi.mocked(addPax8OrderLine).mockImplementation(() => response({ data: { id: 'line-1' } }));

    render(<Pax8OrgTab orgId="org-1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await userEvent.click(screen.getByRole('button', { name: 'Stage cancellation' }));

    await vi.waitFor(() => expect(addPax8OrderLine).toHaveBeenCalledWith(
      '44444444-4444-4444-8444-444444444444',
      { action: 'cancel', targetSubscriptionId: 'sub-1' },
    ));
  });

  it('fails closed for a deep-linked order belonging to another organization', async () => {
    window.location.hash = '#pax8/44444444-4444-4444-8444-444444444444';
    vi.mocked(listPax8Companies).mockImplementation(() => response({ data: [], integrationId: 'integration-1' }));
    vi.mocked(listPax8Subscriptions).mockImplementation(() => response({ data: [], integrationId: 'integration-1' }));
    vi.mocked(listPax8Orders).mockImplementation(() => response({ data: [] }));
    vi.mocked(listPax8Products).mockImplementation(() => response({ data: [] }));
    vi.mocked(getPax8Order).mockImplementation(() => response({ data: {
      order: {
        id: '44444444-4444-4444-8444-444444444444', integrationId: 'integration-1', partnerId: 'partner-1',
        orgId: 'org-2', pax8CompanyId: 'company-2', status: 'draft', source: 'direct', sourceQuoteId: null,
        pax8OrderId: null, error: null, submittedAt: null, createdAt: '2026-07-14T00:00:00Z', updatedAt: '2026-07-14T00:00:00Z',
      }, lines: [],
    } }));

    render(<Pax8OrgTab orgId="org-1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/organization/i);
    expect(screen.queryByTestId('pax8-submit')).not.toBeInTheDocument();
    expect(preflightPax8Order).not.toHaveBeenCalled();
    expect(submitPax8Order).not.toHaveBeenCalled();
  });

  it('writes exact order hashes and follows root/order hash navigation', async () => {
    const firstId = '44444444-4444-4444-8444-444444444444';
    const secondId = '55555555-5555-4555-8555-555555555555';
    vi.mocked(listPax8Companies).mockImplementation(() => response({ data: [], integrationId: 'integration-1' }));
    vi.mocked(listPax8Subscriptions).mockImplementation(() => response({ data: [], integrationId: 'integration-1' }));
    vi.mocked(listPax8Orders).mockImplementation(() => response({ data: [order(firstId)] }));
    vi.mocked(listPax8Products).mockImplementation(() => response({ data: [] }));
    vi.mocked(getPax8Order).mockImplementation((id) => response({
      data: { order: order(id), lines: [] },
    }));

    render(<Pax8OrgTab orgId="org-1" />);

    await userEvent.click(await screen.findByRole('button', { name: /direct order/i }));
    expect(window.location.hash).toBe(`#pax8/${firstId}`);
    expect(await screen.findByTestId('pax8-order-builder')).toBeInTheDocument();
    expect(getPax8Order).toHaveBeenLastCalledWith(firstId);

    await userEvent.click(screen.getByRole('button', { name: /back to pax8/i }));
    expect(window.location.hash).toBe('#pax8');
    expect(await screen.findByTestId('pax8-org-tab')).toBeInTheDocument();

    act(() => {
      window.location.hash = `#pax8/${secondId}`;
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(await screen.findByTestId('pax8-order-builder')).toBeInTheDocument();
    expect(getPax8Order).toHaveBeenLastCalledWith(secondId);
  });

  it('localizes order-history status instead of displaying the wire enum', async () => {
    await loadLocale('es-419');
    await act(() => i18n.changeLanguage('es-419'));
    vi.mocked(listPax8Companies).mockImplementation(() => response({ data: [], integrationId: 'integration-1' }));
    vi.mocked(listPax8Subscriptions).mockImplementation(() => response({ data: [], integrationId: 'integration-1' }));
    vi.mocked(listPax8Orders).mockImplementation(() => response({ data: [order('44444444-4444-4444-8444-444444444444')] }));
    vi.mocked(listPax8Products).mockImplementation(() => response({ data: [] }));

    render(<Pax8OrgTab orgId="org-1" />);

    expect(await screen.findByText('Borrador')).toBeInTheDocument();
    expect(screen.queryByText('draft')).not.toBeInTheDocument();
  });
});
