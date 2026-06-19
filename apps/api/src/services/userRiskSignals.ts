import { sql } from 'drizzle-orm';

import { db } from '../db';
import { appendUserRiskSignalEvent } from './userRiskScoring';
import { resolveMlFeatureFlagForOrg } from './mlFeatureFlags';

const DEFAULT_LOOKBACK_HOURS = 24;
const OFF_HOURS_MASS_SCRIPT_TARGETS = 10;
const REMOTE_SESSION_BURST_COUNT = 5;
const ELEVATION_BURST_COUNT = 3;

type OffHoursScriptRow = {
  batch_id: string;
  user_id: string;
  script_id: string;
  devices_targeted: number | string;
  created_at: Date | string;
};

type RemoteSessionBurstRow = {
  user_id: string;
  session_count: number | string;
  latest_at: Date | string;
};

type ElevationBurstRow = {
  user_id: string;
  request_count: number | string;
  approved_count: number | string;
  latest_at: Date | string;
};

type NewGeographyLoginRow = {
  user_id: string;
  country: string;
  login_count: number | string;
  latest_at: Date | string;
  previous_countries: string[] | string | null;
};

export type UserRiskSignalEvaluationResult = {
  orgId: string;
  skipped: boolean;
  appended: number;
  deduped: number;
  /** Signals whose append threw and were skipped (S4 — distinct from deduped). */
  failed: number;
  // NOTE: `candidates` are DETECTION counts (how many rows each query matched),
  // NOT persisted counts. The persisted total is `appended`; `appended + deduped
  // + failed` should equal the sum of candidate counts.
  candidates: {
    offHoursMassScripts: number;
    remoteSessionBursts: number;
    privilegeElevationBursts: number;
    newGeographyLogins: number;
  };
};

