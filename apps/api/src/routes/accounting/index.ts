import { isAutopayEnabledForPartner } from '../../services/autopay/autopayGate';
import { Hono, type Context, type Env, type MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { accountingConnections, accountingEntityMappings, invoicePayments, invoiceStripePayments, invoices } from '../../db/schema';
import {
  authMiddleware, requireMfa, requirePermission, requireScope, withAuthDbAccessContext, type AuthContext,
} from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import {
  AccountingConnectionError,
  AccountingProviderConflictError,
  deleteConnection, getConnection,
  PENDING_TENANT_STATUS,
  type AccountingConnection,
  getPartnerConnectionRef,
  refreshRealmSettings,
  upsertConnection,
  resolveActiveConnectionRef,
} from '../../services/accounting/accountingConnectionService';
import {
  importAccountingCustomers,
  listAccountingCustomersAnnotated,
} from '../../services/accounting/accountingCustomerImport';
import {
  listMappingProposals,
  listRemoteIncomeAccountsForPartner,
  resolveConnectionAndToken,
  saveMappingDecision,
  syncMappedEntity,
  type MappingDecision,
  type MappingEntityType,
} from '../../services/accounting/accountingMappingService';
import { AccountingInvoicePushError, pushInvoiceToAccounting } from '../../services/accounting/accountingInvoicePush';
import { enqueueAccountingInvoicePush, enqueueAccountingMappingSync } from '../../jobs/accountingSyncWorker';
import { enqueueAccountingReconcile } from '../../jobs/accountingReconcileWorker';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  findAccountingProvider, getAccountingProvider, LEGACY_UNTARGETED_JOB_PROVIDER, providerSupports,
} from '../../services/accounting/providerRegistry';
import { captureException } from '../../services/sentry';
import { ACCOUNTING_PROVIDER_IDS } from '../../services/accounting/types';
import { discardPendingTenantSelection } from '../../services/accounting/accountingTenantSelection';
import { auditOwedDeletesDiscarded } from './owedDeletesAudit';
import { rateLimitRetryAfterMs } from '../../services/accounting/accountingProviderError';
import { releaseProviderConnection } from '../../services/accounting/accountingProviderRelease';
import type { DbContextRunner } from '../../services/accounting/dbContextGuard';
import { listProvidersHandler, providerGateResponse } from './providerGate';
import { handleImportError, handleMappingError, setRetryAfter } from './routeErrors';
import { registerConnectionSetupRoutes } from './connectionSetupRoutes';
import { connectRedirectPath, finalizeConnection, homeCurrencyField, readPriorRealm } from './connectFinalize';
import { completeTenantSelectingCallback } from './tenantConnect';
import { constantTimeEqual, createState, STATE_TTL_MS, stateCookieValue, verifyState } from './oauthState';
import {
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
} from '../../services/partnerWideAccess';

export const accountingRoutes = new Hono();

const partnerScopes = requireScope('partner', 'system');

// Customer annotation and import both enter the shared org-import seam, which
// reads the whole partner tenant tree under system DB context. The capability
// follows that blast radius, not the accounting connection: an org-selected
// member must not infer matches or create tenants outside their selection.
const requireFullPartnerOrgImportAccess: MiddlewareHandler = async (c, next) => {
  if (!canManagePartnerWidePolicies(c.get('auth') as AuthContext)) {
    return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
  }
  return next();
};

// The IMPORT route creates organizations and their default sites, so it carries
// the same permission pair as routes/orgs.ts POST /import. The customer LIST
// route deliberately does NOT: it only reads QuickBooks and creates nothing,
// and gating it on write permissions would lock the seeded "Partner Billing"
// role — which owns the QuickBooks connection — out of a screen it has always
// been able to browse.
const requireOrgWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);
const requireSiteWrite = requirePermission(PERMISSIONS.SITES_WRITE.resource, PERMISSIONS.SITES_WRITE.action);

/**
 * `requirePermission` resolves a role from `auth.partnerId`/`auth.orgId`, and a
 * SYSTEM-scope token carries neither — `getUserPermissions` then returns null
 * and every system-scope caller 403s, even though `requireScope('partner',
 * 'system')` advertises support for them and the handler resolves the partner
 * from `?partnerId=`. System scope is already the most privileged scope and is
 * gated above, so the per-partner role check does not apply to it.
 *
 * routes/orgs.ts POST /import advertises the same system scope but still uses
 * the raw permission guards, so membership-less system callers remain a
 * separate route-contract/availability residual rather than an authz bypass.
 */
function partnerScopedPermission(...guards: MiddlewareHandler[]): MiddlewareHandler {
  return async (c, next) => {
    if (c.get('auth')?.scope === 'system') return next();
    // Run the guards in order, propagating whatever a denying guard returns
    // (its 403 Response) instead of falling through to the handler.
    const run = (i: number): Promise<Response | void> => {
      const guard = guards[i];
      if (!guard) return next();
      return Promise.resolve(guard(c, () => run(i + 1) as Promise<void>));
    };
    return run(0);
  };
}

// NOTE: the accounting:read guard is folded INTO this composition rather than
// listed separately on the route. The import route's middleware chain is
// already at Hono's variadic-inference limit — adding a 10th handler collapses
// the handler's `c.req.valid(...)` types to `never`. Composing keeps the chain
// length unchanged and the ordering identical (system scope is exempt from all
// three for the reason documented on partnerScopedPermission).
const requireImportPermissions = partnerScopedPermission(
  requirePermission(PERMISSIONS.ACCOUNTING_READ.resource, PERMISSIONS.ACCOUNTING_READ.action),
  requireOrgWrite,
  requireSiteWrite,
);

/**
 * Dedicated accounting capabilities (SEC-2026-09-05-057). Before these, every
 * interactive QuickBooks route gated on partner authority alone, so any
 * full-partner member — however low their role — could read the shared
 * provider realm and, with MFA, drive realm lifecycle and settings mutations.
 *
 * `accounting:read` covers the provider reads (status, customers, entity
 * mappings, income accounts, remote candidates); `accounting:manage` covers
 * connect/disconnect, settings update/refresh, mapping writes and provider or
 * mapping synchronization. Both are wrapped in `partnerScopedPermission` for
 * the same reason the import/invoice guards are: a system-scope token carries
 * no partner or org membership, so `requirePermission` can resolve no role for
 * it (see that helper's comment above).
 *
 * `accounting:manage` also covers BOTH invoice-push routes (PR review
 * finding): a push writes an invoice into the shared provider realm, exactly
 * like a mapping sync or a reconcile trigger, so it belongs on the same
 * capability rather than on `invoices:write` alone.
 *
 * These are ADDITIVE. Every pre-existing route requirement — MFA,
 * organizations:write + sites:write on customer import, invoices:write on
 * invoice push, catalog:write on item mappings, and the full-partner authority
 * check — stays exactly as it was.
 */
