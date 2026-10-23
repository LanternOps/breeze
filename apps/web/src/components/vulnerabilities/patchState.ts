import type { FleetVulnerability, SoftwareGroup } from '../../lib/api/vulnerabilities';

/**
 * "Is there a patch?" — one answer for every lens on the page (#9533). See
 * PATCH_EXPLANATION in vulnExplanations.ts for the user-facing legend.
 *
 * - `ready`  — a managed patch is pending on the device AND approved for the
 *              partner (the server's Remediate resolver, #7499).
 * - `update` — no Ready managed patch, but the vendor has a fix: update the
 *              software directly.
 * - `none`   — nothing known to install.
 */
export type PatchState = 'ready' | 'update' | 'none';

export function groupPatchState(
  g: Pick<SoftwareGroup, 'patchReadyFindingCount' | 'vendorFixAvailable' | 'targetVersion'>,
): PatchState {
  if (g.patchReadyFindingCount > 0) return 'ready';
  // A known fix-in version is a vendor fix even where the catalog flag is
  // unset (that flag is only stamped by the MSRC/SOFA feeds).
  if (g.vendorFixAvailable || g.targetVersion) return 'update';
  return 'none';
}

export function cvePatchState(
  v: Pick<FleetVulnerability, 'patchReadyDeviceCount' | 'patchAvailable' | 'statuses'>,
): PatchState {
  if (v.patchReadyDeviceCount > 0) return 'ready';
  // Every finding already patched: there is nothing left to update.
  if (v.statuses.length > 0 && v.statuses.every((s) => s === 'patched')) return 'none';
  if (v.patchAvailable) return 'update';
  return 'none';
}
