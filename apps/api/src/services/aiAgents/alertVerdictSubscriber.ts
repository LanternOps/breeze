/**
 * CONTRACT (C2 fix, P2-1 wave B task 16d): never re-read a row the
 * publishing transaction wrote — it may not be committed yet (the
 * auto-resolve sweep in `jobs/alertWorker.ts` / `jobs/monitorWorker.ts`
 * publishes `alert.resolved` from inside the SAME `withSystemDbAccessContext`
 * transaction that performed the UPDATE, before it commits; a re-read on
 * this subscriber's own fresh connection can see the pre-update row and
 * silently skip a real system resolve). Gate resolve-state decisions
 * (`resolvedBy`/`resolvedAt`/`triggeredAt`) on the PUBLISHED payload when it
 * carries them — the row read is safe ONLY for fields the publisher's
 * UPDATE never touches (deviceId, ruleId, severity, org membership), which
 * were committed long before resolve.
 *
 * Durable alert-verdict admission subscriber (Phase 2 wave P2-1 — alert
 * verdicts, task 12).
 *
 * Registered on the durable `eventSubscriberRegistry` under id
 * `ai-agent-alert-verdict` (`eventSubscribers.ts`), subscribed to
 * `alert.correlation_group.created` and `alert.resolved`.
 *
 * Admission itself is delegated entirely to `createAndEnqueueAgentRun`
 * (runService.ts) with `profile: 'verdict'` — kill switch, circuit breaker,
 * dedupe, the verdict-profile's own concurrency/rate caps, and trigger
 * filters all live there. `createAndEnqueueAgentRun` manages its own DB
 * access and deliberately performs its announce+enqueue step OUTSIDE any
 * system DB context (#1105 pool-hold-across-Redis) — this module MUST call
 * it with no system context active, or that protection is silently defeated
 * by non-re-entrant nesting (see `metricAnomalySubscriber.ts`'s /
 * `ticketHelpdeskSubscriber.ts`'s identical header comment for the full
 * account; this module is a direct structural clone). Only the reads below
 * run inside a system context.
 *
 * This module's own job is narrow, per event type:
 *
 *  1. `alert.correlation_group.created` — the group verdict run is
 *     DEVICE-BOUND TO THE ROOT ALERT'S DEVICE (controller decision, task 12):
 *     `deviceId`/`alertId`/`correlationGroupId` all come from the event
 *     payload (`groupId`, `rootAlertId`, `deviceId` — published by
 *     `jobs/alertCorrelation.ts`). This binding is load-bearing: a suggested
 *     action's Tier-2 intent is gated at creation on
 *     `alert.device_id === run.device_id` (`alertVerdicts.ts`), so admitting
 *     a group run against any device other than the root alert's would
 *     silently break that gate. `rootAlertId`/`deviceId` are both null when
 *     the root alert has since been hard-deleted (`alert_correlation_
 *     groups.root_alert_id` is `ON DELETE SET NULL`) — that is skipped with
 *     a warning, not admitted with a null target.
 *  2. `alert.resolved` — admits a verdict run ONLY for a SYSTEM/auto resolve
 *     (`resolvedBy === null`; a human resolve never triggers a verdict run)
 *     that landed within `AUTO_RESOLVE_VERDICT_WINDOW_MINUTES` of the
 *     alert's `triggeredAt`, and only when the alert does not already carry
 *     a live verdict (`latestVerdictsForAlerts`) — an alert that was already
 *     verdicted (e.g. as a correlation group's root) is not re-analyzed on
 *     resolve.
 *
 * `enqueueVerdictRunForAlert`/`enqueueVerdictRunForGroup` are exported so
 * task 13 (the ungrouped-alert delay job) can reuse the single-alert variant
 * directly with `reason: 'ungrouped'`, without going through this module's
 * event-shaped entry point.
 */
import { and, eq } from 'drizzle-orm';
import * as dbModule from '../../db';
import { alerts } from '../../db/schema/alerts';
import { devices } from '../../db/schema/devices';
import { AI_AGENTS_ENABLED } from '../../config/env';
import type { BreezeEvent } from '../eventBus';
import { latestVerdictsForAlerts } from './alertVerdicts';
import { createAndEnqueueAgentRun, type CreateAgentRunInput } from './runService';

/**
 * How recent an auto (system) alert resolution must be, relative to the
 * alert's `triggeredAt`, to be worth a verdict run — an alert auto-resolved
 * long after it triggered is unlikely to still be diagnostically
 * interesting, and would otherwise fire a verdict run on every stale
 * condition clearing.
 */
export const AUTO_RESOLVE_VERDICT_WINDOW_MINUTES = 30;

