import { describe, it, expect, vi, beforeEach } from 'vitest';

// Queued select-chain db mock (invoiceResend.test.ts pattern).
const { dbResults } = vi.hoisted(() => ({ dbResults: [] as unknown[][] }));
vi.mock('../db', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'from', 'where', 'limit']) chain[m] = vi.fn(() => chain);
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(dbResults.shift() ?? []).then(resolve);
    return chain;
  };
  return {
    db: makeChain(),
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

const { sendEmailMock, getEmailServiceMock } = vi.hoisted(() => ({
  sendEmailMock: vi.fn(),
  getEmailServiceMock: vi.fn(),
}));
vi.mock('./email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./email')>();
  return { ...actual, getEmailService: getEmailServiceMock };
});

const { emitQuoteEventMock } = vi.hoisted(() => ({ emitQuoteEventMock: vi.fn() }));
vi.mock('./quoteEvents', () => ({ emitQuoteEvent: emitQuoteEventMock }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { notifyQuoteOutcome } from './quoteOutcomeNotify';
import { buildQuoteOutcomeTemplate } from './email';

const QUOTE_ID = '11111111-1111-1111-1111-111111111111';

const quoteRow = (overrides: Record<string, unknown> = {}) => ({
  quoteNumber: 'Q-2026-0042', orgId: 'org-1', partnerId: 'p1',
  createdBy: 'u1', declineReason: 'Too expensive for this year.\nMaybe Q1.',
  convertedInvoiceId: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  dbResults.length = 0;
  getEmailServiceMock.mockReturnValue({ sendEmail: sendEmailMock });
  sendEmailMock.mockResolvedValue(undefined);
});

describe('notifyQuoteOutcome', () => {
  it('emails the quote creator with the verbatim decline reason and emits quote.declined', async () => {
    dbResults.push([quoteRow()]);                       // quote
    dbResults.push([{ email: 'tech@lantern.test' }]);   // creator
    dbResults.push([{ billingEmail: 'billing@lantern.test' }]); // partner (fallback, unused)
    dbResults.push([{ name: 'Acme Corp' }]);            // org
    await notifyQuoteOutcome({ quoteId: QUOTE_ID, outcome: 'declined', source: 'customer' });
    expect(emitQuoteEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'quote.declined', quoteId: QUOTE_ID }));
    const envelope = sendEmailMock.mock.calls[0]![0];
    expect(envelope.to).toBe('tech@lantern.test');
    expect(envelope.subject).toBe('Quote Q-2026-0042 declined — Acme Corp');
    expect(envelope.text).toContain('Too expensive for this year.');
    // HTML: escaped + newline preserved as <br>.
    expect(envelope.html).toContain('Too expensive for this year.<br>Maybe Q1.');
  });

  it('falls back to the partner billing email when the creator is unresolvable', async () => {
    dbResults.push([quoteRow({ createdBy: null })]);
    dbResults.push([{ billingEmail: 'billing@lantern.test' }]);
    dbResults.push([{ name: 'Acme Corp' }]);
    await notifyQuoteOutcome({ quoteId: QUOTE_ID, outcome: 'declined', source: 'customer' });
    expect(sendEmailMock.mock.calls[0]![0].to).toBe('billing@lantern.test');
  });

  it('accepted outcome names the signer and the issued invoice', async () => {
    dbResults.push([quoteRow({ declineReason: null, convertedInvoiceId: 'inv-1' })]);
    dbResults.push([{ email: 'tech@lantern.test' }]);
    dbResults.push([{ billingEmail: null }]);
    dbResults.push([{ name: 'Acme Corp' }]);
    dbResults.push([{ invoiceNumber: 'INV-2026-0099' }]);
    await notifyQuoteOutcome({ quoteId: QUOTE_ID, outcome: 'accepted', source: 'customer', signerName: 'Pat Prospect' });
    expect(emitQuoteEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'quote.accepted' }));
    const envelope = sendEmailMock.mock.calls[0]![0];
    expect(envelope.subject).toBe('Quote Q-2026-0042 accepted — Acme Corp');
    expect(envelope.text).toContain('Pat Prospect at Acme Corp has accepted');
    expect(envelope.text).toContain('INV-2026-0099');
  });

  it('skips quietly when no recipient can be resolved (still emits the event)', async () => {
    dbResults.push([quoteRow({ createdBy: null })]);
    dbResults.push([{ billingEmail: null }]);
    await notifyQuoteOutcome({ quoteId: QUOTE_ID, outcome: 'declined', source: 'customer' });
    expect(emitQuoteEventMock).toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('never throws — a transport failure is swallowed', async () => {
    dbResults.push([quoteRow()]);
    dbResults.push([{ email: 'tech@lantern.test' }]);
    dbResults.push([{ billingEmail: null }]);
    dbResults.push([{ name: 'Acme Corp' }]);
    sendEmailMock.mockRejectedValue(new Error('smtp down'));
    await expect(notifyQuoteOutcome({ quoteId: QUOTE_ID, outcome: 'declined', source: 'customer' })).resolves.toBeUndefined();
  });


  it("an MSP-side decline emits the event but sends NO email (never misattributed to the customer)", async () => {
    dbResults.push([quoteRow()]);
    await notifyQuoteOutcome({ quoteId: QUOTE_ID, outcome: 'declined', source: 'msp' });
    expect(emitQuoteEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'quote.declined' }));
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('no-ops on a vanished quote', async () => {
    dbResults.push([]);
    await notifyQuoteOutcome({ quoteId: QUOTE_ID, outcome: 'declined', source: 'customer' });
    expect(emitQuoteEventMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe('buildQuoteOutcomeTemplate', () => {
  it('escapes HTML in the customer note', () => {
    const t = buildQuoteOutcomeTemplate({
      outcome: 'declined', quoteNumber: 'Q-1', orgName: 'Acme',
      declineReason: '<script>alert(1)</script>',
    });
    expect(t.html).not.toContain('<script>');
    expect(t.html).toContain('&lt;script&gt;');
  });

  it('omits the quote button when no app base url is configured', () => {
    const t = buildQuoteOutcomeTemplate({ outcome: 'accepted', quoteNumber: 'Q-1', orgName: 'Acme', quoteUrl: null });
    expect(t.text).not.toContain('View quote');
  });
});
