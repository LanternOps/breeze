/**
 * Where the device page's "Devices" crumb (and Back) should land.
 *
 * Navigation never silently changes the working org. When the working org IS
 * the device's org (or is the fleet view), `/devices` already shows this
 * device's neighbours. When it differs, `/devices` would list a different
 * customer's machines, so send the user to the device's own org record, whose
 * Devices tab is pinned to that org.
 */
export function deviceListCrumbHref(currentOrgId: string | null, deviceOrgId: string): string {
  if (currentOrgId === null || deviceOrgId === '' || currentOrgId === deviceOrgId) return '/devices';
  return `/organizations/${deviceOrgId}#devices`;
}
