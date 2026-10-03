import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { stripeConnectAccounts } from '../db/schema/stripePayments';
import { decryptSecret } from './secretCrypto';
import { PartnerStripeError } from './partnerStripe';
import { findLatestArchivedCredentialForAccount, getSupersededStripeCredential } from './stripeCredentialArchive';

interface StoredClient { stripe: Stripe; stripeAccountId: string; defaultCurrency: string | null }
type ArchivedSource = { archivedCredentialId: string; invoiceStripePaymentId?: string; reason?: 'payment_intent_settlement' | 'autopay_org_merge_detach' };
type CandidateSource = { candidateApiKey: string };
const API_VERSION = '2026-08-26.dahlia';
type ReconciliationSource = {
  reconciliationAccountId: string; archivedCredentialId?: string | null; invoiceStripePaymentId?: string;
  reason: 'payment_intent_settlement' | 'autopay_recovery' | 'autopay_outcome' | 'client_confirmation' | 'financial_event_poll';
};
export function getPartnerStripeClient(partnerId: string, source: CandidateSource): Promise<{stripe: Stripe}>;
export function getPartnerStripeClient(partnerId: string, source: ReconciliationSource): Promise<StoredClient>;
export function getPartnerStripeClient(partnerId: string, source?: ArchivedSource): Promise<StoredClient>;
export async function getPartnerStripeClient(partnerId: string,
  source?: CandidateSource | ArchivedSource | ReconciliationSource): Promise<StoredClient | {stripe: Stripe}> {
  if (source && 'candidateApiKey' in source) {
    return {stripe: new Stripe(source.candidateApiKey, {apiVersion: API_VERSION})};
  }
  const reconciliation = source && 'reconciliationAccountId' in source ? source : null;
  if (source && !reconciliation && 'archivedCredentialId' in source && source.archivedCredentialId) {
    const archived = await getSupersededStripeCredential(source.archivedCredentialId, {
      reason: source.reason ?? 'payment_intent_settlement', invoiceStripePaymentId: source.invoiceStripePaymentId,
    });
    if (archived.partnerId !== partnerId) throw new PartnerStripeError('Archived credential belongs to another partner', 'STRIPE_CONNECTION_CHANGED');
    return {stripe: archived.stripe, stripeAccountId: archived.stripeAccountId, defaultCurrency: null};
  }
  const [row] = await db.select({apiKey:stripeConnectAccounts.apiKey,status:stripeConnectAccounts.status,
    stripeAccountId:stripeConnectAccounts.stripeAccountId,defaultCurrency:stripeConnectAccounts.defaultCurrency})
    .from(stripeConnectAccounts).where(eq(stripeConnectAccounts.partnerId,partnerId)).limit(1);
  if (reconciliation && (!row?.apiKey
    || row.status !== 'connected' || row.stripeAccountId !== reconciliation.reconciliationAccountId)) {
    return archivedClient(partnerId, reconciliation);
  }
  if (!row || row.status !== 'connected' || !row.apiKey) throw new PartnerStripeError('Online payment is not available — connect Stripe first.','NO_STRIPE_KEY');
  let key: string | null;
  try { key = decryptSecret(row.apiKey); }
  catch (error) {
    console.error('[partnerStripe] failed to decrypt stored key',{partnerId,message:error instanceof Error?error.message:String(error)});
    throw new PartnerStripeError('Stored Stripe key could not be read — please reconnect Stripe.','STRIPE_KEY_UNREADABLE');
  }
  if (!key) throw new PartnerStripeError('Stored Stripe key could not be read — please reconnect Stripe.','STRIPE_KEY_UNREADABLE');
  const live = new Stripe(key, {apiVersion:API_VERSION});
  const stripe = reconciliation ? withCredentialFallback(live, () => runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => (await archivedClient(partnerId, reconciliation)).stripe))) : live;
  return {stripe,stripeAccountId:row.stripeAccountId,defaultCurrency:row.defaultCurrency};
}

async function archivedClient(partnerId: string, reconciliation: ReconciliationSource): Promise<StoredClient> {
    const credentialId = reconciliation.archivedCredentialId ??
      (await findLatestArchivedCredentialForAccount(partnerId,reconciliation.reconciliationAccountId))?.id;
    if (!credentialId) throw new PartnerStripeError('Original Stripe credential unavailable','NO_STRIPE_KEY');
    const archived = await getSupersededStripeCredential(credentialId, {
      reason:reconciliation.reason,invoiceStripePaymentId:reconciliation.invoiceStripePaymentId,
    });
    if (archived.partnerId !== partnerId || archived.stripeAccountId !== reconciliation.reconciliationAccountId) {
      throw new PartnerStripeError('Stripe account mismatch','STRIPE_CONNECTION_CHANGED');
    }
    return {stripe:archived.stripe,stripeAccountId:archived.stripeAccountId,defaultCurrency:null};
}

/** Only authentication rejection proves retrying the same operation with a same-account
 * credential is appropriate. Connection errors never cause credential failover. */
function withCredentialFallback(live: Stripe, fallback: () => Promise<Stripe>): Stripe {
  function wrap<T extends object>(resource: T, path: PropertyKey[]): T {
    return new Proxy(resource, { get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value === 'function') return async (...args: unknown[]) => {
        try { return await Reflect.apply(value, target, args); }
        catch (error) {
          const type = error && typeof error === 'object' && 'type' in error ? error.type : null;
          if (type !== 'StripeAuthenticationError') throw error;
          let archived: object = await fallback();
          for (const part of path) archived = Reflect.get(archived, part);
          return Reflect.apply(Reflect.get(archived, key), archived, args);
        }
      };
      return value && typeof value === 'object' ? wrap(value, [...path, key]) : value;
    } });
  }
  return wrap(live, []);
}
