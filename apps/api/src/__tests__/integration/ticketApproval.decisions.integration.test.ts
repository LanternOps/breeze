/**
 * Customer work approval W02 Task 5 (#4617 spec §5.6): decide / cancel /
 * re-ask / write-off / staff-raised / expire, against real Postgres under a
 * partner-scope request context (system scope for the sweep).
 */
import './setup';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/timeEntryEvents', () => ({ emitTimeEntryEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/ticketEvents', async (orig) => ({
  ...(await orig<typeof import('../../services/ticketEvents')>()),
  emitTicketEvent: vi.fn().mockResolvedValue(undefined),
}));

import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { portalUsers } from '../../db/schema';
import * as timeSvc from '../../services/timeEntryService';
import {
  cancelApprovalRequest, createStaffApprovalRequest, decideApprovalRequest, expireDueApprovalRequests,
  reaskApprovalRequest, writeOffHeldEntry, type DecisionActor,
} from '../../services/ticketApproval/decisions';
import {
  actor, addContact, ctx, insertSettledEntry, readEntry, readRequest, readRequests, seedApprovalFixture,
  type ApprovalFixture,
} from './ticketApprovalFixtures';

const RUN = !!process.env.DATABASE_URL;
const ago = (min: number) => new Date(Date.now() - min * 60_000);
const asTech = <T>(f: ApprovalFixture, fn: () => Promise<T>) => withDbAccessContext(ctx(f), fn);

async function rejected(p: Promise<unknown>): Promise<{ status?: number; code?: string }> {
  try { await p; } catch (err) { return err as { status?: number; code?: string }; }
  throw new Error('expected a rejection');
}

function onBehalf(f: ApprovalFixture, o: Partial<Extract<DecisionActor, { kind: 'on_behalf' }>> = {}): DecisionActor {
  return { kind: 'on_behalf', userId: f.userId, method: 'verbal', reference: 'Phone call 10:14', signerName: 'Pat Customer', ...o };
}

/** A held entry of `minutes` created through the real writer. */
async function logHeld(f: ApprovalFixture, minutes: number, o: { workTypeId?: string; ticketId?: string } = {}) {
  const e = await asTech(f, () => timeSvc.createTimeEntry({
    ticketId: o.ticketId ?? f.ticketId, startedAt: ago(minutes), endedAt: new Date(), isBillable: true,
    ...(o.workTypeId ? { workTypeId: o.workTypeId } : {}),
  }, actor(f)));
  return e;
}

async function portalUser(orgId: string, email: string): Promise<string> {
  const [u] = await withSystemDbAccessContext(() => db.insert(portalUsers).values({ orgId, email, name: 'Portal person' })
    .returning({ id: portalUsers.id }));
  return u!.id;
}

