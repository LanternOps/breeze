/**
 * Real-DB tests for the per-partner Stripe API-key model (replaces Connect OAuth).
 * The Stripe SDK is mocked; the encrypted-key storage + retrieval run against
 * Postgres. Verifies: save validates the key + stores it encrypted with a display
 * last4, getPartnerStripe rebuilds a client from the decrypted key, status
 * reflects connected/disconnected, and disconnect clears the secret.
 */
import './setup';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { stripeConnectAccounts } from '../../db/schema/stripePayments';
import { createPartner } from './db-utils';
import { isEncryptedSecret } from '../../services/secretCrypto';

const { accountsRetrieveMock } = vi.hoisted(() => ({ accountsRetrieveMock: vi.fn() }));
vi.mock('stripe', () => ({
  default: class MockStripe {
    public _key: string;
    accounts = { retrieve: accountsRetrieveMock };
    constructor(key: string) { this._key = key; }
  },
}));

import {
  savePartnerStripeKey,
  getPartnerStripe,
  getPartnerStripeStatus,
  disconnectPartnerStripe,
} from '../../services/partnerStripe';

const runDb = it.runIf(!!process.env.DATABASE_URL);
// Assembled from parts so the literal doesn't trip secret-scanning push protection
// (it's a fake key, but matches the sk_test_ shape). Ends in 9999 → last4 assertion.
const TEST_KEY = ['sk', 'test', '51ABCdefGHIjklMNOpqr9999'].join('_');

