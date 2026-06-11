import { db } from '../db';
import { organizations } from '../db/schema';
import { eq } from 'drizzle-orm';
import { decryptForColumn } from './secretCrypto';

interface LogForwardingConfig {
  enabled: boolean;
  // Field names are retained from the original Elasticsearch-only design to
  // avoid a settings-JSONB migration. The transport below speaks the plain
  // Elasticsearch/OpenSearch `_bulk` wire protocol over HTTP, so any
  // compatible sink works (Elasticsearch, OpenSearch, the Wazuh indexer,
  // Graylog, AWS OpenSearch Service, etc.).
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
  rawData?: unknown;
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

function buildBulkBody(indexName: string, events: EventLogDocument[]): string {
  // Elasticsearch/OpenSearch bulk format: an action line followed by a source
  // line per document, NDJSON, with a mandatory trailing newline.
  return (
    events
      .flatMap((doc) => [JSON.stringify({ index: { _index: indexName } }), JSON.stringify(doc)])
      .join('\n') + '\n'
  );
}

/**
 * Ship a batch of event documents to any Elasticsearch/OpenSearch-compatible
 * `_bulk` endpoint over plain HTTP. Uses fetch rather than the official
 * `@elastic/elasticsearch` client so non-Elastic sinks (OpenSearch, the Wazuh
 * indexer, Graylog) are not rejected by the client's product check.
 */
export async function bulkIndexToEndpoint(
  config: LogForwardingConfig,
  events: EventLogDocument[],
): Promise<BulkResult> {
  if (events.length === 0) return { indexed: 0, errors: 0 };

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
  const indexName = `${config.indexPrefix}-${today}`;
  const url = `${config.elasticsearchUrl.replace(/\/+$/, '')}/_bulk`;

  const headers: Record<string, string> = { 'content-type': 'application/x-ndjson' };
  const auth = buildAuthHeader(config);
  if (auth) headers.authorization = auth;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: buildBulkBody(indexName, events),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    console.error(
      `[logForwarding] Bulk request failed: HTTP ${response.status} ${detail.slice(0, 200)}`,
    );
    return { indexed: 0, errors: events.length };
  }

  const result = (await response.json()) as {
    errors?: boolean;
    items?: Array<{ index?: { error?: unknown } }>;
  };

  let errors = 0;
  if (result.errors && Array.isArray(result.items)) {
    errors = result.items.filter((item) => item.index?.error).length;
    console.error(`[logForwarding] Bulk index had ${errors} errors`);
  }

  return { indexed: events.length - errors, errors };
}

export async function bulkIndexEvents(orgId: string, events: EventLogDocument[]): Promise<BulkResult> {
  const config = await getOrgForwardingConfig(orgId);
  if (!config) return { indexed: 0, errors: 0 };
  return bulkIndexToEndpoint(config, events);
}

/**
 * Retained for API compatibility with the worker shutdown path. The HTTP
 * transport keeps no per-org client/connection state (undici pools globally),
 * so there is nothing to clear.
 */
export function clearClientCache(): void {
  // no-op
}
