import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../db', () => ({
  db: { select: vi.fn(), update: vi.fn() },
}));

vi.mock('../../../db/schema', () => ({
  partners: {
    id: 'partners.id',
    emailVerifiedAt: 'partners.emailVerifiedAt',
    paymentMethodAttachedAt: 'partners.paymentMethodAttachedAt',
    stripeCustomerId: 'partners.stripeCustomerId',
  },
}));

vi.mock('../../../services/breezeBillingClient', () => ({
  getBreezeBillingClient: vi.fn(),
}));

import { attachPaymentMethodTool } from './attachPaymentMethod';
import { db } from '../../../db';
import { getBreezeBillingClient } from '../../../services/breezeBillingClient';

function enqueueSelects(rows: unknown[][]): void {
  const queue = [...rows];
  vi.mocked(db.select).mockImplementation(() => {
    const chain: any = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockImplementation(() => Promise.resolve(queue.shift() ?? [])),
    };
    return chain as any;
  });
}

describe('attach_payment_method', () => {
  const createSetupIntent = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    createSetupIntent.mockReset();
    vi.mocked(getBreezeBillingClient).mockReturnValue({ createSetupIntent } as any);
    process.env.PUBLIC_ACTIVATION_BASE_URL = 'https://us.2breeze.app';

    // Default update() mock — resolves successfully.
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    } as any);
  });

  it('throws UNKNOWN_TENANT when partner row missing', async () => {
    enqueueSelects([[]]);
    await expect(
      attachPaymentMethodTool.handler(
        { tenant_id: '00000000-0000-0000-0000-000000000000' },
        {} as any,
      ),
    ).rejects.toMatchObject({ code: 'UNKNOWN_TENANT' });
    expect(createSetupIntent).not.toHaveBeenCalled();
  });

  it('throws EMAIL_NOT_VERIFIED when emailVerifiedAt is null', async () => {
    enqueueSelects([
      [{ id: 'p1', emailVerifiedAt: null, paymentMethodAttachedAt: null }],
    ]);
    await expect(
      attachPaymentMethodTool.handler({ tenant_id: 'p1' }, {} as any),
    ).rejects.toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
    expect(createSetupIntent).not.toHaveBeenCalled();
  });

  it('is idempotent when payment method already attached', async () => {
    enqueueSelects([
      [{
        id: 'p1',
        emailVerifiedAt: new Date(),
        paymentMethodAttachedAt: new Date(),
      }],
    ]);
    const r = await attachPaymentMethodTool.handler({ tenant_id: 'p1' }, {} as any);
    expect(r).toEqual({ setup_url: null, already_attached: true });
    expect(createSetupIntent).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('calls billing client, stores customer id, returns setup_url on happy path', async () => {
    enqueueSelects([
      [{ id: 'p1', emailVerifiedAt: new Date(), paymentMethodAttachedAt: null }],
    ]);
    createSetupIntent.mockResolvedValue({
      setupUrl: 'https://stripe.example/setup/abc',
      customerId: 'cus_123',
    });
    const setMock = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

    const r = await attachPaymentMethodTool.handler({ tenant_id: 'p1' }, {} as any);

    expect(r).toEqual({
      setup_url: 'https://stripe.example/setup/abc',
      already_attached: false,
    });
    expect(createSetupIntent).toHaveBeenCalledWith({
      partnerId: 'p1',
      returnUrl: 'https://us.2breeze.app/activate/complete?partner=p1',
    });
    expect(setMock).toHaveBeenCalledWith({ stripeCustomerId: 'cus_123' });
  });
});
