/**
 * The provider-neutral tail of an accounting OAuth connect, shared by the
 * callback (QuickBooks, and Xero's single-organisation path) and the Xero tenant
 * picker (POST /:provider/tenants/select): persist, realm-change reset, and the
 * non-fatal home-currency / multi-currency capture. Moved out of
 * routes/accounting/index.ts's callback unchanged in behaviour (Xero W02),
 * including the W01c F7 throttle guard; see the original comments below for
 * every rule.
 *
 * Runs with NO request DB context: every write opens its own short system
 * context (the callback has no request auth), and every provider call runs
 * outside any context.
 */
import type { Context } from 'hono';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  AccountingProviderConflictError,
  AccountingTenantHeldError,
  getConnection,
  isHomeCurrencyCasAbort,
  resetConnectionForRealmChange,
  updateHomeCurrency,
  updateMultiCurrencyEnabled,
  type AccountingConnection,
} from '../../services/accounting/accountingConnectionService';
import { AccountingTenantSelectionError } from '../../services/accounting/accountingTenantSelection';
import { rateLimitRetryAfterMs, rateLimitSourceOf } from '../../services/accounting/accountingProviderError';
import { getAccountingProvider } from '../../services/accounting/providerRegistry';
import type { AccountingProviderId } from '../../services/accounting/types';
import { writeRouteAudit } from '../../services/auditEvents';
import { captureException, captureMessage } from '../../services/sentry';

/**
 * The route context. A Hono `Context` (not `Parameters<typeof writeRouteAudit>[0]`):
 * `captureException` needs the Hono type, and it also satisfies `writeRouteAudit`.
 */
export type RouteCtx = Context;
export interface PriorRealm { known: boolean; realmId: string | null }
export type FinalizeFailure = 'provider_conflict' | 'tenant_held' | 'persist_failed';
export type FinalizeResult = { ok: true; connection: AccountingConnection } | { ok: false; error: FinalizeFailure };
export type ConnectOutcome = { kind: 'connected' } | { kind: 'select_tenant' } | { kind: 'error'; error: string };

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** The browser redirect for a finished (or refused) connect. QuickBooks strings are byte-identical to pre-W02. */
export function connectRedirectPath(provider: AccountingProviderId, outcome: ConnectOutcome): string {
  const base = `/integrations?accounting=${provider}`;
  if (outcome.kind === 'connected') return `${base}&connected=1#accounting`;
  if (outcome.kind === 'select_tenant') return `${base}&select_tenant=1#accounting`;
  return `${base}&error=${outcome.error}#accounting`;
}

/**
 * Does this reconnect change realms? A DIFFERENT realm's home currency must
 * never persist, but blanking it on a SAME-realm reconnect degrades a healthy
 * connection: capture below is non-fatal and there is no retry, no refresh
 * route and no job, so a transient Preferences failure would strand the row at
 * NULL until someone completes another full OAuth round-trip that succeeds.
 * Read failure falls back to the fail-closed answer (`known: false`) rather
 * than losing the freshly-exchanged grant.
 */
export async function readPriorRealm(c: RouteCtx, partnerId: string, provider: AccountingProviderId): Promise<PriorRealm> {
  try {
    const existing = await withSystemDbAccessContext(() => getConnection(db, partnerId, provider));
    return { known: true, realmId: existing?.realmId ?? null };
  } catch (err) {
    captureException(asError(err), c);
    console.warn(`[accounting] ${getAccountingProvider(provider).displayName} pre-reconnect realm read failed; clearing home currency`, { partnerId, provider });
    return { known: false, realmId: null };
  }
}

/**
 * Explicit null on a realm CHANGE, not omission: upsertConnection's conflict
 * set strips undefined, so omitting it would carry a PREVIOUS realm's home
 * currency across a reconnect. Unknown must fail closed at push time instead
 * (multi-currency §11). On a same-realm reconnect the undefined is deliberate —
 * it leaves an already-captured currency intact.
 */
export function homeCurrencyField(prior: PriorRealm, realmId: string): null | undefined {
  return prior.known && prior.realmId !== null && prior.realmId === realmId ? undefined : null;
}

