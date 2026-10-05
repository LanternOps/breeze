import { describe, expect, it } from 'vitest';
import { noticeDedupeKey, returnedNoticeDedupeKey } from './paymentNotices';
it('shares a receipt identity between return, sweep, and event replay', () => {
  expect(noticeDedupeKey('mapping-1', 'payment_receipt')).toBe('mapping-1:payment_receipt:1');
  expect(noticeDedupeKey('attempt-1', 'payment_failed')).toBe('attempt-1:payment_failed:1');
});
it('does not let an earlier failure suppress a returned-payment notice',()=>{
  const first=returnedNoticeDedupeKey('attempt-1','mapping-1:dp_1');
  expect(first).not.toBe(noticeDedupeKey('attempt-1','payment_failed'));
  expect(first).toBe(returnedNoticeDedupeKey('attempt-1','mapping-1:dp_1'));
  expect(first).not.toBe(returnedNoticeDedupeKey('attempt-1','mapping-1:dp_2'));
});

import { attentionDedupeKey } from './paymentNotices';
it('dedupes each attempt outcome independently', () => {
  expect(attentionDedupeKey('a', 'payment.unapplied')).toBe('autopay:a:payment.unapplied');
  expect(attentionDedupeKey('a', 'payment.ach_returned')).not.toBe(attentionDedupeKey('a', 'payment.unapplied'));
});