const requireAccountingRead = partnerScopedPermission(
  requirePermission(PERMISSIONS.ACCOUNTING_READ.resource, PERMISSIONS.ACCOUNTING_READ.action),
);
const requireAccountingManage = partnerScopedPermission(
  requirePermission(PERMISSIONS.ACCOUNTING_MANAGE.resource, PERMISSIONS.ACCOUNTING_MANAGE.action),
);
const providerParamSchema = z.object({ provider: z.enum(ACCOUNTING_PROVIDER_IDS) });
const partnerQuerySchema = z.object({ partnerId: z.string().guid().optional() });
const callbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  // QuickBooks sends realmId; Xero does not (its tenant is chosen after the exchange).
  realmId: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  // The provider's own OAuth error (e.g. access_denied when the user cancels consent).
  // Truncated, never refused: any value redirects consent_denied and is never reflected.
  error: z.string().transform((v) => v.slice(0, 100)).optional(),
});
const settingsSchema = z.object({
  feeIncomeItemRef: z.string().trim().min(1).max(64).nullable().optional(),
  feeIncomeAccountRef: z.string().trim().min(1).max(64).nullable().optional(),
  pushMode: z.enum(['auto', 'manual']).optional(),
  defaultIncomeAccountRef: z.string().max(64).nullable().optional(),
  defaultTaxCodeRef: z.string().max(64).nullable().optional(),
  // Phase D, Task 6 — whether the reconcile worker pulls QuickBooks payments
  // for this connection. Same tier as pushMode: a plain connection setting,
  // not a captured external fact (unlike homeCurrency/multiCurrencyEnabled
  // below, which PATCH must never accept).
  pullPayments: z.boolean().optional(),
  // Phase D2 — whether Breeze pushes its own payments INTO QuickBooks for this
  // connection. Same tier as pushMode/pullPayments: a plain connection setting,
  // not a captured external fact.
  pushPayments: z.boolean().optional(),
  // Xero W02 — defaults the push applies when a line is tax-exempt / when a
  // payment is recorded (a Xero TaxType and a bank AccountID). Plain connection
  // settings, same tier as the income-account / tax-code refs above.
  defaultExemptTaxCodeRef: z.string().max(64).nullable().optional(),
  defaultPaymentAccountRef: z.string().max(64).nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, {
  message: 'At least one setting is required',
});
const importCustomersSchema = z.object({
  customerIds: z.array(z.string().min(1)).min(1).max(500),
});

const mappingEntityQuerySchema = partnerQuerySchema.extend({
  entityType: z.enum(['org', 'catalog_item']),
});
const mappingDecisionSchema = z.object({
  breezeEntityType: z.enum(['org', 'catalog_item']),
  breezeEntityId: z.string().guid(),
  decision: z.enum(['confirmed', 'create_new', 'unlinked']),
  remoteEntityId: z.string().min(1).max(255).optional(),
}).superRefine((value, ctx) => {
  if (value.decision === 'confirmed' && !value.remoteEntityId) {
    ctx.addIssue({ code: 'custom', path: ['remoteEntityId'], message: 'remoteEntityId is required when confirming a match' });
  }
  if (value.decision !== 'confirmed' && value.remoteEntityId) {
    ctx.addIssue({ code: 'custom', path: ['remoteEntityId'], message: 'remoteEntityId is only valid for confirmed matches' });
  }
});
const mappingSyncSchema = z.object({
  breezeEntityType: z.enum(['org', 'catalog_item']),
  breezeEntityId: z.string().guid(),
});

// Phase C, Task 5 — invoice push routes.
const invoicePushParamSchema = z.object({ provider: z.enum(ACCOUNTING_PROVIDER_IDS), invoiceId: z.string().guid() });
const invoicePushBulkSchema = z.object({
  invoiceIds: z.array(z.string().guid()).min(1).max(100),
});
const remoteCandidatesQuerySchema = partnerQuerySchema.extend({
  entityType: z.enum(['org', 'catalog_item']),
  q: z.string().max(255).optional(),
});

/**
 * Deliberately a DIFFERENT body shape from `handleMappingError` (./routeErrors)
 * (`{ error: code, message }`, not `{ error: message, code }`) — the invoice
 * push coordinator's error taxonomy (Phase C, Task 3) is a separate typed
 * class from the mapping workbench's, and this shape is what Task 5's spec
 * calls for.
 */
function handleInvoicePushError(c: Context, err: unknown): Response {
  // AccountingInvoicePushError.status is a narrowed literal union (404|409|429|502), so no cast.
  if (err instanceof AccountingInvoicePushError) {
    setRetryAfter(c, err);
    return c.json({ error: err.code, message: err.message }, err.status);
  }
  throw err;
}

function handleConnectionError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof AccountingConnectionError) return c.json({ error: err.message, code: err.code }, err.status);
  throw err;
}

/**
 * Curated response for a mapping row — mirrors PATCH /:provider/settings
 * above, which explicitly `.returning({ ... })`s a safe subset rather than
 * echoing the raw row. `saveMappingDecision`/`syncMappedEntity` return the
 * full `accounting_entity_mappings` row (internal `id`, `integrationId`,
 * `partnerId`, `remoteSyncToken`, `createdAt`, `updatedAt` included), so the
 * route — not the service — is responsible for narrowing it before it goes
 * over the wire. None of those omitted fields are secrets, but they are
 * internal plumbing (tenancy/connection ids, QuickBooks' own optimistic-
 * concurrency token) the client has no use for.
 */
function toMappingResponse(mapping: {
  breezeEntityType: string;
  breezeEntityId: string;
  remoteEntityType: string;
  remoteEntityId: string | null;
  linkStatus: string;
  syncStatus: string;
  lastSyncedAt: Date | null;
  lastError: string | null;
  confidence: string;
  proposedRemoteName: string | null;
}) {
  return {
    breezeEntityType: mapping.breezeEntityType,
    breezeEntityId: mapping.breezeEntityId,
    remoteEntityType: mapping.remoteEntityType,
    remoteEntityId: mapping.remoteEntityId,
    linkStatus: mapping.linkStatus,
    syncStatus: mapping.syncStatus,
    lastSyncedAt: mapping.lastSyncedAt,
    lastError: mapping.lastError,
    confidence: mapping.confidence,
    proposedRemoteName: mapping.proposedRemoteName,
  };
}

// Post-`zValidator('json', ...)` entity-aware write guard for the two mapping
// mutation routes: ORGS_WRITE for an org decision, CATALOG_WRITE for a
// catalog_item decision. System scope bypasses the role lookup, matching
// `partnerScopedPermission` above (requirePermission resolves a role from
// auth.partnerId/orgId, which a system-scope token never carries).
const requireCustomerMappingWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);
const requireItemMappingWrite = requirePermission(PERMISSIONS.CATALOG_WRITE.resource, PERMISSIONS.CATALOG_WRITE.action);

// Phase C, Task 5 — the manual/bulk invoice push routes below gate on
// INVOICES_WRITE directly (not an entity-aware split like the two mapping
// mutation routes above: an invoice push is always an invoice-shaped write).
// Wrapped in `partnerScopedPermission` for the same system-scope bypass as
// `requireImportPermissions` above — see that constant's comment.
const requireInvoicePush = partnerScopedPermission(
  requirePermission(PERMISSIONS.INVOICES_WRITE.resource, PERMISSIONS.INVOICES_WRITE.action),
);

/**
 * Finding D. `PATCH /:provider/settings` was gated on partner scope + MFA only,
 * so any partner admin without `invoices:write` could switch the payment
 * pull-back off — silently stopping every QuickBooks payment from reaching
 * Breeze — or flip `pushMode` to `manual` and stop invoices going out, or flip
 * `pushPayments` off and silently stop every Breeze payment from reaching the
 * books. All three are the same authority the manual/bulk push routes
 * require, so the settings handler now demands it too WHEN THE BODY CARRIES
 * ONE OF THOSE FIELDS.
 *
 * The account-ref settings stay ungated: they are plumbing for a push someone
 * else performs, not a switch over whether money syncs at all.
 */
type SettingsWriteJsonInput = { pushMode?: 'auto' | 'manual'; pullPayments?: boolean; pushPayments?: boolean };
const requireInvoicePushForSyncSwitches: MiddlewareHandler<
  Env,
  string,
  { in: { json: SettingsWriteJsonInput }; out: { json: SettingsWriteJsonInput } }
> = async (c, next) => {
  const body = c.req.valid('json');
  if (!('pushMode' in body) && !('pullPayments' in body) && !('pushPayments' in body)) return next();
  return requireInvoicePush(c, next);
};

