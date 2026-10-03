import { expect, it } from 'vitest';
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
import { invoiceCollectionAttempts, invoiceStripePayments, invoices, organizations, partners, orgPaymentMethods, orgAutopayEnrollments, billingNoticeOutbox } from '../../db/schema';
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
  expect(h.enqueue).toHaveBeenCalledWith(tx, expect.objectContaining({ rendered: expect.objectContaining({ text: expect.stringContaining('One retry may follow.') }) }));
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
  expect(h.enqueue).toHaveBeenCalledWith(tx, expect.objectContaining({ dedupeKey: 'mapping:payment_receipt:1', rendered: expect.objectContaining({ frozen: { amount: '100.00', fee: '3.00', total: '103.00' } }) }));
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
