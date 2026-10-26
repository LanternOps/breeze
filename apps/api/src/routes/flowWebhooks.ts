/**
 * Tool Catalog W05 (#5215 / #5220) — the public flow webhook ingress.
 *
 *   POST /api/v1/webhooks/flows/:flowId
 *
 * A PUBLIC router (plan Decision 1): no session, no API key. The sender
 * authenticates with the Breeze HMAC scheme (`X-Breeze-Timestamp` +
 * `X-Breeze-Signature`) or, in token mode, `X-Breeze-Webhook-Token`; there is
 * no `?token=` (query strings land in proxy and access logs). Mounted beside
 * the other inbound webhooks, never under the authenticated `/flows` router,
 * so staying public never depends on middleware order.
 *
 * In front of it (index.ts / middleware): the `flow-webhook` bodyLimit rule
 * (262,144 B, before the handler reads the body), an isolated global
 * rate-limit bucket, and an exact-path partnerGuard exemption. The handler
 * reads the RAW body (what is authenticated and hashed), never logs request
 * headers, and answers `Cache-Control: no-store` on every outcome. Everything
 * else — flag, per-flow limiter, verification, replay protection, org
 * resolution, run creation — is services/flows/webhook/ingest.ts.
 */
import { Hono } from 'hono';
import { ingestFlowWebhook } from '../services/flows/webhook/ingest';
import { captureException } from '../services/sentry';

export const flowWebhookRoutes = new Hono();

flowWebhookRoutes.post('/:flowId', async (c) => {
  c.header('Cache-Control', 'no-store');
  const flowId = c.req.param('flowId');
  try {
    const rawBody = await c.req.text();
    const result = await ingestFlowWebhook({ flowId, rawBody, headers: c.req.raw.headers, receivedAt: new Date() });
    if (result.http === 429) c.header('Retry-After', String(result.retryAfterSec));
    return c.json(result.body, result.http);
  } catch (err) {
    // Never the headers or the body: either may carry the secret or tenant data.
    console.error(`[flows] webhook ingest failed (flow=${flowId}): ${err instanceof Error ? err.message : 'unknown error'}`);
    captureException(err instanceof Error ? err : new Error('flow webhook ingest failed'), undefined,
      { flow_site: 'flows.webhook.ingest' }, { fingerprint: ['flow', 'flows.webhook.ingest'] });
    c.header('Retry-After', '30');
    return c.json({ error: 'temporarily_unavailable' }, 503);
  }
});