// Typed against the validated `json` env — matching `optionalJsonValidator`'s
// idiom (lib/validation.ts) for a standalone middleware that reads
// `c.req.valid('json')` — rather than a bare `MiddlewareHandler` (which
// erases the `zValidator('json', ...)` typing upstream and makes
// `c.req.valid('json')` resolve to `never`). Shared by both mutation routes
// (`mappingDecisionSchema` and `mappingSyncSchema`), so it is typed against
// only the field both schemas' outputs share.
type MappingWriteJsonInput = { breezeEntityType: MappingEntityType };
const requireMappingWrite: MiddlewareHandler<
  Env,
  string,
  { in: { json: MappingWriteJsonInput }; out: { json: MappingWriteJsonInput } }
> = async (c, next) => {
  if (c.get('auth')?.scope === 'system') return next();
  const body = c.req.valid('json');
  const guard = body.breezeEntityType === 'org' ? requireCustomerMappingWrite : requireItemMappingWrite;
  return guard(c, next);
};

// CSRF binding cookie: the OAuth callback must complete in the SAME browser
// that initiated /connect. Without it, an attacker who captures a victim into
// their own connect flow could link the victim's QuickBooks realm into the
// attacker's partner (or vice-versa). Mirrors the SSO callback's state-cookie
// defense (routes/sso.ts). The callback is intentionally NOT behind
// authMiddleware — a browser redirect from Intuit carries no Bearer token —
// so the signed `state` + this cookie are the authentication.
const ACCOUNTING_STATE_COOKIE = 'breeze_accounting_oauth_state';
// Signing, TTL and verification live in ./oauthState.

function resolvePartnerId(auth: Pick<AuthContext, 'scope' | 'partnerId'>, requested?: string): { partnerId: string } | { error: string; status: 400 | 403 } {
  if (auth.scope === 'partner') {
    if (!auth.partnerId) return { error: 'Partner context required', status: 403 };
    if (requested && requested !== auth.partnerId) return { error: 'Access to this partner denied', status: 403 };
    return { partnerId: auth.partnerId };
  }
  if (auth.scope !== 'system') {
    return { error: 'Accounting integrations are managed at partner scope', status: 403 };
  }
  if (!requested) return { error: 'partnerId is required for system scope', status: 400 };
  return { partnerId: requested };
}

/**
 * Every interactive accounting route operates on one partner-global provider
 * realm. Prove both the exact partner binding and raw all-organization partner
 * authority before validation, configuration checks, database/provider work,
 * queueing, or audit. System automation keeps its explicit-partner behavior;
 * signed provider callbacks and background workers use separate trust paths.
 */
const requireAccountingPartnerAuthority: MiddlewareHandler = async (c, next) => {
  const auth = c.get('auth') as AuthContext | undefined;
  if (!auth) return c.json({ error: 'Not authenticated' }, 401);

  const partner = resolvePartnerId(auth, c.req.query('partnerId'));
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  if (!canManagePartnerWidePolicies(auth)) {
    return c.json({ error: 'Full partner organization access is required' }, 403);
  }
  return next();
};

// Initiate the OAuth flow. Authenticated + MFA-gated: this is the privileged
// action that decides which partner an external accounting realm links to.
accountingRoutes.get('/:provider/connect', authMiddleware, partnerScopes, requireAccountingPartnerAuthority, requireAccountingManage, requireMfa(), zValidator('param', providerParamSchema), zValidator('query', partnerQuerySchema), async (c) => {
  const { provider } = c.req.valid('param');
  const gate = providerGateResponse(c, provider, 'connect');
  if (gate) return gate;
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, c.req.valid('query').partnerId);
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  // One connection per partner (spec D2): refuse a cross-provider connect before OAuth
  // starts. Non-decrypting, any-status read: a pending_tenant row still holds the slot (W02).
  const existing = await getPartnerConnectionRef(db, partner.partnerId);
  if (existing && existing.provider !== provider) {
    const conflict = new AccountingProviderConflictError(existing.provider, provider, existing.status);
    return c.json({ error: conflict.message, code: conflict.code }, 409);
  }

  const state = createState(partner.partnerId, auth.user?.id ?? null, provider);
  const cookieValue = state ? stateCookieValue(state) : null;
  if (!state || !cookieValue) return c.json({ error: 'OAuth state signing secret is not configured' }, 500);

  setCookie(c, ACCOUNTING_STATE_COOKIE, cookieValue, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax', // sent on the top-level redirect back from Intuit
    path: '/',
    maxAge: STATE_TTL_MS / 1000,
  });

  const authUrl = getAccountingProvider(provider).buildAuthUrl(state);
  return c.json({ authUrl });
});

// OAuth redirect target. NO authMiddleware — Intuit redirects the browser here
// with no Bearer token. Authentication is the signed `state` + binding cookie.
accountingRoutes.get('/:provider/callback', zValidator('param', providerParamSchema), zValidator('query', callbackQuerySchema), async (c) => {
  const { provider } = c.req.valid('param');
  const query = c.req.valid('query');
  const gate = providerGateResponse(c, provider, 'connect');
  if (gate) return gate;

  // The signed state + binding cookie authenticate the callback; null = not this browser's flow.
  const bindingValid = (stateParam: string): boolean => {
    const expectedCookie = stateCookieValue(stateParam);
    const presentedCookie = getCookie(c, ACCOUNTING_STATE_COOKIE);
    return Boolean(expectedCookie && presentedCookie && constantTimeEqual(presentedCookie, expectedCookie));
  };

  if (query.error) {
    // Consent cancelled or refused at the provider: no grant exists, nothing to
    // exchange or clean up. Only this browser's own verified flow FOR THIS
    // provider clears the binding cookie, so a crafted link cannot cancel an
    // in-flight connect.
    const denied = query.state ? verifyState(query.state) : null;
    if (denied && (denied.provider ?? LEGACY_UNTARGETED_JOB_PROVIDER) === provider && bindingValid(query.state!)) {
      deleteCookie(c, ACCOUNTING_STATE_COOKIE, { path: '/' });
    }
    return c.redirect(connectRedirectPath(provider, { kind: 'error', error: 'consent_denied' }));
  }
  if (!query.code || !query.state) return c.json({ error: 'Missing code or state' }, 400);
  const code = query.code;

  const state = verifyState(query.state);
  if (!state) return c.json({ error: 'Invalid or expired OAuth state' }, 400);
  // Pre-W01 states carry no provider; they were QuickBooks flows (10-minute TTL spans at most one deploy).
  if ((state.provider ?? LEGACY_UNTARGETED_JOB_PROVIDER) !== provider) {
    return c.json({ error: 'OAuth state was issued for a different provider' }, 400);
  }
  if (!bindingValid(query.state)) return c.json({ error: 'OAuth state binding mismatch' }, 400);

  const providerClient = getAccountingProvider(provider);
  // A provider without tenant selection names its realm in the callback (QuickBooks).
  if (!providerClient.tenantSelection && !query.realmId) return c.json({ error: 'Missing realmId' }, 400);

  let tokens;
  try {
    tokens = await runOutsideDbContext(() => providerClient.exchangeCode(code, query.realmId ?? ''));
  } catch (err) {
    // Never log query.code / realmId / token bodies — only partner + provider.
    // A provider/local throttle is not an incident (matches connectFinalize's
    // F7 guard) — warn only; anything else still goes to Sentry.
    if (rateLimitRetryAfterMs(err) === null) {
      captureException(err instanceof Error ? err : new Error(String(err)), c);
      console.error(`[accounting] ${providerClient.displayName} code exchange failed`, { partnerId: state.partnerId, provider });
    } else {
      console.warn(`[accounting] ${providerClient.displayName} code exchange throttled`, { partnerId: state.partnerId, provider });
    }
    deleteCookie(c, ACCOUNTING_STATE_COOKIE, { path: '/' });
    return c.redirect(connectRedirectPath(provider, { kind: 'error', error: 'exchange_failed' }));
  }

  if (providerClient.tenantSelection) {
    const outcome = await completeTenantSelectingCallback(c, { provider, tokens, partnerId: state.partnerId, userId: state.userId });
    deleteCookie(c, ACCOUNTING_STATE_COOKIE, { path: '/' });
    return c.redirect(connectRedirectPath(provider, outcome));
  }

  // Persist, realm-change reset and settings capture: connectFinalize.ts (moved, Xero W02).
  const realmId = tokens.realmId;
  const prior = await readPriorRealm(c, state.partnerId, provider);
  const result = await finalizeConnection(c, {
    provider, partnerId: state.partnerId, realmId, prior,
    persist: () => withSystemDbAccessContext(() => upsertConnection(db, state.partnerId, provider, {
      realmId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      environment: providerClient.connectEnvironment(),
      homeCurrency: homeCurrencyField(prior, realmId),
      status: 'connected',
      lastError: null,
      connectedBy: state.userId,
    })),
  });
  deleteCookie(c, ACCOUNTING_STATE_COOKIE, { path: '/' });
  return c.redirect(connectRedirectPath(provider, result.ok ? { kind: 'connected' } : { kind: 'error', error: result.error }));
});

