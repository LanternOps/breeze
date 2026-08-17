/**
 * Normalization for the agent's own row in a device software inventory report.
 *
 * The Windows MSI registers an Uninstall key whose `DisplayVersion` is the
 * version that was installed originally. The agent self-updates by replacing
 * its binary in place — it never reinstalls the MSI — so that registry value
 * is frozen forever while the agent actually running is many versions newer.
 * The software collector reads the registry, so `software_inventory.version`
 * for "Breeze Agent" drifts away from `devices.agent_version` (which the
 * heartbeat reports from the running binary and is authoritative).
 *
 * Practical damage: Software Policy allowlist/blocklist evaluation reads
 * `software_inventory.version`, so the agent itself shows up as a fleet-wide
 * outdated-software violation on devices that are fully current (issue #3591).
 *
 * The fix normalizes at ingest rather than in the collector: the API already
 * holds the authoritative `devices.agent_version`, and the correction then
 * applies to every agent already in the field instead of waiting for a fleet
 * promote. Inventory rows are wiped and reinserted on every report, so no
 * backfill is needed — the next scan corrects each device.
 */

/**
 * Display names the Breeze agent installer registers, lowercased.
 *
 * These are the MSI `ProductName` literals (see `agent/installer/build-msi.ps1`:
 * `$hostedProductName` / `$selfHostProductName`). Matching is exact on the
 * normalized name — a substring match would also capture unrelated products
 * that merely mention Breeze, and mislabel their versions with ours.
 */
const BREEZE_AGENT_PRODUCT_NAMES = new Set([
  'breeze agent',
  'breeze agent (self-hosted)',
]);

/** True when a reported software name is the Breeze agent's own installer entry. */
export function isBreezeAgentProductName(name: string): boolean {
  return BREEZE_AGENT_PRODUCT_NAMES.has(name.trim().toLowerCase());
}

/**
 * Version to store for one reported software item.
 *
 * For the agent's own entry, prefers the live heartbeat-reported agent version
 * over the installer-registered one. Falls back to whatever the collector
 * reported when `agentVersion` is missing (a device that has not completed its
 * first heartbeat) so a normalization can never blank a version out.
 */
export function resolveInventoryVersion(
  name: string,
  reportedVersion: string | null | undefined,
  agentVersion: string | null | undefined
): string | null {
  const reported = reportedVersion?.trim() || null;
  if (!isBreezeAgentProductName(name)) return reported;

  const live = agentVersion?.trim() || null;
  return live ?? reported;
}
