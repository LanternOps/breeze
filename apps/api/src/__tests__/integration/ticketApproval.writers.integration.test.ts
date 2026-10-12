/**
 * Customer work approval W02 Task 3 (#4617 spec §5.1, §5.5): the gate wired
 * into the four time-entry writers (+ delete), against real Postgres under a
 * PARTNER-scope request context — the shape every REST/add-in/AI caller uses.
 */
import './setup';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/timeEntryEvents', () => ({ emitTimeEntryEvent: vi.fn().mockResolvedValue(undefined) }));
const { emitTicketEventMock } = vi.hoisted(() => ({ emitTicketEventMock: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/ticketEvents', async (orig) => ({
  ...(await orig<typeof import('../../services/ticketEvents')>()),
  emitTicketEvent: emitTicketEventMock,
}));

import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import * as timeSvc from '../../services/timeEntryService';
import {
  actor, ctx, entriesOfTicket, insertSettledEntry, readEntry, readRequest, readRequests, seedApprovalFixture,
  type ApprovalFixture,
} from './ticketApprovalFixtures';

const RUN = !!process.env.DATABASE_URL;
const ago = (min: number) => new Date(Date.now() - min * 60_000);

function asTech<T>(f: ApprovalFixture, fn: () => Promise<T>, userId = f.userId): Promise<T> {
  return withDbAccessContext(ctx(f, userId), fn);
}

async function rejected(p: Promise<unknown>): Promise<{ status?: number; code?: string; details?: unknown }> {
  try { await p; } catch (err) { return err as { status?: number; code?: string; details?: unknown }; }
  throw new Error('expected a rejection');
}

/** Backdate a running timer by `minutes` (a real stop then has a real duration). */
async function backdateRunning(userId: string, minutes: number) {
  await withSystemDbAccessContext(() => db.execute(
    sql`UPDATE time_entries SET started_at = now() - make_interval(secs => ${minutes * 60 + 30}) WHERE user_id = ${userId}::uuid AND ended_at IS NULL`));
}

