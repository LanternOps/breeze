import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext } from '../../db';
import { accountingConnections } from '../../db/schema';
import { authMiddleware, requireMfa, requireScope, type AuthContext } from '../../middleware/auth';
import { QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_ENVIRONMENT, QBO_REDIRECT_URI } from '../../config/env';
import {
  deleteConnection,
  getConnection,
  upsertConnection,
} from '../../services/accounting/accountingConnectionService';
import { getAccountingProvider } from '../../services/accounting/providerRegistry';
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

interface AccountingStatePayload {
  partnerId: string;
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

function signStatePayload(encodedPayload: string): string | null {
  const secret = signingSecret();
  if (!secret) return null;
  return createHmac('sha256', secret).update(`accounting-oauth:${encodedPayload}`).digest('base64url');
}

function createState(partnerId: string): string | null {
  const payload: AccountingStatePayload = {
    partnerId,
    nonce: randomBytes(16).toString('hex'),
    exp: Date.now() + 10 * 60 * 1000,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = signStatePayload(encoded);
  return sig ? `${encoded}.${sig}` : null;
}

function verifyState(state: string): AccountingStatePayload | null {
  const [encoded, sig] = state.split('.');
  if (!encoded || !sig) return null;
  const expected = signStatePayload(encoded);
  if (!expected) return null;
  const left = Buffer.from(sig, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as AccountingStatePayload;
    if (!parsed.partnerId || !parsed.nonce || !parsed.exp || parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
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

accountingRoutes.use('*', authMiddleware);

accountingRoutes.get('/:provider/connect', partnerScopes, zValidator('param', providerParamSchema), zValidator('query', partnerQuerySchema), async (c) => {
  const { provider } = c.req.valid('param');
  const configError = validateProviderConfig(provider);
  if (configError) return c.json({ error: configError }, 400);
  const partner = resolvePartnerId(c.get('auth'), c.req.valid('query').partnerId);
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);

  const state = createState(partner.partnerId);
  if (!state) return c.json({ error: 'OAuth state signing secret is not configured' }, 500);
  const authUrl = getAccountingProvider(provider).buildAuthUrl(state);
  return c.json({ authUrl });
});

accountingRoutes.get('/:provider/callback', partnerScopes, requireMfa(), zValidator('param', providerParamSchema), zValidator('query', callbackQuerySchema), async (c) => {
  const { provider } = c.req.valid('param');
  const query = c.req.valid('query');
  const configError = validateProviderConfig(provider);
  if (configError) return c.json({ error: configError }, 400);

  const state = verifyState(query.state);
  if (!state) return c.json({ error: 'Invalid or expired OAuth state' }, 400);
  const partner = resolvePartnerId(c.get('auth'), state.partnerId);
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  if (partner.partnerId !== state.partnerId) return c.json({ error: 'OAuth state partner mismatch' }, 403);

  const providerClient = getAccountingProvider(provider);
  const tokens = await runOutsideDbContext(() => providerClient.exchangeCode(query.code, query.realmId));
  await upsertConnection(db, partner.partnerId, provider, {
    realmId: tokens.realmId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
    environment: QBO_ENVIRONMENT as 'sandbox' | 'production',
    status: 'connected',
    lastError: null,
    connectedBy: c.get('auth').user.id,
  });

  return c.redirect('/integrations?accounting=quickbooks&connected=1');
});

accountingRoutes.post('/:provider/disconnect', partnerScopes, requireMfa(), zValidator('param', providerParamSchema), zValidator('query', partnerQuerySchema), async (c) => {
  const { provider } = c.req.valid('param');
  const partner = resolvePartnerId(c.get('auth'), c.req.valid('query').partnerId);
  if ('error' in partner) return c.json({ error: partner.error }, partner.status);
  await deleteConnection(db, partner.partnerId, provider);
  return c.json({ disconnected: true });
});

accountingRoutes.get('/:provider', partnerScopes, zValidator('param', providerParamSchema), zValidator('query', partnerQuerySchema), async (c) => {
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

accountingRoutes.patch('/:provider/settings', partnerScopes, requireMfa(), zValidator('param', providerParamSchema), zValidator('query', partnerQuerySchema), zValidator('json', settingsSchema), async (c) => {
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