describe.runIf(RUN)('decideApprovalRequest — approve', () => {
  it('on behalf: stamps the decision at the seen revision, copies the ask, and releases the held entries', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 60 });
    await insertSettledEntry(f, 60);
    const held = await logHeld(f, 30);
    const requestId = held.approvalHold!.requestId;
    const res = await asTech(f, () => decideApprovalRequest(db, { requestId, decision: 'approved', revision: 1, actor: onBehalf(f) }));
    expect(res.released).toEqual([held.id]);
    expect(res.stillHeld).toEqual([]);
    expect(await readRequest(requestId)).toMatchObject({
      status: 'approved', decisionOrigin: 'on_behalf', decidedRevision: 1, decidedByUserId: f.userId,
      decisionMethod: 'verbal', decisionReference: 'Phone call 10:14', signerName: 'Pat Customer',
      approvedExtensionMinutes: 30,
    });
    const e = await readEntry(held.id);
    expect(e.billingStatus).toBe('not_billed');
    expect(e.approvalRequestId).toBe(requestId); // provenance kept
  });

  it('a stale revision is 409 REQUEST_CHANGED and releases nothing', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 60 });
    await insertSettledEntry(f, 60);
    const a = await logHeld(f, 30);
    await logHeld(f, 15); // joins → revision 2
    const err = await rejected(asTech(f, () => decideApprovalRequest(db, {
      requestId: a.approvalHold!.requestId, decision: 'approved', revision: 1, actor: onBehalf(f),
    })));
    expect(err).toMatchObject({ status: 409, code: 'REQUEST_CHANGED' });
    expect((await readEntry(a.id)).billingStatus).toBe('awaiting_approval');
    expect((await readRequest(a.approvalHold!.requestId)).status).toBe('pending');
  });

  it('an extension smaller than the overage leaves the excess entry held on a NEW request', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 60 });
    await insertSettledEntry(f, 60);
    const a = await logHeld(f, 30);
    const b = await logHeld(f, 30); // ask 60
    // The ticket budget is cut after the ask was made: the approved +60 no longer covers both.
    await withSystemDbAccessContext(() => db.execute(sql`UPDATE tickets SET budget_minutes = 30 WHERE id = ${f.ticketId}::uuid`));
    const res = await asTech(f, () => decideApprovalRequest(db, { requestId: a.approvalHold!.requestId, decision: 'approved', revision: 2, actor: onBehalf(f) }));
    expect(res.released).toEqual([[a.id, b.id].sort()[0]]);
    expect(res.stillHeld).toEqual([[a.id, b.id].sort()[1]]);
    const still = await readEntry(res.stillHeld[0]!);
    expect(still.billingStatus).toBe('awaiting_approval');
    expect(still.approvalRequestId).not.toBe(a.approvalHold!.requestId);
    expect((await readRequest(still.approvalRequestId!)).status).toBe('pending');
  });

  it('queue-rule regression: budget 120, 90 consumed, 60 held, then 20 logged — approving the recomputed ask releases both', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 120 });
    await insertSettledEntry(f, 90);
    const big = await logHeld(f, 60);
    const small = await logHeld(f, 20);
    expect(small.approvalHold!.requestId).toBe(big.approvalHold!.requestId);
    const req = await readRequest(big.approvalHold!.requestId);
    expect(req.requestedExtensionMinutes).toBe(60);
    const res = await asTech(f, () => decideApprovalRequest(db, { requestId: req.id, decision: 'approved', revision: req.revision, actor: onBehalf(f) }));
    expect(res.released.sort()).toEqual([big.id, small.id].sort());
    expect(res.stillHeld).toEqual([]);
  });

  it('after-hours then budget: approving each releases the entry once, never re-holding it on the trigger already cleared', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 60 });
    await insertSettledEntry(f, 60);
    const e = await logHeld(f, 30, { workTypeId: f.afterHoursWorkTypeId });
    expect(e.approvalHold!.trigger).toBe('after_hours');
    const ah = await asTech(f, () => decideApprovalRequest(db, { requestId: e.approvalHold!.requestId, decision: 'approved', revision: 1, actor: onBehalf(f) }));
    expect(ah.stillHeld).toEqual([e.id]); // released from after-hours, now over budget
    const afterAh = await readEntry(e.id);
    const budgetReq = await readRequest(afterAh.approvalRequestId!);
    expect(budgetReq).toMatchObject({ trigger: 'budget', status: 'pending' });
    const bud = await asTech(f, () => decideApprovalRequest(db, { requestId: budgetReq.id, decision: 'approved', revision: budgetReq.revision, actor: onBehalf(f) }));
    expect(bud.released).toEqual([e.id]);
    expect((await readEntry(e.id)).billingStatus).toBe('not_billed');
    expect((await readRequests(f.ticketId)).filter((r) => r.status === 'pending')).toHaveLength(0);
  });
});

