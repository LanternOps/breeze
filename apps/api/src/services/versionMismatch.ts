import { normalizeReleaseVersion } from '../upgrade/upgradePreflight';

/**
 * #7024: on a digest-pinned install, BREEZE_VERSION (.env) and the running
 * image are set independently. Bumping BREEZE_VERSION without new digests keeps
 * the old image running while BREEZE_VERSION still drives agent release
 * selection (binarySource.ts), so agents can be offered a release ahead of the
 * server. APP_VERSION is the image's own baked version — Compose no longer
 * overrides it — so comparing the two exposes that state instead of hiding it.
 *
 * Pure: env in, result out. Read by the boot warning and the System page
 * Connections report.
 */
export interface VersionMismatch {
  /** APP_VERSION: baked into the running image at build time. */
  running: string;
  /** BREEZE_VERSION: what the operator's .env says is deployed. */
  configured: string;
}

type VersionEnv = Partial<Record<'APP_VERSION' | 'BREEZE_VERSION', string | undefined>>;

// Build metadata (`+…`) never identifies a different release (semver §10); a
// prerelease (`-rc.1`) does, so it is kept.
const bare = (raw: string | undefined): string => (raw ?? '').trim().replace(/^v/, '').replace(/\+.*$/, '');

/**
 * Non-null only when BOTH sides are release versions and they differ. A dev
 * image, the unversioned `0.2.0` build placeholder, or an unset BREEZE_VERSION
 * says nothing about which release is deployed, so it is not a mismatch.
 */
export function getVersionMismatch(env: VersionEnv = process.env): VersionMismatch | null {
  const running = bare(env.APP_VERSION);
  const configured = bare(env.BREEZE_VERSION);
  if (!normalizeReleaseVersion(running) || !normalizeReleaseVersion(configured)) return null;
  return running === configured ? null : { running, configured };
}

/** Logs the boot-time mismatch warning; returns whether it fired. */
export function warnOnVersionMismatch(
  env: VersionEnv = process.env,
  logger: Pick<Console, 'warn'> = console,
): boolean {
  const mismatch = getVersionMismatch(env);
  if (!mismatch) return false;
  logger.warn(
    `[version] BREEZE_VERSION=${mismatch.configured} but this API image is ${mismatch.running}. ` +
      `/health reports the image (${mismatch.running}); agent release selection still follows BREEZE_VERSION. ` +
      'Changing BREEZE_VERSION does not change a digest-pinned image: upgrade with `guided-setup.sh --upgrade`, ' +
      'or set BREEZE_VERSION back to the running release.',
  );
  return true;
}
