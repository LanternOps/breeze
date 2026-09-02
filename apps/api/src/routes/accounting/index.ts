import { Hono, type Env, type MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { accountingConnections, invoices } from '../../db/schema';
import {
  authMiddleware, requireMfa, requirePermission, requireScope, withAuthDbAccessContext, type AuthContext,
} from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_ENVIRONMENT, QBO_REDIRECT_URI } from '../../config/env';
import {
  AccountingConnectionError,
  deleteConnection,
  getConnection,
  isHomeCurrencyCasAbort,
  refreshRealmSettings,
  updateHomeCurrency,
  updateMultiCurrencyEnabled,
  upsertConnection,
  resetConnectionForRealmChange,
} from '../../services/accounting/accountingConnectionService';
import type { AccountingConnection } from '../../services/accounting/accountingConnectionService';
import {
  importQuickbooksCustomers,
  listQuickbooksCustomersAnnotated,
  QbImportError,
} from '../../services/accounting/quickbooksCustomerImport';
import {
  AccountingMappingError,
  listMappingProposals,
  listRemoteIncomeAccountsForPartner,
  resolveConnectionAndToken,
  saveMappingDecision,
  syncMappedEntity,
  type MappingDecision,
  type MappingEntityType,
} from '../../services/accounting/accountingMappingService';
import { AccountingInvoicePushError, pushInvoiceToAccounting } from '../../services/accounting/accountingInvoicePush';
import { enqueueAccountingInvoicePush } from '../../jobs/accountingSyncWorker';
import { enqueueAccountingReconcile } from '../../jobs/accountingReconcileWorker';
import { writeRouteAudit } from '../../services/auditEvents';
import { getAccountingProvider } from '../../services/accounting/providerRegistry';
import { captureException, captureMessage } from '../../services/sentry';
import type { AccountingProviderId } from '../../services/accounting/types';

export const accountingRoutes = new Hono();

const partnerScopes = requireScope('partner', 'system');

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
 * Note routes/orgs.ts POST /import has the same latent gap; it is not fixed
 * here to keep this PR's blast radius on the QuickBooks path.
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

const requireImportPermissions = partnerScopedPermission(requireOrgWrite, requireSiteWrite);
const providerParamSchema = z.object({ provider: z.enum(['quickbooks']) });
const partnerQuerySchema = z.object({ partnerId: z.string().guid().optional() });
const callbackQuerySchema = z.object({
  code: z.string().min(1),
  realmId: z.string().min(1),
  state: z.string().min(1),
});
const settingsSchema = z.object({
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
const invoicePushParamSchema = z.object({ provider: z.enum(['quickbooks']), invoiceId: z.string().guid() });
const invoicePushBulkSchema = z.object({
  invoiceIds: z.array(z.string().guid()).min(1).max(100),
});
const remoteCandidatesQuerySchema = partnerQuerySchema.extend({
  entityType: z.enum(['org', 'catalog_item']),
  q: z.string().max(255).optional(),
});

function handleImportError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  // QbImportError.status is a narrowed literal union (400|404|409|502), so no cast.
  if (err instanceof QbImportError) return c.json({ error: err.message, code: err.code }, err.status);
  throw err;
}

function handleMappingError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  // AccountingMappingError.status is a narrowed literal union (404|409|502), so
  // no cast, and every current/future code (including item_price_required)
  // flows through generically — the route never re-enumerates codes.
  if (err instanceof AccountingMappingError) return c.json({ error: err.message, code: err.code }, err.status);
  throw err;
}

/**
 * Deliberately a DIFFERENT body shape from `handleMappingError` above
 * (`{ error: code, message }`, not `{ error: message, code }`) — the invoice
 * push coordinator's error taxonomy (Phase C, Task 3) is a separate typed
 * class from the mapping workbench's, and this shape is what Task 5's spec
 * calls for.
 */
function handleInvoicePushError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  // AccountingInvoicePushError.status is a narrowed literal union (404|409|502), so no cast.
  if (err instanceof AccountingInvoicePushError) return c.json({ error: err.code, message: err.message }, err.status);
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
const STATE_TTL_MS = 10 * 60 * 1000;

interface AccountingStatePayload {
  partnerId: string;
  userId: string | null;
  nonce: string;
  exp: number;
}

