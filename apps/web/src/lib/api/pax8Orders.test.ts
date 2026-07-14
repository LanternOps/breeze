import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { fetchWithAuth } from '../../stores/auth';
import {
  addPax8OrderLine,
  type AddPax8OrderLineRequest,
  listPax8Orders,
  readData,
  updatePax8OrderLine,
} from './pax8Orders';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

describe('Pax8 ordering API client', () => {
  it('does not expose tenant linkage as client-controlled add-line input', () => {
    expectTypeOf<AddPax8OrderLineRequest>().not.toHaveProperty('contractLineId');
  });
  it('scopes the order list to the selected organization', () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(new Response());
    void listPax8Orders('org/one');
    expect(fetchWithAuth).toHaveBeenCalledWith('/pax8/orders?orgId=org%2Fone');
  });

  it('sends only the staged-line editable fields through PATCH', () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(new Response());
    void updatePax8OrderLine('order-1', 'line-1', {
      commitmentTermId: 'commit-1',
      provisioningDetails: [{ key: 'domain', values: ['acme.example'] }],
    });
    expect(fetchWithAuth).toHaveBeenCalledWith('/pax8/orders/order-1/lines/line-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commitmentTermId: 'commit-1',
        provisioningDetails: [{ key: 'domain', values: ['acme.example'] }],
      }),
    });
  });

  it('does not send a client-selected contract line when staging a subscription change', () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(new Response());
    void addPax8OrderLine('order-1', {
      action: 'change_quantity',
      targetSubscriptionId: 'subscription-1',
      quantity: '12',
    });
    expect(fetchWithAuth).toHaveBeenCalledWith('/pax8/orders/order-1/lines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'change_quantity',
        targetSubscriptionId: 'subscription-1',
        quantity: '12',
      }),
    });
  });

  it('fails closed on a successful response without the expected data envelope', async () => {
    const response = new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
    await expect(readData(response, 'Malformed Pax8 response')).rejects.toThrow('Malformed Pax8 response');
  });
});
