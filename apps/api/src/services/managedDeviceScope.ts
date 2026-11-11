import { eq, ne, type SQL } from 'drizzle-orm';
import { devices } from '../db/schema';
import { notParkedDeviceCondition } from './unassignedPool/selectorPredicate';

/**
 * The one "managed device" population every report generator counts (#11562):
 * in the org, not a Quick Support (ephemeral) session, not parked in a holding
 * org, and not decommissioned. A retired machine is not managed, is not billed
 * (see partnerDeviceCapacity) and must not appear in a customer-facing total or
 * pull an "agent coverage" figure down.
 *
 * Callers append their own site/filter predicates to the returned array. Use
 * this instead of hand-rolling the conditions per report so a new report cannot
 * forget one of the three exclusions.
 */
export function managedDeviceConditions(orgId: string): SQL[] {
  return [
    eq(devices.orgId, orgId),
    eq(devices.isEphemeral, false),
    notParkedDeviceCondition(),
    ne(devices.status, 'decommissioned'),
  ];
}
