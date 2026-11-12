import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../../db';
import {
  DESTINATION_IDENTITY_FIELDS,
  DESTINATION_LOOKBACK_MS,
  classifyDestinationOutcome,
  currentDestinationIdentity,
  evaluateBackupDestination,
  type BackupDestinationEvaluation,
  type DestinationJobOutcome,
} from '../../backupDestinationHealth';
import { backupDestinationHealth } from '../../integrationStates';
import { PERMISSIONS } from '../../permissions';
import { cleanDisplayName } from '../sanitize';
import type { HealthObservation, HealthSource } from '../types';
import { toHealthObservation, validUuids } from './observeRows';

// Backup destinations (#11772): one incident per backup_configs row, org-scoped,
// when the devices backing up to it fail on the destination itself. The verdict
// is the shared evaluator's (services/backupDestinationHealth.ts), the same one
// the backup dashboard's destination item uses.
//
// Two reads, both index-backed (migration 2027-01-24-100000):
//   broken:   backup_jobs_unsuccessful_completed_at_idx (completed_at, config_id)
//             WHERE status IN ('failed', 'partial', 'completed_with_errors').
//             The unsuccessful jobs of active configs in the lookback; the
//             evaluator's classifier picks the destination faults in
//             TypeScript (the cause is read from error_log text, and one
//             classifier means the SQL cannot drift from it).
//   evidence: backup_jobs_config_completed_at_idx (config_id, completed_at),
//             every terminal outcome (successes included: recovery is
//             affirmative) of the candidate and tracked configs.
// A config that is deleted is absent (the reconciler retires it); one that is
// disabled reports retired.

const FIX_HREF = '/backup#profiles';
/** Configs per evidence read, so one large outage never loads every job at once. */
const LOAD_CHUNK = 100;

const UNSUCCESSFUL = sql.raw(`('failed', 'partial', 'completed_with_errors')`);
const TERMINAL = sql.raw(`('completed', 'failed', 'partial', 'completed_with_errors', 'cancelled')`);
const IDENTITY_FIELDS = sql.raw(
  `jsonb_build_object(${DESTINATION_IDENTITY_FIELDS.map((f) => `'${f}', c.provider_config -> '${f}'`).join(', ')})`,
);

export type BackupDestinationRow = {
  id: string;
  orgId: string;
  partnerId: string;
  name: string;
  isActive: boolean;
  createdAt: Date;
  currentStorageIdentity: string;
  jobs: DestinationJobOutcome[];
};

const lookbackStart = (now: Date) => new Date(now.getTime() - DESTINATION_LOOKBACK_MS).toISOString();

/** What the destination answered, in words an admin can act on. Never the raw store text. */
const CAUSE_ADVICE: Readonly<Record<string, string>> = {
  storage_access_denied: "The destination refused the request: check the access key, the bucket policy and the storage account's standing, then run Test connection.",
  storage_not_found: 'The destination says the bucket or its backup data is missing: check that the bucket still exists and that no lifecycle rule deletes backup data, then run Test connection.',
  storage_clock_skew: 'The destination rejected the time on the requests: check the date and time on the failing devices.',
  storage_operation_failed: "The destination did not complete storage operations: check the storage provider's status, then run Test connection.",
};
const DEFAULT_ADVICE = 'Backups to this destination are failing on the storage side: check the destination settings, then run Test connection.';

