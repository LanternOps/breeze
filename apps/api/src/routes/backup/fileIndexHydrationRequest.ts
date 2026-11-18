import { runAfterDbContextExit } from '../../db';
import { captureException } from '../../services/sentry';
import {
  enqueueSnapshotFileIndexHydration,
  type SnapshotFileIndexHydrationReason,
} from '../../jobs/backupSnapshotFileIndexWorker';

/**
 * Ask for a snapshot's file index to be built from its manifest once the
 * request's DB context has settled (#11026), as backupResultPersistence does:
 * the queue request is several Redis round trips and must not hold a pooled
 * connection. It is idempotent (snapshot-scoped job id) and best effort: a
 * failure is logged and the request still answers, because the person is shown
 * the index state either way, and the next read asks again.
 */
export function requestFileIndexHydrationAfterContext(
  snapshotDbId: string,
  reason: SnapshotFileIndexHydrationReason,
): void {
  runAfterDbContextExit('backup.fileIndex.requestHydration', async () => {
    try {
      await enqueueSnapshotFileIndexHydration(snapshotDbId, reason);
    } catch (err) {
      console.error(`[backup] Failed to request file-index hydration for snapshot ${snapshotDbId} (${reason}):`, err);
      // The person keeps seeing "preparing" while the queue is down; make the
      // outage itself visible.
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
