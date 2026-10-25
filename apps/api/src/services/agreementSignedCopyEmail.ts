import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  agreementRequestRecipients,
  agreementRequests,
  contractDocuments,
  contractTemplates,
} from '../db/schema/contractDocuments';
import { organizations, partners } from '../db/schema/orgs';
import { BODY_PARA, MUTED_PARA, getEmailService, type EmailTemplate } from './email';
import { escapeHtml, renderLayout } from './emailLayout';
import { sanitizeAttachmentFilename } from './attachmentFilename';
import { captureException } from './sentry';
import { loadCertifiedAgreementInput, renderCertifiedAgreementPdf } from './agreementCertificate';
import { PdfMergeError } from './pdfMerge';

/**
 * "Your signed copy" (#9075 W2b, spec §3.6): after a client signs an agreement
 * request on the public page, the signer (the email they typed — the shared
 * token is the only way to know it) and every request recipient get the signed
 * agreement by email. No portal account is needed and the signing link is
 * already spent, so the attachment IS the delivery.
 *
 * The attachment is the CERTIFIED copy (#9075 W2c, spec §3.8): the frozen
 * agreement plus its signature certificate page, rendered on demand by
 * renderCertifiedAgreementPdf through the ONE seam, loadSignedCopyAttachment.
 * If the certificate cannot be rendered the original frozen bytes go instead —
 * delivery never blocks on the certificate.
 *
 * Built with renderLayout (not partner-editable), like quoteOnBehalfNotify.
 * Post-commit, fire-and-forget: never throws; the outcome is returned for
 * tests and logs. DB reads run in short system contexts that close BEFORE the
 * SMTP call, so no pooled connection is held across the transport.
 */

/** Mail-provider-safe ceiling for the attachment (spec §3.6: ≤ 10 MB). */
export const SIGNED_COPY_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

const EXTENSION_BY_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

export interface SignedCopyAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

/**
 * THE attachment seam: the certified copy of the signed agreement, read under
 * system scope (loadCertifiedAgreementInput). Null when the row is gone.
 *
 * Fallback (spec §3.8): when the certificate cannot be rendered, the ORIGINAL
 * stored bytes are attached under their stored MIME — warned for a
 * PdfMergeError (an unreadable/oversized original), an error for anything else
 * (a bug), captured either way. A load failure still throws to the caller,
 * which sends the mail without an attachment.
 */
export async function loadSignedCopyAttachment(documentId: string): Promise<SignedCopyAttachment | null> {
  const input = await loadCertifiedAgreementInput(documentId);
  if (!input) return null;
  const base = input.agreement.name.trim() || 'Agreement';
  try {
    const pdf = await renderCertifiedAgreementPdf(input);
    return {
      filename: sanitizeAttachmentFilename(`${base} (signed).pdf`),
      content: pdf,
      contentType: 'application/pdf',
    };
  } catch (err) {
    const detail = { documentId, err: err instanceof Error ? err.message : String(err) };
    if (err instanceof PdfMergeError) {
      console.warn('[agreementSignedCopyEmail] certified copy unavailable — attaching the original', detail);
    } else {
      console.error('[agreementSignedCopyEmail] certified copy render failed — attaching the original', detail);
    }
    captureException(err instanceof Error ? err : new Error(String(err)));
    const ext = EXTENSION_BY_MIME[input.document.mime] ?? 'pdf';
    return {
      filename: sanitizeAttachmentFilename(`${base} (signed).${ext}`),
      content: Buffer.from(input.document.pdfData),
      contentType: input.document.mime,
    };
  }
}

export type SignedCopyOutcome =
  | { sent: true; recipients: string[]; attached: boolean }
  | { sent: false; reason: 'not_found' | 'no_recipients' | 'no_email_service' | 'send_failed' };

function normalize(email: string | null | undefined): string | null {
  const e = email?.trim().toLowerCase();
  return e ? e : null;
}

