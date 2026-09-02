import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { TICKET_ATTACHMENT_LIMITS } from '@breeze/shared';
import { PERMISSIONS, hasPermission, type UserPermissions } from '../../services/permissions';
import { db } from '../../db';
import { ATTACHMENT_META_COLUMNS, ticketAttachments } from '../../db/schema/ticketAttachments';
import { ticketComments } from '../../db/schema';
import { requirePermission, requireScope } from '../../middleware/auth';
import { userRateLimit } from '../../middleware/userRateLimit';
import { createAuditLogAsync } from '../../services/auditService';
import { sniffAttachmentMime } from '../../services/attachmentSniff';
import {
  AttachmentStorageError,
  deleteBytes,
  openBytes,
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

const contentParam = z.object({ id: z.string().guid(), attachmentId: z.string().guid() });

function callerCanManageTickets(c: { get: (k: 'permissions') => unknown }): boolean {
  const perms = c.get('permissions') as UserPermissions | undefined;
  return perms
    ? hasPermission(perms, PERMISSIONS.TICKETS_MANAGE.resource, PERMISSIONS.TICKETS_MANAGE.action)
    : false;
}

/**
 * One attachment plus its parent comment's visibility fields. `data` and
 * `storage_key` are selected here BECAUSE this is the byte path — every other
 * read uses ATTACHMENT_META_COLUMNS (spec D10).
 */
async function loadAttachmentRow(ticketId: string, attachmentId: string) {
  const rows = await db
    .select({
      attachment: {
        id: ticketAttachments.id,
        ticketId: ticketAttachments.ticketId,
        commentId: ticketAttachments.commentId,
        uploadedByUserId: ticketAttachments.uploadedByUserId,
        storageBackend: ticketAttachments.storageBackend,
        storageKey: ticketAttachments.storageKey,
        data: ticketAttachments.data,
        contentType: ticketAttachments.contentType,
        byteSize: ticketAttachments.byteSize,
        originalFilename: ticketAttachments.originalFilename,
        sha256: ticketAttachments.sha256,
        createdAt: ticketAttachments.createdAt,
      },
      comment: {
        id: ticketComments.id,
        isPublic: ticketComments.isPublic,
        deletedAt: ticketComments.deletedAt,
        userId: ticketComments.userId,
      },
    })
    .from(ticketAttachments)
    .leftJoin(ticketComments, eq(ticketComments.id, ticketAttachments.commentId))
    .where(and(eq(ticketAttachments.id, attachmentId), eq(ticketAttachments.ticketId, ticketId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Build the D7 `Content-Disposition` value. The filename is re-sanitised on the
 * way OUT as well as on the way in: a quote or CRLF reaching this header is a
 * response-splitting vector, and defence here does not depend on every row
 * having been written by the current upload route.
 */
export function contentDispositionFor(contentType: string, filename: string): string {
  const disposition = contentType.startsWith('image/') ? 'inline' : 'attachment';
  const safe = sanitizeAttachmentFilename(filename);
  // A Node header value must be latin-1 — anything above U+00FF throws
  // ERR_INVALID_CHAR and 500s this route, which would make an ordinary upload
  // called `写真.png` permanently unreadable. So the quoted-string form carries an
  // ASCII-only fallback and the real name rides in the RFC 5987 `filename*`
  // parameter, which every current browser prefers.
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '') || 'attachment';
  // encodeURIComponent leaves !'()* unescaped; they are not RFC 5987
  // attr-chars, so escape them too.
  const encoded = encodeURIComponent(safe).replace(
    /['()!*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// GET /tickets/:id/attachments/:attachmentId/content — authenticated bytes.
// Never a public or presigned URL (spec D7).
ticketAttachmentRoutes.get(
  '/:id/attachments/:attachmentId/content',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action),
  zValidator('param', contentParam),
  async (c) => {
    const auth = c.get('auth');
    const { id, attachmentId } = c.req.valid('param');
    if (auth.scope === 'organization' && !auth.orgId) {
      return fail(c, 403, 'ORG_CONTEXT_REQUIRED', 'Organization context required');
    }
    const canManage = callerCanManageTickets(c);

    // Every rung below returns a BARE 404 so the route never discloses that an
    // attachment exists to someone who may not see it.
    const ticket = await getScopedTicketOr404(auth, id, { includeDeleted: canManage });
    if (!ticket) return fail(c, 404, 'ATTACHMENT_NOT_FOUND', 'Attachment not found');

    const row = await loadAttachmentRow(id, attachmentId);
    if (!row) return fail(c, 404, 'ATTACHMENT_NOT_FOUND', 'Attachment not found');
    const att = row.attachment;

    if (!att.commentId) {
      // Pending upload: visible only to its own uploader.
      if (att.uploadedByUserId !== auth.user.id) {
        return fail(c, 404, 'ATTACHMENT_NOT_FOUND', 'Attachment not found');
      }
    } else if (row.comment?.deletedAt && !canManage) {
      // A soft-deleted comment hides its attachments (rows and objects are
      // kept so a restore is free — spec open question 8).
      return fail(c, 404, 'ATTACHMENT_NOT_FOUND', 'Attachment not found');
    }

    const etag = `"${att.sha256}"`;
    // Short-circuit BEFORE opening the bytes — a 304 that still fetched from
    // the object store is a silent egress bill.
    if (c.req.header('If-None-Match') === etag) {
      return c.body(null, 304, {
        ETag: etag,
        'Cache-Control': 'private, max-age=300',
        'X-Content-Type-Options': 'nosniff',
      });
    }

    let opened: Awaited<ReturnType<typeof openBytes>>;
    try {
      opened = await openBytes(att);
    } catch (err) {
      captureException(err);
      return fail(c, 503, 'STORAGE_UNAVAILABLE', 'Attachment storage is unavailable — try again shortly');
    }
    if (!opened.body) {
      console.error('[ticket-attachments] object missing for row', { attachmentId, backend: att.storageBackend });
      return fail(c, 404, 'ATTACHMENT_NOT_FOUND', 'Attachment not found');
    }

    const headers: Record<string, string> = {
      ETag: etag,
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      // The STORED content type, sniffed at upload — never the client's.
      'Content-Type': att.contentType,
      'Content-Disposition': contentDispositionFor(att.contentType, att.originalFilename),
    };
    const length = opened.contentLength ?? att.byteSize;
    if (typeof length === 'number') headers['Content-Length'] = String(length);

    if (Buffer.isBuffer(opened.body)) {
      return c.body(new Uint8Array(opened.body), 200, headers);
    }
    return c.body(Readable.toWeb(opened.body) as ReadableStream, 200, headers);
  },
);

// DELETE /tickets/:id/attachments/:attachmentId — hard delete, object first.
ticketAttachmentRoutes.delete(
  '/:id/attachments/:attachmentId',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  zValidator('param', contentParam),
  async (c) => {
    const auth = c.get('auth');
    const { id, attachmentId } = c.req.valid('param');
    if (auth.scope === 'organization' && !auth.orgId) {
      return fail(c, 403, 'ORG_CONTEXT_REQUIRED', 'Organization context required');
    }
    const canManage = callerCanManageTickets(c);

    const ticket = await getScopedTicketOr404(auth, id, { includeDeleted: canManage });
    if (!ticket) return fail(c, 404, 'ATTACHMENT_NOT_FOUND', 'Attachment not found');

    const row = await loadAttachmentRow(id, attachmentId);
    if (!row) return fail(c, 404, 'ATTACHMENT_NOT_FOUND', 'Attachment not found');
    const att = row.attachment;

    const isOwn = att.uploadedByUserId === auth.user.id;
    if (!isOwn && !canManage) {
      return fail(c, 403, 'ATTACHMENT_NOT_DELETABLE', "Deleting another user's attachment requires ticket management permission");
    }

    // Object BEFORE row: reversed, a failed object delete would leave bytes in
    // the bucket with no row left to find them by — the same reasoning as the
    // org-erasure ordering in spec D9. A storage fault leaves the row intact
    // and the delete is safely retryable.
    try {
      await deleteBytes(att);
    } catch (err) {
      captureException(err);
      return fail(c, 503, 'STORAGE_UNAVAILABLE', 'Attachment storage is unavailable — try again shortly');
    }
    await db.delete(ticketAttachments).where(eq(ticketAttachments.id, attachmentId));

    await createAuditLogAsync({
      orgId: ticket.orgId,
      actorId: auth.user.id,
      action: 'ticket.attachment.delete',
      resourceType: 'ticket',
      resourceId: ticket.id,
      details: { attachmentId, byteSize: att.byteSize, contentType: att.contentType },
      result: 'success',
    });

    return c.body(null, 204);
  },
);
