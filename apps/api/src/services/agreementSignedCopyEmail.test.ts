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

// The certified copy (#9075 W2c): renderer + loader are unit-tested in
// agreementCertificate.test.ts; here only the attachment seam's use of them.
const { loadInputMock, renderMock } = vi.hoisted(() => ({ loadInputMock: vi.fn(), renderMock: vi.fn() }));
vi.mock('./agreementCertificate', () => ({
  loadCertifiedAgreementInput: loadInputMock,
  renderCertifiedAgreementPdf: renderMock,
}));

// #9075 W3a: the portal link the email falls back to.
const { portalBaseMock } = vi.hoisted(() => ({ portalBaseMock: vi.fn(() => 'https://portal.example.test/portal') }));
vi.mock('./portalUrl', () => ({ portalBase: portalBaseMock }));

import {
  buildSignedCopyTemplate,
  loadSignedCopyAttachment,
  sendSignedAgreementCopy,
  SIGNED_COPY_ATTACHMENT_MAX_BYTES,
} from './agreementSignedCopyEmail';
import { MAIL_PURPOSES } from './emailDomains/mailPurposes';
import { captureException } from './sentry';
import { PdfMergeError } from './pdfMerge';

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

const CERTIFIED = Buffer.from('%PDF-1.7 certified copy');

/** What loadCertifiedAgreementInput returns for the signed agreement. */
function certInput(over: { pdfData?: Buffer; mime?: string; name?: string } = {}) {
  return {
    document: { id: DOC_ID, pdfData: over.pdfData ?? Buffer.from('%PDF-signed'), mime: over.mime ?? 'application/pdf' },
    agreement: { name: over.name ?? 'Business Associate Agreement', templateName: 'Business Associate Agreement', versionNumber: 1 },
  };
}

/** The certified copy renders fine. */
function queueCertified(input = certInput(), pdf = CERTIFIED) {
  loadInputMock.mockResolvedValueOnce(input);
  renderMock.mockResolvedValueOnce(pdf);
}

function queuePrepared(recipients: string[], over: Record<string, unknown> = {}) {
  dbResults.push([prepRow(over)]);
  dbResults.push(recipients.map((email) => ({ email })));
  dbResults.push([docRow()]);
}

