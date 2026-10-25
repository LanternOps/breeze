import { Hono } from 'hono';
import { z } from 'zod';
import { optionalQueryBoolean } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { requireScope, requirePermission, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import {
  listContractDocuments,
  getContractDocumentPdf,
  linkContractDocument,
  ContractDocumentServiceError,
} from '../../services/contractDocumentService';
import { auditSensitiveRead } from '../../services/sensitiveReadAudit';
import { contentDispositionFor } from '../../services/attachmentFilename';
import { loadCertifiedAgreementInput, renderCertifiedAgreementPdf } from '../../services/agreementCertificate';
import { PdfMergeError } from '../../services/pdfMerge';
import { captureException } from '../../services/sentry';

// Executed contract-document surfaces (Task 18): list per-contract or
// unattached, stream the raw PDF, and link a document to a contract after
// the fact. Mirrors templates.ts's shape (thin routes, service does the
// access/validation work, one shared error mapper).
export const contractDocumentRoutes = new Hono();

const scopes = requireScope('partner', 'organization', 'system');
// Signed agreements gate on agreements:* (W02, spec §4) — see templates.ts.
const readPerm = requirePermission(PERMISSIONS.AGREEMENTS_READ.resource, PERMISSIONS.AGREEMENTS_READ.action);
const writePerm = requirePermission(PERMISSIONS.AGREEMENTS_WRITE.resource, PERMISSIONS.AGREEMENTS_WRITE.action);

const idParam = z.object({ id: z.string().guid() });
// `linked` is the Agreements-area filter (spec §6). It DEFAULTS to 'unlinked' so
// the pre-Agreements caller (which sent `unattached=true`, or nothing) keeps its
// exact behaviour; the Signed agreements page opts into the full inventory by
// sending linked=all. `unattached` is the legacy spelling of linked=unlinked and
// stays accepted until no client sends it.
const listQuery = z.object({
  contractId: z.string().guid().optional(),
  orgId: z.string().guid().optional(),
  unattached: optionalQueryBoolean,
  linked: z.enum(['all', 'linked', 'unlinked']).default('unlinked'),
});
const linkBody = z.object({ contractId: z.string().guid() });
// #9075 W2c (spec §3.8): which copy of a signed agreement to download. The
// certified copy (original + signature certificate page, derived on demand) is
// the default; `original` is the stored bytes, for hash verification.
const pdfQuery = z.object({ copy: z.enum(['certified', 'original']).default('certified') });

function authFrom(c: { get: (k: string) => unknown }): AuthContext {
  return c.get('auth') as AuthContext;
}

/** Mirrors templates.ts's handleTemplateError — the one error class the service throws maps to its own status/code. */
function handleDocumentError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof ContractDocumentServiceError) return c.json({ error: err.message, code: err.code }, err.status);
  throw err;
}

/** File extension for a signed agreement's STORED MIME (spec §3.4): an
 *  externally signed scan is a PNG/JPEG, not a PDF, and must download as one.
 *  freezeSignedAgreement only ever stores these three, so the `.pdf` fallback
 *  is for legacy rows (all PDFs); Content-Type always carries the real MIME. */
const SIGNED_AGREEMENT_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
};

/** The certified copy is always a PDF; the original keeps its stored MIME and
 *  says it is the original, so a fallback download is never mistaken for the
 *  certified one. Mirrored by the web's signedAgreementFilename. */
function signedAgreementFilename(id: string, mime: string, copy: 'certified' | 'original'): string {
  return copy === 'certified'
    ? `signed-agreement-${id}.pdf`
    : `signed-agreement-${id}-original.${SIGNED_AGREEMENT_EXT[mime] ?? 'pdf'}`;
}

/** Strips the binary pdfData column before a full document row goes over
 *  JSON — same reasoning as templates.ts's serializeVersion. Only the PATCH
 *  (link) response returns a full row; GET / already selects a JSON-safe
 *  projection and GET /:id/pdf streams the bytes directly. */
