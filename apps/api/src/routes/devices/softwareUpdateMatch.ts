import { patchSourceEnum } from '../../db/schema';

/** A patch `source` bucket as constrained by the DB enum. */
export type PatchSource = (typeof patchSourceEnum.enumValues)[number];

/**
 * Correlates installed-software inventory rows with the available third-party
 * updates that the agent already reports through the patch pipeline.
 *
 * The agent submits each available upgrade as a patch with `source='third_party'`,
 * `packageId=<provider id>` and `version=<available version>` (see agent
 * heartbeat.go availablePatchesToMaps + mapPatchProviderSource). Those land in
 * `patches`/`device_patches` and already power the Patches tab. This module joins
 * that same data back onto the Software tab so the per-row "Update" button can be
 * gated on a *real* available update instead of firing a blind upgrade that
 * silently no-ops.
 *
 * The `third_party` bucket spans providers: winget on Windows, and Homebrew /
 * Chocolatey elsewhere — so this matching is intentionally source-agnostic and
 * runs for macOS rows too (Homebrew). The route caller is responsible for not
 * forwarding a non-winget packageId (e.g. Homebrew's "homebrew:cask:foo", which
 * contains colons) to the winget-only `--id` update path.
 *
 * Matching is by normalized name. The provider's reported Name is derived from
 * the installed package, so it usually equals the display name we store as
 * `software_inventory.name` — exact-normalized equality is the common case. We
 * deliberately avoid fuzzy substring matching to keep false positives (which
 * would re-introduce the "button does nothing" problem) out. Dual-architecture
 * packages whose names collide after normalization (most notably the Visual C++
 * redistributables, x64 + x86 side by side) are dropped as ambiguous rather than
 * annotated with a guessed architecture — see `buildUpdateIndex`.
 */

export interface AvailableUpdate {
  /** Provider package identifier, e.g. "Mozilla.Firefox" (winget). Used to upgrade by --id. */
  packageId: string | null;
  /** Target version the update would install. */
  availableVersion: string | null;
  /** Patch source bucket — always 'third_party' here (winget / Homebrew / Chocolatey). */
  source: PatchSource;
  /** Normalized patch title used for matching. */
  normalizedName: string;
}

export interface SoftwareUpdateAnnotation {
  updateAvailable: boolean;
  availableVersion: string | null;
  updatePackageId: string | null;
  updateSource: PatchSource | null;
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
 *
 * Bitness is intentionally stripped: a provider's reported Name is inconsistent
 * about it (winget says "Mozilla Firefox" while the registry DisplayName is
 * "Mozilla Firefox (x64 en-US)"), so keeping it would break the common case.
 * The dual-architecture collision it creates (e.g. the x64 and x86 Visual C++
 * redistributables both normalizing to one key) is instead handled in
 * `buildUpdateIndex`, which drops ambiguous keys rather than guess an arch.
 */
export function normalizeSoftwareName(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ') // drop "(x64 en-US)" style qualifiers
    .replace(/[®™©]/g, ' ')
    .replace(/\b(?:x64|x86|amd64|arm64|aarch64|64[\s-]?bit|32[\s-]?bit)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Build a name → update index from the device's pending third-party patches.
 *
 * If two patches normalize to the same name but point at *different* packages
 * (different packageId), the name is ambiguous — typically the x64 and x86 builds
 * of the same product — and is dropped entirely, so neither inventory row gets a
 * wrong-architecture annotation. Repeated entries for the *same* package (same
 * packageId, e.g. a duplicated scan row) are harmless and keep the first.
 */
export function buildUpdateIndex(
  patches: Array<{ title: string; packageId: string | null; version: string | null; source: PatchSource }>
): Map<string, AvailableUpdate> {
  const index = new Map<string, AvailableUpdate>();
  const ambiguous = new Set<string>();
  for (const patch of patches) {
    const normalizedName = normalizeSoftwareName(patch.title);
    if (!normalizedName) continue;
    const existing = index.get(normalizedName);
    if (existing) {
      if ((existing.packageId ?? '') !== (patch.packageId ?? '')) {
        ambiguous.add(normalizedName);
      }
      continue;
    }
    index.set(normalizedName, {
      packageId: patch.packageId,
      availableVersion: patch.version,
      source: patch.source,
      normalizedName,
    });
  }
  for (const name of ambiguous) index.delete(name);
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
