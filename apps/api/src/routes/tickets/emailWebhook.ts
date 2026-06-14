/**
 * Inbound email webhook route
 *
 * POST /api/v1/webhooks/tickets/email-inbound
 *
 * This endpoint is intentionally unauthenticated (no session auth / no JWT).
 * Security is provided exclusively by HMAC verification (provider.verify).
 * It is mounted OUTSIDE the sessionAuth middleware chain — see index.ts mount point.
 *
 * Flow:
 *   rate-limit (per source IP) → provider.verify (HMAC) → provider.parse → enqueue → 202
 *
 * Error semantics chosen for provider retry behaviour:
 *   429 — rate-limit failure: provider SHOULD retry. This also covers a Redis
 *         outage, because rateLimiter fails CLOSED (a failed limiter check returns
 *         not-allowed -> 429), so a Redis-down request never reaches the enqueue path.
 *   401 — bad HMAC: provider should NOT retry (signature is permanent)
 *   400 — parse error: provider should NOT retry (payload is malformed)
 *   503 — enqueue failure (queue add rejected): provider SHOULD retry
 *   202 — accepted for async processing
 */

import { Hono } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import { getRedis } from '../../services/redis';
import { rateLimiter } from '../../services/rate-limit';
import { getTrustedClientIp } from '../../services/clientIp';
import { MailgunInboundProvider } from '../../services/inboundEmail/mailgun';
import { enqueueInboundEmail } from '../../services/inboundEmailQueue';

export const emailWebhookRoutes = new Hono<{ Bindings: HttpBindings }>();

const provider = new MailgunInboundProvider();

// 60 requests per minute per source IP — generous to accommodate burst retries
// from the provider, strict enough to limit abuse on an unauthenticated endpoint.
const RATE_LIMIT = 60;
const RATE_WINDOW_SECONDS = 60;

emailWebhookRoutes.post('/email-inbound', async (c) => {
  // 1. Rate limit (keyed by source IP so a single abusive IP can't flood the queue)
  const ip = getTrustedClientIp(c, 'unknown');
  const rate = await rateLimiter(getRedis(), `inbound-email:${ip}`, RATE_LIMIT, RATE_WINDOW_SECONDS);
  if (!rate.allowed) {
    return c.json({ error: 'Too Many Requests' }, 429);
  }

  // 2. HMAC verify — provider.verify reads the multipart body via req.parseBody()
  //    (Hono caches the parsed body so the second call in parse() is cheap).
  const valid = await provider.verify(c.req);
  if (!valid) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // 3. Parse the verified request into a normalized email
  let parsed;
  try {
    parsed = await provider.parse(c.req);
  } catch (err) {
    return c.json({
      error: 'Bad Request',
      detail: err instanceof Error ? err.message : 'parse failed'
    }, 400);
  }

  // 4. Enqueue for async processing — return 503 if the queue add is rejected so the
  //    provider retries the webhook delivery (at-least-once semantics). Note: a full
  //    Redis outage surfaces earlier as a 429 from the fail-closed rate limiter above.
  try {
    await enqueueInboundEmail(parsed);
  } catch (err) {
    console.error('[EmailWebhook] Failed to enqueue inbound email:', err instanceof Error ? err.message : err);
    return c.json({ error: 'Service Unavailable' }, 503);
  }

  return c.json({ accepted: true }, 202);
});
