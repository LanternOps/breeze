import type Stripe from 'stripe';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ client: vi.fn(), depth: 0 }));
vi.mock('../partnerStripe', () => ({ getPartnerStripeClient: h.client }));
vi.mock('../../db', () => ({ runOutsideDbContext: (fn: () => unknown) => fn() }));
import { getPartnerStripeClient } from '../partnerStripe';
import { probeAutopayCapabilities, getAutopayStripeReadiness } from './stripeCapabilities';
import type { Tx } from './types';
const missingResource = () => Object.assign(new Error('synthetic missing object'), { type: 'StripeInvalidRequestError', code: 'resource_missing' });
function client() {
  const call = () => vi.fn().mockRejectedValue(missingResource());
  return { customers: { update: call() }, setupIntents: { update: call() }, paymentIntents: { update: call() }, paymentMethods: { update: call() }, mandates: { retrieve: call() } };
}
function executor(row?: Record<string, unknown>): Tx {
  const chain: Record<string, unknown> = {};
  for (const name of ['select', 'from', 'where', 'limit']) chain[name] = () => chain;
  chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(row ? [row] : []).then(resolve);
  return chain as unknown as Tx;
}
beforeEach(() => vi.clearAllMocks());
describe('autopay capability probes', () => {
  it('proves all five write/read permissions using missing resources without creating objects', async () => {
    const sdk = client(); h.client.mockResolvedValue({ stripe: sdk });
    const { stripe } = await getPartnerStripeClient('partner', { candidateApiKey: 'synthetic_candidate' });
    await expect(probeAutopayCapabilities(stripe)).resolves.toEqual({ missing: [] });
    expect(sdk.customers.update).toHaveBeenCalledWith('cus_breeze_autopay_permission_probe', { metadata: {} });
    expect(sdk.setupIntents.update).toHaveBeenCalledTimes(1);
    expect(sdk.paymentIntents.update).toHaveBeenCalledTimes(1);
    expect(sdk.paymentMethods.update).toHaveBeenCalledTimes(1);
    expect(sdk.mandates.retrieve).toHaveBeenCalledTimes(1);
  });
  it('treats a successful synthetic-id response as permitted', async () => {
    const sdk = client(); sdk.customers.update.mockResolvedValue({}); h.client.mockResolvedValue({ stripe: sdk });
    const { stripe } = await getPartnerStripeClient('partner');
    await expect(probeAutopayCapabilities(stripe)).resolves.toEqual({ missing: [] });
  });
  it('reports only the denied permission', async () => {
    const sdk = client(); sdk.setupIntents.update.mockRejectedValue(Object.assign(new Error('denied'), { type: 'StripePermissionError' }));
    h.client.mockResolvedValue({ stripe: sdk });
    const { stripe } = await getPartnerStripeClient('partner');
    await expect(probeAutopayCapabilities(stripe)).resolves.toEqual({ missing: ['setup_intents_write'] });
  });
  it.each(['StripeAPIError', 'StripeConnectionError', 'StripeRateLimitError', 'StripeAuthenticationError', 'unexpected'])('does not call %s a missing permission', async (type) => {
    const sdk = client(); sdk.customers.update.mockRejectedValue(Object.assign(new Error('probe failure'), { type }));
    h.client.mockResolvedValue({ stripe: sdk });
    const { stripe } = await getPartnerStripeClient('partner');
    await expect(probeAutopayCapabilities(stripe)).rejects.toThrow('probe failure');
  });
  it.each([
    ['US', new Date(), [], true], ['IN', new Date(), [], false],
    ['US', null, [], false], ['US', new Date(), ['mandates_read'], false],
  ])('country=%s probe=%s missing=%s yields ready=%s', async (accountCountry, checked, missing, ready) => {
    const tx = executor({ status: 'connected', stripeAccountId: 'acct_test', accountCountry, autopayCapabilitiesCheckedAt: checked, autopayMissingPermissions: missing });
    await expect(getAutopayStripeReadiness(tx, 'partner')).resolves.toMatchObject({ ready, missing, stripeAccountId: 'acct_test', accountCountry });
  });
  it('an invisible or disconnected connection cannot become ready', async () => {
    await expect(getAutopayStripeReadiness(executor(), 'partner')).resolves.toEqual({ ready: false, missing: [], stripeAccountId: null, accountCountry: null });
  });
});