accountingRoutes.post('/:provider/disconnect', authMiddleware, partnerScopes, requireAccountingPartnerAuthority, requireAccountingManage, requireMfa(), zValidator('param', providerParamSchema), zValidator('query', partnerQuerySchema), async (c) => {
  const { provider } = c.req.valid('param');
  const gate = providerGateResponse(c, provider, 'connect', { requireConfigured: false });
  if (gate) return gate;
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, c.req.valid('query').partnerId);
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  // Self-managed (SELF_MANAGED_DB_CONTEXT_ROUTES): the provider-side release is
  // an outbound call, so every DB step is its own short context, none held across it.
  const runInDb: DbContextRunner = (fn) => withAuthDbAccessContext(auth, fn);
  const ref = await runInDb(() => getPartnerConnectionRef(db, partner.partnerId));
  if (!ref || ref.provider !== provider) return c.json({ error: 'Accounting connection not found' }, 404);
  // `status` is the latest pre-delete read (the decrypting re-read when one ran,
  // otherwise the first read) (review I), not the first read's.
  const audit = (resourceId: string, status: string, details: Record<string, unknown>) => writeRouteAudit(c, {
    orgId: null, action: 'accounting.connection.disconnected', resourceType: 'accounting_connection', resourceId,
    details: { provider, status, ...details },
  });
  // A row waiting for an organisation is a cancel: no chosen link to release,
  // and this flow's links go through the held-checked cleanup. False = it was
  // claimed (or removed) in the meantime.
  // A RE-PARKED former connected row can still carry mappings (#7289): the
  // payment deletes they owed are discarded with it and audited like any
  // disconnect's.
  const discardPending = async () => {
    const result = await discardPendingTenantSelection({
      partnerId: partner.partnerId, provider, reason: 'cancel', runInDbContext: runInDb,
    });
    if (!result.discarded) return false;
    auditOwedDeletesDiscarded(c, { provider, connectionId: result.connectionId, reason: 'disconnect', owed: result.owedPaymentDeletes });
    return true;
  };
  if (ref.status === PENDING_TENANT_STATUS && await discardPending()) {
    audit(ref.id, PENDING_TENANT_STATUS, {});
    return c.json({ disconnected: true });
  }
  // Best-effort provider-side release BEFORE the row and its tokens are gone
  // (spec W02 "Disconnect"; never token revocation). Only a provider with a
  // release hook needs the decrypting read (review K). A row whose tokens
  // cannot be decrypted skips the release but still disconnects.
  let full: AccountingConnection | null = null;
  if (findAccountingProvider(provider)?.releaseConnection) {
    try {
      full = await runInDb(() => getConnection(db, partner.partnerId, provider));
    } catch (err) {
      captureException(err instanceof Error ? err : new Error(String(err)), c, { service: 'accounting' });
      console.warn('[accounting] disconnect could not read the connection; skipping the provider-side release', {
        partnerId: partner.partnerId, provider, error: err instanceof Error ? err.message : String(err),
      });
    }
    // A concurrent reconnect re-parked the row (review H): its new grant's links
    // need the held-checked cleanup, and a pending row is never refreshed. If
    // it was claimed yet again, disconnect it without a release (best-effort).
    if (full?.status === PENDING_TENANT_STATUS) {
      if (await discardPending()) {
        audit(full.id, PENDING_TENANT_STATUS, {});
        return c.json({ disconnected: true });
      }
      full = null;
    }
  }
  const providerRelease = full ? await releaseProviderConnection(full) : 'skipped';
  const { removed, connectionId, owedPaymentDeletes } = await runInDb(() => deleteConnection(db, partner.partnerId, provider));
  if (!removed) return c.json({ error: 'Accounting connection not found' }, 404);
  audit(connectionId ?? ref.id, full?.status ?? ref.status, { providerRelease });
  // The disconnect is never blocked, but a QuickBooks payment deletion Breeze
  // still owed dies with the mapping (ON DELETE CASCADE). Record the remote ids
  // — the only thing that lets a human find those Payments afterwards (review
  // wave 2, finding 3). The service already warned and raised Sentry.
  // `connectionId` is non-null whenever `removed` is true (the 404 above).
  auditOwedDeletesDiscarded(c, {
    provider, connectionId: connectionId ?? partner.partnerId, reason: 'disconnect', owed: owedPaymentDeletes,
  });
  return c.json({ disconnected: true });
});

// Organisation picker, cancel and settings pickers (Xero W02): connect chain, manage-gated.
registerConnectionSetupRoutes(accountingRoutes, {
  auth: [authMiddleware, partnerScopes, requireAccountingPartnerAuthority, requireAccountingManage],
  mfa: requireMfa(),
  resolvePartnerId,
});

// Registered BEFORE GET /:provider, which would otherwise capture it (and the enum 400 it).
accountingRoutes.get('/providers', authMiddleware, partnerScopes, requireAccountingPartnerAuthority, requireAccountingRead, zValidator('query', partnerQuerySchema), async (c) => {
  const partner = resolvePartnerId(c.get('auth'), c.req.valid('query').partnerId);
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  return listProvidersHandler(c, partner.partnerId);
});

