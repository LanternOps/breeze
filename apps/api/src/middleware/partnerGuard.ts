import { Context, Next } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { partners } from '../db/schema';
import { verifyToken } from '../services/jwt';

export async function partnerGuard(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    await next();
    return;
  }

  const token = authHeader.slice(7);

  // Verify the JWT signature before trusting any claims
  let partnerId: string | null = null;
  try {
    const payload = await verifyToken(token);
    partnerId = payload?.partnerId ?? null;
  } catch {
    await next();
    return;
  }

  if (!partnerId) {
    await next();
    return;
  }

  let partner;
  try {
    [partner] = await db
      .select({
        status: partners.status,
        settings: partners.settings,
      })
      .from(partners)
      .where(eq(partners.id, partnerId))
      .limit(1);
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

  await next();
}
