import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { timingSafeEqual } from 'crypto';
import { db } from '../../db';
import { partners } from '../../db/schema';

const bodySchema = z.object({
  stripe_customer_id: z.string().min(1),
  payment_method_attached_at: z.string().datetime(),
});

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
      return c.json({ error: 'unauthorized' }, 401);
    }
    const provided = c.req.header('x-breeze-billing-secret') ?? '';
    if (!secretsMatch(provided, configuredSecret)) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    const partnerId = c.req.param('id');
    const { stripe_customer_id, payment_method_attached_at } = c.req.valid('json');

    // System-context update — no RLS / partnerGuard. The shared-secret check
    // above is the sole auth for this server-to-server endpoint.
    const [row] = await db
      .update(partners)
      .set({
        status: 'active',
        stripeCustomerId: stripe_customer_id,
        paymentMethodAttachedAt: new Date(payment_method_attached_at),
        updatedAt: new Date(),
      })
      .where(eq(partners.id, partnerId))
      .returning({ id: partners.id, status: partners.status });

    if (!row) return c.json({ error: 'partner_not_found' }, 404);
    return c.json({ id: row.id, status: row.status });
  },
);
