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
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { organizations, webhooks as webhooksTable } from '../db/schema';
import { partnerFanoutOrgCondition } from './partnerFanoutOrgs';
import { recordWebhookDelivery } from './webhookDeliveryRecord';
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
          .select({
            id: webhooksTable.id,
            orgId: webhooksTable.orgId,
            partnerId: webhooksTable.partnerId,
            approvalGeneration: webhooksTable.approvalGeneration,
            events: webhooksTable.events,
            payloadVersion: webhooksTable.payloadVersion,
          })
          .from(webhooksTable)
          .where(
            and(
              or(
                eq(webhooksTable.orgId, orgId),
                and(
                  isNull(webhooksTable.orgId),
                  sql`${webhooksTable.partnerId} IN (
                    SELECT ${organizations.partnerId} FROM ${organizations}
                    WHERE ${organizations.id} = ${orgId} AND ${partnerFanoutOrgCondition()}
                  )`,
                ),
              ),
              eq(webhooksTable.status, 'active')
            )
          );

        // Site-ceiling gate contract §7E: no decryption here. `events` is a
        // plain (non-encrypted) column, and the fan-out/dedupe path never
        // needed url/secret/headers — only `enqueueWebhookAttempt` and
        // `recordWebhookDelivery` consume this, and use only the
        // identity, approval generation and payload version. Decryption now happens
        // exactly once, inside the delivery worker at send time
        // (resolveDeliveryWebhookConfig), which is what closes the window
        // where a decrypted secret used to sit in the Redis queue payload.
        return rows
          .filter((row) => {
            const events = row.events ?? [];
            return events.includes(eventType) || events.includes('*');
          })
          .map((row) => ({
            id: row.id,
            orgId: row.orgId,
            partnerId: row.partnerId,
            approvalGeneration: row.approvalGeneration,
            payloadVersion: row.payloadVersion === 2 ? 2 as const : 1 as const,
          }));
      });
    },
    createDeliveryRecord: recordWebhookDelivery,
  };
}