export async function finalizeConnection(c: RouteCtx, input: {
  provider: AccountingProviderId;
  partnerId: string;
  realmId: string;
  prior: PriorRealm;
  persist: () => Promise<AccountingConnection>;
}): Promise<FinalizeResult> {
  const { provider, partnerId, realmId, prior } = input;
  const providerClient = getAccountingProvider(provider);
  const label = providerClient.displayName;

  // No request auth context here, so the write would match 0 rows under
  // breeze_app RLS (silent failure). `persist` runs it in system context with
  // the partnerId taken from the verified state (or the authenticated picker).
  // Guard the persist: a failure after a successful exchange leaves a
  // live-but-unrecorded grant, so surface it rather than 500-ing on a raw page.
  let connection: AccountingConnection;
  try {
    connection = await input.persist();
  } catch (err) {
    // The picker route answers its own claim errors (409/404 JSON).
    if (err instanceof AccountingTenantSelectionError) throw err;
    // The partner connected another provider while this flow was in flight (spec D2).
    if (err instanceof AccountingProviderConflictError) return { ok: false, error: 'provider_conflict' };
    // The realm/tenant is connected to ANOTHER partner (spec W02): a user outcome, not an incident.
    if (err instanceof AccountingTenantHeldError) return { ok: false, error: 'tenant_held' };
    captureException(asError(err), c);
    console.error(`[accounting] ${label} connection persist failed`, { partnerId, provider });
    return { ok: false, error: 'persist_failed' };
  }

  // A reconnect that landed on a DIFFERENT company/organisation gets DISCONNECT
  // SEMANTICS (finding C): every `accounting_entity_mappings` row under this
  // connection still names the OLD realm's Customer/Item/Invoice/Payment ids,
  // and `cdc_cursor` is a watermark in the old realm's change stream. Left
  // alone, the next push would "update" a stranger's invoice and the next pull
  // would skip the new realm's first window as already read.
  //
  // Only fires on a POSITIVELY KNOWN change: `prior.known` false means the
  // pre-upsert read failed, and destroying a healthy connection's entire
  // mapping set on a guess is far worse than the divergence it would prevent.
  // A prior realm of null (first connect, or a pending_tenant first pick) is
  // not a change. Non-fatal for the same reason the currency capture is: the
  // grant is already live, and a reconcile job that arrives before this lands
  // is caught by the worker's own compare-and-set on the fingerprint.
  const realmChanged = prior.known && prior.realmId !== null && prior.realmId !== realmId;
  if (realmChanged) {
    try {
      const { mappingsDeleted, owedPaymentDeletes } = await withSystemDbAccessContext(
        () => resetConnectionForRealmChange(db, connection.id, partnerId),
      );
      // Same rule as the disconnect route: the reset cannot be blocked (the new
      // grant is already live), and the remote ids of the payment deletes it
      // discards are all a human has left to reconcile with. They name Payments
      // in the OLD company file, which is exactly why they cannot simply be
      // retained.
      if (owedPaymentDeletes.count > 0) {
        writeRouteAudit(c, {
          orgId: null,
          action: 'accounting.connection.owed_deletes_discarded',
          resourceType: 'accounting_connection',
          resourceId: connection.id,
          result: 'failure',
          details: {
            provider,
            reason: 'realm_changed',
            count: owedPaymentDeletes.count,
            remoteEntityIds: owedPaymentDeletes.remoteEntityIds,
          },
        });
      }
      console.warn(`[accounting] ${label} realm changed on reconnect; mappings and CDC cursor cleared`, {
        partnerId, provider, mappingsDeleted,
      });
      writeRouteAudit(c, {
        orgId: null,
        action: 'accounting.connection.realm_changed',
        resourceType: 'accounting_connection',
        resourceId: connection.id,
        details: { provider, mappingsDeleted },
      });
    } catch (err) {
      captureException(asError(err), c);
      console.error(`[accounting] ${label} realm-change cleanup failed`, { partnerId, provider });
    }
  }

  // Capture the realm's home currency (multi-currency §11). NON-FATAL by design:
  // the connection is already live and usable for customer import, and the
  // invoice-push guard fails closed on a NULL home currency, so a Preferences
  // outage must never turn a successful OAuth grant into a connect error.
  // The provider call runs with no ambient DB context; the write is a short
  // compare-and-set on the row we just persisted.
  let capturedSettings: { homeCurrency: string | null; multiCurrencyEnabled: boolean | null } | null = null;
  // The generation both realm-derived writes below stake their compare-and-set
  // on. `updateHomeCurrency` BUMPS it, so it hands back the new one for the
  // multi-currency write to chain onto; a lost CAS clears it, which skips the
  // second write rather than issuing it against a claim we know has expired.
  let generation: Date | null = connection.updatedAt;
  try {
    capturedSettings = await runOutsideDbContext(() => providerClient.fetchRealmSettings(connection));
    const { homeCurrency } = capturedSettings;
    if (homeCurrency && generation) {
      // The generation this capture belongs to: the row as we just wrote it
      // (updatedAt) AND the realm we just connected. A reconnect to another
      // realm in between — even inside the same millisecond — aborts the write.
      generation = await withSystemDbAccessContext(() => updateHomeCurrency(
        db,
        connection.id,
        partnerId,
        { updatedAt: generation as Date, realmId },
        homeCurrency,
      ));
    } else if (!homeCurrency) {
      // The realm reported nothing — an ordinary external condition. Push-time
      // fails closed on NULL, so a warning is the whole response.
      console.warn(`[accounting] ${label} home currency unavailable`, { partnerId, provider });
    } else {
      // A GOOD capture we cannot anchor: the row we just upserted came back with
      // no updatedAt, so the compare-and-set has no generation to target. That is
      // an unexpected row shape, not an external outage — report it instead of
      // discarding the value under an "unavailable" warning.
      captureException(new Error('Accounting home currency captured but the persisted connection carried no updatedAt to compare-and-set against'), c);
      console.error(`[accounting] ${label} home currency captured but the persisted row has no updatedAt`, { partnerId, provider });
    }
  } catch (err) {
    // A lost compare-and-set is an EXPECTED race (double connect, concurrent
    // reconnect), not a defect: the winning capture already wrote a currency for
    // the generation that survived. Report it as a warning so it stops filing
    // Sentry issues on a normal user action; genuine failures stay exceptions.
    if (isHomeCurrencyCasAbort(err)) {
      generation = null;
      captureMessage(`[accounting] ${label} home currency capture lost the compare-and-set`, {
        eventCode: 'accounting_home_currency_cas_lost',
      });
      console.warn(`[accounting] ${label} home currency capture lost the compare-and-set`, { partnerId, provider });
    } else {
      // A throttled capture is not an incident (F7): a provider/local throttle
      // never reaches Sentry, and a limiter-store outage is reported once,
      // centrally, by the limiter itself — capturing it here would double it.
      if (rateLimitRetryAfterMs(err) === null) captureException(asError(err), c);
      console.warn(`[accounting] ${label} home currency capture failed`, {
        partnerId, provider, throttleSource: rateLimitSourceOf(err) ?? undefined,
      });
    }
  }

  // Persist the realm's multi-currency flag, under the SAME realm+generation
  // compare-and-set as the home currency (a reconnect to a different realm
  // must not be stamped with the old realm's flag). It runs AFTER the block
  // above and chains onto the generation that write returned — both writes
  // bump updated_at, so ordering and chaining are both load-bearing.
  // A null flag is left untouched (unknown must never blank a previously
  // captured true/false), matching the home-currency "never blank" rule above.
  if (typeof capturedSettings?.multiCurrencyEnabled === 'boolean' && generation) {
    try {
      await withSystemDbAccessContext(() => updateMultiCurrencyEnabled(
        db,
        connection.id,
        partnerId,
        { updatedAt: generation as Date, realmId },
        capturedSettings!.multiCurrencyEnabled as boolean,
      ));
    } catch (err) {
      if (isHomeCurrencyCasAbort(err)) {
        console.warn(`[accounting] ${label} multi-currency flag capture lost the compare-and-set`, { partnerId, provider });
      } else {
        captureException(asError(err), c);
        console.warn(`[accounting] ${label} multi-currency flag capture failed`, { partnerId, provider });
      }
    }
  }

  return { ok: true, connection };
}
