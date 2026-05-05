import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import {
  getActiveSecretEncryptionKeyId,
  isEncryptedSecret,
  reencryptSecret,
  shouldReencryptSecret,
} from './secretCrypto';

type EncryptedColumnKind = 'text' | 'text-array' | 'json';

export interface EncryptedColumnSpec {
  table: string;
  column: string;
  kind: EncryptedColumnKind;
  idColumn?: string;
  description: string;
}

export interface ReencryptSecretsOptions {
  dryRun?: boolean;
  batchSize?: number;
  registry?: EncryptedColumnSpec[];
  executor?: SecretReencryptionExecutor;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export interface SecretReencryptionExecutor {
  execute(query: unknown): Promise<unknown>;
}

export interface ReencryptSecretsStats {
  activeKeyId: string;
  dryRun: boolean;
  scanned: number;
  changed: number;
  updated: number;
  skippedMissingTables: string[];
  errors: Array<{ table: string; column: string; id: string; error: string }>;
}

export const encryptedColumnRegistry: EncryptedColumnSpec[] = [
  { table: 'sso_providers', column: 'client_secret', kind: 'text', description: 'OIDC client secret' },
  { table: 'user_sso_identities', column: 'access_token', kind: 'text', description: 'SSO access token' },
  { table: 'user_sso_identities', column: 'refresh_token', kind: 'text', description: 'SSO refresh token' },
  { table: 'c2c_connections', column: 'client_secret', kind: 'text', description: 'C2C OAuth client secret' },
  { table: 'c2c_connections', column: 'refresh_token', kind: 'text', description: 'C2C OAuth refresh token' },
  { table: 'c2c_connections', column: 'access_token', kind: 'text', description: 'C2C OAuth access token' },
  { table: 'webhooks', column: 'secret', kind: 'text', description: 'outbound webhook signing secret' },
  { table: 'webhooks', column: 'headers', kind: 'json', description: 'outbound webhook encrypted headers' },
  { table: 'notification_channels', column: 'config', kind: 'json', description: 'notification channel secret config' },
  { table: 'discovery_profiles', column: 'snmp_communities', kind: 'text-array', description: 'SNMP community strings' },
  { table: 'discovery_profiles', column: 'snmp_credentials', kind: 'json', description: 'SNMP credential secrets' },
  { table: 'snmp_devices', column: 'community', kind: 'text', description: 'SNMP v1/v2c community string' },
  { table: 'snmp_devices', column: 'auth_password', kind: 'text', description: 'SNMP v3 auth password' },
  { table: 'snmp_devices', column: 'priv_password', kind: 'text', description: 'SNMP v3 privacy password' },
  { table: 'automations', column: 'trigger', kind: 'json', description: 'automation webhook trigger secret' },
  { table: 'psa_connections', column: 'credentials', kind: 'json', description: 'PSA connection credentials' },
  { table: 'huntress_integrations', column: 'api_key_encrypted', kind: 'text', description: 'Huntress API key' },
  { table: 'huntress_integrations', column: 'webhook_secret_encrypted', kind: 'text', description: 'Huntress webhook secret' },
  { table: 's1_integrations', column: 'api_token_encrypted', kind: 'text', description: 'SentinelOne API token' },
  { table: 'dns_filter_integrations', column: 'api_key', kind: 'text', description: 'DNS filter API key' },
  { table: 'dns_filter_integrations', column: 'api_secret', kind: 'text', description: 'DNS filter API secret' },
  { table: 'storage_encryption_keys', column: 'encrypted_private_key', kind: 'text', description: 'backup private key material' },
  { table: 'organizations', column: 'settings', kind: 'json', description: 'organization settings with encrypted log-forwarding secrets' },
];

const SECRET_JSON_KEYS = new Set([
  'secret',
  'webhookSecret',
  'clientSecret',
  'accessToken',
  'refreshToken',
  'token',
  'apiKey',
  'apiSecret',
  'apiKeyValue',
  'authToken',
  'authPassword',
  'routingKey',
  'integrationKey',
  'webhookUrl',
  'password',
  'privateKey',
  'encrypted',
  'elasticsearchApiKey',
  'elasticsearchPassword',
  'community',
  'authPassphrase',
  'privacyPassphrase',
  'authPassword',
  'privPassword',
]);

function rowsFromResult(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Array<Record<string, unknown>> }).rows;
  }
  return [];
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function maybeReencryptString(value: string, force: boolean): string {
  if (isEncryptedSecret(value)) {
    return shouldReencryptSecret(value) ? reencryptSecret(value) ?? value : value;
  }
  if (!force) {
    return value;
  }
  return reencryptSecret(value) ?? value;
}

