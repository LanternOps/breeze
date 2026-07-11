/**
 * Regression (real DB) for the worker-write RLS hole: ticket_mailbox_connections is
 * FORCE ROW LEVEL SECURITY, and the poll worker runs with NO request DB context.
 * Cursor/status CAS helpers therefore self-wrap in system context — otherwise the FORCE-RLS UPDATE
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
import {
  ticketMailboxConnections,
  ticketMailboxTenantOwnerships,
} from '../../db/schema/ticketMailbox';
import { createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seedConnectedMailbox(): Promise<{
  id: string;
  partnerId: string;
  tenantId: string;
  consentAttemptId: string;
}> {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const tenantId = '11111111-1111-4111-8111-111111111111';
    await db.insert(ticketMailboxTenantOwnerships).values({
      tenantId,
      partnerId: partner.id,
      verifiedMicrosoftOid: '22222222-2222-4222-8222-222222222222',
    });
    const [row] = await db.insert(ticketMailboxConnections).values({
      partnerId: partner.id,
      tenantId,
      mailboxAddress: `support-${Date.now()}@a.com`,
      status: 'connected',
    }).returning({
      id: ticketMailboxConnections.id,
      consentAttemptId: ticketMailboxConnections.consentAttemptId,
    });
    return { id: row!.id, partnerId: partner.id, tenantId, consentAttemptId: row!.consentAttemptId };
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
    const snapshot = await seedConnectedMailbox();
    const { updateDeltaCursor } = await import('../../services/ticketMailbox/connectionService');
    // Called exactly as the worker does: no surrounding withSystemDbAccessContext.
    await expect(updateDeltaCursor(snapshot, 'delta-PERSISTED', new Date(), null)).resolves.toBe(true);
    expect((await readBack(snapshot.id)).deltaLink).toBe('delta-PERSISTED');
  });

  runDb('resetDeltaCursor clears the cursor when called with no DB context', async () => {
    const snapshot = await seedConnectedMailbox();
    const { updateDeltaCursor, resetDeltaCursor } = await import('../../services/ticketMailbox/connectionService');
    await updateDeltaCursor(snapshot, 'delta-to-clear', new Date(), null);
    await expect(resetDeltaCursor(snapshot)).resolves.toBe(true);
    expect((await readBack(snapshot.id)).deltaLink).toBeNull();
  });

  runDb('status CAS persists in system context and rejects a stale generation', async () => {
    const snapshot = await seedConnectedMailbox();
    const { setConnectedMailboxStatus } = await import('../../services/ticketMailbox/connectionService');
    await expect(setConnectedMailboxStatus(
      { ...snapshot, consentAttemptId: '33333333-3333-4333-8333-333333333333' },
      'reauth_required',
      'stale token',
    )).resolves.toBe(false);
    expect((await readBack(snapshot.id)).status).toBe('connected');
    await expect(setConnectedMailboxStatus(snapshot, 'reauth_required', 'token expired')).resolves.toBe(true);
    expect((await readBack(snapshot.id)).status).toBe('reauth_required');
  });
});
