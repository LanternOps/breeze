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
  rows.set(invoiceCollectionAttempts, [{ id: 'a', invoiceId: 'invoice', orgId: 'org', paymentMethodId: 'method', invoiceStripePaymentId: 'mapping', failureClass: 'nsf',
    principalAmount: '100.00', feeAmount: '3.00', currency: 'USD' }]);
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
  expect(h.enqueue).toHaveBeenCalledWith(tx, expect.objectContaining({ dedupeKey: 'a:payment_failed:1', rendered: expect.objectContaining({ frozen: expect.objectContaining({ attemptId: 'a', variant, tokenId: 'token-row', returnIdentity: null }) }) }));
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
    // One date formatter: "October 4, 2026", never an ISO date.
    expect(body).toContain(`try again on or after ${new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`);
    expect(body).not.toContain(date);
    expect(body).not.toContain('One retry may follow');
  }
  // V2-5: the date it states is frozen, so a later "will not happen" cites the retry, not the first notice.
  expect(h.enqueue.mock.calls.at(-1)![1].rendered.frozen).toMatchObject({ retryOn: `${date}T14:00:00.000Z` });
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
  expect(h.enqueue).toHaveBeenCalledWith(tx, expect.objectContaining({ dedupeKey: 'a:payment_failed:returned:mapping:dp_1', rendered: expect.objectContaining({ frozen: expect.objectContaining({ attemptId: 'a', variant: 'returned', tokenId: null, returnIdentity: 'mapping:dp_1' }) }) }));
});
it('freezes exact receipt principal, fee and total, and skips unapplied mappings', async () => {
  await enqueueOnlineReceipt(tx, 'mapping');
  expect(h.enqueue).toHaveBeenCalledWith(tx, expect.objectContaining({ dedupeKey: 'mapping:payment_receipt:1', rendered: expect.objectContaining({ frozen: expect.objectContaining({ mappingId: 'mapping', amount: '100.00', fee: '3.00', total: '103.00' }) }) }));
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

import { enqueueMethodUnusableNotice, enqueueMethodUnusablePayNotice } from './paymentNotices';
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
        frozen: expect.objectContaining({ attemptId: null, scheduleId: 'schedule', variant: 'update', tokenId: 'token-row', returnIdentity: null }) }) }));
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