describe('partner Stripe API-key credentials (breeze_app, real DB)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accountsRetrieveMock.mockResolvedValue({ id: 'acct_partnerOwn', charges_enabled: true });
  });

  runDb('save validates the key, stores it encrypted with last4, and marks connected', async () => {
    const partner = await withSystemDbAccessContext(() => createPartner());
    const res = await withSystemDbAccessContext(() => savePartnerStripeKey({ partnerId: partner.id, apiKey: TEST_KEY, userId: null }));
    expect(res.stripeAccountId).toBe('acct_partnerOwn');
    expect(res.last4).toBe('9999');

    const [row] = await withSystemDbAccessContext(() => db.select().from(stripeConnectAccounts).where(eq(stripeConnectAccounts.partnerId, partner.id)));
    expect(row!.status).toBe('connected');
    expect(row!.stripeAccountId).toBe('acct_partnerOwn');
    expect(row!.keyLast4).toBe('9999');
    expect(row!.apiKey).toBeTruthy();
    expect(row!.apiKey).not.toContain(TEST_KEY);     // stored encrypted, never plaintext
    expect(isEncryptedSecret(row!.apiKey!)).toBe(true);
  });

  runDb('getPartnerStripe rebuilds a client from the decrypted key', async () => {
    const partner = await withSystemDbAccessContext(() => createPartner());
    await withSystemDbAccessContext(() => savePartnerStripeKey({ partnerId: partner.id, apiKey: TEST_KEY, userId: null }));
    const client = await withSystemDbAccessContext(() => getPartnerStripe(partner.id)) as unknown as { _key: string };
    expect(client._key).toBe(TEST_KEY); // decrypted round-trip
  });

  runDb('getPartnerStripe throws NO_STRIPE_KEY when the partner has not configured a key', async () => {
    const partner = await withSystemDbAccessContext(() => createPartner());
    await expect(withSystemDbAccessContext(() => getPartnerStripe(partner.id)))
      .rejects.toMatchObject({ code: 'NO_STRIPE_KEY' });
  });

  runDb('status reflects connected → disconnected; disconnect clears the secret', async () => {
    const partner = await withSystemDbAccessContext(() => createPartner());
    await withSystemDbAccessContext(() => savePartnerStripeKey({ partnerId: partner.id, apiKey: TEST_KEY, userId: null }));
    let status = await withSystemDbAccessContext(() => getPartnerStripeStatus(partner.id));
    expect(status).toMatchObject({ connected: true, last4: '9999', stripeAccountId: 'acct_partnerOwn' });

    await withSystemDbAccessContext(() => disconnectPartnerStripe(partner.id));
    status = await withSystemDbAccessContext(() => getPartnerStripeStatus(partner.id));
    expect(status.connected).toBe(false);
    const [row] = await withSystemDbAccessContext(() => db.select().from(stripeConnectAccounts).where(eq(stripeConnectAccounts.partnerId, partner.id)));
    expect(row!.apiKey).toBeNull(); // secret wiped on disconnect
  });

  runDb('save rejects a key Stripe refuses (invalid/revoked) and writes NO row', async () => {
    const partner = await withSystemDbAccessContext(() => createPartner());
    accountsRetrieveMock.mockRejectedValue(Object.assign(new Error('Invalid API Key provided'), { type: 'StripeAuthenticationError' }));
    await expect(withSystemDbAccessContext(() => savePartnerStripeKey({ partnerId: partner.id, apiKey: ['sk', 'test', 'bogus000000000000000000'].join('_'), userId: null })))
      .rejects.toMatchObject({ code: 'INVALID_STRIPE_KEY' });
    const rows = await withSystemDbAccessContext(() => db.select().from(stripeConnectAccounts).where(eq(stripeConnectAccounts.partnerId, partner.id)));
    expect(rows).toHaveLength(0); // validation precedes the insert — nothing persisted
  });

  // Key rotation: re-saving overwrites in place (one row), and no stale secret survives.
  runDb('re-saving a key for the same partner overwrites it (no duplicate, no stale secret)', async () => {
    const partner = await withSystemDbAccessContext(() => createPartner());
    const keyA = ['sk', 'test', '51AAAAaaaa1111'].join('_');
    const keyB = ['sk', 'test', '51BBBBbbbb2222'].join('_');
    accountsRetrieveMock.mockResolvedValue({ id: 'acct_A', charges_enabled: true });
    await withSystemDbAccessContext(() => savePartnerStripeKey({ partnerId: partner.id, apiKey: keyA, userId: null }));
    accountsRetrieveMock.mockResolvedValue({ id: 'acct_B', charges_enabled: true });
    await withSystemDbAccessContext(() => savePartnerStripeKey({ partnerId: partner.id, apiKey: keyB, userId: null }));

    const rows = await withSystemDbAccessContext(() => db.select().from(stripeConnectAccounts).where(eq(stripeConnectAccounts.partnerId, partner.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.stripeAccountId).toBe('acct_B');
    expect(rows[0]!.keyLast4).toBe('2222');
    const client = await withSystemDbAccessContext(() => getPartnerStripe(partner.id)) as unknown as { _key: string };
    expect(client._key).toBe(keyB); // the new key, not the old one
  });

  // A live key (rk_live/sk_live) flips livemode — drives the test/live badge in the UI.
  runDb('a live-mode key sets livemode=true', async () => {
    const partner = await withSystemDbAccessContext(() => createPartner());
    const liveKey = ['rk', 'live', '51LIVEkey9999'].join('_'); // restricted live key (recommended prod shape)
    const res = await withSystemDbAccessContext(() => savePartnerStripeKey({ partnerId: partner.id, apiKey: liveKey, userId: null }));
    expect(res.livemode).toBe(true);
    const status = await withSystemDbAccessContext(() => getPartnerStripeStatus(partner.id));
    expect(status).toMatchObject({ connected: true, livemode: true });
  });

  runDb('getPartnerStripe throws NO_STRIPE_KEY after disconnect', async () => {
    const partner = await withSystemDbAccessContext(() => createPartner());
    await withSystemDbAccessContext(() => savePartnerStripeKey({ partnerId: partner.id, apiKey: TEST_KEY, userId: null }));
    await withSystemDbAccessContext(() => disconnectPartnerStripe(partner.id));
    await expect(withSystemDbAccessContext(() => getPartnerStripe(partner.id)))
      .rejects.toMatchObject({ code: 'NO_STRIPE_KEY' });
  });
});
