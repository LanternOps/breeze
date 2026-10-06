import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { getActiveSecretEncryptionKeyId } from './secretCrypto';
import { BACKUP_PROVIDER_CONFIG_COLUMN } from './backupProviderConfigSealing';
import {
  isSecretJsonPath,
  transformEncryptedColumnValue,
  type EncryptedColumnSpec,
} from './encryptedColumnTransform';

export {
  columnAad,
  isSecretJsonPath,
  transformEncryptedColumnValue,
  type EncryptedColumnSpec,
} from './encryptedColumnTransform';

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
  /** Rows changed by a concurrent write between read and re-seal; not written. */
  contended: number;
  skippedMissingTables: string[];
  errors: Array<{ table: string; column: string; id: string; error: string }>;
}

/**
 * Secrets in the `settings` JSON columns (organizations, partners, sites) that
 * are identified by path: notification-channel destinations and credentials.
 * A Slack incoming-webhook URL and the extra webhook URLs carry their
 * credential in the URL itself; the Pushover application token and user key
 * are the same pair a Pushover channel config seals (notificationChannelSecrets
 * `secretKeysForType('pushover')`). Shared with response masking
 * (settingsSecretMasking.ts), which serves all three columns.
 */
export const SETTINGS_SECRET_JSON_PATHS: readonly (readonly string[])[] = [
  ['notifications', 'slackWebhookUrl'],
  ['notifications', 'webhooks'],
  ['notifications', 'pushoverAppToken'],
  ['notifications', 'pushoverDefaultUser'],
];