function signingSecret(): string | null {
  return process.env.APP_ENCRYPTION_KEY?.trim()
    || process.env.SECRET_ENCRYPTION_KEY?.trim()
    || process.env.SESSION_SECRET?.trim()
    || process.env.JWT_SECRET?.trim()
    || (process.env.NODE_ENV === 'production' ? null : 'test-only-accounting-oauth-state-secret');
}

function hmac(label: string, value: string): string | null {
  const secret = signingSecret();
  if (!secret) return null;
  return createHmac('sha256', secret).update(`${label}:${value}`).digest('base64url');
}

function createState(partnerId: string, userId: string | null): string | null {
  const payload: AccountingStatePayload = {
    partnerId,
    userId,
    nonce: randomBytes(16).toString('hex'),
    exp: Date.now() + STATE_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = hmac('accounting-oauth', encoded);
  return sig ? `${encoded}.${sig}` : null;
}

function verifyState(state: string): AccountingStatePayload | null {
  const [encoded, sig] = state.split('.');
  if (!encoded || !sig) return null;
  const expected = hmac('accounting-oauth', encoded);
  if (!expected) return null;
  if (!constantTimeEqual(sig, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as AccountingStatePayload;
    if (!parsed.partnerId || !parsed.nonce || !parsed.exp || parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

function stateCookieValue(state: string): string | null {
  return hmac('accounting-oauth-cookie', state);
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

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

function validateProviderConfig(provider: AccountingProviderId): string | null {
  if (provider !== 'quickbooks') return null;
  if (!QBO_CLIENT_ID || !QBO_CLIENT_SECRET || !QBO_REDIRECT_URI || !QBO_ENVIRONMENT) {
    return 'QuickBooks OAuth is not configured on this instance';
  }
  if (QBO_ENVIRONMENT !== 'sandbox' && QBO_ENVIRONMENT !== 'production') {
    return 'QBO_ENVIRONMENT must be sandbox or production';
  }
  return null;
}

// Initiate the OAuth flow. Authenticated + MFA-gated: this is the privileged
// action that decides which partner an external accounting realm links to.
accountingRoutes.get('/:provider/connect', authMiddleware, partnerScopes, requireMfa(), zValidator('param', providerParamSchema), zValidator('query', partnerQuerySchema), async (c) => {
  const { provider } = c.req.valid('param');
  const configError = validateProviderConfig(provider);
  if (configError) return c.json({ error: configError }, 400);
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, c.req.valid('query').partnerId);
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);

  const state = createState(partner.partnerId, auth.user?.id ?? null);
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
  const configError = validateProviderConfig(provider);
  if (configError) return c.json({ error: configError }, 400);

  const state = verifyState(query.state);
  if (!state) return c.json({ error: 'Invalid or expired OAuth state' }, 400);

  const expectedCookie = stateCookieValue(query.state);
  const presentedCookie = getCookie(c, ACCOUNTING_STATE_COOKIE);
  if (!expectedCookie || !presentedCookie || !constantTimeEqual(presentedCookie, expectedCookie)) {
    return c.json({ error: 'OAuth state binding mismatch' }, 400);
  }

  const providerClient = getAccountingProvider(provider);
  let tokens;
  try {
    tokens = await runOutsideDbContext(() => providerClient.exchangeCode(query.code, query.realmId));
  } catch (err) {
    // Never log query.code / realmId / token bodies — only partner + provider.
    captureException(err instanceof Error ? err : new Error(String(err)), c);
    console.error('[accounting] QuickBooks code exchange failed', { partnerId: state.partnerId, provider });
    deleteCookie(c, ACCOUNTING_STATE_COOKIE, { path: '/' });
    return c.redirect('/integrations?accounting=quickbooks&error=exchange_failed#accounting');
  }

  // No request auth context here, so the write would match 0 rows under
  // breeze_app RLS (silent failure). Run it in system context with the
  // partnerId taken from the verified state. Guard the persist: a failure
  // after a successful exchange leaves a live-but-unrecorded grant, so surface
  // it rather than 500-ing on a raw page.
  // Does this reconnect change realms? A DIFFERENT realm's home currency must
  // never persist, but blanking it on a SAME-realm reconnect degrades a healthy
  // connection: capture below is non-fatal and there is no retry, no refresh
  // route and no job, so a transient Preferences failure would strand the row at
  // NULL until someone completes another full OAuth round-trip that succeeds.
  // Read failure falls back to the fail-closed answer (null) rather than losing
  // the freshly-exchanged grant.
  let priorRealmId: string | null = null;
  let priorRealmKnown = false;
  try {
    const existing = await withSystemDbAccessContext(() => getConnection(db, state.partnerId, provider));
    priorRealmId = existing?.realmId ?? null;
    priorRealmKnown = true;
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), c);
    console.warn('[accounting] QuickBooks pre-reconnect realm read failed; clearing home currency', { partnerId: state.partnerId, provider });
  }
  const sameRealm = priorRealmKnown && priorRealmId !== null && priorRealmId === tokens.realmId;

  let connection: AccountingConnection;
  try {
    connection = await withSystemDbAccessContext(() => upsertConnection(db, state.partnerId, provider, {
      realmId: tokens.realmId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      environment: QBO_ENVIRONMENT as 'sandbox' | 'production',
      // Explicit null on a realm CHANGE, not omission: upsertConnection's
      // conflict set strips undefined, so omitting it would carry a PREVIOUS
      // realm's home currency across a reconnect. Unknown must fail closed at
      // push time instead (multi-currency §11). On a same-realm reconnect the
      // undefined is deliberate — it leaves an already-captured currency intact.
      homeCurrency: sameRealm ? undefined : null,
      status: 'connected',
      lastError: null,
      connectedBy: state.userId,
    }));
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), c);
    console.error('[accounting] QuickBooks connection persist failed', { partnerId: state.partnerId, provider });
    deleteCookie(c, ACCOUNTING_STATE_COOKIE, { path: '/' });
    return c.redirect('/integrations?accounting=quickbooks&error=persist_failed#accounting');
  }

  // A reconnect that landed on a DIFFERENT QuickBooks company gets DISCONNECT
  // SEMANTICS (finding C): every `accounting_entity_mappings` row under this
  // connection still names the OLD realm's Customer/Item/Invoice/Payment ids,
  // and `cdc_cursor` is a watermark in the old realm's change stream. Left
  // alone, the next push would "update" a stranger's invoice and the next pull
  // would skip the new realm's first window as already read.
  //
  // Only fires on a POSITIVELY KNOWN change: `priorRealmKnown` false means the
  // pre-upsert read failed, and destroying a healthy connection's entire
  // mapping set on a guess is far worse than the divergence it would prevent.
  // Non-fatal for the same reason the currency capture is: the grant is already
  // live, and a reconcile job that arrives before this lands is caught by the
  // worker's own compare-and-set on the fingerprint.
  const realmChanged = priorRealmKnown && priorRealmId !== null && priorRealmId !== tokens.realmId;
  if (realmChanged) {
    try {
      const { mappingsDeleted } = await withSystemDbAccessContext(
        () => resetConnectionForRealmChange(db, connection.id, state.partnerId),
      );
      console.warn('[accounting] QuickBooks realm changed on reconnect; mappings and CDC cursor cleared', {
        partnerId: state.partnerId, provider, mappingsDeleted,
      });
      writeRouteAudit(c, {
        orgId: null,
        action: 'accounting.connection.realm_changed',
        resourceType: 'accounting_connection',
        resourceId: connection.id,
        details: { provider, mappingsDeleted },
      });
    } catch (err) {
      captureException(err instanceof Error ? err : new Error(String(err)), c);
      console.error('[accounting] QuickBooks realm-change cleanup failed', { partnerId: state.partnerId, provider });
    }
  }

  // Capture the realm's home currency (multi-currency §11). NON-FATAL by design:
  // the connection is already live and usable for customer import, and the
  // invoice-push guard fails closed on a NULL home currency, so a Preferences
  // outage must never turn a successful OAuth grant into a connect error.
  // The QBO call runs with no ambient DB context; the write is a short
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
      // (updatedAt) AND the realm we just exchanged for. A reconnect to another
      // realm in between — even inside the same millisecond — aborts the write.
      generation = await withSystemDbAccessContext(() => updateHomeCurrency(
        db,
        connection.id,
        state.partnerId,
        { updatedAt: generation as Date, realmId: tokens.realmId },
        homeCurrency,
      ));
    } else if (!homeCurrency) {
      // The realm reported nothing — an ordinary external condition. Push-time
      // fails closed on NULL, so a warning is the whole response.
      console.warn('[accounting] QuickBooks home currency unavailable', { partnerId: state.partnerId, provider });
    } else {
      // A GOOD capture we cannot anchor: the row we just upserted came back with
      // no updatedAt, so the compare-and-set has no generation to target. That is
      // an unexpected row shape, not an external outage — report it instead of
      // discarding the value under an "unavailable" warning.
      captureException(new Error('Accounting home currency captured but the persisted connection carried no updatedAt to compare-and-set against'), c);
      console.error('[accounting] QuickBooks home currency captured but the persisted row has no updatedAt', { partnerId: state.partnerId, provider });
    }
  } catch (err) {
    // A lost compare-and-set is an EXPECTED race (double connect, concurrent
    // reconnect), not a defect: the winning capture already wrote a currency for
    // the generation that survived. Report it as a warning so it stops filing
    // Sentry issues on a normal user action; genuine failures stay exceptions.
    if (isHomeCurrencyCasAbort(err)) {
      generation = null;
      captureMessage('[accounting] QuickBooks home currency capture lost the compare-and-set', {
        eventCode: 'accounting_home_currency_cas_lost',
      });
      console.warn('[accounting] QuickBooks home currency capture lost the compare-and-set', { partnerId: state.partnerId, provider });
    } else {
      captureException(err instanceof Error ? err : new Error(String(err)), c);
      console.warn('[accounting] QuickBooks home currency capture failed', { partnerId: state.partnerId, provider });
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
        state.partnerId,
        { updatedAt: generation as Date, realmId: tokens.realmId },
        capturedSettings!.multiCurrencyEnabled,
      ));
    } catch (err) {
      if (isHomeCurrencyCasAbort(err)) {
        console.warn('[accounting] QuickBooks multi-currency flag capture lost the compare-and-set', { partnerId: state.partnerId, provider });
      } else {
        captureException(err instanceof Error ? err : new Error(String(err)), c);
        console.warn('[accounting] QuickBooks multi-currency flag capture failed', { partnerId: state.partnerId, provider });
      }
    }
  }

  deleteCookie(c, ACCOUNTING_STATE_COOKIE, { path: '/' });
  return c.redirect('/integrations?accounting=quickbooks&connected=1#accounting');
});

