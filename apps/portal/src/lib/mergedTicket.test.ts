import { describe, expect, it } from 'vitest';
import { isPortalMergedTicket } from './mergedTicket';
import type { PortalMergedTicket, TicketDetails } from './api';

// The portal ticket page uses this to skip the approvals read and the
// component uses it to render the merged notice instead of ticket fields.
describe('isPortalMergedTicket', () => {
  const merged: PortalMergedTicket = { merged: true, mergedInto: null, mergedAt: null, survivorDeleted: true };
  const live = { id: 't-1', ticketNumber: 'T-1', subject: 'Printer', comments: [] } as unknown as TicketDetails;

  it('recognises the merged result', () => {
    expect(isPortalMergedTicket(merged)).toBe(true);
  });

  it('is false for a live ticket, null and undefined', () => {
    expect(isPortalMergedTicket(live)).toBe(false);
    expect(isPortalMergedTicket(null)).toBe(false);
    expect(isPortalMergedTicket(undefined)).toBe(false);
  });

  it('is false for a truthy-but-not-true merged field', () => {
    expect(isPortalMergedTicket({ ...live, merged: 'yes' } as unknown as TicketDetails)).toBe(false);
  });
});
