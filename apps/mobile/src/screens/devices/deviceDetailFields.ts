/**
 * Pure formatting rules for the Device Details v1 fields (#5140, decision
 * #5117-2): IP (LAN, with public on a second line when present), logged-in
 * user, OS version alongside OS, and the open alert/ticket counts.
 *
 * "Empty values render '—', never blank" per the decision doc — kept here as
 * pure string functions (no react-native import) so DeviceDetailScreen's JSX
 * stays a straight prop-to-JSX mapping and this stays node-testable, matching
 * lib/osLabel.ts's rationale.
 */

const EM_DASH = '—';

function isBlank(value: string | null | undefined): value is null | undefined {
  return value == null || value.trim().length === 0;
}

/** A single detail-row value: the string itself, or an em dash when absent. */
export function formatDetailValue(value: string | null | undefined): string {
  return isBlank(value) ? EM_DASH : value;
}

/**
 * The IP detail row's value: LAN IP on the first line (em-dashed if absent),
 * with the public/WAN IP appended on a second line only when present. A
 * device with neither collapses to a single em dash rather than a dangling
 * blank second line.
 */
export function formatIpValue(lanIp: string | null | undefined, publicIp: string | null | undefined): string {
  const lanLine = formatDetailValue(lanIp);
  if (isBlank(publicIp)) return lanLine;
  return `${lanLine}\n${publicIp}`;
}

/**
 * The OPERATING SYSTEM row's value: the OS label with its version appended
 * when known. Unlike the other new fields, an absent version falls back to
 * the bare OS label rather than an em dash — "Linux · —" reads as broken data
 * where "Linux" reads as simply not yet reported.
 */
export function formatOsVersionValue(osLabel: string, osVersion: string | null | undefined): string {
  return isBlank(osVersion) ? osLabel : `${osLabel} · ${osVersion}`;
}

/**
 * "Open alerts · N" / "Open tickets · N". A real zero renders as `· 0` (the
 * device genuinely has none open); only a missing count (undefined/null —
 * the field hasn't been backfilled yet, or this is a stale cached record)
 * em-dashes.
 */
export function formatCountLabel(label: string, count: number | null | undefined): string {
  return `${label} · ${count == null ? EM_DASH : count}`;
}
