/**
 * The request the three datasets that predate the run frame (`metrics`,
 * `vulnerabilities`, `custom_fields`) hand to `exportDeviceSet` (Wisp analysis
 * sessions W05 carry-over).
 *
 * These datasets used to verify and read each device in turn, so a 5,000-device
 * frame cost 5,000 to 20,000 queries. They now resolve the whole set with one
 * `exportDeviceSet` call and page their rows with one keyset query per page.
 *
 * One rule differs from the W04+ datasets, kept on purpose so no caller loses
 * data it could export before: a run with NO frame (a non-analysis run that
 * names no device) still exports the devices the model listed in `deviceIds`.
 * The central device gate has already run `verifyDeviceAccess` on every one of
 * those ids, and `exportDeviceSet` narrows them again by org, the exact-device
 * axis and the site axis. A run with neither a frame nor a list exports
 * nothing, as before.
 *
 * A pure rewrite of the request: each adapter still calls `exportDeviceSet`
 * itself, in the function that holds its `.from(...)`, which is what the scope
 * contract scans credit.
 */
import type { DatasetRequest } from '../aiToolsExportDatasets';

export function withRequestedDevicesAsFrame(req: DatasetRequest): DatasetRequest {
  if ((!req.runTargets || req.runTargets.length === 0) && req.deviceIds && req.deviceIds.length > 0) {
    // `notes` stays the same array, so anything the resolver notes reaches the result.
    return { ...req, runTargets: [...req.deviceIds] };
  }
  return req;
}
