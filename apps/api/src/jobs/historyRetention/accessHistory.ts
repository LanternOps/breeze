/**
 * Notification and session history targets (#4342 W5). Each is REPORT-ONLY
 * until its own `<NAME>_RETENTION_ENFORCE=true`.
 *
 * user_notifications (two targets, one metric each)
 *   - read: a read notification goes `read_at` + 90 d.
 *   - all: any notification goes `created_at` + 365 d, EXCEPT an unread
 *     `approval`: it is still actionable, and for an approver with no phone it
 *     is the only channel (`services/actionIntents/intentService.ts`).
 *   `wisp_thread_posts.notification_id` is SET NULL.
 *
 * remote_sessions
 *   Ended sessions (`disconnected`/`failed`/`denied`) past the window.
 *   `recording_url` is a link the user typed, not a stored file, so it goes
 *   with the row. No inbound FKs.
 *
 * support_sessions
 *   `ended`/`expired` past the window. These columns are timestamptz.
 *   `enrollment_keys.support_session_id` cascades; the quick-support reaper
 *   has already purged the device hours after the session ended.
 *
 * sessions (auth)
 *   Written by SSO login. A row goes once it was created before the window AND
 *   has expired. The window floors at `USER_RISK_SESSION_LOOKBACK_DAYS` (30):
 *   `services/userRiskScoring.ts` reads sessions created in the last 30 days.
 *
 * Except support_sessions, every age column is `timestamp without time zone`
 * holding UTC.
 */

import { sql } from 'drizzle-orm';

import { USER_RISK_SESSION_LOOKBACK_DAYS } from '../../services/userRiskScoring';
import { resolveRetentionDays, retentionEnforceFromEnv, utcWallTime } from '../retentionBatch';
import type { RetentionTarget } from '../retentionTarget';
import { historyKnobs, LOG_PREFIX, type HistoryRetentionEntry } from './shared';

const READ_NOTIFICATION_MAX_DAYS = 365;
const AUTH_SESSION_MAX_DAYS = 365;
const MAX_DAYS = 1095;

const USER_NOTIFICATION_READ_DAYS = resolveRetentionDays(process.env.USER_NOTIFICATION_READ_RETENTION_DAYS, 90, READ_NOTIFICATION_MAX_DAYS, LOG_PREFIX);
const USER_NOTIFICATION_READ_ENFORCE = retentionEnforceFromEnv(LOG_PREFIX, 'USER_NOTIFICATION_READ_RETENTION_ENFORCE', false);
const USER_NOTIFICATION_DAYS = resolveRetentionDays(process.env.USER_NOTIFICATION_RETENTION_DAYS, 365, MAX_DAYS, LOG_PREFIX);
const USER_NOTIFICATION_ENFORCE = retentionEnforceFromEnv(LOG_PREFIX, 'USER_NOTIFICATION_RETENTION_ENFORCE', false);
const REMOTE_SESSION_DAYS = resolveRetentionDays(process.env.REMOTE_SESSION_RETENTION_DAYS, 365, MAX_DAYS, LOG_PREFIX);
const REMOTE_SESSION_ENFORCE = retentionEnforceFromEnv(LOG_PREFIX, 'REMOTE_SESSION_RETENTION_ENFORCE', false);
const SUPPORT_SESSION_DAYS = resolveRetentionDays(process.env.SUPPORT_SESSION_RETENTION_DAYS, 365, MAX_DAYS, LOG_PREFIX);
const SUPPORT_SESSION_ENFORCE = retentionEnforceFromEnv(LOG_PREFIX, 'SUPPORT_SESSION_RETENTION_ENFORCE', false);
const AUTH_SESSION_DAYS = floorAuthSessionDays(
  resolveRetentionDays(process.env.AUTH_SESSION_RETENTION_DAYS, 30, AUTH_SESSION_MAX_DAYS, LOG_PREFIX),
);
const AUTH_SESSION_ENFORCE = retentionEnforceFromEnv(LOG_PREFIX, 'AUTH_SESSION_RETENTION_ENFORCE', false);

