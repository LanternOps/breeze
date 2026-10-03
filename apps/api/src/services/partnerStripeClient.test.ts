import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ StripeMock: vi.fn(), selectMock: vi.fn(), rows: [] as unknown[][], constructed: [] as unknown[][] }));
vi.mock('stripe', () => ({ default: class StripeStub { constructor(key: string, options: unknown) { h.constructed.push([key, options]); return h.StripeMock(key, options); } } }));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const name of ['select', 'from', 'where', 'limit', 'update', 'set']) chain[name] = () => { if (name === 'select') h.selectMock(); return chain; };
  chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(h.rows.shift() ?? []).then(resolve);
  return { db: chain };
});
vi.mock('./auditEvents', () => ({ writeAuditEventAsync: vi.fn().mockResolvedValue(undefined), requestLikeFromSnapshot: () => ({}) }));

import { encryptSecret } from './secretCrypto';
import { getPartnerStripeClient } from './partnerStripeClient';
import { StripeCredentialUnavailableError } from './stripeCredentialArchive';

const stripe = { mock: true };
const apiVersion = '2026-08-26.dahlia';
const connected = (apiKey: string) => ({ apiKey, status: 'connected', stripeAccountId: 'acct_test', defaultCurrency: 'usd' });

beforeEach(() => { vi.clearAllMocks(); h.rows.length = 0; h.constructed.length = 0; h.StripeMock.mockReturnValue(stripe); });

describe('getPartnerStripeClient credential boundary', () => {
  it('decrypts the real stored ciphertext and constructs Stripe with the pinned API version', async () => {
    h.rows.push([connected(encryptSecret('sk_test_real')!)]);
    await expect(getPartnerStripeClient('partner')).resolves.toMatchObject({ stripe, stripeAccountId: 'acct_test' });
    expect(h.constructed).toEqual([['sk_test_real', { apiVersion }]]);
  });

  it('rejects nonempty undecryptable ciphertext without constructing Stripe', async () => {
    h.rows.push([connected('enc:v1:not-valid-ciphertext')]);
    await expect(getPartnerStripeClient('partner')).rejects.toMatchObject({ code: 'STRIPE_KEY_UNREADABLE' });
    expect(h.constructed).toHaveLength(0);
  });

  it('uses a candidate key without reading stored ciphertext', async () => {
    await expect(getPartnerStripeClient('partner', { candidateApiKey: 'sk_test_candidate' })).resolves.toEqual({ stripe });
    expect(h.selectMock).not.toHaveBeenCalled();
    expect(h.constructed).toEqual([['sk_test_candidate', { apiVersion }]]);
  });

  it('decrypts an archived credential row and rejects an erased archive', async () => {
    h.rows.push([{ id: 'credential', partnerId: 'partner', stripeAccountId: 'acct_old', apiKey: encryptSecret('sk_test_archived'), generation: 1, erasedAt: null }]);
    await expect(getPartnerStripeClient('partner', { archivedCredentialId: 'credential' })).resolves.toMatchObject({ stripe, stripeAccountId: 'acct_old' });
    expect(h.constructed).toEqual([['sk_test_archived', { apiVersion }]]);

    h.rows.push([{ id: 'credential', partnerId: 'partner', stripeAccountId: 'acct_old', apiKey: null, generation: 1, erasedAt: new Date() }]);
    await expect(getPartnerStripeClient('partner', { archivedCredentialId: 'credential' })).rejects.toBeInstanceOf(StripeCredentialUnavailableError);
    expect(h.constructed).toHaveLength(1);
  });
});

it('prefers a current key on the original account over an archived mapping key', async () => {
  h.rows.push([connected(encryptSecret('sk_test_current')!)]);
  await expect(getPartnerStripeClient('partner', {
    reconciliationAccountId: 'acct_test', archivedCredentialId: 'old-credential', reason: 'autopay_recovery',
  })).resolves.toMatchObject({ stripeAccountId: 'acct_test' });
  expect(h.constructed).toEqual([['sk_test_current', { apiVersion }]]);
  expect(h.selectMock).toHaveBeenCalledOnce();
});