function transformJsonSecrets(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    if (isEncryptedSecret(value) || (key && SECRET_JSON_KEYS.has(key) && value.length > 0)) {
      return maybeReencryptString(value, Boolean(key && SECRET_JSON_KEYS.has(key)));
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => transformJsonSecrets(entry, key));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        transformJsonSecrets(entryValue, entryKey),
      ])
    );
  }

  return value;
}

export function transformEncryptedColumnValue(spec: EncryptedColumnSpec, value: unknown): unknown {
  if (spec.kind === 'text') {
    return typeof value === 'string' ? maybeReencryptString(value, true) : value;
  }

  if (spec.kind === 'text-array') {
    return Array.isArray(value)
      ? value.map((entry) => typeof entry === 'string' ? maybeReencryptString(entry, true) : entry)
      : value;
  }

  return transformJsonSecrets(value);
}

async function tableExists(executor: SecretReencryptionExecutor, table: string): Promise<boolean> {
  const rows = rowsFromResult(await executor.execute(sql`
    SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS present
  `));
  return rows[0]?.present === true;
}

async function fetchBatch(
  executor: SecretReencryptionExecutor,
  spec: EncryptedColumnSpec,
  lastId: string,
  batchSize: number,
): Promise<Array<{ id: string; value: unknown }>> {
  const idColumn = spec.idColumn ?? 'id';
  const rows = rowsFromResult(await executor.execute(sql`
    SELECT ${sql.identifier(idColumn)}::text AS id, ${sql.identifier(spec.column)} AS value
    FROM ${sql.identifier(spec.table)}
    WHERE ${sql.identifier(spec.column)} IS NOT NULL
      AND ${sql.identifier(idColumn)} > ${lastId}
    ORDER BY ${sql.identifier(idColumn)}
    LIMIT ${batchSize}
  `));

  return rows
    .filter((row) => typeof row.id === 'string')
    .map((row) => ({ id: row.id as string, value: row.value }));
}

async function updateValue(
  executor: SecretReencryptionExecutor,
  spec: EncryptedColumnSpec,
  id: string,
  value: unknown,
): Promise<void> {
  const idColumn = spec.idColumn ?? 'id';
  if (spec.kind === 'json') {
    await executor.execute(sql`
      UPDATE ${sql.identifier(spec.table)}
      SET ${sql.identifier(spec.column)} = ${JSON.stringify(value)}::jsonb
      WHERE ${sql.identifier(idColumn)} = ${id}
    `);
    return;
  }

  if (spec.kind === 'text-array') {
    await executor.execute(sql`
      UPDATE ${sql.identifier(spec.table)}
      SET ${sql.identifier(spec.column)} = ${value as string[]}::text[]
      WHERE ${sql.identifier(idColumn)} = ${id}
    `);
    return;
  }

  await executor.execute(sql`
    UPDATE ${sql.identifier(spec.table)}
    SET ${sql.identifier(spec.column)} = ${value as string}
    WHERE ${sql.identifier(idColumn)} = ${id}
  `);
}

export async function reencryptRegisteredSecrets(options: ReencryptSecretsOptions = {}): Promise<ReencryptSecretsStats> {
  const activeKeyId = getActiveSecretEncryptionKeyId();
  if (!activeKeyId) {
    throw new Error('APP_ENCRYPTION_KEY_ID is required before running registered secret re-encryption');
  }

  const executor = options.executor ?? db;
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 250, 1000));
  const dryRun = options.dryRun ?? true;
  const logger = options.logger ?? console;
  const stats: ReencryptSecretsStats = {
    activeKeyId,
    dryRun,
    scanned: 0,
    changed: 0,
    updated: 0,
    skippedMissingTables: [],
    errors: [],
  };

  const run = async () => {
    for (const spec of options.registry ?? encryptedColumnRegistry) {
      if (!(await tableExists(executor, spec.table))) {
        stats.skippedMissingTables.push(spec.table);
        logger.warn(`[secret-rotation] Skipping missing table ${spec.table}`);
        continue;
      }

      let lastId = '00000000-0000-0000-0000-000000000000';
      while (true) {
        const rows = await fetchBatch(executor, spec, lastId, batchSize);
        if (rows.length === 0) break;

        for (const row of rows) {
          lastId = row.id;
          stats.scanned++;

          try {
            const transformed = transformEncryptedColumnValue(spec, row.value);
            if (valuesEqual(transformed, row.value)) {
              continue;
            }

            stats.changed++;
            if (!dryRun) {
              await updateValue(executor, spec, row.id, transformed);
              stats.updated++;
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            stats.errors.push({ table: spec.table, column: spec.column, id: row.id, error: message });
            logger.error(`[secret-rotation] Failed ${spec.table}.${spec.column} row ${row.id}: ${message}`);
          }
        }
      }
    }
  };

  if (options.executor) {
    await run();
  } else {
    await withSystemDbAccessContext(run);
  }

  return stats;
}
