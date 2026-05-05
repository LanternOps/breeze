import { Hono } from 'hono';
import { z } from 'zod';
import { HTTPException } from 'hono/http-exception';
import { authMiddleware, requireMfa, requirePermission } from '../middleware/auth';
import { db } from '../db';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';
import { rateLimiter } from '../services/rate-limit';
import { getRedis } from '../services/redis';
import { DEFAULT_ALLOWED_ORIGINS, shouldIncludeDefaultOrigins } from '../services/corsOrigins';
import { PERMISSIONS } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';

export const externalServicesRoutes = new Hono();

// NOTE: scoped to the actual routes — `.use('*', ...)` here would attach
// the middleware to every `/api/v1/*` request via the `api.route('/', ...)`
// mount in index.ts, breaking unauth paths like /api/v1/mcp/message.
externalServicesRoutes.use('/billing/portal', authMiddleware);
externalServicesRoutes.use('/support', authMiddleware);

function externalBaseUrl(): string | null {
  return process.env.BREEZE_BILLING_URL || null;
}

async function forward(path: string, body: unknown) {
  const baseUrl = externalBaseUrl();
  if (!baseUrl) {
    return { status: 503, body: { error: 'not_configured' } as const };
  }
  let upstreamHost = '';
  try {
    upstreamHost = new URL(baseUrl).host;
  } catch {
    upstreamHost = '<invalid>';
  }
  const partnerId =
    body && typeof body === 'object' && 'partner_id' in body
      ? (body as { partner_id?: unknown }).partner_id
      : undefined;
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      console.error('[externalServices] upstream_invalid_response', {
        path,
        host: upstreamHost,
        partnerId,
        status: res.status,
        bodyExcerpt: text.slice(0, 500),
      });
      return { status: 502, body: { error: 'upstream_invalid_response' } };
    }
    if (res.status >= 400) {
      console.warn('[externalServices] Upstream returned non-2xx', {
        path,
        status: res.status,
        bodyExcerpt: text.slice(0, 500),
      });
    }
    return { status: res.status, body: json };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[externalServices] Upstream fetch failed:', {
      path,
      host: upstreamHost,
      partnerId,
      error: msg,
    });
    return { status: 502, body: { error: 'upstream_unavailable' } };
  }
}

function retryAfterSeconds(resetAt: Date): number {
  return Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));
}

function originFromUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

function getAllowedBillingReturnOrigins(): Set<string> {
  const configuredOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => originFromUrl(value.trim()))
    .filter((value): value is string => Boolean(value));

  const appOrigins = [
    originFromUrl(process.env.DASHBOARD_URL),
    originFromUrl(process.env.PUBLIC_APP_URL),
  ].filter((value): value is string => Boolean(value));

  const defaults = shouldIncludeDefaultOrigins(process.env.NODE_ENV ?? 'development')
    ? [...DEFAULT_ALLOWED_ORIGINS]
    : [];

  return new Set([...configuredOrigins, ...appOrigins, ...defaults]);
}

function isAllowedBillingReturnUrl(returnUrl: string): boolean {
  const origin = originFromUrl(returnUrl);
  if (!origin) return false;
  return getAllowedBillingReturnOrigins().has(origin);
}

const portalSchema = z.object({
  returnUrl: z.string().url().refine(isAllowedBillingReturnUrl, {
    message: 'Return URL origin is not allowed',
  }),
});

// POST /api/v1/billing/portal — returns { url } to Stripe Customer Portal,
// or 503 if billing not configured on this deployment.
externalServicesRoutes.post(
  '/billing/portal',
  requirePermission(PERMISSIONS.BILLING_MANAGE.resource, PERMISSIONS.BILLING_MANAGE.action),
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    if (!auth?.partnerId) {
      throw new HTTPException(403, { message: 'Partner context required' });
    }
    const redis = getRedis();
    const rate = await rateLimiter(
      redis,
      `billing-portal:user:${auth.user.id}`,
      10,
      3600
    );
    if (!rate.allowed) {
      return c.json(
        { error: 'rate_limited', retryAfter: retryAfterSeconds(rate.resetAt) },
        429
      );
    }
    const parsed = portalSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
    }
    const result = await forward('/portal-sessions', {
      partner_id: auth.partnerId,
      return_url: parsed.data.returnUrl,
    });

    writeRouteAudit(c, {
      orgId: null,
      action: 'billing.portal_session.create',
      resourceType: 'partner',
      resourceId: auth.partnerId,
      details: {
        upstreamStatus: result.status,
        returnUrlOrigin: originFromUrl(parsed.data.returnUrl),
      },
      result: result.status >= 400 ? 'failure' : 'success',
    });

    return c.json(result.body as Record<string, unknown>, result.status as 200 | 400 | 404 | 502 | 503);
  }
);

const supportSchema = z.object({
  subject: z.string().min(1).max(300),
  message: z.string().min(1).max(10_000),
});

// POST /api/v1/support — forwards a support email, or 503 if not configured.
externalServicesRoutes.post('/support', async (c) => {
  const auth = c.get('auth');
  if (!auth?.partnerId) {
    throw new HTTPException(403, { message: 'Partner context required' });
  }
  const redis = getRedis();
  const rate = await rateLimiter(
    redis,
    `support:user:${auth.user.id}`,
    5,
    3600
  );
  if (!rate.allowed) {
    return c.json(
      { error: 'rate_limited', retryAfter: retryAfterSeconds(rate.resetAt) },
      429
    );
  }
  const parsed = supportSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
  }
  const [user] = await db
    .select({ email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, auth.user.id))
    .limit(1);
  if (!user) {
    throw new HTTPException(404, { message: 'User not found' });
  }
  const result = await forward('/support', {
    partner_id: auth.partnerId,
    from_email: user.email,
    from_name: user.name,
    subject: parsed.data.subject,
    message: parsed.data.message,
  });
  return c.json(result.body as Record<string, unknown>, result.status as 200 | 400 | 502 | 503);
});
