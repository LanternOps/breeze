/**
 * Expired-snapshot cleanup run: row-level retention for every org, then one
 * mark-and-sweep pass over backup storage.
 *
 * Runs on its own queue and worker (backupSnapshotCleanupWorker.ts), never on
 * the shared `backup` queue: a run over large manifests can take longer than
 * the schedule interval, and on the shared 5-slot worker it held every slot
 * that backup dispatch, result processing and schedule checks need (#12061).
 *
 * A run can be bounded (#12061): retention stops between orgs once
 * `retentionDeadlineMs` passes, and the storage sweep stops between storage
 * identities once `gcDeadlineMs` passes. Each phase reports where it stopped
 * through `saveCursors`, and the next run resumes there and wraps around, so
 * one slow org or bucket cannot hold back the ones after it run after run.
 */

import * as dbModule from '../db';
import { backupSnapshots } from '../db/schema';
import { cleanupExpiredSnapshots, sweepUnreferencedBackupObjects } from './backupRetention';
import { captureException } from '../services/sentry';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

export type BackupSnapshotCleanupCursors = {
  // The org id the next run's retention phase starts at; null = from the first org.
  retention: string | null;
  // The storage sweep's resume cursor; null = from the first storage identity.
  gc: string | null;
};

export type BackupSnapshotCleanupOptions = {
  retentionDeadlineMs?: number;
  gcDeadlineMs?: number;
  retentionCursor?: string | null;
  gcCursor?: string | null;
  // Called once per run with where the next run should resume, before the
  // run fails for a per-row delete failure, so a failed run still advances.
  saveCursors?: (cursors: BackupSnapshotCleanupCursors) => Promise<void>;
};

export type BackupSnapshotCleanupResult = {
  deleted: number;
  skipped: number;
  prunedByMaxVersions: number;
  // D17: rows whose DELETE was rejected by the DB (per-row isolated in
  // cleanupExpiredSnapshots — see backupRetention.ts) across every org this
  // run. Non-zero triggers the throw at the very end of the run, AFTER the
  // GC sweep has already run.
  failed: number;
  gcDeleted: number;
  // GC's unit of work is a storage identity (possibly several backupConfigs
  // rows sharing one bucket), not a single "destination" row.
  gcSkippedIdentities: number;
  // Subset of gcSkippedIdentities that fail-closed on an unfetchable
  // manifest — the distinct signal of a possible non-self-healing storage leak.
  gcBlockedIdentities: number;
  // D18 W02: retirement rows CONFIRMED fully swept from storage this run
  // (durable, via swept_at).
  gcRetiredSwept: number;
  // D18 W02: abandoned orphan-manifest prefixes reclaimed this run
  // (best-effort observability metric, no DB row to confirm against).
  gcOrphansSwept: number;
  // D18 W02: identities that ran today's (pre-D18) algorithm only this run
  // (legacy helper and/or unresolved NULL-storage_identity rows).
  gcDeferredIdentities: number;
  // D18 W02: storage_identity values with rows but no current config
  // producing them (visibility only).
  gcUnreachableIdentities: number;
  // #12061: orgs left for the next run because the retention deadline passed.
  // Absent when every org ran.
  retentionDeferredOrgs?: number;
};

/** Orgs in id order, starting at `cursor` (when it is still present) and wrapping around. */
function orgsInRunOrder(orgIds: string[], cursor: string | null | undefined): string[] {
  const sorted = [...new Set(orgIds)].sort();
  if (!cursor) return sorted;
  const start = sorted.findIndex((orgId) => orgId >= cursor);
  if (start <= 0) return sorted;
  return [...sorted.slice(start), ...sorted.slice(0, start)];
}