export function destinationHealthDetail(e: BackupDestinationEvaluation): string | null {
  if (e.state !== 'broken' || !e.since) return null;
  const since = `${e.since.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const devices = e.totalDevices === 1 ? 'device' : 'devices';
  return `${e.failingDevices} of ${e.totalDevices} ${devices} failing since ${since}. ${(e.cause && CAUSE_ADVICE[e.cause]) ?? DEFAULT_ADVICE}`;
}

export function backupDestinationObservation(row: BackupDestinationRow, now: Date): HealthObservation {
  const evaluation = evaluateBackupDestination({ currentStorageIdentity: row.currentStorageIdentity, jobs: row.jobs, now });
  return toHealthObservation({
    kind: 'backup_destination',
    verdict: backupDestinationHealth({ isActive: row.isActive, state: evaluation.state, cause: evaluation.cause }),
    now,
    createdAt: row.createdAt,
    sourceId: row.id,
    partnerId: row.partnerId,
    orgId: row.orgId,
    displayName: cleanDisplayName(`Backup destination ${row.name}`, 'Backup destination'),
    rawDetail: destinationHealthDetail(evaluation),
    fixHref: FIX_HREF,
    viewPermission: PERMISSIONS.BACKUP_READ,
    repairPermission: PERMISSIONS.BACKUP_WRITE,
  });
}

/**
 * Unsuccessful jobs of active configs completed inside the lookback: the
 * candidate superset. observe() classifies them with the evaluator's own
 * classifyDestinationOutcome and loads full evidence only for configs with a
 * destination fault, so offline devices and other non-destination failures
 * (the common case) never pull a config's whole job history. The status list
 * and the cast are literal so the planner matches the partial index.
 */
function brokenDestinationsQuery(now: Date): SQL {
  return sql`
    SELECT j.config_id, j.status::text AS status, j.error_log
    FROM backup_jobs j
    JOIN backup_configs c ON c.id = j.config_id AND c.is_active
    WHERE j.status IN ${UNSUCCESSFUL}
      AND j.completed_at >= ${lookbackStart(now)}::timestamptz`;
}

const idList = (ids: string[]) => sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);

/** The configs by id, with the partner via the org. Only the identity fields of provider_config are read, never a credential. */
export function destinationConfigsQuery(ids: string[]): SQL {
  return sql`
    SELECT c.id, c.org_id, o.partner_id, c.name, c.is_active, c.created_at, c.provider::text AS provider,
      ${IDENTITY_FIELDS} AS identity_fields
    FROM backup_configs c
    JOIN organizations o ON o.id = c.org_id
    WHERE c.id IN (${idList(ids)})`;
}

/** Every terminal outcome of the given configs inside the lookback. */
export function destinationJobsQuery(ids: string[], now: Date): SQL {
  return sql`
    SELECT j.config_id, j.device_id, j.status::text AS status, j.error_log, j.created_at, j.completed_at, j.storage_identity
    FROM backup_jobs j
    WHERE j.config_id IN (${idList(ids)})
      AND j.completed_at >= ${lookbackStart(now)}::timestamptz
      AND j.status IN ${TERMINAL}`;
}

type ConfigDbRow = {
  id: string; org_id: string; partner_id: string; name: string; is_active: boolean;
  created_at: Date | string; provider: string; identity_fields: Record<string, unknown> | null;
};
type JobDbRow = {
  config_id: string; device_id: string; status: string; error_log: string | null;
  created_at: Date | string; completed_at: Date | string | null; storage_identity: string | null;
};

async function loadDestinations(ids: string[], now: Date): Promise<BackupDestinationRow[]> {
  const out: BackupDestinationRow[] = [];
  for (let i = 0; i < ids.length; i += LOAD_CHUNK) {
    const chunk = ids.slice(i, i + LOAD_CHUNK);
    const configs = (await db.execute(destinationConfigsQuery(chunk))) as unknown as ConfigDbRow[];
    if (configs.length === 0) continue;
    const jobs = (await db.execute(destinationJobsQuery(configs.map((c) => c.id), now))) as unknown as JobDbRow[];
    const byConfig = new Map<string, DestinationJobOutcome[]>();
    for (const j of jobs) {
      const list = byConfig.get(j.config_id) ?? [];
      list.push({
        deviceId: j.device_id,
        status: j.status,
        errorLog: j.error_log,
        createdAt: new Date(j.created_at),
        completedAt: j.completed_at === null ? null : new Date(j.completed_at),
        storageIdentity: j.storage_identity,
      });
      byConfig.set(j.config_id, list);
    }
    for (const c of configs) {
      out.push({
        id: c.id,
        orgId: c.org_id,
        partnerId: c.partner_id,
        name: c.name,
        isActive: c.is_active,
        createdAt: new Date(c.created_at),
        currentStorageIdentity: currentDestinationIdentity(c.provider, c.identity_fields ?? {}),
        jobs: byConfig.get(c.id) ?? [],
      });
    }
  }
  return out;
}

export const backupDestinationSource: HealthSource = {
  kind: 'backup_destination',
  intervalMinutes: 15,
  tables: ['backup_configs', 'backup_jobs'],
  fixHrefs: [FIX_HREF],
  brokenQuery: brokenDestinationsQuery,
  async observe(now, trackedSourceIds) {
    const failures = (await db.execute(brokenDestinationsQuery(now))) as unknown as Array<{ config_id: string; status: string; error_log: string | null }>;
    const candidates = failures
      .filter((f) => classifyDestinationOutcome({ status: f.status, errorLog: f.error_log }).outcome === 'bad')
      .map((f) => f.config_id);
    const tracked = new Set(trackedSourceIds);
    const ids = validUuids([...candidates, ...trackedSourceIds]);
    const observations: HealthObservation[] = [];
    for (const row of await loadDestinations(ids, now)) {
      const o = backupDestinationObservation(row, now);
      // Spec §1.3: an untracked config matters only while broken.
      if (o.state === 'broken' || tracked.has(o.sourceId)) observations.push(o);
    }
    return observations;
  },
};