type VerdictReason = 'group_created' | 'auto_resolved' | 'ungrouped';

/** The fields of `alert.correlation_group.created`'s payload this module reads. */
export interface AlertCorrelationGroupCreatedTrigger {
  groupId: string;
  rootAlertId: string | null;
  deviceId: string | null;
}

// #1105 pool-hold seam — identical discipline and identical rationale to
// `metricAnomalySubscriber.ts`'s `runWithSystemDbAccess`: only the reads
// below run under a system context; `createAndEnqueueAgentRun` must run with
// NO system context active. See that module's header comment for the full
// account of why a wrapping-the-whole-handler shape would silently defeat
// the protection.
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

interface AlertVerdictContextRow {
  id: string;
  deviceId: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  ruleId: string | null;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  triggeredAt: Date;
}

/**
 * Org-pinned alert lookup. `null` means the alert is not (or no longer) in
 * this org — same "moved/deleted reads as absent" posture used throughout
 * this wave (`metricAnomalySubscriber.ts`, `ticketHelpdeskSubscriber.ts`).
 */
async function loadAlertForVerdict(alertId: string, orgId: string): Promise<AlertVerdictContextRow | null> {
  const { db } = dbModule;
  const [row] = await db
    .select({
      id: alerts.id,
      deviceId: alerts.deviceId,
      severity: alerts.severity,
      ruleId: alerts.ruleId,
      resolvedAt: alerts.resolvedAt,
      resolvedBy: alerts.resolvedBy,
      triggeredAt: alerts.triggeredAt,
    })
    .from(alerts)
    .where(and(eq(alerts.id, alertId), eq(alerts.orgId, orgId)))
    .limit(1);
  return row ?? null;
}

/**
 * Site/tag context for `alertContext.siteId`/`deviceTags` — same shape and
 * same org-pinned posture as `metricAnomalySubscriber.ts`'s
 * `loadDeviceFilterContext` / `automationRuntime.ts`'s `executeAiTriageAction`
 * device-tags lookup. `null` means the device is not (or no longer) in this
 * org.
 */
async function loadDeviceContext(deviceId: string, orgId: string): Promise<{ siteId: string | null; tags: string[] } | null> {
  const { db } = dbModule;
  const [row] = await db
    .select({ siteId: devices.siteId, tags: devices.tags })
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
    .limit(1);
  if (!row) return null;
  return { siteId: row.siteId, tags: row.tags ?? [] };
}

function buildAlertContext(
  alert: Pick<AlertVerdictContextRow, 'severity' | 'ruleId'>,
  deviceCtx: { siteId: string | null; tags: string[] },
): NonNullable<CreateAgentRunInput['alertContext']> {
  return {
    severity: alert.severity,
    ruleId: alert.ruleId,
    siteId: deviceCtx.siteId,
    deviceTags: deviceCtx.tags,
  };
}

/**
 * Admits a `profile: 'verdict'` run for ONE alert. Reusable across both the
 * auto-resolve path (this module) and task 13's ungrouped-alert delay job
 * (`reason: 'ungrouped'`). No-op when `!AI_AGENTS_ENABLED` (before any DB
 * read — the platform kill switch is also enforced inside
 * `createAndEnqueueAgentRun`, but skipping here avoids the two reads below
 * entirely when the feature is off).
 */
export async function enqueueVerdictRunForAlert(
  orgId: string,
  alertId: string,
  reason: Extract<VerdictReason, 'auto_resolved' | 'ungrouped'>,
): Promise<void> {
  if (!AI_AGENTS_ENABLED) return;

  const alert = await runWithSystemDbAccess(() => loadAlertForVerdict(alertId, orgId));
  if (!alert) {
    console.info('[alertVerdictSubscriber] skipping verdict run — alert not found (or not in org)', {
      alertId, orgId, reason,
    });
    return;
  }

  const deviceCtx = await runWithSystemDbAccess(() => loadDeviceContext(alert.deviceId, orgId));
  if (!deviceCtx) {
    console.info('[alertVerdictSubscriber] skipping verdict run — alert device not found (or not in org)', {
      alertId, deviceId: alert.deviceId, orgId, reason,
    });
    return;
  }

  // Called with NO system DB context active — `createAndEnqueueAgentRun`
  // manages its own (see this module's header).
  const result = await createAndEnqueueAgentRun({
    orgId,
    kind: 'triage',
    triggerKind: 'alert',
    profile: 'verdict',
    deviceId: alert.deviceId,
    alertId: alert.id,
    alertContext: buildAlertContext(alert, deviceCtx),
    triggerRef: { verdictReason: reason, alertId: alert.id },
    dedupeKey: `alert-verdict:${alertId}`,
  });

  if (!result.created) {
    console.info('[alertVerdictSubscriber] admission skipped', { alertId, orgId, reason: result.skipped });
  }
}

