import { classifyBackupFailureDetail, type BackupFailureCause } from '@breeze/shared';
import { normalizeStorageIdentity } from './backupStorageIdentity';

// #11772: is a backup destination (one backup_configs row) failing? Pure: the
// connection-health source (connectionHealth/sources/backupDestination.ts) and
// the backup dashboard's destination item (routes/backup/dashboard.ts) both
// feed it job outcomes and act on the same answer, so the notification and the
// dashboard cannot disagree.
//
// The rule, from the issue's design decisions:
//  - Evidence is terminal jobs completed in the last 72 h on the config's
//    CURRENT storage identity. A config re-pointed at another bucket does not
//    inherit the old bucket's failures; a job never dispatched has no identity
//    and is not evidence either way.
//  - The profile fan-out (file + system image jobs of one run share created_at,
//    see backupJobOrdering.ts) collapses to one occurrence per device and run.
//    A destination failure wins inside an occurrence; otherwise a completed job
//    makes it good; otherwise it is unknown.
//  - A device's state is its latest decisive (good or bad) occurrence. Unknown
//    occurrences (offline, cancelled, non-storage failures) neither prove
//    recovery nor erase earlier evidence.
//  - Broken: two or more failing devices. A destination with decisive evidence
//    from one device only: broken on one explicit refusal or missing
//    destination, otherwise on its last two decisive occurrences both bad.
//  - Healthy only on affirmative evidence: no failing device, and clean
//    occurrences from min(2, decisive devices) devices after the latest
//    destination failure. Anything else is unknown.

export const DESTINATION_LOOKBACK_MS = 72 * 60 * 60 * 1000;

/**
 * Storage causes the failure text ties to the destination itself (#11768). A
 * storage failure with no cause (a Breeze API refusal, an unrecognised store
 * status) or an ended upload session is not evidence that the customer's
 * destination is broken.
 */
export const DESTINATION_FAULT_CAUSES: ReadonlySet<BackupFailureCause> = new Set<BackupFailureCause>([
  'storage_access_denied',
  'storage_not_found',
  'storage_clock_skew',
  'storage_operation_failed',
]);

/** The destination refused outright or is gone: retrying will not fix it, so it opens at once. */
export const PERMANENT_DESTINATION_CAUSES: ReadonlySet<BackupFailureCause> = new Set<BackupFailureCause>([
  'storage_access_denied',
  'storage_not_found',
]);

/** The providerConfig fields normalizeStorageIdentity reads. None is a sealed credential field. */
export const DESTINATION_IDENTITY_FIELDS = ['endpoint', 'bucket', 'bucketName', 'path', 'basePath'] as const;

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'partial', 'completed_with_errors', 'cancelled']);
const UNSUCCESSFUL_STATUSES: ReadonlySet<string> = new Set(['failed', 'partial', 'completed_with_errors']);

export type DestinationJobOutcome = {
  deviceId: string;
  status: string;
  errorLog: string | null;
  createdAt: Date;
  completedAt: Date | null;
  storageIdentity: string | null;
};

export type DestinationOutcome = { outcome: 'good' | 'bad' | 'unknown'; cause: BackupFailureCause | null };

export type BackupDestinationEvaluation = {
  state: 'healthy' | 'broken' | 'unknown';
  /** Set only while broken. */
  severity: 'permanent' | 'transient' | null;
  /** The failing devices' cause when a strict majority agree; otherwise null. */
  cause: BackupFailureCause | null;
  failingDevices: number;
  /** Devices with any terminal outcome on the current identity in the lookback. */
  totalDevices: number;
  /** When the earliest still-failing device's current failure streak began. */
  since: Date | null;
  lastFailureAt: Date | null;
  evidence: {
    decisiveDevices: number;
    cleanDevicesSinceLastFailure: number;
    requiredCleanDevices: number;
    occurrences: number;
  };
};

/** The config's current identity, computed the way dispatch stamps backup_jobs.storage_identity. */
export function currentDestinationIdentity(provider: string, fields: Record<string, unknown>): string {
  const picked: Record<string, unknown> = {};
  for (const key of DESTINATION_IDENTITY_FIELDS) if (key in fields) picked[key] = fields[key];
  return normalizeStorageIdentity(provider, picked);
}

/** One job's verdict on the destination. */
export function classifyDestinationOutcome(job: { status: string; errorLog: string | null | undefined }): DestinationOutcome {
  if (job.status === 'completed') return { outcome: 'good', cause: null };
  if (!UNSUCCESSFUL_STATUSES.has(job.status)) return { outcome: 'unknown', cause: null };
  const { category, cause } = classifyBackupFailureDetail(job);
  if (category === 'storage' && cause && DESTINATION_FAULT_CAUSES.has(cause)) return { outcome: 'bad', cause };
  return { outcome: 'unknown', cause: null };
}