function serializeDocument(doc: { pdfData: Buffer; [k: string]: unknown }) {
  const { pdfData: _pdfData, ...rest } = doc;
  return rest;
}

contractDocumentRoutes.get('/', scopes, readPerm, zValidator('query', listQuery), async (c) => {
  try {
    const { contractId, orgId, unattached, linked } = c.req.valid('query');
    const docs = await listContractDocuments(authFrom(c), { contractId, orgId, unattached, linked });
    return c.json({ data: docs });
  } catch (err) {
    return handleDocumentError(c, err);
  }
});

// GET /:id/pdf — a signed agreement's bytes, always a download, never rendered
// inline in the app origin (acceptanceEvidence.ts precedent).
//   ?copy=certified (default) — the frozen original plus a derived signature
//     certificate page (renderCertifiedAgreementPdf); always a PDF.
//   ?copy=original — the stored bytes byte-for-byte under the stored MIME (a
//     PDF, or an externally signed PNG/JPEG scan), for hash verification.
// Access is decided by getContractDocumentPdf under the caller's RLS context;
// the certificate loader runs only after it succeeded (it reads under system
// scope so the bytes do not vary by viewer — see agreementCertificate.ts).
contractDocumentRoutes.get(
  '/:id/pdf',
  scopes,
  readPerm,
  zValidator('param', idParam),
  zValidator('query', pdfQuery),
  async (c) => {
    try {
      const { id } = c.req.valid('param');
      const { copy } = c.req.valid('query');
      const doc = await getContractDocumentPdf(authFrom(c), id);

      let body: Uint8Array<ArrayBuffer>;
      let mime = doc.mime;
      let served: 'certified' | 'original' = 'original';
      if (copy === 'certified') {
        const input = await loadCertifiedAgreementInput(id);
        if (!input) {
          // Readable a moment ago, gone now: same answer as never there.
          throw new ContractDocumentServiceError('Contract document not found', 404, 'DOCUMENT_NOT_FOUND');
        }
        try {
          body = new Uint8Array(await renderCertifiedAgreementPdf(input));
          mime = 'application/pdf';
          served = 'certified';
        } catch (err) {
          // Only an unreadable/oversized original degrades to the original
          // (spec §3.8 fallback) — named and audited as the original, so the
          // download never pretends to be certified. Anything else (a missing
          // font, a bug) is a loud 500; the Original download still works.
          if (!(err instanceof PdfMergeError)) throw err;
          console.warn('[contractDocuments] certified copy unavailable — serving the original', { id, code: err.code, message: err.message });
          captureException(err);
          body = new Uint8Array(doc.pdfData);
        }
      } else {
        body = new Uint8Array(doc.pdfData);
      }

      const response = new Response(body, {
        status: 200,
        headers: {
          'Content-Type': mime,
          'Content-Length': String(body.byteLength),
          'Content-Disposition': contentDispositionFor(mime, signedAgreementFilename(id, mime, served))
            .replace(/^inline;/, 'attachment;'),
          'X-Agreement-Copy': served,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, max-age=300',
        },
      });
      auditSensitiveRead(c, {
        action: 'contract.document.download',
        orgId: doc.orgId,
        resourceType: 'contract_document',
        resourceId: id,
        format: served === 'certified' ? 'pdf-certified' : 'original',
        rowCount: 1,
        byteCount: body.byteLength,
      });
      return response;
    } catch (err) {
      return handleDocumentError(c, err);
    }
  },
);

// PATCH /:id — link-later: attach an unattached document to a contract.
contractDocumentRoutes.patch(
  '/:id',
  scopes,
  writePerm,
  zValidator('param', idParam),
  zValidator('json', linkBody),
  async (c) => {
    try {
      const { id } = c.req.valid('param');
      const { contractId } = c.req.valid('json');
      const doc = await linkContractDocument(authFrom(c), id, contractId);
      return c.json({ data: serializeDocument(doc) });
    } catch (err) {
      return handleDocumentError(c, err);
    }
  },
);