/**
 * Admits a `profile: 'verdict'` run for a newly created correlation group,
 * bound to the ROOT alert's device (see this module's header, point 1).
 * No-op when `!AI_AGENTS_ENABLED`, and when the payload carries a null
 * `rootAlertId`/`deviceId` (the root alert has since been hard-deleted).
 */
export async function enqueueVerdictRunForGroup(
  orgId: string,
  payload: AlertCorrelationGroupCreatedTrigger,
): Promise<void> {
  if (!AI_AGENTS_ENABLED) return;

  if (!payload.rootAlertId || !payload.deviceId) {
    console.warn(
      '[alertVerdictSubscriber] skipping group verdict run — rootAlertId/deviceId is null (root alert deleted)',
      { groupId: payload.groupId, orgId },
    );
    return;
  }
  const rootAlertId = payload.rootAlertId;
  const deviceId = payload.deviceId;

  const alert = await runWithSystemDbAccess(() => loadAlertForVerdict(rootAlertId, orgId));
  if (!alert) {
    console.info('[alertVerdictSubscriber] skipping group verdict run — root alert not found (or not in org)', {
      groupId: payload.groupId, rootAlertId, orgId,
    });
    return;
  }

  const deviceCtx = await runWithSystemDbAccess(() => loadDeviceContext(deviceId, orgId));
  if (!deviceCtx) {
    console.info('[alertVerdictSubscriber] skipping group verdict run — device not found (or not in org)', {
      groupId: payload.groupId, deviceId, orgId,
    });
    return;
  }

  // Called with NO system DB context active — see this module's header.
  const result = await createAndEnqueueAgentRun({
    orgId,
    kind: 'triage',
    triggerKind: 'alert',
    profile: 'verdict',
    deviceId,
    alertId: rootAlertId,
    correlationGroupId: payload.groupId,
    alertContext: buildAlertContext(alert, deviceCtx),
    triggerRef: { verdictReason: 'group_created', groupId: payload.groupId, alertId: rootAlertId },
    dedupeKey: `group-verdict:${payload.groupId}`,
  });

  if (!result.created) {
    console.info('[alertVerdictSubscriber] admission skipped', {
      groupId: payload.groupId, orgId, reason: result.skipped,
    });
  }
}

/**
 * Registered handler for `alert.correlation_group.created` / `alert.resolved`
 * (`eventSubscribers.ts`). MUST throw on failure — queue-mode dispatch
 * (#4085) retries on a thrown rejection; local delivery's wrapper
 * (`eventBus.ts`'s `invokeLocalHandlers`) provides the swallow-and-log
 * semantics a handler-level try/catch used to. A malformed event (missing
 * groupId/alertId) is NOT retryable — it is logged and dropped, never
 * thrown, since no redelivery of the same malformed payload would ever
 * succeed.
 */