describe.runIf(RUN)('createTimeEntry', () => {
  it('a finished entry over budget is recorded and held, with approvalHold on the result', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 120 });
    await insertSettledEntry(f, 100);
    const res = await asTech(f, () => timeSvc.createTimeEntry({
      ticketId: f.ticketId, startedAt: ago(30), endedAt: new Date(), isBillable: true,
    }, actor(f)));
    expect(res.billingStatus).toBe('awaiting_approval');
    expect(res.approvalHold).toMatchObject({ trigger: 'budget' });
    expect(res.approvalRequestId).toBe(res.approvalHold!.requestId);
    expect(await readRequest(res.approvalHold!.requestId)).toMatchObject({
      status: 'pending', origin: 'auto', revision: 1, requestedExtensionMinutes: 15,
    });
    expect(emitTicketEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ticket.approval_requested', ticketId: f.ticketId,
      payload: expect.objectContaining({ created: true, trigger: 'budget' }),
    }));
  });

  it('hard mode never refuses a completed entry: it is held, not 409', async () => {
    const f = await seedApprovalFixture({ enforcement: 'hard', budgetMinutes: 60 });
    await insertSettledEntry(f, 60);
    const res = await asTech(f, () => timeSvc.createTimeEntry({
      ticketId: f.ticketId, startedAt: ago(45), endedAt: new Date(), isBillable: true,
    }, actor(f)));
    expect(res.billingStatus).toBe('awaiting_approval');
    expect((await readRequest(res.approvalHold!.requestId)).enforcement).toBe('hard');
  });

  it('a fitting entry is not held, and a disabled policy never holds', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 120 });
    const ok = await asTech(f, () => timeSvc.createTimeEntry({ ticketId: f.ticketId, startedAt: ago(30), endedAt: new Date(), isBillable: true }, actor(f)));
    expect(ok.billingStatus).toBe('not_billed');
    expect(ok.approvalHold).toBeNull();
    const off = await seedApprovalFixture({ enabled: false, budgetMinutes: 10 });
    const res = await asTech(off, () => timeSvc.createTimeEntry({ ticketId: off.ticketId, startedAt: ago(90), endedAt: new Date(), isBillable: true }, actor(off)));
    expect(res.billingStatus).toBe('not_billed');
    expect(await readRequests(off.ticketId)).toHaveLength(0);
  });

  it('non-billable work is never held', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 10 });
    const res = await asTech(f, () => timeSvc.createTimeEntry({ ticketId: f.ticketId, startedAt: ago(90), endedAt: new Date(), isBillable: false }, actor(f)));
    expect(res.billingStatus).toBe('not_billed');
    expect(res.approvalHold).toBeNull();
  });

  it('queue rule: while a budget request is pending, a later entry that would fit joins it (revision 2)', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 120 });
    await insertSettledEntry(f, 90);
    const first = await asTech(f, () => timeSvc.createTimeEntry({ ticketId: f.ticketId, startedAt: ago(60), endedAt: new Date(), isBillable: true }, actor(f)));
    const second = await asTech(f, () => timeSvc.createTimeEntry({ ticketId: f.ticketId, startedAt: ago(20), endedAt: new Date(), isBillable: true }, actor(f)));
    expect(second.billingStatus).toBe('awaiting_approval');
    expect(second.approvalHold!.requestId).toBe(first.approvalHold!.requestId);
    // 90 + 80 − 120 = 50 → 60.
    expect(await readRequest(first.approvalHold!.requestId)).toMatchObject({ revision: 2, requestedExtensionMinutes: 60 });
  });

  it('an uncovered after-hours work type is held on an after_hours request even under budget', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 600 });
    const res = await asTech(f, () => timeSvc.createTimeEntry({
      ticketId: f.ticketId, startedAt: ago(30), endedAt: new Date(), isBillable: true, workTypeId: f.afterHoursWorkTypeId,
    }, actor(f)));
    expect(res.approvalHold).toMatchObject({ trigger: 'after_hours' });
    expect((await readRequest(res.approvalHold!.requestId)).afterHoursWorkTypeId).toBe(f.afterHoursWorkTypeId);
  });

  it('a client-supplied awaiting_approval is refused (400), never written', async () => {
    const f = await seedApprovalFixture();
    const err = await rejected(asTech(f, () => timeSvc.createTimeEntry({
      ticketId: f.ticketId, startedAt: ago(30), endedAt: new Date(), billingStatus: 'awaiting_approval' as never,
    }, actor(f))));
    expect(err.status).toBe(400);
    expect(await entriesOfTicket(f.ticketId)).toHaveLength(0);
  });
});

describe.runIf(RUN)('startTimer / stopTimer', () => {
  it('soft: starting at the ceiling is allowed; the stop is held', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 60 });
    await insertSettledEntry(f, 60);
    const started = await asTech(f, () => timeSvc.startTimer({ ticketId: f.ticketId }, actor(f)));
    expect(started.approvalHold).toBeNull();
    await backdateRunning(f.userId, 20);
    const stopped = await asTech(f, () => timeSvc.stopTimer({}, actor(f)));
    expect(stopped.billingStatus).toBe('awaiting_approval');
    expect(stopped.durationMinutes).toBe(20);
    expect(stopped.approvalHold).toMatchObject({ trigger: 'budget' });
  });

  it('hard: starting a billable timer at the ceiling is 409 APPROVAL_REQUIRED with details; non-billable starts', async () => {
    const f = await seedApprovalFixture({ enforcement: 'hard', budgetMinutes: 60 });
    await insertSettledEntry(f, 60);
    const err = await rejected(asTech(f, () => timeSvc.startTimer({ ticketId: f.ticketId }, actor(f))));
    expect(err).toMatchObject({ status: 409, code: 'APPROVAL_REQUIRED', details: { trigger: 'budget', pendingRequestId: null } });
    const nb = await asTech(f, () => timeSvc.startTimer({ ticketId: f.ticketId, isBillable: false } as never, actor(f)));
    expect(nb.isBillable).toBe(false);
  });

  it('hard: a refused start leaves the previous running timer running (the whole request rolls back)', async () => {
    const f = await seedApprovalFixture({ enforcement: 'hard', budgetMinutes: 60 });
    await insertSettledEntry(f, 60, { ticketId: f.ticketId });
    const prior = await asTech(f, () => timeSvc.startTimer({ ticketId: f.ticket2Id }, actor(f)));
    await rejected(asTech(f, () => timeSvc.startTimer({ ticketId: f.ticketId }, actor(f))));
    expect((await readEntry(prior.id)).endedAt).toBeNull();
  });

  it('starting a timer auto-stops a running one on ANOTHER ticket, and that stop is gated on its own ticket', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 60 });
    await insertSettledEntry(f, 60, { ticketId: f.ticket2Id });
    const running = await asTech(f, () => timeSvc.startTimer({ ticketId: f.ticket2Id }, actor(f)));
    await backdateRunning(f.userId, 15);
    await asTech(f, () => timeSvc.startTimer({ ticketId: f.ticketId }, actor(f)));
    const stopped = await readEntry(running.id);
    expect(stopped.endedAt).not.toBeNull();
    expect(stopped.billingStatus).toBe('awaiting_approval');
    expect((await readRequests(f.ticket2Id))).toHaveLength(1);
    expect(await readRequests(f.ticketId)).toHaveLength(0);
  });
});