export const encryptedColumnRegistry: EncryptedColumnSpec[] = [
  { table: 'billing_link_tokens', column: 'token_ct', kind: 'text', aadBinding: 'row', description: 'Autopay bearer link token, encrypted and bound to its row id' },

  { table: 'sso_providers', column: 'client_secret', kind: 'text', description: 'OIDC client secret' },
  { table: 'user_sso_identities', column: 'access_token', kind: 'text', description: 'SSO access token' },
  { table: 'user_sso_identities', column: 'refresh_token', kind: 'text', description: 'SSO refresh token' },
  { table: 'c2c_connections', column: 'client_secret', kind: 'text', description: 'C2C OAuth client secret' },
  { table: 'c2c_connections', column: 'refresh_token', kind: 'text', description: 'C2C OAuth refresh token' },
  { table: 'c2c_connections', column: 'access_token', kind: 'text', description: 'C2C OAuth access token' },
  { table: 'webhooks', column: 'url', kind: 'text', description: 'outbound webhook delivery URL (may embed credentials in userinfo/query)' },
  { table: 'webhooks', column: 'secret', kind: 'text', description: 'outbound webhook signing secret' },
  { table: 'webhooks', column: 'headers', kind: 'json', description: 'outbound webhook encrypted headers' },
  // Moved off notification_channels (#6379); the AAD tag keeps its old
  // location so existing ciphertext decrypts (notificationChannelSecrets.ts).
  { table: 'notification_channel_configs', column: 'config', kind: 'json', idColumn: 'channel_id', aadTag: 'notification_channels.config', description: 'notification channel secret config' },
  { table: 'discovery_profiles', column: 'snmp_communities', kind: 'text-array', description: 'SNMP community strings' },
  { table: 'discovery_profiles', column: 'snmp_credentials', kind: 'json', description: 'SNMP credential secrets' },
  { table: 'snmp_devices', column: 'community', kind: 'text', description: 'SNMP v1/v2c community string' },
  { table: 'snmp_devices', column: 'auth_password', kind: 'text', description: 'SNMP v3 auth password' },
  { table: 'snmp_devices', column: 'priv_password', kind: 'text', description: 'SNMP v3 privacy password' },
  { table: 'automations', column: 'trigger', kind: 'json', description: 'automation webhook trigger secret' },
  { table: 'psa_connections', column: 'credentials', kind: 'json', description: 'PSA connection credentials' },
  { table: 'stripe_connect_accounts', column: 'credentials', kind: 'json', description: 'Stripe Connect OAuth token (deauthorize use)' },
  { table: 'stripe_connect_accounts', column: 'api_key', kind: 'text', description: 'Per-partner Stripe secret/restricted key (API-key billing model)' },
  // AI model registry W02 (#7600, quorum #13): the retired legacy table's rows
  // were copied to partner_ai_connections with the SAME id, so the AAD tag stays
  // the legacy column's logical identity and every stored ciphertext decrypts
  // unchanged (the #6379 moved-column precedent). Row-bound: a blob pasted into
  // another partner's connection does not decrypt. Never rename the tag.
  { table: 'partner_ai_connections', column: 'api_key_encrypted', kind: 'text', aadBinding: 'row', aadTag: 'partner_llm_configs.api_key_encrypted', description: 'Per-partner AI connection key (#7600) — legacy AAD tag (id-preserving copy), bound to the row id' },
  { table: 'huntress_integrations', column: 'api_key_encrypted', kind: 'text', description: 'Huntress API key' },
  { table: 'huntress_integrations', column: 'webhook_secret_encrypted', kind: 'text', description: 'Huntress webhook secret' },
  { table: 'pax8_integrations', column: 'client_id_encrypted', kind: 'text', description: 'Pax8 OAuth client id' },
  { table: 'pax8_integrations', column: 'client_secret_encrypted', kind: 'text', description: 'Pax8 OAuth client secret' },
  { table: 'pax8_integrations', column: 'access_token_encrypted', kind: 'text', description: 'Pax8 OAuth access token cache' },
  { table: 'pax8_integrations', column: 'webhook_secret_encrypted', kind: 'text', description: 'Pax8 webhook secret' },
  { table: 'accounting_connections', column: 'realm_id_encrypted', kind: 'text', description: 'QBO realmId / Xero tenantId' },
  { table: 'accounting_connections', column: 'access_token_encrypted', kind: 'text', description: 'Accounting provider OAuth access token' },
  { table: 'accounting_connections', column: 'refresh_token_encrypted', kind: 'text', description: 'Accounting provider OAuth refresh token (rotates)' },
  { table: 'accounting_connections', column: 'webhook_verifier_token_encrypted', kind: 'text', description: 'QBO webhook verifier token' },
  { table: 's1_integrations', column: 'api_token_encrypted', kind: 'text', description: 'SentinelOne API token' },
  { table: 'dns_filter_integrations', column: 'api_key', kind: 'text', description: 'DNS filter API key' },
  { table: 'dns_filter_integrations', column: 'api_secret', kind: 'text', description: 'DNS filter API secret' },
  { table: 'storage_encryption_keys', column: 'encrypted_private_key', kind: 'text', description: 'backup private key material' },
  { table: 'organizations', column: 'settings', kind: 'json', secretJsonPaths: SETTINGS_SECRET_JSON_PATHS, description: 'organization settings with encrypted log-forwarding and notification-channel secrets' },
  { table: 'partners', column: 'settings', kind: 'json', secretJsonPaths: SETTINGS_SECRET_JSON_PATHS, description: 'partner settings with encrypted remote-access launcher passwords (#716) and notification-channel secrets' },
  { table: 'sites', column: 'settings', kind: 'json', secretJsonPaths: SETTINGS_SECRET_JSON_PATHS, description: 'site-level settings with encrypted overrides' },
  { table: 'td_synnex_digital_bridge_integrations', column: 'credentials', kind: 'json', description: 'TD SYNNEX Digital Bridge API credentials' },
  { table: 'td_synnex_ec_express_integrations', column: 'credentials', kind: 'json', description: 'TD SYNNEX EC Express API credentials' },
  { table: 'td_synnex_sftp_integrations', column: 'credentials', kind: 'json', description: 'TD SYNNEX nightly SFTP P&A password (credentials.password)' },
  { table: 'device_recovery_keys', column: 'encrypted_key', kind: 'text', description: 'escrowed BitLocker/FileVault recovery key (#2021)' },
  { table: 'tenant_variables', column: 'value', kind: 'text', aadBinding: 'row', description: 'tenant variable value (#3409) — AAD bound to the row id' },
  { table: 'invoices', column: 'public_link_token_ct', kind: 'text', aadBinding: 'row', description: 'public invoice-link bearer token (row-bound: swapping ciphertext between invoices would move a live credential across tenants)' },
  { table: 'tool_sources', column: 'auth_config_encrypted', kind: 'text', aadBinding: 'row', description: 'external tool source credential JSON (#5216, spec 2026-09-07 §5.2) — AAD bound to the row id' },
  { table: 'backup_storage_credential_history', column: 'sealed_previous_secret', kind: 'text', aadBinding: 'row', description: 'replaced S3 backup destination connection settings (endpoint, bucket, key pair), kept only to check the old key is disabled — AAD bound to the row id' },
  { table: 'backup_provider_connections', column: 'credentials_encrypted', kind: 'text', aadBinding: 'row', description: 'external backup provider console credentials JSON (#6008 W01) — AAD bound to the row id, so a blob pasted into another partner\'s connection does not decrypt' },
  // Sealed/opened by the column type itself (db/schema/backup.ts); listed here
  // so key rotation re-seals it.
  BACKUP_PROVIDER_CONFIG_COLUMN,
];

