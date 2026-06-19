// apps/api/src/services/stripeConnectService.ts
//
// Read/lifecycle helpers over stripe_connect_accounts. The Connect OAuth flow
// (buildOAuthUrl/consumeState/completeOAuth/deauthorize) was removed when billing
// moved to the per-partner API-key model (see partnerStripe.ts) — partners now paste
// their own Stripe key and charges run directly on their account, no platform/Connect.
// What remains here is the partner-axis read used to gate the "Send payment link" UI
// and the account-keyed lookups still consulted by the inbound webhook path.
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { stripeConnectAccounts } from '../db/schema/stripePayments';

export async function getConnection(partnerId: string) {
  const [row] = await db.select().from(stripeConnectAccounts).where(eq(stripeConnectAccounts.partnerId, partnerId)).limit(1);
  return row ?? null;
}

/**
 * Resolve a connection by its Stripe account id. Used by the UNAUTHENTICATED
 * webhook to (a) route an event to its partner and (b) enforce the livemode guard.
 * stripe_connect_accounts is a partner-axis table, so this must run in system
 * context — a bare org/partner-scope read would be silently RLS-filtered to null
 * with no error (the #1375 class).
 */
export async function getConnectionByAccount(stripeAccountId: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(stripeConnectAccounts)
      .where(eq(stripeConnectAccounts.stripeAccountId, stripeAccountId)).limit(1);
    return row ?? null;
  });
}

/** Webhook-driven disconnect (MSP revoked from their own dashboard). System context. */
export async function markDisconnectedByAccount(stripeAccountId: string): Promise<void> {
  await withSystemDbAccessContext(async () => {
    await db.update(stripeConnectAccounts)
      .set({ status: 'disconnected', disconnectedAt: new Date(), updatedAt: new Date() })
      .where(eq(stripeConnectAccounts.stripeAccountId, stripeAccountId));
  });
}
