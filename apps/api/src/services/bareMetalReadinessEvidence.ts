// Bare-metal W08: recovery-readiness evidence from real rebuild outcomes.
//
// Reads terminal `bare_metal_recoveries` rows (existing columns only) and
// turns them into a measured RTO and risk factors that the generic readiness
// calculator merges into `recovery_readiness`. A recovery that never ran has
// no evidence — this module reports "no evidence", never a synthetic pass.
import { and, desc, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { bareMetalRecoveries } from '../db/schema';
import type { RecoveryRiskFactor } from '../routes/backup/types';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
export const BARE_METAL_EVIDENCE_WINDOW = 10;
/** A last successful rebuild older than this no longer proves recovery works. */
export const BARE_METAL_STALE_DAYS = 90;
/** Measured rebuild duration above this is reported as an RTO risk. */
export const BARE_METAL_RTO_TARGET_MINUTES = 60;

const SUCCESS_STATUSES = new Set(['checked_in', 'completed']);

export type BareMetalEvidenceRow = {
  status: string;
  identity: 'original' | 'new' | string;
  platform: string | null;
  drExecutionId: string | null;
  executingDeviceId: string | null;
  createdAt: Date;
  restoringAt: Date | null;
  validatedAt: Date | null;
  completedAt: Date | null;
};

export type BareMetalEvidenceSummary = {
  hasEvidence: boolean;
  successCount: number;
  failureCount: number;
  latestFailed: boolean;
  rehearsalSuccessCount: number;
  productionSuccessCount: number;
  /** Slowest measured rebuild (restoring → validated) among recent successes, whole minutes; null with no measurement. */
  measuredRtoMinutes: number | null;
  lastSuccessAt: Date | null;
  riskFactors: RecoveryRiskFactor[];
};

/** Rebuild-host / DR runs are rehearsals; boot-media recoveries have neither. */
function isRehearsal(row: BareMetalEvidenceRow): boolean {
  return row.drExecutionId !== null || row.executingDeviceId !== null;
}

function rebuildMinutes(row: BareMetalEvidenceRow): number | null {
  const end = row.validatedAt ?? row.completedAt;
  if (!row.restoringAt || !end) return null;
  const ms = end.getTime() - row.restoringAt.getTime();
  return ms > 0 ? Math.ceil(ms / MINUTE_MS) : null;
}

export function summarizeBareMetalEvidence(rows: BareMetalEvidenceRow[], now: number): BareMetalEvidenceSummary {
  // `refused` is the engine declining before touching a disk (wrong target,
  // integrity gate) — neither proof of recovery nor a failed one. In-flight
  // rows are neutral for the same reason a running verification is.
  const settled = rows
    .filter((row) => SUCCESS_STATUSES.has(row.status) || row.status === 'failed')
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const successes = settled.filter((row) => SUCCESS_STATUSES.has(row.status));
  const failures = settled.filter((row) => row.status === 'failed');
  const latestFailed = settled[0]?.status === 'failed';

  const minutes = successes.map(rebuildMinutes).filter((m): m is number => m !== null);
  const measuredRtoMinutes = minutes.length > 0 ? Math.max(...minutes) : null;

  const lastSuccess = successes[0];
  const lastSuccessAt = lastSuccess ? (lastSuccess.completedAt ?? lastSuccess.validatedAt ?? lastSuccess.createdAt) : null;

  const riskFactors: RecoveryRiskFactor[] = [];
  if (latestFailed) {
    riskFactors.push({
      code: 'bare_metal_recovery_failed',
      severity: 'high',
      message: 'The most recent bare-metal rebuild failed.',
    });
  } else if (failures.length > 0) {
    riskFactors.push({
      code: 'bare_metal_recovery_failed',
      severity: 'medium',
      message: `${failures.length} recent bare-metal rebuild(s) failed before the latest success.`,
    });
  }
  if (lastSuccessAt && (now - lastSuccessAt.getTime()) > BARE_METAL_STALE_DAYS * DAY_MS) {
    riskFactors.push({
      code: 'bare_metal_rehearsal_stale',
      severity: 'medium',
      message: `The last successful bare-metal rebuild is ${Math.floor((now - lastSuccessAt.getTime()) / DAY_MS)} day(s) old.`,
    });
  }
  if (measuredRtoMinutes !== null && measuredRtoMinutes > BARE_METAL_RTO_TARGET_MINUTES) {
    riskFactors.push({
      code: 'bare_metal_rto_above_target',
      severity: 'medium',
      message: `The slowest recent bare-metal rebuild took ${measuredRtoMinutes} minute(s).`,
    });
  }

  return {
    hasEvidence: settled.length > 0,
    successCount: successes.length,
    failureCount: failures.length,
    latestFailed,
    rehearsalSuccessCount: successes.filter(isRehearsal).length,
    productionSuccessCount: successes.filter((row) => !isRehearsal(row)).length,
    measuredRtoMinutes,
    lastSuccessAt,
    riskFactors,
  };
}

/** Loads the device's most recent settled rebuilds under system scope (readiness is recomputed from workers and routes alike). */
export async function loadBareMetalEvidence(orgId: string, deviceId: string, now: number = Date.now()): Promise<BareMetalEvidenceSummary> {
  const rows = await withSystemDbAccessContext(() => db
    .select({
      status: bareMetalRecoveries.status,
      identity: bareMetalRecoveries.identity,
      platform: bareMetalRecoveries.platform,
      drExecutionId: bareMetalRecoveries.drExecutionId,
      executingDeviceId: bareMetalRecoveries.executingDeviceId,
      createdAt: bareMetalRecoveries.createdAt,
      restoringAt: bareMetalRecoveries.restoringAt,
      validatedAt: bareMetalRecoveries.validatedAt,
      completedAt: bareMetalRecoveries.completedAt,
    })
    .from(bareMetalRecoveries)
    .where(and(
      eq(bareMetalRecoveries.orgId, orgId),
      eq(bareMetalRecoveries.deviceId, deviceId),
      inArray(bareMetalRecoveries.status, ['checked_in', 'completed', 'failed']),
      // An operator cancelling a pending recovery is not a failed rebuild.
      or(isNull(bareMetalRecoveries.failureReason), ne(bareMetalRecoveries.failureReason, 'cancelled')),
    ))
    .orderBy(desc(bareMetalRecoveries.createdAt))
    .limit(BARE_METAL_EVIDENCE_WINDOW));
  return summarizeBareMetalEvidence(rows, now);
}
