import { describe, expectTypeOf, it } from 'vitest';
import type {
  PortalArtifactState, PortalOccurrenceStatus, PortalServiceOverviewDto, ServiceTileDto,
} from './portalService';

describe('portal service DTOs', () => {
  it('never exposes a ticket anywhere in the overview', () => {
    // Compile-time proof of spec D10: the portal shows the delivery record, not
    // the ticket. A future field called ticketId would fail this immediately.
    expectTypeOf<keyof PortalServiceOverviewDto>().toEqualTypeOf<'asOf' | 'timezone' | 'groups' | 'keyDates'>();
  });
  it('hides awaiting_evidence from the customer vocabulary', () => {
    expectTypeOf<PortalOccurrenceStatus>().not.toEqualTypeOf<'awaiting_evidence'>();
  });
  it('carries the four artifact states', () => {
    expectTypeOf<PortalArtifactState>().toEqualTypeOf<'attached' | 'report' | 'none' | 'held_by_msp'>();
  });
  it('windows the service tile at 90 days', () => {
    expectTypeOf<ServiceTileDto['windowDays']>().toEqualTypeOf<90>();
  });
});