import { beforeEach, vi } from 'vitest';
import { enqueueAttemptNotice, enqueueOnlineReceipt, notifyPaymentAttention } from './paymentNotices';
import { invoiceCollectionAttempts, invoiceStripePayments, invoices, organizations, partners, orgPaymentMethods, orgAutopayEnrollments, billingNoticeOutbox, invoiceAutopaySchedules } from '../../db/schema';
import type { Tx } from './types';
const h = vi.hoisted(() => ({ enqueue: vi.fn(), mint: vi.fn(), payLink: vi.fn(), staff: vi.fn() }));
vi.mock('./noticeOutbox', () => ({ enqueueBillingNotice: h.enqueue }));
vi.mock('./linkTokens', () => ({ mintBillingLinkToken: h.mint, buildBillingLinkUrl: (purpose: string, token: string) => `https://example.test/${purpose}/${token}` }));
vi.mock('../invoiceLinkToken', () => ({ getOrMintInvoiceLink: h.payLink, buildPublicInvoiceUrl: (token: string) => `https://example.test/invoice/${token}` }));
vi.mock('./staffNotifications', () => ({ sendAutopayStaffEmail: h.staff }));
const rows = new Map<unknown, Record<string, unknown>[]>();
const tx = { select: () => {
  let table: unknown;
  const chain: Record<string, unknown> = {};
  chain.from = (value: unknown) => { table = value; return chain; };
  for (const key of ['where', 'limit', 'for']) chain[key] = () => chain;
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(rows.get(table) ?? []).then(resolve);
  return chain;
} } as unknown as Tx;
beforeEach(() => {
  vi.clearAllMocks(); rows.clear();
  rows.set(invoiceCollectionAttempts, [{ id: 'a', invoiceId: 'invoice', orgId: 'org', paymentMethodId: 'method', invoiceStripePaymentId: 'mapping', failureClass: 'nsf' }]);
  rows.set(invoices, [{ id: 'invoice', orgId: 'org', partnerId: 'partner', currencyCode: 'USD', balance: '100.00', invoiceNumber: 'INV-1' }]);
  rows.set(organizations, [{ id: 'org', partnerId: 'partner', name: 'Customer', billingContact: { email: 'billing@example.test' } }]);
  rows.set(partners, [{ id: 'partner', name: 'Provider', settings: {} }]);
  rows.set(orgPaymentMethods, [{ id: 'method', orgId: 'org', enrollmentId: 'enrollment' }]);
  rows.set(orgAutopayEnrollments, [{ id: 'enrollment', orgId: 'org', status: 'active', generation: 7 }]);
  rows.set(invoiceStripePayments, [{ id: 'mapping', invoiceId: 'invoice', orgId: 'org', invoicePaymentId: 'ledger', status: 'succeeded', amount: '100.00', feeAmount: '3.00', currency: 'USD', paymentReceivedAt: '2026-10-01', paymentMethodType: 'card' }]);
  h.mint.mockResolvedValue({ id: 'token-row', token: 'secret' }); h.payLink.mockResolvedValue({ token: 'pay' });
});
it.each(['confirm', 'update'] as const)('binds %s tokens to enrollment generation and exact attempt', async variant => {
  await enqueueAttemptNotice(tx, 'a', variant);
  expect(h.mint).toHaveBeenCalledWith(tx, expect.objectContaining({ generation: 7, enrollmentId: 'enrollment', purpose: variant === 'confirm' ? 'confirm_payment' : 'enroll', ttlDays: 14 }));
  expect(h.enqueue).toHaveBeenCalledWith(tx, expect.objectContaining({ dedupeKey: 'a:payment_failed:1', rendered: expect.objectContaining({ frozen: { attemptId: 'a', variant, tokenId: 'token-row', returnIdentity: null } }) }));
});
it('checks dedupe before minting tokens on replay', async () => {
  rows.set(billingNoticeOutbox, [{ id: 'already-enqueued' }]);
  await enqueueAttemptNotice(tx, 'a', 'confirm');
  expect(h.mint).not.toHaveBeenCalled(); expect(h.enqueue).not.toHaveBeenCalled();
});
it.each(['missing', 'foreign', 'inactive'] as const)('refuses collection authority for %s method/enrollment', async kind => {
  if (kind === 'missing') rows.set(orgPaymentMethods, []);
  if (kind === 'foreign') rows.get(orgPaymentMethods)![0]!.orgId = 'another-org';
  if (kind === 'inactive') rows.get(orgAutopayEnrollments)![0]!.status = 'cancelled';
  for (const variant of ['confirm', 'update'] as const) await enqueueAttemptNotice(tx, 'a', variant);
  expect(h.mint).not.toHaveBeenCalled(); expect(h.enqueue).not.toHaveBeenCalled();
});
it('uses the transactional invoice link for pay and includes NSF copy', async () => {
  await enqueueAttemptNotice(tx, 'a', 'pay');
  expect(h.payLink).toHaveBeenCalledWith(rows.get(invoices)![0], tx);
  expect(h.mint).not.toHaveBeenCalled();
  expect(h.enqueue).toHaveBeenCalledWith(tx, expect.objectContaining({ rendered: expect.objectContaining({ text: expect.stringContaining('insufficient available funds') }) }));
});
const queuedText = () => (h.enqueue.mock.calls.at(-1)![1] as { rendered: { text: string; html: string } }).rendered;
function scheduled(attempt: Record<string, unknown>, schedule: Record<string, unknown> | null) {
  Object.assign(rows.get(invoiceCollectionAttempts)![0]!, { scheduleId: 'schedule', attemptNo: 1, ...attempt });
  rows.set(invoiceAutopaySchedules, schedule ? [{ id: 'schedule', invoiceId: 'invoice', orgId: 'org', attemptCount: 1, ...schedule }] : []);
}
it.each([
  ['an NSF bank debit', { failureClass: 'nsf', attemptNo: 1 }, 'insufficient available funds', '2026-10-09'],
  ['a soft card decline on day 1', { failureClass: 'soft', attemptNo: 1 }, 'could not be completed', '2026-10-04'],
  ['a soft card decline on day 3', { failureClass: 'soft', attemptNo: 2 }, 'could not be completed', '2026-10-08'],
] as const)('states the scheduled retry date for %s', async (_label, attempt, reason, date) => {
  scheduled(attempt, { state: 'retry_scheduled', attemptCount: attempt.attemptNo, nextAttemptAt: new Date(`${date}T14:00:00.000Z`) });
  await enqueueAttemptNotice(tx, 'a', 'pay');
  const { text, html } = queuedText();
  for (const body of [text, html]) {
    expect(body).toContain(reason);
    expect(body).toContain(`try again on or after ${date}`);
    expect(body).not.toContain('One retry may follow');
  }
});
it.each([
  ['an NSF retry that already failed', { failureClass: 'nsf', attemptNo: 2 }, { state: 'failed', attemptCount: 2, nextAttemptAt: null }],
  ['the last soft-decline retry', { failureClass: 'soft', attemptNo: 3 }, { state: 'failed', attemptCount: 3, nextAttemptAt: null }],
  ['a payment with no schedule', { failureClass: 'nsf', scheduleId: null }, null],
  ['a retry schedule that belongs to a later attempt', { failureClass: 'soft' }, { state: 'retry_scheduled', attemptCount: 2, nextAttemptAt: new Date('2026-10-08T00:00:00Z') }],
] as const)('says plainly there is no automatic retry for %s', async (_label, attempt, schedule) => {
  scheduled(attempt, schedule);
  await enqueueAttemptNotice(tx, 'a', 'pay');
  const { text } = queuedText();
  expect(text).toContain('There will be no automatic retry.');
  expect(text).not.toContain('try again');
  expect(text).not.toContain('One retry may follow');
});
it('gives the update-method email a pay-now link and a separate update link that does not claim to pay', async () => {
  rows.get(invoiceCollectionAttempts)![0]!.failureClass = 'hard';
  await enqueueAttemptNotice(tx, 'a', 'update');
  const { text, html } = queuedText();
  expect(html).toContain('href="https://example.test/invoice/pay"');
  expect(html).toContain('href="https://example.test/enroll/secret"');
  expect(text).toContain('Pay invoice: https://example.test/invoice/pay');
  expect(text).toContain('Update payment method: https://example.test/enroll/secret');
  for (const body of [text, html]) {
    expect(body).toContain('future invoices');
    expect(body).toContain('does not pay this invoice');
    expect(body).toContain('There will be no automatic retry.');
    expect(body).not.toContain('Please update it or pay this invoice');
  }
});
it('keeps the confirm email to its single confirm action (pay-now would be refused while it is pending)', async () => {
  await enqueueAttemptNotice(tx, 'a', 'confirm');
  const { text, html } = queuedText();
  expect(html).toContain('href="https://example.test/confirm_payment/secret"');
  expect(html).not.toContain('https://example.test/invoice/pay');
  expect(text).not.toContain('Update payment method:');
});
it('requires an actually applied return mapping and permits cleared method authority', async () => {
  await expect(enqueueAttemptNotice(tx, 'a', 'returned')).rejects.toThrow('identity');
  await expect(enqueueAttemptNotice(tx, 'a', 'returned', 'mapping:dp_1')).rejects.toThrow('applied return identity');
  Object.assign(rows.get(invoiceStripePayments)![0]!, { status: 'disputed', disputeFundsWithdrawn: true, invoicePaymentId: null });
  rows.get(invoiceCollectionAttempts)![0]!.paymentMethodId = null;
  await enqueueAttemptNotice(tx, 'a', 'returned', 'mapping:dp_1');
  expect(h.mint).not.toHaveBeenCalled();
  expect(h.enqueue).toHaveBeenCalledWith(tx, expect.objectContaining({ dedupeKey: 'a:payment_failed:returned:mapping:dp_1', rendered: expect.objectContaining({ frozen: { attemptId: 'a', variant: 'returned', tokenId: null, returnIdentity: 'mapping:dp_1' } }) }));
});
it('freezes exact receipt principal, fee and total, and skips unapplied mappings', async () => {
  await enqueueOnlineReceipt(tx, 'mapping');
  expect(h.enqueue).toHaveBeenCalledWith(tx, expect.objectContaining({ dedupeKey: 'mapping:payment_receipt:1', rendered: expect.objectContaining({ frozen: { mappingId: 'mapping', amount: '100.00', fee: '3.00', total: '103.00' } }) }));
  h.enqueue.mockClear(); rows.get(invoiceStripePayments)![0]!.invoicePaymentId = null;
  await enqueueOnlineReceipt(tx, 'mapping'); expect(h.enqueue).not.toHaveBeenCalled();
});
it('skips missing billing recipients and rejects mismatched ownership', async () => {
  rows.get(organizations)![0]!.billingContact = null;
  await enqueueOnlineReceipt(tx, 'mapping'); expect(h.enqueue).not.toHaveBeenCalled();
  rows.get(organizations)![0]!.partnerId = 'foreign';
  await expect(enqueueOnlineReceipt(tx, 'mapping')).rejects.toThrow('ownership');
});
it('requires return identity for staff and preserves the invoice destination', async () => {
  const input = { attemptId: 'a', partnerId: 'partner', orgId: 'org', invoiceId: 'invoice', event: 'payment.ach_returned' as const };
  await expect(notifyPaymentAttention(input)).rejects.toThrow('identity');
  await notifyPaymentAttention({ ...input, returnIdentity: 'mapping:dp_1' });
  expect(h.staff).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: 'invoice', dedupeKey: 'autopay:a:payment.ach_returned:mapping:dp_1' }));
});
it.each(['payment.failed_final', 'payment.unapplied', 'payment.ach_returned', 'autopay.needs_attention'] as const)(
  'names no raw invoice or attempt id in the %s staff message (P-17)', async event => {
    h.staff.mockClear();
    const ids = { invoiceId: '55555555-5555-4555-8555-555555555555', attemptId: '66666666-6666-4666-8666-666666666666' };
    await notifyPaymentAttention({ ...ids, partnerId: 'partner', orgId: 'org', event, returnIdentity: 'mapping:dp_1' });
    const [[sent]] = h.staff.mock.calls as [[{ message: string; invoiceId: string }]];
    expect(sent.invoiceId).toBe(ids.invoiceId);
    expect(sent.message).not.toContain(ids.invoiceId); expect(sent.message).not.toContain(ids.attemptId);
  });