const footerBrand = (html: string) => html.match(/<p style="margin: 16px 0 0;[^>]*>([^<]*)<\/p>/)?.[1];
const lastQueued = () => (h.enqueue.mock.calls.at(-1)![1] as { rendered: { text: string; html: string; frozen: Record<string, unknown> } }).rendered;
describe('client payment notices name the invoice, the provider and the method (D-8, D-23, D-26)', () => {
  beforeEach(() => {
    Object.assign(rows.get(orgPaymentMethods)![0]!, { type: 'card', cardBrand: 'visa', cardFunding: 'credit', cardLast4: '4242' });
    Object.assign(rows.get(invoiceStripePayments)![0]!, { source: 'autopay' });
  });
  it('an autopay card receipt names the invoice, the provider and the card, with the provider as the email brand', async () => {
    await enqueueOnlineReceipt(tx, 'mapping');
    const { html, text, frozen } = lastQueued();
    expect(footerBrand(html)).toBe('Provider');
    expect(html).not.toContain('Breeze RMM');
    expect(frozen).toMatchObject({ invoiceNumber: 'INV-1', partnerName: 'Provider', methodLabel: 'Visa credit card ending in 4242' });
    for (const body of [html, text]) {
      expect(body).toContain('INV-1'); expect(body).toContain('Provider');
      expect(body).toContain('Visa credit card ending in 4242');
      expect(body).not.toContain('Principal');
      expect(body).not.toMatch(/Card on 2026/);
    }
  });
  it.each([
    ['a pay-link payment (method unknown to Breeze)', { paymentMethodType: null, source: 'checkout' }, [], 'Online payment'],
    ['an autopay bank debit', { paymentMethodType: 'us_bank_account' }, null, 'Bank account ending in 6789'],
  ] as const)('labels %s truthfully, never "Card"', async (_label, mapping, attempts, label) => {
    Object.assign(rows.get(invoiceStripePayments)![0]!, mapping);
    Object.assign(rows.get(orgPaymentMethods)![0]!, { type: 'us_bank_account', cardBrand: null, cardFunding: null, cardLast4: null, bankLast4: '6789' });
    if (attempts) rows.set(invoiceCollectionAttempts, [...attempts]);
    await enqueueOnlineReceipt(tx, 'mapping');
    const { html, text, frozen } = lastQueued();
    expect(frozen.methodLabel).toBe(label);
    for (const body of [html, text]) { expect(body).toContain(label); expect(body).not.toMatch(/\bCard\b/); }
  });
  it('omits the fee and total lines from a fee-free receipt', async () => {
    Object.assign(rows.get(invoiceStripePayments)![0]!, { feeAmount: '0.00' });
    await enqueueOnlineReceipt(tx, 'mapping');
    const { html, text } = lastQueued();
    for (const body of [html, text]) { expect(body).not.toContain('Processing fee'); expect(body).not.toContain('Total charged'); }
  });
  it.each(['confirm', 'update', 'pay', 'expired'] as const)('a %s failure notice uses the provider as the email brand and freezes the facts', async variant => {
    Object.assign(rows.get(invoiceCollectionAttempts)![0]!, { failureClass: variant === 'update' ? 'hard' : 'soft' });
    await enqueueAttemptNotice(tx, 'a', variant);
    const { html, frozen } = lastQueued();
    expect(footerBrand(html)).toBe('Provider');
    expect(frozen).toMatchObject({ invoiceNumber: 'INV-1', partnerName: 'Provider', methodLabel: 'Visa credit card ending in 4242' });
  });
  it('the confirm notice freezes the attempted autopay total and the pay-now amount, and explains the difference', async () => {
    Object.assign(rows.get(invoiceCollectionAttempts)![0]!, { principalAmount: '90.00', feeAmount: '2.70', currency: 'USD', failureClass: 'auth_required' });
    rows.get(invoices)![0]!.balance = '90.00';
    await enqueueAttemptNotice(tx, 'a', 'confirm');
    const { html, text, frozen } = lastQueued();
    expect(frozen).toMatchObject({ attemptedAmount: '92.70', attemptFee: '2.70', payNowAmount: '90.00', currency: 'USD' });
    for (const body of [html, text]) {
      expect(body).toContain('INV-1');
      expect(body).toContain('$92.70');
      expect(body).toContain('$2.70');
      expect(body).toContain('$90.00');
      expect(body).not.toMatch(/USD \d/);
      expect(body).toContain('Nothing has been charged');
    }
  });
});

describe('a returned bank payment whose account can no longer be used (2b-2)', () => {
  beforeEach(() => {
    Object.assign(rows.get(invoiceStripePayments)![0]!, { status: 'disputed', disputeFundsWithdrawn: true, invoicePaymentId: null, paymentMethodType: 'us_bank_account' });
    Object.assign(rows.get(orgPaymentMethods)![0]!, { type: 'us_bank_account', bankLast4: '6789', status: 'unusable', isAutopayMethod: true });
  });
  it('leads with paying the invoice and adds the update-method link with the 2b update layout', async () => {
    await enqueueAttemptNotice(tx, 'a', 'returned', 'mapping:dp_1');
    expect(h.mint).toHaveBeenCalledWith(tx, expect.objectContaining({ purpose: 'enroll', enrollmentId: 'enrollment', generation: 7, ttlDays: 14 }));
    const { html, text, frozen } = lastQueued();
    expect(frozen).toMatchObject({ variant: 'returned', tokenId: 'token-row', returnIdentity: 'mapping:dp_1' });
    expect(html).toContain('href="https://example.test/invoice/pay"');
    expect(html).toContain('href="https://example.test/enroll/secret"');
    expect(text).toContain('Pay invoice: https://example.test/invoice/pay');
    expect(text).toContain('Update payment method: https://example.test/enroll/secret');
    for (const body of [html, text]) {
      expect(body).toContain('bank account ending in 6789 can no longer be used for automatic payments');
      expect(body).toContain('does not pay this invoice');
    }
  });
  it('keeps the plain returned email for a soft return that left the account usable', async () => {
    rows.get(orgPaymentMethods)![0]!.status = 'active';
    await enqueueAttemptNotice(tx, 'a', 'returned', 'mapping:dp_1');
    expect(h.mint).not.toHaveBeenCalled();
    const { html, text } = lastQueued();
    for (const body of [html, text]) { expect(body).not.toContain('Update payment method'); expect(body).not.toContain('can no longer be used'); }
  });
  it('leaves the update link out once autopay no longer holds that account', async () => {
    rows.get(orgAutopayEnrollments)![0]!.status = 'cancelled';
    await enqueueAttemptNotice(tx, 'a', 'returned', 'mapping:dp_1');
    expect(h.mint).not.toHaveBeenCalled();
    expect(lastQueued().text).not.toContain('Update payment method');
  });
  it('re-issues without the update link under its own dedupe key', async () => {
    await enqueueAttemptNotice(tx, 'a', 'returned', 'mapping:dp_1', { fallback: true });
    expect(h.mint).not.toHaveBeenCalled();
    expect(h.enqueue).toHaveBeenCalledWith(tx, expect.objectContaining({ dedupeKey: 'a:payment_failed:returned:mapping:dp_1:reissued' }));
    expect(lastQueued().text).not.toContain('Update payment method');
  });
});
describe('re-issuing an update-method email as the pay variant (2b-1)', () => {
  it('sends the pay variant for the same attempt under its own dedupe key', async () => {
    rows.get(invoiceCollectionAttempts)![0]!.failureClass = 'hard';
    await enqueueAttemptNotice(tx, 'a', 'pay', undefined, { fallback: true });
    expect(h.mint).not.toHaveBeenCalled();
    expect(h.enqueue).toHaveBeenCalledWith(tx, expect.objectContaining({ dedupeKey: 'a:payment_failed:pay:reissued:1',
      rendered: expect.objectContaining({ frozen: expect.objectContaining({ attemptId: 'a', variant: 'pay', tokenId: null }) }) }));
    const { html, text } = lastQueued();
    for (const body of [html, text]) {
      expect(body).toContain('There will be no automatic retry.');
      expect(body).not.toContain('Update payment method');
    }
    expect(text).toContain('Pay invoice: https://example.test/invoice/pay');
  });
  it('re-issues a schedule-bound method-unusable email as the pay variant without minting a link', async () => {
    rows.set(invoiceAutopaySchedules, [{ id: 'schedule', invoiceId: 'invoice', orgId: 'org', enrollmentId: 'enrollment',
      enrollmentGeneration: 7, state: 'failed', stateReason: 'method_not_usable' }]);
    rows.get(orgAutopayEnrollments)![0]!.status = 'cancelled';
    await enqueueMethodUnusablePayNotice(tx, 'schedule');
    expect(h.mint).not.toHaveBeenCalled();
    expect(h.enqueue).toHaveBeenCalledWith(tx, expect.objectContaining({ kind: 'payment_failed', invoiceId: 'invoice',
      dedupeKey: 'invoice:payment_failed:method_not_usable:pay:1',
      rendered: expect.objectContaining({ frozen: expect.objectContaining({ attemptId: null, scheduleId: 'schedule', variant: 'pay', tokenId: null }) }) }));
    const { html, text } = lastQueued();
    for (const body of [html, text]) {
      expect(body).toContain('was not charged automatically');
      expect(body).toContain('There will be no automatic retry.');
      expect(body).not.toContain('Update payment method');
    }
  });
});

import { enqueueRefundNotice } from './paymentNotices';
describe('client refund notice (D-20)', () => {
  beforeEach(() => {
    Object.assign(rows.get(invoiceStripePayments)![0]!, { source: 'autopay', status: 'partially_refunded', refundedAmountMinor: '5150', paymentReceivedAt: '2026-10-05' });
    Object.assign(rows.get(orgPaymentMethods)![0]!, { type: 'card', cardBrand: 'visa', cardFunding: 'credit', cardLast4: '4242' });
    rows.get(invoices)![0]!.balance = '50.00';
  });
  it('states the amount refunded, where it goes and the invoice balance afterwards', async () => {
    await enqueueRefundNotice(tx, 'mapping', { priorRefundedMinor: 0, refundedMinor: 5150 });
    expect(h.enqueue).toHaveBeenCalledWith(tx, expect.objectContaining({ kind: 'payment_receipt', invoiceId: 'invoice',
      dedupeKey: 'mapping:payment_receipt:refund:5150', toEmail: 'billing@example.test' }));
    const { html, text, frozen } = lastQueued();
    expect(frozen).toMatchObject({ mappingId: 'mapping', variant: 'refund', refundedAmount: '51.50', refundedTotal: '51.50',
      balanceAfter: '50.00', currency: 'USD', invoiceNumber: 'INV-1', partnerName: 'Provider', methodLabel: 'Visa credit card ending in 4242' });
    expect(footerBrand(html)).toBe('Provider');
    expect(text).toContain('Refunded: $51.50');
    expect(text).toContain('Refunded to: Visa credit card ending in 4242');
    for (const body of [html, text]) {
      expect(body).toContain('$51.50');
      expect(body).toContain('Visa credit card ending in 4242');
      expect(body).toContain('Balance due on invoice INV-1 after this refund: $50.00');
      expect(body).toContain('Provider');
      expect(body).not.toContain('Payment received');
    }
    expect(text).toContain('View invoice: https://example.test/invoice/pay');
  });
  it('does not use a partner receipt override, which describes a payment rather than a refund', async () => {
    rows.get(partners)![0]!.settings = { emailTemplates: { payment_receipt: { subject: 'Thanks for paying', html: '<p>Thanks for your payment</p>' } } };
    await enqueueRefundNotice(tx, 'mapping', { priorRefundedMinor: 0, refundedMinor: 5150 });
    const { html, text } = lastQueued();
    for (const body of [html, text]) expect(body).not.toContain('Thanks for');
  });
  it('a second refund reports only its own amount and dedupes on the cumulative total', async () => {
    rows.get(invoices)![0]!.balance = '100.00';
    await enqueueRefundNotice(tx, 'mapping', { priorRefundedMinor: 5150, refundedMinor: 10300 });
    expect(h.enqueue).toHaveBeenCalledWith(tx, expect.objectContaining({ dedupeKey: 'mapping:payment_receipt:refund:10300' }));
    expect(lastQueued().frozen).toMatchObject({ refundedAmount: '51.50', refundedTotal: '103.00', balanceAfter: '100.00' });
  });
  it('says a pay-link refund goes back to the original payment method', async () => {
    Object.assign(rows.get(invoiceStripePayments)![0]!, { source: 'checkout', paymentMethodType: null });
    await enqueueRefundNotice(tx, 'mapping', { priorRefundedMinor: 0, refundedMinor: 5150 });
    expect(lastQueued().text).toContain('Refunded to: the original payment method');
  });
  it('says so when nothing is left to pay', async () => {
    rows.get(invoices)![0]!.balance = '0.00';
    await enqueueRefundNotice(tx, 'mapping', { priorRefundedMinor: 0, refundedMinor: 300 });
    expect(lastQueued().text).toContain('Invoice INV-1 has no balance due.');
  });
  it('sends nothing without a billing contact or a new refund', async () => {
    await enqueueRefundNotice(tx, 'mapping', { priorRefundedMinor: 5150, refundedMinor: 5150 });
    rows.get(organizations)![0]!.billingContact = null;
    await enqueueRefundNotice(tx, 'mapping', { priorRefundedMinor: 0, refundedMinor: 5150 });
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