accountingRoutes.get('/:provider', authMiddleware, partnerScopes, requireAccountingPartnerAuthority, requireAccountingRead, zValidator('param', providerParamSchema), zValidator('query', partnerQuerySchema), async (c) => {
  const { provider } = c.req.valid('param');
  const gate = providerGateResponse(c, provider, 'connect', { requireConfigured: false });
  if (gate) return gate;
  const partner = resolvePartnerId(c.get('auth'), c.req.valid('query').partnerId);
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const autopayEnabled = await isAutopayEnabledForPartner(db, partner.partnerId);
  const feeErrors = await db.select({ n: sql<number>`count(*)::int` }).from(invoiceStripePayments)
    .innerJoin(invoices, eq(invoices.id, invoiceStripePayments.invoiceId))
    .where(and(eq(invoices.partnerId, partner.partnerId), sql`${invoiceStripePayments.feeAccountingError} IS NOT NULL`));
  const connection = await getConnection(db, partner.partnerId, provider);
  // What the provider can do and which setup steps it has (Xero W02). DB-only:
  // the organisation name / demo badge come from GET /:provider/settings/options.
  const impl = getAccountingProvider(provider);
  const providerShape = {
    capabilities: impl.capabilities,
    features: { tenantSelection: !!impl.tenantSelection, settingsOptions: typeof impl.listSettingsOptions === 'function' },
  };
  if (!connection) {
    return c.json({
      ...providerShape,
      autopayEnabled,
      feeAccountingErrorCount: feeErrors[0]?.n ?? 0,
      status: 'disconnected',
      environment: null,
      pushMode: 'auto',
      connectedAt: null,
      lastError: null,
      homeCurrency: null,
      multiCurrencyEnabled: null,
      // Same shape either way (Phase D, Task 6) — the "Sync now" card reads
      // these fields whether or not a connection exists yet. `true` matches
      // the column's own `.default(true)` (accountingConnectionService.ts).
      pullPayments: true,
      lastReconcileAt: null,
      // Phase D2 — same story as pullPayments: `true` matches the
      // push_payments column's own `.default(true)`.
      pushPayments: true,
    });
  }
  return c.json({
    ...providerShape,
    autopayEnabled,
    feeAccountingErrorCount: feeErrors[0]?.n ?? 0,
    status: connection.status,
    environment: connection.environment,
    pushMode: connection.pushMode,
    connectedAt: connection.createdAt,
    lastError: connection.lastError,
    feeIncomeItemRef: connection.feeIncomeItemRef ?? null,
    feeIncomeAccountRef: connection.feeIncomeAccountRef ?? null,
    defaultIncomeAccountRef: connection.defaultIncomeAccountRef,
    defaultTaxCodeRef: connection.defaultTaxCodeRef,
    defaultExemptTaxCodeRef: connection.defaultExemptTaxCodeRef,
    defaultPaymentAccountRef: connection.defaultPaymentAccountRef,
    // A captured external fact, exposed so an operator can see whether connect-time
    // capture succeeded. Deliberately absent from settingsSchema — PATCH must never
    // accept it.
    homeCurrency: connection.homeCurrency,
    // Same story: captured at connect / settings refresh, read-only here.
    multiCurrencyEnabled: connection.multiCurrencyEnabled,
    // Phase D, Task 6 — reconcile-worker settings/status, so the "Sync now"
    // card can render whether pull is on and when it last ran.
    pullPayments: connection.pullPayments,
    lastReconcileAt: connection.lastReconcileAt,
    // Phase D2 — whether Breeze pushes its own payments into QuickBooks.
    pushPayments: connection.pushPayments,
  });
});

// Read from the outbox, not surviving payments: an owed delete must remain
// visible after voidPayment removes its invoice_payments row.
accountingRoutes.get('/:provider/owed-operations', authMiddleware, partnerScopes, requireAccountingPartnerAuthority, requireAccountingRead, zValidator('param', providerParamSchema), zValidator('query', partnerQuerySchema), async (c) => {
  const { provider } = c.req.valid('param');
  const gate = providerGateResponse(c, provider, 'paymentPush', { requireConfigured: false });
  if (gate) return gate;
  const partner = resolvePartnerId(c.get('auth'), c.req.valid('query').partnerId);
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const invoiceMapping = alias(accountingEntityMappings, 'owed_invoice_mapping');
  const rows = await db.select({
    id: accountingEntityMappings.id,
    pendingOp: accountingEntityMappings.pendingOp,
    lastError: accountingEntityMappings.lastError,
    pendingSince: sql<Date>`coalesce(${accountingEntityMappings.pendingSince}, ${accountingEntityMappings.createdAt})`.mapWith(accountingEntityMappings.createdAt),
    invoiceId: invoices.id,
    invoiceNumber: invoices.invoiceNumber,
  }).from(accountingEntityMappings)
    .innerJoin(accountingConnections, and(
      eq(accountingConnections.id, accountingEntityMappings.integrationId),
      eq(accountingConnections.partnerId, accountingEntityMappings.partnerId),
      eq(accountingConnections.provider, provider),
    ))
    .leftJoin(invoicePayments, eq(invoicePayments.id, accountingEntityMappings.breezeEntityId))
    // Payment remote ids encode Payment/Invoice. This recovers the invoice
    // after deletion; both mapping axes must match to avoid crossing realms.
    .leftJoin(invoiceMapping, and(
      eq(invoiceMapping.integrationId, accountingEntityMappings.integrationId),
      eq(invoiceMapping.partnerId, accountingEntityMappings.partnerId),
      eq(invoiceMapping.breezeEntityType, 'invoice'),
      eq(invoiceMapping.remoteEntityId, sql`split_part(${accountingEntityMappings.remoteEntityId}, '/', 2)`),
    ))
    .leftJoin(invoices, and(
      eq(invoices.id, sql`coalesce(${invoicePayments.invoiceId}, ${invoiceMapping.breezeEntityId})`),
      eq(invoices.partnerId, partner.partnerId),
    ))
    .where(and(
      eq(accountingEntityMappings.partnerId, partner.partnerId),
      eq(accountingEntityMappings.breezeEntityType, 'payment'),
      isNotNull(accountingEntityMappings.pendingOp),
    ))
    .orderBy(asc(accountingEntityMappings.pendingSince), asc(accountingEntityMappings.id));
  const now = Date.now();
  return c.json({
    count: rows.length,
    data: rows.map((row) => ({
      ...row,
      ageSeconds: Math.max(0, Math.floor((now - row.pendingSince.getTime()) / 1000)),
    })),
  });
});

// List remote QuickBooks customers, annotated with whether each is already
// imported. The route creates nothing in Breeze, so it needs no write-role
// permission, but annotation still compares against every organization in the
// partner and therefore requires full-partner org access.
accountingRoutes.get('/:provider/customers', authMiddleware, partnerScopes, requireFullPartnerOrgImportAccess, requireAccountingPartnerAuthority, requireAccountingRead, zValidator('param', providerParamSchema), zValidator('query', partnerQuerySchema), async (c) => {
  const { provider } = c.req.valid('param');
  const gate = providerGateResponse(c, provider, 'customerImport');
  if (gate) return gate;
  const partner = resolvePartnerId(c.get('auth'), c.req.valid('query').partnerId);
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  try {
    const data = await listAccountingCustomersAnnotated(partner.partnerId, provider);
    return c.json({ data });
  } catch (err) {
    return handleImportError(c, err);
  }
});

// Import selected QuickBooks customers as orgs + sites. Write + MFA-gated.
// Carries `accounting:read` cumulatively (PR review finding): the response
// echoes remote QuickBooks displayNames for the caller-supplied ids, so this
// route reads the shared provider realm as well as creating tenants. That
// guard lives inside `requireImportPermissions` — see its comment.
accountingRoutes.post('/:provider/customers/import', authMiddleware, partnerScopes, requireFullPartnerOrgImportAccess, requireAccountingPartnerAuthority, requireImportPermissions, requireMfa(), zValidator('param', providerParamSchema), zValidator('query', partnerQuerySchema), zValidator('json', importCustomersSchema), async (c) => {
  const { provider } = c.req.valid('param');
  const gate = providerGateResponse(c, provider, 'customerImport');
  if (gate) return gate;
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, c.req.valid('query').partnerId);
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);

  let summary;
  try {
    summary = await importAccountingCustomers({
      partnerId: partner.partnerId,
      provider,
      customerIds: c.req.valid('json').customerIds,
      // Stamped onto organization_external_links.created_by by the seam.
      actor: { userId: auth.user?.id ?? null },
    });
  } catch (err) {
    return handleImportError(c, err);
  }

  // Audit each created org (the site id is recorded in details). The import
  // ran in system context, so the actor-bearing audit is written here.
  for (const item of summary.imported) {
    writeRouteAudit(c, {
      orgId: item.organizationId,
      action: 'organization.create',
      resourceType: 'organization',
      resourceId: item.organizationId,
      resourceName: item.displayName,
      details: { source: `${provider}_import`, [`${provider}CustomerId`]: item.customerId, siteId: item.siteId },
    });
  }

  return c.json({ data: summary });
});

