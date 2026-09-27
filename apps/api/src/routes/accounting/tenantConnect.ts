/**
 * OAuth callback branch for providers whose grant can reach several tenants
 * (provider.tenantSelection — Xero W02). Rules:
 *  - The flow's auth event (decoded from the access token) scopes EVERYTHING;
 *    missing → fail closed. Never an unfiltered /connections diff (spec open item 4).
 *  - A reconnect keeps the partner's OWN tenant (plan refinement 2): looked up by
 *    the exact tenant id the partner's row already holds, never chosen from others.
 *  - One connectable tenant → connect; several → pending_tenant + picker; none → error.
 *  - Unchosen links from THIS auth event are released (held-checked, best-effort).
 * Runs with NO request DB context: provider calls run outside any context and
 * each write opens its own short system context (the callback has no request auth).
 */
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { AccountingProviderConflictError, upsertConnection } from '../../services/accounting/accountingConnectionService';
import { releaseUnchosenTenants } from '../../services/accounting/accountingTenantSelection';
import { getAccountingProvider } from '../../services/accounting/providerRegistry';
import type { AccountingProviderId, ConnectionTokens, ProviderTenant } from '../../services/accounting/types';
import { captureException } from '../../services/sentry';
import {
  finalizeConnection, homeCurrencyField, readPriorRealm, type ConnectOutcome, type FinalizeFailure, type RouteCtx,
} from './connectFinalize';

export type TenantCallbackError = FinalizeFailure | 'auth_event_missing' | 'no_organisation' | 'tenant_lookup_failed';

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export async function completeTenantSelectingCallback(c: RouteCtx, input: {
  provider: AccountingProviderId; tokens: ConnectionTokens; partnerId: string; userId: string | null;
}): Promise<ConnectOutcome> {
  const { provider, tokens, partnerId, userId } = input;
  const providerClient = getAccountingProvider(provider);
  const selection = providerClient.tenantSelection;
  const label = providerClient.displayName;
  const fail = (error: TenantCallbackError): ConnectOutcome => ({ kind: 'error', error });
  if (!selection) throw new Error(`${label} does not use organisation selection`); // caller dispatches on tenantSelection

  const authEventId = selection.authEventIdOf(tokens.accessToken);
  if (!authEventId) {
    // Spec open item 4: never fall back to an unfiltered /connections diff.
    console.error(`[accounting] ${label} access token carried no auth-event claim; refusing to guess the organisation`, { partnerId, provider });
    return fail('auth_event_missing');
  }
  // Releases only THIS flow's links; the held check (system scope) spares any
  // tenant an accounting_connections row already holds, whoever's it is.
  // Best-effort: a release failure never changes the connect outcome.
  const release = async (tenants: readonly ProviderTenant[], keepConnectionRef: string | null): Promise<void> => {
    try {
      await releaseUnchosenTenants({ provider, accessToken: tokens.accessToken, tenants, keepConnectionRef, context: 'callback' });
    } catch (err) {
      captureException(asError(err), c);
      console.warn(`[accounting] ${label} unchosen organisation release failed (best-effort)`, { partnerId, provider });
    }
  };

  const prior = await readPriorRealm(c, partnerId, provider);
  let grant: ProviderTenant[];
  try {
    grant = await runOutsideDbContext(() => selection.listGrantTenants(tokens.accessToken, authEventId));
  } catch (err) {
    captureException(asError(err), c);
    console.error(`[accounting] ${label} organisation lookup failed`, { partnerId, provider });
    return fail('tenant_lookup_failed');
  }

  // Fail CLOSED on an unreadable prior row (review I1). Unlike QuickBooks, where
  // the provider dictates the realm, here Breeze picks the tenant: without the
  // prior realm we can neither find the partner's own tenant (refinement 2) nor
  // detect a realm change, so a one-org grant could silently switch organisation
  // and keep the old organisation's mappings and CDC cursor.
  if (!prior.known) {
    console.error(`[accounting] ${label} prior connection unreadable; refusing to choose an organisation`, { partnerId, provider });
    await release(grant, null);
    return fail('tenant_lookup_failed');
  }

  // Reconnect (plan refinement 2): the partner's own tenant keeps the link it was
  // first authorised under, so it is absent from this auth event's list. Look up
  // THAT tenant id only — the unfiltered list never supplies any other tenant.
  let own: ProviderTenant | null = null;
  if (prior.realmId) {
    try {
      const all = await runOutsideDbContext(() => selection.listAllTenants(tokens.accessToken));
      own = all.find((t) => t.tenantId === prior.realmId && t.tenantType === selection.connectableTenantType) ?? null;
    } catch (err) {
      captureException(asError(err), c);
      console.error(`[accounting] ${label} organisation lookup failed`, { partnerId, provider });
      await release(grant, null);
      return fail('tenant_lookup_failed');
    }
  }

  const connectable = grant.filter((t) => t.tenantType === selection.connectableTenantType);
  const chosen = own ?? (connectable.length === 1 ? connectable[0]! : null);
  const tokenFields = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
    environment: providerClient.connectEnvironment(),
    lastError: null,
    connectedBy: userId,
  };

  if (chosen) {
    const result = await finalizeConnection(c, {
      provider, partnerId, realmId: chosen.tenantId, prior,
      persist: () => withSystemDbAccessContext(() => upsertConnection(db, partnerId, provider, {
        ...tokenFields,
        realmId: chosen.tenantId,
        providerConnectionRef: chosen.connectionRef,
        homeCurrency: homeCurrencyField(prior, chosen.tenantId),
        status: 'connected',
      })),
    });
    // keep=null on failure: the held check is what spares another partner's tenant.
    await release(grant, result.ok ? chosen.connectionRef : null);
    return result.ok ? { kind: 'connected' } : fail(result.error);
  }

  if (connectable.length === 0) {
    await release(grant, null);
    return fail('no_organisation');
  }

  // Several organisations: park the grant. realmId is deliberately OMITTED so a
  // reconnect keeps the old tenant id for the picker's realm-change detection.
  try {
    await withSystemDbAccessContext(() => upsertConnection(db, partnerId, provider, {
      ...tokenFields,
      providerConnectionRef: null,
      status: 'pending_tenant',
    }));
  } catch (err) {
    await release(grant, null);
    if (err instanceof AccountingProviderConflictError) return fail('provider_conflict');
    captureException(asError(err), c);
    console.error(`[accounting] ${label} pending connection persist failed`, { partnerId, provider });
    return fail('persist_failed');
  }
  return { kind: 'select_tenant' };
}
