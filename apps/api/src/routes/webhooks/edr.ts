// apps/api/src/routes/webhooks/edr.ts
//
// EDR vendor push webhook (EDR W03 PR-B, #8167; spec §4.8).
//
// POST /api/v1/webhooks/edr/:connectionId
//
// Intentionally unauthenticated by session: the ONLY credential is the
// per-connection shared secret Breeze generated at push opt-in and registered
// with the vendor, which the vendor echoes in `Authorization`. Mounted outside
// the /edr router (whose authMiddleware covers `*`) and exempt from partnerGuard
// by exact uuid path, so a bearer-shaped secret is never treated as a JWT.
//
// A push is a HINT, never data: the only thing persisted is the connection's
// `pending_hint_at` timestamp plus opaque vendor ids in a bounded Redis set
// (services/edrProviders/hints.ts). It never writes a detection, never calls a
// vendor, never triggers a response action. A forged-but-authenticated push can
// at worst cause one extra read sync.
//
// Order (each step tested in edr.test.ts):
//   1. :connectionId not a uuid                                  -> 404 (route shape not confirmed)
//   2. per-connection Redis limit, BEFORE any DB read           -> 429 (fails closed without Redis)
//   3. raw body (the global gate caps this path at 256 KB)
//   4. connection missing / inactive / push off / no verifier   -> uniform 404
//   5. no stored secret or it does not decrypt (row-bound AAD)  -> 403
//   6. adapter.verifyWebhook fails                              -> 401, uniform body
//   7. record the hint outside any DB context, enqueue one detections sync -> 202 { accepted: true }
//
// The body is never echoed in a response and never logged. NOT in
// SELF_MANAGED_DB_CONTEXT_ROUTES: there is no ambient auth transaction on an
// unauthenticated route; the lookup runs in its own short system context.
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { edrConnections } from '../../db/schema';
import { rateLimiter } from '../../services/rate-limit';
import { getRedis } from '../../services/redis';
import { decryptEdrSecret } from '../../services/edrProviders/credentials';
import { getEdrProvider } from '../../services/edrProviders/registry';
import { recordEdrHint } from '../../services/edrProviders/hints';
import type { EdrProviderAdapter } from '../../services/edrProviders/types';
import { enqueueEdrSync } from '../../jobs/edrProviderSync';

export const edrWebhookRoutes = new Hono();

/** Per connection, per minute. GravityZone batches events, so a real console sends far fewer. */
export const EDR_WEBHOOK_RATE_LIMIT = 60;
const RATE_WINDOW_SECONDS = 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NOT_FOUND = { error: 'Not found' } as const;

function adapterFor(provider: string): EdrProviderAdapter | null {
  try {
    return getEdrProvider(provider);
  } catch {
    return null;
  }
}

edrWebhookRoutes.post('/edr/:connectionId', async (c) => {
  const raw = c.req.param('connectionId');
  if (!UUID_RE.test(raw)) return c.json(NOT_FOUND, 404);
  const connectionId = raw.toLowerCase();

  const rate = await rateLimiter(getRedis(), `edr-webhook:${connectionId}`, EDR_WEBHOOK_RATE_LIMIT, RATE_WINDOW_SECONDS);
  if (!rate.allowed) {
    const retryAfter = Math.max(1, Math.ceil((rate.resetAt.getTime() - Date.now()) / 1000));
    c.header('Retry-After', String(retryAfter));
    return c.json({ error: 'Too many requests' }, 429);
  }

  const body = await c.req.text();

  const [row] = await withSystemDbAccessContext(() => db
    .select({
      id: edrConnections.id,
      provider: edrConnections.provider,
      isActive: edrConnections.isActive,
      pushEnabled: edrConnections.pushEnabled,
      webhookSecretEncrypted: edrConnections.webhookSecretEncrypted,
    })
    .from(edrConnections)
    .where(eq(edrConnections.id, connectionId))
    .limit(1), 'edrWebhook.lookup');
  const adapter = row ? adapterFor(row.provider) : null;
  if (!row || !row.isActive || !row.pushEnabled || !adapter?.verifyWebhook) return c.json(NOT_FOUND, 404);

  if (!row.webhookSecretEncrypted) return c.json({ error: 'Forbidden' }, 403);
  let secret: string;
  try {
    const plain = decryptEdrSecret('connection_webhook_secret', row.id, row.webhookSecretEncrypted);
    if (typeof plain !== 'string' || plain.length === 0) return c.json({ error: 'Forbidden' }, 403);
    secret = plain;
  } catch {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const verdict = adapter.verifyWebhook({ headers: c.req.header(), body }, secret);
  if (!verdict.ok) return c.json({ error: 'Unauthorized' }, 401);

  let recorded: boolean;
  try {
    recorded = await runOutsideDbContext(() => recordEdrHint(row.id, verdict.hints, getRedis()));
  } catch (error) {
    // Message only: never the body, never the secret.
    console.error(`[edrWebhook] failed to record a push hint for ${row.id}:`, error instanceof Error ? error.message : 'unknown error');
    return c.json({ error: 'Temporarily unavailable' }, 503);
  }
  if (!recorded) return c.json(NOT_FOUND, 404);

  try {
    await runOutsideDbContext(() => enqueueEdrSync(row.id, 'detections'));
  } catch (error) {
    // The marker is durable: the next sync-all tick treats the connection as due.
    console.error(`[edrWebhook] detections enqueue failed for ${row.id} (marker kept):`, error instanceof Error ? error.message : 'unknown error');
  }
  return c.json({ accepted: true }, 202);
});
