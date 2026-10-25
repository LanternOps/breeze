import { describe, it, expect, vi, beforeEach } from 'vitest';

// Queued select-chain db mock (quoteOutcomeNotify.test.ts pattern).
const { dbResults, contexts } = vi.hoisted(() => ({ dbResults: [] as unknown[][], contexts: { open: 0 } }));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit', 'innerJoin', 'leftJoin']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(dbResults.shift() ?? []).then(resolve);
  return {
    db: chain,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: async (fn: () => Promise<unknown>) => {
      contexts.open += 1;
      try { return await fn(); } finally { contexts.open -= 1; }
    },
  };
});

const { sendEmailMock, getEmailServiceMock } = vi.hoisted(() => ({ sendEmailMock: vi.fn(), getEmailServiceMock: vi.fn() }));
vi.mock('./email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./email')>()),
  getEmailService: getEmailServiceMock,
}));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { notifyAgreementOutcome, buildAgreementOutcomeTemplate } from './agreementOutcomeNotify';
import { MAIL_PURPOSES } from './emailDomains/mailPurposes';
import { captureException } from './sentry';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

const requestRow = (over: Record<string, unknown> = {}) => ({
  orgId: 'org-1', createdBy: 'u1', label: 'BAA 2027', declineReason: 'Not this year.\n<b>Maybe</b> Q1.',
  templateName: 'Business Associate Agreement', orgName: 'Example Clinic', partnerId: 'p1',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  dbResults.length = 0;
  contexts.open = 0;
  getEmailServiceMock.mockReturnValue({ sendEmail: sendEmailMock });
  sendEmailMock.mockImplementation(async () => { expect(contexts.open).toBe(0); });
});

describe('notifyAgreementOutcome', () => {
  it('emails the creator on a customer signature, on the platform staff purpose, with no DB context held across SMTP', async () => {
    dbResults.push([requestRow()]);
    dbResults.push([{ email: 'tech@example.com' }]);
    await notifyAgreementOutcome({ requestId: REQUEST_ID, outcome: 'signed', source: 'customer', signerName: 'Dana Buyer' });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const envelope = sendEmailMock.mock.calls[0]![0];
    expect(envelope.to).toBe('tech@example.com');
    expect(envelope.purpose).toBe('staff.agreement_outcome');
    expect(MAIL_PURPOSES['staff.agreement_outcome']).toEqual({ lane: 'platform' });
    expect(envelope.subject).toContain('signed');
    expect(envelope.text).toContain('Dana Buyer at Example Clinic');
    expect(envelope.partnerId).toBeUndefined();
  });

  it('falls back to the partner billing inbox when the creator has no email / is gone', async () => {
    dbResults.push([requestRow({ createdBy: 'u-gone' })]);
    dbResults.push([]); // creator missing
    dbResults.push([{ billingEmail: ' billing@example.com ' }]);
    await notifyAgreementOutcome({ requestId: REQUEST_ID, outcome: 'declined', source: 'customer' });
    expect(sendEmailMock.mock.calls[0]![0].to).toBe('billing@example.com');
  });

  it('falls back to the billing inbox when there is no creator at all', async () => {
    dbResults.push([requestRow({ createdBy: null })]);
    dbResults.push([{ billingEmail: 'billing@example.com' }]);
    await notifyAgreementOutcome({ requestId: REQUEST_ID, outcome: 'signed', source: 'customer' });
    expect(sendEmailMock.mock.calls[0]![0].to).toBe('billing@example.com');
  });

  it('warns and sends nothing when neither recipient exists', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    dbResults.push([requestRow({ createdBy: null })]);
    dbResults.push([{ billingEmail: null }]);
    await notifyAgreementOutcome({ requestId: REQUEST_ID, outcome: 'signed', source: 'customer' });
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('an MSP-recorded outcome sends no email (the actor already knows)', async () => {
    dbResults.push([requestRow()]);
    await notifyAgreementOutcome({ requestId: REQUEST_ID, outcome: 'signed', source: 'msp' });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('a missing request is a quiet no-op', async () => {
    dbResults.push([]);
    await notifyAgreementOutcome({ requestId: REQUEST_ID, outcome: 'signed', source: 'customer' });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('never throws: a transport failure is logged + captured', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbResults.push([requestRow()]);
    dbResults.push([{ email: 'tech@example.com' }]);
    sendEmailMock.mockRejectedValue(new Error('smtp down'));
    await expect(notifyAgreementOutcome({ requestId: REQUEST_ID, outcome: 'signed', source: 'customer' })).resolves.toBeUndefined();
    expect(captureException).toHaveBeenCalled();
    err.mockRestore();
  });

  it('no email service configured → no send, no throw', async () => {
    getEmailServiceMock.mockReturnValue(null);
    dbResults.push([requestRow()]);
    dbResults.push([{ email: 'tech@example.com' }]);
    await expect(notifyAgreementOutcome({ requestId: REQUEST_ID, outcome: 'signed', source: 'customer' })).resolves.toBeUndefined();
  });
});

describe('buildAgreementOutcomeTemplate', () => {
  it('declined: includes the escaped verbatim note', () => {
    const t = buildAgreementOutcomeTemplate({
      outcome: 'declined', agreementName: 'BAA 2027', orgName: 'Example Clinic', signerName: null,
      declineReason: 'Not this year.\n<b>Maybe</b> Q1.', agreementsUrl: null,
    });
    expect(t.subject).toBe('Agreement BAA 2027 declined — Example Clinic');
    expect(t.html).toContain('&lt;b&gt;Maybe&lt;/b&gt;');
    expect(t.html).not.toContain('<b>Maybe</b>');
    expect(t.text).toContain('Their note: Not this year.');
  });

  it('signed: names the signer and links to Signed agreements when a web base exists', () => {
    const t = buildAgreementOutcomeTemplate({
      outcome: 'signed', agreementName: 'BAA', orgName: 'Example Clinic', signerName: 'Dana Buyer',
      declineReason: 'ignored', agreementsUrl: 'https://app.example.com/agreements/signed',
    });
    expect(t.subject).toBe('Agreement BAA signed — Example Clinic');
    expect(t.html).toContain('https://app.example.com/agreements/signed');
    expect(t.text).not.toContain('ignored');
    // Vocabulary: the UI never says "contract document".
    expect(`${t.html}${t.text}`).not.toMatch(/contract document/i);
  });
});
