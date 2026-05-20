import { Context, Next } from 'hono';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { partners } from '../db/schema';
import { verifyToken } from '../services/jwt';

export async function partnerGuard(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return next();
  }

  const token = authHeader.slice(7);

  // Verify the JWT signature before trusting any claims
  let partnerId: string | null = null;
  try {
    const payload = await verifyToken(token);
    partnerId = payload?.partnerId ?? null;
  } catch {
    return next();
  }

  if (!partnerId) {
    return next();
  }

  let partner;
  try {
    // Run under the system RLS context. This guard fires before authMiddleware
    // has set a request-scoped context, so a bare `db` read of `partners`
    // (which has partner-axis RLS) would return 0 rows under `breeze_app`
    // and trigger PARTNER_NOT_FOUND for every authenticated request. SR-005.
    [partner] = await withSystemDbAccessContext(() =>
      db
        .select({
          status: partners.status,
          settings: partners.settings,
        })
        .from(partners)
        .where(eq(partners.id, partnerId!))
        .limit(1),
    );
  } catch (err) {
    // Fail closed: this guard is a security + billing-control boundary. A
    // verified token already proved a partnerId; if we cannot resolve that
    // partner's status we must not let the request through. SR-005.
    console.error(`[PartnerGuard] DB lookup failed for partner ${partnerId}:`, err instanceof Error ? err.message : String(err));
    return c.json({
      error: 'Account status temporarily unavailable',
      code: 'PARTNER_LOOKUP_UNAVAILABLE',
    }, 503);
  }

  if (!partner) {
    // A signature-verified token references a partner that no longer exists
    // (deleted/purged). Fail closed rather than treating it as anonymous. SR-005.
    return c.json({
      error: 'Account not found',
      code: 'PARTNER_NOT_FOUND',
    }, 403);
  }

  if (partner.status !== 'active') {
    const settings = (partner.settings ?? {}) as Record<string, unknown>;
    return c.json({
      error: 'Account inactive',
      code: 'PARTNER_INACTIVE',
      status: partner.status,
      message: (settings.statusMessage as string) ?? null,
      actionUrl: (settings.statusActionUrl as string) ?? null,
      actionLabel: (settings.statusActionLabel as string) ?? null,
    }, 403);
  }

  return next();
}
