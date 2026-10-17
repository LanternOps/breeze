import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../../db';
import { webhookHealth } from '../../integrationStates';
import { PERMISSIONS } from '../../permissions';
import { cleanDisplayName } from '../sanitize';
import type { HealthObservation, HealthSource } from '../types';
import { observeRows, toHealthObservation, validUuids } from './observeRows';

// Outbound webhooks (spec §3, W4). Org-owned, one incident per webhook.
//
// What counts as a terminal failure: a webhook_deliveries row in `failed` whose
// `attempts` reached the webhook's retry budget. The delivery worker writes
// `failed` after EVERY failed attempt (the next retry is a Redis job, not a row
// state), so `failed` alone is not terminal. Excluded:
//   - superseded deliveries (webhook edited or disabled after enqueue,
//     workers/webhookDelivery.ts; error_message `superseded_by_edit:`), which
//     were never attempted against the endpoint;
//   - rows the recovery sweep resolved (jobs/webhookDeliveryRecovery.ts), which
//     carry attempts 0: a Breeze-side failure, not the endpoint's.
// Recovery is affirmative: webhooks.last_success_at after the latest terminal
// failure. A webhook whose endpoint died and that receives no more events stays
// open until a delivery succeeds or the webhook is disabled (retired).
//
// Both tables grow with orgs, so both reads are index-backed (2026-12-29-250000):
//   broken:  webhook_deliveries_failed_recent_idx (created_at) WHERE status = 'failed'
//   tracked: webhook_deliveries_failed_webhook_idx (webhook_id, created_at)
//            WHERE status = 'failed' AND attempts > 0
// The tracked index's extra `attempts > 0` is deliberate: only the tracked
// lookup states it literally, so the broken query cannot be planned onto the
// per-webhook index (whose webhook_id order would turn the one-hour window
// into a scan of every failed row).
const ATTEMPTED = sql.raw(`d.attempts > 0`);

const FIX_HREF = '/integrations#webhooks';
/** Spec §3: terminal failures inside this window open an incident. */
export const TERMINAL_FAILURE_WINDOW_MS = 60 * 60 * 1000;
/** The worker's default retry budget (workers/webhookDelivery.ts MAX_RETRIES). */
const DEFAULT_MAX_RETRIES = 5;

// Inlined as literals, not bound: the planner must see `status = 'failed'` to
// match the partial indexes. `_` is escaped so LIKE does not treat it as a wildcard.
const FAILED = sql.raw(`'failed'`);
const NOT_SUPERSEDED = sql.raw(`(d.error_message IS NULL OR d.error_message NOT LIKE 'superseded\\_by\\_edit:%')`);
// The worker treats attempt N as the last when N >= retryPolicy.maxRetries
// (default 5, and at least one attempt always happens). A malformed value falls
// back to the default rather than failing the cast.
const TERMINAL_ATTEMPTS = sql.raw(
  `GREATEST(1, CASE WHEN (w.retry_policy->>'maxRetries') ~ '^[0-9]{1,6}$' `
  + `THEN (w.retry_policy->>'maxRetries')::int ELSE ${DEFAULT_MAX_RETRIES} END)`,
);

export type WebhookRow = {
  id: string;
  orgId: string;
  partnerId: string;
  name: string;
  status: string;
  createdAt: Date;
  hasTerminalFailure: boolean;
  recoveredSince: boolean;
  failureMessage: string | null;
  failureResponseStatus: number | null;
};

export function webhookObservation(row: WebhookRow, now: Date): HealthObservation {
  const raw = row.failureMessage ?? (row.failureResponseStatus ? `HTTP ${row.failureResponseStatus}` : null);
  return toHealthObservation({
    kind: 'webhook',
    verdict: webhookHealth(row),
    now,
    createdAt: row.createdAt,
    sourceId: row.id,
    partnerId: row.partnerId,
    orgId: row.orgId,
    displayName: cleanDisplayName(row.name, 'Webhook'),
    rawDetail: raw,
    fixHref: FIX_HREF,
    viewPermission: PERMISSIONS.WEBHOOKS_READ,
    repairPermission: PERMISSIONS.ORGS_WRITE,
  });
}

