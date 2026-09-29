import { and, eq, sql } from 'drizzle-orm';
import {
  TIME_SYNC_FINDING_SEVERITY,
  timeSyncEnforcementReportSchema,
  type TimeSyncEnforcementState,
} from '@breeze/shared';
import { db } from '../../db';
import { auditLogs } from '../../db/schema';
import { ANONYMOUS_ACTOR_ID } from '../auditEvents';
import { sanitizeAuditPayload } from '../auditPayloadSanitizer';
import type { TimeFindingsContext, TimeSyncFinding } from './findings';

export function readEnforcement(
  value: unknown,
): TimeSyncEnforcementState | null {
  const parsed = timeSyncEnforcementReportSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
export function managementFindings(
  report: TimeSyncEnforcementState | null,
  policyManagedValues: string[],
  settings: TimeFindingsContext['enforcementSettings'],
): TimeSyncFinding[] {
  if (!report || !settings) return [];
  const findings: TimeSyncFinding[] = [];
  const ntp = report.ntp;
  const timezone = report.timezone;
  const ntpFailed =
    settings.enforceNtp &&
    ntp &&
    (ntp.outcome === 'failed' ||
      (ntp.outcome === 'skipped' && ntp.reason === 'role_unknown'));
  const timezoneFailed =
    settings.timezoneAutoFix && timezone?.outcome === 'failed';
  const failed = ntpFailed ? ntp : timezoneFailed ? timezone : null;
  if (failed)
    findings.push({
      code: 'policy_not_applied',
      severity: TIME_SYNC_FINDING_SEVERITY.policy_not_applied,
      detail: {
        kind: ntpFailed ? 'ntp' : 'timezone',
        reason: failed.reason,
        error: failed.error,
      },
    });
  if (settings.enforceNtp && ntp?.reason === 'conflict_gpo') {
    findings.push({
      code: 'policy_conflict_gpo',
      severity: TIME_SYNC_FINDING_SEVERITY.policy_conflict_gpo,
      detail: { values: policyManagedValues.join(',') },
    });
  }
  return findings;
}

/** Called only inside accepted ingest, while its per-device status lock is held. */
export async function auditEnforcement(args: {
  deviceId: string;
  orgId: string;
  previous: TimeSyncEnforcementState | null;
  report: TimeSyncEnforcementState | null;
}): Promise<void> {
  for (const kind of ['ntp', 'timezone'] as const) {
    const result = args.report?.[kind];
    if (!result || result.resultId === args.previous?.[kind]?.resultId)
      continue;
    const [alreadyAudited] = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.orgId, args.orgId),
          eq(auditLogs.resourceId, args.deviceId),
          eq(auditLogs.action, 'time_sync.enforced'),
          sql`${auditLogs.details}->>'kind' = ${kind}`,
          sql`${auditLogs.details}->>'resultId' = ${result.resultId}`,
        ),
      )
      .limit(1);
    if (alreadyAudited) continue;
    await db.insert(auditLogs).values({
      orgId: args.orgId,
      actorType: 'system',
      actorId: ANONYMOUS_ACTOR_ID,
      action: 'time_sync.enforced',
      resourceType: 'device',
      resourceId: args.deviceId,
      initiatedBy: 'agent',
      result: result.outcome === 'failed' ? 'failure' : 'success',
      details: sanitizeAuditPayload({ kind, ...result }) as Record<
        string,
        unknown
      >,
    });
  }
}
