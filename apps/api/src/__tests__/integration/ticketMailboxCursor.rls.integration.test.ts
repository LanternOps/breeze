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
import { randomUUID } from 'node:crypto';
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

async function seedConnectedMailbox(tenantId = '11111111-1111-4111-8111-111111111111'): Promise<{
  id: string;
  partnerId: string;
  tenantId: string;
  consentAttemptId: string;
}> {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
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
  // #10863: what the worker's floor and baseline writes do to a real row, under the
  // real provider CHECK, with no surrounding DB context, as the worker calls them.
  describe('connect baseline (#10863)', () => {
    const readBaseline = async (id: string) => (await withSystemDbAccessContext(async () => db.select({
      deltaLink: ticketMailboxConnections.deltaLink,
      eligibleAfter: ticketMailboxConnections.eligibleAfter,
      skipped: ticketMailboxConnections.baselineSkippedCount,
      completedAt: ticketMailboxConnections.baselineCompletedAt,
      status: ticketMailboxConnections.status,
    }).from(ticketMailboxConnections).where(eq(ticketMailboxConnections.id, id))))[0]!;
    const setRow = (id: string, values: Partial<typeof ticketMailboxConnections.$inferInsert>) =>
      withSystemDbAccessContext(async () => db.update(ticketMailboxConnections).set(values).where(eq(ticketMailboxConnections.id, id)));

    /** A row part-way through consent, then bound, exactly as the callback does it. */
    async function connectMailbox(): Promise<{ id: string; partnerId: string; tenantId: string; consentAttemptId: string; mailboxAddress: string }> {
      const { createPendingConnection, bindVerifiedTenant } = await import('../../services/ticketMailbox/connectionService');
      const partner = await withSystemDbAccessContext(() => createPartner());
      const tenantId = randomUUID();
      const mailboxAddress = `support-${randomUUID()}@a.com`;
      const pending = await withSystemDbAccessContext(() => createPendingConnection({
        partnerId: partner.id, mailboxAddress, displayName: null, createdBy: null,
      }));
      await withSystemDbAccessContext(() => bindVerifiedTenant(pending.id, partner.id, pending.consentAttemptId, tenantId, {
        microsoftOid: randomUUID(), breezeUserId: null,
      }));
      return { id: pending.id, partnerId: partner.id, tenantId, consentAttemptId: pending.consentAttemptId, mailboxAddress };
    }

    /** Re-consent from the row's current state, then bind again. */
    async function reconnect(partnerId: string, mailboxAddress: string, tenantId: string) {
      const { createPendingConnection, bindVerifiedTenant } = await import('../../services/ticketMailbox/connectionService');
      const pending = await withSystemDbAccessContext(() => createPendingConnection({
        partnerId, mailboxAddress, displayName: null, createdBy: null,
      }));
      await withSystemDbAccessContext(() => bindVerifiedTenant(pending.id, partnerId, pending.consentAttemptId, tenantId, {
        microsoftOid: randomUUID(), breezeUserId: null,
      }));
    }

    runDb('a new connection gets a floor at bind, on an m365 row, with its baseline open', async () => {
      const before = Date.now();
      const { id } = await connectMailbox();
      const row = await readBaseline(id);
      expect(row.status).toBe('connected');
      expect(row.deltaLink).toBeNull();
      expect(row.eligibleAfter!.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(row.eligibleAfter!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
      expect(row.skipped).toBe(0);
      expect(row.completedAt).toBeNull();
    });

    runDb('parts of a baseline add up, the first deltaLink closes it, and a losing sweep counts nothing', async () => {
      const { updateDeltaCursor } = await import('../../services/ticketMailbox/connectionService');
      const snapshot = await connectMailbox();

      await expect(updateDeltaCursor(snapshot, null, 'resume-1', new Date(), null, { skipped: 2000, completed: false })).resolves.toBe(true);
      expect(await readBaseline(snapshot.id)).toMatchObject({ deltaLink: 'resume-1', skipped: 2000, completedAt: null });

      // An overlapping sweep that also started from no cursor loses the swap.
      await expect(updateDeltaCursor(snapshot, null, 'resume-stale', new Date(), null, { skipped: 2000, completed: false })).resolves.toBe(false);
      expect(await readBaseline(snapshot.id)).toMatchObject({ deltaLink: 'resume-1', skipped: 2000, completedAt: null });

      const doneAt = new Date();
      await expect(updateDeltaCursor(snapshot, 'resume-1', 'delta-1', doneAt, null, { skipped: 487, completed: true })).resolves.toBe(true);
      const row = await readBaseline(snapshot.id);
      expect(row).toMatchObject({ deltaLink: 'delta-1', skipped: 2487 });
      expect(row.completedAt!.getTime()).toBe(doneAt.getTime());
    });

    runDb('an expired cursor restarts an open baseline count, and keeps a finished one and the floor', async () => {
      const { updateDeltaCursor, resetDeltaCursor } = await import('../../services/ticketMailbox/connectionService');

      const open = await connectMailbox();
      const openFloor = (await readBaseline(open.id)).eligibleAfter;
      await updateDeltaCursor(open, null, 'resume-1', new Date(), null, { skipped: 2000, completed: false });
      await expect(resetDeltaCursor(open, 'resume-1')).resolves.toBe(true);
      expect(await readBaseline(open.id)).toMatchObject({ deltaLink: null, skipped: 0, completedAt: null, eligibleAfter: openFloor });

      const done = await connectMailbox();
      const doneFloor = (await readBaseline(done.id)).eligibleAfter;
      await updateDeltaCursor(done, null, 'delta-1', new Date(), null, { skipped: 42, completed: true });
      await expect(resetDeltaCursor(done, 'delta-1')).resolves.toBe(true);
      const row = await readBaseline(done.id);
      expect(row).toMatchObject({ deltaLink: null, skipped: 42, eligibleAfter: doneFloor });
      expect(row.completedAt).not.toBeNull();
    });

    runDb('a re-consent keeps the floor and the finished baseline, and clears the cursor', async () => {
      const { updateDeltaCursor } = await import('../../services/ticketMailbox/connectionService');
      const snapshot = await connectMailbox();
      const floor = new Date('2026-06-01T00:00:00.000Z');
      await setRow(snapshot.id, { eligibleAfter: floor });
      await updateDeltaCursor(snapshot, null, 'delta-1', new Date(), null, { skipped: 42, completed: true });
      await setRow(snapshot.id, { status: 'reauth_required' });

      await reconnect(snapshot.partnerId, snapshot.mailboxAddress, snapshot.tenantId);

      const row = await readBaseline(snapshot.id);
      expect(row).toMatchObject({ status: 'connected', deltaLink: null, skipped: 42 });
      expect(row.eligibleAfter!.getTime()).toBe(floor.getTime());
      expect(row.completedAt).not.toBeNull();
    });

    runDb('a re-consent during an open baseline keeps the floor and restarts the count', async () => {
      const { updateDeltaCursor } = await import('../../services/ticketMailbox/connectionService');
      const snapshot = await connectMailbox();
      const floor = (await readBaseline(snapshot.id)).eligibleAfter;
      await updateDeltaCursor(snapshot, null, 'resume-1', new Date(), null, { skipped: 2000, completed: false });

      await reconnect(snapshot.partnerId, snapshot.mailboxAddress, snapshot.tenantId);

      expect(await readBaseline(snapshot.id)).toMatchObject({ deltaLink: null, skipped: 0, completedAt: null, eligibleAfter: floor });
    });

    runDb('connecting again after a disconnect is a new connection: new floor, new baseline', async () => {
      const { updateDeltaCursor, disableConnection } = await import('../../services/ticketMailbox/connectionService');
      const snapshot = await connectMailbox();
      const oldFloor = new Date('2026-06-01T00:00:00.000Z');
      await setRow(snapshot.id, { eligibleAfter: oldFloor });
      await updateDeltaCursor(snapshot, null, 'delta-1', new Date(), null, { skipped: 42, completed: true });
      await withSystemDbAccessContext(() => disableConnection(snapshot.id, snapshot.partnerId));

      const before = Date.now();
      await reconnect(snapshot.partnerId, snapshot.mailboxAddress, snapshot.tenantId);

      const row = await readBaseline(snapshot.id);
      expect(row).toMatchObject({ status: 'connected', deltaLink: null, skipped: 0, completedAt: null });
      expect(row.eligibleAfter!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    });

    runDb('a row with no cursor or floor that has polled seeds from its last poll, already baselined', async () => {
      const { seedDeltaFloor } = await import('../../services/ticketMailbox/connectionService');
      const snapshot = await seedConnectedMailbox(randomUUID());
      const lastPolledAt = new Date('2026-10-30T08:00:00.000Z');
      await setRow(snapshot.id, { lastPolledAt });

      const now = new Date();
      const seeded = await seedDeltaFloor(snapshot, now);

      // Five minutes before the last poll: mail the last round read but had not
      // committed yet is re-offered, and dedup absorbs what was ingested.
      const expectedFloor = lastPolledAt.getTime() - 5 * 60_000;
      expect(seeded!.eligibleAfter.getTime()).toBe(expectedFloor);
      expect(seeded!.baselineCompletedAt!.getTime()).toBe(now.getTime());
      const row = await readBaseline(snapshot.id);
      expect(row.eligibleAfter!.getTime()).toBe(expectedFloor);
      expect(row.completedAt).not.toBeNull();
    });

    runDb('re-consenting a mailbox from before the floor picks up from its last poll, not from the reconnect', async () => {
      const { updateDeltaCursor } = await import('../../services/ticketMailbox/connectionService');
      const snapshot = await seedConnectedMailbox(randomUUID());
      const lastPolledAt = new Date('2026-10-30T08:00:00.000Z');
      await updateDeltaCursor(snapshot, null, 'delta-legacy', lastPolledAt, null);
      await setRow(snapshot.id, { status: 'reauth_required' });
      const mailboxAddress = (await withSystemDbAccessContext(async () => db.select({ m: ticketMailboxConnections.mailboxAddress })
        .from(ticketMailboxConnections).where(eq(ticketMailboxConnections.id, snapshot.id))))[0]!.m;

      await reconnect(snapshot.partnerId, mailboxAddress, snapshot.tenantId);

      const row = await readBaseline(snapshot.id);
      expect(row).toMatchObject({ status: 'connected', deltaLink: null, skipped: 0 });
      expect(row.eligibleAfter!.getTime()).toBe(lastPolledAt.getTime() - 5 * 60_000);
      // Not a connect, so the card says nothing about mail "already in this inbox".
      expect(row.completedAt).not.toBeNull();
    });

    runDb('a gmail address re-connected through Microsoft starts a fresh floor and baseline', async () => {
      const { createPendingConnection, bindVerifiedTenant } = await import('../../services/ticketMailbox/connectionService');
      const partner = await withSystemDbAccessContext(() => createPartner());
      const mailboxAddress = `support-${randomUUID()}@a.com`;
      await withSystemDbAccessContext(() => getTestDb().execute(sql`
        INSERT INTO ticket_mailbox_connections (partner_id, provider, mailbox_address, status, eligible_after)
        VALUES (${partner.id}, 'gmail', ${mailboxAddress}, 'reauth_required', '2026-01-01T00:00:00Z')
      `));

      const before = Date.now();
      const pending = await withSystemDbAccessContext(() => createPendingConnection({
        partnerId: partner.id, mailboxAddress, displayName: null, createdBy: null,
      }));
      await withSystemDbAccessContext(() => bindVerifiedTenant(pending.id, partner.id, pending.consentAttemptId, randomUUID(), {
        microsoftOid: randomUUID(), breezeUserId: null,
      }));

      const row = await readBaseline(pending.id);
      expect(row).toMatchObject({ status: 'connected', skipped: 0, completedAt: null });
      expect(row.eligibleAfter!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    });

    runDb('a row with no cursor or floor that never polled seeds from now, with its baseline open', async () => {
      const { seedDeltaFloor } = await import('../../services/ticketMailbox/connectionService');
      const snapshot = await seedConnectedMailbox(randomUUID());

      const now = new Date();
      const seeded = await seedDeltaFloor(snapshot, now);

      expect(seeded!.eligibleAfter.getTime()).toBe(now.getTime());
      expect(seeded!.baselineCompletedAt).toBeNull();
    });

    runDb('the seed lands once, and never on a row that already has a cursor or a floor', async () => {
      const { seedDeltaFloor, updateDeltaCursor } = await import('../../services/ticketMailbox/connectionService');
      const snapshot = await seedConnectedMailbox(randomUUID());
      await expect(seedDeltaFloor(snapshot, new Date())).resolves.not.toBeNull();
      await expect(seedDeltaFloor(snapshot, new Date())).resolves.toBeNull();

      // An existing connection with a cursor is left without a floor.
      const existing = await seedConnectedMailbox(randomUUID());
      await updateDeltaCursor(existing, null, 'delta-1', new Date(), null);
      await expect(seedDeltaFloor(existing, new Date())).resolves.toBeNull();
      expect((await readBaseline(existing.id)).eligibleAfter).toBeNull();
    });

    runDb('the provider CHECK still refuses baseline state on a gmail row', async () => {
      const snapshot = await seedConnectedMailbox(randomUUID());
      const write = () => withSystemDbAccessContext(() => getTestDb().execute(sql`
        UPDATE ticket_mailbox_connections
           SET provider = 'gmail', tenant_id = NULL, status = 'pending_consent', baseline_skipped_count = 5
         WHERE id = ${snapshot.id}
      `));
      const err = await write().catch((e: unknown) => e) as Error & { cause?: Error };
      expect(`${err.message} ${err.cause?.message ?? ''}`).toContain('ticket_mailbox_connections_provider_fields_consistent');
    });
  });

  runDb('recordPollAttempt persists with no DB context (#8308)', async () => {
    const snapshot = await seedConnectedMailbox(randomUUID());
    const { recordPollAttempt } = await import('../../services/ticketMailbox/connectionService');
    // Called exactly as the worker does: no surrounding withSystemDbAccessContext.
    await expect(recordPollAttempt(snapshot, 30_000)).resolves.toBe(true);
    const rows = await withSystemDbAccessContext(async () => db.select({ at: ticketMailboxConnections.lastPollAttemptAt })
      .from(ticketMailboxConnections).where(eq(ticketMailboxConnections.id, snapshot.id)));
    expect(rows[0]!.at).toBeInstanceOf(Date);
  });

  runDb('the sweep lists the never-attempted first, then the oldest attempt (#8308)', async () => {
    const { listConnectedMailboxes } = await import('../../services/ticketMailbox/connectionService');
    // Built so the physical row order is the reverse of the expected order (an
    // UPDATE writes a new row version at the end of the heap), so the result can
    // only come from the ORDER BY: physical order ends up a, b, never.
    const a = await seedConnectedMailbox(randomUUID());
    const b = await seedConnectedMailbox(randomUUID());
    const stamp = (id: string, at: Date) => withSystemDbAccessContext(async () => db.update(ticketMailboxConnections)
      .set({ lastPollAttemptAt: at }).where(eq(ticketMailboxConnections.id, id)));
    await stamp(a.id, new Date(Date.now() - 5_000));
    await stamp(b.id, new Date(Date.now() - 10_000));
    const never = await seedConnectedMailbox(randomUUID());

    const ours = new Set([never.id, a.id, b.id]);
    const order = (await listConnectedMailboxes()).map((c) => c.id).filter((id) => ours.has(id));
    expect(order).toEqual([never.id, b.id, a.id]);
  });

  runDb('recordPollAttempt is a claim: a second sweep inside the window gets false and the stamp stays (#8308)', async () => {
    const snapshot = await seedConnectedMailbox(randomUUID());
    const { recordPollAttempt } = await import('../../services/ticketMailbox/connectionService');
    const read = async () => (await withSystemDbAccessContext(async () => db.select({ at: ticketMailboxConnections.lastPollAttemptAt })
      .from(ticketMailboxConnections).where(eq(ticketMailboxConnections.id, snapshot.id))))[0]!.at;

    await expect(recordPollAttempt(snapshot, 30_000)).resolves.toBe(true);
    const first = await read();
    // An overlapping sweep reaching the same mailbox moments later.
    await expect(recordPollAttempt(snapshot, 30_000)).resolves.toBe(false);
    expect(await read()).toEqual(first);

    // Once the window has passed, the next sweep claims it again and moves it forward.
    // (Concurrent overlap is covered by the row-lock test below.)
    const old = new Date(Date.now() - 31_000);
    await withSystemDbAccessContext(async () => db.update(ticketMailboxConnections)
      .set({ lastPollAttemptAt: old }).where(eq(ticketMailboxConnections.id, snapshot.id)));
    await expect(recordPollAttempt(snapshot, 30_000)).resolves.toBe(true);
    expect((await read())!.getTime()).toBeGreaterThan(old.getTime());
  });

  runDb('two overlapping stamps serialize on the row lock and the second gets false (#8308)', async () => {
    const snapshot = await seedConnectedMailbox(randomUUID());
    const { recordPollAttempt } = await import('../../services/ticketMailbox/connectionService');
    let secondSettled = false;
    let second!: Promise<boolean>;
    // Sweep A stamps inside a transaction it holds open; sweep B (its own
    // connection, as recordPollAttempt opens one outside any context) reaches the
    // same row meanwhile and must wait for A's commit, then see A's stamp.
    await withSystemDbAccessContext(async () => {
      await db.update(ticketMailboxConnections)
        .set({ lastPollAttemptAt: sql`clock_timestamp()` })
        .where(eq(ticketMailboxConnections.id, snapshot.id));
      second = recordPollAttempt(snapshot, 30_000);
      second.then(() => { secondSettled = true; }, () => { secondSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(secondSettled).toBe(false);
    });
    await expect(second).resolves.toBe(false);
  });

  runDb('recordPollAttempt never moves a stamp backward (#8308)', async () => {
    const snapshot = await seedConnectedMailbox(randomUUID());
    const { recordPollAttempt } = await import('../../services/ticketMailbox/connectionService');
    // A value from a clock ahead of this one is already committed. With a zero
    // window the stamp lands, and GREATEST keeps the larger value.
    const ahead = new Date(Date.now() + 60 * 60 * 1000);
    await withSystemDbAccessContext(async () => db.update(ticketMailboxConnections)
      .set({ lastPollAttemptAt: ahead }).where(eq(ticketMailboxConnections.id, snapshot.id)));
    await expect(recordPollAttempt(snapshot, -2 * 60 * 60 * 1000)).resolves.toBe(true);
    const rows = await withSystemDbAccessContext(async () => db.select({ at: ticketMailboxConnections.lastPollAttemptAt })
      .from(ticketMailboxConnections).where(eq(ticketMailboxConnections.id, snapshot.id)));
    expect(rows[0]!.at).toEqual(ahead);
  });

  runDb('releasePollAttempt clears the stamp with no DB context, so the mailbox lists first again (#8308)', async () => {
    const { recordPollAttempt, releasePollAttempt, listConnectedMailboxes } = await import('../../services/ticketMailbox/connectionService');
    const late = await seedConnectedMailbox(randomUUID());
    const other = await seedConnectedMailbox(randomUUID());
    await withSystemDbAccessContext(async () => db.update(ticketMailboxConnections)
      .set({ lastPollAttemptAt: new Date(Date.now() - 60_000) }).where(eq(ticketMailboxConnections.id, other.id)));
    await expect(recordPollAttempt(late, 30_000)).resolves.toBe(true);
    const ours = new Set([late.id, other.id]);
    const listed = async () => (await listConnectedMailboxes()).map((c) => c.id).filter((id) => ours.has(id));
    // Freshly stamped, the late mailbox sorts after the older attempt.
    expect(await listed()).toEqual([other.id, late.id]);

    // Called exactly as the worker does: no surrounding withSystemDbAccessContext.
    await expect(releasePollAttempt(late)).resolves.toBe(true);
    const rows = await withSystemDbAccessContext(async () => db.select({ at: ticketMailboxConnections.lastPollAttemptAt })
      .from(ticketMailboxConnections).where(eq(ticketMailboxConnections.id, late.id)));
    expect(rows[0]!.at).toBeNull();
    expect(await listed()).toEqual([late.id, other.id]);
  });

  runDb('releasePollAttempt leaves a stale generation alone and says so (#8308)', async () => {
    const snapshot = await seedConnectedMailbox(randomUUID());
    const { recordPollAttempt, releasePollAttempt } = await import('../../services/ticketMailbox/connectionService');
    await expect(recordPollAttempt(snapshot, 30_000)).resolves.toBe(true);
    await expect(releasePollAttempt({ ...snapshot, consentAttemptId: randomUUID() })).resolves.toBe(false);
    const rows = await withSystemDbAccessContext(async () => db.select({ at: ticketMailboxConnections.lastPollAttemptAt })
      .from(ticketMailboxConnections).where(eq(ticketMailboxConnections.id, snapshot.id)));
    expect(rows[0]!.at).toBeInstanceOf(Date);
  });

  runDb('recordPollAttempt does not stamp a stale generation and says so (#8308)', async () => {
    const snapshot = await seedConnectedMailbox(randomUUID());
    const { recordPollAttempt } = await import('../../services/ticketMailbox/connectionService');
    await expect(recordPollAttempt({ ...snapshot, consentAttemptId: randomUUID() }, 30_000)).resolves.toBe(false);
    const rows = await withSystemDbAccessContext(async () => db.select({ at: ticketMailboxConnections.lastPollAttemptAt })
      .from(ticketMailboxConnections).where(eq(ticketMailboxConnections.id, snapshot.id)));
    expect(rows[0]!.at).toBeNull();
  });

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