accountingRoutes.post('/:provider/disconnect', authMiddleware, partnerScopes, requireMfa(), zValidator('param', providerParamSchema), zValidator('query', partnerQuerySchema), async (c) => {
  const { provider } = c.req.valid('param');
  const partner = resolvePartnerId(c.get('auth'), c.req.valid('query').partnerId);
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const removed = await deleteConnection(db, partner.partnerId, provider);
  if (!removed) return c.json({ error: 'Accounting connection not found' }, 404);
  return c.json({ disconnected: true });
});

accountingRoutes.get('/:provider', authMiddleware, partnerScopes, zValidator('param', providerParamSchema), zValidator('query', partnerQuerySchema), async (c) => {
  const { provider } = c.req.valid('param');
  const partner = resolvePartnerId(c.get('auth'), c.req.valid('query').partnerId);
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  const connection = await getConnection(db, partner.partnerId, provider);
  if (!connection) {
    return c.json({
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
    status: connection.status,
    environment: connection.environment,
    pushMode: connection.pushMode,
    connectedAt: connection.createdAt,
    lastError: connection.lastError,
    defaultIncomeAccountRef: connection.defaultIncomeAccountRef,
    defaultTaxCodeRef: connection.defaultTaxCodeRef,
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

// List remote QuickBooks customers, annotated with whether each is already
// imported. Read-only — it creates nothing in Breeze — so partner/system scope
// is the whole gate; see requireImportPermissions for why no write permission
// is required here.
accountingRoutes.get('/:provider/customers', authMiddleware, partnerScopes, zValidator('param', providerParamSchema), zValidator('query', partnerQuerySchema), async (c) => {
  const { provider } = c.req.valid('param');
  const configError = validateProviderConfig(provider);
  if (configError) return c.json({ error: configError }, 400);
  const partner = resolvePartnerId(c.get('auth'), c.req.valid('query').partnerId);
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  try {
    const data = await listQuickbooksCustomersAnnotated(partner.partnerId);
    return c.json({ data });
  } catch (err) {
    return handleImportError(c, err);
  }
});

// Import selected QuickBooks customers as orgs + sites. Write + MFA-gated.
accountingRoutes.post('/:provider/customers/import', authMiddleware, partnerScopes, requireImportPermissions, requireMfa(), zValidator('param', providerParamSchema), zValidator('query', partnerQuerySchema), zValidator('json', importCustomersSchema), async (c) => {
  const { provider } = c.req.valid('param');
  const configError = validateProviderConfig(provider);
  if (configError) return c.json({ error: configError }, 400);
  const auth = c.get('auth');
  const partner = resolvePartnerId(auth, c.req.valid('query').partnerId);
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);

  let summary;
  try {
    summary = await importQuickbooksCustomers({
      partnerId: partner.partnerId,
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
      details: { source: 'quickbooks_import', quickbooksCustomerId: item.customerId, siteId: item.siteId },
    });
  }

  return c.json({ data: summary });
});

accountingRoutes.patch('/:provider/settings', authMiddleware, partnerScopes, requireMfa(), zValidator('param', providerParamSchema), zValidator('query', partnerQuerySchema), zValidator('json', settingsSchema), requireInvoicePushForSyncSwitches, async (c) => {
  const { provider } = c.req.valid('param');
  const body = c.req.valid('json');
  const partner = resolvePartnerId(c.get('auth'), c.req.valid('query').partnerId);
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);

  const [updated] = await db
    .update(accountingConnections)
    .set({
      ...('pushMode' in body ? { pushMode: body.pushMode } : {}),
      ...('defaultIncomeAccountRef' in body ? { defaultIncomeAccountRef: body.defaultIncomeAccountRef } : {}),
      ...('defaultTaxCodeRef' in body ? { defaultTaxCodeRef: body.defaultTaxCodeRef } : {}),
      ...('pullPayments' in body ? { pullPayments: body.pullPayments } : {}),
      ...('pushPayments' in body ? { pushPayments: body.pushPayments } : {}),
      updatedAt: new Date(),
    })
    .where(and(
      eq(accountingConnections.partnerId, partner.partnerId),
      eq(accountingConnections.provider, provider)
    ))
    .returning({
      status: accountingConnections.status,
      environment: accountingConnections.environment,
      pushMode: accountingConnections.pushMode,
      defaultIncomeAccountRef: accountingConnections.defaultIncomeAccountRef,
      defaultTaxCodeRef: accountingConnections.defaultTaxCodeRef,
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
accountingRoutes.post('/:provider/settings/refresh', authMiddleware, partnerScopes, requireMfa(), zValidator('param', providerParamSchema), zValidator('query', partnerQuerySchema), async (c) => {
  const { provider } = c.req.valid('param');
  const configError = validateProviderConfig(provider);
  if (configError) return c.json({ error: configError }, 400);
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
accountingRoutes.post('/:provider/reconcile', authMiddleware, partnerScopes, requireMfa(), requireInvoicePush, zValidator('param', providerParamSchema), zValidator('query', partnerQuerySchema), async (c) => {
  const { provider } = c.req.valid('param');
  const partner = resolvePartnerId(c.get('auth'), c.req.valid('query').partnerId);
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);

  const connection = await getConnection(db, partner.partnerId, provider);
  if (!connection) return c.json({ error: 'Accounting connection not found' }, 404);

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
accountingRoutes.get('/:provider/mappings', authMiddleware, partnerScopes, zValidator('param', providerParamSchema), zValidator('query', mappingEntityQuerySchema), async (c) => {
  const { provider } = c.req.valid('param');
  const configError = validateProviderConfig(provider);
  if (configError) return c.json({ error: configError }, 400);
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
accountingRoutes.get('/:provider/income-accounts', authMiddleware, partnerScopes, zValidator('param', providerParamSchema), zValidator('query', partnerQuerySchema), async (c) => {
  const { provider } = c.req.valid('param');
  const configError = validateProviderConfig(provider);
  if (configError) return c.json({ error: configError }, 400);
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
accountingRoutes.put('/:provider/mappings', authMiddleware, partnerScopes, requireMfa(), zValidator('param', providerParamSchema), zValidator('query', partnerQuerySchema), zValidator('json', mappingDecisionSchema), requireMappingWrite, async (c) => {
  const { provider } = c.req.valid('param');
  const configError = validateProviderConfig(provider);
  if (configError) return c.json({ error: configError }, 400);
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
accountingRoutes.post('/:provider/mappings/sync', authMiddleware, partnerScopes, requireMfa(), zValidator('param', providerParamSchema), zValidator('query', partnerQuerySchema), zValidator('json', mappingSyncSchema), requireMappingWrite, async (c) => {
  const { provider } = c.req.valid('param');
  const configError = validateProviderConfig(provider);
  if (configError) return c.json({ error: configError }, 400);
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
  requireMfa(),
  requireInvoicePush,
  zValidator('param', invoicePushParamSchema),
  zValidator('query', partnerQuerySchema),
  async (c) => {
    const { provider, invoiceId } = c.req.valid('param');
    const configError = validateProviderConfig(provider);
    if (configError) return c.json({ error: configError }, 400);
    const auth = c.get('auth');
    const partner = resolvePartnerId(auth, c.req.valid('query').partnerId);
    if ('error' in partner) return c.json({ error: partner.error }, partner.status);

    let outcome;
    try {
      outcome = await pushInvoiceToAccounting(invoiceId, partner.partnerId, (fn) => withAuthDbAccessContext(auth, fn));
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
      },
    });

    return c.json({ syncStatus: outcome.syncStatus, docNumber: outcome.docNumber, taxVarianceCents: outcome.taxVarianceCents });
  },
);

// Bulk enqueue. Same gates as the manual push route above, but this one only
// ever touches Redis (`enqueueAccountingInvoicePush` is fire-and-forget and
// never calls QuickBooks itself — the actual push happens later on the
// accounting-sync worker), so it keeps the normal ambient request
// transaction and carries NO SELF_MANAGED_DB_CONTEXT_ROUTES entry.
accountingRoutes.post(
  '/:provider/invoices/push-bulk',
  authMiddleware,
  partnerScopes,
  requireMfa(),
  requireInvoicePush,
  zValidator('param', providerParamSchema),
  zValidator('query', partnerQuerySchema),
  zValidator('json', invoicePushBulkSchema),
  async (c) => {
    const { provider } = c.req.valid('param');
    const configError = validateProviderConfig(provider);
    if (configError) return c.json({ error: configError }, 400);
    const partner = resolvePartnerId(c.get('auth'), c.req.valid('query').partnerId);
    if ('error' in partner) return c.json({ error: partner.error }, partner.status);
    const { invoiceIds } = c.req.valid('json');

    // Ownership filter: one `inArray` select rather than N per-id lookups. An
    // id that isn't this partner's (wrong partner, or doesn't exist at all)
    // is silently counted into `skipped` — this is a bulk convenience action,
    // not a per-id validation surface.
    const owned = await db
      .select({ id: invoices.id })
      .from(invoices)
      .where(and(inArray(invoices.id, invoiceIds), eq(invoices.partnerId, partner.partnerId)));
    const ownedIds = new Set(owned.map((row) => row.id));

    // `enqueued` counts jobs the queue actually ACCEPTED. It used to count
    // every owned id regardless — `enqueueAccountingInvoicePush` swallows a
    // Redis outage by design, so a total queue failure still reported "all
    // enqueued" and the operator had no signal at all. Failures now get their
    // own count and their own line in the audit record.
    let enqueued = 0;
    let failed = 0;
    let skipped = 0;
    for (const invoiceId of invoiceIds) {
      if (!ownedIds.has(invoiceId)) { skipped++; continue; }
      if (await enqueueAccountingInvoicePush(invoiceId, partner.partnerId)) enqueued++;
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
// shape as GET /:provider/customers above (no MFA/permission; see that
// route's comment for why). Makes a real outbound QuickBooks call via
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
  zValidator('param', providerParamSchema),
  zValidator('query', remoteCandidatesQuerySchema),
  async (c) => {
    const { provider } = c.req.valid('param');
    const configError = validateProviderConfig(provider);
    if (configError) return c.json({ error: configError }, 400);
    const auth = c.get('auth');
    const partner = resolvePartnerId(auth, c.req.valid('query').partnerId);
    if ('error' in partner) return c.json({ error: partner.error }, partner.status);
    const { entityType, q } = c.req.valid('query');

    try {
      const { liveConn } = await resolveConnectionAndToken(partner.partnerId, provider, (fn) => withAuthDbAccessContext(auth, fn));
      const providerImpl = getAccountingProvider(provider);
      const data = entityType === 'org'
        ? (await runOutsideDbContext(() => providerImpl.listRemoteCustomers(liveConn, q))).map((r) => ({
          id: r.id, displayName: r.displayName, email: r.email ?? null, currencyCode: r.currencyCode ?? null,
        }))
        : (await runOutsideDbContext(() => providerImpl.listRemoteItems(liveConn, q))).map((r) => ({
          id: r.id, displayName: r.displayName, sku: r.sku ?? null,
        }));
      return c.json({ data });
    } catch (err) {
      return handleMappingError(c, err);
    }
  },
);