describe.runIf(RUN)('updateTimeEntry', () => {
  it('mobile stop-replay PATCH {endedAt} over budget is held (never 409, even in hard mode)', async () => {
    const f = await seedApprovalFixture({ enforcement: 'hard', budgetMinutes: 60 });
    await insertSettledEntry(f, 50);
    const running = await asTech(f, () => timeSvc.startTimer({ ticketId: f.ticketId }, actor(f)));
    await backdateRunning(f.userId, 30);
    const row = await readEntry(running.id);
    const res = await asTech(f, () => timeSvc.updateTimeEntry(running.id, { endedAt: new Date(row.startedAt.getTime() + 30 * 60_000) }, actor(f)));
    expect(res.billingStatus).toBe('awaiting_approval');
    expect(res.approvalHold).toMatchObject({ trigger: 'budget' });
  });

  it('editing a held entry down so it fits releases it and cancels the now-empty auto request', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 60 });
    await insertSettledEntry(f, 30);
    const held = await asTech(f, () => timeSvc.createTimeEntry({ ticketId: f.ticketId, startedAt: ago(60), endedAt: new Date(), isBillable: true }, actor(f)));
    const requestId = held.approvalHold!.requestId;
    const res = await asTech(f, () => timeSvc.updateTimeEntry(held.id, { startedAt: new Date(held.endedAt!.getTime() - 20 * 60_000) }, actor(f)));
    expect(res.billingStatus).toBe('not_billed');
    expect(res.approvalRequestId).toBeNull();
    expect(res.approvalHold).toBeNull();
    expect((await readRequest(requestId)).status).toBe('cancelled');
  });

  it('a reprice (work type change) on a held entry that still crosses stays awaiting_approval', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 60 });
    await insertSettledEntry(f, 60);
    const held = await asTech(f, () => timeSvc.createTimeEntry({ ticketId: f.ticketId, startedAt: ago(30), endedAt: new Date(), isBillable: true }, actor(f)));
    const res = await asTech(f, () => timeSvc.updateTimeEntry(held.id, { workTypeId: f.plainWorkTypeId }, actor(f)));
    expect(res.billingStatus).toBe('awaiting_approval');
    expect(res.approvalRequestId).toBe(held.approvalRequestId);
    expect((await readRequest(held.approvalHold!.requestId))).toMatchObject({ status: 'pending', revision: 2 });
  });

  it('a description-only edit of a held entry leaves the hold and the request revision alone', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 60 });
    await insertSettledEntry(f, 60);
    const held = await asTech(f, () => timeSvc.createTimeEntry({ ticketId: f.ticketId, startedAt: ago(30), endedAt: new Date(), isBillable: true }, actor(f)));
    const res = await asTech(f, () => timeSvc.updateTimeEntry(held.id, { description: 'typo' }, actor(f)));
    expect(res.billingStatus).toBe('awaiting_approval');
    expect((await readRequest(held.approvalHold!.requestId)).revision).toBe(1);
  });

  it('marking a held entry non-billable releases it', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 60 });
    await insertSettledEntry(f, 60);
    const held = await asTech(f, () => timeSvc.createTimeEntry({ ticketId: f.ticketId, startedAt: ago(30), endedAt: new Date(), isBillable: true }, actor(f)));
    const res = await asTech(f, () => timeSvc.updateTimeEntry(held.id, { isBillable: false }, actor(f)));
    expect(res.billingStatus).toBe('not_billed');
    expect(res.approvalRequestId).toBeNull();
    expect((await readRequest(held.approvalHold!.requestId)).status).toBe('cancelled');
  });

  it('relinking a held entry to another ticket releases it from the old request (no cross-ticket link survives)', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 60 });
    await insertSettledEntry(f, 60);
    const held = await asTech(f, () => timeSvc.createTimeEntry({ ticketId: f.ticketId, startedAt: ago(30), endedAt: new Date(), isBillable: true }, actor(f)));
    const res = await asTech(f, () => timeSvc.updateTimeEntry(held.id, { ticketId: f.ticket2Id }, actor(f)));
    expect(res.ticketId).toBe(f.ticket2Id);
    expect(res.billingStatus).toBe('not_billed');
    expect(res.approvalRequestId).toBeNull();
    expect((await readRequest(held.approvalHold!.requestId)).status).toBe('cancelled');
  });

  it('a client cannot PATCH billingStatus to awaiting_approval', async () => {
    const f = await seedApprovalFixture();
    const e = await insertSettledEntry(f, 10);
    const err = await rejected(asTech(f, () => timeSvc.updateTimeEntry(e, { billingStatus: 'awaiting_approval' as never }, actor(f))));
    expect(err.status).toBe(400);
    expect((await readEntry(e)).billingStatus).toBe('not_billed');
  });
});

