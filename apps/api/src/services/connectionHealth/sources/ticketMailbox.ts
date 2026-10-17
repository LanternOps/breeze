import { inArray, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { ticketMailboxConnections as t } from '../../../db/schema';
import { MAILBOX_TRANSIENT_FAILURE_THRESHOLD, ticketMailboxHealth } from '../../integrationStates';
import { PERMISSIONS } from '../../permissions';
import { cleanDisplayName } from '../sanitize';
import type { HealthObservation } from '../types';
import { defineRowSource, toHealthObservation } from './observeRows';

// Ticket mailboxes (90-second poll sweep). Partner-owned, including Gmail rows
// whose org_id only names the credential org. `last_error` holds raw upstream
// text the API never exposes (#6192), so no detail is ever reported.
// Partner axis: not index-backed.

const FIX_HREF = '/settings/ticketing#email';

export type TicketMailboxRow = {
  id: string;
  partnerId: string;
  mailboxAddress: string;
  status: string;
  consecutiveTransientFailures: number;
  createdAt: Date;
};

export function ticketMailboxObservation(row: TicketMailboxRow, now: Date): HealthObservation {
  return toHealthObservation({
    kind: 'ticket_mailbox',
    verdict: ticketMailboxHealth(row),
    now,
    createdAt: row.createdAt,
    sourceId: row.id,
    partnerId: row.partnerId,
    orgId: null,
    displayName: cleanDisplayName(`Ticket mailbox ${row.mailboxAddress}`, 'Ticket mailbox'),
    rawDetail: null,
    fixHref: FIX_HREF,
    viewPermission: PERMISSIONS.ORGS_READ,
    repairPermission: PERMISSIONS.ORGS_WRITE,
  });
}

export const ticketMailboxSource = defineRowSource<TicketMailboxRow>({
  kind: 'ticket_mailbox',
  intervalMinutes: 15,
  tables: ['ticket_mailbox_connections'],
  fixHrefs: [FIX_HREF],
  select: (where) => db
    .select({
      id: t.id,
      partnerId: t.partnerId,
      mailboxAddress: t.mailboxAddress,
      status: t.status,
      consecutiveTransientFailures: t.consecutiveTransientFailures,
      createdAt: t.createdAt,
    })
    .from(t)
    .where(where),
  brokenWhere: sql`(${t.status} IN (${sql.raw(`'reauth_required', 'error'`)}) OR (${t.status} = ${sql.raw(`'connected'`)} AND ${t.consecutiveTransientFailures} >= ${sql.raw(String(MAILBOX_TRANSIENT_FAILURE_THRESHOLD))}))`,
  trackedWhere: (ids) => inArray(t.id, ids),
  sourceIdOf: (r) => r.id,
  toObservation: ticketMailboxObservation,
});
