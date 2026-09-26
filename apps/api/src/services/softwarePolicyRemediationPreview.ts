/**
 * #3616 — the dry run behind the software-policy Remediate confirmation.
 *
 * Incident #3381: one click on an unlabelled Remediate icon POSTed an empty
 * body, the route resolved every violating device (up to 500) on its own, and
 * 259 machines had software uninstalled with no number shown beforehand. The
 * confirmation dialog now asks the server for this summary first, shows the
 * operator the blast radius, and confirms by sending back exactly
 * `deviceIds` — so the set that runs is the set that was shown, never a set
 * the route re-resolves after the fact.
 *
 * Only `unauthorized` violations are uninstall work (the remediation worker
 * skips everything else and marks a device with none as completed), so a
 * device whose row carries only `missing` violations is not a target here.
 * Per-device dedupe mirrors the worker's normalizeSoftwareKey — trimmed,
 * lower-cased (name, version) — so the preview count is the command count.
 */

export const REMEDIATION_PREVIEW_SAMPLE_DEVICES = 10;
export const REMEDIATION_PREVIEW_TOP_SOFTWARE = 15;

export type RemediationPreviewRow = {
  deviceId: string;
  hostname: string | null;
  violations: unknown;
};

export type RemediationPreviewUninstall = { name: string; version?: string };

export type RemediationPreviewSummary = {
  /** Every device that would receive at least one uninstall, in row order. */
  deviceIds: string[];
  deviceCount: number;
  /** Total uninstall commands across all target devices. */
  uninstallCount: number;
  /** Most-affected software first, by name (case-insensitive), bounded. */
  software: Array<{ name: string; deviceCount: number }>;
  softwareDistinctCount: number;
  /** The first few target devices with exactly what each would lose. */
  sampleDevices: Array<{
    deviceId: string;
    hostname: string | null;
    uninstalls: RemediationPreviewUninstall[];
  }>;
};

function readUninstalls(violations: unknown): RemediationPreviewUninstall[] {
  if (!Array.isArray(violations)) return [];
  const out: RemediationPreviewUninstall[] = [];
  const seen = new Set<string>();
  for (const violation of violations) {
    if (!violation || typeof violation !== 'object') continue;
    const typed = violation as { type?: unknown; software?: { name?: unknown; version?: unknown } };
    if (typed.type !== 'unauthorized') continue;
    const name = typeof typed.software?.name === 'string' ? typed.software.name.trim() : '';
    if (!name) continue;
    const version = typeof typed.software?.version === 'string' ? typed.software.version.trim() : '';
    const key = `${name.toLowerCase()}::${version.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(version ? { name, version } : { name });
  }
  return out;
}

export function summarizeRemediationTargets(rows: RemediationPreviewRow[]): RemediationPreviewSummary {
  const perDevice = new Map<string, { hostname: string | null; uninstalls: RemediationPreviewUninstall[] }>();

  for (const row of rows) {
    const uninstalls = readUninstalls(row.violations);
    if (uninstalls.length === 0) continue;
    const existing = perDevice.get(row.deviceId);
    if (!existing) {
      perDevice.set(row.deviceId, { hostname: row.hostname, uninstalls });
      continue;
    }
    const keys = new Set(existing.uninstalls.map((u) => `${u.name.toLowerCase()}::${(u.version ?? '').toLowerCase()}`));
    for (const u of uninstalls) {
      const key = `${u.name.toLowerCase()}::${(u.version ?? '').toLowerCase()}`;
      if (!keys.has(key)) {
        keys.add(key);
        existing.uninstalls.push(u);
      }
    }
  }

  // Software tally by name: a device counts once per name even when it holds
  // several versions, because "how many machines lose Zoom" is the question.
  const software = new Map<string, { name: string; devices: Set<string> }>();
  let uninstallCount = 0;
  for (const [deviceId, entry] of perDevice) {
    uninstallCount += entry.uninstalls.length;
    for (const u of entry.uninstalls) {
      const key = u.name.toLowerCase();
      let bucket = software.get(key);
      if (!bucket) {
        bucket = { name: u.name, devices: new Set() };
        software.set(key, bucket);
      }
      bucket.devices.add(deviceId);
    }
  }

  const deviceIds = Array.from(perDevice.keys());
  return {
    deviceIds,
    deviceCount: deviceIds.length,
    uninstallCount,
    software: Array.from(software.values())
      .map((b) => ({ name: b.name, deviceCount: b.devices.size }))
      .sort((a, b) => b.deviceCount - a.deviceCount || a.name.localeCompare(b.name))
      .slice(0, REMEDIATION_PREVIEW_TOP_SOFTWARE),
    softwareDistinctCount: software.size,
    sampleDevices: deviceIds.slice(0, REMEDIATION_PREVIEW_SAMPLE_DEVICES).map((deviceId) => {
      const entry = perDevice.get(deviceId)!;
      return { deviceId, hostname: entry.hostname, uninstalls: entry.uninstalls };
    }),
  };
}
