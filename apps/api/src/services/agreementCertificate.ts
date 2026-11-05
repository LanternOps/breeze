// Signature certificate — the "certified copy" of a signed agreement (#9075
// W2c, spec §3.8 / OD10).
//
// DERIVED, NEVER STORED. contract_documents.pdf_data stays the exact frozen
// bytes, so `sha256` and `content_sha256` keep verifying; the certified copy is
// produced on demand: the original normalised to PDF pages (a PNG/JPEG
// externally-signed scan becomes one image per page) plus ONE certificate page
// appended through mergeUploadedContractPdfs (MAX_MERGED_PAGES, PdfMergeError).
//
// DETERMINISTIC. The renderer is a pure function of CertifiedAgreementInput:
// CreationDate/ModDate are pinned to signed_at (created_at on a legacy row with
// no evidence), Producer/Creator are constants, the signing time is rendered in
// UTC with the STORED acceptance locale, and there is no "generated at" line —
// the same document always yields the same bytes, whatever the wall clock or
// the viewer. The loader reads under system scope for that reason: an RLS-
// scoped read would hide the recorder's name or the partner page size from an
// organization-scope viewer and change the bytes per viewer. It is NOT an
// authorization step — callers check access first (route: getContractDocumentPdf
// under the caller's RLS; email: the signer just accepted this request).
//
// WORDING (vocabulary spec §8): "electronically accepted", never "signed by",
// and no drawn or handwritten-looking mark. Only a customer acceptance (the
// client typed their name into Breeze) gets the italic typed-signature face,
// printed again beneath it in plain text. A staff-recorded acceptance or an
// uploaded copy says "as recorded" and never claims an electronic acceptance:
// the page attests what was recorded (and, for an upload, the upload).