/**
 * `isSecretJsonPath` for the `settings` columns. Response masking
 * (services/settingsSecretMasking.ts) and partner-lock checks use this, so a
 * leaf sealed on write is always masked on read.
 */
export function isSettingsSecretPath(path: readonly string[]): boolean {
  return isSecretJsonPath(path, SETTINGS_SECRET_JSON_PATHS);
}

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

/**
 * Encrypt secret-bearing fields inside a registered table.column value before
 * writing it to the database.
 *
 * Mutating routes that set `partners.settings` / `sites.settings` /
 * `organizations.settings` (or any other registered column) MUST run their
 * incoming value through this helper. Otherwise a UI edit silently re-writes
 * the column as plaintext — undoing the at-rest guarantee from the deploy-day
 * batch re-encrypt. See PR #716 and the registry walker `reencryptRegisteredSecrets`
 * for the reference path.
 *
 * No-op when the table/column is not registered (returns the value unchanged)
 * — callers can guard registered and unregistered columns with the same code.
 *
 * THROWS for `aadBinding: 'row'` columns: their AAD needs a row id this helper
 * has no way to know, and sealing under the wrong AAD would produce a row that
 * can never be decrypted again. Those columns have a dedicated writer instead.
 */
export function encryptColumnValueForWrite(table: string, column: string, value: unknown): unknown {
  const spec = encryptedColumnRegistry.find((s) => s.table === table && s.column === column);
  if (!spec) return value;
  return transformEncryptedColumnValue(spec, value);
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

/**
 * Writes the re-sealed value only if the row still holds exactly what was
 * read (compare-and-set). A concurrent save — a credential edit landing
 * between the read and this write — must never be overwritten with the
 * re-sealed OLD value. Returns false when the row changed; the next run picks
 * it up.
 */
async function updateValue(
  executor: SecretReencryptionExecutor,
  spec: EncryptedColumnSpec,
  id: string,
  previous: unknown,
  value: unknown,
): Promise<boolean> {
  const idColumn = spec.idColumn ?? 'id';
  const target = sql.identifier(spec.column);
  let assignment;
  let unchanged;
  if (spec.kind === 'json') {
    assignment = sql`${JSON.stringify(value)}::jsonb`;
    unchanged = sql`${target} = ${JSON.stringify(previous)}::jsonb`;
  } else if (spec.kind === 'text-array') {
    // Bound as ONE jsonb parameter: Drizzle expands a JS array into a
    // parenthesised parameter list, which `::text[]` cannot cast.
    assignment = sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(value)}::jsonb))`;
    unchanged = sql`to_jsonb(${target}) = ${JSON.stringify(previous)}::jsonb`;
  } else {
    assignment = sql`${value as string}`;
    unchanged = sql`${target} = ${previous as string}`;
  }
  const updated = rowsFromResult(await executor.execute(sql`
    UPDATE ${sql.identifier(spec.table)}
    SET ${target} = ${assignment}
    WHERE ${sql.identifier(idColumn)} = ${id} AND ${unchanged}
    RETURNING 1 AS updated
  `));
  return updated.length > 0;
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
    contended: 0,
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
            // row.id is threaded through so row-bound columns rebuild exactly
            // the AAD their write path used; ignored by column-bound specs.
            const transformed = transformEncryptedColumnValue(spec, row.value, row.id);
            if (valuesEqual(transformed, row.value)) {
              continue;
            }

            stats.changed++;
            if (!dryRun) {
              if (await updateValue(executor, spec, row.id, row.value, transformed)) {
                stats.updated++;
              } else {
                stats.contended++;
                logger.warn(`[secret-rotation] ${spec.table}.${spec.column} row ${row.id} changed while being re-sealed; left for the next run`);
              }
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