describe('sendSignedAgreementCopy', () => {
  it('mails the signer + every recipient (lowercased, deduped) on the partner lane with the CERTIFIED copy attached', async () => {
    queuePrepared(['ops@example.com', 'dana@example.com']);
    queueCertified();
    const res = await sendSignedAgreementCopy({ requestId: REQUEST_ID, signedAgreementId: DOC_ID, signerEmail: ' Dana@Example.com ' });
    expect(res).toEqual({ sent: true, recipients: ['dana@example.com', 'ops@example.com'], attached: true, certified: true, portalLink: false });
    const env = sendEmailMock.mock.calls[0]![0];
    expect(env.to).toEqual(['dana@example.com', 'ops@example.com']);
    expect(env.purpose).toBe('agreement.signed_copy');
    expect(MAIL_PURPOSES['agreement.signed_copy']).toEqual({ lane: 'partner', stream: 'billing', fallbackFrom: 'partner_display_name' });
    expect(env.partnerId).toBe('p1');
    expect(env.partnerName).toBe('Acme MSP');
    expect(env.replyTo).toBe('billing@example.com');
    expect(env.subject).toBe('Your signed copy: Business Associate Agreement');
    expect(env.attachments).toEqual([{ filename: 'Business Associate Agreement (signed).pdf', content: CERTIFIED, contentType: 'application/pdf' }]);
    expect(loadInputMock).toHaveBeenCalledWith(DOC_ID);
  });

  it('an externally-signed PNG is attached as its certified copy — a PDF, sanitized name', async () => {
    queueCertified(certInput({ pdfData: Buffer.from('png'), mime: 'image/png', name: 'Scan "x"\r\n' }));
    const att = await loadSignedCopyAttachment(DOC_ID);
    expect(att?.contentType).toBe('application/pdf');
    expect(att?.content).toBe(CERTIFIED);
    expect(att?.filename.endsWith('(signed).pdf')).toBe(true);
    expect(att?.certified).toBe(true);
    expect(att?.filename).not.toMatch(/["\r\n]/);
  });

  it('a PdfMergeError falls back to the ORIGINAL bytes under the stored MIME — warned + captured, never blocked', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const png = Buffer.from('png-original');
    loadInputMock.mockResolvedValueOnce(certInput({ pdfData: png, mime: 'image/png', name: 'BAA' }));
    renderMock.mockRejectedValueOnce(new PdfMergeError('The signed agreement image could not be read: bad'));
    const att = await loadSignedCopyAttachment(DOC_ID);
    // Named as the original so nobody mistakes it for the certified copy.
    expect(att).toEqual({ filename: 'BAA (signed, original).png', content: png, contentType: 'image/png', certified: false });
    expect(warn).toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('any other render failure ALSO falls back to the original (delivery never blocks on the certificate), logged as an error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    loadInputMock.mockResolvedValueOnce(certInput());
    renderMock.mockRejectedValueOnce(new Error('document theme font missing'));
    const att = await loadSignedCopyAttachment(DOC_ID);
    expect(att).toEqual({ filename: 'Business Associate Agreement (signed, original).pdf', content: Buffer.from('%PDF-signed'), contentType: 'application/pdf', certified: false });
    expect(err).toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it('end to end: a fallback original is still ATTACHED to the mail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    queuePrepared(['ops@example.com']);
    loadInputMock.mockResolvedValueOnce(certInput());
    renderMock.mockRejectedValueOnce(new PdfMergeError('bad xref'));
    const res = await sendSignedAgreementCopy({ requestId: REQUEST_ID, signedAgreementId: DOC_ID, signerEmail: null });
    expect(res).toEqual({ sent: true, recipients: ['ops@example.com'], attached: true, certified: false, portalLink: true });
    // The transport gets only filename/content/contentType — no internal flags.
    expect(sendEmailMock.mock.calls[0]![0].attachments).toEqual([
      { filename: 'Business Associate Agreement (signed, original).pdf', content: Buffer.from('%PDF-signed'), contentType: 'application/pdf' },
    ]);
    warn.mockRestore();
  });

  it('a certified copy over 10 MB whose ORIGINAL fits → the original is attached instead, warned', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    queueCertified(certInput({ name: 'BAA' }), Buffer.alloc(SIGNED_COPY_ATTACHMENT_MAX_BYTES + 1));
    const att = await loadSignedCopyAttachment(DOC_ID);
    expect(att).toEqual({ filename: 'BAA (signed, original).pdf', content: Buffer.from('%PDF-signed'), contentType: 'application/pdf', certified: false });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('over 10 MB → sent WITHOUT the attachment, the body says so, warned + captured', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    queuePrepared(['ops@example.com']);
    // Both the certified copy AND the original are over the limit.
    queueCertified(certInput({ name: 'BAA', pdfData: Buffer.alloc(SIGNED_COPY_ATTACHMENT_MAX_BYTES + 1) }), Buffer.alloc(SIGNED_COPY_ATTACHMENT_MAX_BYTES + 2));
    const res = await sendSignedAgreementCopy({ requestId: REQUEST_ID, signedAgreementId: DOC_ID, signerEmail: null });
    expect(res).toEqual({ sent: true, recipients: ['ops@example.com'], attached: false, certified: false, portalLink: true });
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
    loadInputMock.mockRejectedValueOnce(new Error('db blew up'));
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
    queueCertified(certInput({ name: 'BAA' }));
    sendEmailMock.mockRejectedValue(new Error('smtp down'));
    await expect(sendSignedAgreementCopy({ requestId: REQUEST_ID, signedAgreementId: DOC_ID, signerEmail: null }))
      .resolves.toEqual({ sent: false, reason: 'send_failed' });
    expect(captureException).toHaveBeenCalled();
    err.mockRestore();
  });

  it('a request missing right after signing sends nothing and is logged + captured (integrity signal)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbResults.push([]);
    expect(await sendSignedAgreementCopy({ requestId: REQUEST_ID, signedAgreementId: DOC_ID, signerEmail: 'x@example.com' }))
      .toEqual({ sent: false, reason: 'not_found' });
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it('a signed-agreement row that is gone (not thrown) → mail still sent without it, captured once', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    queuePrepared(['ops@example.com']);
    loadInputMock.mockResolvedValueOnce(null); // the signed agreement row is gone
    const res = await sendSignedAgreementCopy({ requestId: REQUEST_ID, signedAgreementId: DOC_ID, signerEmail: null });
    expect(res).toEqual({ sent: true, recipients: ['ops@example.com'], attached: false, certified: false, portalLink: true });
    expect(sendEmailMock.mock.calls[0]![0].text).toContain('could not be attached');
    expect(captureException).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});

describe('subject header safety', () => {
  it('a line break in a staff-authored label never reaches the Subject', () => {
    const t = buildSignedCopyTemplate({ partnerName: 'Acme', agreementName: 'BAA\r\nBcc: x@example.com', signerName: null, signedDate: 'January 1, 2027', attached: true });
    expect(t.subject).not.toMatch(/[\r\n]/);
    expect(t.subject).toBe('Your signed copy: BAA Bcc: x@example.com');
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

  it('with a portal URL (the W3a fallback) names the client portal and links it, escaped', () => {
    const t = buildSignedCopyTemplate({
      partnerName: 'Acme', agreementName: 'BAA', signerName: 'Dana', signedDate: 'January 11, 2027',
      attached: false, portalUrl: 'https://portal.example.test/portal/agreements?a=1&b="2"',
    });
    expect(t.text).toContain('client portal: https://portal.example.test/portal/agreements?a=1&b="2"');
    expect(t.html).toContain('href="https://portal.example.test/portal/agreements?a=1&amp;b=&quot;2&quot;"');
    expect(`${t.html}${t.text}`).not.toMatch(/signed by/i);
  });
});

describe('portal-link fallback (#9075 W3a, spec §3.6/§3.8)', () => {
  const PORTAL_LINK = 'https://portal.example.test/portal/agreements';

  it('the certified copy attached → no portal link', async () => {
    queuePrepared(['ops@example.com']);
    queueCertified();
    const res = await sendSignedAgreementCopy({ requestId: REQUEST_ID, signedAgreementId: DOC_ID, signerEmail: null });
    expect(res).toMatchObject({ sent: true, attached: true, certified: true, portalLink: false });
    const env = sendEmailMock.mock.calls[0]![0];
    expect(env.text).not.toContain(PORTAL_LINK);
    expect(env.html).not.toMatch(/href=/);
  });

  it('only the ORIGINAL could be attached → the mail adds the portal link for the certified copy', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    queuePrepared(['ops@example.com']);
    loadInputMock.mockResolvedValueOnce(certInput());
    renderMock.mockRejectedValueOnce(new PdfMergeError('bad xref'));
    const res = await sendSignedAgreementCopy({ requestId: REQUEST_ID, signedAgreementId: DOC_ID, signerEmail: null });
    expect(res).toMatchObject({ sent: true, attached: true, certified: false, portalLink: true });
    const env = sendEmailMock.mock.calls[0]![0];
    expect(env.text).toContain(PORTAL_LINK);
    expect(env.html).toContain(`href="${PORTAL_LINK}"`);
    warn.mockRestore();
  });

  it('nothing attached (too large / gone / load failed) → the portal link', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    queuePrepared(['ops@example.com']);
    loadInputMock.mockResolvedValueOnce(null);
    const res = await sendSignedAgreementCopy({ requestId: REQUEST_ID, signedAgreementId: DOC_ID, signerEmail: null });
    expect(res).toMatchObject({ sent: true, attached: false, portalLink: true });
    expect(sendEmailMock.mock.calls[0]![0].text).toContain(PORTAL_LINK);
    err.mockRestore();
  });

  it('a misconfigured portal URL never blocks delivery: sent without the link, logged + captured', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    portalBaseMock.mockImplementationOnce(() => { throw new Error('[portalUrl] Cannot build a customer portal URL'); });
    queuePrepared(['ops@example.com']);
    loadInputMock.mockResolvedValueOnce(null);
    const res = await sendSignedAgreementCopy({ requestId: REQUEST_ID, signedAgreementId: DOC_ID, signerEmail: null });
    expect(res).toMatchObject({ sent: true, attached: false, portalLink: false });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalled();
    err.mockRestore();
  });
});