export async function processCleanupExpiredSnapshots(
  options: BackupSnapshotCleanupOptions = {},
): Promise<BackupSnapshotCleanupResult> {
  // D18 §3.7: this whole function runs with NO ambient DB context (the worker
  // calls it directly, outside any blanket wrap) — the read below and
  // cleanupExpiredSnapshots's own per-row work each open their OWN context
  // explicitly.
  const orgRows = await runWithSystemDbAccess(() =>
    db.selectDistinct({ orgId: backupSnapshots.orgId }).from(backupSnapshots)
  );
  const orgIds = orgsInRunOrder(orgRows.map((row) => row.orgId), options.retentionCursor);

  let deleted = 0;
  let skipped = 0;
  let prunedByMaxVersions = 0;
  let failed = 0;
  let retentionCursor: string | null = null;
  let retentionDeferredOrgs = 0;
  // Orgs whose whole retention pass threw (distinct from per-row `failed`).
  let orgsFailed = 0;

  for (const [index, orgId] of orgIds.entries()) {
    // #12061: stop between orgs once the retention deadline passes. The first
    // org always runs, so a run makes progress however small the budget.
    if (index > 0 && options.retentionDeadlineMs !== undefined && Date.now() >= options.retentionDeadlineMs) {
      retentionCursor = orgId;
      retentionDeferredOrgs = orgIds.length - index;
      console.log(
        `[BackupWorker] cleanup-expired-snapshots: retention time budget spent after ${index} of ${orgIds.length} ` +
        'org(s) — the next run resumes at the next org',
      );
      break;
    }
    // cleanupExpiredSnapshots (backupRetention.ts) opens its OWN per-
    // candidate-row system context internally — deliberately NOT wrapped
    // here, so each row's retirement-insert + delete commits independently
    // of every other row and of the sweep below.
    let result: Awaited<ReturnType<typeof cleanupExpiredSnapshots>>;
    try {
      result = await cleanupExpiredSnapshots(orgId);
    } catch (err) {
      // One org's unexpected failure (its rows are isolated per row already;
      // this is e.g. its candidate query failing) must not hold back every
      // org after it, or the sweep. Counted as a failure, so the run still
      // fails at the end (D17).
      console.error(`[BackupWorker] cleanup-expired-snapshots: retention failed for org ${orgId}:`, err);
      captureException(err instanceof Error ? err : new Error(String(err)));
      orgsFailed += 1;
      continue;
    }
    deleted += result.deleted;
    skipped += result.skippedLegalHold + result.skippedImmutable;
    prunedByMaxVersions += result.prunedByMaxVersions;
    failed += result.failed;
  }

  // Mark-and-sweep GC runs ONCE per retention cycle, after row-level
  // retention has finished — not per-org, since a destination's live set
  // spans every retained snapshot regardless of which org iteration deleted
  // rows (see backupRetention.ts's deleteSnapshotRow: row deletion no longer
  // touches object storage at all; GC is the only thing that does). A GC
  // failure must never fail this job: row-level retention already
  // succeeded, and BullMQ would otherwise retry/re-log the whole run over an
  // unrelated object-storage problem.
  //
  // D18 §3.7 (W02): the call is BARE, at depth 0 — no ambient DB context.
  // sweepUnreferencedBackupObjects (backupRetention.ts) opens its own short
  // per-identity withSystemDbAccessContext calls internally and makes every
  // storage (list/fetch/delete) call outside any held context; wrapping the
  // whole call in one context here would defeat that split and pin a pooled
  // connection across every identity's storage I/O.
  // assertOutsideHeldDbContext inside sweepStorageIdentity is the runtime
  // tripwire for this invariant.
  let gcDeleted = 0;
  let gcSkippedIdentities = 0;
  let gcBlockedIdentities = 0;
  let gcRetiredSwept = 0;
  let gcOrphansSwept = 0;
  let gcDeferredIdentities = 0;
  let gcUnreachableIdentities = 0;
  // A sweep that throws keeps the previous place, so the next run retries it.
  let gcCursor: string | null = options.gcCursor ?? null;
  try {
    const gcResult = await sweepUnreferencedBackupObjects({
      deadlineMs: options.gcDeadlineMs,
      resumeCursor: options.gcCursor ?? null,
    });
    gcDeleted = gcResult.deleted;
    gcSkippedIdentities = gcResult.skippedIdentities;
    gcBlockedIdentities = gcResult.blockedIdentities;
    gcRetiredSwept = gcResult.retiredSwept;
    gcOrphansSwept = gcResult.orphansSwept;
    gcDeferredIdentities = gcResult.deferredIdentities;
    gcUnreachableIdentities = gcResult.unreachableIdentities;
    gcCursor = gcResult.resumeCursor ?? null;
  } catch (err) {
    console.error('[BackupWorker] Backup object GC sweep failed — retention run still succeeded:', err);
    captureException(err instanceof Error ? err : new Error(String(err)));
  }

  if (options.saveCursors) {
    // A failed save leaves the previous cursors in place (or none), so the
    // next run repeats some work: slower, never wrong. A Redis hiccup here
    // must not fail a run whose work already committed.
    try {
      await options.saveCursors({ retention: retentionCursor, gc: gcCursor });
    } catch (err) {
      console.error('[BackupWorker] cleanup-expired-snapshots: could not save resume cursors:', err);
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // D17: a per-row DELETE failure must not be swallowed — it has to surface
  // as a failed BullMQ job so it's visible in the worker's failed-job log and
  // dashboards, not just in the Sentry capture cleanupExpiredSnapshots already
  // made per org. This throw is deliberately the LAST thing in this function,
  // after both row-level retention AND the GC sweep above have already run to
  // completion — a job whose retention had partial failures must not also
  // block that run's object-storage reclamation.
  if (failed > 0 || orgsFailed > 0) {
    const parts = [
      ...(failed > 0 ? [`${failed} snapshot row delete(s) failed this run`] : []),
      ...(orgsFailed > 0 ? [`retention failed for ${orgsFailed} org(s)`] : []),
    ];
    throw new Error(
      `[BackupWorker] cleanup-expired-snapshots: ${parts.join('; ')} — ` +
      'see prior [BackupRetention] / [BackupWorker] error logs for detail; they will be retried next run.'
    );
  }

  return {
    deleted, skipped, prunedByMaxVersions, failed,
    gcDeleted, gcSkippedIdentities, gcBlockedIdentities,
    gcRetiredSwept, gcOrphansSwept, gcDeferredIdentities, gcUnreachableIdentities,
    ...(retentionDeferredOrgs > 0 ? { retentionDeferredOrgs } : {}),
  };
}
