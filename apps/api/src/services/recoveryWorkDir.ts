import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// D7: recoveryMediaService.ts / recoveryBootMediaService.ts each build a
// scratch bundle (a 45-65MB helper binary plus a tarball or ISO) under a
// `mkdtemp` directory. The shipped compose files (docker-compose.yml,
// deploy/docker-compose.prod.yml) mount /tmp as a 64MB tmpfs on both the api
// and worker containers, so building straight under `os.tmpdir()` there
// reliably fails with ENOSPC. This resolver picks a scratch base directory
// that actually has room to hold a bundle, in order of preference:
//
//   1. RECOVERY_MEDIA_WORK_DIR, if the operator set one explicitly.
//   2. A `recovery-work` directory under the API's durable data directory.
//      There is no single generic "DATA_DIR" env in this codebase — every
//      subsystem that writes durable on-disk data owns its own env pointing
//      under the shared /data volume (AGENT_BINARY_DIR, VIEWER_BINARY_DIR,
//      BINARY_VERSION_FILE, ...). PATCH_REPORT_STORAGE_PATH is the closest
//      precedent for "a plain directory under that volume" — compose maps it
//      to /data/patch-reports and patchComplianceReportWorker.ts falls back
//      to ./data/patch-reports outside a container — so we derive the root
//      from it rather than inventing a second convention.
//   3. os.tmpdir(), as an explicit last resort. In any deployment using the
//      shipped compose files this candidate almost certainly *is* the 64MB
//      tmpfs, so falling back to it is worth a loud warning rather than a
//      silent choice.
//
// Every persistent candidate is verified writable (mkdir -p, then a
// create+unlink probe file) before being accepted. An unwritable candidate
// is skipped rather than thrown on, so a partially-locked-down environment
// (e.g. RECOVERY_MEDIA_WORK_DIR pointing at a read-only mount) still
// degrades to the next candidate instead of failing the whole resolution.

const DEFAULT_PATCH_REPORT_STORAGE_PATH = './data/patch-reports';
const STALE_SUBDIR_PREFIXES = ['bmr-bundle-', 'recovery-boot-media-'];
const STALE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Best-effort, at most once per process: the sweep is a courtesy cleanup for
// crashed/killed builds, not a correctness requirement, so it's not worth
// paying a readdir + stat-per-entry cost on every bundle/ISO build.
let staleSweepDone = false;

async function isWritableDir(candidate: string): Promise<boolean> {
  try {
    await mkdir(candidate, { recursive: true });
    const probePath = join(candidate, `.recovery-work-probe-${randomUUID()}`);
    await writeFile(probePath, '');
    await unlink(probePath);
    return true;
  } catch {
    return false;
  }
}

function dataDirRecoveryWorkCandidate(): string {
  const patchReportPath = process.env.PATCH_REPORT_STORAGE_PATH || DEFAULT_PATCH_REPORT_STORAGE_PATH;
  return join(dirname(patchReportPath), 'recovery-work');
}

async function sweepStaleWorkDirs(baseDir: string): Promise<void> {
  if (staleSweepDone) return;
  staleSweepDone = true;

  try {
    const entries = await readdir(baseDir, { withFileTypes: true });
    const now = Date.now();
    await Promise.all(
      entries
        .filter(
          (entry) => entry.isDirectory() && STALE_SUBDIR_PREFIXES.some((prefix) => entry.name.startsWith(prefix))
        )
        .map(async (entry) => {
          const fullPath = join(baseDir, entry.name);
          try {
            const stats = await stat(fullPath);
            if (now - stats.mtimeMs > STALE_MAX_AGE_MS) {
              await rm(fullPath, { recursive: true, force: true });
            }
          } catch {
            // Best-effort: ignore races (already removed) or permission
            // errors on an individual stale entry — never block resolution.
          }
        })
    );
  } catch {
    // Best-effort: baseDir may be unreadable for some other reason; the
    // caller still gets a usable (writable, just verified) directory.
  }
}

/**
 * Resolve the scratch base directory recovery bundle/ISO builds should use
 * for `mkdtemp`. See the module comment above for the fallback order and
 * why. Always returns a directory that has been verified to exist and be
 * writable (the os.tmpdir() last resort excepted, which is trusted as-is).
 */
export async function resolveRecoveryWorkDir(): Promise<string> {
  const candidates: string[] = [];
  const envOverride = process.env.RECOVERY_MEDIA_WORK_DIR?.trim();
  if (envOverride) candidates.push(envOverride);
  candidates.push(dataDirRecoveryWorkCandidate());

  for (const candidate of candidates) {
    if (await isWritableDir(candidate)) {
      await sweepStaleWorkDirs(candidate);
      return candidate;
    }
  }

  const fallback = tmpdir();
  console.warn(
    `[recoveryWorkDir] no persistent scratch directory available; falling back to os.tmpdir() (${fallback}). ` +
      'The shipped docker-compose.yml / deploy/docker-compose.prod.yml mount /tmp as a 64MB tmpfs, so a ' +
      'recovery bundle/ISO build (45-65MB+) will likely fail with ENOSPC there. Set RECOVERY_MEDIA_WORK_DIR ' +
      'to a directory on persistent storage to fix this.'
  );
  await sweepStaleWorkDirs(fallback);
  return fallback;
}
