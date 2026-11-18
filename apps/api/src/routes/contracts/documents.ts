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
import { buildSignedAgreementDownload, signedAgreementCopyQuery } from '../../services/signedAgreementDownload';

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

function authFrom(c: { get: (k: string) => unknown }): AuthContext {
  return c.get('auth') as AuthContext;
}

/** Mirrors templates.ts's handleTemplateError — the one error class the service throws maps to its own status/code. */
function handleDocumentError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof ContractDocumentServiceError) return c.json({ error: err.message, code: err.code }, err.status);
  throw err;
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
// the shared download builder (services/signedAgreementDownload.ts — also the
// portal's) runs only after it succeeded.
contractDocumentRoutes.get(
  '/:id/pdf',
  scopes,
  readPerm,
  zValidator('param', idParam),
  zValidator('query', signedAgreementCopyQuery),
  async (c) => {
    try {
      const { id } = c.req.valid('param');
      const { copy } = c.req.valid('query');
      const doc = await getContractDocumentPdf(authFrom(c), id);

      const download = await buildSignedAgreementDownload(c, {
        documentId: id, storedBytes: doc.pdfData, storedMime: doc.mime, copy, area: 'staff',
      });
      if (!download) {
        // Readable a moment ago, gone now: same answer as never there.
        throw new ContractDocumentServiceError('Contract document not found', 404, 'DOCUMENT_NOT_FOUND');
      }
      auditSensitiveRead(c, {
        action: 'contract.document.download',
        orgId: doc.orgId,
        resourceType: 'contract_document',
        resourceId: id,
        format: download.served === 'certified' ? 'pdf-certified' : 'original',
        rowCount: 1,
        byteCount: download.byteLength,
      });
      return download.response;
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