function formatSignedDate(value: Date | null | undefined): string {
  const d = value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date();
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

export async function sendSignedAgreementCopy(input: {
  requestId: string;
  signedAgreementId: string;
  /** The email the signer typed on the public page (null on other paths). */
  signerEmail: string | null;
}): Promise<SignedCopyOutcome> {
  try {
    // Phase 1 — reads, one short system context.
    const prepared = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
      const [req] = await db
        .select({
          orgId: agreementRequests.orgId,
          label: agreementRequests.label,
          templateName: contractTemplates.name,
          partnerId: organizations.partnerId,
          partnerName: partners.name,
          billingEmail: partners.billingEmail,
          emailSignature: partners.emailSignature,
        })
        .from(agreementRequests)
        .innerJoin(organizations, eq(organizations.id, agreementRequests.orgId))
        .innerJoin(partners, eq(partners.id, organizations.partnerId))
        .leftJoin(contractTemplates, eq(contractTemplates.id, agreementRequests.templateId))
        .where(eq(agreementRequests.id, input.requestId))
        .limit(1);
      if (!req) return null;
      const recips = await db
        .select({ email: agreementRequestRecipients.email })
        .from(agreementRequestRecipients)
        .where(eq(agreementRequestRecipients.requestId, input.requestId));
      const [doc] = await db
        .select({ signerName: contractDocuments.signerName, signedAt: contractDocuments.signedAt })
        .from(contractDocuments)
        .where(eq(contractDocuments.id, input.signedAgreementId))
        .limit(1);
      // Signer first, then the request recipients; lowercased + deduped.
      const to = [...new Set([normalize(input.signerEmail), ...recips.map((r) => normalize(r.email))]
        .filter((e): e is string => e !== null))];
      return { req, doc: doc ?? null, to };
    }));
    if (!prepared) {
      // Called right after the accept committed: a missing row is an integrity
      // signal, not a quiet no-op.
      const msg = `[agreementSignedCopyEmail] request ${input.requestId} not found after signing — signed copy not sent`;
      console.error(msg);
      captureException(new Error(msg));
      return { sent: false, reason: 'not_found' };
    }
    const { req, doc, to } = prepared;
    if (to.length === 0) {
      console.warn('[agreementSignedCopyEmail] signed copy skipped', `requestId=${input.requestId}`, 'reason=no_recipients');
      return { sent: false, reason: 'no_recipients' };
    }
    const emailService = getEmailService();
    if (!emailService) {
      console.warn('[agreementSignedCopyEmail] signed copy skipped', `requestId=${input.requestId}`, 'reason=no_email_service');
      return { sent: false, reason: 'no_email_service' };
    }

    // Phase 2 — the attachment. Delivery never blocks on it: a load failure or
    // an oversized file sends the mail without it (and says so).
    let attachment: SignedCopyAttachment | null = null;
    let loadThrew = false;
    try {
      attachment = await loadSignedCopyAttachment(input.signedAgreementId);
    } catch (err) {
      console.error('[agreementSignedCopyEmail] attachment load failed — sending without it', { requestId: input.requestId, err });
      captureException(err instanceof Error ? err : new Error(String(err)));
      loadThrew = true;
    }
    if (attachment === null && !loadThrew) {
      // Not thrown, just gone: the mail still goes,
      // saying the file could not be attached — record why on our side too.
      const msg = `[agreementSignedCopyEmail] signed agreement ${input.signedAgreementId} unavailable for request ${input.requestId} — sending without the attachment`;
      console.error(msg);
      captureException(new Error(msg));
    }
    let tooLarge = false;
    if (attachment && attachment.content.byteLength > SIGNED_COPY_ATTACHMENT_MAX_BYTES) {
      tooLarge = true;
      const warning = `[agreementSignedCopyEmail] signed copy for request ${input.requestId} is ${attachment.content.byteLength} bytes — over the ${SIGNED_COPY_ATTACHMENT_MAX_BYTES}-byte attachment limit; sending without it`;
      console.warn(warning);
      captureException(new Error(warning));
      attachment = null;
    }

    const partnerName = req.partnerName?.trim() || 'your provider';
    const template = buildSignedCopyTemplate({
      partnerName,
      agreementName: req.label?.trim() || req.templateName?.trim() || 'Agreement',
      signerName: doc?.signerName ?? null,
      signedDate: formatSignedDate(doc?.signedAt ?? null),
      attached: attachment !== null,
      tooLarge,
      signature: req.emailSignature,
    });

    // Phase 3 — transport, no DB context held. Same partner-branded billing
    // envelope as the request itself; replies land in the MSP's billing inbox.
    await emailService.sendEmail({
      to,
      purpose: 'agreement.signed_copy',
      partnerId: req.partnerId,
      partnerName: req.partnerName ?? null,
      replyTo: req.billingEmail?.trim() || undefined,
      subject: template.subject,
      html: template.html,
      text: template.text,
      attachments: attachment ? [attachment] : undefined,
    });
    return { sent: true, recipients: to, attached: attachment !== null };
  } catch (err) {
    console.error('[agreementSignedCopyEmail] failed', { requestId: input.requestId }, err instanceof Error ? err.message : err);
    captureException(err instanceof Error ? err : new Error(String(err)));
    return { sent: false, reason: 'send_failed' };
  }
}

export interface SignedCopyEmailParams {
  partnerName: string;
  agreementName: string;
  signerName: string | null;
  /** Pre-formatted signing date. */
  signedDate: string;
  attached: boolean;
  /** The file existed but was over the attachment limit. */
  tooLarge?: boolean;
  signature?: string | null;
}

/** Vocabulary (spec §3.8): "electronically accepted", never "signed by". */
export function buildSignedCopyTemplate(params: SignedCopyEmailParams): EmailTemplate {
  // Header-safe: a staff-authored label must not carry a line break into Subject.
  const subject = `Your signed copy: ${params.agreementName}`.replace(/[\r\n]+/g, ' ');
  const signature = params.signature?.trim() || null;
  const who = params.signerName?.trim() || 'You';
  const acceptedLine = `${who} electronically accepted ${params.agreementName} from ${params.partnerName} on ${params.signedDate}.`;
  const fileLine = params.attached
    ? 'A copy is attached for your records.'
    : params.tooLarge
      ? 'The signed agreement is too large to attach to this email.'
      : 'The signed agreement could not be attached to this email.';
  const contactLine = `Need another copy? Please contact ${params.partnerName}.`;
  const body = `
      <p style="${BODY_PARA}">${escapeHtml(acceptedLine)}</p>
      <p style="${BODY_PARA}">${escapeHtml(fileLine)}</p>
      <p style="${BODY_PARA}">${escapeHtml(contactLine)}</p>
      ${signature ? `<p style="${MUTED_PARA}">${escapeHtml(signature).replace(/\r?\n/g, '<br>')}</p>` : ''}
  `;
  const html = renderLayout({
    title: subject,
    preheader: acceptedLine,
    heading: 'Your signed copy',
    body,
    // Customer-facing: the brand line names their provider, not Breeze.
    brandName: params.partnerName,
  });
  const text = [acceptedLine, fileLine, contactLine, signature].filter(Boolean).join('\n');
  return { subject, html, text };
}
