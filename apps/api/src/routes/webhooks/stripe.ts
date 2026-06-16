// apps/api/src/routes/webhooks/stripe.ts
import { Hono } from 'hono';
import { getTrustedClientIp } from '../../services/clientIp'; // match the helper used by emailWebhook
import { rateLimiter } from '../../services/rate-limit';
import { getRedis } from '../../services/redis';
import { verifyStripeEvent, handleStripeEvent } from '../../services/stripeWebhook';
import { captureException } from '../../services/sentry';

export const stripeWebhookRoutes = new Hono();

const RATE_LIMIT = 240;
const RATE_WINDOW_SECONDS = 60;

stripeWebhookRoutes.post('/stripe/connect', async (c) => {
  const ip = getTrustedClientIp(c, 'unknown');
  const rate = await rateLimiter(getRedis(), `stripe-webhook:${ip}`, RATE_LIMIT, RATE_WINDOW_SECONDS);
  if (!rate.allowed) return c.json({ error: 'Too Many Requests' }, 429);

  const sig = c.req.header('stripe-signature');
  const raw = await c.req.text(); // raw body required for signature verification
  if (!sig) return c.json({ error: 'Missing signature' }, 400);

  let event;
  try {
    event = verifyStripeEvent(raw, sig);
  } catch {
    return c.json({ error: 'Invalid signature' }, 400);
  }

  try {
    await handleStripeEvent(event);
  } catch (err) {
    console.error('[stripeWebhook] handler error', event.type, err instanceof Error ? err.message : String(err));
    // A money-moving webhook failed to reconcile — surface to Sentry (with a
    // breadcrumb-ish error) so the retry storm doesn't silently bury a real bug.
    captureException(err instanceof Error ? err : new Error(`[stripeWebhook] handler error for ${event.type}: ${String(err)}`), c);
    // Return 500 so Stripe retries on transient errors; idempotency makes retries safe.
    return c.json({ error: 'Handler error' }, 500);
  }
  return c.json({ received: true }, 202);
});
