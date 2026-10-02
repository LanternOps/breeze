import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { stripeConnectAccounts } from '../db/schema/stripePayments';
import { decryptSecret } from './secretCrypto';
import { PartnerStripeError } from './partnerStripe';
import { getSupersededStripeCredential } from './stripeCredentialArchive';

interface StoredClient { stripe: Stripe; stripeAccountId: string; defaultCurrency: string | null }
type ArchivedSource = { archivedCredentialId: string; invoiceStripePaymentId?: string; reason?: 'payment_intent_settlement' | 'autopay_org_merge_detach' };
type CandidateSource = { candidateApiKey: string };
const API_VERSION = '2026-08-26.dahlia';
export function getPartnerStripeClient(partnerId: string, source: CandidateSource): Promise<{ stripe: Stripe }>;
export function getPartnerStripeClient(partnerId: string, source?: ArchivedSource): Promise<StoredClient>;
export async function getPartnerStripeClient(partnerId: string, source?: CandidateSource | ArchivedSource): Promise<StoredClient | { stripe: Stripe }> {
  if (source && 'candidateApiKey' in source) {
    return { stripe: new Stripe(source.candidateApiKey, { apiVersion: API_VERSION }) };
  }
  if (source && 'archivedCredentialId' in source) {
    const archived = await getSupersededStripeCredential(source.archivedCredentialId, { reason: source.reason ?? 'payment_intent_settlement', invoiceStripePaymentId: source.invoiceStripePaymentId });
    if (archived.partnerId !== partnerId) throw new PartnerStripeError('Archived credential belongs to another partner', 'STRIPE_CONNECTION_CHANGED');
    return { stripe: archived.stripe, stripeAccountId: archived.stripeAccountId, defaultCurrency: null };
  }
  const [row] = await db.select({ apiKey: stripeConnectAccounts.apiKey, status: stripeConnectAccounts.status, stripeAccountId: stripeConnectAccounts.stripeAccountId, defaultCurrency: stripeConnectAccounts.defaultCurrency })
    .from(stripeConnectAccounts).where(eq(stripeConnectAccounts.partnerId, partnerId)).limit(1);
  if (!row || row.status !== 'connected' || !row.apiKey) throw new PartnerStripeError('Online payment is not available — connect Stripe first.', 'NO_STRIPE_KEY');
  let key: string | null;
  try { key = decryptSecret(row.apiKey); }
  catch (error) {
    console.error('[partnerStripe] failed to decrypt stored key', { partnerId, message: error instanceof Error ? error.message : String(error) });
    throw new PartnerStripeError('Stored Stripe key could not be read — please reconnect Stripe.', 'STRIPE_KEY_UNREADABLE');
  }
  if (!key) throw new PartnerStripeError('Stored Stripe key could not be read — please reconnect Stripe.', 'STRIPE_KEY_UNREADABLE');
  return { stripe: new Stripe(key, { apiVersion: API_VERSION }), stripeAccountId: row.stripeAccountId, defaultCurrency: row.defaultCurrency };
}