accountingRoutes.patch('/:provider/settings', authMiddleware, partnerScopes, requireAccountingPartnerAuthority, requireAccountingManage, requireMfa(), zValidator('param', providerParamSchema), zValidator('query', partnerQuerySchema), zValidator('json', settingsSchema), requireInvoicePushForSyncSwitches, async (c) => {
  const { provider } = c.req.valid('param');
  const gate = providerGateResponse(c, provider, 'connect', { requireConfigured: false });
  if (gate) return gate;
  const body = c.req.valid('json');
  const partner = resolvePartnerId(c.get('auth'), c.req.valid('query').partnerId);
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);

  if (('feeIncomeItemRef' in body || 'feeIncomeAccountRef' in body)
    && !await isAutopayEnabledForPartner(db, partner.partnerId)) {
    return c.json({ error: 'Automatic payments are not enabled', code: 'autopay_not_enabled' }, 404);
  }
  if ((provider === 'xero' && body.feeIncomeItemRef != null)
    || (provider !== 'xero' && body.feeIncomeAccountRef != null)) {
    return c.json({ error: 'Use the processing fee mapping for this accounting provider' }, 400);
  }

  const [updated] = await db
    .update(accountingConnections)
    .set({
      ...('feeIncomeItemRef' in body ? { feeIncomeItemRef: body.feeIncomeItemRef } : {}),
      ...('feeIncomeAccountRef' in body ? { feeIncomeAccountRef: body.feeIncomeAccountRef } : {}),
      ...('pushMode' in body ? { pushMode: body.pushMode } : {}),
      ...('defaultIncomeAccountRef' in body ? { defaultIncomeAccountRef: body.defaultIncomeAccountRef } : {}),
      ...('defaultTaxCodeRef' in body ? { defaultTaxCodeRef: body.defaultTaxCodeRef } : {}),
      ...('defaultExemptTaxCodeRef' in body ? { defaultExemptTaxCodeRef: body.defaultExemptTaxCodeRef } : {}),
      ...('defaultPaymentAccountRef' in body ? { defaultPaymentAccountRef: body.defaultPaymentAccountRef } : {}),
      ...('pullPayments' in body ? { pullPayments: body.pullPayments } : {}),
      ...('pushPayments' in body ? { pushPayments: body.pushPayments } : {}),
      // Turning the switch back ON restarts the horizon, so a deliberate pause
      // never later flushes a backlog of payments the operator recorded while it
      // was off (review wave 2, finding 2). Decided IN the UPDATE: the SET list
      // sees the row's OLD `push_payments`, so the flip is detected atomically
      // without a read-modify-write, and turning it ON when it was already on
      // leaves the horizon exactly where it was.
      ...(body.pushPayments === true
        ? {
          pushPaymentsSince: sql`CASE WHEN ${accountingConnections.pushPayments} = false THEN now() ELSE ${accountingConnections.pushPaymentsSince} END`,
        }
        : {}),
      updatedAt: new Date(),
    })
    .where(and(
      eq(accountingConnections.partnerId, partner.partnerId),
      eq(accountingConnections.provider, provider)
    ))
    .returning({
      feeIncomeItemRef: accountingConnections.feeIncomeItemRef,
      feeIncomeAccountRef: accountingConnections.feeIncomeAccountRef,
      status: accountingConnections.status,
      environment: accountingConnections.environment,
      pushMode: accountingConnections.pushMode,
      defaultIncomeAccountRef: accountingConnections.defaultIncomeAccountRef,
      defaultTaxCodeRef: accountingConnections.defaultTaxCodeRef,
      defaultExemptTaxCodeRef: accountingConnections.defaultExemptTaxCodeRef,
      defaultPaymentAccountRef: accountingConnections.defaultPaymentAccountRef,
      lastError: accountingConnections.lastError,
      pullPayments: accountingConnections.pullPayments,
      pushPayments: accountingConnections.pushPayments,
    });

  if (!updated) return c.json({ error: 'Accounting connection not found' }, 404);
  return c.json(updated);
});

// On-demand realm settings refresh (multi-currency §11 / Phase C). Write +
// MFA-gated (same tier as PATCH /:provider/settings above — it makes a real
// outbound QuickBooks call and persists the result). The service call makes a
// live QBO HTTP request, so this route also carries the
// SELF_MANAGED_DB_CONTEXT_ROUTES registration (middleware/selfManagedDbContextRoutes.ts)
// — no ambient request transaction, so `refreshRealmSettings`'s ambient-`db`
// reads/writes need an explicit context. The route supplies a RUNNER, not a
// wrapper: the service re-enters it per DB phase and asserts nothing is
// already open, so no connection is pinned across the QuickBooks round trip
// and each phase commits on its own (services/accounting/dbContextGuard.ts).
// The same applies to the four mapping-workbench routes below.
accountingRoutes.post('/:provider/settings/refresh', authMiddleware, partnerScopes, requireAccountingPartnerAuthority, requireAccountingManage, requireMfa(), zValidator('param', providerParamSchema), zValidator('query', partnerQuerySchema), async (c) => {
  const { provider } = c.req.valid('param');
  const gate = providerGateResponse(c, provider, 'connect');
  if (gate) return gate;
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, c.req.valid('query').partnerId);
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);

  let settings;
  try {
    settings = await refreshRealmSettings(partner.partnerId, provider, (fn) => withAuthDbAccessContext(auth, fn));
  } catch (err) {
    return handleConnectionError(c, err);
  }

  writeRouteAudit(c, {
    orgId: null,
    action: 'accounting.settings.refresh',
    resourceType: 'accounting_connection',
    resourceId: null,
    details: {
      provider,
      homeCurrency: settings.homeCurrency,
      multiCurrencyEnabled: settings.multiCurrencyEnabled,
    },
  });

  return c.json(settings);
});

// "Sync now" (Phase D, Task 6) — manually kicks the accounting-reconcile
// worker's CDC pull for this connection, same job shape the 15-minute sweep
// and the QuickBooks webhook route enqueue with `trigger: 'sweep'`/`'webhook'`
// (jobs/accountingReconcileWorker.ts). Gated on INVOICES_WRITE via
// requireInvoicePush — a payment pull-back is an invoice-shaped write, same
// tier as the manual/bulk invoice push routes above.
//
// This route only ever touches Redis (`enqueueAccountingReconcile` never
// calls QuickBooks itself — the actual CDC pull happens later, on the
// worker), so — like `push-bulk` above — it keeps the normal ambient request
// transaction and carries NO SELF_MANAGED_DB_CONTEXT_ROUTES entry
// (middleware/selfManagedDbContextRoutes.ts:90-92 records the same reasoning
// for push-bulk).
//
// Reports `enqueued` HONESTLY (the Phase C lesson: `enqueueAccountingInvoicePush`
// swallows a Redis outage by design, so the caller must surface its boolean
// rather than assume the job landed — see the push-bulk route's comment above).
accountingRoutes.post('/:provider/reconcile', authMiddleware, partnerScopes, requireAccountingPartnerAuthority, requireAccountingManage, requireMfa(), requireInvoicePush, zValidator('param', providerParamSchema), zValidator('query', partnerQuerySchema), async (c) => {
  const { provider } = c.req.valid('param');
  const gate = providerGateResponse(c, provider, 'paymentPull', { requireConfigured: false });
  if (gate) return gate;
  const partner = resolvePartnerId(c.get('auth'), c.req.valid('query').partnerId);
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);

  const connection = await getConnection(db, partner.partnerId, provider);
  if (!connection) return c.json({ error: 'Accounting connection not found' }, 404);

  // Issue #4543: refuse rather than answer `{ enqueued: true }` honestly-but-
  // uselessly. Before this check, a switched-off connection still got a
  // 200/queued response — the reconcile worker then silently no-oped
  // (accountingReconcileWorker.ts's `both_switches_off` short-circuit) and the
  // operator had no way to tell "switch is off" apart from "it's syncing".
  // 409 + a stable `code`, matching the `{ error, code }` shape
  // AccountingConnectionError/AccountingMappingError already use elsewhere in
  // this file, rather than adding a new response shape.
  //
  // Phase D2 (spec decision 6): the gate is pull OR push, mirroring the
  // worker. With pull off and push on the CDC pass still has work — it adopts
  // Breeze-created Payments whose phase 2 never landed and notices
  // Breeze-origin Payments deleted in QuickBooks — so "Sync now" must run.
  if (!connection.pullPayments && !connection.pushPayments) {
    return c.json({ error: 'Payment sync is disabled for this connection', code: 'payment_sync_disabled' }, 409);
  }

  const enqueued = await enqueueAccountingReconcile(connection.id, partner.partnerId, 'manual');

  writeRouteAudit(c, {
    orgId: null,
    action: 'accounting.reconcile.requested',
    resourceType: 'accounting_connection',
    resourceId: connection.id,
    details: { provider, connectionId: connection.id, enqueued },
  });

  return c.json({ enqueued });
});

