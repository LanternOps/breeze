import { createHash } from 'crypto';
import { db } from '../db';
import { organizations } from '../db/schema';
import { eq } from 'drizzle-orm';
import { decryptForColumn } from './secretCrypto';
import { captureException } from './sentry';
import { safeFetch, SsrfBlockedError } from './urlSafety';

interface LogForwardingConfig {
  enabled: boolean;
  // Field names are retained from the original Elasticsearch-only design to
  // avoid a settings-JSONB migration. The transport below speaks the plain
  // Elasticsearch/OpenSearch `_bulk` wire protocol over HTTP, so any
  // compatible sink works (Elasticsearch, OpenSearch, the Wazuh indexer,
  // AWS OpenSearch Service, etc.).
  elasticsearchUrl: string;
  elasticsearchApiKey?: string;
  elasticsearchUsername?: string;
  elasticsearchPassword?: string;
  indexPrefix: string;
}

interface EventLogDocument {
  deviceId: string;
  orgId: string;
  hostname: string;
  category: string;
  level: string;
  source: string;
  message: string;
  timestamp: string;
  details?: unknown;
}

interface BulkResult {
  indexed: number;
  errors: number;
}

export async function getOrgForwardingConfig(orgId: string): Promise<LogForwardingConfig | null> {
  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!org) return null;

  const settings = (org.settings as Record<string, unknown>) ?? {};
  const forwarding = settings.logForwarding as LogForwardingConfig | undefined;

  if (!forwarding?.enabled || !forwarding.elasticsearchUrl) return null;
  return {
    ...forwarding,
    // Sub-fields of organizations.settings JSON column; AAD binds at the
    // column level to match transformEncryptedColumnValue's walker output.
    elasticsearchApiKey: decryptForColumn('organizations', 'settings', forwarding.elasticsearchApiKey) ?? undefined,
    elasticsearchPassword: decryptForColumn('organizations', 'settings', forwarding.elasticsearchPassword) ?? undefined,
  };
}

function buildAuthHeader(config: LogForwardingConfig): string | undefined {
  if (config.elasticsearchApiKey) {
    return `ApiKey ${config.elasticsearchApiKey}`;
  }
  if (config.elasticsearchUsername && config.elasticsearchPassword) {
    const creds = Buffer.from(`${config.elasticsearchUsername}:${config.elasticsearchPassword}`).toString('base64');
    return `Basic ${creds}`;
  }
  return undefined;
}

// Deterministic document id derived from the FULL document content. Makes
// indexing idempotent: re-sending a batch (full-batch or item-level retry)
// overwrites rather than duplicating, so retries are safe. Only byte-identical
// events collapse — hashing every field (not a subset) avoids silently dropping
// events that differ only in level/details, and serializing avoids the
// separator-collision risk of joining fields with a delimiter.
function docId(doc: EventLogDocument): string {
  return createHash('sha256').update(JSON.stringify(doc)).digest('hex');
}

function buildBulkBody(indexName: string, events: EventLogDocument[]): string {
  // Elasticsearch/OpenSearch bulk format: an action line followed by a source
  // line per document, NDJSON, with a mandatory trailing newline.
  return (
    events
      .flatMap((doc) => [
        JSON.stringify({ index: { _index: indexName, _id: docId(doc) } }),
        JSON.stringify(doc),
      ])
      .join('\n') + '\n'
  );
}

// 429 (rate limited) and 5xx (server/gateway) are transient — throwing lets
// the BullMQ worker retry with backoff, matching the old @elastic client which
// threw on non-2xx. Other 4xx (400/401/403/404) are terminal misconfiguration:
// retrying every batch 5x won't help, so we drop and surface to Sentry instead.
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Ship a batch of event documents to any Elasticsearch/OpenSearch-compatible
 * `_bulk` endpoint. Uses `safeFetch` (not the `@elastic/elasticsearch` client)
 * so non-Elastic sinks (OpenSearch, the Wazuh indexer) are not rejected by the
 * client's product check, and so the tenant-controlled URL is SSRF-guarded with
 * connect-time IP pinning (a DNS rebind cannot redirect us to an internal host).
 *
 * Throws on transient failures (transport errors, 429, 5xx, retryable per-item
 * errors) so the BullMQ worker retries; returns a counted result for
 * terminal/partial outcomes. Indexing is idempotent (deterministic `_id`), so a
 * batch retry never duplicates documents.
 */
