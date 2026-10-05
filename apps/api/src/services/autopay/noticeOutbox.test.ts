import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ row: {} as any, ackFailures: 0, invoiceEligible: true, send: vi.fn(), capture: vi.fn() }));
vi.mock('../email', () => ({ getEmailService: () => ({ sendEmail: h.send }) }));
vi.mock('../sentry', () => ({ captureException: h.capture }));
vi.mock('../../db', async () => {
  const { billingNoticeOutbox, invoices } = await import('../../db/schema');
  const db: any = {
    transaction: (fn: any) => fn(db),
    select: () => {
      let table: any;
      const chain: any = {};
      for (const key of ['where', 'orderBy', 'limit', 'for', 'innerJoin']) chain[key] = () => chain;
      chain.from = (t: any) => { table = t; return chain; };
      chain.then = (resolve: any, reject: any) => Promise.resolve(table === billingNoticeOutbox ? [structuredClone(h.row)] : table === invoices ? (h.invoiceEligible ? [{ id: 'invoice' }] : []) : [{ id: 'partner', name: 'Partner' }]).then(resolve, reject);
      return chain;
    },
    update: () => ({ set: (values: any) => {
      const chain: any = { where: () => chain, returning: () => chain };
      chain.then = (resolve: any, reject: any) => Promise.resolve().then(() => {
        if (values.sentAt && h.ackFailures-- > 0) throw new Error('ack failed');
        Object.assign(h.row, values); return [structuredClone(h.row)];
      }).then(resolve, reject);
      return chain;
    } }),
  };
  return { db, assertOutsideHeldDbContext: () => {}, runOutsideDbContext: (fn: any) => fn(), withSystemDbAccessContext: (fn: any) => fn() };
});
import { dispatchPendingBillingNotices, registerNoticeSentHandler } from './noticeOutbox';
beforeEach(() => {
  vi.clearAllMocks(); h.ackFailures = 0; h.invoiceEligible = true;
  h.send.mockReset().mockResolvedValue(undefined);
  h.row = { id: 'outbox', orgId: 'org', kind: 'autopay_request', status: 'pending', attempts: 0, sentAt: null,
    rendered: { subject: 'Notice', html: '<p>Notice</p>', text: 'Notice' }, toEmail: 'client@example.test' };
});
it('captures sanitized send failure with row identity and terminal status', async () => {
  h.row.attempts = 7;
  h.send.mockRejectedValueOnce(new Error('secret bearer URL'));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await dispatchPendingBillingNotices()).toEqual({ sent: 0, failed: 1 });
  expect(h.row.status).toBe('failed');
  expect(h.capture).toHaveBeenCalledWith(expect.any(Error), undefined, expect.objectContaining({ billing_notice_id: 'outbox', billing_notice_kind: 'autopay_request', org_id: 'org' }));
  expect(log).toHaveBeenCalled();
  expect(JSON.stringify(log.mock.calls)).not.toContain('secret bearer URL');
  expect(h.capture.mock.calls[0]![0].message).not.toContain('secret bearer URL');
  log.mockRestore();
});
it('caps handler retries without resending accepted mail', async () => {
  h.row.kind = 'payment_failed'; h.row.sentAt = new Date(); h.row.attempts = 7;
  registerNoticeSentHandler('payment_failed', async () => { throw new Error('handler unavailable'); });
  expect(await dispatchPendingBillingNotices()).toEqual({ sent: 0, failed: 1 });
  expect(h.row.status).toBe('handler_failed');
  expect(h.send).not.toHaveBeenCalled(); expect(h.capture).toHaveBeenCalled();
});
it('retries only the acknowledgement after provider acceptance', async () => {
  h.ackFailures = 1;
  expect(await dispatchPendingBillingNotices()).toEqual({ sent: 1, failed: 0 });
  expect(h.send).toHaveBeenCalledTimes(1); expect(h.row.status).toBe('sent');
});
it('parks an accepted notice when every acknowledgement fails', async () => {
  h.ackFailures = 99;
  expect(await dispatchPendingBillingNotices()).toEqual({ sent: 0, failed: 1 });
  expect(h.row).toMatchObject({ status: 'sending', sentAt: null, lastError: 'Delivery acknowledgement pending' });
  expect(h.send).toHaveBeenCalledOnce(); expect(h.capture).toHaveBeenCalled();
});

it.each([false, true])('terminalizes already exhausted rows (sent=%s) before attempting delivery', async sent => {
  h.row.attempts = 8; h.row.sentAt = sent ? new Date() : null;
  expect(await dispatchPendingBillingNotices()).toEqual({ sent: 0, failed: 1 });
  expect(h.row.status).toBe(sent ? 'handler_failed' : 'failed');
  expect(h.send).not.toHaveBeenCalled(); expect(h.capture).toHaveBeenCalledOnce();
});

it.each(['payment_reminder', 'payment_overdue'])('cancels ineligible %s without delivery or retry', async kind => {
  h.row.kind = kind; h.row.invoiceId = 'invoice'; h.invoiceEligible = false;
  expect(await dispatchPendingBillingNotices()).toEqual({ sent: 0, failed: 0 });
  expect(h.row).toMatchObject({ status: 'cancelled' });
  expect(h.row.lastError).toBeTruthy();
  expect(h.send).not.toHaveBeenCalled();
});
it('leaves non-reminder delivery unaffected by invoice eligibility', async () => {
  h.invoiceEligible = false;
  expect(await dispatchPendingBillingNotices()).toEqual({ sent: 1, failed: 0 });
  expect(h.send).toHaveBeenCalledOnce();
});
it('finishes an accepted reminder without revalidating or resending', async () => {
  h.row.kind = 'payment_reminder'; h.row.sentAt = new Date(); h.invoiceEligible = false;
  expect(await dispatchPendingBillingNotices()).toEqual({ sent: 1, failed: 0 });
  expect(h.row.status).toBe('sent'); expect(h.send).not.toHaveBeenCalled();
});
