import { semverCompare } from './semverCompare';

/**
 * "Force reboot now" (#8729), shared by the API (version gate, audit argv) and
 * the web console (menu gating, the confirmation dialog), so the two cannot
 * drift.
 */

/**
 * First agent release that knows the `force_reboot` command type (the release
 * after v0.124.0). An older agent answers it with "unknown command type".
 */
export const FORCE_REBOOT_MIN_AGENT_VERSION = '0.125.0';

/**
 * Whether an agent version can run `force_reboot`. Fails CLOSED: an empty,
 * missing, `dev` or otherwise unparseable version is unsupported. A prerelease
 * of the minimum (the lab build) counts as the minimum.
 */
export function agentSupportsForceReboot(agentVersion: string | null | undefined): boolean {
  if (typeof agentVersion !== 'string') return false;
  const cmp = semverCompare(agentVersion.trim(), FORCE_REBOOT_MIN_AGENT_VERSION);
  return cmp !== null && cmp >= 0;
}

export type ForceRebootOs = 'windows' | 'macos' | 'linux';

/**
 * The exact command the agent runs for a force reboot on this OS: the mirror
 * of ForceRebootArgv in agent/internal/remote/tools/system.go.
 *
 * Windows adds `/f`: Microsoft documents it as implied only when `/t` > 0, so
 * an immediate reboot without it can stall on "this app is preventing
 * shutdown". `shutdown -r` on macOS and Linux does not wait on applications,
 * so force changes nothing there.
 */
export function forceRebootArgv(os: string): string[] | null {
  switch (os) {
    case 'windows':
      return ['shutdown', '/r', '/f', '/t', '0'];
    case 'macos':
    case 'linux':
      return ['shutdown', '-r', '+0'];
    default:
      return null;
  }
}

/** True when force adds anything on this OS (only Windows). */
export function forceRebootChangesBehavior(os: string): boolean {
  return os === 'windows';
}