function toInt(value: number | string | null | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function windowKey(date: Date, hours: number): string {
  const widthMs = Math.max(1, hours) * 60 * 60 * 1000;
  return new Date(Math.floor(date.getTime() / widthMs) * widthMs).toISOString();
}

async function hasExistingSignal(input: {
  orgId: string;
  userId: string;
  eventType: string;
  fingerprint: string;
  sinceIso: string;
}): Promise<boolean> {
  const rows = await db.execute(sql`
    SELECT id
    FROM user_risk_events
    WHERE org_id = ${input.orgId}
      AND user_id = ${input.userId}
      AND event_type = ${input.eventType}
      AND occurred_at >= ${input.sinceIso}::timestamptz
      AND details->>'fingerprint' = ${input.fingerprint}
    LIMIT 1
  `) as Array<{ id: string }>;
  return rows.length > 0;
}

async function appendDedupedSignal(input: {
  orgId: string;
  userId: string;
  eventType: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  scoreImpact: number;
  description: string;
  details: Record<string, unknown>;
  occurredAt: Date;
  sinceIso: string;
}): Promise<'appended' | 'deduped'> {
  const fingerprint = String(input.details.fingerprint ?? '');
  if (fingerprint && await hasExistingSignal({
    orgId: input.orgId,
    userId: input.userId,
    eventType: input.eventType,
    fingerprint,
    sinceIso: input.sinceIso,
  })) {
    return 'deduped';
  }

  await appendUserRiskSignalEvent({
    orgId: input.orgId,
    userId: input.userId,
    eventType: input.eventType,
    severity: input.severity,
    scoreImpact: input.scoreImpact,
    description: input.description,
    details: input.details,
    occurredAt: input.occurredAt,
  });
  return 'appended';
}

export async function evaluateUserRiskSignalsForOrg(
  orgId: string,
  options: { now?: Date; lookbackHours?: number } = {},
): Promise<UserRiskSignalEvaluationResult> {
  const flag = await resolveMlFeatureFlagForOrg(orgId, 'ml.user_risk_v0.enabled');
  if (!flag.enabled) {
    return {
      orgId,
      skipped: true,
      appended: 0,
      deduped: 0,
      failed: 0,
      candidates: {
        offHoursMassScripts: 0,
        remoteSessionBursts: 0,
        privilegeElevationBursts: 0,
        newGeographyLogins: 0,
      },
    };
  }

  const now = options.now ?? new Date();
  const lookbackHours = Math.min(Math.max(1, options.lookbackHours ?? DEFAULT_LOOKBACK_HOURS), 168);
  const since = new Date(now.getTime() - lookbackHours * 60 * 60 * 1000);
  const sinceIso = since.toISOString();

  const [scriptRows, remoteRows, elevationRows, newGeographyRows] = await Promise.all([
    db.execute(sql`
      SELECT id AS batch_id, triggered_by AS user_id, script_id, devices_targeted, created_at
      FROM script_execution_batches
      WHERE org_id = ${orgId}
        AND triggered_by IS NOT NULL
        AND trigger_type = 'manual'
        AND devices_targeted >= ${OFF_HOURS_MASS_SCRIPT_TARGETS}
        AND created_at >= ${sinceIso}::timestamptz
        AND (EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC') < 6 OR EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC') >= 20)
    `) as Promise<OffHoursScriptRow[]>,
    db.execute(sql`
      SELECT user_id, count(*)::int AS session_count, max(created_at) AS latest_at
      FROM remote_sessions
      WHERE org_id = ${orgId}
        AND created_at >= ${sinceIso}::timestamptz
      GROUP BY user_id
      HAVING count(*) >= ${REMOTE_SESSION_BURST_COUNT}
    `) as Promise<RemoteSessionBurstRow[]>,
    db.execute(sql`
      SELECT subject_user_id AS user_id,
        count(*)::int AS request_count,
        count(*) FILTER (WHERE status IN ('approved', 'auto_approved', 'actuating'))::int AS approved_count,
        max(requested_at) AS latest_at
      FROM elevation_requests
      WHERE org_id = ${orgId}
        AND subject_user_id IS NOT NULL
        AND requested_at >= ${sinceIso}::timestamptz
      GROUP BY subject_user_id
      HAVING count(*) >= ${ELEVATION_BURST_COUNT}
    `) as Promise<ElevationBurstRow[]>,
    db.execute(sql`
      WITH recent AS (
        SELECT actor_id AS user_id,
          upper(details->>'cfAccessCountry') AS country,
          timestamp
        FROM audit_logs
        WHERE org_id = ${orgId}
          AND actor_type = 'user'
          AND action = 'user.login'
          AND result = 'success'
          AND details->>'method' = 'cf_access_jwt'
          AND details->>'cfAccessCountry' IS NOT NULL
          AND timestamp >= ${sinceIso}::timestamptz
      ),
      history AS (
        SELECT actor_id AS user_id,
          upper(details->>'cfAccessCountry') AS country
        FROM audit_logs
        WHERE org_id = ${orgId}
          AND actor_type = 'user'
          AND action = 'user.login'
          AND result = 'success'
          AND details->>'method' = 'cf_access_jwt'
          AND details->>'cfAccessCountry' IS NOT NULL
          AND timestamp < ${sinceIso}::timestamptz
      )
      SELECT recent.user_id,
        recent.country,
        count(*)::int AS login_count,
        max(recent.timestamp) AS latest_at,
        array_agg(DISTINCT history.country) AS previous_countries
      FROM recent
      JOIN history ON history.user_id = recent.user_id
      WHERE NOT EXISTS (
        SELECT 1
        FROM history same_country
        WHERE same_country.user_id = recent.user_id
          AND same_country.country = recent.country
      )
      GROUP BY recent.user_id, recent.country
    `) as Promise<NewGeographyLoginRow[]>,
  ]);

  let appended = 0;
  let deduped = 0;
  let failed = 0;
  // S4: a single signal append failing must not abort evaluation of the rest of
  // the org's candidates. Count the failure and continue; the count is surfaced
  // in the result (and `appended` stays an honest persisted count).
  const recordSignal = async (build: () => Promise<'appended' | 'deduped'>): Promise<void> => {
    try {
      const result = await build();
      if (result === 'appended') appended += 1;
      else deduped += 1;
    } catch (error) {
      failed += 1;
      console.error(`[UserRiskSignals] Failed to append signal for org ${orgId}:`, error);
    }
  };

  for (const row of scriptRows) {
    const devicesTargeted = toInt(row.devices_targeted);
    const occurredAt = toDate(row.created_at);
    await recordSignal(() => appendDedupedSignal({
      orgId,
      userId: row.user_id,
      eventType: 'script.off_hours_mass_execution',
      severity: devicesTargeted >= 25 ? 'critical' : 'high',
      scoreImpact: Math.min(30, 10 + Math.ceil(devicesTargeted / 5)),
      description: `Off-hours manual script execution targeted ${devicesTargeted} devices`,
      details: {
        fingerprint: `script-off-hours:${row.batch_id}`,
        source: 'script_execution_batches',
        batchId: row.batch_id,
        scriptId: row.script_id,
        devicesTargeted,
        offHoursBasis: 'utc',
      },
      occurredAt,
      sinceIso,
    }));
  }

  for (const row of remoteRows) {
    const count = toInt(row.session_count);
    const latestAt = toDate(row.latest_at);
    const key = windowKey(latestAt, lookbackHours);
    await recordSignal(() => appendDedupedSignal({
      orgId,
      userId: row.user_id,
      eventType: 'remote_session_burst',
      severity: count >= 10 ? 'high' : 'medium',
      scoreImpact: Math.min(24, 6 + count * 2),
      description: `${count} remote sessions started in the last ${lookbackHours} hours`,
      details: {
        fingerprint: `remote-session-burst:${orgId}:${row.user_id}:${key}`,
        source: 'remote_sessions',
        sessionCount: count,
        lookbackHours,
      },
      occurredAt: latestAt,
      sinceIso,
    }));
  }

  for (const row of elevationRows) {
    const requestCount = toInt(row.request_count);
    const approvedCount = toInt(row.approved_count);
    const latestAt = toDate(row.latest_at);
    const key = windowKey(latestAt, lookbackHours);
    await recordSignal(() => appendDedupedSignal({
      orgId,
      userId: row.user_id,
      eventType: 'privilege_elevation_burst',
      severity: approvedCount >= ELEVATION_BURST_COUNT ? 'high' : 'medium',
      scoreImpact: Math.min(28, 8 + requestCount * 4 + approvedCount * 2),
      description: `${requestCount} privilege elevation requests in the last ${lookbackHours} hours`,
      details: {
        fingerprint: `privilege-elevation-burst:${orgId}:${row.user_id}:${key}`,
        source: 'elevation_requests',
        requestCount,
        approvedCount,
        lookbackHours,
      },
      occurredAt: latestAt,
      sinceIso,
    }));
  }

  for (const row of newGeographyRows) {
    const loginCount = toInt(row.login_count);
    const latestAt = toDate(row.latest_at);
    const key = windowKey(latestAt, lookbackHours);
    const previousCountries = Array.isArray(row.previous_countries)
      ? row.previous_countries
      : typeof row.previous_countries === 'string'
        ? row.previous_countries.replace(/[{}"]/g, '').split(',').filter(Boolean)
        : [];
    await recordSignal(() => appendDedupedSignal({
      orgId,
      userId: row.user_id,
      eventType: 'auth.login.new_geography',
      severity: previousCountries.length >= 2 ? 'high' : 'medium',
      scoreImpact: Math.min(24, 10 + previousCountries.length * 3 + loginCount),
      description: `Cloudflare Access login from new country ${row.country}`,
      details: {
        fingerprint: `cf-access-new-country:${orgId}:${row.user_id}:${row.country}:${key}`,
        source: 'audit_logs',
        method: 'cf_access_jwt',
        country: row.country,
        previousCountries,
        loginCount,
        lookbackHours,
      },
      occurredAt: latestAt,
      sinceIso,
    }));
  }

  return {
    orgId,
    skipped: false,
    appended,
    deduped,
    failed,
    candidates: {
      offHoursMassScripts: scriptRows.length,
      remoteSessionBursts: remoteRows.length,
      privilegeElevationBursts: elevationRows.length,
      newGeographyLogins: newGeographyRows.length,
    },
  };
}
