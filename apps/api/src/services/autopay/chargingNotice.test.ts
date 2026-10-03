vi.mock('./staffNotifications', () => ({enqueueAutopayStaffNotifications:vi.fn()}));
import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  responses: [] as unknown[][], writes: [] as { table: unknown; values: Record<string, unknown> }[],
  emit: vi.fn(), send: vi.fn(), mint: vi.fn(), link: vi.fn(),
}));
vi.mock('../invoiceEvents', () => ({ emitInvoiceEvent: h.emit }));
vi.mock('../email', () => ({ getEmailService: () => ({ sendEmail: h.send }) }));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));
vi.mock('../invoiceLinkToken', () => ({ getOrMintInvoiceLink: h.link, buildPublicInvoiceUrl: () => 'https://example.test/invoice/token' }));
vi.mock('./linkTokens', () => ({ mintBillingLinkToken: h.mint, buildBillingLinkUrl: (purpose: string) => `https://example.test/billing/${purpose}/token` }));
vi.mock('../../db', () => {
  const db: Record<string, any> = {};
  const query = () => {
    const chain: Record<string, any> = {};
    for (const name of ['from', 'where', 'limit', 'for', 'orderBy', 'innerJoin', 'returning', 'onConflictDoNothing']) chain[name] = () => chain;
    chain.then = (resolve: (value: unknown) => unknown) => {
      if (!h.responses.length) throw new Error('Unexpected database query');
      return Promise.resolve(h.responses.shift()).then(resolve);
    };
    return chain;
  };
  db.select = query;
  db.update = (table: unknown) => ({ set: (values: Record<string, unknown>) => { h.writes.push({ table, values }); return query(); } });
  db.insert = (table: unknown) => ({ values: (values: Record<string, unknown>) => { h.writes.push({ table, values }); return query(); } });
  db.transaction = (fn: (tx: unknown) => unknown) => fn(db);
  return { db, assertOutsideHeldDbContext: () => {}, runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn() };
});
import { db } from '../../db';
import { billingNoticeOutbox, invoiceAutopaySchedules, invoices } from '../../db/schema';
import { dispatchPendingBillingNotices, type NoticeSentHandler } from './noticeOutbox';
import { enqueueAutopayNotice, invoiceAutopayNoticeSent, registerAutopayNoticeHandlers, type AutopayTerms } from './chargingNotice';

const invoice = { id: '10000000-0000-4000-8000-000000000001', partnerId: '20000000-0000-4000-8000-000000000001',
  orgId: '30000000-0000-4000-8000-000000000001', status: 'sent', balance: '100.00', currencyCode: 'USD',
  invoiceNumber: 'INV-1', dueDate: '2026-10-03', sentAt: null, autopayExcluded: false };
const terms: AutopayTerms = { issuedAt: '2026-10-01T12:00:00Z', offsetDays: 0, rule: 'later', cap: { enabled: false },
  methodType: 'us_bank_account', methodId: '40000000-0000-4000-8000-000000000001', last4: '1234', methodLabel: 'Bank ••1234',
  accountHolderType: 'individual', noticeLeadDays: 10, principal: '100.00', currency: 'USD', feeAmount: '0.00',
  feeKind: 'none', cardFeeBps: 0, achFeeAmount: '0.00', chargeDate: '2026-10-03', noticeSeq: 1 };
const schedule = { id: '50000000-0000-4000-8000-000000000001', invoiceId: invoice.id, orgId: invoice.orgId,
  state: 'awaiting_notice', eligible: true, enrollmentGeneration: 1, enrollmentId: '60000000-0000-4000-8000-000000000001',
  noticeOutboxId: '70000000-0000-4000-8000-000000000001', collectOn: '2026-10-03', termsSnapshot: terms };
const enrollment = { id: schedule.enrollmentId, orgId: invoice.orgId, partnerId: invoice.partnerId,
  generation: 1, status: 'active', stripeConnectionId: '80000000-0000-4000-8000-000000000001' };
const org = { id: invoice.orgId, partnerId: invoice.partnerId, status: 'active', deletedAt: null,
  name: 'Client', billingContact: { email: 'billing@example.test' }, billingAddressCountry: 'US', billingAddressRegion: 'NY' };
const partner = { id: invoice.partnerId, status: 'active', deletedAt: null, autopayEnabled: true, name: 'Partner', settings: {} };
const method = { id: terms.methodId, orgId: invoice.orgId, enrollmentId: enrollment.id, type: terms.methodType,
  accountHolderType: 'individual', status: 'active', isAutopayMethod: true, bankLast4: '1234', cardFunding: null };
