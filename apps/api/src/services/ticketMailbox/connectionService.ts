import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { ticketMailboxConnections } from '../../db/schema/ticketMailbox';
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

type Row = typeof ticketMailboxConnections.$inferSelect;

function toConnection(r: Row): MailboxConnection {
  return { ...r, status: r.status as MailboxConnectionStatus };
}

export async function listMailboxConnections(partnerId: string): Promise<MailboxConnection[]> {
  const rows = await db.select().from(ticketMailboxConnections)
    .where(eq(ticketMailboxConnections.partnerId, partnerId));
  return rows.map(toConnection);
}

/** System-context read across all partners — used by the poll worker (Plan 2). */
export async function listConnectedMailboxes(): Promise<MailboxConnection[]> {
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const rows = await db.select().from(ticketMailboxConnections)
      .where(eq(ticketMailboxConnections.status, 'connected'));
    return rows.map(toConnection);
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
    set: { status: 'pending_consent', displayName: input.displayName, updatedAt: new Date() },
  }).returning();
  const row = rows[0];
  if (!row) throw new Error('Failed to create pending mailbox connection');
  return toConnection(row);
}

export async function setConnectionTenant(id: string, partnerId: string, tenantId: string): Promise<void> {
  await db.update(ticketMailboxConnections)
    .set({ tenantId, updatedAt: new Date() })
    .where(and(eq(ticketMailboxConnections.id, id), eq(ticketMailboxConnections.partnerId, partnerId)));
}

export async function setConnectionStatus(
  id: string, partnerId: string, status: MailboxConnectionStatus, lastError: string | null,
): Promise<void> {
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
