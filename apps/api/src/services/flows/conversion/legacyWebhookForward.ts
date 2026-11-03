/**
 * Tool Catalog W06 (#5221) Task B6 — the legacy webhook URL of a SWITCHED Job.
 *
 * Senders keep `POST /api/v1/automations/webhooks/:id` until standalone
 * admission is retired (plan Decision 8). Once the Job's generation is
 * switched, the legacy route hands the delivery to the flow's ingest
 * (`ingestFlowWebhook`) BEFORE any legacy verification or Redis replay write:
 *
 *  - the raw body is read once and passed on unchanged (the HMAC covers the
 *    bytes), with the other headers;
 *  - the delivery id legacy reads (`x-breeze-event-id`, else
 *    `x-breeze-nonce`) becomes `X-Breeze-Delivery-Id` when the flow can carry
 *    it, replacing any the sender set, so the flow's `webhook:dlv:` alias is
 *    exactly the one legacy claimed for the same request (webhookOccurrence);
 *  - flow ingest verifies the carried legacy secret (B3), answers its uniform
 *    401 to a plain-secret header (the legacy plain-secret path is never taken
 *    for a switched row) and to a `?secret=` query (legacy refused that
 *    unconditionally), and claims both aliases inside `createFlowRun` (B2), so
 *    a delivery legacy admitted before the switch is a duplicate here.
 *
 * DB context: the legacy webhook route is public and self-managed (no ambient
 * context). The switched-row read is one read-only system lookup, like the
 * route's own; ingest opens its own contexts. Nothing here runs inside the
 * route's owner-context transaction, which it reaches only on `null`.
 * The response mirrors routes/flowWebhooks.ts (no-store, Retry-After, 503).
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { FLOW_WEBHOOK_HEADERS } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../../db';
import { getTrustedClientIp } from '../../clientIp';
import { captureException } from '../../sentry';
import { ingestFlowWebhook } from '../webhook/ingest';
import { legacyWebhookDeliveryIdHeader, webhookDeliveryIdFor } from './webhookOccurrence';

/**
 * The flow a switched webhook Job forwards to, or null. The row shape is the
 * one the switch leaves (`switchedConvertedAutomationCondition`), its live
 * generation is switched and names that flow, and the Job was a webhook Job
 * (a switched schedule/event Job's old URL keeps legacy's 404).
 */
async function switchedWebhookFlowFor(automationId: string): Promise<string | null> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const rows = (await db.execute(sql`
      SELECT fac.flow_id
      FROM automations a
      JOIN flow_automation_conversions fac
        ON fac.automation_id = a.id AND fac.state = 'switched' AND fac.flow_id = a.converted_to_flow_id
      WHERE a.id = ${automationId}
        AND a.enabled = false
        AND a.retired_reason = 'converted_to_flow'
        AND a.trigger->>'type' = 'webhook'
      LIMIT 1`)) as unknown as Array<{ flow_id: string }>;
    return rows[0]?.flow_id ?? null;
  }, 'automations.webhook.forward'));
}

/** The forwarded headers: a copy, with `X-Breeze-Delivery-Id` set from the legacy header (or removed). */
export function forwardedWebhookHeaders(incoming: Headers): Headers {
  const headers = new Headers(incoming);
  headers.delete(FLOW_WEBHOOK_HEADERS.deliveryId);
  const id = webhookDeliveryIdFor(legacyWebhookDeliveryIdHeader((name) => incoming.get(name) ?? undefined));
  if (id) headers.set(FLOW_WEBHOOK_HEADERS.deliveryId, id);
  return headers;
}

/**
 * The flow ingest's answer for a switched webhook Job, or null when the row
 * has no switched generation (legacy then continues, and claims when the row
 * has a conversion in any state).
 */
export async function forwardLegacyWebhook(c: Context, automationId: string): Promise<Response | null> {
  const flowId = await switchedWebhookFlowFor(automationId);
  if (!flowId) return null;

  c.header('Cache-Control', 'no-store');
  if (c.req.query('secret')) return c.json({ error: 'Unauthorized' }, 401);
  try {
    const rawBody = await c.req.text();
    const result = await ingestFlowWebhook({
      flowId,
      rawBody,
      headers: forwardedWebhookHeaders(c.req.raw.headers),
      receivedAt: new Date(),
      clientIp: getTrustedClientIp(c),
    });
    if (result.http === 429) c.header('Retry-After', String(result.retryAfterSec));
    return c.json(result.body, result.http);
  } catch (err) {
    // Never the headers or the body: either may carry the secret or tenant data.
    console.error(`[flows] legacy webhook forward failed (automation=${automationId}, flow=${flowId}): ${err instanceof Error ? err.message : 'unknown error'}`);
    captureException(err instanceof Error ? err : new Error('legacy webhook forward failed'), undefined,
      { flow_site: 'flows.webhook.legacy_forward', flow_id: flowId, automation_id: automationId },
      { fingerprint: ['flow', 'flows.webhook.legacy_forward'] });
    c.header('Retry-After', '30');
    return c.json({ error: 'temporarily_unavailable' }, 503);
  }
}
