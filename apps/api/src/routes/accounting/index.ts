import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { zValidator } from '../../lib/validation';
import { z } from 'zod';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { accountingConnections } from '../../db/schema';
import { authMiddleware, requireMfa, requireScope, type AuthContext } from '../../middleware/auth';
import { QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_ENVIRONMENT, QBO_REDIRECT_URI } from '../../config/env';
import {
  deleteConnection,
  getConnection,
  upsertConnection,
} from '../../services/accounting/accountingConnectionService';
import {
  importQuickbooksCustomers,
  listQuickbooksCustomersAnnotated,
  QbImportError,
} from '../../services/accounting/quickbooksCustomerImport';
import { writeRouteAudit } from '../../services/auditEvents';
import { getAccountingProvider } from '../../services/accounting/providerRegistry';
import { captureException } from '../../services/sentry';
import type { AccountingProviderId } from '../../services/accounting/types';

export const accountingRoutes = new Hono();

const partnerScopes = requireScope('partner', 'system');
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
}).refine((value) => Object.keys(value).length > 0, {
  message: 'At least one setting is required',
});
const importCustomersSchema = z.object({
  customerIds: z.array(z.string().min(1)).min(1).max(500),
});

function handleImportError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  // QbImportError.status is a narrowed literal union (400|404|409|502), so no cast.
  if (err instanceof QbImportError) return c.json({ error: err.message, code: err.code }, err.status);
  throw err;
}

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
  try {
    await withSystemDbAccessContext(() => upsertConnection(db, state.partnerId, provider, {
      realmId: tokens.realmId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      environment: QBO_ENVIRONMENT as 'sandbox' | 'production',
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
  });
});

// List remote QuickBooks customers, annotated with whether each is already
// imported. Read-only but partner-privileged, so partner/system scope.
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
accountingRoutes.post('/:provider/customers/import', authMiddleware, partnerScopes, requireMfa(), zValidator('param', providerParamSchema), zValidator('query', partnerQuerySchema), zValidator('json', importCustomersSchema), async (c) => {
  const { provider } = c.req.valid('param');
  const configError = validateProviderConfig(provider);
  if (configError) return c.json({ error: configError }, 400);
  const partner = resolvePartnerId(c.get('auth'), c.req.valid('query').partnerId);
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);

  let summary;
  try {
    summary = await importQuickbooksCustomers({ partnerId: partner.partnerId, customerIds: c.req.valid('json').customerIds });
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

accountingRoutes.patch('/:provider/settings', authMiddleware, partnerScopes, requireMfa(), zValidator('param', providerParamSchema), zValidator('query', partnerQuerySchema), zValidator('json', settingsSchema), async (c) => {
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
    });

  if (!updated) return c.json({ error: 'Accounting connection not found' }, 404);
  return c.json(updated);
});
