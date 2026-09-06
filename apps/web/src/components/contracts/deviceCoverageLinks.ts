// The one producer of coverage-notice deep links (#3205 W06). Built from the
// devices list's OWN hash format so producer and consumer cannot drift:
// `#orgId=…` (orgHash.ts) + `#filtersV2=…` (filterUrl.ts, DevicesPage.tsx:195).
import { encodeFilterToHash } from '../devices/filterUrl';
import { isOrgIdForHash } from '../devices/orgIdShape';
import { DEVICE_ROLES } from '@/lib/deviceRoles';

/** The devices list filtered to one device role, in one org. Returns null for a
 *  role the filter engine does not know, so an unexpected device_role value
 *  renders as plain text rather than a link that matches nothing — and null for
 *  an org id that is not a uuid, so nothing but the two known fragments ever
 *  reaches the anchor's href (the org id can originate from the page hash). */
export function devicesUrlForRole(role: string, orgId: string | null): string | null {
  if (!(DEVICE_ROLES as readonly string[]).includes(role)) return null;
  if (orgId !== null && !isOrgIdForHash(orgId)) return null;
  const encoded = encodeFilterToHash({
    operator: 'AND',
    conditions: [{ field: 'deviceRole', operator: 'equals', value: role }],
  });
  if (!encoded) return null;
  return orgId ? `/devices#orgId=${encodeURIComponent(orgId)}&${encoded}` : `/devices#${encoded}`;
}
