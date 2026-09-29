/**
 * Time-sync monitor handler (W02).
 *
 * Each selected finding code is an independent subject. Its status comes only
 * from the ingest-maintained `finding_streaks` (one step per ACCEPTED snapshot,
 * never per sweep): `present >= N` breaches, `absent >= N` recovers, anything
 * else is `unknown`. A missing or stale status row (freshness is measured on
 * the server clock against `receivedAt`, R18) reports every selected code as
 * `unknown` with `dataAvailable: false`, so open alerts are preserved.
 */
import { eq } from 'drizzle-orm';
import { monitorConditionSchemas, type TimeSyncFindingCode } from '@breeze/shared';
import { db } from '../../../db';
import { deviceTimeStatus } from '../../../db/schema';
import { isTimeStatusStale } from '../../timeSync/freshness';
import type { ConditionHandler } from '../registry';
import type { SubjectEvidence, SubjectStatus } from '../types';

const labels: Record<TimeSyncFindingCode, string> = {
  pdc_no_external_source: 'PDC has no external time source',
  source_local_clock: 'Local clock is the time source',
  dc_vm_host_sync: 'Domain controller uses host time',
  ntp_server_unresolvable: 'Time server name cannot be resolved',
  ntp_peer_unreachable: 'Time peer is unreachable',
  domain_source_unavailable: 'Domain time source is unavailable',
  member_not_on_hierarchy: 'Domain member bypasses the time hierarchy',
  sync_disabled: 'Time synchronization is disabled',
  sync_stale: 'Time sync is stale',
  correction_refused: 'Time correction was refused',
  timezone_mismatch: 'Timezone mismatch',
  policy_not_applied: 'Time policy was not applied',
  policy_conflict_gpo: 'Group Policy manages time settings',
};

export const timeSyncHandler: ConditionHandler = {
  type: 'time_sync',
  async evaluate(condition, deviceId) {
    const { type: _type, ...rest } = condition as Record<string, unknown>;
    const cond = monitorConditionSchemas.time_sync.parse(rest);
    const [row] = await db
      .select()
      .from(deviceTimeStatus)
      .where(eq(deviceTimeStatus.deviceId, deviceId))
      .limit(1);
    const available = Boolean(row && !isTimeStatusStale(row.receivedAt, new Date()));
    const subjects: SubjectEvidence[] = [...new Set(cond.findings)].map((code) => {
      let status: SubjectStatus = 'unknown';
      const streak = row?.findingStreaks?.[code];
      if (available && streak) {
        if (streak.present >= cond.consecutiveSnapshots) status = 'breaching';
        else if (streak.absent >= cond.consecutiveSnapshots) status = 'recovered';
      }
      const detail = row?.findingDetails?.[code] ?? {};
      const findingDetail =
        Object.entries(detail)
          .map(([key, value]) => `${key}: ${value ?? 'unknown'}`)
          .join('; ') || labels[code];
      return {
        subjectKey: code,
        status,
        description: findingDetail,
        context: {
          source: 'time_sync',
          subjectKey: code,
          findingCode: code,
          findingLabel: labels[code],
          findingDetail,
          domainRole: row?.domainRole ?? 'unknown',
          timeSource: row?.source ?? null,
          lastSuccessfulSyncAt: row?.lastSuccessfulSyncAt?.toISOString() ?? null,
        },
      };
    });
    const count = (status: SubjectStatus) => subjects.filter((s) => s.status === status).length;
    return {
      passed: count('breaching') > 0,
      dataAvailable: available,
      subjects,
      description: `${count('breaching')} breaching, ${count('recovered')} recovered, ${count('unknown')} unknown time findings`,
    };
  },
  validate(condition, path) {
    const { type: _type, ...rest } = (condition ?? {}) as Record<string, unknown>;
    const result = monitorConditionSchemas.time_sync.safeParse(rest);
    return result.success
      ? []
      : result.error.issues.map((i) => `${path}.${i.path.join('.')}: ${i.message}`);
  },
};
