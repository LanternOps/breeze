import { decryptForColumn } from './secretCrypto';
import { decryptWebhookHeaders } from './notificationChannelSecrets';
import type { WebhookConfig } from '../workers/webhookDelivery';

/**
 * Row shape this module needs off `webhooks`. Deliberately structural rather
 * than `typeof webhooks.$inferSelect` so callers can hand over a narrowed
 * `select({...})` projection (the recovery sweep does) without widening it.
 */
export interface WebhookConfigRow {
  id: string;
  orgId: string;
  name: string;
  url: string;
  secret: string | null;
  events: string[] | null;
  headers: unknown;
  retryPolicy: unknown;
}

/**
 * Normalise the `headers` jsonb into a flat record.
 *
 * Two historical shapes are in the column: an array of `{ key, value }` pairs
 * (what the UI editor writes) and a plain object. Anything whose value is not
 * a string is dropped rather than coerced — a header with a non-string value
 * would be stringified into the outbound request as "[object Object]".
 */
export function headersToRecord(headers: unknown): Record<string, string> {
  if (!headers) return {};

  if (Array.isArray(headers)) {
    return headers.reduce<Record<string, string>>((acc, header) => {
      if (
        header
        && typeof header === 'object'
        && typeof (header as { key?: unknown }).key === 'string'
        && typeof (header as { value?: unknown }).value === 'string'
      ) {
        acc[(header as { key: string }).key] = (header as { value: string }).value;
      }
      return acc;
    }, {});
  }

  if (typeof headers === 'object') {
    return Object.entries(headers as Record<string, unknown>).reduce<Record<string, string>>((acc, [key, value]) => {
      if (typeof value === 'string') {
        acc[key] = value;
      }
      return acc;
    }, {});
  }

  return {};
}

/**
 * Decrypt one `webhooks` row into the config the delivery worker POSTs with.
 *
 * THROWS on a row that looks encrypted but cannot be decrypted (key/AAD
 * mismatch, partial migration, corruption) — `decryptForColumn`'s own
 * behaviour, deliberately not softened here. Delivering with unusable
 * credentials is worse than not delivering, so every caller must decide what
 * to do with the failure; both current callers isolate it per row and surface
 * it to Sentry rather than letting one bad row abort a batch.
 *
 * Extracted from `index.ts` for #4095: the recovery sweep needs the exact same
 * decrypt/normalise path the '*' subscriber uses, and a second copy of it is
 * how the two would silently diverge the next time an encrypted column is
 * added to `webhooks`.
 */
export function toWebhookConfig(row: WebhookConfigRow): WebhookConfig {
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    url: decryptForColumn('webhooks', 'url', row.url) ?? row.url,
    secret: row.secret
      ? decryptForColumn('webhooks', 'secret', row.secret) ?? undefined
      : undefined,
    events: row.events ?? [],
    headers: headersToRecord(decryptWebhookHeaders(row.headers)),
    retryPolicy: (row.retryPolicy ?? undefined) as WebhookConfig['retryPolicy']
  };
}