import { enqueueMethodUnusableNotice } from './paymentNotices';
describe('method-unusable notice for a due schedule with no attempt of its own', () => {
  beforeEach(() => {
    rows.set(invoiceAutopaySchedules, [{ id: 'schedule', invoiceId: 'invoice', orgId: 'org', enrollmentId: 'enrollment',
      enrollmentGeneration: 7, state: 'failed', stateReason: 'method_not_usable' }]);
  });
  it('enqueues the update variant once per invoice, bound to the enrollment generation', async () => {
    await enqueueMethodUnusableNotice(tx, 'schedule');
    expect(h.mint).toHaveBeenCalledWith(tx, expect.objectContaining({ orgId: 'org', invoiceId: 'invoice', enrollmentId: 'enrollment',
      generation: 7, purpose: 'enroll', ttlDays: 14 }));
    expect(h.enqueue).toHaveBeenCalledWith(tx, expect.objectContaining({ kind: 'payment_failed', invoiceId: 'invoice',
      dedupeKey: 'invoice:payment_failed:method_not_usable:1', toEmail: 'billing@example.test',
      rendered: expect.objectContaining({
        frozen: { attemptId: null, scheduleId: 'schedule', variant: 'update', tokenId: 'token-row', returnIdentity: null } }) }));
  });
  it('leads with paying this invoice and adds an update link that says it does not pay this invoice', async () => {
    await enqueueMethodUnusableNotice(tx, 'schedule');
    const { text, html } = queuedText();
    expect(h.payLink).toHaveBeenCalledWith(rows.get(invoices)![0], tx);
    expect(html).toContain('href="https://example.test/invoice/pay"');
    expect(html).toContain('href="https://example.test/enroll/secret"');
    expect(text).toContain('Pay invoice: https://example.test/invoice/pay');
    expect(text).toContain('Update payment method: https://example.test/enroll/secret');
    for (const body of [text, html]) {
      expect(body).toContain('was not charged automatically');
      expect(body).toContain('future invoices');
      expect(body).toContain('does not pay this invoice');
      expect(body).toContain('There will be no automatic retry.');
      expect(body).not.toContain('Please update it or pay this invoice');
    }
  });
  it('checks dedupe before minting on replay', async () => {
    rows.set(billingNoticeOutbox, [{ id: 'already-enqueued' }]);
    await enqueueMethodUnusableNotice(tx, 'schedule');
    expect(h.mint).not.toHaveBeenCalled(); expect(h.enqueue).not.toHaveBeenCalled();
  });
  it.each(['inactive', 'generation', 'foreign'] as const)('mints no collection control for a %s enrollment', async kind => {
    if (kind === 'inactive') rows.get(orgAutopayEnrollments)![0]!.status = 'cancelled';
    if (kind === 'generation') rows.get(orgAutopayEnrollments)![0]!.generation = 8;
    if (kind === 'foreign') rows.get(orgAutopayEnrollments)![0]!.orgId = 'another-org';
    await enqueueMethodUnusableNotice(tx, 'schedule');
    expect(h.mint).not.toHaveBeenCalled(); expect(h.enqueue).not.toHaveBeenCalled();
  });
});