// Mapping proposals (reconciliation) — read-only, so partner/system scope is
// the whole gate, same as GET /:provider/customers above. The service performs
// QuickBooks HTTP inside, so this route is registered in
// SELF_MANAGED_DB_CONTEXT_ROUTES (middleware/selfManagedDbContextRoutes.ts) —
// no ambient request transaction, so the service's ambient-`db` reads need an
// explicit context (Task 5 review fix — see the settings/refresh comment above).
accountingRoutes.get('/:provider/mappings', authMiddleware, partnerScopes, requireAccountingPartnerAuthority, requireAccountingRead, zValidator('param', providerParamSchema), zValidator('query', mappingEntityQuerySchema), async (c) => {
  const { provider } = c.req.valid('param');
  const gate = providerGateResponse(c, provider, 'mapping');
  if (gate) return gate;
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, c.req.valid('query').partnerId);
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const { entityType } = c.req.valid('query');

  try {
    const data = await listMappingProposals(
      { partnerId: partner.partnerId, provider, entityType },
      (fn) => withAuthDbAccessContext(auth, fn),
    );
    return c.json({ data });
  } catch (err) {
    return handleMappingError(c, err);
  }
});

// Remote income account selector for item mapping — read-only. Also QBO-HTTP
// backed, so it carries the same SELF_MANAGED_DB_CONTEXT_ROUTES registration
// (and the same explicit-context requirement — Task 5 review fix).
accountingRoutes.get('/:provider/income-accounts', authMiddleware, partnerScopes, requireAccountingPartnerAuthority, requireAccountingRead, zValidator('param', providerParamSchema), zValidator('query', partnerQuerySchema), async (c) => {
  const { provider } = c.req.valid('param');
  const gate = providerGateResponse(c, provider, 'mapping');
  if (gate) return gate;
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, c.req.valid('query').partnerId);
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);

  try {
    const data = await listRemoteIncomeAccountsForPartner(
      { partnerId: partner.partnerId, provider },
      (fn) => withAuthDbAccessContext(auth, fn),
    );
    return c.json({ data });
  } catch (err) {
    return handleMappingError(c, err);
  }
});

// Confirm/create/unlink a single mapping. Write + MFA-gated, entity-aware
// permission (ORGS_WRITE for org, CATALOG_WRITE for catalog_item) — the
// `confirmed` path calls the provider list to verify the remote entity, so
// this route also carries the SELF_MANAGED_DB_CONTEXT_ROUTES registration
// (and the same explicit-context requirement — Task 5 review fix).
accountingRoutes.put('/:provider/mappings', authMiddleware, partnerScopes, requireAccountingPartnerAuthority, requireAccountingManage, requireMfa(), zValidator('param', providerParamSchema), zValidator('query', partnerQuerySchema), zValidator('json', mappingDecisionSchema), requireMappingWrite, async (c) => {
  const { provider } = c.req.valid('param');
  const gate = providerGateResponse(c, provider, 'mapping');
  if (gate) return gate;
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, c.req.valid('query').partnerId);
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const body = c.req.valid('json');

  let mapping;
  try {
    mapping = await saveMappingDecision({
      partnerId: partner.partnerId,
      provider,
      breezeEntityType: body.breezeEntityType,
      breezeEntityId: body.breezeEntityId,
      decision: body.decision as MappingDecision,
      remoteEntityId: body.remoteEntityId,
    }, (fn) => withAuthDbAccessContext(auth, fn));
  } catch (err) {
    return handleMappingError(c, err);
  }

  // saveMappingDecision has committed its short auth-scoped context. Redis
  // runs outside that context; the stale-row sweep recovers a missed enqueue.
  if (body.decision === 'confirmed' || body.decision === 'create_new') {
    await runOutsideDbContext(() => enqueueAccountingMappingSync(
      body.breezeEntityType, body.breezeEntityId, partner.partnerId, mapping.integrationId,
    ));
  }

  writeRouteAudit(c, {
    orgId: body.breezeEntityType === 'org' ? body.breezeEntityId : null,
    action: 'accounting.mapping.update',
    resourceType: 'accounting_mapping',
    resourceId: mapping.id,
    details: {
      breezeEntityType: body.breezeEntityType,
      breezeEntityId: body.breezeEntityId,
      decision: body.decision,
      remoteEntityType: mapping.remoteEntityType,
      resultStatus: mapping.syncStatus,
    },
  });

  return c.json({ data: toMappingResponse(mapping) });
});

// Push a confirmed/create_new mapping to QuickBooks. Write + MFA-gated, same
// entity-aware permission guard as PUT above, and the same
// SELF_MANAGED_DB_CONTEXT_ROUTES registration (the provider upsert call is
// real QuickBooks HTTP) — and the same explicit-context requirement (Task 5
// review fix).
accountingRoutes.post('/:provider/mappings/sync', authMiddleware, partnerScopes, requireAccountingPartnerAuthority, requireAccountingManage, requireMfa(), zValidator('param', providerParamSchema), zValidator('query', partnerQuerySchema), zValidator('json', mappingSyncSchema), requireMappingWrite, async (c) => {
  const { provider } = c.req.valid('param');
  const gate = providerGateResponse(c, provider, 'mapping');
  if (gate) return gate;
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, c.req.valid('query').partnerId);
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const body = c.req.valid('json');

  let mapping;
  try {
    mapping = await syncMappedEntity({
      partnerId: partner.partnerId,
      provider,
      breezeEntityType: body.breezeEntityType,
      breezeEntityId: body.breezeEntityId,
    }, (fn) => withAuthDbAccessContext(auth, fn));
  } catch (err) {
    return handleMappingError(c, err);
  }

  writeRouteAudit(c, {
    orgId: body.breezeEntityType === 'org' ? body.breezeEntityId : null,
    action: 'accounting.entity.sync',
    resourceType: 'accounting_mapping',
    resourceId: mapping.id,
    details: {
      breezeEntityType: body.breezeEntityType,
      breezeEntityId: body.breezeEntityId,
      remoteEntityType: mapping.remoteEntityType,
      resultStatus: mapping.syncStatus,
    },
  });

  return c.json({ data: toMappingResponse(mapping) });
});


