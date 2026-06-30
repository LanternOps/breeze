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
const sub = { id: 'sub-1', orgId: 'org-1', productName: 'Microsoft 365 E3', quantity: 5, unitPrice: null };

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

  it('keeps submit disabled for an invalid new-line price', async () => {
    render(<LinkSubscriptionPicker integrationId="int-1" subscription={sub} onDone={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => screen.getByTestId('pax8-link-contract'));
    fireEvent.change(screen.getByTestId('pax8-link-contract'), { target: { value: 'c1' } });
    await waitFor(() => screen.getByTestId('pax8-link-line'));
    fireEvent.change(screen.getByTestId('pax8-link-line'), { target: { value: '__new__' } });
    // Garbage and over-precise values must not satisfy MONEY_RE.
    for (const bad of ['abc', '36.999', '']) {
      fireEvent.change(screen.getByTestId('pax8-link-new-price'), { target: { value: bad } });
      expect((screen.getByTestId('pax8-link-submit') as HTMLButtonElement).disabled).toBe(true);
    }
    // A valid 2-decimal value enables submit.
    fireEvent.change(screen.getByTestId('pax8-link-new-price'), { target: { value: '36.00' } });
    expect((screen.getByTestId('pax8-link-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('prefills the new-line price from the Pax8 subscription sell price', async () => {
    render(<LinkSubscriptionPicker integrationId="int-1" subscription={{ ...sub, unitPrice: '42.5' }} onDone={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => screen.getByTestId('pax8-link-contract'));
    fireEvent.change(screen.getByTestId('pax8-link-contract'), { target: { value: 'c1' } });
    await waitFor(() => screen.getByTestId('pax8-link-line'));
    fireEvent.change(screen.getByTestId('pax8-link-line'), { target: { value: '__new__' } });
    // Seeded to a clean 2-decimal value and submit is immediately enabled.
    expect((screen.getByTestId('pax8-link-new-price') as HTMLInputElement).value).toBe('42.50');
    expect((screen.getByTestId('pax8-link-submit') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('pax8-link-submit'));
    await waitFor(() => expect(addContractLine).toHaveBeenCalled());
    expect(addContractLine.mock.calls[0][1]).toMatchObject({ unitPrice: '42.50' });
  });

  it('leaves the new-line price blank for a zero sell price and keeps submit disabled', async () => {
    render(<LinkSubscriptionPicker integrationId="int-1" subscription={{ ...sub, unitPrice: '0.00' }} onDone={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => screen.getByTestId('pax8-link-contract'));
    fireEvent.change(screen.getByTestId('pax8-link-contract'), { target: { value: 'c1' } });
    await waitFor(() => screen.getByTestId('pax8-link-line'));
    fireEvent.change(screen.getByTestId('pax8-link-line'), { target: { value: '__new__' } });
    // A zero (or negative) Pax8 price is not a real sell price — blank it so the
    // partner must enter one, rather than seeding a $0.00 line.
    expect((screen.getByTestId('pax8-link-new-price') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('pax8-link-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('leaves the new-line price blank when the subscription has no sell price', async () => {
    render(<LinkSubscriptionPicker integrationId="int-1" subscription={{ ...sub, unitPrice: null }} onDone={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => screen.getByTestId('pax8-link-contract'));
    fireEvent.change(screen.getByTestId('pax8-link-contract'), { target: { value: 'c1' } });
    await waitFor(() => screen.getByTestId('pax8-link-line'));
    fireEvent.change(screen.getByTestId('pax8-link-line'), { target: { value: '__new__' } });
    expect((screen.getByTestId('pax8-link-new-price') as HTMLInputElement).value).toBe('');
    expect((screen.getByTestId('pax8-link-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('surfaces an inline error when the contract list fails to load', async () => {
    listContracts.mockResolvedValue(new Response('{"error":"nope"}', { status: 500 }));
    render(<LinkSubscriptionPicker integrationId="int-1" subscription={sub} onDone={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => screen.getByTestId('pax8-link-error'));
    // The dropdown must not silently look like "no contracts".
    expect(addContractLine).not.toHaveBeenCalled();
  });
});
