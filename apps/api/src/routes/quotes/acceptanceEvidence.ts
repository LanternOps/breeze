import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { requireScope, requirePermission, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { getQuote } from '../../services/quoteService';
import { writeRouteAudit } from '../../services/auditEvents';
import { contentDispositionFor } from '../../services/attachmentFilename';
import {
  AcceptanceEvidenceError,
  QUOTE_ACCEPTANCE_EVIDENCE_MAX_BYTES,
  attachAcceptanceEvidence,
  openAcceptanceEvidence,
} from '../../services/quoteAcceptanceEvidence';
import { acceptanceEvidenceAttachedAuditEvent } from '../../services/quoteAcceptanceEvidenceAudit';
import { quoteActorFrom, handleServiceError } from './quotes';

/**
 * Evidence file on an accept-on-behalf acceptance (#6633). Admin-only: mounted
 * under /api/v1/quotes behind authMiddleware + partner/system scope, and never
 * on the portal or public token routers.
 *
 * Both routes run the org-scoped getQuote FIRST, so a quote outside the
 * caller's orgs is a 404 before any storage is touched.
 */
export const quoteAcceptanceEvidenceRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.QUOTES_READ.resource, PERMISSIONS.QUOTES_READ.action);
// The money-committing permission that recorded the acceptance also governs its
// evidence: adding to the dispute record is part of the same act.
const acceptPerm = requirePermission(PERMISSIONS.QUOTES_ACCEPT.resource, PERMISSIONS.QUOTES_ACCEPT.action);
const idParam = z.object({ id: z.string().guid() });

function handleEvidenceError(c: Context, err: unknown): Response {
  if (err instanceof AcceptanceEvidenceError) return c.json({ error: err.message, code: err.code }, err.status);
  return handleServiceError(c, err);
}

// POST /:id/acceptance/evidence — multipart, exactly one `file` part. Replaces
// any previous evidence file on the quote's latest (on-behalf) acceptance.
quoteAcceptanceEvidenceRoutes.post('/:id/acceptance/evidence',
  scopes, acceptPerm, zValidator('param', idParam),
  // Multipart overhead headroom; the exact 10 MB cap is enforced on the bytes.
  bodyLimit({
    maxSize: QUOTE_ACCEPTANCE_EVIDENCE_MAX_BYTES + 64 * 1024,
    onError: (c) => c.json({ error: 'Evidence file too large (max 10 MB)', code: 'FILE_TOO_LARGE' }, 413),
  }),
  async (c) => {
    const id = c.req.valid('param').id;
    const auth = c.get('auth') as AuthContext;
    try {
      const { quote } = await getQuote(id, quoteActorFrom(c)); // org-access 404

      let body: Record<string, unknown>;
      try { body = await c.req.parseBody({ all: true }); } catch {
        return c.json({ error: 'Invalid multipart body', code: 'INVALID_MULTIPART' }, 400);
      }
      const file = body.file;
      if (!(file instanceof File)) {
        return c.json({ error: 'Expected a multipart body with one file part named "file"', code: 'INVALID_MULTIPART' }, 400);
      }

      const res = await attachAcceptanceEvidence({
        quoteId: id,
        orgId: quote.orgId,
        actorUserId: auth.user?.id ?? null,
        file: { buffer: Buffer.from(await file.arrayBuffer()), filename: file.name ?? '' },
      });

      writeRouteAudit(c, acceptanceEvidenceAttachedAuditEvent({
        quoteId: id,
        orgId: quote.orgId,
        acceptanceId: res.acceptanceId,
        filename: res.evidence.filename,
        contentType: res.evidence.contentType,
        sizeBytes: res.evidence.sizeBytes,
        sha256: res.sha256,
        replaced: res.replaced,
      }));

      return c.json({ data: { acceptanceId: res.acceptanceId, evidence: res.evidence } });
    } catch (err) { return handleEvidenceError(c, err); }
  });

// GET /:id/acceptance/evidence — the file itself, always as a download.
quoteAcceptanceEvidenceRoutes.get('/:id/acceptance/evidence',
  scopes, readPerm, zValidator('param', idParam),
  async (c) => {
    const id = c.req.valid('param').id;
    try {
      const { quote } = await getQuote(id, quoteActorFrom(c)); // org-access 404
      const opened = await openAcceptanceEvidence({ quoteId: id, orgId: quote.orgId });
      const disposition = contentDispositionFor(opened.meta.contentType, opened.meta.filename)
        // Evidence is always downloaded, never rendered inline in the app origin.
        .replace(/^inline;/, 'attachment;');
      const headers: Record<string, string> = {
        // The STORED type, sniffed at upload — never the client's.
        'Content-Type': opened.meta.contentType,
        'Content-Disposition': disposition,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      };
      const length = opened.contentLength ?? opened.meta.sizeBytes;
      if (typeof length === 'number') headers['Content-Length'] = String(length);
      if (Buffer.isBuffer(opened.body)) return c.body(new Uint8Array(opened.body), 200, headers);
      return c.body(Readable.toWeb(opened.body) as ReadableStream, 200, headers);
    } catch (err) { return handleEvidenceError(c, err); }
  });