function floorAuthSessionDays(days: number): number {
  if (days >= USER_RISK_SESSION_LOOKBACK_DAYS) return days;
  console.warn(
    `${LOG_PREFIX} AUTH_SESSION_RETENTION_DAYS=${days} is below the ${USER_RISK_SESSION_LOOKBACK_DAYS}-day ` +
    `user-risk session lookback; using ${USER_RISK_SESSION_LOOKBACK_DAYS}.`,
  );
  return USER_RISK_SESSION_LOOKBACK_DAYS;
}

export const USER_NOTIFICATION_READ_RETENTION_TARGET: RetentionTarget = {
  metricName: 'user_notification_read_retention',
  table: 'user_notifications',
  action: { kind: 'delete' },
  where: (cutoffIso) => sql`read = true AND read_at < ${utcWallTime(cutoffIso)}`,
};

export const USER_NOTIFICATION_RETENTION_TARGET: RetentionTarget = {
  metricName: 'user_notification_retention',
  table: 'user_notifications',
  action: { kind: 'delete' },
  where: (cutoffIso) => sql`created_at < ${utcWallTime(cutoffIso)}
    AND NOT (type = 'approval' AND read = false)`,
};

export const REMOTE_SESSION_RETENTION_TARGET: RetentionTarget = {
  metricName: 'remote_session_retention',
  table: 'remote_sessions',
  action: { kind: 'delete' },
  where: (cutoffIso) => sql`status IN ('disconnected', 'failed', 'denied')
    AND COALESCE(ended_at, created_at) < ${utcWallTime(cutoffIso)}`,
};

export const SUPPORT_SESSION_RETENTION_TARGET: RetentionTarget = {
  metricName: 'support_session_retention',
  table: 'support_sessions',
  action: { kind: 'delete' },
  where: (cutoffIso) => sql`status IN ('ended', 'expired') AND COALESCE(ended_at, created_at) < ${cutoffIso}::timestamptz`,
};

export const AUTH_SESSION_RETENTION_TARGET: RetentionTarget = {
  metricName: 'auth_session_retention',
  table: 'sessions',
  action: { kind: 'delete' },
  where: (cutoffIso, nowIso) => sql`created_at < ${utcWallTime(cutoffIso)} AND expires_at < ${utcWallTime(nowIso)}`,
};

export const ACCESS_HISTORY_TARGETS: ReadonlyArray<HistoryRetentionEntry> = [
  {
    target: USER_NOTIFICATION_READ_RETENTION_TARGET,
    knobs: historyKnobs(USER_NOTIFICATION_READ_DAYS, USER_NOTIFICATION_READ_ENFORCE),
    enforceVar: 'USER_NOTIFICATION_READ_RETENTION_ENFORCE',
    maxRetentionDays: READ_NOTIFICATION_MAX_DAYS,
  },
  {
    target: USER_NOTIFICATION_RETENTION_TARGET,
    knobs: historyKnobs(USER_NOTIFICATION_DAYS, USER_NOTIFICATION_ENFORCE),
    enforceVar: 'USER_NOTIFICATION_RETENTION_ENFORCE',
    maxRetentionDays: MAX_DAYS,
  },
  {
    target: REMOTE_SESSION_RETENTION_TARGET,
    knobs: historyKnobs(REMOTE_SESSION_DAYS, REMOTE_SESSION_ENFORCE),
    enforceVar: 'REMOTE_SESSION_RETENTION_ENFORCE',
    maxRetentionDays: MAX_DAYS,
  },
  {
    target: SUPPORT_SESSION_RETENTION_TARGET,
    knobs: historyKnobs(SUPPORT_SESSION_DAYS, SUPPORT_SESSION_ENFORCE),
    enforceVar: 'SUPPORT_SESSION_RETENTION_ENFORCE',
    maxRetentionDays: MAX_DAYS,
  },
  {
    target: AUTH_SESSION_RETENTION_TARGET,
    knobs: historyKnobs(AUTH_SESSION_DAYS, AUTH_SESSION_ENFORCE),
    enforceVar: 'AUTH_SESSION_RETENTION_ENFORCE',
    maxRetentionDays: AUTH_SESSION_MAX_DAYS,
  },
];
