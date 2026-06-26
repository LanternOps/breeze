import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const listContracts = vi.fn();
const getContract = vi.fn();
const addContractLine = vi.fn();
const fetchWithAuth = vi.fn();

vi.mock('../../lib/api/contracts', async (orig) => ({
  ...(await orig<typeof import('../../lib/api/contracts')>()),
  listContracts: (...a: unknown[]) => listContracts(...a),
  getContract: (...a: unknown[]) => getContract(...a),
  addContractLine: (...a: unknown[]) => addContractLine(...a),
}));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

import LinkSubscriptionPicker from './LinkSubscriptionPicker';

const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
const sub = { id: 'sub-1', orgId: 'org-1', productName: 'Microsoft 365 E3', quantity: 5 };

beforeEach(() => {
  listContracts.mockReset(); getContract.mockReset(); addContractLine.mockReset(); fetchWithAuth.mockReset();
  listContracts.mockResolvedValue(ok([{ id: 'c1', orgId: 'org-1', name: 'Acme Monthly', status: 'active' }]));
  getContract.mockResolvedValue(ok({
    contract: { id: 'c1' },
    lines: [{ id: 'line-existing', orgId: 'org-1', lineType: 'manual', description: 'Seats', unitPrice: '30.00', manualQuantity: '3' }],
  }));
  addContractLine.mockResolvedValue(ok({ id: 'line-new' }));
  fetchWithAuth.mockResolvedValue(ok({ id: 'link-1' }));
});

describe('LinkSubscriptionPicker', () => {
  it('links to an existing manual line', async () => {
    render(<LinkSubscriptionPicker integrationId="int-1" subscription={sub} onDone={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => screen.getByTestId('pax8-link-contract'));
    fireEvent.change(screen.getByTestId('pax8-link-contract'), { target: { value: 'c1' } });
    await waitFor(() => screen.getByTestId('pax8-link-line'));
    fireEvent.change(screen.getByTestId('pax8-link-line'), { target: { value: 'line-existing' } });
    fireEvent.click(screen.getByTestId('pax8-link-submit'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    const [url, opts] = fetchWithAuth.mock.calls[0];
    expect(url).toBe('/pax8/subscriptions/link');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toMatchObject({ integrationId: 'int-1', subscriptionSnapshotId: 'sub-1', contractLineId: 'line-existing', syncEnabled: true });
    expect(addContractLine).not.toHaveBeenCalled();
  });

  it('creates a new manual line then links to it', async () => {
    render(<LinkSubscriptionPicker integrationId="int-1" subscription={sub} onDone={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => screen.getByTestId('pax8-link-contract'));
    fireEvent.change(screen.getByTestId('pax8-link-contract'), { target: { value: 'c1' } });
    await waitFor(() => screen.getByTestId('pax8-link-line'));
    fireEvent.change(screen.getByTestId('pax8-link-line'), { target: { value: '__new__' } });
    fireEvent.change(screen.getByTestId('pax8-link-new-price'), { target: { value: '36.00' } });
    fireEvent.click(screen.getByTestId('pax8-link-submit'));
    await waitFor(() => expect(addContractLine).toHaveBeenCalled());
    const [cid, lineBody] = addContractLine.mock.calls[0];
    expect(cid).toBe('c1');
    expect(lineBody).toMatchObject({ lineType: 'manual', unitPrice: '36.00', manualQuantity: '5', taxable: false });
    const linkBody = JSON.parse(fetchWithAuth.mock.calls[0][1].body);
    expect(linkBody.contractLineId).toBe('line-new');
  });
});