const row = { id: schedule.noticeOutboxId, orgId: invoice.orgId, invoiceId: invoice.id, enrollmentId: enrollment.id,
  kind: 'invoice_autopay', seq: 1, attempts: 1, status: 'sending', sentAt: new Date('2026-10-05T12:00Z'),
  rendered: { subject: 'Invoice', html: '<p>Invoice</p>', text: 'Invoice', frozen: {
    amount: terms.principal, fee: terms.feeAmount, chargeDate: schedule.collectOn,
    methodType: terms.methodType, enrollmentGeneration: 1,
  } } } as Parameters<NoticeSentHandler>[1];

beforeEach(() => {
  vi.clearAllMocks(); h.responses.length = 0; h.writes.length = 0;
  h.mint.mockResolvedValue({ token: 'token' }); h.link.mockResolvedValue({ token: 'token' });
});

it.each(['old-outbox', 'cancelled', 'new-generation', 'cleared-authority', 'wrong-org', 'inactive'])(
  'does not revive authority after %s', async reason => {
    h.responses.push([invoice], reason === 'old-outbox' ? [] : [{ ...schedule,
      state: reason === 'cancelled' ? 'cancelled' : schedule.state,
      enrollmentId: reason === 'cleared-authority' ? null : schedule.enrollmentId }],
    [{ ...enrollment, generation: reason === 'new-generation' ? 2 : 1,
      orgId: reason === 'wrong-org' ? 'other-org' : invoice.orgId, status: reason === 'inactive' ? 'paused' : 'active' }]);
    await invoiceAutopayNoticeSent(db, row);
    expect(h.writes).toEqual([]); expect(h.emit).not.toHaveBeenCalled();
  });
it('does not mint or enqueue notices for a cleared enrollment', async () => {
  h.responses.push([{ ...schedule, enrollmentId: null }]);
  await enqueueAutopayNotice(db, schedule.id);
  expect(h.writes).toEqual([]); expect(h.mint).not.toHaveBeenCalled();
});
it.each(['2026-10-05T12:00Z', '2026-10-05T23:30Z'])('schedules delayed delivery from %s without changing frozen history or stamping twice', async sent => {
  const sentAt = new Date(sent);
  h.responses.push([invoice], [schedule], [enrollment], [], [{ id: invoice.id }]);
  await invoiceAutopayNoticeSent(db, { ...row, sentAt });
  expect(h.writes).toEqual([
    { table: invoiceAutopaySchedules, values: { noticeSentAt: sentAt, state: 'scheduled', collectOn: '2026-10-15' } },
    { table: invoices, values: { sentAt } },
  ]);
  expect(terms.chargeDate).toBe('2026-10-03');
  expect(h.emit).toHaveBeenCalledWith({ type: 'invoice.sent', invoiceId: invoice.id, orgId: invoice.orgId, partnerId: invoice.partnerId, actorUserId: null });
  h.responses.push([{ ...invoice, sentAt }], [{ ...schedule, state: 'scheduled' }]);
  await invoiceAutopayNoticeSent(db, { ...row, sentAt });
  expect(h.writes).toHaveLength(2); expect(h.emit).toHaveBeenCalledOnce();
});
it('does not emit when an invoice was already stamped by another notice', async () => {
  h.responses.push([{ ...invoice, sentAt: new Date() }], [schedule], [enrollment], [], []);
  await invoiceAutopayNoticeSent(db, row);
  expect(h.emit).not.toHaveBeenCalled();
});
it.each(['paid', 'void', 'draft'])('ignores %s invoices', async status => {
  h.responses.push([{ ...invoice, status }]);
  await invoiceAutopayNoticeSent(db, row); expect(h.writes).toEqual([]);
});
it('records a missing billing contact without minting links', async () => {
  h.responses.push([schedule], [invoice], [{ ...org, billingContact: null }], [partner], []);
  await enqueueAutopayNotice(db, schedule.id);
  expect(h.writes).toEqual([{ table: invoiceAutopaySchedules, values: { stateReason: 'no_billing_contact' } }]);
  expect(h.mint).not.toHaveBeenCalled();
});
it('deduplicates before minting links', async () => {
  h.responses.push([schedule], [invoice], [org], [partner], [{ id: row.id }]);
  await enqueueAutopayNotice(db, schedule.id);
  expect(h.writes).toEqual([]); expect(h.mint).not.toHaveBeenCalled();
});
it('enqueues immutable terms and skip/stop links through the supplied transaction', async () => {
  h.responses.push([schedule], [invoice], [org], [partner], [], [org], [{ id: row.id }], []);
  await enqueueAutopayNotice(db, schedule.id);
  expect(h.link).toHaveBeenCalledWith(invoice, db);
  for (const purpose of ['skip_invoice', 'stop_autopay']) expect(h.mint).toHaveBeenCalledWith(db, expect.objectContaining({
    purpose, enrollmentId: enrollment.id, generation: 1, ttlDays: 90,
  }));
  expect(h.writes[0]).toMatchObject({ table: billingNoticeOutbox, values: {
    dedupeKey: `${invoice.id}:invoice_autopay:1`, kind: 'invoice_autopay', seq: 1, toEmail: 'billing@example.test',
    rendered: { frozen: (row.rendered as { frozen: unknown }).frozen },
  } });
  expect(h.writes[1]).toEqual({ table: invoiceAutopaySchedules, values: { noticeOutboxId: row.id, noticeSentAt: null, stateReason: null } });
});