type Occurrence = { at: number; outcome: DestinationOutcome['outcome']; cause: BackupFailureCause | null };

function collapse(jobs: DestinationJobOutcome[]): Occurrence {
  let at = 0;
  let good = false;
  let bad: BackupFailureCause | null = null;
  for (const j of jobs) {
    at = Math.max(at, (j.completedAt ?? j.createdAt).getTime());
    const o = classifyDestinationOutcome(j);
    if (o.outcome === 'good') good = true;
    // An outright refusal outranks another destination cause in the same run.
    if (o.outcome === 'bad' && (bad === null || (!PERMANENT_DESTINATION_CAUSES.has(bad) && PERMANENT_DESTINATION_CAUSES.has(o.cause!)))) bad = o.cause;
  }
  if (bad) return { at, outcome: 'bad', cause: bad };
  return { at, outcome: good ? 'good' : 'unknown', cause: null };
}

function majorityCause(causes: Array<BackupFailureCause | null>): BackupFailureCause | null {
  const tally = new Map<BackupFailureCause, number>();
  for (const c of causes) if (c) tally.set(c, (tally.get(c) ?? 0) + 1);
  for (const [cause, count] of tally) if (count * 2 > causes.length) return cause;
  return null;
}

export function evaluateBackupDestination(input: {
  currentStorageIdentity: string | null;
  jobs: readonly DestinationJobOutcome[];
  now: Date;
}): BackupDestinationEvaluation {
  const cutoff = input.now.getTime() - DESTINATION_LOOKBACK_MS;

  // device → run (created_at) → jobs
  const runs = new Map<string, Map<number, DestinationJobOutcome[]>>();
  for (const j of input.jobs) {
    if (input.currentStorageIdentity === null || j.storageIdentity !== input.currentStorageIdentity) continue;
    if (!TERMINAL_STATUSES.has(j.status) || (j.completedAt ?? j.createdAt).getTime() < cutoff) continue;
    const byRun = runs.get(j.deviceId) ?? new Map<number, DestinationJobOutcome[]>();
    const key = j.createdAt.getTime();
    byRun.set(key, [...(byRun.get(key) ?? []), j]);
    runs.set(j.deviceId, byRun);
  }

  let occurrences = 0;
  let lastFailureAt: number | null = null;
  const decisiveByDevice: Occurrence[][] = [];
  for (const byRun of runs.values()) {
    const occ = [...byRun.values()].map(collapse);
    occurrences += occ.length;
    for (const o of occ) if (o.outcome === 'bad' && (lastFailureAt === null || o.at > lastFailureAt)) lastFailureAt = o.at;
    // Newest first.
    const decisive = occ.filter((o) => o.outcome !== 'unknown').sort((a, b) => b.at - a.at);
    if (decisive.length > 0) decisiveByDevice.push(decisive);
  }

  const failing = decisiveByDevice.filter((d) => d[0]!.outcome === 'bad');
  const failingCauses = failing.map((d) => d[0]!.cause);
  // A failing device's streak runs back over its consecutive bad decisive occurrences.
  const streakStarts = failing.map((d) => {
    let start = d[0]!.at;
    for (const o of d) {
      if (o.outcome !== 'bad') break;
      start = o.at;
    }
    return start;
  });
  const cause = majorityCause(failingCauses);
  const decisiveDevices = decisiveByDevice.length;
  const requiredCleanDevices = Math.min(2, decisiveDevices);
  const cleanDevicesSinceLastFailure = decisiveByDevice.filter((d) => d.some((o) => o.outcome === 'good' && (lastFailureAt === null || o.at > lastFailureAt))).length;

  let state: BackupDestinationEvaluation['state'] = 'unknown';
  if (failing.length >= 2) {
    state = 'broken';
  } else if (decisiveDevices === 1 && failing.length === 1) {
    const only = failing[0]!;
    if (PERMANENT_DESTINATION_CAUSES.has(only[0]!.cause!) || only[1]?.outcome === 'bad') state = 'broken';
  } else if (failing.length === 0 && decisiveDevices > 0 && cleanDevicesSinceLastFailure >= requiredCleanDevices) {
    state = 'healthy';
  }

  return {
    state,
    severity: state === 'broken' ? (cause && PERMANENT_DESTINATION_CAUSES.has(cause) ? 'permanent' : 'transient') : null,
    cause,
    failingDevices: failing.length,
    totalDevices: runs.size,
    since: streakStarts.length > 0 ? new Date(Math.min(...streakStarts)) : null,
    lastFailureAt: lastFailureAt === null ? null : new Date(lastFailureAt),
    evidence: { decisiveDevices, cleanDevicesSinceLastFailure, requiredCleanDevices, occurrences },
  };
}
