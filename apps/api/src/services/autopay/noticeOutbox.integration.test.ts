import '../../__tests__/integration/setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { billingNoticeOutbox, organizations, partners } from '../../db/schema';
const { send } = vi.hoisted(() => ({ send: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../email', () => ({ getEmailService: () => ({ sendEmail: send }) }));
import { enqueueBillingNotice, dispatchPendingBillingNotices, registerNoticeSentHandler } from './noticeOutbox';
const ids: string[] = [];
async function fixture(kind: 'autopay_request' | 'invoice_autopay' = 'autopay_request') {
  return withSystemDbAccessContext(async () => {
    const suffix = crypto.randomUUID();
    const [p] = await db.insert(partners).values({ name: 'Outbox fixture', slug: `outbox-${suffix}`, type: 'msp', plan: 'pro', status: 'active', billingEmail: 'billing@example.test' }).returning();
    const [o] = await db.insert(organizations).values({ name: 'Outbox org', slug: `org-${suffix}`, currencyCode: 'USD', partnerId: p!.id }).returning();
    const input = { partnerId: p!.id, orgId: o!.id, kind, seq: 1, dedupeKey: `test:${suffix}`, toEmail: 'client@example.test',
      rendered: { subject: 'Frozen', html: '<p>100.00</p>', text: '100.00', frozen: { amount: '100.00' } } };
    const result = await enqueueBillingNotice(db, input);
    ids.push(result.id);
    return { ...result, input };
  });
}
afterEach(async () => {
  vi.restoreAllMocks();
  if (ids.length) await withSystemDbAccessContext(() => db.delete(billingNoticeOutbox).where(inArray(billingNoticeOutbox.id, ids.splice(0))));
  send.mockReset().mockResolvedValue(undefined);
});
describe('billing outbox on real PostgreSQL', () => {
  it('dedupes enqueue without changing the frozen original', async () => {
    const f = await fixture();
    const result = await withSystemDbAccessContext(() => enqueueBillingNotice(db, {
      ...f.input, rendered: { ...f.input.rendered, text: 'changed' },
    }));
    expect(result).toEqual({ id: f.id, created: false });
    const [row] = await withSystemDbAccessContext(() => db.select().from(billingNoticeOutbox).where(eq(billingNoticeOutbox.id, f.id)));
    expect(row!.rendered).toMatchObject({ text: '100.00' });
  });
  it('two dispatchers send the same due row once', async () => {
    await fixture();
    const results = await Promise.all([dispatchPendingBillingNotices(), dispatchPendingBillingNotices()]);
    expect(results.reduce((sum, r) => sum + r.sent, 0)).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'billing.notice', replyTo: 'billing@example.test' }));
  });
  it('retries an expired sending lease and exhausts the eighth failed send', async () => {
    const f = await fixture();
    await withSystemDbAccessContext(() => db.update(billingNoticeOutbox).set({ status: 'sending', attempts: 7, nextAttemptAt: new Date(0) }).where(eq(billingNoticeOutbox.id, f.id)));
    send.mockRejectedValueOnce(new Error('synthetic transport failure'));
    expect(await dispatchPendingBillingNotices()).toEqual({ sent: 0, failed: 1 });
    const [row] = await withSystemDbAccessContext(() => db.select().from(billingNoticeOutbox).where(eq(billingNoticeOutbox.id, f.id)));
    expect(row).toMatchObject({ status: 'failed', attempts: 8, sentAt: null });
    await dispatchPendingBillingNotices(new Date(Date.now() + 86400000));
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('backs off ordinary failure and never sends cancelled rows', async () => {
    const f = await fixture();
    const now = new Date();
    vi.spyOn(Date, 'now').mockReturnValue(now.getTime() - 1000);
    send.mockRejectedValueOnce(new Error('temporary'));
    expect(await dispatchPendingBillingNotices(now)).toEqual({ sent: 0, failed: 1 });
    const [row] = await withSystemDbAccessContext(() => db.select().from(billingNoticeOutbox).where(eq(billingNoticeOutbox.id, f.id)));
    expect(row).toMatchObject({ status: 'pending', attempts: 1, sentAt: null });
    expect(row!.nextAttemptAt!.getTime()).toBe(now.getTime() + 60000);
    await withSystemDbAccessContext(() => db.update(billingNoticeOutbox).set({ status: 'cancelled' }).where(eq(billingNoticeOutbox.id, f.id)));
    await dispatchPendingBillingNotices(new Date(now.getTime() + 60001));
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('preserves the full retry interval after a slow failed send', async () => {
    const f = await fixture();
    const now = new Date();
    const failedAt = now.getTime() + 120000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now.getTime());
    send.mockImplementationOnce(async () => {
      clock.mockReturnValue(failedAt);
      throw new Error('slow transport failure');
    });
    expect(await dispatchPendingBillingNotices(now)).toEqual({ sent: 0, failed: 1 });
    const [row] = await withSystemDbAccessContext(() => db.select().from(billingNoticeOutbox).where(eq(billingNoticeOutbox.id, f.id)));
    expect(row).toMatchObject({ status: 'pending', attempts: 1, sentAt: null });
    expect(row!.nextAttemptAt!.getTime()).toBe(failedAt + 60000);
    expect(await dispatchPendingBillingNotices(new Date(failedAt + 59999))).toEqual({ sent: 0, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await dispatchPendingBillingNotices(new Date(failedAt + 60000))).toEqual({ sent: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('handler failure after durable send acknowledgement retries without re-sending', async () => {
    const f = await fixture('invoice_autopay');
    let calls = 0;
    registerNoticeSentHandler('invoice_autopay', async () => {
      if (++calls === 1) throw new Error('handler unavailable');
    });
    const now = new Date();
    expect(await dispatchPendingBillingNotices(now)).toEqual({ sent: 0, failed: 1 });
    const [ack] = await withSystemDbAccessContext(() => db.select().from(billingNoticeOutbox).where(eq(billingNoticeOutbox.id, f.id)));
    expect(ack!.sentAt).not.toBeNull();
    expect(ack!.status).toBe('pending');
    expect(await dispatchPendingBillingNotices(ack!.nextAttemptAt!)).toEqual({ sent: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
  });
  it('rejects enqueue when the caller supplies another partner', async () => {
    const f = await fixture();
    await expect(withSystemDbAccessContext(() => enqueueBillingNotice(db, {
      ...f.input, partnerId: crypto.randomUUID(), dedupeKey: crypto.randomUUID(),
    }))).rejects.toThrow('Billing notice ownership mismatch');
  });
  it.each(['cancelled', 'reclaimed'] as const)('skips a later row %s while an earlier send is paused', async (action) => {
    const first = await fixture();
    const later = await fixture();
    await withSystemDbAccessContext(async () => {
      await db.update(billingNoticeOutbox).set({ nextAttemptAt: new Date(0) }).where(eq(billingNoticeOutbox.id, first.id));
      await db.update(billingNoticeOutbox).set({ nextAttemptAt: new Date(1) }).where(eq(billingNoticeOutbox.id, later.id));
    });
    let release!: () => void;
    let started!: () => void;
    const paused = new Promise<void>(resolve => { started = resolve; });
    const resumed = new Promise<void>(resolve => { release = resolve; });
    send.mockImplementationOnce(async () => { started(); await resumed; });
    const dispatch = dispatchPendingBillingNotices();
    await paused;
    try {
      await withSystemDbAccessContext(() => db.update(billingNoticeOutbox).set(action === 'cancelled'
        ? { status: 'cancelled' }
        : { status: 'sending', attempts: 2, nextAttemptAt: new Date(Date.now() + 15 * 60000) }
      ).where(eq(billingNoticeOutbox.id, later.id)));
    } finally {
      release();
    }
    expect(await dispatch).toEqual({ sent: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    const [row] = await withSystemDbAccessContext(() => db.select().from(billingNoticeOutbox).where(eq(billingNoticeOutbox.id, later.id)));
    expect(row!.status).toBe(action === 'cancelled' ? 'cancelled' : 'sending');
    expect(row!.sentAt).toBeNull();
  });

});
