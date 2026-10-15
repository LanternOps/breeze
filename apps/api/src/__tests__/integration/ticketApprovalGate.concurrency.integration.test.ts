/**
 * Customer work approval W02 Task 4 (#4617 spec §5.2, Review Focus #1/#2):
 * the gate's lock order under real concurrency. Each race pre-holds the
 * contended row lock on a dedicated connection, starts the racers under
 * partner-scope withDbAccessContext, waits (pg_blocking_pids) until every
 * racer is queued behind it, then releases — so the interleaving is forced,
 * not hoped for. Harness from timeEntryRace.integration.test.ts.
 */
import './setup';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/timeEntryEvents', () => ({ emitTimeEntryEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/ticketEvents', async (orig) => ({
  ...(await orig<typeof import('../../services/ticketEvents')>()),
  emitTicketEvent: vi.fn().mockResolvedValue(undefined),
}));

import { sql } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import * as timeSvc from '../../services/timeEntryService';
import { decideApprovalRequest, reaskApprovalRequest, writeOffHeldEntry } from '../../services/ticketApproval/decisions';
import { getTestDb } from './setup';
import {
  actor, ctx, entriesOfTicket, insertSettledEntry, readEntry, readRequest, readRequests, seedApprovalFixture,
  type ApprovalFixture,
} from './ticketApprovalFixtures';

const RUN = !!process.env.DATABASE_URL;
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