const windowStart = (now: Date) => new Date(now.getTime() - TERMINAL_FAILURE_WINDOW_MS).toISOString();

/**
 * Webhooks with a terminal failure inside the window. Range scan on the
 * failed-deliveries index; the webhook is joined by primary key. Timestamps
 * are bound as ISO strings (the columns are `timestamp`, written in UTC).
 */
function brokenWebhooksQuery(now: Date): SQL {
  // A semi-join, not SELECT DISTINCT: nothing asks for webhook_id order.
  return sql`
    SELECT wh.id
    FROM webhooks wh
    WHERE wh.status = 'active'
      AND wh.id IN (
        SELECT d.webhook_id
        FROM webhook_deliveries d
        JOIN webhooks w ON w.id = d.webhook_id
        WHERE d.status = ${FAILED}
          AND d.created_at >= ${windowStart(now)}::timestamp
          AND d.attempts >= ${TERMINAL_ATTEMPTS}
          AND ${NOT_SUPERSEDED}
      )`;
}

type DbRow = {
  id: string; org_id: string; partner_id: string; name: string; status: string; created_at: Date | string;
  failed_at: Date | string | null; recovered: boolean; error_message: string | null; response_status: number | null;
};

/** The given webhooks with their latest terminal failure (any age). A deleted webhook is absent. */
async function loadWebhooks(ids: string[]): Promise<WebhookRow[]> {
  const valid = validUuids(ids);
  if (valid.length === 0) return [];
  const rows = (await db.execute(sql`
    SELECT w.id, w.org_id, o.partner_id, w.name, w.status, w.created_at,
      f.created_at AS failed_at, f.error_message, f.response_status,
      (f.created_at IS NOT NULL AND w.last_success_at IS NOT NULL AND w.last_success_at > f.created_at) AS recovered
    FROM webhooks w
    JOIN organizations o ON o.id = w.org_id
    LEFT JOIN LATERAL (
      SELECT d.created_at, d.error_message, d.response_status
      FROM webhook_deliveries d
      WHERE d.webhook_id = w.id AND d.status = ${FAILED} AND ${ATTEMPTED}
        AND d.attempts >= ${TERMINAL_ATTEMPTS}
        AND ${NOT_SUPERSEDED}
      ORDER BY d.created_at DESC
      LIMIT 1
    ) f ON true
    WHERE w.id IN (${sql.join(valid.map((id) => sql`${id}::uuid`), sql`, `)})`)) as unknown as DbRow[];
  return rows.map((r) => ({
    id: r.id,
    orgId: r.org_id,
    partnerId: r.partner_id,
    name: r.name,
    status: r.status,
    createdAt: new Date(r.created_at),
    hasTerminalFailure: r.failed_at !== null,
    recoveredSince: r.recovered === true,
    failureMessage: r.error_message,
    failureResponseStatus: r.response_status,
  }));
}

export const webhookSource: HealthSource = {
  kind: 'webhook',
  intervalMinutes: 15,
  tables: ['webhooks', 'webhook_deliveries'],
  fixHrefs: [FIX_HREF],
  brokenQuery: brokenWebhooksQuery,
  observe: (now, trackedSourceIds) => observeRows<WebhookRow>({
    now,
    trackedSourceIds,
    loadBroken: async () => {
      const ids = (await db.execute(brokenWebhooksQuery(now))) as unknown as Array<{ id: string }>;
      return loadWebhooks(ids.map((r) => r.id));
    },
    loadTracked: loadWebhooks,
    sourceIdOf: (r) => r.id,
    toObservation: webhookObservation,
  }),
};