// ---------------------------------------------------------------------------
// Phase C, Task 5 (2026-09-01-quickbooks-phase-c-invoice-push) — manual/bulk
// invoice push and remote-candidate search.
// ---------------------------------------------------------------------------

// Manual, synchronous invoice push. Write + MFA-gated on INVOICES_WRITE
// (system scope bypasses the role lookup — see `requireInvoicePush`).
// `pushInvoiceToAccounting` makes REAL outbound QuickBooks calls and must be
// entered with NO ambient DB context (it asserts that): this route therefore
// carries the SELF_MANAGED_DB_CONTEXT_ROUTES registration
// (middleware/selfManagedDbContextRoutes.ts) and hands the coordinator a
// `runInDbContext` runner it re-enters per phase — exactly mirroring how
// `processAccountingSyncJob` (jobs/accountingSyncWorker.ts) hands it a SYSTEM
// runner off the request path. Wrapping the call instead would hold one
// transaction across every QuickBooks call AND roll back the coordinator's
// error markers whenever it throws.
accountingRoutes.post(
  '/:provider/invoices/:invoiceId/push',
  authMiddleware,
  partnerScopes,
  requireAccountingPartnerAuthority,
  requireAccountingManage,
  requireMfa(),
  requireInvoicePush,
  zValidator('param', invoicePushParamSchema),
  zValidator('query', partnerQuerySchema),
  async (c) => {
    const { provider, invoiceId } = c.req.valid('param');
    const gate = providerGateResponse(c, provider, 'invoicePush');
    if (gate) return gate;
    const auth = c.get('auth');
    const partner = resolvePartnerId(auth, c.req.valid('query').partnerId);
    if ('error' in partner) return c.json({ error: partner.error }, partner.status);

    let outcome;
    try {
      outcome = await pushInvoiceToAccounting(invoiceId, partner.partnerId, (fn) => withAuthDbAccessContext(auth, fn), { provider });
    } catch (err) {
      return handleInvoicePushError(c, err);
    }

    writeRouteAudit(c, {
      orgId: null,
      action: 'accounting.invoice.push',
      resourceType: 'accounting_mapping',
      resourceId: outcome.mappingId,
      details: {
        provider,
        invoiceId,
        remoteEntityId: outcome.remoteEntityId,
        docNumber: outcome.docNumber,
        syncStatus: outcome.syncStatus,
        taxVarianceCents: outcome.taxVarianceCents,
        totalVarianceCents: outcome.totalVarianceCents,
      },
    });

    return c.json({
      syncStatus: outcome.syncStatus,
      docNumber: outcome.docNumber,
      taxVarianceCents: outcome.taxVarianceCents,
      totalVarianceCents: outcome.totalVarianceCents,
    });
  },
);

// Bulk enqueue. Same gates as the manual push route above, but this one only
// ever touches Redis (the push happens later on the accounting-sync worker), so
// it keeps the ambient request transaction and has NO SELF_MANAGED_DB_CONTEXT_ROUTES
// entry. Every job carries the partner's ONE connection id, resolved once (Xero W01).
accountingRoutes.post(
  '/:provider/invoices/push-bulk',
  authMiddleware,
  partnerScopes,
  requireAccountingPartnerAuthority,
  requireAccountingManage,
  requireMfa(),
  requireInvoicePush,
  zValidator('param', providerParamSchema),
  zValidator('query', partnerQuerySchema),
  zValidator('json', invoicePushBulkSchema),
  async (c) => {
    const { provider } = c.req.valid('param');
    const gate = providerGateResponse(c, provider, 'invoicePush');
    if (gate) return gate;
    const partner = resolvePartnerId(c.get('auth'), c.req.valid('query').partnerId);
    if ('error' in partner) return c.json({ error: partner.error }, partner.status);
    const { invoiceIds } = c.req.valid('json');
    const conn = await resolveActiveConnectionRef(db, partner.partnerId); // non-decrypting: only .id/.provider used below
    if (conn && (conn.provider !== provider || !providerSupports(conn.provider, 'invoicePush'))) {
      return c.json({ error: 'Invoice push is not available for this accounting connection', code: 'capability_unavailable' }, 409);
    }

    // Ownership filter: one `inArray` select, not N lookups. A foreign or
    // unknown id lands in `skipped` (a bulk convenience, not a validation surface).
    const owned = await db
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(inArray(invoices.id, invoiceIds), eq(invoices.partnerId, partner.partnerId)));
    const ownedIds = new Set(owned.map((row) => row.id));

    // `enqueued` counts jobs the queue ACCEPTED (the enqueue swallows a Redis
    // outage; counting every owned id hid a total queue failure). No connection
    // at all: nothing is enqueued, every id is `skipped` (it would only no-op).
    let enqueued = 0;
    let failed = 0;
    let skipped = 0;
    for (const invoiceId of invoiceIds) {
      if (!ownedIds.has(invoiceId) || !conn) { skipped++; continue; }
      // Operator-initiated: runs even in pushMode 'manual' (#7251).
      if (await enqueueAccountingInvoicePush(invoiceId, partner.partnerId, conn.id, { requestedBy: 'operator' })) enqueued++;
      else failed++;
    }

    writeRouteAudit(c, {
      orgId: null,
      action: 'accounting.invoice.push_bulk',
      resourceType: 'accounting_mapping',
      resourceId: null,
      details: { provider, requested: invoiceIds.length, enqueued, skipped, failed },
    });

    return c.json({ enqueued, skipped, failed });
  },
);

// Remote candidate search (Phase B follow-up, surfaced by Task 5): replaces
// manual remote-ID entry in the mapping workbench. Read-only — same gate
// shape as GET /:provider/customers above: full-partner authority plus
// `accounting:read`, and no MFA (reads are not step-up gated) and no write
// permission (it creates nothing in Breeze). Makes a real outbound QuickBooks
// call via
// `resolveConnectionAndToken` + `listRemoteCustomers`/`listRemoteItems`, so it
// carries the same SELF_MANAGED_DB_CONTEXT_ROUTES + `runInDbContext` runner
// treatment as the push route above. Wraps its response in `{ data }` —
// review ruling (Task 5 fix round): every sibling list route in this file
// (`/customers`, `/mappings`, `/income-accounts`) uses that envelope, and
// Task 7's web layer consumes it the same way.
accountingRoutes.get(
  '/:provider/remote-candidates',
  authMiddleware,
  partnerScopes,
  requireAccountingPartnerAuthority,
  requireAccountingRead,
  zValidator('param', providerParamSchema),
  zValidator('query', remoteCandidatesQuerySchema),
  async (c) => {
    const { provider } = c.req.valid('param');
    const gate = providerGateResponse(c, provider, 'mapping');
    if (gate) return gate;
    const auth = c.get('auth');
    const partner = resolvePartnerId(auth, c.req.valid('query').partnerId);
    if ('error' in partner) return c.json({ error: partner.error }, partner.status);
    const { entityType, q } = c.req.valid('query');

    try {
      const { liveConn } = await resolveConnectionAndToken(partner.partnerId, { provider }, (fn) => withAuthDbAccessContext(auth, fn));
      const providerImpl = getAccountingProvider(provider);
      const data = entityType === 'org'
        ? (await runOutsideDbContext(() => providerImpl.listRemoteCustomers(liveConn, q))).map((r) => ({
          id: r.id, displayName: r.displayName, email: r.email ?? null, currencyCode: r.currencyCode ?? null, archived: r.active === false,
        }))
        : (await runOutsideDbContext(() => providerImpl.listRemoteItems(liveConn, q))).map((r) => ({
          id: r.id, displayName: r.displayName, sku: r.sku ?? null, archived: r.active === false,
        }));
      return c.json({ data });
    } catch (err) {
      return handleMappingError(c, err);
    }
  },
);