async function waitForBlockedBackends(min: number): Promise<void> {
  const admin = getTestDb();
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rows = await admin.execute<{ waiting: number }>(sql`
      SELECT count(*)::int AS waiting FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database() AND state = 'active'
        AND cardinality(pg_catalog.pg_blocking_pids(pid)) > 0`);
    if ((rows[0]?.waiting ?? 0) >= min) return;
    if (Date.now() > deadline) throw new Error(`expected >= ${min} lock-blocked backends within 10s`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function raceBehindLock(
  lockSql: (tx: Sql) => Promise<unknown>,
  racers: () => Promise<unknown>[],
): Promise<PromiseSettledResult<unknown>[]> {
  const held = deferred<void>();
  const release = deferred<void>();
  const holder = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  let work: Promise<unknown> | undefined;
  try {
    work = holder.begin(async (tx) => {
      await lockSql(tx as unknown as Sql);
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const started = racers();
    await waitForBlockedBackends(started.length);
    release.resolve();
    await work;
    return await Promise.allSettled(started);
  } finally {
    release.resolve();
    if (work) await Promise.allSettled([work]);
    await holder.end({ timeout: 1 });
  }
}

const codeOf = (r: PromiseSettledResult<unknown>) =>
  r.status === 'rejected' ? (r.reason as { code?: string }).code : undefined;
const asUser = <T>(f: ApprovalFixture, userId: string, fn: () => Promise<T>) => withDbAccessContext(ctx(f, userId), fn);

async function runningTimer(f: ApprovalFixture, userId: string, ticketId: string, minutesAgo: number): Promise<string> {
  const e = await asUser(f, userId, () => timeSvc.startTimer({ ticketId }, actor(f, { userId })));
  await withSystemDbAccessContext(() => db.execute(
    sql`UPDATE time_entries SET started_at = now() - make_interval(secs => ${minutesAgo * 60 + 30}) WHERE id = ${e.id}::uuid`));
  return e.id;
}

describe.runIf(RUN)('approval gate concurrency (spec §5.2)', () => {
  it('two technicians stop timers on the same near-budget ticket at once: exactly one fits, one is held, one request', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 60 });
    await insertSettledEntry(f, 30);
    const a = await runningTimer(f, f.userId, f.ticketId, 30);
    const b = await runningTimer(f, f.user2Id, f.ticketId, 30);

    const settled = await raceBehindLock(
      (tx) => tx`SELECT id FROM public.tickets WHERE id = ${f.ticketId} FOR UPDATE`,
      () => [
        asUser(f, f.userId, () => timeSvc.stopTimer({}, actor(f, { userId: f.userId }))),
        asUser(f, f.user2Id, () => timeSvc.stopTimer({}, actor(f, { userId: f.user2Id }))),
      ],
    );
    expect(settled.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const statuses = [(await readEntry(a)).billingStatus, (await readEntry(b)).billingStatus].sort();
    // Never two not_billed that together exceed the ceiling.
    expect(statuses).toEqual(['awaiting_approval', 'not_billed']);
    const pending = (await readRequests(f.ticketId)).filter((r) => r.status === 'pending');
    expect(pending).toHaveLength(1);
  }, 30_000);

  it('a hold joining while an approve commits: the approve never releases an entry it did not see', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 60 });
    await insertSettledEntry(f, 60);
    const first = await asUser(f, f.userId, () => timeSvc.createTimeEntry({
      ticketId: f.ticketId, startedAt: new Date(Date.now() - 30 * 60_000), endedAt: new Date(), isBillable: true,
    }, actor(f)));
    const requestId = first.approvalHold!.requestId;

    const settled = await raceBehindLock(
      (tx) => tx`SELECT id FROM public.tickets WHERE id = ${f.ticketId} FOR UPDATE`,
      () => [
        asUser(f, f.userId, () => decideApprovalRequest(db, {
          requestId, decision: 'approved', revision: 1,
          actor: { kind: 'on_behalf', userId: f.userId, method: 'email', reference: 'Email 12:01', signerName: 'Pat' },
        })),
        asUser(f, f.user2Id, () => timeSvc.createTimeEntry({
          ticketId: f.ticketId, startedAt: new Date(Date.now() - 15 * 60_000), endedAt: new Date(), isBillable: true,
        }, actor(f, { userId: f.user2Id }))),
      ],
    );
    const [approve, join] = settled;
    expect(join!.status).toBe('fulfilled');
    const late = (join as PromiseFulfilledResult<Awaited<ReturnType<typeof timeSvc.createTimeEntry>>>).value;
    const lateRow = await readEntry(late.id);
    const req = await readRequest(requestId);
    if (approve!.status === 'fulfilled') {
      // Approve won: it released only `first`; the late entry opened a NEW request.
      expect(req.status).toBe('approved');
      expect((await readEntry(first.id)).billingStatus).toBe('not_billed');
      expect(lateRow.billingStatus).toBe('awaiting_approval');
      expect(lateRow.approvalRequestId).not.toBe(requestId);
      expect((await readRequest(lateRow.approvalRequestId!)).status).toBe('pending');
    } else {
      // The join won: revision moved, so the approve of revision 1 was refused.
      expect(codeOf(approve!)).toBe('REQUEST_CHANGED');
      expect(req).toMatchObject({ status: 'pending', revision: 2 });
      expect(lateRow).toMatchObject({ billingStatus: 'awaiting_approval', approvalRequestId: requestId });
    }
    // The forbidden state, asserted explicitly.
    expect(lateRow.billingStatus === 'not_billed' && lateRow.approvalRequestId === requestId).toBe(false);
  }, 30_000);

  it('crossed timers between two tickets (A: X→Y, B: Y→X) both complete with no 40P01', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 600 });
    const aOld = await runningTimer(f, f.userId, f.ticketId, 10);   // A on X
    const bOld = await runningTimer(f, f.user2Id, f.ticket2Id, 10); // B on Y
    const [lo, hi] = [f.ticketId, f.ticket2Id].sort() as [string, string];

    const settled = await raceBehindLock(
      (tx) => tx`SELECT id FROM public.tickets WHERE id IN (${lo}, ${hi}) ORDER BY id FOR UPDATE`,
      () => [
        asUser(f, f.userId, () => timeSvc.startTimer({ ticketId: f.ticket2Id }, actor(f, { userId: f.userId }))),
        asUser(f, f.user2Id, () => timeSvc.startTimer({ ticketId: f.ticketId }, actor(f, { userId: f.user2Id }))),
      ],
    );
    for (const r of settled) {
      if (r.status === 'rejected') throw r.reason;
    }
    expect((await readEntry(aOld)).endedAt).not.toBeNull();
    expect((await readEntry(bOld)).endedAt).not.toBeNull();
    const running = [...await entriesOfTicket(f.ticketId), ...await entriesOfTicket(f.ticket2Id)].filter((e) => e.endedAt == null);
    expect(running.map((e) => `${e.userId}:${e.ticketId}`).sort())
      .toEqual([`${f.userId}:${f.ticket2Id}`, `${f.user2Id}:${f.ticketId}`].sort());
  }, 30_000);

  it('write-off racing a re-ask on the same entry: exactly one wins and no pending request is left empty', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 60 });
    await insertSettledEntry(f, 60);
    const held = await asUser(f, f.userId, () => timeSvc.createTimeEntry({
      ticketId: f.ticketId, startedAt: new Date(Date.now() - 30 * 60_000), endedAt: new Date(), isBillable: true,
    }, actor(f)));
    const requestId = held.approvalHold!.requestId;
    await asUser(f, f.userId, () => decideApprovalRequest(db, {
      requestId, decision: 'denied', revision: 1,
      actor: { kind: 'on_behalf', userId: f.userId, method: 'verbal', reference: 'Call', signerName: 'Pat' },
    }));

    const settled = await raceBehindLock(
      (tx) => tx`SELECT id FROM public.tickets WHERE id = ${f.ticketId} FOR UPDATE`,
      () => [
        asUser(f, f.userId, () => writeOffHeldEntry(db, { entryId: held.id, actor: actor(f) })),
        asUser(f, f.user2Id, () => reaskApprovalRequest(db, { requestId, userId: f.user2Id })),
      ],
    );
    const [writeOff, reask] = settled;
    expect([writeOff!.status, reask!.status].filter((s) => s === 'fulfilled')).toHaveLength(1);
    const entry = await readEntry(held.id);
    const pending = (await readRequests(f.ticketId)).filter((r) => r.status === 'pending');
    if (writeOff!.status === 'fulfilled') {
      expect(codeOf(reask!)).toBe('NOTHING_HELD');
      expect(entry.billingStatus).toBe('no_charge');
      expect(pending).toHaveLength(0);
    } else {
      expect(codeOf(writeOff!)).toBe('ENTRY_NOT_RESOLVABLE');
      expect(entry.billingStatus).toBe('awaiting_approval');
      expect(pending).toHaveLength(1);
      expect(entry.approvalRequestId).toBe(pending[0]!.id);
    }
  }, 30_000);
});
