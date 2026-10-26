import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { ERROR_CODES } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { db } from '../../db';
import { agreementRequests, contractDocuments } from '../../db/schema/contractDocuments';
import { quotes } from '../../db/schema/quotes';
import { auditPortalSensitiveRead } from '../../services/sensitiveReadAudit';
import { buildSignedAgreementDownload, signedAgreementCopyQuery } from '../../services/signedAgreementDownload';
import { loadTemplateLabels } from './agreements';

/**
 * The customer's signed agreements (#9075 W3a; spec §3.6, §3.8, §5): every
 * `contract_documents` row of the portal user's org — BOTH source kinds, so a
 * proposal-embedded agreement and a standalone request read the same — listed
 * as metadata, and downloaded by DOCUMENT id (not request id) with
 * `?copy=certified|original` (default certified) through the same download
 * builder as the staff route.
 *
 * A new read model beside the document library: services/portal/
 * documentsReadModel.ts reads only `org_documents` and is not widened.
 *
 * TENANCY. Runs inside the portal user's org-scoped request transaction (RLS
 * on contract_documents, agreement_requests and quotes) and filters org_id =
 * the session org. The certificate loader reads under system scope so the
 * bytes do not vary by viewer — it runs only AFTER the org-scoped read found
 * the document. Any miss is the same 404.
 *
 * Disclosure: the list never carries the MSP's evidence trail (signer IP / user
 * agent, on-behalf method + reference, who recorded it) — only the origin, as
 * the portal quote detail does. The certified PDF itself prints the spec §3.8
 * certificate, which is the stated evidence for the signed copy.
 */
export const portalSignedAgreementRoutes = new Hono();

const documentParam = z.object({ documentId: z.string().guid() });

function notFound(c: Context): Response {
  return c.json({ error: 'Signed agreement not found', code: ERROR_CODES.NOT_FOUND }, 404);
}

function portalAuthOf(c: Context): { userId: string; orgId: string; email: string; partnerId: string | null } {
  const auth = c.get('portalAuth') as { user: { id: string; orgId: string; email: string }; partnerId?: string | null };
  return { userId: auth.user.id, orgId: auth.user.orgId, email: auth.user.email, partnerId: auth.partnerId ?? null };
}

// GET /signed-agreements — the org's signed agreements, newest first.
portalSignedAgreementRoutes.get('/signed-agreements', async (c) => {
  const { orgId } = portalAuthOf(c);
  const docs = await db
    .select({
      id: contractDocuments.id,
      sourceKind: contractDocuments.sourceKind,
      templateVersionId: contractDocuments.templateVersionId,
      agreementRequestId: contractDocuments.agreementRequestId,
      quoteId: contractDocuments.quoteId,
      mime: contractDocuments.mime,
      byteSize: contractDocuments.byteSize,
      signerName: contractDocuments.signerName,
      signedAt: contractDocuments.signedAt,
      acceptanceOrigin: contractDocuments.acceptanceOrigin,
      createdAt: contractDocuments.createdAt,
    })
    .from(contractDocuments)
    .where(eq(contractDocuments.orgId, orgId))
    .orderBy(desc(contractDocuments.createdAt))
    .limit(200);

  const requestIds = [...new Set(docs.map((d) => d.agreementRequestId).filter((v): v is string => v !== null))];
  const quoteIds = [...new Set(docs.map((d) => d.quoteId).filter((v): v is string => v !== null))];
  // Sequential: these share the request transaction's one connection.
  const requestRows = requestIds.length
    ? await db.select({ id: agreementRequests.id, label: agreementRequests.label }).from(agreementRequests)
      .where(and(eq(agreementRequests.orgId, orgId), inArray(agreementRequests.id, requestIds)))
    : [];
  const quoteRows = quoteIds.length
    ? await db.select({ id: quotes.id, quoteNumber: quotes.quoteNumber }).from(quotes)
      .where(and(eq(quotes.orgId, orgId), inArray(quotes.id, quoteIds)))
    : [];
  const labels = await loadTemplateLabels(docs.map((d) => d.templateVersionId));
  const requestLabel = new Map(requestRows.map((r) => [r.id, r.label]));
  const quoteNumber = new Map(quoteRows.map((q) => [q.id, q.quoteNumber]));

  const data = docs.map((d) => {
    const template = labels.get(d.templateVersionId);
    const label = d.agreementRequestId ? requestLabel.get(d.agreementRequestId)?.trim() : null;
    return {
      id: d.id,
      name: label || template?.templateName || 'Agreement',
      templateName: template?.templateName ?? null,
      versionNumber: template?.versionNumber ?? null,
      sourceKind: d.sourceKind,
      // The proposal number for a quote-sourced agreement (null once the quote is gone).
      quoteNumber: d.quoteId ? (quoteNumber.get(d.quoteId) ?? null) : null,
      mime: d.mime,
      byteSize: d.byteSize,
      signerName: d.signerName,
      signedAt: d.signedAt ? d.signedAt.toISOString() : null,
      acceptanceOrigin: d.acceptanceOrigin,
      createdAt: d.createdAt.toISOString(),
    };
  });
  return c.json({ data });
});

// GET /signed-agreements/:documentId/file?copy=certified|original — the
// portal access check (org-scoped read) FIRST, the system-scope certificate
// loader second (buildSignedAgreementDownload); always a download.
portalSignedAgreementRoutes.get(
  '/signed-agreements/:documentId/file',
  zValidator('param', documentParam),
  zValidator('query', signedAgreementCopyQuery),
  async (c) => {
    const { userId, orgId, email, partnerId } = portalAuthOf(c);
    const { documentId } = c.req.valid('param');
    const { copy } = c.req.valid('query');
    const [doc] = await db
      .select({ id: contractDocuments.id, orgId: contractDocuments.orgId, mime: contractDocuments.mime, pdfData: contractDocuments.pdfData })
      .from(contractDocuments)
      .where(and(eq(contractDocuments.id, documentId), eq(contractDocuments.orgId, orgId)))
      .limit(1);
    // RLS + the org filter already decide this; the row check makes a policy
    // regression a 404 here too, never another org's contract served.
    if (!doc || doc.orgId !== orgId) return notFound(c);

    const download = await buildSignedAgreementDownload(c, {
      documentId: doc.id, storedBytes: doc.pdfData, storedMime: doc.mime, copy, area: 'portal',
    });
    // Readable a moment ago, gone now: same answer as never there.
    if (!download) return notFound(c);
    auditPortalSensitiveRead(c, { id: userId, email }, {
      action: 'contract.document.download',
      orgId: doc.orgId,
      partnerId,
      resourceType: 'contract_document',
      resourceId: doc.id,
      format: download.served === 'certified' ? 'pdf-certified' : 'original',
      rowCount: 1,
      byteCount: download.byteLength,
      fallback: copy === 'certified' && download.served === 'original',
    });
    return download.response;
  },
);
