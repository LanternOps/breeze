/**
 * `buildWebhookFanoutDeps` — extracted from `index.ts` (wave 3.5d-b, #4086) so
 * it is importable without the route graph. Split out verbatim: only the
 * import paths changed, the body is byte-identical to the version that lived
 * in `index.ts`.
 *
 * Build the `getWebhooksForEvent`/`createDeliveryRecord` closures the durable
 * `webhook-delivery` subscriber needs (services/eventSubscribers.ts). Kept as
 * its own leaf module so it can be handed to `registerAllEventSubscribers()`
 * synchronously BEFORE `initializeWorkers()` runs (codex Q3 hole #2) — the
 * claim/delivery callback wiring is fine running inside the async worker-init
 * phase, but the subscriber lookup itself must exist before any event can
 * reach the registry.
 */
import { and, eq } from 'drizzle-orm';
import * as dbModule from '../db';
import { webhooks as webhooksTable } from '../db/schema';
import { toWebhookConfig } from './webhookConfig';
import { recordWebhookDelivery } from './webhookDeliveryRecord';
import { captureException } from './sentry';
import type { WebhookFanoutDeps } from '../workers/webhookDelivery';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

export function buildWebhookFanoutDeps(): WebhookFanoutDeps {
  return {
    getWebhooksForEvent: async (orgId, eventType) => {
      return runWithSystemDbAccess(async () => {
        const rows = await db
          .select()
          .from(webhooksTable)
          .where(
            and(
              eq(webhooksTable.orgId, orgId),
              eq(webhooksTable.status, 'active')
            )
          );

        return rows
          .filter((webhook) => {
            const events = webhook.events ?? [];
            return events.includes(eventType) || events.includes('*');
          })
          // Decrypt PER ROW inside a try/catch. url/secret/headers are encrypted
          // at rest (encryptedColumnRegistry); decryptForColumn THROWS on a row
          // that looks encrypted but can't be decrypted (key/AAD mismatch,
          // partial migration, corruption). Without per-row isolation a single
          // bad row would abort the whole .map and silently drop delivery for
          // EVERY webhook in the org. Skip only the offending webhook (delivering
          // with unusable credentials is worse) and surface it to Sentry. Legacy
          // plaintext rows pass through decryptForColumn unchanged.
          .flatMap((webhook) => {
            try {
              // Shared with the recovery sweep (services/webhookConfig): one
              // decrypt/normalise path, so the two cannot drift the next time an
              // encrypted column is added to `webhooks`.
              return [toWebhookConfig(webhook)];
            } catch (err) {
              console.error(
                `[webhookDelivery] failed to decrypt webhook ${webhook.id} (org ${webhook.orgId}); skipping delivery for this webhook only`,
                err
              );
              captureException(err instanceof Error ? err : new Error(String(err)));
              return [];
            }
          });
      });
    },
    createDeliveryRecord: recordWebhookDelivery,
  };
}
