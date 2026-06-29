/**
 * Regression (real DB) for the worker-write RLS hole: ticket_mailbox_connections is
 * FORCE ROW LEVEL SECURITY, and the poll worker runs with NO request DB context.
 * updateDeltaCursor / resetDeltaCursor / setConnectionStatus therefore self-wrap (or
 * are wrapped at the call site) in system context — otherwise the FORCE-RLS UPDATE
 * matches zero rows SILENTLY and the cursor never advances / status never updates.
 *
 * These tests call those writes with NO surrounding context (exactly as the worker
 * does) and assert the row actually changed. Before the fix they pass-but-persist-
 * nothing (0-row update, no error); the read-backs would still show the old values.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { ticketMailboxConnections } from '../../db/schema/ticketMailbox';
import { createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seedConnectedMailbox(): Promise<{ id: string; partnerId: string }> {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const [row] = await db.insert(ticketMailboxConnections).values({
      partnerId: partner.id,
      tenantId: '11111111-1111-1111-1111-111111111111',
      mailboxAddress: `support-${Date.now()}@a.com`,
      status: 'connected',
    }).returning({ id: ticketMailboxConnections.id });
    return { id: row!.id, partnerId: partner.id };
  });
}

async function readBack(id: string): Promise<{ deltaLink: string | null; status: string }> {
  return withSystemDbAccessContext(async () => {
    const rows = await db.select({ deltaLink: ticketMailboxConnections.deltaLink, status: ticketMailboxConnections.status })
      .from(ticketMailboxConnections).where(eq(ticketMailboxConnections.id, id)).limit(1);
    return rows[0]!;
  });
}

describe('ticket_mailbox_connections worker writes persist under FORCE RLS (no request context)', () => {
  runDb('updateDeltaCursor persists the cursor when called with no DB context', async () => {
    const { id } = await seedConnectedMailbox();
    const { updateDeltaCursor } = await import('../../services/ticketMailbox/connectionService');
    // Called exactly as the worker does: no surrounding withSystemDbAccessContext.
    await updateDeltaCursor(id, 'delta-PERSISTED', new Date(), null);
    expect((await readBack(id)).deltaLink).toBe('delta-PERSISTED');
  });

  runDb('resetDeltaCursor clears the cursor when called with no DB context', async () => {
    const { id } = await seedConnectedMailbox();
    const { updateDeltaCursor, resetDeltaCursor } = await import('../../services/ticketMailbox/connectionService');
    await updateDeltaCursor(id, 'delta-to-clear', new Date(), null);
    await resetDeltaCursor(id);
    expect((await readBack(id)).deltaLink).toBeNull();
  });

  runDb('setConnectionStatus persists when wrapped in system context (worker call shape)', async () => {
    const { id, partnerId } = await seedConnectedMailbox();
    const { setConnectionStatus } = await import('../../services/ticketMailbox/connectionService');
    const { runOutsideDbContext, withSystemDbAccessContext: sysCtx } = await import('../../db');
    // Mirror the worker call site: setConnectionStatus is shared (bare db), wrapped here.
    await runOutsideDbContext(() => sysCtx(() => setConnectionStatus(id, partnerId, 'reauth_required', 'token expired')));
    expect((await readBack(id)).status).toBe('reauth_required');
  });
});
