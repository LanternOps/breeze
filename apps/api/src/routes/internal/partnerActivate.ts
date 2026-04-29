import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { timingSafeEqual } from 'crypto';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { partners } from '../../db/schema';
import { captureException } from '../../services/sentry';
import { writeAuditEvent } from '../../services/auditEvents';

const bodySchema = z.object({
  stripe_customer_id: z.string().min(1),
  payment_method_attached_at: z.string().datetime(),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Constant-time string comparison — prevents timing-based enumeration of the
 * shared secret. Buffers must be equal length before calling timingSafeEqual,
 * so we pad to the longer length with a dummy value; the length check itself
 * is not secret so a short-circuit is fine there.
 */
function secretsMatch(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

// Minimal RequestLike shim for writeAuditEvent (this route has no Hono context headers)
const SYSTEM_REQUEST_SHIM = {
  req: {
    header: (_name: string) => undefined as string | undefined,
  },
};

export const partnerActivateRoute = new Hono();

partnerActivateRoute.post(
  '/internal/partners/:id/activate',
  zValidator('json', bodySchema),
  async (c) => {
    // Read at call time so the value is always current (supports tests that
    // flip the env var between cases without reloading the module).
    // Fail closed: an unset BREEZE_BILLING_CALLBACK_SECRET env var means
    // either we're on self-host (no billing service exists) or hosted is
    // misconfigured. Either way, never let a callback succeed.
    const configuredSecret = process.env.BREEZE_BILLING_CALLBACK_SECRET ?? '';
    if (!configuredSecret) {
      // eslint-disable-next-line no-console
      console.error('[partnerActivate] BREEZE_BILLING_CALLBACK_SECRET is not set — rejecting activation callback');
      return c.json({ error: 'unauthorized' }, 401);
    }
    const provided = c.req.header('x-breeze-billing-secret') ?? '';
    if (!secretsMatch(provided, configuredSecret)) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    const partnerId = c.req.param('id');

    // Validate UUID format before hitting the DB — avoids Postgres exceptions
    // on malformed input and gives a clean 400 to the caller.
    if (!UUID_RE.test(partnerId)) {
      return c.json({ error: 'invalid_partner_id' }, 400);
    }

    const { stripe_customer_id, payment_method_attached_at } = c.req.valid('json');

    // System-context update — no RLS / partnerGuard. The shared-secret check
    // above is the sole auth for this server-to-server endpoint.
    // Without withSystemDbAccessContext the UPDATE runs as breeze_app with no
    // breeze.scope GUC set; RLS on the partners table rejects the row and the
    // UPDATE matches 0 rows, returning 404 every time in production.
    let row: { id: string; status: string } | undefined;
    try {
      [row] = await runOutsideDbContext(() =>
        withSystemDbAccessContext(() =>
          db
            .update(partners)
            .set({
              status: 'active',
              stripeCustomerId: stripe_customer_id,
              paymentMethodAttachedAt: new Date(payment_method_attached_at),
              updatedAt: new Date(),
            })
            .where(eq(partners.id, partnerId))
            .returning({ id: partners.id, status: partners.status }),
        ),
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[partnerActivate] DB update failed', {
        partnerId,
        error: err instanceof Error ? err.message : String(err),
      });
      captureException(err);
      return c.json({ error: 'internal_error' }, 500);
    }

    if (!row) {
      // eslint-disable-next-line no-console
      console.warn('[partnerActivate] partner_not_found', { partnerId });
      return c.json({ error: 'partner_not_found' }, 404);
    }

    // eslint-disable-next-line no-console
    console.log('[partnerActivate] activated', { partnerId: row.id, status: row.status });

    // Audit the partner status flip so it's observable in the audit log.
    writeAuditEvent(SYSTEM_REQUEST_SHIM, {
      orgId: null,
      actorType: 'system',
      actorId: 'breeze-billing',
      action: 'partner.activated',
      resourceType: 'partner',
      resourceId: row.id,
      details: { stripe_customer_id, payment_method_attached_at },
      result: 'success',
    });

    return c.json({ id: row.id, status: row.status });
  },
);