describe.runIf(RUN)('decideApprovalRequest — who may decide', () => {
  it('a customer whose email is an approver for this org may approve; notify-only gets 403; another org gets 403', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 60 });
    await addContact(f, 'boss@example.test', [{ role: 'billing' }]);
    const requester = await addContact(f, 'req@example.test', [{ role: 'technical' }]);
    await withSystemDbAccessContext(() => db.execute(sql`UPDATE tickets SET requester_contact_id = ${requester}::uuid WHERE id = ${f.ticketId}::uuid`));
    await insertSettledEntry(f, 60);
    const held = await logHeld(f, 30);
    const requestId = held.approvalHold!.requestId;
    const notifyOnly = await portalUser(f.orgId, 'req@example.test');
    const otherOrg = await portalUser(f.otherOrgId, 'boss@example.test');
    const boss = await portalUser(f.orgId, 'Boss@Example.test');
    const customer = (portalUserId: string, email: string): DecisionActor =>
      ({ kind: 'customer', portalUserId, email, signerName: 'Boss', ip: '203.0.113.9', userAgent: 'vitest' });

    expect(await rejected(asTech(f, () => decideApprovalRequest(db, { requestId, decision: 'approved', revision: 1, actor: customer(notifyOnly, 'req@example.test') }))))
      .toMatchObject({ status: 403 });
    expect(await rejected(asTech(f, () => decideApprovalRequest(db, { requestId, decision: 'approved', revision: 1, actor: customer(otherOrg, 'boss@example.test') }))))
      .toMatchObject({ status: 403 });
    await asTech(f, () => decideApprovalRequest(db, { requestId, decision: 'approved', revision: 1, actor: customer(boss, 'BOSS@example.test') }));
    expect(await readRequest(requestId)).toMatchObject({
      status: 'approved', decisionOrigin: 'customer', decidedByPortalUserId: boss, signerEmail: 'boss@example.test',
      ipAddress: '203.0.113.9', userAgent: 'vitest',
    });
  });

  it('on behalf requires a non-blank reference (400) and a non-pending request is 409', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 60 });
    await insertSettledEntry(f, 60);
    const held = await logHeld(f, 30);
    const requestId = held.approvalHold!.requestId;
    expect(await rejected(asTech(f, () => decideApprovalRequest(db, { requestId, decision: 'approved', revision: 1, actor: onBehalf(f, { reference: '  ' }) }))))
      .toMatchObject({ status: 400 });
    await asTech(f, () => decideApprovalRequest(db, { requestId, decision: 'denied', revision: 1, actor: onBehalf(f) }));
    expect(await rejected(asTech(f, () => decideApprovalRequest(db, { requestId, decision: 'approved', revision: 1, actor: onBehalf(f) }))))
      .toMatchObject({ status: 409, code: 'REQUEST_NOT_PENDING' });
  });

  it('a request past its expiry is 409 REQUEST_EXPIRED (the sweep expires it)', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 60 });
    await insertSettledEntry(f, 60);
    const held = await logHeld(f, 30);
    await withSystemDbAccessContext(() => db.execute(sql`UPDATE ticket_approval_requests SET expires_at = now() - interval '1 minute' WHERE id = ${held.approvalHold!.requestId}::uuid`));
    expect(await rejected(asTech(f, () => decideApprovalRequest(db, { requestId: held.approvalHold!.requestId, decision: 'approved', revision: 1, actor: onBehalf(f) }))))
      .toMatchObject({ status: 409, code: 'REQUEST_EXPIRED' });
    expect((await readEntry(held.id)).billingStatus).toBe('awaiting_approval');
  });
});

describe.runIf(RUN)('deny, write-off, re-ask', () => {
  it('deny stamps only: entries stay awaiting_approval linked to the denied request', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 60 });
    await insertSettledEntry(f, 60);
    const held = await logHeld(f, 30);
    const res = await asTech(f, () => decideApprovalRequest(db, { requestId: held.approvalHold!.requestId, decision: 'denied', revision: 1, note: 'Not this month', actor: onBehalf(f) }));
    expect(res).toMatchObject({ released: [], stillHeld: [held.id] });
    expect(await readRequest(held.approvalHold!.requestId)).toMatchObject({ status: 'denied', decisionNote: 'Not this month', approvedExtensionMinutes: null });
    expect(await readEntry(held.id)).toMatchObject({ billingStatus: 'awaiting_approval', approvalRequestId: held.approvalHold!.requestId });
  });

  it('write-off needs manage billing (403), refuses a pending request (409), and on a denied one sets no_charge + audit', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 60 });
    await insertSettledEntry(f, 60);
    const held = await logHeld(f, 30);
    const audits: unknown[] = [];
    expect(await rejected(asTech(f, () => writeOffHeldEntry(db, { entryId: held.id, actor: actor(f, { manageBilling: false }) }))))
      .toMatchObject({ status: 403 });
    expect(await rejected(asTech(f, () => writeOffHeldEntry(db, { entryId: held.id, actor: actor(f) }))))
      .toMatchObject({ status: 409, code: 'ENTRY_NOT_RESOLVABLE' });
    await asTech(f, () => decideApprovalRequest(db, { requestId: held.approvalHold!.requestId, decision: 'denied', revision: 1, actor: onBehalf(f) }));
    await asTech(f, () => writeOffHeldEntry(db, { entryId: held.id, actor: actor(f, { recordAuditMutation: (m) => audits.push(m) }) }));
    expect((await readEntry(held.id)).billingStatus).toBe('no_charge');
    expect(audits).toEqual([expect.objectContaining({ action: 'time_entry.approval_written_off', entryId: held.id })]);
  });

  it('re-ask moves a denied request\'s held entries onto a new staff request; the old one stays denied', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 60 });
    await insertSettledEntry(f, 60);
    const held = await logHeld(f, 30);
    const oldId = held.approvalHold!.requestId;
    await asTech(f, () => decideApprovalRequest(db, { requestId: oldId, decision: 'denied', revision: 1, actor: onBehalf(f) }));
    const { newRequestId } = await asTech(f, () => reaskApprovalRequest(db, { requestId: oldId, userId: f.userId, message: 'Revised scope' }));
    expect(newRequestId).not.toBe(oldId);
    expect(await readRequest(newRequestId)).toMatchObject({ status: 'pending', origin: 'staff', requestedByUserId: f.userId, message: 'Revised scope', requestedExtensionMinutes: 30 });
    expect((await readRequest(oldId)).status).toBe('denied');
    expect((await readEntry(held.id)).approvalRequestId).toBe(newRequestId);
    expect(await rejected(asTech(f, () => reaskApprovalRequest(db, { requestId: newRequestId, userId: f.userId }))))
      .toMatchObject({ status: 409 });
  });
});

