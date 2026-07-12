import { Context, Next } from 'hono';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { partners } from '../db/schema';
import { verifyToken } from '../services/jwt';
import {
  activatePendingPartnerAndInvalidateSessions,
  shouldActivatePendingPartner,
} from '../services/partnerActivation';
import { withAuthLifecycleSystemTransaction } from '../services/authLifecycle';

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
          emailVerifiedAt: partners.emailVerifiedAt,
          paymentMethodAttachedAt: partners.paymentMethodAttachedAt,
          deletedAt: partners.deletedAt,
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
    // Activation reconciliation (#718). Covers the verify-then-pay ordering:
    // the partner verified email first, then breeze-billing attached payment
    // but — through a webhook / idempotency gap — never flipped status. Both
    // preconditions are now independently met, so self-heal to `active` on
    // this request rather than stranding the tenant on the billing page
    // forever. Strictly gated on `payment_method_attached_at` (a confirmed
    // Stripe capture) AND `email_verified_at`; never time-based, and only for
    // `pending` (suspended/churned/soft-deleted are never resurrected here).
    if (shouldActivatePendingPartner(partner)) {
      try {
        const activation = await withAuthLifecycleSystemTransaction((tx) =>
          activatePendingPartnerAndInvalidateSessions(tx, partnerId!)
        );
        if (activation.activated) {
          console.warn(`[PartnerGuard] reconciled stranded pending partner ${partnerId} → active (#718)`);
          return c.json({
            error: 'Session state changed; sign in again',
            code: 'SESSION_STALE',
          }, 401);
        }
      } catch (err) {
        // Reconciliation is best-effort: if the activation write fails we fall
        // through to the normal inactive response rather than leaking through.
        // The next request retries. Fail closed.
        console.error(
          `[PartnerGuard] activation reconciliation failed for partner ${partnerId}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

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
