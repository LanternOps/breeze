import './setup';
import { describe, it, expect } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, stripeConnectAccounts } from '../../db/schema';

const RUN = !!process.env.DATABASE_URL;

/**
 * Multi-currency wave 5 (#3777): connected-account currency and country cache.
 */
describe.runIf(RUN)('Stripe account-currency cache columns', () => {
  it('round-trips cached connected-account facts', async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    const refreshedAt = new Date();

    const read = await withSystemDbAccessContext(async () => {
      const [partner] = await db.insert(partners).values({
        name: `Stripe Cache ${suffix}`,
        slug: `stripe-cache-${suffix}`,
        type: 'msp',
        plan: 'pro',
        status: 'active',
        currencyCode: 'USD'
      }).returning({ id: partners.id });

      const [account] = await db.insert(stripeConnectAccounts).values({
        partnerId: partner!.id,
        stripeAccountId: `acct_cache_${suffix}`,
        // CHECK stripe_connect_connected_requires_key: 'connected' needs api_key + key_last4
        apiKey: 'enc:test-key',
        keyLast4: '4242',
        status: 'connected',
        defaultCurrency: 'EUR',
        accountCountry: 'DE',
        accountRefreshedAt: refreshedAt
      }).returning({ id: stripeConnectAccounts.id });

      const [row] = await db.select({
        defaultCurrency: stripeConnectAccounts.defaultCurrency,
        accountCountry: stripeConnectAccounts.accountCountry,
        accountRefreshedAt: stripeConnectAccounts.accountRefreshedAt
      }).from(stripeConnectAccounts).where(eq(stripeConnectAccounts.id, account!.id));
      return row;
    });

    expect(read?.defaultCurrency).toBe('EUR');
    expect(read?.accountCountry).toBe('DE');
    expect(read?.accountRefreshedAt).toEqual(refreshedAt);
  });

  it('lists all three nullable cache columns in information_schema', async () => {
    const rows = await withSystemDbAccessContext(() =>
      db.execute(sql`
        SELECT column_name, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = 'stripe_connect_accounts'
          AND column_name IN ('default_currency', 'account_country', 'account_refreshed_at')
        ORDER BY column_name
      `)
    ) as unknown as { column_name: string; is_nullable: string; column_default: string | null }[];

    expect(rows.map((row) => row.column_name)).toEqual([
      'account_country',
      'account_refreshed_at',
      'default_currency'
    ]);
    for (const row of rows) {
      expect(row.is_nullable).toBe('YES');
      expect(row.column_default).toBeNull();
    }
  });
});
