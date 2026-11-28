/**
 * Minimum-OS gate for agent binaries (#12169, plan PR #12173 W1).
 *
 * Each release records the minimum OS of its darwin artifacts as
 * `agent_versions.min_os_version`, sourced from the signed release manifest's
 * `minOs` (declared in `agent/platform-floors.json`). Every server path that
 * picks an agent binary for a device runs this ONE pure evaluator, so a Mac
 * below a release's floor is never offered or sent that release and stays on
 * the agent version it has.
 *
 * Unknown device OS (Open Decision 1, resolved: HOLD). When the release has a
 * floor but the device's macOS version cannot be read — a bare `darwin`
 * (sw_vers failed), the SYSTEM_VERSION_COMPAT sentinel `10.16`, or garbage —
 * the offer is held with its own reason. Allowing it is the only branch that
 * can strand an agent on a binary its OS does not support; a hold is visible
 * on the device page and clears itself on the first beat that reports a
 * parseable version.
 */

/**
 * The macOS floor this source tree declares in `agent/platform-floors.json`
 * (a unit test keeps the two equal). Used only where no signed manifest
 * records a floor: binaries registered from a local directory through the
 * per-deployment fallback were built from this source, so they carry its floor.
 */
export const DECLARED_MACOS_FLOOR = '13.0';

export const OS_BELOW_MINIMUM_REASON = 'os_below_minimum';
export const OS_VERSION_UNKNOWN_REASON = 'os_version_unknown';
export type OsFloorHoldReason = typeof OS_BELOW_MINIMUM_REASON | typeof OS_VERSION_UNKNOWN_REASON;

/** True for the reason codes this gate owns on `devices.update_offer_withheld_reason`. */
export function isOsFloorHoldReason(value: string | null | undefined): value is OsFloorHoldReason {
  return value === OS_BELOW_MINIMUM_REASON || value === OS_VERSION_UNKNOWN_REASON;
}

export interface DeviceOsFacts {
  /** `devices.os_type` (`macos` | `windows` | `linux`). */
  platform: string;
  /** The OS version on the current heartbeat, when the beat carried one. */
  reportedOsVersion: string | null;
  /** `devices.os_version` as stored. Used when the beat has no parseable value. */
  storedOsVersion: string | null;
}

export type OsFloorDecision =
  | { kind: 'allow' }
  | { kind: 'hold'; reason: OsFloorHoldReason; requiredOs: string; reportedOs: string | null };

/** Same shape as the migration's CHECK and the release manifest guard. */
const OS_VERSION_RE = /^\d{1,3}(\.\d{1,3}){0,2}$/;
const MACOS_PREFIX_RE = /^(?:darwin|macos|mac\s+os\s+x)\b\s*/i;

function parseDotted(value: string): number[] | null {
  if (!OS_VERSION_RE.test(value)) return null;
  return value.split('.').map((part) => Number.parseInt(part, 10));
}

/** Parse a release floor (`"13.0"`). Null when malformed. */
export function parseOsFloor(raw: string | null | undefined): number[] | null {
  if (typeof raw !== 'string') return null;
  return parseDotted(raw.trim());
}

/**
 * Parse a device's reported OS version into numeric parts. macOS only: the
 * agent reports `darwin 15.8.1` (gopsutil platform + `sw_vers -productVersion`).
 * Returns null for any other platform, an unparseable string, or the
 * SYSTEM_VERSION_COMPAT value `10.16`, which is not a real macOS version.
 */
export function parseDeviceOsVersion(platform: string, raw: string | null | undefined): number[] | null {
  if (platform !== 'macos' || typeof raw !== 'string') return null;
  const rest = raw.trim().replace(MACOS_PREFIX_RE, '').trim();
  const parts = parseDotted(rest);
  if (!parts) return null;
  if (parts[0] === 10 && parts[1] === 16) return null;
  return parts;
}

/** Numeric tuple compare, missing parts read as 0 (`13` == `13.0.0`). */
export function compareOsVersions(a: readonly number[], b: readonly number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function evaluateOsFloor(device: DeviceOsFacts, minOs: string | null | undefined): OsFloorDecision {
  if (minOs === null || minOs === undefined) return { kind: 'allow' };
  // Only macOS floors are declared and parsed (plan Open Decision 6). A stray
  // floor on a Windows or Linux row must not hold that fleet as "unknown".
  if (device.platform !== 'macos') return { kind: 'allow' };
  const floor = parseOsFloor(minOs);
  const parsed =
    parseDeviceOsVersion(device.platform, device.reportedOsVersion) ??
    parseDeviceOsVersion(device.platform, device.storedOsVersion);

  if (!floor) {
    // Unreachable through the DB (CHECK constraint) — fail closed if it happens.
    console.error(`[agentOsFloor] malformed release floor ${JSON.stringify(minOs)}; holding the offer`);
    return {
      kind: 'hold',
      reason: parsed ? OS_BELOW_MINIMUM_REASON : OS_VERSION_UNKNOWN_REASON,
      requiredOs: minOs,
      reportedOs: parsed ? parsed.join('.') : null,
    };
  }
  if (!parsed) {
    return { kind: 'hold', reason: OS_VERSION_UNKNOWN_REASON, requiredOs: minOs, reportedOs: null };
  }
  if (compareOsVersions(parsed, floor) < 0) {
    return { kind: 'hold', reason: OS_BELOW_MINIMUM_REASON, requiredOs: minOs, reportedOs: parsed.join('.') };
  }
  return { kind: 'allow' };
}

const warnedUnknownShapes = new Set<string>();

/** Bounded description of an unparseable OS string for dedup (digits collapsed). */
function rawShape(raw: string | null): string {
  if (raw === null) return '<null>';
  return raw.trim().slice(0, 40).replace(/\d+/g, 'N') || '<empty>';
}

/**
 * Log an unknown-OS hold once per (platform, raw shape) per process. A
 * below-minimum hold is expected and visible on the device, so it is not
 * logged here.
 */
export function noteOsFloorHold(device: DeviceOsFacts, hold: Extract<OsFloorDecision, { kind: 'hold' }>): void {
  if (hold.reason !== OS_VERSION_UNKNOWN_REASON) return;
  const raw = device.reportedOsVersion ?? device.storedOsVersion;
  const key = `${device.platform}:${rawShape(raw)}`;
  if (warnedUnknownShapes.has(key)) return;
  warnedUnknownShapes.add(key);
  console.warn(
    `[agentOsFloor] holding agent update: ${device.platform} OS version ${JSON.stringify(raw)} ` +
      `cannot be compared with the release minimum ${hold.requiredOs} (#12169)`,
  );
}

/** Test seam. */
export function __resetUnknownDeviceOsWarnings(): void {
  warnedUnknownShapes.clear();
}
