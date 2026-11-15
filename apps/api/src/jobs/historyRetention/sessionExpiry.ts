/**
 * Expired and ended session targets (#4342 W6.c). REPORT-ONLY BY
 * CONSTRUCTION: each action is `reportOnly` and none has an `_ENFORCE`
 * variable, so these only count (see `HistoryReportOnlyEntry` in `shared.ts`).
 *
 * sso_sessions
 *   One row per SSO login, link or re-auth start, with a 10-minute
 *   `expires_at` (`routes/sso.ts`). A successful callback deletes its row
 *   (`services/ssoBrowserTransition.ts`), and the callback already rejects an
 *   expired row, so every row still here past expiry was abandoned. The window
 *   is a grace period after `expires_at`. No inbound FKs.
 *
 * c2c_consent_sessions
 *   The same shape for the Microsoft 365 admin-consent start
 *   (`routes/c2c/m365Auth.ts`): 10-minute `expires_at`, deleted on callback,
 *   rejected once expired. No inbound FKs.
 *
 * tunnel_sessions
 *   One row per VNC or proxy tunnel. Ended rows (`disconnected`, `failed`)
 *   past the window; `pending`/`connecting`/`active` are never eligible. Its
 *   readers look rows up by id or read the newest 100 per org, and live-session
 *   reads are bounded to recent rows. No inbound FKs.
 *
 * Every age column here is `timestamp without time zone` holding UTC.
 */

import { sql } from 'drizzle-orm';

import { resolveRetentionDays, utcWallTime } from '../retentionBatch';
import type { RetentionTarget } from '../retentionTarget';
import { LOG_PREFIX, reportOnlyKnobs, type HistoryReportOnlyEntry } from './shared';

const EXPIRED_SESSION_MAX_DAYS = 365;
const MAX_DAYS = 1095;

const SSO_SESSION_DAYS = resolveRetentionDays(process.env.SSO_SESSION_RETENTION_DAYS, 7, EXPIRED_SESSION_MAX_DAYS, LOG_PREFIX);
const C2C_CONSENT_SESSION_DAYS = resolveRetentionDays(process.env.C2C_CONSENT_SESSION_RETENTION_DAYS, 7, EXPIRED_SESSION_MAX_DAYS, LOG_PREFIX);
const TUNNEL_SESSION_DAYS = resolveRetentionDays(process.env.TUNNEL_SESSION_RETENTION_DAYS, 365, MAX_DAYS, LOG_PREFIX);

export const SSO_SESSION_RETENTION_TARGET = {
  metricName: 'sso_session_retention',
  table: 'sso_sessions',
  action: { kind: 'reportOnly' },
  where: (cutoffIso) => sql`expires_at < ${utcWallTime(cutoffIso)}`,
} satisfies RetentionTarget;

export const C2C_CONSENT_SESSION_RETENTION_TARGET = {
  metricName: 'c2c_consent_session_retention',
  table: 'c2c_consent_sessions',
  action: { kind: 'reportOnly' },
  where: (cutoffIso) => sql`expires_at < ${utcWallTime(cutoffIso)}`,
} satisfies RetentionTarget;

export const TUNNEL_SESSION_RETENTION_TARGET = {
  metricName: 'tunnel_session_retention',
  table: 'tunnel_sessions',
  action: { kind: 'reportOnly' },
  where: (cutoffIso) => sql`status IN ('disconnected', 'failed')
    AND COALESCE(ended_at, created_at) < ${utcWallTime(cutoffIso)}`,
} satisfies RetentionTarget;

export const SESSION_EXPIRY_TARGETS: ReadonlyArray<HistoryReportOnlyEntry> = [
  {
    target: SSO_SESSION_RETENTION_TARGET,
    knobs: reportOnlyKnobs(SSO_SESSION_DAYS),
    daysVar: 'SSO_SESSION_RETENTION_DAYS',
    maxRetentionDays: EXPIRED_SESSION_MAX_DAYS,
  },
  {
    target: C2C_CONSENT_SESSION_RETENTION_TARGET,
    knobs: reportOnlyKnobs(C2C_CONSENT_SESSION_DAYS),
    daysVar: 'C2C_CONSENT_SESSION_RETENTION_DAYS',
    maxRetentionDays: EXPIRED_SESSION_MAX_DAYS,
  },
  {
    target: TUNNEL_SESSION_RETENTION_TARGET,
    knobs: reportOnlyKnobs(TUNNEL_SESSION_DAYS),
    daysVar: 'TUNNEL_SESSION_RETENTION_DAYS',
    maxRetentionDays: MAX_DAYS,
  },
];