import PDFKitDocument from 'pdfkit';
import { PDFDocument, PageSizes } from 'pdf-lib';
import { eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import {
  agreementRequests,
  contractDocuments,
  contractTemplates,
  contractTemplateVersions,
} from '../db/schema/contractDocuments';
import { quoteAcceptances, quotes } from '../db/schema/quotes';
import { users } from '../db/schema/users';
import { organizations, partners } from '../db/schema/orgs';
import { computeAgreementSha256 } from './agreementContentHash';
import { registerThemeFonts, resolvePageSize, type DocumentPageSize } from './documentThemes';
import { MAX_MERGED_PAGES, PdfMergeError, mergeUploadedContractPdfs } from './pdfMerge';
import { certificateVersionFromColumn, type CertificateVersion } from './agreementCertificateVersion';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** `signing_link` = the public token link, however it reached the client
 *  (emailed by Breeze, or copied and shared by the technician — #10513). */
export type CertificateCustomerChannel = 'signing_link' | 'portal' | 'unknown';

/** How the acceptance happened — classified from stored columns by the loader. */
export type CertificateHow =
  | { kind: 'customer'; channel: CertificateCustomerChannel; method: string | null }
  | { kind: 'on_behalf'; recordedByName: string | null; method: string | null; reference: string | null }
  | { kind: 'external_upload'; recordedByName: string | null; method: string | null; reference: string | null }
  /** Legacy quote-sourced row whose acceptance was deleted before the back-fill. */
  | { kind: 'unavailable' };

export interface CertifiedAgreementDocument {
  id: string;
  /** The stored bytes. Read only — never modified or written back. */
  pdfData: Buffer;
  mime: string;
  sha256: string;
  createdAt: Date;
  signerName: string | null;
  signerEmail: string | null;
  signedAt: Date | null;
  signerIp: string | null;
  signerUserAgent: string | null;
  contentSha256: string | null;
  contentHashVersion: number | null;
  acceptanceRenderLocale: string | null;
}

export interface CertifiedAgreementInput {
  document: CertifiedAgreementDocument;
  /** `name` = the template name as it was at signing (never the staff-internal
   *  request label, never a later rename, #10294). */
  agreement: { name: string; templateName: string; versionNumber: number | null };
  parties: { seller: string | null; client: string | null };
  source: { kind: 'quote'; quoteNumber: string | null } | { kind: 'request'; requestId: string | null };
  how: CertificateHow;
  /** Page size for an image original (a PDF original keeps its own page size). */
  pageSize: DocumentPageSize;
  /** The wording version stamped at signing (agreementCertificateVersion.ts). */
  certificateVersion: CertificateVersion;
}

// ---------------------------------------------------------------------------
// Content model (what the page prints) — pure, tested directly
// ---------------------------------------------------------------------------

export interface CertificateRow {
  label: string;
  value: string;
  /** signature = the typed name in the body-italic face; mono = a hash. */
  style?: 'signature' | 'mono' | 'note';
}

export interface CertificateSection {
  heading: string;
  rows: CertificateRow[];
}

export interface CertificateContent {
  title: string;
  subtitle: string;
  sections: CertificateSection[];
  footer: string;
}

const METHOD_LABELS: Record<string, string> = {
  'typed-signature': 'typed signature',
  verbal: 'verbal',
  email: 'email',
  signed_document: 'signed document',
  purchase_order: 'purchase order',
  other: 'other',
};

const UNKNOWN_RECORDER = 'a staff member (account no longer available)';
const NOT_RECORDED = 'Not recorded';

/** Caps keep the certificate on ONE page whatever the evidence holds. */
const MAX_NAME = 200;
const MAX_REFERENCE = 300;
const MAX_USER_AGENT = 160;

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function methodLabel(method: string | null): string {
  if (!method) return 'not recorded';
  return METHOD_LABELS[method] ?? method;
}

/** Intl output with the narrow/no-break spaces newer ICU emits normalised to a
 *  plain space (the vendored DM Sans has no glyph for U+202F). */
function plain(s: string): string {
  return s.replace(/[  ]/g, ' ');
}

function resolveLocale(raw: string | null): string {
  const candidate = raw?.trim() || 'en';
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([candidate]).length > 0 ? candidate : 'en';
  } catch (err) {
    if (err instanceof RangeError) return 'en'; // malformed language tag
    throw err;
  }
}

function longDate(at: Date, locale: string): string {
  return plain(new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(at));
}

function longDateTime(at: Date, locale: string): string {
  return `${plain(new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }).format(at))} UTC`;
}

/** The token-link wording, frozen per certificate version (#10513). v1 MUST
 *  keep printing "emailed link": it is what every pre-v2 certificate says. */
const SIGNING_LINK_VIA: Record<CertificateVersion, string> = {
  1: 'Electronically accepted via emailed link',
  2: 'Electronically accepted via signing link',
};

function howLines(
  how: Exclude<CertificateHow, { kind: 'unavailable' }>,
  createdAt: Date,
  locale: string,
  version: CertificateVersion,
): string[] {
  switch (how.kind) {
    case 'customer': {
      const via = how.channel === 'signing_link' ? SIGNING_LINK_VIA[version]
        : how.channel === 'portal' ? 'Electronically accepted via portal'
          : 'Electronically accepted online';
      // Only the built-in typed-signature provider is a typed name + checkbox;
      // a future provider must not inherit that claim.
      return [how.method === 'typed-signature'
        ? `${via}: typed full legal name + consent checkbox`
        : `${via} — method ${methodLabel(how.method)}`];
    }
    case 'on_behalf':
      return [`Recorded by ${clip(how.recordedByName ?? UNKNOWN_RECORDER, MAX_NAME)} on behalf of the client — method ${methodLabel(how.method)}, reference ${clip(how.reference ?? 'not recorded', MAX_REFERENCE)}`];
    case 'external_upload':
      return [
        // The upload date is when the copy reached Breeze (created_at), not the
        // signing date the tech typed.
        `Signed outside Breeze; copy uploaded by ${clip(how.recordedByName ?? UNKNOWN_RECORDER, MAX_NAME)} on ${longDate(createdAt, locale)}`,
        'This certificate attests the upload, not the signature on it.',
        `Method ${methodLabel(how.method)}, reference ${clip(how.reference ?? 'not recorded', MAX_REFERENCE)}`,
      ];
  }
}

export function buildCertificateContent(input: CertifiedAgreementInput): CertificateContent {
  const { document: doc, agreement, parties, source, how } = input;
  const locale = resolveLocale(doc.acceptanceRenderLocale);
  const version = agreement.versionNumber != null ? ` v${agreement.versionNumber}` : '';
  const sections: CertificateSection[] = [];

  sections.push({
    heading: 'Agreement',
    rows: [
      { label: 'Agreement', value: clip(agreement.name, MAX_NAME) },
      { label: 'Template', value: `${clip(agreement.templateName, MAX_NAME)}${version}` },
      { label: 'Document ID', value: doc.id },
    ],
  });
  sections.push({
    heading: 'Parties',
    rows: [
      { label: 'Provider', value: clip(parties.seller ?? NOT_RECORDED, MAX_NAME) },
      { label: 'Client', value: clip(parties.client ?? NOT_RECORDED, MAX_NAME) },
    ],
  });

  if (how.kind === 'unavailable' || !doc.signedAt) {
    const via = source.kind === 'quote' ? 'quote' : 'agreement request';
    sections.push({
      heading: 'Acceptance',
      rows: [{
        label: 'Record',
        value: `Acceptance record unavailable — this agreement was accepted on ${longDate(doc.createdAt, locale)} via ${via}, but the acceptance evidence was deleted before Breeze retained it.`,
        style: 'note',
      }],
    });
  } else {
    const signer = clip(doc.signerName ?? NOT_RECORDED, MAX_NAME);
    const email = { label: 'Email', value: doc.signerEmail ?? 'Not provided' };
    if (how.kind === 'customer') {
      // The client typed this name into Breeze themselves: the typed
      // signature in the italic face, then printed plainly.
      sections.push({
        heading: 'Electronically accepted by',
        rows: [
          { label: 'Accepted by', value: signer, style: 'signature' },
          { label: 'Printed name', value: signer },
          email,
        ],
      });
    } else {
      // Staff typed the name and date (record-signed / accept-on-behalf): no
      // signature face and no claim of an electronic acceptance — the page
      // attests what was recorded, and for an upload, the upload.
      sections.push({
        heading: how.kind === 'external_upload' ? 'Signed outside Breeze' : 'Acceptance recorded by staff',
        rows: [
          { label: how.kind === 'external_upload' ? 'Signer (as recorded)' : 'Client signer (as recorded)', value: signer },
          email,
        ],
      });
    }
    const recorded = how.kind !== 'customer';
    sections.push({
      heading: 'When and where',
      rows: [
        {
          label: how.kind === 'customer' ? 'Accepted at (UTC)'
            : how.kind === 'external_upload' ? 'Signed at, as recorded (UTC)' : 'Accepted at, as recorded (UTC)',
          value: doc.signedAt.toISOString(),
        },
        { label: 'Local rendering', value: longDateTime(doc.signedAt, locale) },
        ...(how.kind === 'external_upload' ? [{ label: 'Uploaded at (UTC)', value: doc.createdAt.toISOString() }] : []),
        // On an MSP-recorded row the network evidence is the recorder's.
        { label: recorded ? 'Recorded from IP' : 'Signer IP', value: doc.signerIp ?? NOT_RECORDED },
        { label: recorded ? 'Recorded with' : 'User agent', value: clip(doc.signerUserAgent ?? NOT_RECORDED, MAX_USER_AGENT) },
      ],
    });
    sections.push({
      heading: 'How',
      rows: howLines(how, doc.createdAt, locale, input.certificateVersion).map((value, i) => ({ label: i === 0 ? 'How' : '', value })),
    });
  }

  sections.push({
    heading: 'Source',
    rows: [{
      label: 'Source',
      value: source.kind === 'quote'
        ? (source.quoteNumber ? `Quote ${source.quoteNumber}` : 'Quote (no longer available)')
        : (source.requestId ? `Agreement request ${source.requestId}` : 'Agreement request (no longer available)'),
    }],
  });
  sections.push({
    heading: 'Integrity',
    rows: [
      { label: 'Original file SHA-256', value: doc.sha256, style: 'mono' },
      {
        label: doc.contentHashVersion != null ? `Content hash (v${doc.contentHashVersion})` : 'Content hash',
        value: doc.contentSha256 ?? NOT_RECORDED,
        style: 'mono',
      },
      { label: '', value: 'Verify: the SHA-256 of the original file downloaded from Breeze matches the value above.', style: 'note' },
    ],
  });

  return {
    title: 'Signature certificate',
    subtitle: parties.seller ? `Acceptance record · ${clip(parties.seller, MAX_NAME)}` : 'Acceptance record',
    sections,
    footer: 'This page records how acceptance of the agreement above was captured in Breeze. It is not a handwritten or cryptographic signature, and it is not part of the original file.',
  };
}

/** Every string the certificate prints, in order (tests + diagnostics). */
export function certificateText(content: CertificateContent): string[] {
  return [
    content.title,
    content.subtitle,
    ...content.sections.flatMap((s) => [s.heading, ...s.rows.flatMap((r) => (r.label ? [r.label, r.value] : [r.value]))]),
    content.footer,
  ];
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

const INK = '#111827';
const MUTED = '#6b7280';
const RULE = '#e5e7eb';

/** The certificate keeps the original's page size when it is an ordinary
 *  portrait document page (Letter, A4, Legal); anything else (a tiny,
 *  landscape or poster page) gets the partner's page size so the one page
 *  always fits. */
function certificatePageSize(last: { width: number; height: number } | null, fallback: DocumentPageSize): [number, number] {
  if (last && last.width >= 500 && last.width <= 650 && last.height >= 700 && last.height <= 1010) {
    return [last.width, last.height];
  }
  return fallback === 'letter' ? [PageSizes.Letter[0], PageSizes.Letter[1]] : [PageSizes.A4[0], PageSizes.A4[1]];
}

function toMergeError(err: unknown, what: string): PdfMergeError {
  if (err instanceof PdfMergeError) return err;
  return new PdfMergeError(`${what}: ${err instanceof Error ? err.message : String(err)}`);
}

/** The original as PDF bytes plus its last page's size. PNG/JPEG → one image
 *  per page, scaled to fit the partner page size. */
async function normalizeOriginal(input: CertifiedAgreementInput): Promise<{ pdf: Buffer; last: { width: number; height: number } | null }> {
  const { pdfData, mime } = input.document;
  if (mime === 'image/png' || mime === 'image/jpeg') {
    try {
      const out = await PDFDocument.create({ updateMetadata: false });
      const image = mime === 'image/png' ? await out.embedPng(pdfData) : await out.embedJpg(pdfData);
      const [pw, ph] = input.pageSize === 'letter' ? PageSizes.Letter : PageSizes.A4;
      const page = out.addPage([pw, ph]);
      const margin = 36;
      const scale = Math.min((pw - 2 * margin) / image.width, (ph - 2 * margin) / image.height);
      const w = image.width * scale;
      const h = image.height * scale;
      page.drawImage(image, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
      return { pdf: Buffer.from(await out.save()), last: { width: pw, height: ph } };
    } catch (err) {
      throw toMergeError(err, 'The signed agreement image could not be read');
    }
  }
  try {
    const original = await PDFDocument.load(pdfData, { updateMetadata: false });
    const count = original.getPageCount();
    if (count + 1 > MAX_MERGED_PAGES) {
      throw new PdfMergeError(
        `Certified copy would exceed the ${MAX_MERGED_PAGES}-page limit (${count + 1} pages)`,
        422,
        'CONTRACT_PDF_PAGE_LIMIT_EXCEEDED',
      );
    }
    const last = count > 0 ? original.getPage(count - 1).getSize() : null;
    return { pdf: pdfData, last };
  } catch (err) {
    throw toMergeError(err, 'The signed agreement PDF could not be read');
  }
}

/** One pdfkit page. Every value goes through `text` exactly as the content
 *  model holds it; boxes are height-capped with an ellipsis, so the page never
 *  flows onto a second one. */
function drawCertificatePage(content: CertificateContent, size: [number, number], pinned: Date): Promise<Buffer> {
  const doc = new PDFKitDocument({
    size,
    margin: 54,
    info: { CreationDate: pinned, ModDate: pinned, Producer: 'Breeze', Creator: 'Breeze', Title: content.title },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (d: Buffer) => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const fonts = registerThemeFonts(doc, 'condensed');
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const labelWidth = 128;
  const valueX = left + labelWidth + 12;
  const valueWidth = width - labelWidth - 12;
  const bottom = doc.page.height - doc.page.margins.bottom - 40; // footer band

  doc.font(fonts.heading.bold).fontSize(22).fillColor(INK).text(content.title, left, doc.page.margins.top, { width, lineBreak: false });
  doc.font(fonts.body.regular).fontSize(10).fillColor(MUTED)
    .text(content.subtitle, left, doc.y + 4, { width, height: 14, ellipsis: true });
  let y = doc.y + 10;
  doc.moveTo(left, y).lineTo(left + width, y).lineWidth(1).strokeColor(RULE).stroke();
  y += 14;

  for (const section of content.sections) {
    if (y > bottom - 30) break; // never reached with the caps above; a page-flow guard
    doc.font(fonts.heading.bold).fontSize(11).fillColor(INK).text(section.heading, left, y, { width, height: 14, lineBreak: false });
    y += 18;
    for (const row of section.rows) {
      const font = row.style === 'signature' ? fonts.body.italic : row.style === 'mono' ? 'Courier' : fonts.body.regular;
      const fontSize = row.style === 'signature' ? 16 : row.style === 'mono' ? 8.5 : 9.5;
      const maxLines = row.style === 'note' ? 4 : 3;
      doc.font(font).fontSize(fontSize);
      const lineHeight = doc.currentLineHeight(true);
      const valueHeight = Math.min(doc.heightOfString(row.value, { width: valueWidth }), lineHeight * maxLines);
      if (y + valueHeight > bottom) break;
      if (row.label) {
        doc.font(fonts.body.bold).fontSize(8.5).fillColor(MUTED)
          .text(row.label, left, y + (row.style === 'signature' ? 4 : 0), { width: labelWidth, height: 12, ellipsis: true, lineBreak: false });
      }
      doc.font(font).fontSize(fontSize).fillColor(row.style === 'note' ? MUTED : INK)
        .text(row.value, valueX, y, { width: valueWidth, height: lineHeight * maxLines, ellipsis: true });
      y += Math.max(valueHeight, 12) + 5;
    }
    y += 8;
  }

  doc.font(fonts.body.regular).fontSize(8).fillColor(MUTED)
    .text(content.footer, left, doc.page.height - doc.page.margins.bottom - 28, { width, height: 30, ellipsis: true });
  doc.end();
  return done;
}

/**
 * The certified copy: original pages + one certificate page, deterministic.
 * Throws PdfMergeError when the original cannot be read or the result would
 * exceed MAX_MERGED_PAGES — callers fall back to the original bytes.
 */
export async function renderCertifiedAgreementPdf(input: CertifiedAgreementInput): Promise<Buffer> {
  const pinned = input.document.signedAt ?? input.document.createdAt;
  const { pdf, last } = await normalizeOriginal(input);
  const certificate = await drawCertificatePage(
    buildCertificateContent(input),
    certificatePageSize(last, input.pageSize),
    pinned,
  );
  try {
    return await mergeUploadedContractPdfs(pdf, [{ afterMarker: 'signature-certificate', data: certificate }], { pinDates: pinned });
  } catch (err) {
    // The original already loaded and passed the page cap in normalizeOriginal,
    // so a failure HERE is our certificate page or a pdf-lib regression — a
    // bug, never a "bad original". It must take the loud path (route 500,
    // email error log), not the quiet PdfMergeError → original fallback.
    throw new Error(
      `Signature certificate could not be assembled: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

function snapshotName(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const name = (snapshot as { name?: unknown }).name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

function nonBlank(value: string | null | undefined): string | null {
  return value?.trim() ? value.trim() : null;
}

/**
 * Everything the certificate prints, for one signed agreement, in ONE
 * system-scope read (see the file header — viewer-independent bytes; not an
 * access check). Null when the document does not exist.
 */
export async function loadCertifiedAgreementInput(documentId: string): Promise<CertifiedAgreementInput | null> {
  const [row] = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db
      .select({
        id: contractDocuments.id,
        pdfData: contractDocuments.pdfData,
        mime: contractDocuments.mime,
        sha256: contractDocuments.sha256,
        createdAt: contractDocuments.createdAt,
        sourceKind: contractDocuments.sourceKind,
        agreementRequestId: contractDocuments.agreementRequestId,
        quoteId: contractDocuments.quoteId,
        signerName: contractDocuments.signerName,
        signerEmail: contractDocuments.signerEmail,
        signedAt: contractDocuments.signedAt,
        signerIp: contractDocuments.signerIp,
        signerUserAgent: contractDocuments.signerUserAgent,
        acceptanceOrigin: contractDocuments.acceptanceOrigin,
        acceptanceMethod: contractDocuments.acceptanceMethod,
        acceptanceReference: contractDocuments.acceptanceReference,
        certificateVersion: contractDocuments.certificateVersion,
        contentSha256: contractDocuments.contentSha256,
        contentHashVersion: contractDocuments.contentHashVersion,
        acceptanceRenderLocale: contractDocuments.acceptanceRenderLocale,
        templateNameSnapshot: contractDocuments.templateNameSnapshot,
        templateName: contractTemplates.name,
        versionNumber: contractTemplateVersions.versionNumber,
        versionSha256: contractTemplateVersions.sha256,
        requestSeller: agreementRequests.sellerSnapshot,
        requestClient: agreementRequests.clientNameSnapshot,
        requestPublicResponseJti: agreementRequests.publicResponseJti,
        quoteNumber: quotes.quoteNumber,
        quoteSeller: quotes.sellerSnapshot,
        quoteBillTo: quotes.billToName,
        quoteAcceptanceTokenJti: quoteAcceptances.acceptanceTokenJti,
        quoteAcceptanceExists: sql<boolean>`${quoteAcceptances.id} IS NOT NULL`,
        recorderName: users.name,
        orgName: organizations.name,
        partnerName: partners.name,
        partnerPageSize: partners.documentPageSize,
      })
      .from(contractDocuments)
      .leftJoin(contractTemplates, eq(contractTemplates.id, contractDocuments.templateId))
      .leftJoin(contractTemplateVersions, eq(contractTemplateVersions.id, contractDocuments.templateVersionId))
      .leftJoin(agreementRequests, eq(agreementRequests.id, contractDocuments.agreementRequestId))
      .leftJoin(quotes, eq(quotes.id, contractDocuments.quoteId))
      .leftJoin(quoteAcceptances, eq(quoteAcceptances.id, contractDocuments.quoteAcceptanceId))
      .leftJoin(users, eq(users.id, contractDocuments.recordedByUserId))
      .leftJoin(organizations, eq(organizations.id, contractDocuments.orgId))
      .leftJoin(partners, eq(partners.id, organizations.partnerId))
      .where(eq(contractDocuments.id, documentId))
      .limit(1)));
  if (!row) return null;

  const isRequest = row.sourceKind === 'request';
  let how: CertificateHow;
  if (!row.signedAt) {
    how = { kind: 'unavailable' };
  } else if (row.mime.startsWith('image/') || isExternalUpload(row)) {
    how = { kind: 'external_upload', recordedByName: row.recorderName ?? null, method: row.acceptanceMethod, reference: row.acceptanceReference };
  } else if (row.acceptanceOrigin === 'on_behalf') {
    how = { kind: 'on_behalf', recordedByName: row.recorderName ?? null, method: row.acceptanceMethod, reference: row.acceptanceReference };
  } else {
    // A public-link accept consumes the link's jti; a logged-in portal accept
    // has none. A quote acceptance deleted before the back-fill leaves no way
    // to tell, so the certificate says "online". The jti says the token link
    // was used, not how it was delivered (emailed or copied, #10513).
    const channel: CertificateCustomerChannel = isRequest
      ? (row.requestPublicResponseJti ? 'signing_link' : 'portal')
      : (row.quoteAcceptanceExists ? (row.quoteAcceptanceTokenJti ? 'signing_link' : 'portal') : 'unknown');
    how = { kind: 'customer', channel, method: row.acceptanceMethod };
  }

  // Party names from the send-/accept-time snapshot; only when the source row
  // is gone do the live org/partner names stand in (never a blank party).
  const seller = isRequest ? snapshotName(row.requestSeller) : snapshotName(row.quoteSeller);
  const client = isRequest ? nonBlank(row.requestClient) : nonBlank(row.quoteBillTo);
  // The name frozen at signing (#10294): a later template rename must not
  // change signed evidence. The live name stands in only for a row written
  // without the snapshot (an instance on older code during a rolling deploy).
  const templateName = nonBlank(row.templateNameSnapshot) ?? nonBlank(row.templateName) ?? 'Agreement';

  return {
    document: {
      id: row.id,
      pdfData: row.pdfData,
      mime: row.mime,
      sha256: row.sha256,
      createdAt: row.createdAt,
      signerName: row.signerName,
      signerEmail: row.signerEmail,
      signedAt: row.signedAt,
      signerIp: row.signerIp,
      signerUserAgent: row.signerUserAgent,
      contentSha256: row.contentSha256,
      contentHashVersion: row.contentHashVersion,
      acceptanceRenderLocale: row.acceptanceRenderLocale,
    },
    // Named by the template (as it was at signing), never the staff-internal
    // request label: the certificate and its attachment filename reach the
    // customer (#10294).
    agreement: { name: templateName, templateName, versionNumber: row.versionNumber ?? null },
    parties: { seller: seller ?? nonBlank(row.partnerName), client: client ?? nonBlank(row.orgName) },
    source: isRequest ? { kind: 'request', requestId: row.agreementRequestId } : { kind: 'quote', quoteNumber: row.quoteNumber ?? null },
    how,
    pageSize: resolvePageSize(row.partnerPageSize),
    certificateVersion: certificateVersionFromColumn(row.certificateVersion),
  };
}

/** A record-signed upload binds its bytes in the external branch of the
 *  agreement content hash (agreementRequestService.prepareRequestFreeze), so a
 *  stored hash that re-derives from (version sha, bytes sha, mime) IS an
 *  upload — no extra column needed. */
function isExternalUpload(row: {
  sourceKind: string; acceptanceOrigin: string | null; contentHashVersion: number | null;
  contentSha256: string | null; versionSha256: string | null; sha256: string; mime: string;
}): boolean {
  if (row.sourceKind !== 'request' || row.acceptanceOrigin !== 'on_behalf') return false;
  if (row.contentHashVersion !== 1 || !row.contentSha256) return false;
  return row.contentSha256 === computeAgreementSha256({
    kind: 'external',
    versionSha: row.versionSha256 ?? '',
    bytesSha256: row.sha256,
    mime: row.mime,
  });
}
