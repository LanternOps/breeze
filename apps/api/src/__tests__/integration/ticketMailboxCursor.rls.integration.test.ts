/**
 * Regression (real DB) for the worker-write RLS hole: ticket_mailbox_connections is
 * FORCE ROW LEVEL SECURITY, and the poll worker runs with NO request DB context.
 * Cursor/status CAS helpers therefore self-wrap in system context — otherwise the FORCE-RLS UPDATE
 * matches zero rows SILENTLY and the cursor never advances / status never updates.
 *
 * These tests call worker writes with NO surrounding context and assert the row
 * actually changed. They also prove a request-scoped no-transition retest lock
 * serializes a concurrent disable until the retest transaction releases the row.
 */
import './setup';
import { describe, it, expect, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  ticketMailboxConnections,
  ticketMailboxTenantOwnerships,
} from '../../db/schema/ticketMailbox';
import { createPartner } from './db-utils';
import { getTestDb } from './setup';

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
    await expect(updateDeltaCursor(snapshot, null, 'delta-PERSISTED', new Date(), null)).resolves.toBe(true);
    expect((await readBack(snapshot.id)).deltaLink).toBe('delta-PERSISTED');
  });

  runDb('updateDeltaCursor does not move the cursor backward when another sweep already advanced it (#8400)', async () => {
    const snapshot = await seedConnectedMailbox();
    const { updateDeltaCursor } = await import('../../services/ticketMailbox/connectionService');
    // Two sweeps both started from a null cursor; the first one commits.
    await expect(updateDeltaCursor(snapshot, null, 'resume-AHEAD', new Date(), null)).resolves.toBe(true);
    // The slower one loses the compare-and-swap and changes nothing.
    await expect(updateDeltaCursor(snapshot, null, 'resume-BEHIND', new Date(), null)).resolves.toBe(false);
    expect((await readBack(snapshot.id)).deltaLink).toBe('resume-AHEAD');
    // A sweep that started from the current cursor advances it.
    await expect(updateDeltaCursor(snapshot, 'resume-AHEAD', 'delta-DONE', new Date(), null)).resolves.toBe(true);
    expect((await readBack(snapshot.id)).deltaLink).toBe('delta-DONE');
  });

  runDb('a stale 410 does not clear a cursor another sweep already advanced (#8400)', async () => {
    const snapshot = await seedConnectedMailbox();
    const { updateDeltaCursor, resetDeltaCursor } = await import('../../services/ticketMailbox/connectionService');
    await updateDeltaCursor(snapshot, null, 'resume-R', new Date(), null);
    // Sweep B advanced R; sweep A, which also started from R, then got a 410.
    await updateDeltaCursor(snapshot, 'resume-R', 'resume-AHEAD', new Date(), null);
    await expect(resetDeltaCursor(snapshot, 'resume-R')).resolves.toBe(false);
    expect((await readBack(snapshot.id)).deltaLink).toBe('resume-AHEAD');
  });

  runDb('resetDeltaCursor clears the cursor when called with no DB context', async () => {
    const snapshot = await seedConnectedMailbox();
    const { updateDeltaCursor, resetDeltaCursor } = await import('../../services/ticketMailbox/connectionService');
    await updateDeltaCursor(snapshot, null, 'delta-to-clear', new Date(), null);
    await expect(resetDeltaCursor(snapshot, 'delta-to-clear')).resolves.toBe(true);
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

  // #8308: the transient-failure counter is a worker write like the cursor, so it
  // must self-wrap in system context and honour the same generation CAS.
  runDb('recordTransientPollFailure counts up with no DB context, and a completed poll resets it', async () => {
    const snapshot = await seedConnectedMailbox();
    const { recordTransientPollFailure, updateDeltaCursor } = await import('../../services/ticketMailbox/connectionService');
    const failedAt = new Date('2026-10-11T12:00:00Z');
    await expect(recordTransientPollFailure(snapshot, new Date('2026-10-11T11:58:30Z'))).resolves.toBe(1);
    await expect(recordTransientPollFailure(snapshot, failedAt)).resolves.toBe(2);
    await expect(recordTransientPollFailure(
      { ...snapshot, consentAttemptId: '33333333-3333-4333-8333-333333333333' },
      new Date(),
    )).resolves.toBeNull();

    const read = () => withSystemDbAccessContext(async () => (await db.select({
      count: ticketMailboxConnections.consecutiveTransientFailures,
      lastAt: ticketMailboxConnections.lastTransientFailureAt,
      lastError: ticketMailboxConnections.lastError,
      status: ticketMailboxConnections.status,
    }).from(ticketMailboxConnections).where(eq(ticketMailboxConnections.id, snapshot.id)).limit(1))[0]!);

    expect(await read()).toEqual({ count: 2, lastAt: failedAt, lastError: null, status: 'connected' });
    await updateDeltaCursor(snapshot, null, 'delta-after-recovery', new Date(), null);
    expect(await read()).toMatchObject({ count: 0, lastAt: null });
  });

  runDb('no-transition retest lock serializes a concurrent disable', async () => {
    const snapshot = await seedConnectedMailbox();
    const {
      disableConnection,
      isMailboxConnectionSnapshotCurrent,
    } = await import('../../services/ticketMailbox/connectionService');
    let releaseLock!: () => void;
    const holdLock = new Promise<void>((resolve) => { releaseLock = resolve; });
    let lockAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => { lockAcquired = resolve; });

    const recheck = withSystemDbAccessContext(async () => {
      const current = await isMailboxConnectionSnapshotCurrent(snapshot, 'connected');
      lockAcquired();
      await holdLock;
      return current;
    });
    await acquired;

    const disable = withSystemDbAccessContext(() =>
      disableConnection(snapshot.id, snapshot.partnerId),
    );
    try {
      await vi.waitFor(async () => {
        const blocked = await getTestDb().execute(sql`
          SELECT pid
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND query ILIKE '%ticket_mailbox_connections%'
        `);
        expect(blocked.length).toBeGreaterThan(0);
      }, { timeout: 5_000, interval: 25 });
    } finally {
      releaseLock();
    }

    await expect(recheck).resolves.toBe(true);
    await expect(disable).resolves.toBe(true);
    expect((await readBack(snapshot.id)).status).toBe('disabled');
  });
});
