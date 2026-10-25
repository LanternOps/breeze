import { describe, it, expect, vi, beforeEach } from 'vitest';

const { dbResults, contexts } = vi.hoisted(() => ({ dbResults: [] as unknown[][], contexts: { open: 0 } }));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit', 'innerJoin', 'leftJoin', 'orderBy']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
    const next = dbResults.shift() ?? [];
    return (next instanceof Error ? Promise.reject(next) : Promise.resolve(next)).then(resolve, reject);
  };
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

import {
  buildSignedCopyTemplate,
  loadSignedCopyAttachment,
  sendSignedAgreementCopy,
  SIGNED_COPY_ATTACHMENT_MAX_BYTES,
} from './agreementSignedCopyEmail';
import { MAIL_PURPOSES } from './emailDomains/mailPurposes';
import { captureException } from './sentry';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const DOC_ID = '22222222-2222-4222-8222-222222222222';

const prepRow = (over: Record<string, unknown> = {}) => ({
  orgId: 'org-1', label: null, templateName: 'Business Associate Agreement', partnerId: 'p1',
  partnerName: 'Acme MSP', billingEmail: 'billing@example.com', emailSignature: 'The Acme team',
  ...over,
});
const docRow = (over: Record<string, unknown> = {}) => ({
  signerName: 'Dana Buyer', signedAt: new Date('2027-01-11T09:30:00.000Z'), ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  dbResults.length = 0;
  contexts.open = 0;
  getEmailServiceMock.mockReturnValue({ sendEmail: sendEmailMock });
  sendEmailMock.mockImplementation(async () => { expect(contexts.open).toBe(0); });
});

function queuePrepared(recipients: string[], over: Record<string, unknown> = {}) {
  dbResults.push([prepRow(over)]);
  dbResults.push(recipients.map((email) => ({ email })));
  dbResults.push([docRow()]);
}

describe('sendSignedAgreementCopy', () => {
  it('mails the signer + every recipient (lowercased, deduped) on the partner lane with the frozen bytes attached', async () => {
    queuePrepared(['ops@example.com', 'dana@example.com']);
    dbResults.push([{ pdfData: Buffer.from('%PDF-signed'), mime: 'application/pdf', templateName: 'Business Associate Agreement', label: null }]);
    const res = await sendSignedAgreementCopy({ requestId: REQUEST_ID, signedAgreementId: DOC_ID, signerEmail: ' Dana@Example.com ' });
    expect(res).toEqual({ sent: true, recipients: ['dana@example.com', 'ops@example.com'], attached: true });
    const env = sendEmailMock.mock.calls[0]![0];
    expect(env.to).toEqual(['dana@example.com', 'ops@example.com']);
    expect(env.purpose).toBe('agreement.signed_copy');
    expect(MAIL_PURPOSES['agreement.signed_copy']).toEqual({ lane: 'partner', stream: 'billing', fallbackFrom: 'partner_display_name' });
    expect(env.partnerId).toBe('p1');
    expect(env.partnerName).toBe('Acme MSP');
    expect(env.replyTo).toBe('billing@example.com');
    expect(env.subject).toBe('Your signed copy: Business Associate Agreement');
    expect(env.attachments).toEqual([{ filename: 'Business Associate Agreement (signed).pdf', content: Buffer.from('%PDF-signed'), contentType: 'application/pdf' }]);
  });

  it('an externally-signed PNG keeps its MIME-correct extension', async () => {
    dbResults.push([{ pdfData: Buffer.from('png'), mime: 'image/png', templateName: 'BAA', label: 'Scan "x"\r\n' }]);
    const att = await loadSignedCopyAttachment(DOC_ID);
    expect(att?.contentType).toBe('image/png');
    expect(att?.filename.endsWith('(signed).png')).toBe(true);
    expect(att?.filename).not.toMatch(/["\r\n]/);
  });

  it('over 10 MB → sent WITHOUT the attachment, the body says so, warned + captured', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    queuePrepared(['ops@example.com']);
    dbResults.push([{ pdfData: Buffer.alloc(SIGNED_COPY_ATTACHMENT_MAX_BYTES + 1), mime: 'application/pdf', templateName: 'BAA', label: null }]);
    const res = await sendSignedAgreementCopy({ requestId: REQUEST_ID, signedAgreementId: DOC_ID, signerEmail: null });
    expect(res).toEqual({ sent: true, recipients: ['ops@example.com'], attached: false });
    const env = sendEmailMock.mock.calls[0]![0];
    expect(env.attachments).toBeUndefined();
    expect(env.text).toContain('too large to attach');
    expect(warn).toHaveBeenCalled();
    expect(captureException).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('an attachment-load failure still delivers the mail (never blocks on the attachment)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    queuePrepared(['ops@example.com']);
    dbResults.push(new Error('db blew up') as unknown as unknown[]);
    const res = await sendSignedAgreementCopy({ requestId: REQUEST_ID, signedAgreementId: DOC_ID, signerEmail: 'dana@example.com' });
    expect(res).toMatchObject({ sent: true, attached: false });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalled();
    err.mockRestore();
  });

  it('no signer email and no recipients → nothing sent', async () => {
    queuePrepared([]);
    const res = await sendSignedAgreementCopy({ requestId: REQUEST_ID, signedAgreementId: DOC_ID, signerEmail: null });
    expect(res).toEqual({ sent: false, reason: 'no_recipients' });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('no email service → reported, not thrown', async () => {
    getEmailServiceMock.mockReturnValue(null);
    queuePrepared(['ops@example.com']);
    const res = await sendSignedAgreementCopy({ requestId: REQUEST_ID, signedAgreementId: DOC_ID, signerEmail: null });
    expect(res).toEqual({ sent: false, reason: 'no_email_service' });
  });

  it('never throws: a transport failure is captured and reported', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    queuePrepared(['ops@example.com']);
    dbResults.push([{ pdfData: Buffer.from('x'), mime: 'application/pdf', templateName: 'BAA', label: null }]);
    sendEmailMock.mockRejectedValue(new Error('smtp down'));
    await expect(sendSignedAgreementCopy({ requestId: REQUEST_ID, signedAgreementId: DOC_ID, signerEmail: null }))
      .resolves.toEqual({ sent: false, reason: 'send_failed' });
    expect(captureException).toHaveBeenCalled();
    err.mockRestore();
  });

  it('a missing request is a quiet no-op', async () => {
    dbResults.push([]);
    expect(await sendSignedAgreementCopy({ requestId: REQUEST_ID, signedAgreementId: DOC_ID, signerEmail: 'x@example.com' }))
      .toEqual({ sent: false, reason: 'not_found' });
  });
});

describe('buildSignedCopyTemplate', () => {
  it('says "electronically accepted", never "signed by", escapes partner text, and gives no portal link', () => {
    const t = buildSignedCopyTemplate({
      partnerName: 'Acme <MSP>', agreementName: 'BAA', signerName: 'Dana Buyer',
      signedDate: 'January 11, 2027', attached: true, signature: 'Thanks,\n<b>Acme</b>',
    });
    expect(t.subject).toBe('Your signed copy: BAA');
    expect(t.html).toContain('Acme &lt;MSP&gt;');
    expect(t.html).toContain('&lt;b&gt;Acme&lt;/b&gt;');
    expect(`${t.html}${t.text}`).toContain('electronically accepted');
    expect(`${t.html}${t.text}`).not.toMatch(/signed by/i);
    expect(t.text).toContain('A copy is attached');
    expect(t.text).toContain('Need another copy? Please contact Acme <MSP>.');
    expect(t.html).not.toMatch(/href=/);
  });
});