describe.runIf(RUN)('org-axis allowlist runs before the new pre-lock reads', () => {
  // A partner user with orgAccess='selected' who lacks the entry's org: the
  // ticket/org locks taken before the entry must not turn the existing clean
  // 404 into an RLS-hidden-org error (500).
  const selected = (f: ApprovalFixture) => ({
    ctx: { ...ctx(f), accessibleOrgIds: [f.otherOrgId] },
    actor: actor(f, { accessibleOrgIds: [f.otherOrgId] }),
  });

  it('update / delete of an entry in a non-granted org is 404 ENTRY_NOT_FOUND', async () => {
    const f = await seedApprovalFixture();
    const e = await insertSettledEntry(f, 10);
    const s = selected(f);
    const upd = await rejected(withDbAccessContext(s.ctx, () => timeSvc.updateTimeEntry(e, { description: 'x' }, s.actor)));
    expect(upd).toMatchObject({ status: 404, code: 'ENTRY_NOT_FOUND' });
    const del = await rejected(withDbAccessContext(s.ctx, () => timeSvc.deleteTimeEntry(e, s.actor)));
    expect(del).toMatchObject({ status: 404, code: 'ENTRY_NOT_FOUND' });
  });

  it('stopping your own timer on a ticket in an org you no longer have is a clean 403, not a 500', async () => {
    const f = await seedApprovalFixture();
    await asTech(f, () => timeSvc.startTimer({ ticketId: f.ticketId }, actor(f)));
    const s = selected(f);
    const err = await rejected(withDbAccessContext(s.ctx, () => timeSvc.stopTimer({}, s.actor)));
    expect(err).toMatchObject({ status: 403, code: 'ORG_DENIED' });
  });
});

describe.runIf(RUN)('deleteTimeEntry', () => {
  it('deleting the only held entry cancels its auto request', async () => {
    const f = await seedApprovalFixture({ budgetMinutes: 60 });
    await insertSettledEntry(f, 60);
    const held = await asTech(f, () => timeSvc.createTimeEntry({ ticketId: f.ticketId, startedAt: ago(30), endedAt: new Date(), isBillable: true }, actor(f)));
    await asTech(f, () => timeSvc.deleteTimeEntry(held.id, actor(f)));
    expect((await readRequest(held.approvalHold!.requestId)).status).toBe('cancelled');
  });
});
