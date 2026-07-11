import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  ticketMailboxConnections,
  ticketMailboxTenantOwnerships,
} from '../../db/schema/ticketMailbox';
import { getMailboxToken } from './mailboxToken';

export type MailboxConnectionStatus =
  | 'pending_consent' | 'connected' | 'error' | 'reauth_required' | 'disabled';

export interface MailboxConnection {
  id: string;
  partnerId: string;
  tenantId: string | null;
  mailboxAddress: string;
  displayName: string | null;
  status: MailboxConnectionStatus;
  deltaLink: string | null;
  strictSenderAuth: boolean;
  lastPolledAt: Date | null;
  lastMessageAt: Date | null;
  lastError: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MailboxConnectionListItem {
  id: string;
  mailboxAddress: string;
  displayName: string | null;
  status: MailboxConnectionStatus;
  lastPolledAt: Date | null;
  lastMessageAt: Date | null;
}

type ConnectedMailbox = Pick<
  MailboxConnection,
  'id' | 'partnerId' | 'tenantId' | 'mailboxAddress' | 'deltaLink'
>;

type Row = typeof ticketMailboxConnections.$inferSelect;

function toConnection(r: Row): MailboxConnection {
  return { ...r, status: r.status as MailboxConnectionStatus };
}

export async function listMailboxConnections(partnerId: string): Promise<MailboxConnectionListItem[]> {
  const rows = await db.select({
    id: ticketMailboxConnections.id,
    mailboxAddress: ticketMailboxConnections.mailboxAddress,
    displayName: ticketMailboxConnections.displayName,
    status: ticketMailboxConnections.status,
    lastPolledAt: ticketMailboxConnections.lastPolledAt,
    lastMessageAt: ticketMailboxConnections.lastMessageAt,
  }).from(ticketMailboxConnections)
    .where(eq(ticketMailboxConnections.partnerId, partnerId));
  return rows.map((row) => ({
    id: row.id,
    mailboxAddress: row.mailboxAddress,
    displayName: row.displayName,
    status: row.status as MailboxConnectionStatus,
    lastPolledAt: row.lastPolledAt,
    lastMessageAt: row.lastMessageAt,
  }));
}

/** System-context read across all partners — used by the poll worker (Plan 2). */
export async function listConnectedMailboxes(): Promise<ConnectedMailbox[]> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    return db.select({
      id: ticketMailboxConnections.id,
      partnerId: ticketMailboxConnections.partnerId,
      tenantId: ticketMailboxConnections.tenantId,
      mailboxAddress: ticketMailboxConnections.mailboxAddress,
      deltaLink: ticketMailboxConnections.deltaLink,
    }).from(ticketMailboxConnections)
      .innerJoin(
        ticketMailboxTenantOwnerships,
        and(
          eq(ticketMailboxConnections.tenantId, ticketMailboxTenantOwnerships.tenantId),
          eq(ticketMailboxConnections.partnerId, ticketMailboxTenantOwnerships.partnerId),
        ),
      )
      .where(eq(ticketMailboxConnections.status, 'connected'));
  }));
}

export async function getMailboxConnection(id: string, partnerId: string): Promise<MailboxConnection | null> {
  const rows = await db.select().from(ticketMailboxConnections)
    .where(and(eq(ticketMailboxConnections.id, id), eq(ticketMailboxConnections.partnerId, partnerId)))
    .limit(1);
  return rows[0] ? toConnection(rows[0]) : null;
}

export async function createPendingConnection(input: {
  partnerId: string; mailboxAddress: string; displayName: string | null; createdBy: string | null;
}): Promise<MailboxConnection> {
  const rows = await db.insert(ticketMailboxConnections).values({
    partnerId: input.partnerId,
    mailboxAddress: input.mailboxAddress.trim().toLowerCase(),
    displayName: input.displayName,
    status: 'pending_consent',
    createdBy: input.createdBy,
  }).onConflictDoUpdate({
    target: [ticketMailboxConnections.partnerId, ticketMailboxConnections.mailboxAddress],
    set: {
      status: 'pending_consent',
      tenantId: null,
      deltaLink: null,
      lastError: null,
      lastPolledAt: null,
      lastMessageAt: null,
      displayName: input.displayName,
      updatedAt: new Date(),
    },
  }).returning();
  const row = rows[0];
  if (!row) throw new Error('Failed to create pending mailbox connection');
  return toConnection(row);
}

