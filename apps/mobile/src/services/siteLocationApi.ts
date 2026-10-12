import { coreRequest } from './api';

/**
 * `POST /orgs/sites/:id/location` — the one place a coordinate leaves the
 * phone, and only as a deliberately pinned SITE position (the server stamps
 * `location_source = 'technician'`). Requires `sites:set_location`.
 */
export async function pinSiteLocation(
  siteId: string,
  fix: { latitude: number; longitude: number }
): Promise<void> {
  await coreRequest(`/orgs/sites/${encodeURIComponent(siteId)}/location`, {
    method: 'POST',
    body: JSON.stringify({ latitude: fix.latitude, longitude: fix.longitude }),
  });
}
