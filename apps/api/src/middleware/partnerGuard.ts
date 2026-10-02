import { Context, Next } from 'hono';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { partners } from '../db/schema';
import { verifyToken } from '../services/jwt';
import { shouldActivatePendingPartner, activatePartnerRow } from '../services/partnerActivation';

const SIGNED_WEBHOOK_PATHS: ReadonlySet<string> = new Set([
  '/api/v1/webhooks/xero',
  '/api/v1/webhooks/quickbooks',
]);

/**
 * Paths the global partner-status guard skips (mounted in index.ts). They must
 * stay reachable while the partner is not `active`: sign-in and MFA enrollment
 * (/auth/*), public config, the caller's own profile, the caller's own partner
 * status (read by the account-inactive screen), agent traffic, the
 * self-gated synthetic router, and the exact-path Xero and QuickBooks
 * webhooks (signature-authenticated, no partner acted for). Adding a path here lets an inactive tenant use
 * it — keep the list minimal.
 */
export function isPartnerGuardExemptPath(path: string): boolean {
  if (path.startsWith('/api/v1/auth')) return true;
  if (path === '/api/v1/config' || path === '/api/v1/config/') return true;
  if (path.startsWith('/api/v1/users/me')) return true;
  if (path === '/api/v1/partner/me' || path.startsWith('/api/v1/partner/me/')) return true;
  if (path.startsWith('/api/v1/agents/')) return true;
  if (path.startsWith('/api/v1/internal/synthetic/')) return true;   // synthetic test router — self-gated (token + canary latch)
  // Signature-authenticated, unauthenticated webhooks (Xero W05 quorum finding
  // 10; QuickBooks #7296). partnerGuard must not verify a bearer token, read
  // `partners` or activate a partner on these paths BEFORE the route has
  // checked its HMAC. Exact match only; no partner is ever acted for here.
  if (SIGNED_WEBHOOK_PATHS.has(path)) return true;
  // Public token GETs must never trigger staff account activation.
  if (path.startsWith('/api/v1/autopay/public/')) return true;
  return false;
}

/**
 * The middleware mounted globally in index.ts: skips exempt paths, otherwise
 * runs partnerGuard. Must `return` the promise so guard Responses propagate.
 */
export function partnerGuardWithExemptions(c: Context, next: Next) {
  if (isPartnerGuardExemptPath(c.req.path)) return next();
  return partnerGuard(c, next);
}

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
          trustState: partners.trustState,
          settings: partners.settings,
          emailVerifiedAt: partners.emailVerifiedAt,
          paymentMethodAttachedAt: partners.paymentMethodAttachedAt,
          billingSubscriptionStatus: partners.billingSubscriptionStatus,
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
        await withSystemDbAccessContext(() => activatePartnerRow(db, partnerId!));
        console.warn(`[PartnerGuard] reconciled stranded pending partner ${partnerId} → active (#718)`);
        c.set('trustState', partner.trustState);
        return next();
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

  c.set('trustState', partner.trustState);
  return next();
}
