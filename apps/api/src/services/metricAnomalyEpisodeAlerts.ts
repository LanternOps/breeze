import { and, eq, gte, inArray, ne } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../db';
import { alerts, metricAnomalyEpisodes } from '../db/schema';
import { resolveAlert } from './alertService';
import { setEpisodeCloseHandler, type EpisodeCloseResult } from './metricAnomalyEpisodes';
import { captureException } from './sentry';

/**
 * Spec §7 alert half: when an episode closes automatically (cleared /
 * expired_*), resolve its linked alert if that alert is still `active` and
 * not `requires_human`. Promoted anomaly alerts have ruleId NULL, so
 * checkAutoResolve never closes them (alertService.ts:455-457); this is their
 * only automatic path. A `detection_off` close (flag turned off, W01 A5) is
 * NOT in AUTO_CLOSE_REASONS: nothing observed the device recover, so its
 * alert stays for the alert workflow.
 *
 * Crash-safe by construction: the work set is re-derived from the database
 * (auto-closed within EPISODE_ALERT_CATCHUP_HOURS, alert still active), not
 * from the in-memory list, and resolveAlert is a CAS — so a lost invocation is
 * repaired by the next one and a repeated one is a no-op.
 *
 * DB context: withSystemDbAccessContext only — opens a short transaction
 * when called outside a context (the intended call site: after the
 * episode-resolve stage commits) and joins one otherwise. Never
 * runOutsideDbContext, so it can never take a second pooled connection.
 */

export const AUTO_CLOSE_REASONS = ['cleared', 'expired_offline', 'expired_no_data'] as const;
export const EPISODE_ALERT_CATCHUP_HOURS = 24;
const MAX_ALERTS_PER_PASS = 200;

export function autoResolveNoteFor(closeReason: string | null): string {
  return closeReason === 'cleared'
    ? 'Auto-resolved: anomaly episode cleared'
    : 'Auto-resolved: anomaly episode expired';
}

export async function resolveAlertsForAutoClosedEpisodes(orgId: string, now: Date = new Date()): Promise<number> {
  return withSystemDbAccessContext(async () => {
    const since = new Date(now.getTime() - EPISODE_ALERT_CATCHUP_HOURS * 3_600_000);
    const rows = await db
      .select({ alertId: alerts.id, closeReason: metricAnomalyEpisodes.closeReason })
      .from(metricAnomalyEpisodes)
      .innerJoin(alerts, and(
        eq(alerts.id, metricAnomalyEpisodes.linkedAlertId),
        eq(alerts.orgId, metricAnomalyEpisodes.orgId),
      ))
      .where(and(
        eq(metricAnomalyEpisodes.orgId, orgId),
        ne(metricAnomalyEpisodes.status, 'open'),
        inArray(metricAnomalyEpisodes.closeReason, [...AUTO_CLOSE_REASONS]),
        gte(metricAnomalyEpisodes.resolvedAt, since),
        eq(alerts.status, 'active'),
        eq(alerts.requiresHuman, false),
      ))
      .limit(MAX_ALERTS_PER_PASS);

    let resolved = 0;
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.alertId)) continue;
      seen.add(row.alertId);
      if (await resolveAlert(row.alertId, autoResolveNoteFor(row.closeReason))) resolved += 1;
    }
    return resolved;
  }, 'metricAnomalyEpisodes.closeAlerts');
}

export async function handleEpisodesClosed(orgId: string, _closed: EpisodeCloseResult[]): Promise<void> {
  try {
    await resolveAlertsForAutoClosedEpisodes(orgId);
  } catch (error) {
    console.error(`[MetricAnomalyEpisodes] org=${orgId} failed to auto-resolve linked alerts:`, error);
    captureException(error instanceof Error ? error : new Error(String(error)));
  }
}

export function registerEpisodeCloseAlertHandler(): void {
  setEpisodeCloseHandler(handleEpisodesClosed);
}