export async function bindVerifiedTenant(
  connectionId: string,
  partnerId: string,
  tenantId: string,
  evidence: { microsoftOid: string; breezeUserId: string | null },
): Promise<void> {
  const normalizedTenantId = tenantId.toLowerCase();
  const normalizedMicrosoftOid = evidence.microsoftOid.toLowerCase();

  await db.transaction(async (tx) => {
    await tx.insert(ticketMailboxTenantOwnerships).values({
      tenantId: normalizedTenantId,
      partnerId,
      verifiedBy: evidence.breezeUserId,
      verifiedMicrosoftOid: normalizedMicrosoftOid,
    }).onConflictDoNothing({
      target: ticketMailboxTenantOwnerships.tenantId,
    }).returning({ partnerId: ticketMailboxTenantOwnerships.partnerId });

    const ownershipRows = await tx.select({ partnerId: ticketMailboxTenantOwnerships.partnerId })
      .from(ticketMailboxTenantOwnerships)
      .where(eq(ticketMailboxTenantOwnerships.tenantId, normalizedTenantId))
      .limit(1);
    const ownership = ownershipRows[0];
    if (!ownership) throw new Error('Failed to verify mailbox tenant ownership');
    if (ownership.partnerId !== partnerId) {
      throw new Error('Mailbox tenant is already owned by another partner');
    }

    const updated = await tx.update(ticketMailboxConnections)
      .set({
        tenantId: normalizedTenantId,
        status: 'connected',
        lastError: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(ticketMailboxConnections.id, connectionId),
        eq(ticketMailboxConnections.partnerId, partnerId),
        eq(ticketMailboxConnections.status, 'pending_consent'),
      ))
      .returning({ id: ticketMailboxConnections.id });
    if (updated.length !== 1) throw new Error('Pending mailbox connection not found');
  });
}

/**
 * @deprecated Temporary compatibility bridge for the pre-verified callback route.
 * Use bindVerifiedTenant with verified Microsoft identity evidence instead.
 */
export async function setConnectionTenant(
  _id: string, _partnerId: string, _tenantId: string,
): Promise<void> {
  throw new Error('Legacy mailbox tenant binding is disabled');
}

export async function setConnectionStatus(
  id: string, partnerId: string, status: MailboxConnectionStatus, lastError: string | null,
): Promise<void> {
  if (status === 'connected') {
    throw new Error('Connected status requires bindVerifiedTenant');
  }
  await db.update(ticketMailboxConnections)
    .set({ status, lastError, updatedAt: new Date() })
    .where(and(eq(ticketMailboxConnections.id, id), eq(ticketMailboxConnections.partnerId, partnerId)));
}

/** Worker-only. Self-wraps in system context: ticket_mailbox_connections is
 *  FORCE RLS (partner-axis), and the poll worker runs with no request DB context,
 *  so a bare write would match zero rows silently and the cursor would never
 *  advance. */
export async function updateDeltaCursor(
  id: string, deltaLink: string, polledAt: Date, lastMessageAt: Date | null,
): Promise<void> {
  await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    await db.update(ticketMailboxConnections)
      .set({ deltaLink, lastPolledAt: polledAt, ...(lastMessageAt ? { lastMessageAt } : {}), updatedAt: new Date() })
      .where(eq(ticketMailboxConnections.id, id));
  }));
}

export async function disableConnection(id: string, partnerId: string): Promise<void> {
  await db.update(ticketMailboxConnections)
    .set({ status: 'disabled', deltaLink: null, updatedAt: new Date() })
    .where(and(eq(ticketMailboxConnections.id, id), eq(ticketMailboxConnections.partnerId, partnerId)));
}

/** 410 Gone: Graph invalidated the delta token. Clear it so the next sweep restarts
 *  the delta from "now" (no history backfill). Stays 'connected'. Worker-only;
 *  self-wraps in system context (FORCE RLS — see updateDeltaCursor). */
export async function resetDeltaCursor(id: string): Promise<void> {
  await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    await db.update(ticketMailboxConnections)
      .set({ deltaLink: null, updatedAt: new Date() })
      .where(eq(ticketMailboxConnections.id, id));
  }));
}

/** Lightweight Graph probe: can the app read this mailbox under the tenant's consent? */
export async function probeMailbox(tenantId: string, mailboxAddress: string): Promise<{ ok: boolean; error?: string }> {
  let token: string;
  try {
    token = await getMailboxToken(tenantId);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'token acquisition failed' };
  }
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailboxAddress)}/messages?${encodeURIComponent('$top')}=1`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' });
  if (res.ok) return { ok: true };
  return { ok: false, error: `Graph returned ${res.status}` };
}
