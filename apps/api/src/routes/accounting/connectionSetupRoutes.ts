/**
 * Connection-setup routes (Xero W02): the organisation picker, cancel, and the
 * settings pickers. Split out of index.ts (which must not grow).
 *
 * Every route here makes a live provider call (or, for cancel, a best-effort
 * provider cleanup), so each is registered in SELF_MANAGED_DB_CONTEXT_ROUTES
 * and hands the services a runInDbContext runner: no DB context is held across
 * a provider round trip. The held check that spares another partner's links
 * runs in SYSTEM scope inside releaseUnchosenTenants.
 */
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { db } from '../../db';
import { withAuthDbAccessContext, type AuthContext } from '../../middleware/auth';
import { ACCOUNTING_PROVIDER_IDS, type AccountingProviderId } from '../../services/accounting/types';
import { AccountingTenantHeldError } from '../../services/accounting/accountingConnectionService';
import {
  AccountingTenantSelectionError, connectableTenants, discardPendingTenantSelection, loadPendingGrant,
  releaseUnchosenTenants, TENANT_PICK_TOKEN_MARGIN_MS,
} from '../../services/accounting/accountingTenantSelection';
import { claimPendingTenant } from '../../services/accounting/accountingTenantSelectionStore';
import { listProviderSettingsOptions } from '../../services/accounting/accountingSettingsOptions';
import { AccountingMappingError } from '../../services/accounting/accountingMappingService';
import { isAccountingProviderError, rateLimitRetryAfterMs } from '../../services/accounting/accountingProviderError';
import { accountingProviderDisplayName } from '../../services/accounting/providerRegistry';
import type { DbContextRunner } from '../../services/accounting/dbContextGuard';
import { writeRouteAudit } from '../../services/auditEvents';
import { auditOwedDeletesDiscarded } from './owedDeletesAudit';
import { captureException } from '../../services/sentry';
import { providerGateResponse } from './providerGate';
import { finalizeConnection, type PriorRealm } from './connectFinalize';
import { handleMappingError } from './routeErrors';

export interface ConnectionSetupDeps {
  /** [authMiddleware, partnerScopes, requireAccountingPartnerAuthority, requireAccountingManage] */
  auth: MiddlewareHandler[];
  /** requireMfa() — on the two writes (select, cancel). */
  mfa: MiddlewareHandler;
  resolvePartnerId: (auth: AuthContext, requested?: string) => { partnerId: string } | { error: string; status: 400 | 403 };
}

const paramSchema = z.object({ provider: z.enum(ACCOUNTING_PROVIDER_IDS) });
const querySchema = z.object({ partnerId: z.string().guid().optional() });
const selectSchema = z.object({ tenantId: z.string().min(1).max(100) });

/**
 * The guard chain as ONE middleware: Hono's overloads cannot take a spread
 * array, and a longer positional chain hits its variadic-inference limit (the
 * same reason index.ts composes `partnerScopedPermission`). A denying guard's
 * Response is propagated; the chain only reaches the handler through `next`.
 */
function chain(handlers: readonly MiddlewareHandler[]): MiddlewareHandler {
  return async (c, next) => {
    const run = (i: number): Promise<Response | void> => {
      const handler = handlers[i];
      if (!handler) return next();
      return Promise.resolve(handler(c, () => run(i + 1) as Promise<void>));
    };
    return run(0);
  };
}

/**
 * Selection errors carry their own status; a provider throttle (raw, or typed
 * by the options service) goes through the SHARED mapper (429 + Retry-After,
 * ruling F7); any other provider failure is a 502 that leaks no upstream text.
 */