export async function bulkIndexToEndpoint(
  config: LogForwardingConfig,
  events: EventLogDocument[],
  orgId?: string,
): Promise<BulkResult> {
  if (events.length === 0) return { indexed: 0, errors: 0 };

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
  const indexName = `${config.indexPrefix}-${today}`;
  const url = `${config.elasticsearchUrl.replace(/\/+$/, '')}/_bulk`;
  const orgSuffix = orgId ? ` org=${orgId}` : '';

  const headers: Record<string, string> = { 'content-type': 'application/x-ndjson' };
  const auth = buildAuthHeader(config);
  if (auth) headers.authorization = auth;

  let response: Response;
  try {
    response = await safeFetch(url, {
      method: 'POST',
      headers,
      body: buildBulkBody(indexName, events),
      timeoutMs: 30_000,
    });
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      // Target resolves to an internal/blocked address — terminal, not worth
      // retrying. Surface it so the misconfiguration (or attack) is visible.
      const message = `[logForwarding] Bulk target blocked by SSRF guard${orgSuffix}: ${err.message}`;
      console.error(message);
      captureException(err);
      return { indexed: 0, errors: events.length };
    }
    // Transport/TLS/timeout — transient, propagate so the worker retries.
    throw err;
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const message = `[logForwarding] Bulk request failed: HTTP ${response.status}${orgSuffix} ${detail.slice(0, 200)}`;
    if (isRetryableStatus(response.status)) {
      throw new Error(message);
    }
    // Terminal: drop the batch but make the misconfiguration visible.
    console.error(message);
    captureException(new Error(message));
    return { indexed: 0, errors: events.length };
  }

  // Some compatible sinks/proxies return 200 with an empty or non-JSON body.
  // The server accepted the batch, so treat it as indexed rather than throwing
  // (which would retry and risk wasted re-sends).
  let result: { errors?: boolean; items?: Array<{ index?: { status?: number; error?: unknown } }> };
  try {
    result = await response.json();
  } catch {
    // 2xx but unparseable body (e.g. a proxy ack page). The server reported
    // success, so assume indexed — but surface it so a misbehaving proxy in
    // front of the sink is visible rather than silently masking dropped logs.
    console.warn(`[logForwarding] sink returned HTTP ${response.status} with a non-JSON body${orgSuffix}; assuming indexed`);
    return { indexed: events.length, errors: 0 };
  }

  if (!result.errors || !Array.isArray(result.items)) {
    return { indexed: events.length, errors: 0 };
  }

  const failed = result.items.filter((item) => item.index?.error);
  const retryable = failed.filter((item) => {
    const status = item.index?.status;
    return typeof status === 'number' && isRetryableStatus(status);
  });

  if (retryable.length > 0) {
    // Some docs hit transient backpressure (429 / es_rejected_execution_exception
    // / 5xx). The deterministic _id makes a whole-batch retry idempotent, so
    // throw to let BullMQ retry with backoff without creating duplicates.
    throw new Error(
      `[logForwarding] ${retryable.length}/${failed.length} bulk items retryable${orgSuffix}; retrying batch`,
    );
  }

  // Only terminal (poison) docs failed — they will never succeed, so drop them
  // but surface a sample so the mapping/format issue is debuggable.
  const sample = failed.slice(0, 3).map((item) => item.index?.error);
  console.error(`[logForwarding] ${failed.length} bulk items permanently rejected${orgSuffix}`, sample);
  captureException(
    new Error(`[logForwarding] ${failed.length} bulk items permanently rejected${orgSuffix}`),
  );

  return { indexed: events.length - failed.length, errors: failed.length };
}

export async function bulkIndexEvents(orgId: string, events: EventLogDocument[]): Promise<BulkResult> {
  const config = await getOrgForwardingConfig(orgId);
  if (!config) return { indexed: 0, errors: 0 };
  return bulkIndexToEndpoint(config, events, orgId);
}

/**
 * Retained for API compatibility with the worker shutdown path. The HTTP
 * transport keeps no per-org client/connection state (undici pools globally),
 * so there is nothing to clear.
 */
export function clearClientCache(): void {
  // no-op
}
