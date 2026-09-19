/**
 * Execution plane W04 — the sandbox's fixed shape, its fixed paths, and the
 * region assertion.
 *
 * A LEAF module on purpose: it imports `config/env` and this wave's error type
 * and nothing else. `workspaceService.ts` (which reaches the database, the
 * artifact store and the tool-output compactor) re-exports everything here, so
 * a caller that only needs a path constant or `deploymentRegion()` —
 * `workspaceTools.ts` for its tool descriptions, `runService.ts` for the
 * admission-time residency check — does not drag the run loop's whole
 * dependency graph into its own import closure. That mattered in practice:
 * pulling `workspaceService` into `aiTools.ts` put `../../db` behind every
 * tool-registry import and broke two dozen suites' partial db mocks, and put
 * socket-local route modules inside the sweep scheduler's worker closure
 * (`workerEntrypointClosure.contract.test.ts`).
 */
import type { BlobRegion } from '../artifacts/blobStorage';
import { breezeRegion } from '../../config/env';
import { WorkspaceToolError } from './workspaceErrors';

// v1 fixed sandbox shape (spec §5.1). `memGb` is what compute pricing bills.
export const WORKSPACE_CPU = 1 as const;
export const WORKSPACE_MEMORY_MB = 2048 as const;
export const WORKSPACE_MEMORY_GB = WORKSPACE_MEMORY_MB / 1024;
/** Legacy bootstrap revision. Actual provider image is recorded separately as runtimeImage. */
export const WORKSPACE_BOOTSTRAP_IMAGE = 'breeze-analysis@sha256:bootstrap-v1';
export const WORKSPACE_BOOTSTRAP_HASH = 'bootstrap-v1';

export const WORKSPACE_IN_DIR = '/work/in';
export const WORKSPACE_OUT_DIR = '/work/out';
export const WORKSPACE_TMP_DIR = '/work/tmp';

/** Provider-side deadline = remaining run wall clock + this (spec §5.4). */
export const WORKSPACE_DEADLINE_GRACE_SECONDS = 60;
export const WORKSPACE_MAX_STAGED_FILES = 200;
export const WORKSPACE_MAX_COLLECT_FILES = 50;
export const WORKSPACE_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const WORKSPACE_STDOUT_MAX_BYTES = 1024 * 1024;

/**
 * The region THIS deployment serves. Each region is its own droplet, its own
 * Postgres and its own blob bucket, so the org's region and the deployment's
 * are the same value by construction — `ensure` asserts it anyway, because
 * spec §8 makes "analysis code executes in <region>" a customer-facing claim
 * and a mis-set env var is exactly how that claim would quietly become false.
 *
 * `breezeRegion()` is W01's canonical resolver over env `BREEZE_REGION`
 * (config/env.ts). Wrapped rather than inlined so this wave has ONE region
 * decision and so the typed refusal below is the same shape as every other
 * workspace failure — a bad env var must reach the model as `region_mismatch`,
 * not as a raw TypeError.
 */
export function deploymentRegion(): BlobRegion {
  const raw = String(breezeRegion() ?? '').trim().toLowerCase();
  if (raw !== 'eu' && raw !== 'us') {
    throw new WorkspaceToolError('region_mismatch', 'This deployment has no valid region configured.');
  }
  return raw;
}
