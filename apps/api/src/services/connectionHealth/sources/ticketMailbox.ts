import { inArray, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { ticketMailboxConnections as t } from '../../../db/schema';
import { MAILBOX_TRANSIENT_FAILURE_THRESHOLD, staleAfterMinutes, ticketMailboxHealth } from '../../integrationStates';
import { PERMISSIONS } from '../../permissions';
import { cleanDisplayName } from '../sanitize';
import type { HealthObservation } from '../types';
import { defineRowSource, staleArm, toHealthObservation } from './observeRows';

// Ticket mailboxes (90-second poll sweep). Partner-owned, including Gmail rows
// whose org_id only names the credential org. `last_error` holds raw upstream
// text the API never exposes (#6192), so no detail is ever reported.
// Partner axis: not index-backed.
// Staleness (#9127): a poll stamps last_polled_at whenever it persists a cursor
// (the M365 delta or resume link, or a Gmail history id, even an unchanged
// one), so an idle inbox stays fresh, and a reconnect clears it. A connected
// mailbox that never persists a cursor (a dead sweep, or a connect floor that
// keeps failing to seed) goes stale from created_at.

const FIX_HREF = '/settings/ticketing#email';

/** SWEEP_INTERVAL_MS in jobs/ticketMailboxPollWorker.ts, not imported so the worker stays out of the reconciler. */
const POLL_SWEEP_MINUTES = 1.5;

const stale = (now: Date) => staleArm({
  lastOk: t.lastPolledAt,
  createdAt: t.createdAt,
  now,
  minutes: staleAfterMinutes(POLL_SWEEP_MINUTES),
  withTimezone: true,
});

export type TicketMailboxRow = {
  id: string;
  partnerId: string;
  mailboxAddress: string;
  status: string;
  consecutiveTransientFailures: number;
  createdAt: Date;
  /** Computed in SQL (#9127): no poll within the stale threshold. */
  stale: boolean;
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
  select: (where, now) => db
    .select({
      id: t.id,
      partnerId: t.partnerId,
      mailboxAddress: t.mailboxAddress,
      status: t.status,
      consecutiveTransientFailures: t.consecutiveTransientFailures,
      createdAt: t.createdAt,
      stale: sql<boolean>`${stale(now)}`,
    })
    .from(t)
    .where(where),
  brokenWhere: (now) => sql`(${t.status} IN (${sql.raw(`'reauth_required', 'error'`)}) OR (${t.status} = ${sql.raw(`'connected'`)} AND (${t.consecutiveTransientFailures} >= ${sql.raw(String(MAILBOX_TRANSIENT_FAILURE_THRESHOLD))} OR ${stale(now)})))`,
  trackedWhere: (ids) => inArray(t.id, ids),
  sourceIdOf: (r) => r.id,
  toObservation: ticketMailboxObservation,
});
