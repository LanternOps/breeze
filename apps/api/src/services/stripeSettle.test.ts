import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ rows: [] as unknown[][], depth: 0, held: false, client: vi.fn(), retrieve: vi.fn(), record: vi.fn(), archive: vi.fn() }));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const name of ['select', 'from', 'innerJoin', 'where', 'limit']) chain[name] = vi.fn(() => chain);
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(h.rows.shift() ?? []).then(resolve);
  return {
    db: chain,
    hasDbAccessContext: () => h.held || h.depth > 0,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: async (fn: () => Promise<unknown>) => { h.depth++; try { return await fn(); } finally { h.depth--; } },
  };
});
vi.mock('./partnerStripe', () => ({
  getPartnerStripeClient: h.client,
  PartnerStripeError: class PartnerStripeError extends Error { constructor(message: string, readonly code: string) { super(message); } },
}));
vi.mock('./stripeReconcile', () => ({ recordStripePayment: h.record }));
vi.mock('./stripeCredentialArchive', () => ({ findLatestArchivedCredentialForAccount: h.archive }));
import { settlePaymentIntent } from './stripeSettle';
const mapping = { id: '11111111-1111-4111-8111-111111111111', invoiceId: '22222222-2222-4222-8222-222222222222', stripeAccountId: 'acct_original', revocationCredentialId: null };
beforeEach(() => {
  vi.clearAllMocks(); h.rows.length = 0; h.depth = 0; h.held = false;
  h.client.mockResolvedValue({ stripe: { paymentIntents: { retrieve: h.retrieve } }, stripeAccountId: 'acct_original', defaultCurrency: 'USD' });
  h.record.mockResolvedValue({ invoiceId: mapping.invoiceId });
  h.retrieve.mockImplementation(async () => { expect(h.depth).toBe(0); return { id: 'pi_test', status: 'succeeded', amount_received: 10300, currency: 'usd' }; });
});
describe('settlePaymentIntent', () => {
  it('books provider gross outside the Stripe HTTP phase and checks the durable payment link', async () => {
    h.rows.push([mapping], [{ invoicePaymentId: '33333333-3333-4333-8333-333333333333' }]);
    await expect(settlePaymentIntent('44444444-4444-4444-8444-444444444444', 'pi_test')).resolves.toEqual({ settled: true, status: 'succeeded', invoiceId: mapping.invoiceId });
    expect(h.record).toHaveBeenCalledWith({ stripeObjectId: 'pi_test', stripePaymentIntentId: 'pi_test', stripeAccountId: 'acct_original', amount: '103.00', currency: 'USD' });
  });
  it('processing keeps the reservation and does not write a payment', async () => {
    h.rows.push([mapping]);
    h.retrieve.mockResolvedValue({ id: 'pi_test', status: 'processing', currency: 'usd', amount_received: 0 });
    await expect(settlePaymentIntent('partner', 'pi_test')).resolves.toEqual({ settled: false, status: 'processing', invoiceId: mapping.invoiceId });
    expect(h.record).not.toHaveBeenCalled();
  });
  it('uses the mapping archive when the partner disconnected, without checking rollout', async () => {
    h.rows.push([{ ...mapping, revocationCredentialId: 'archive-id' }], [{ invoicePaymentId: 'payment-id' }]);
    await settlePaymentIntent('partner', 'pi_test');
    expect(h.client).toHaveBeenCalledWith('partner', { archivedCredentialId: 'archive-id', invoiceStripePaymentId: mapping.id });
  });
  it('never retrieves another partner\'s mapping', async () => {
    h.rows.push([]);
    await expect(settlePaymentIntent('wrong-partner', 'pi_test')).rejects.toMatchObject({ status: 404, code: 'INVOICE_NOT_FOUND' });
    expect(h.client).not.toHaveBeenCalled();
  });
  it('does not claim settled when captured money could not be applied', async () => {
    h.rows.push([mapping], [{ invoicePaymentId: null }]);
    await expect(settlePaymentIntent('partner', 'pi_test')).resolves.toMatchObject({ settled: false, status: 'succeeded' });
  });
  it('rejects a held caller transaction before any query or HTTP call', async () => {
    h.held = true;
    await expect(settlePaymentIntent('partner', 'pi_test')).rejects.toThrow(/must run outside any DB access context/);
    expect(h.client).not.toHaveBeenCalled();
  });
});
