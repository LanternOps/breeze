import { Client } from '@elastic/elasticsearch';
import { db } from '../db';
import { organizations } from '../db/schema';
import { eq } from 'drizzle-orm';

interface LogForwardingConfig {
  enabled: boolean;
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

// Per-org ES client cache (avoid creating new client per request)
const clientCache = new Map<string, { client: Client; config: LogForwardingConfig; cachedAt: number }>();
const CLIENT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

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
  return forwarding;
}

function getOrCreateClient(orgId: string, config: LogForwardingConfig): Client {
  const cached = clientCache.get(orgId);
  if (cached && Date.now() - cached.cachedAt < CLIENT_CACHE_TTL) {
    return cached.client;
  }

  const clientOpts: Record<string, unknown> = {
    node: config.elasticsearchUrl,
  };

  if (config.elasticsearchApiKey) {
    clientOpts.auth = { apiKey: config.elasticsearchApiKey };
  } else if (config.elasticsearchUsername && config.elasticsearchPassword) {
    clientOpts.auth = {
      username: config.elasticsearchUsername,
      password: config.elasticsearchPassword,
    };
  }

  const client = new Client(clientOpts as any);
  clientCache.set(orgId, { client, config, cachedAt: Date.now() });
  return client;
}

export async function bulkIndexEvents(
  orgId: string,
  events: EventLogDocument[],
): Promise<{ indexed: number; errors: number }> {
  const config = await getOrgForwardingConfig(orgId);
  if (!config) return { indexed: 0, errors: 0 };

  const client = getOrCreateClient(orgId, config);
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
  const indexName = `${config.indexPrefix}-${today}`;

  const operations = events.flatMap((doc) => [
    { index: { _index: indexName } },
    doc,
  ]);

  const result = await client.bulk({ operations, refresh: false });

  let errors = 0;
  if (result.errors) {
    errors = result.items.filter((item) => item.index?.error).length;
    console.error(`[logForwarding] Bulk index had ${errors} errors for org ${orgId}`);
  }

  return { indexed: events.length - errors, errors };
}

export function clearClientCache(): void {
  for (const [, entry] of clientCache) {
    entry.client.close().catch(() => {});
  }
  clientCache.clear();
}