function setupErrorResponse(
  c: Context, provider: AccountingProviderId, err: unknown,
  /** When set, an error no mapper recognises answers this typed 500 (reported) instead of the global 500. */
  unmapped?: { error: string; code: string },
): Response {
  if (err instanceof AccountingTenantSelectionError) return c.json({ error: err.message, code: err.code }, err.status);
  if (isAccountingProviderError(err) && rateLimitRetryAfterMs(err) === null) {
    captureException(err, c);
    return c.json({ error: `${accountingProviderDisplayName(provider)} returned an error; try again shortly`, code: 'provider_error' }, 502);
  }
  if (unmapped && !isAccountingProviderError(err) && !(err instanceof AccountingMappingError)) {
    captureException(err instanceof Error ? err : new Error(String(err)), c);
    return c.json(unmapped, 500);
  }
  return handleMappingError(c, err);
}

export function registerConnectionSetupRoutes(router: Hono, deps: ConnectionSetupDeps): void {
  const guard = chain(deps.auth);

  /** Provider gate, partner binding and the request's DB runner — or the response that refuses. */
  const setup = (c: Context, provider: AccountingProviderId, gateOptions?: { requireConfigured: false }) => {
    const gate = gateOptions
      ? providerGateResponse(c, provider, 'connect', gateOptions)
      : providerGateResponse(c, provider, 'connect');
    if (gate) return { refused: gate } as const;
    const auth = c.get('auth') as AuthContext;
    const partner = deps.resolvePartnerId(auth, c.req.query('partnerId'));
    if ('error' in partner) return { refused: c.json({ error: partner.error }, partner.status) } as const;
    const runInDb: DbContextRunner = (fn) => withAuthDbAccessContext(auth, fn);
    return { partnerId: partner.partnerId, runInDb } as const;
  };

  // The organisations THIS sign-in authorised, for the picker.
  router.get('/:provider/tenants', guard, zValidator('param', paramSchema), zValidator('query', querySchema), async (c) => {
    const { provider } = c.req.valid('param');
    const s = setup(c, provider);
    if ('refused' in s) return s.refused;
    try {
      const grant = await loadPendingGrant(s.partnerId, provider, s.runInDb);
      const tokenExpiresAt = grant.row.accessTokenExpiresAt?.getTime() ?? 0;
      return c.json({
        data: connectableTenants(grant).map((t) => ({ tenantId: t.tenantId, name: t.name })),
        // The pick must land inside the ORIGINAL token's life (pending rows are never
        // refreshed); loadPendingGrant refuses inside the last TENANT_PICK_TOKEN_MARGIN_MS.
        expiresAt: new Date(tokenExpiresAt - TENANT_PICK_TOKEN_MARGIN_MS).toISOString(),
      });
    } catch (err) {
      return setupErrorResponse(c, provider, err);
    }
  });

  router.post('/:provider/tenants/select', guard, deps.mfa, zValidator('param', paramSchema), zValidator('query', querySchema), zValidator('json', selectSchema), async (c) => {
    const { provider } = c.req.valid('param');
    const { tenantId } = c.req.valid('json');
    const s = setup(c, provider);
    if ('refused' in s) return s.refused;
    try {
      const grant = await loadPendingGrant(s.partnerId, provider, s.runInDb);
      const chosen = connectableTenants(grant).find((t) => t.tenantId === tenantId);
      if (!chosen) {
        return c.json({ error: 'That organisation was not authorised in this sign-in', code: 'tenant_not_in_grant' }, 400);
      }
      // The pending row keeps the tenant it last held (a reconnect), so a pick of a
      // DIFFERENT organisation gets the realm-change reset in finalizeConnection.
      const prior: PriorRealm = { known: true, realmId: grant.row.realmId };
      const result = await finalizeConnection(c, {
        provider, partnerId: s.partnerId, realmId: chosen.tenantId, prior,
        persist: async () => {
          const claim = await s.runInDb(() => claimPendingTenant(db, {
            connectionId: grant.row.id,
            partnerId: s.partnerId,
            provider,
            realmId: chosen.tenantId,
            providerConnectionRef: chosen.connectionRef,
            resetRealmFacts: prior.realmId !== chosen.tenantId,
            grantFingerprint: grant.grantFingerprint,
          }));
          if (claim.kind === 'grant_superseded') {
            throw new AccountingTenantSelectionError('grant_superseded', 409, 'A newer sign-in replaced this one. Choose the organisation again.');
          }
          if (claim.kind === 'not_pending') {
            throw new AccountingTenantSelectionError('no_pending_selection', 409, 'This connection is no longer waiting for an organisation');
          }
          return claim.connection;
        },
      });
      if (!result.ok) {
        // Review Focus 1: the row stays pending_tenant, so the user can pick another
        // organisation or cancel. Nothing is released: the grant is still in play.
        if (result.error === 'tenant_held') {
          const held = new AccountingTenantHeldError(provider);
          return c.json({ error: held.message, code: held.code }, 409);
        }
        return c.json(
          { error: 'Could not connect that organisation', code: result.error },
          result.error === 'provider_conflict' ? 409 : 500,
        );
      }
      // Best-effort: the connection is live; a cleanup failure never changes that.
      try {
        await releaseUnchosenTenants({
          provider, accessToken: grant.accessToken, tenants: grant.tenants, keepConnectionRef: chosen.connectionRef, context: 'select',
        });
      } catch (err) {
        captureException(err instanceof Error ? err : new Error(String(err)), c);
        console.warn(`[accounting] ${accountingProviderDisplayName(provider)} unchosen organisation release failed (best-effort)`, {
          partnerId: s.partnerId, provider,
        });
      }
      writeRouteAudit(c, {
        orgId: null,
        action: 'accounting.connection.tenant_selected',
        resourceType: 'accounting_connection',
        resourceId: result.connection.id,
        details: { provider },
      });
      return c.json({ connected: true });
    } catch (err) {
      return setupErrorResponse(c, provider, err);
    }
  });

  // Ruling F13: no configuration requirement (like disconnect) — a pending row must
  // never be stranded because the provider's env was removed from this instance.
  router.post('/:provider/tenants/cancel', guard, deps.mfa, zValidator('param', paramSchema), zValidator('query', querySchema), async (c) => {
    const { provider } = c.req.valid('param');
    const s = setup(c, provider, { requireConfigured: false });
    if ('refused' in s) return s.refused;
    let result: Awaited<ReturnType<typeof discardPendingTenantSelection>>;
    try {
      result = await discardPendingTenantSelection({ partnerId: s.partnerId, provider, reason: 'cancel', runInDbContext: s.runInDb });
    } catch (err) {
      // Review L: a typed body like the sibling routes, never the global 500.
      return setupErrorResponse(c, provider, err, {
        error: `Could not cancel the ${accountingProviderDisplayName(provider)} connection; try again`, code: 'cancel_failed',
      });
    }
    if (!result.discarded) {
      return c.json({ error: 'There is no connection waiting for an organisation', code: 'no_pending_selection' }, 404);
    }
    // A RE-PARKED former connected row can still carry mappings (#7289): a
    // cancel is the operator's decision, so it is never blocked, but the
    // payment deletes those mappings owed are audited like a disconnect's.
    auditOwedDeletesDiscarded(c, {
      provider, connectionId: result.connectionId, reason: 'tenant_selection_cancelled', owed: result.owedPaymentDeletes,
    });
    writeRouteAudit(c, {
      orgId: null,
      action: 'accounting.connection.tenant_selection_cancelled',
      resourceType: 'accounting_connection',
      resourceId: null,
      details: { provider },
    });
    return c.json({ cancelled: true });
  });

  router.get('/:provider/settings/options', guard, zValidator('param', paramSchema), zValidator('query', querySchema), async (c) => {
    const { provider } = c.req.valid('param');
    const s = setup(c, provider);
    if ('refused' in s) return s.refused;
    try {
      return c.json({ data: await listProviderSettingsOptions({ partnerId: s.partnerId, provider }, s.runInDb) });
    } catch (err) {
      return setupErrorResponse(c, provider, err);
    }
  });
}
