// Owns ticketing configuration: custom statuses, priority SLA settings, and org-level overrides — per 2026-06-12 spec.

import { ticketStatuses } from '../db/schema';
import { ticketStatusEnum } from '../db/schema/portal';

export type CoreTicketStatus = (typeof ticketStatusEnum.enumValues)[number];

export const DEFAULT_STATUSES: Array<{
  coreStatus: CoreTicketStatus;
  name: string;
  sortOrder: number;
}> = [
  { coreStatus: 'new', name: 'New', sortOrder: 0 },
  { coreStatus: 'open', name: 'Open', sortOrder: 1 },
  { coreStatus: 'pending', name: 'Pending', sortOrder: 2 },
  { coreStatus: 'on_hold', name: 'On hold', sortOrder: 3 },
  { coreStatus: 'resolved', name: 'Resolved', sortOrder: 4 },
  { coreStatus: 'closed', name: 'Closed', sortOrder: 5 },
];

/**
 * Insert the six system ticket statuses for a newly created partner.
 * Called inside `createPartner`'s transaction — `tx` is the Drizzle
 * transaction object.
 */
export async function seedSystemTicketStatuses(
  tx: { insert: any },
  partnerId: string,
): Promise<void> {
  await tx
    .insert(ticketStatuses)
    .values(
      DEFAULT_STATUSES.map((s) => ({
        partnerId,
        name: s.name,
        coreStatus: s.coreStatus,
        sortOrder: s.sortOrder,
        isSystem: true,
      })),
    );
}
