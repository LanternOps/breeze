/**
 * Correlates installed-software inventory rows with the available third-party
 * updates that the agent already reports through the patch pipeline.
 *
 * The agent's WingetProvider runs `winget upgrade` and submits each available
 * upgrade as a patch with `source='third_party'`, `packageId=<winget Id>` and
 * `version=<available version>` (see agent heartbeat.go availablePatchesToMaps +
 * mapPatchProviderSource). Those land in `patches`/`device_patches` and already
 * power the Patches tab. This module joins that same data back onto the Software
 * tab so the per-row "Update" button can be gated on a *real* available update
 * instead of firing a blind `winget upgrade` that silently no-ops.
 *
 * Matching is by normalized name. `winget upgrade`'s Name column is derived from
 * the installed (ARP) package, so it usually equals the registry DisplayName we
 * store as `software_inventory.name` — exact-normalized equality is the common
 * case. We deliberately avoid fuzzy substring matching to keep false positives
 * (which would re-introduce the "button does nothing" problem) out.
 */

export interface AvailableUpdate {
  /** Winget package identifier, e.g. "Mozilla.Firefox". Used to upgrade by --id. */
  packageId: string | null;
  /** Target version the update would install. */
  availableVersion: string | null;
  /** Provider bucket the update came from (currently always winget on Windows). */
  source: string;
  /** Normalized patch title used for matching. */
  normalizedName: string;
}

export interface SoftwareUpdateAnnotation {
  updateAvailable: boolean;
  availableVersion: string | null;
  updatePackageId: string | null;
  updateSource: string | null;
}

const NO_UPDATE: SoftwareUpdateAnnotation = {
  updateAvailable: false,
  availableVersion: null,
  updatePackageId: null,
  updateSource: null,
};

/**
 * Normalize a software/package name for cross-source matching. Lowercases,
 * strips parenthetical qualifiers (architecture/locale like "(x64 en-US)"),
 * drops trademark glyphs and bitness tokens, then collapses to single spaces.
 */
export function normalizeSoftwareName(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ') // drop "(x64 en-US)" style qualifiers
    .replace(/[®™©]/g, ' ')
    .replace(/\b(?:x64|x86|amd64|arm64|64[\s-]?bit|32[\s-]?bit)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Build a name → update index from the device's pending third-party patches.
 * When several updates normalize to the same name, the first one wins (the
 * scan rarely produces dupes; if it does, either is a valid upgrade target).
 */
export function buildUpdateIndex(
  patches: Array<{ title: string; packageId: string | null; version: string | null; source: string }>
): Map<string, AvailableUpdate> {
  const index = new Map<string, AvailableUpdate>();
  for (const patch of patches) {
    const normalizedName = normalizeSoftwareName(patch.title);
    if (!normalizedName) continue;
    if (index.has(normalizedName)) continue;
    index.set(normalizedName, {
      packageId: patch.packageId,
      availableVersion: patch.version,
      source: patch.source,
      normalizedName,
    });
  }
  return index;
}

/**
 * Resolve the update annotation for a single installed-software row. Returns a
 * no-update annotation unless a third-party update matches by normalized name
 * AND the target version actually differs from what's installed (guards against
 * a stale patch row that's already at the installed version).
 */
export function annotateSoftwareRow(
  row: { name: string | null; version: string | null },
  index: Map<string, AvailableUpdate>
): SoftwareUpdateAnnotation {
  const match = index.get(normalizeSoftwareName(row.name));
  if (!match) return NO_UPDATE;

  // If we know both versions and they're equal, there's nothing to do.
  if (
    match.availableVersion &&
    row.version &&
    match.availableVersion.trim() === row.version.trim()
  ) {
    return NO_UPDATE;
  }

  return {
    updateAvailable: true,
    availableVersion: match.availableVersion,
    updatePackageId: match.packageId,
    updateSource: match.source,
  };
}
