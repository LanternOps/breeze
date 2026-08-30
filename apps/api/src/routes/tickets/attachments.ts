import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { TICKET_ATTACHMENT_LIMITS } from '@breeze/shared';
import { PERMISSIONS } from '../../services/permissions';
import { db } from '../../db';
import { ATTACHMENT_META_COLUMNS, ticketAttachments } from '../../db/schema/ticketAttachments';
import { requirePermission, requireScope } from '../../middleware/auth';
import { userRateLimit } from '../../middleware/userRateLimit';
import { createAuditLogAsync } from '../../services/auditService';
import { sniffAttachmentMime } from '../../services/attachmentSniff';
import {
  AttachmentStorageError,
  deleteBytes,
  putBytes,
} from '../../services/ticketAttachmentStorage';
import { getScopedTicketOr404 } from './tickets';
import { captureException } from '../../services/sentry';

/**
 * Ticket comment attachments (W08 #3902).
 *
 * Upload is step 1 of the two-step protocol (spec D2): this route writes a
 * PENDING row (comment_id NULL) and returns its id; POST /tickets/:id/comments
 * then claims those ids inside the comment transaction. Abandoned pending rows
 * are reaped after 24h.
 *
 * No new permission is introduced — every route here reuses
 * PERMISSIONS.TICKETS_{READ,WRITE,MANAGE}. See attachments.permissions.test.ts.
 */
export const ticketAttachmentRoutes = new Hono();

const idParam = z.object({ id: z.string().guid() });

/** JSON error body shape shared by every attachment route. */
function fail(
  c: { json: (b: unknown, s: number) => Response },
  status: 400 | 403 | 404 | 409 | 413 | 415 | 429 | 503,
  code: string,
  message: string,
): Response {
  return c.json({ error: message, code }, status);
}

/**
 * Reduce a client-supplied filename to a safe BASENAME.
 *
 * This value is echoed in the `Content-Disposition` header by the content
 * route, so a quote, backslash, CR or LF here is a header-injection vector —
 * they are removed outright rather than escaped. Path separators are dropped
 * (only the last segment survives) so nothing resembling a traversal is ever
 * persisted. Empty results fall back to a constant.
 */
export function sanitizeAttachmentFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"\\]/g, '').trim();
  return cleaned.slice(0, 255).trim() || 'attachment';
}

/** Collect every File value in a parsed multipart body, under any key. */
function collectFiles(body: Record<string, unknown>): File[] {
  const files: File[] = [];
  for (const value of Object.values(body)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item instanceof File) files.push(item);
    }
  }
  return files;
}

// POST /tickets/:id/attachments — multipart, exactly one file part.
ticketAttachmentRoutes.post(
  '/:id/attachments',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  zValidator('param', idParam),
  userRateLimit('ticket-attachment-upload', 30, 60),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    if (auth.scope === 'organization' && !auth.orgId) {
      return fail(c, 403, 'ORG_CONTEXT_REQUIRED', 'Organization context required');
    }

    // includeDeleted so a soft-deleted ticket answers 409 TICKET_DELETED
    // instead of masquerading as "not found" — the client needs to know the
    // difference to stop retrying an upload it can never complete.
    const ticket = await getScopedTicketOr404(auth, id, { includeDeleted: true });
    if (!ticket) return fail(c, 404, 'TICKET_NOT_FOUND', 'Ticket not found');
    if (ticket.deletedAt) {
      return fail(c, 409, 'TICKET_DELETED', 'Cannot attach files to a deleted ticket');
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = (await c.req.parseBody({ all: true })) as Record<string, unknown>;
    } catch {
      return fail(c, 400, 'INVALID_MULTIPART', 'Expected a multipart body with exactly one file part');
    }
    const files = collectFiles(parsed);
    if (files.length !== 1) {
      return fail(c, 400, 'INVALID_MULTIPART', 'Expected exactly one file part named "file"');
    }
    const file = files[0]!;

    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.length === 0) return fail(c, 400, 'EMPTY_ATTACHMENT', 'Attachment is empty');
    if (buf.length > TICKET_ATTACHMENT_LIMITS.maxBytes) {
      return fail(c, 413, 'ATTACHMENT_TOO_LARGE', 'Attachment too large (max 10 MB)');
    }

    // The client's Content-Type is NEVER consulted (spec D4) — magic bytes only.
    const contentType = sniffAttachmentMime(buf);
    if (!contentType) {
      return fail(
        c, 415, 'UNSUPPORTED_ATTACHMENT_TYPE',
        'Only JPEG, PNG, WebP images and PDFs can be attached',
      );
    }

    // Soft cap, deliberately un-locked: a race can overshoot by a request or
    // two, and the reaper clears the excess. A lock here would serialize every
    // technician's uploads for no tenant-safety gain.
    const pending = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(ticketAttachments)
      .where(and(
        eq(ticketAttachments.uploadedByUserId, auth.user.id),
        isNull(ticketAttachments.commentId),
      ));
    if ((pending[0]?.count ?? 0) >= TICKET_ATTACHMENT_LIMITS.maxPendingPerUser) {
      return fail(
        c, 429, 'TOO_MANY_PENDING',
        'Too many attachments waiting to be posted — send or discard some first',
      );
    }

    const attachmentId = randomUUID();
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const originalFilename = sanitizeAttachmentFilename(file.name ?? '');

    // Put BEFORE insert: a put failure leaves no row at all.
    let stored: Awaited<ReturnType<typeof putBytes>>;
    try {
      stored = await putBytes(attachmentId, buf, contentType, sha256);
    } catch (err) {
      if (err instanceof AttachmentStorageError) {
        captureException(err);
        return fail(c, 503, 'STORAGE_UNAVAILABLE', 'Attachment storage is unavailable — try again shortly');
      }
      throw err;
    }

    let row;
    try {
      const inserted = await db
        .insert(ticketAttachments)
        .values({
          id: attachmentId,
          orgId: ticket.orgId,
          ticketId: ticket.id,
          commentId: null,
          uploadedByUserId: auth.user.id,
          storageBackend: stored.backend,
          storageKey: stored.storageKey,
          data: stored.data,
          contentType,
          byteSize: buf.length,
          originalFilename,
          sha256,
        })
        .returning(ATTACHMENT_META_COLUMNS);
      row = inserted[0]!;
    } catch (err) {
      // Compensating delete. It must NEVER mask the original fault — the
      // deleteBinary docstring in s3Storage states the same contract.
      try {
        await deleteBytes({
          storageBackend: stored.backend,
          storageKey: stored.storageKey,
          data: stored.data,
        });
      } catch (cleanupErr) {
        captureException(cleanupErr);
      }
      throw err;
    }

    // Audit details deliberately omit the filename: it can carry customer PII.
    await createAuditLogAsync({
      orgId: ticket.orgId,
      actorId: auth.user.id,
      action: 'ticket.attachment.upload',
      resourceType: 'ticket',
      resourceId: ticket.id,
      details: { attachmentId, byteSize: buf.length, contentType },
      result: 'success',
    });

    return c.json({ data: { ...row, createdAt: row.createdAt } }, 201);
  },
);
