import { readFile } from 'fs/promises';
import { getBinariesVersion, getBinarySource } from './binarySource';

/**
 * Which agent build a BINARY_SOURCE=local server can actually serve (#7516).
 *
 * Local mode holds ONE build per (component, os, arch): the files in the
 * binaries volume, mirrored to S3 under unversioned keys. The download route
 * streams (or presigns) those bytes for every request, because the agent's
 * download URL carries no version in local mode (agentVersions.ts,
 * downloadUrlVersionPin). So an upgrade offer naming any OTHER version is
 * unsatisfiable by construction: the agent fetches the offered version's
 * checksum, downloads the volume's bytes, and fails checksum verification —
 * on every heartbeat, forever.
 *
 * That is the normal deploy-before-promote window under AGENT_AUTO_PROMOTE=false
 * (new binaries deployed, fleet target still the previous release), and on
 * 2026-09-29 it saturated the US API. The heartbeat now withholds such offers
 * (routes/agents/helpers.ts resolvePinnedUpgradeTarget[s]); the device idles on
 * its current version until the operator promotes the build this server holds.
 *
 * GitHub mode serves per-version release assets (the download URL is pinned to
 * the offered version, #5159), so every registered target is servable there.
 */

/**
 * How long a read of the VERSION file is reused. The resolvers run on every
 * heartbeat; a recreated binaries-init container is picked up within this
 * window without an API restart.
 */
const BUILD_VERSION_CACHE_TTL_MS = 60_000;
/**
 * A configured VERSION file that could not be read (e.g. mid-recreate of the
 * binaries volume) yields the env fallback, which may not describe the disk;
 * keep that answer only briefly so the file is retried soon.
 */
const FALLBACK_CACHE_TTL_MS = 5_000;

let cached: { value: string | null; readAt: number; ttlMs: number } | null = null;
const warnedUnreadableFiles = new Set<string>();
const warnedWithheld = new Set<string>();

/** Test-only: clear the cached build version and the once-per-key warn dedupe. */
export function __resetLocalBinaryBuildForTests(): void {
  cached = null;
  warnedUnreadableFiles.clear();
  warnedWithheld.clear();
}

function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/, '');
}

async function readBuildVersion(): Promise<{ value: string | null; ttlMs: number }> {
  // The VERSION file is written by binaries-init alongside the binaries, and
  // binarySync registers every local agent_versions row under its content —
  // it describes the bytes on disk. The env (BINARY_VERSION / paired /
  // BREEZE_VERSION) describes what the operator INTENDED, which differs from
  // the disk exactly when the volume is stale; prefer the disk.
  const versionFile = process.env.BINARY_VERSION_FILE?.trim();
  let ttlMs = BUILD_VERSION_CACHE_TTL_MS;
  if (versionFile) {
    try {
      const content = (await readFile(versionFile, 'utf-8')).trim();
      if (content && content !== 'unknown') {
        return { value: normalizeVersion(content), ttlMs };
      }
    } catch (err) {
      ttlMs = FALLBACK_CACHE_TTL_MS;
      if (!warnedUnreadableFiles.has(versionFile)) {
        warnedUnreadableFiles.add(versionFile);
        console.warn(
          `[localBinaryBuild] could not read BINARY_VERSION_FILE ${versionFile}; ` +
            `using the env-resolved binaries version to decide which upgrade offers ` +
            `this server can serve (#7516): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  const envVersion = getBinariesVersion();
  return { value: envVersion === 'latest' ? null : normalizeVersion(envVersion), ttlMs };
}

/**
 * The version of the build in the local binaries volume, or null when nothing
 * names it (no readable VERSION file and no BINARY_VERSION / BREEZE_VERSION).
 * Cached for {@link BUILD_VERSION_CACHE_TTL_MS}.
 */
export async function getLocalBinariesBuildVersion(): Promise<string | null> {
  const now = Date.now();
  if (cached && now - cached.readAt < cached.ttlMs) return cached.value;
  const { value, ttlMs } = await readBuildVersion();
  cached = { value, readAt: now, ttlMs };
  return value;
}

/**
 * Whether this server can serve the bytes for an upgrade offer of `version`.
 * False only in local mode when the volume's build is known and is a different
 * release; every uncertain case answers true (the pre-#7516 behaviour), because
 * withholding wrongly would freeze a fleet that could have upgraded.
 *
 * Logs each withheld (component, platform, arch, target, build) once per
 * process — the condition is expected for the length of a deploy-before-promote
 * window, so it must not log per heartbeat.
 */
export async function isUpgradeTargetServable(args: {
  component: string;
  platform: string;
  architecture: string;
  version: string;
}): Promise<boolean> {
  if (getBinarySource() !== 'local') return true;
  // binarySync registers local rows as "unknown" when it has no VERSION file;
  // such a row was registered FROM the volume, so it is the volume's build.
  if (args.version === 'unknown') return true;

  const build = await getLocalBinariesBuildVersion();
  if (build === null) return true;
  if (normalizeVersion(args.version) === build) return true;

  const key = `${args.component}:${args.platform}:${args.architecture}:${args.version}:${build}`;
  if (!warnedWithheld.has(key)) {
    warnedWithheld.add(key);
    console.warn(
      `[localBinaryBuild] withholding ${args.component} upgrade offer to ${args.version} ` +
        `for ${args.platform}/${args.architecture}: BINARY_SOURCE=local holds only the ` +
        `${build} build, so the download would fail checksum verification on every ` +
        `attempt (#7516). Promote ${build} (POST /agent-versions/promote) or deploy the ` +
        `${args.version} binaries; devices stay on their current version until then.`,
    );
  }
  return false;
}