export async function handleAlertVerdictEvent(event: BreezeEvent): Promise<void> {
  if (!AI_AGENTS_ENABLED) return;

  const orgId = event.orgId;

  try {
    if (event.type === 'alert.correlation_group.created') {
      const payload = event.payload as {
        groupId?: unknown; rootAlertId?: unknown; deviceId?: unknown;
      } | null | undefined;
      const groupId = typeof payload?.groupId === 'string' ? payload.groupId : null;
      if (!groupId || !orgId) {
        console.error(
          '[alertVerdictSubscriber] malformed alert.correlation_group.created event — missing groupId/orgId, dropping',
          { eventId: event.id, orgId, payload: event.payload },
        );
        return;
      }
      const rootAlertId = typeof payload?.rootAlertId === 'string' ? payload.rootAlertId : null;
      const deviceId = typeof payload?.deviceId === 'string' ? payload.deviceId : null;

      await enqueueVerdictRunForGroup(orgId, { groupId, rootAlertId, deviceId });
      return;
    }

    if (event.type === 'alert.resolved') {
      const payload = event.payload as {
        alertId?: unknown;
        resolvedBy?: unknown;
        resolvedAt?: unknown;
        triggeredAt?: unknown;
      } | null | undefined;
      const alertId = typeof payload?.alertId === 'string' ? payload.alertId : null;
      if (!alertId || !orgId) {
        console.error(
          '[alertVerdictSubscriber] malformed alert.resolved event — missing alertId/orgId, dropping',
          { eventId: event.id, orgId, payload: event.payload },
        );
        return;
      }

      // C2 fix — see this file's header contract comment. When the payload
      // carries all three fields, resolve-state is decided ENTIRELY from
      // the payload; the row read below (still needed for deviceId/ruleId/
      // severity context) is never consulted for resolvedBy/resolvedAt,
      // even if it still shows the pre-commit (stale) values. A publisher
      // that omits any of the three fields falls back to reading them off
      // the row, matching the pre-existing behavior.
      const payloadResolvedBy =
        typeof payload?.resolvedBy === 'string' ? payload.resolvedBy
        : payload?.resolvedBy === null ? null
        : undefined;
      const payloadResolvedAt = typeof payload?.resolvedAt === 'string' ? payload.resolvedAt : undefined;
      const payloadTriggeredAt = typeof payload?.triggeredAt === 'string' ? payload.triggeredAt : undefined;
      const payloadGated = payloadResolvedBy !== undefined && payloadResolvedAt !== undefined && payloadTriggeredAt !== undefined;

      // Only these reads run under a system context — see
      // `runWithSystemDbAccess`'s header comment (#1105 pool-hold seam).
      // Existence/org-membership and deviceId/ruleId/severity context are
      // safe to read regardless of the resolving transaction's commit
      // state — this UPDATE never touches those columns.
      const alert = await runWithSystemDbAccess(() => loadAlertForVerdict(alertId, orgId));
      if (!alert) {
        console.info('[alertVerdictSubscriber] skipping resolve verdict — alert not found (or not in org)', {
          alertId, orgId,
        });
        return;
      }

      let resolvedBy: string | null;
      let resolvedAtMs: number;
      let triggeredAtMs: number;

      if (payloadGated) {
        resolvedBy = payloadResolvedBy;
        resolvedAtMs = new Date(payloadResolvedAt).getTime();
        triggeredAtMs = new Date(payloadTriggeredAt).getTime();
      } else {
        // Older publisher without the new payload fields — fall back to the
        // row's own resolve state (pre-existing behavior).
        if (!alert.resolvedAt) {
          // Should not happen for a genuine alert.resolved delivery — the
          // resolve path always sets resolvedAt in the same UPDATE. Not
          // retryable: redelivery of the same event answers the same way.
          console.info('[alertVerdictSubscriber] skipping resolve verdict — no resolvedAt on alert', {
            alertId, orgId,
          });
          return;
        }
        resolvedBy = alert.resolvedBy;
        resolvedAtMs = alert.resolvedAt.getTime();
        triggeredAtMs = alert.triggeredAt.getTime();
      }

      // Task 16e fix: a malformed ISO string in the PAYLOAD (payloadGated
      // branch) parses to `Invalid Date`, whose `.getTime()` is `NaN`.
      // `NaN > AUTO_RESOLVE_VERDICT_WINDOW_MINUTES` is `false`, so without
      // this guard the elapsed-time check below silently falls through and
      // admits the run — exactly the failure mode this gate exists to
      // prevent. Fail closed: an unparseable timestamp is treated the same
      // as "outside the window", not "inside" it.
      if (Number.isNaN(resolvedAtMs) || Number.isNaN(triggeredAtMs)) {
        console.warn('[alertVerdictSubscriber] skipping resolve verdict — unparseable resolvedAt/triggeredAt', {
          alertId, orgId, payloadGated, resolvedAtMs, triggeredAtMs,
        });
        return;
      }

      // Human resolves never trigger a verdict run — only a system/auto
      // resolve (resolvedBy null) does.
      if (resolvedBy !== null) {
        console.info('[alertVerdictSubscriber] skipping resolve verdict — human resolve', { alertId, orgId });
        return;
      }

      const elapsedMinutes = (resolvedAtMs - triggeredAtMs) / 60_000;
      if (elapsedMinutes > AUTO_RESOLVE_VERDICT_WINDOW_MINUTES) {
        console.info('[alertVerdictSubscriber] skipping resolve verdict — outside auto-resolve window', {
          alertId, orgId, elapsedMinutes,
        });
        return;
      }

      const existingVerdicts = await runWithSystemDbAccess(() => latestVerdictsForAlerts(orgId, [alertId]));
      if (existingVerdicts.has(alertId)) {
        console.info('[alertVerdictSubscriber] skipping resolve verdict — alert already carries a verdict', {
          alertId, orgId,
        });
        return;
      }

      await enqueueVerdictRunForAlert(orgId, alertId, 'auto_resolved');
      return;
    }
  } catch (err) {
    console.error('[alertVerdictSubscriber] handler failed', {
      eventType: event.type,
      orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
