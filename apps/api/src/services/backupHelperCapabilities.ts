import { compareAgentVersions, parseComparableVersion } from './agentEditionCompat';

/**
 * First breeze-backup helper release that implements the per-device execution
 * queue protocol (#4923): `{"queued":true}` admission, `queued`/`starting`
 * progress phases, and job-targeted `backup_stop {jobId}`.
 *
 * Older helpers execute every dispatched workload concurrently and treat any
 * `backup_stop` as device-wide, so callers that rely on the queue must keep
 * the pre-queue server-side behaviour for devices below this version.
 */
export const BACKUP_QUEUE_MIN_HELPER_VERSION = '0.110.0';

/**
 * True when `devices.backup_version` reports a helper that serializes
 * workloads itself. Unknown, unparseable, or missing versions are treated as
 * NOT capable (conservative: fall back to server-side per-mode dedupe).
 */
export function backupHelperSupportsQueue(version: string | null | undefined): boolean {
  if (!version) return false;
  if (!parseComparableVersion(version)) return false;
  return compareAgentVersions(version, BACKUP_QUEUE_MIN_HELPER_VERSION) >= 0;
}

/**
 * First breeze-backup helper release that supports server-owned dedupe base
 * selection (D18 W01/W02): the server picks and leases the incremental base,
 * the agent downloads it by id, and the agent itself never deletes remote
 * objects. Older helpers still list the bucket to choose a base and still
 * prune remotely on retention, so GC's unrooted-prefix reclamation (retired +
 * orphan-past-window deletion) must stay disabled on any identity still
 * serving a helper below this version — see
 * apps/api/src/jobs/backupRetention.ts's capability gate.
 */
export const BACKUP_SERVER_BASE_MIN_HELPER_VERSION = '0.112.0';

/**
 * True when `devices.backup_version` reports a helper new enough to trust
 * with unrooted-prefix GC reclamation. Unknown, unparseable, or missing
 * versions are treated as NOT capable (conservative: legacy behavior).
 */
export function backupHelperSupportsServerBase(version: string | null | undefined): boolean {
  if (!version) return false;
  if (!parseComparableVersion(version)) return false;
  return compareAgentVersions(version, BACKUP_SERVER_BASE_MIN_HELPER_VERSION) >= 0;
}