// Exercise the actual registry and dispatcher, mocking only database and transport.
function dispatchResponses(change: string) {
  const queued = { ...row, sentAt: null };
  const responses = [[queued], [queued], [queued],
    [{ ...invoice, status: change === 'paid' ? 'paid' : 'sent', orgId: change === 'wrong-tenant' ? 'other-org' : invoice.orgId }],
    [{ ...schedule, noticeOutboxId: change === 'old-outbox' ? 'other-outbox' : row.id,
      enrollmentId: change === 'cleared-authority' ? null : enrollment.id,
      state: change === 'cancelled' ? 'cancelled' : schedule.state }],
    [{ ...enrollment, generation: change === 'new-generation' ? 2 : 1, status: change === 'paused' ? 'paused' : 'active' }],
    [{ ...org, status: change === 'archived' ? 'archived' : 'active' }],
    [{ ...partner, status: change === 'suspended-partner' ? 'suspended' : 'active' }],
    [{ ...method, type: change === 'method-type' ? 'card' : method.type,
      accountHolderType: change === 'holder' ? 'company' : 'individual' }],
    [org], change === 'fee' ? [{ orgId: null, partnerId: partner.id, achFeeAmount: '1.00' }] : [],
    [{ id: enrollment.stripeConnectionId, partnerId: partner.id, accountCountry: 'US' }],
    [{feeTerms:{methodType:'us_bank_account',currency:'USD',feeAttested:false,cardFeeBps:0,achFeeAmount:change==='fee'?'1.00':'0.00'}}],
  ];
  return { queued, responses };
}
it.each(['old-outbox', 'cancelled', 'cleared-authority', 'new-generation', 'paused', 'wrong-tenant', 'paid', 'archived', 'suspended-partner', 'method-type', 'holder', 'fee'])(
  'cancels an obsolete queued notice (%s) before transport', async reason => {
    registerAutopayNoticeHandlers();
    const { responses } = dispatchResponses(reason);
    h.responses.push(...responses, []);
    expect(await dispatchPendingBillingNotices()).toEqual({ sent: 0, failed: 0 });
    expect(h.send).not.toHaveBeenCalled(); expect(h.emit).not.toHaveBeenCalled();
    expect(h.writes.at(-1)).toMatchObject({ table: billingNoticeOutbox, values: { status: 'cancelled' } });
  });
it('delivers a current notice and runs its registered acknowledgement handler', async () => {
  registerAutopayNoticeHandlers(); registerAutopayNoticeHandlers();
  const { queued, responses } = dispatchResponses('valid');
  h.responses.push(...responses, [partner], [queued], [row], [row], [invoice], [schedule], [enrollment], [], [{ id: invoice.id }], []);
  expect(await dispatchPendingBillingNotices()).toEqual({ sent: 1, failed: 0 });
  expect(h.send).toHaveBeenCalledOnce(); expect(h.emit).toHaveBeenCalledOnce();
  expect(h.writes).toContainEqual({ table: invoiceAutopaySchedules, values: { state: 'scheduled', noticeSentAt: row.sentAt, collectOn: '2026-10-15' } });
  expect(h.responses).toEqual([]);
});

it.each(['clientSkippedAt', 'mspExcludedAt'])('does not restore notice authority behind the %s fence', async field => {
  h.responses.push([invoice], [{...schedule, [field]:new Date()}], [enrollment]);
  await invoiceAutopayNoticeSent(db, row);
  expect(h.writes).toHaveLength(0);
});