describe.runIf(RUN)('cancel, staff-raised, expire', () => {
  it('cancel releases entries that now fit and re-holds the rest on a new pending request', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 60 });
    await insertSettledEntry(f, 30);
    const big = await logHeld(f, 45);   // 30 + 45 > 60 → held
    const small = await logHeld(f, 10); // queue rule → joins
    const requestId = big.approvalHold!.requestId;
    expect(small.approvalHold!.requestId).toBe(requestId);
    const res = await asTech(f, () => cancelApprovalRequest(db, { requestId, userId: f.userId }));
    expect((await readRequest(requestId)).status).toBe('cancelled');
    // id order: whichever entry is first is re-gated first; the 10 fits on its own (30+10 ≤ 60), the 45 does not.
    const bigRow = await readEntry(big.id);
    const smallRow = await readEntry(small.id);
    if (big.id < small.id) {
      expect(bigRow.billingStatus).toBe('awaiting_approval');
      expect(smallRow.billingStatus).toBe('awaiting_approval'); // queue rule: a new pending request heads the queue
    } else {
      expect(smallRow.billingStatus).toBe('not_billed');
      expect(bigRow.billingStatus).toBe('awaiting_approval');
    }
    expect(bigRow.approvalRequestId).not.toBe(requestId);
    expect((await readRequest(bigRow.approvalRequestId!)).status).toBe('pending');
    expect(res.released.length + res.stillHeld.length).toBe(2);
  });

  it('a staff-raised after-hours window, once approved, covers later after-hours work in it', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 600 });
    const start = ago(120);
    const { requestId } = await asTech(f, () => createStaffApprovalRequest(db, {
      ticketId: f.ticketId, userId: f.userId, trigger: 'after_hours', message: 'Weekend migration',
      coverageStartsAt: start, coverageEndsAt: new Date(Date.now() + 3600_000),
    }));
    expect(await readRequest(requestId)).toMatchObject({ origin: 'staff', trigger: 'after_hours', status: 'pending' });
    await asTech(f, () => decideApprovalRequest(db, { requestId, decision: 'approved', revision: 1, actor: onBehalf(f) }));
    const e = await logHeld(f, 30, { workTypeId: f.afterHoursWorkTypeId });
    expect(e.billingStatus).toBe('not_billed');
  });

  it('a staff-raised budget request rejects a missing extension (400) and a second pending one (409)', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 60 });
    expect(await rejected(asTech(f, () => createStaffApprovalRequest(db, { ticketId: f.ticketId, userId: f.userId, trigger: 'budget' }))))
      .toMatchObject({ status: 400 });
    const { requestId } = await asTech(f, () => createStaffApprovalRequest(db, { ticketId: f.ticketId, userId: f.userId, trigger: 'budget', extensionMinutes: 120 }));
    expect(await readRequest(requestId)).toMatchObject({ requestedExtensionMinutes: 120, origin: 'staff' });
    expect(await rejected(asTech(f, () => createStaffApprovalRequest(db, { ticketId: f.ticketId, userId: f.userId, trigger: 'budget', extensionMinutes: 30 }))))
      .toMatchObject({ status: 409 });
  });

  it('a staff budget ask survives later work joining it (queue rule) and approving it honours the staff figure', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 60 });
    const { requestId } = await asTech(f, () => createStaffApprovalRequest(db, { ticketId: f.ticketId, userId: f.userId, trigger: 'budget', extensionMinutes: 120 }));
    const e = await logHeld(f, 10); // fits the budget, but the pending staff request heads the queue
    expect(e.billingStatus).toBe('awaiting_approval');
    expect(e.approvalHold!.requestId).toBe(requestId);
    const req = await readRequest(requestId);
    expect(req).toMatchObject({ revision: 2, requestedExtensionMinutes: 120 });
    await asTech(f, () => decideApprovalRequest(db, { requestId, decision: 'approved', revision: 2, actor: onBehalf(f) }));
    expect((await readRequest(requestId)).approvedExtensionMinutes).toBe(120);
    expect((await readEntry(e.id)).billingStatus).toBe('not_billed');
  });

  it('money-only budget: approving copies the amount and lifts the money ceiling for later work', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: null, budgetAmount: '100.00' });
    await insertSettledEntry(f, 60); // 100.00
    const held = await asTech(f, () => timeSvc.createTimeEntry({ ticketId: f.ticketId, startedAt: ago(30), endedAt: new Date(), isBillable: true, hourlyRate: 100 }, actor(f)));
    expect(await readRequest(held.approvalHold!.requestId)).toMatchObject({ requestedExtensionAmount: '50.00', requestedExtensionMinutes: null });
    await asTech(f, () => decideApprovalRequest(db, { requestId: held.approvalHold!.requestId, decision: 'approved', revision: 1, actor: onBehalf(f) }));
    expect(await readRequest(held.approvalHold!.requestId)).toMatchObject({ approvedExtensionAmount: '50.00' });
    expect((await readEntry(held.id)).billingStatus).toBe('not_billed');
    const next = await asTech(f, () => timeSvc.createTimeEntry({ ticketId: f.ticketId, startedAt: ago(6), endedAt: new Date(), isBillable: true, hourlyRate: 100 }, actor(f)));
    expect(next.billingStatus).toBe('awaiting_approval'); // 150.00 + 10.00 > 150.00
  });

  it('expire marks due pending requests expired, one event each, and leaves their entries held', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 60 });
    await insertSettledEntry(f, 60);
    const held = await logHeld(f, 30);
    const notDue = await logHeld(f, 20, { ticketId: f.ticket2Id }); // ticket2 has budget 120: fits → not held
    expect(notDue.approvalHold).toBeNull();
    await withSystemDbAccessContext(() => db.execute(sql`UPDATE ticket_approval_requests SET expires_at = now() - interval '1 minute' WHERE id = ${held.approvalHold!.requestId}::uuid`));
    const { expired, events } = await expireDueApprovalRequests(new Date());
    expect(expired).toBe(1);
    expect(events).toEqual([expect.objectContaining({ type: 'ticket.approval_decided', payload: expect.objectContaining({ status: 'expired', requestId: held.approvalHold!.requestId }) })]);
    expect((await readRequest(held.approvalHold!.requestId)).status).toBe('expired');
    expect((await readEntry(held.id)).billingStatus).toBe('awaiting_approval');
    expect((await expireDueApprovalRequests(new Date())).expired).toBe(0);
  });

  it('expire skips a request whose ticket is locked by an in-flight writer (SKIP LOCKED), and gets it next time', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 60 });
    await insertSettledEntry(f, 60);
    const held = await logHeld(f, 30);
    await withSystemDbAccessContext(() => db.execute(sql`UPDATE ticket_approval_requests SET expires_at = now() - interval '1 minute' WHERE id = ${held.approvalHold!.requestId}::uuid`));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const holder = withSystemDbAccessContext(async () => {
      await db.execute(sql`SELECT id FROM tickets WHERE id = ${f.ticketId}::uuid FOR UPDATE`);
      locked();
      await gate;
    });
    await isLocked;
    const first = await expireDueApprovalRequests(new Date());
    release();
    await holder;
    expect(first.expired).toBe(0);
    expect((await expireDueApprovalRequests(new Date())).expired).toBe(1);
  });
});
