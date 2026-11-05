// Kept out of ./api so components whose tests mock '@/lib/api' wholesale can
// still use it; the import below is type-only and erased at build time.
import type { PortalMergedTicket, PortalTicketDetailResult } from './api';

/** True for the merged-tombstone result of portalApi.getTicket (#8972). */
export function isPortalMergedTicket(t: PortalTicketDetailResult | null | undefined): t is PortalMergedTicket {
  return !!t && 'merged' in t && t.merged === true;
}
