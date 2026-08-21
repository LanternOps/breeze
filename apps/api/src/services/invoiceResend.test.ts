import { describe, it, expect, vi, beforeEach } from 'vitest';

// DB mock: select().from().where().limit() resolves to the next queued row set;
// update().set().where() is a thenable so a bookkeeping write awaits cleanly.
// Mirrors the pattern in invoiceCheckout.test.ts.
const { dbResults, updateSetMock } = vi.hoisted(() => ({
  dbResults: [] as unknown[][],
  updateSetMock: vi.fn(),
}));
vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'limit']) chain[m] = vi.fn(() => chain);
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      const rows = dbResults.shift() ?? [];
      return Promise.resolve(rows).then(resolve);
    };
    (chain as { update: unknown }).update = vi.fn(() => ({
      set: (v: unknown) => { updateSetMock(v); return { where: () => Promise.resolve(undefined) }; },
    }));
    return chain;
  };
  return { db: makeChain() };
});

const { sendEmailMock, getEmailServiceMock } = vi.hoisted(() => ({
  sendEmailMock: vi.fn(),
  getEmailServiceMock: vi.fn(),
}));
vi.mock('./email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./email')>();
  return { ...actual, getEmailService: getEmailServiceMock };
});

vi.mock('./invoiceEvents', () => ({ emitInvoiceEvent: vi.fn() }));
vi.mock('./portalUrl', () => ({ portalBase: () => 'https://portal.example.test/portal' }));

import { resendInvoiceEmail } from './invoicePdf';
import { InvoiceServiceError } from './invoiceTypes';

const INV_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = '22222222-2222-2222-2222-222222222222';
const actor = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: null };

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: INV_ID,
    orgId: ORG_ID,
    partnerId: 'p1',
    invoiceNumber: 'INV-2026-0007',
    status: 'sent',
    currencyCode: 'USD',
    dueDate: '2026-09-01',
    total: '158.50',
    depositDue: null,
    amountPaid: '0.00',
    balance: '158.50',
    sentAt: new Date('2026-08-01T00:00:00Z'),
    ...overrides,
  };
}

const PDF_ROW = [{ pdf: Buffer.from('%PDF-1.4 fake') }];
const ORG_ROW = [{ billingContact: { email: 'ap@acme.test' }, name: 'Acme Corp' }];
const PARTNER_ROW = [{ name: 'Lantern MSP', billingEmail: 'billing@lantern.test', emailSignature: '— Todd\nLantern MSP' }];

/** Queue the reads deliverInvoiceEmail makes, in order. */
function queueHappyPath(inv = invoice(), { withPdf = true } = {}) {
  dbResults.push([inv]);
  if (withPdf) dbResults.push(PDF_ROW);
  dbResults.push(ORG_ROW);
  dbResults.push(PARTNER_ROW);
}

