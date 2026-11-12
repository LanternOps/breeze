/**
 * network_change_events retention target (#4342 W5). REPORT-ONLY until
 * NETWORK_CHANGE_EVENT_RETENTION_ENFORCE=true.
 *
 * Replaces networkBaselineWorker's `prune-change-events` handler, which no
 * scheduler ever queued, used the bare `db` outside any context, and skipped
 * events with no profile and profiles with alerts disabled (plan correction 16).
 *
 * Each event's window is its discovery profile's
 * `alert_settings.changeRetentionDays` (the API accepts 1-365), clamped to
 * 1..365. A value that is not a 1-3 digit integer, a NULL `profile_id`, or a
 * deleted profile falls back to the job window (`NETWORK_CHANGE_EVENT_RETENTION_DAYS`,
 * default 90). The regex guard runs in the subquery's WHERE, so the `::int`
 * cast only ever sees digits: junk settings can never make the statement throw.
 *
 * The per-profile window counts back from the run instant; the fallback is the
 * runner's own cutoff, so the knob and the predicate cannot disagree.
 * `detected_at` is `timestamp without time zone` holding UTC. No inbound FKs
 * (`network_change_events.alert_id` points out, to alerts).
 */

import { sql } from 'drizzle-orm';

import { resolveRetentionDays, retentionEnforceFromEnv, utcWallTime } from '../retentionBatch';
import type { RetentionTarget } from '../retentionTarget';
import { historyKnobs, LOG_PREFIX, type HistoryRetentionEntry } from './shared';

const MAX_DAYS = 365;
const RETENTION_DAYS = resolveRetentionDays(process.env.NETWORK_CHANGE_EVENT_RETENTION_DAYS, 90, MAX_DAYS, LOG_PREFIX);
const ENFORCE = retentionEnforceFromEnv(LOG_PREFIX, 'NETWORK_CHANGE_EVENT_RETENTION_ENFORCE', false);

export const NETWORK_CHANGE_EVENT_RETENTION_TARGET: RetentionTarget = {
  metricName: 'network_change_event_retention',
  table: 'network_change_events',
  action: { kind: 'delete' },
  // The outer table is referenced by its bare name (retentionBatch selects FROM
  // it unaliased). The first conjunct is implied by the second (every window,
  // profile or job, is at least 1 day) and exists only so the planner can use
  // network_change_events_detected_at_idx instead of evaluating the
  // per-row subquery on every recent event.
  where: (cutoffIso, nowIso) => sql`detected_at < ${utcWallTime(nowIso)} - interval '1 day'
    AND detected_at < COALESCE((SELECT ${utcWallTime(nowIso)} - make_interval(days => LEAST(365, GREATEST(1, (p.alert_settings->>'changeRetentionDays')::int)))
      FROM discovery_profiles p
     WHERE p.id = network_change_events.profile_id
       AND p.alert_settings->>'changeRetentionDays' ~ '^[0-9]{1,3}$'), ${utcWallTime(cutoffIso)})`,
};

export const NETWORK_CHANGE_EVENT_TARGETS: ReadonlyArray<HistoryRetentionEntry> = [
  {
    target: NETWORK_CHANGE_EVENT_RETENTION_TARGET,
    knobs: historyKnobs(RETENTION_DAYS, ENFORCE),
    enforceVar: 'NETWORK_CHANGE_EVENT_RETENTION_ENFORCE',
    maxRetentionDays: MAX_DAYS,
  },
];