describe('resendInvoiceEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbResults.length = 0;
    updateSetMock.mockReset();
    sendEmailMock.mockReset().mockResolvedValue(undefined);
    getEmailServiceMock.mockReturnValue({
      sendEmail: sendEmailMock,
      fromWithDisplayName: (name: string) => `${name} <no-reply@breeze.test>`,
    });
  });

  it('emails the org billing contact and reports the recipients', async () => {
    queueHappyPath();
    const result = await resendInvoiceEmail(INV_ID, actor);
    expect(result.emailed).toBe(true);
    expect(result.recipients).toEqual(['ap@acme.test']);
    const envelope = sendEmailMock.mock.calls[0][0];
    expect(envelope.to).toEqual(['ap@acme.test']);
    expect(envelope.replyTo).toBe('billing@lantern.test');
    expect(envelope.from).toBe('Lantern MSP via Breeze <no-reply@breeze.test>');
    expect(envelope.attachments?.[0]?.filename).toBe('INV-2026-0007.pdf');
  });

  // The whole point of a re-send: it is the same document, not a new one. A
  // re-stamped sent_at would rewrite when the customer was first billed, and a
  // second invoice.sent would double-fire anything wired to that bus later.
  it('writes nothing — sent_at stays pinned and no lifecycle event is re-emitted', async () => {
    queueHappyPath();
    const { emitInvoiceEvent } = await import('./invoiceEvents');
    const result = await resendInvoiceEmail(INV_ID, actor);
    expect(updateSetMock).not.toHaveBeenCalled();
    expect(emitInvoiceEvent).not.toHaveBeenCalled();
    expect(result.invoice.sentAt).toEqual(new Date('2026-08-01T00:00:00Z'));
  });

  it('composer recipients override the billing contact, normalized and deduped', async () => {
    queueHappyPath();
    const result = await resendInvoiceEmail(INV_ID, actor, {
      to: ['  AP@Acme.test ', 'ap@acme.test', 'cfo@acme.test'],
      cc: ['Books@acme.test'],
    });
    expect(result.recipients).toEqual(['ap@acme.test', 'cfo@acme.test']);
    const envelope = sendEmailMock.mock.calls[0][0];
    expect(envelope.to).toEqual(['ap@acme.test', 'cfo@acme.test']);
    expect(envelope.cc).toEqual(['books@acme.test']);
  });

  it('carries the composer subject and note onto the message', async () => {
    queueHappyPath();
    await resendInvoiceEmail(INV_ID, actor, { subject: 'Copy of invoice 0007', message: 'As requested on the call.' });
    const envelope = sendEmailMock.mock.calls[0][0];
    expect(envelope.subject).toBe('Copy of invoice 0007');
    expect(envelope.html).toContain('As requested on the call.');
    expect(envelope.text).toContain('As requested on the call.');
  });

  // includePdf:false must skip the render/fetch entirely — and the email body
  // must stop promising an attachment that isn't there.
  it('includePdf:false sends no attachment and drops the "PDF is attached" copy', async () => {
    queueHappyPath(invoice(), { withPdf: false });
    await resendInvoiceEmail(INV_ID, actor, { includePdf: false });
    const envelope = sendEmailMock.mock.calls[0][0];
    expect(envelope.attachments).toBeUndefined();
    expect(envelope.text).not.toContain('A PDF copy is attached');
  });

  it('reports no_email_service instead of pretending it sent', async () => {
    getEmailServiceMock.mockReturnValue(null);
    queueHappyPath();
    const result = await resendInvoiceEmail(INV_ID, actor);
    expect(result).toMatchObject({ emailed: false, reason: 'no_email_service', recipients: [] });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('reports no_billing_contact when nothing resolves a recipient', async () => {
    dbResults.push([invoice()], PDF_ROW, [{ billingContact: null, name: 'Acme Corp' }], PARTNER_ROW);
    const result = await resendInvoiceEmail(INV_ID, actor);
    expect(result).toMatchObject({ emailed: false, reason: 'no_billing_contact' });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  // The invoice is already issued, so a transport failure has nothing to roll
  // back — a 500 here would read as "could not re-send" for a message that may
  // well have gone out. Report it instead.
  it('swallows a transport failure into reason:send_failed rather than throwing', async () => {
    sendEmailMock.mockRejectedValue(new Error('smtp 421'));
    queueHappyPath();
    const result = await resendInvoiceEmail(INV_ID, actor);
    expect(result).toMatchObject({ emailed: false, reason: 'send_failed' });
    expect(result.recipients).toEqual(['ap@acme.test']);
  });

  it('refuses a draft — there is nothing issued to re-send', async () => {
    dbResults.push([invoice({ status: 'draft', invoiceNumber: null, sentAt: null })]);
    await expect(resendInvoiceEmail(INV_ID, actor)).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('refuses a void invoice — never re-mail a demand we cancelled', async () => {
    dbResults.push([invoice({ status: 'void' })]);
    await expect(resendInvoiceEmail(INV_ID, actor)).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  // "Send me a copy for our records" is the most common reason a customer asks,
  // and unlike a quote's accept link this email dispenses no credential.
  it('allows a PAID invoice to be re-sent', async () => {
    queueHappyPath(invoice({ status: 'paid', amountPaid: '158.50', balance: '0.00' }));
    const result = await resendInvoiceEmail(INV_ID, actor);
    expect(result.emailed).toBe(true);
  });

  it('404s a missing invoice', async () => {
    dbResults.push([]);
    await expect(resendInvoiceEmail(INV_ID, actor)).rejects.toBeInstanceOf(InvoiceServiceError);
  });

  it('404s (never 403s) an invoice outside the actor org scope', async () => {
    dbResults.push([invoice()]);
    const scoped = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['33333333-3333-3333-3333-333333333333'] };
    await expect(resendInvoiceEmail(INV_ID, scoped)).rejects.toMatchObject({ status: 404, code: 'INVOICE_NOT_FOUND' });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});
