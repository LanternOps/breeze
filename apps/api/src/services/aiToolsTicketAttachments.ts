/**
 * `manage_ticket_attachments` (full-control W06, #6776): the AI twin of
 * routes/tickets/attachments.ts — attach-from-artifact, read content, delete —
 * plus a `list` action (no REST twin; mirrors the comment feed's attachment
 * metadata so the model can find ids).
 *
 * What is deliberately different from the route:
 *  - `read_content` is TEXT-SAFE. Only decodable text (`text/*`, JSON, XML,
 *    CSV) is returned, capped at READ_CONTENT_MAX_CHARS and fenced through
 *    `RAW_TEXT_FIELDS_BY_TOOL` (`text`, `originalFilename`). JPEG/PNG/WebP/PDF
 *    uploads and anything not valid UTF-8 return metadata and
 *    `contentReturned: false` — no binary byte ever reaches the model.
 *  - Upload is not exposed (a model cannot hold bytes); `attach_from_artifact`
 *    stages a PENDING row exactly as the route does. `manage_tickets comment`
 *    takes no attachment ids, so a human posts it (W06 plan, follow-up).
 *
 * Classes (aiGuardrails.ts): list tier 1, read_content and attach_from_artifact
 * tier 2, delete supervised (hard delete of object and row). Writes refuse an
 * `ai_agent` principal (uploaded_by_user_id is a users FK).
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { ticketComments } from '../db/schema';
import { ATTACHMENT_META_COLUMNS, ticketAttachments } from '../db/schema/ticketAttachments';
import { isAiAgentPrincipal, type AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { TICKET_ATTACHMENT_ACTIONS } from './aiToolSchemasTicketOps';
import { findTicketWithAccess } from './aiToolsTicketing';
import { pageEnvelope, pageParamSchema, readPageArgs } from './aiToolPagination';
import {
  agentRefusal,
  isAgentPrincipal,
  json,
  jsonError,
  LIST_PAGE,
  serviceErrorJson,
} from './aiToolsTicketOpsShared';
import { getUserPermissions, hasPermission, PERMISSIONS } from './permissions';
import { lockTicketForWrite } from './ticketRowLock';
import { isMergedTombstone, TicketMergedError } from './ticketMerge/errors';
import { AttachmentExpiredError, deleteBytes, openBytes } from './ticketAttachmentStorage';

type AttachmentAction = (typeof TICKET_ATTACHMENT_ACTIONS)[number];
const guid = z.string().guid();

/** Max characters of file text returned by `read_content`. */
export const READ_CONTENT_MAX_CHARS = 20_000;
const READ_CONTENT_MAX_BYTES = READ_CONTENT_MAX_CHARS * 4;

/** Content types decoded as text. Everything else is metadata-only. */
export function isTextSafeContentType(contentType: string): boolean {
  const base = contentType.split(';')[0]!.trim().toLowerCase();
  return base.startsWith('text/')
    || base === 'application/json'
    || base === 'application/xml'
    || base === 'application/x-ndjson'
    || base.endsWith('+json')
    || base.endsWith('+xml');
}

/**
 * Decode at most READ_CONTENT_MAX_CHARS characters of strict UTF-8. Returns null
 * when the bytes are not valid text (invalid UTF-8 or a NUL byte), so a binary
 * payload mislabelled as text is refused rather than lossily decoded.
 */
export function decodeTextSafely(bytes: Buffer): { text: string; truncated: boolean } | null {
  let slice = bytes.subarray(0, READ_CONTENT_MAX_BYTES);
  const byteTruncated = bytes.length > slice.length;
  // A cut inside a multi-byte sequence is the only decode failure a truncation can cause: back off up to 3 bytes.
  for (let trim = 0; trim <= 3 && slice.length - trim >= 0; trim++) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(slice.subarray(0, slice.length - trim));
      if (text.includes('\u0000')) return null;
      const truncated = byteTruncated || text.length > READ_CONTENT_MAX_CHARS;
      return { text: text.length > READ_CONTENT_MAX_CHARS ? text.slice(0, READ_CONTENT_MAX_CHARS) : text, truncated };
    } catch {
      if (!byteTruncated) return null;
    }
  }
  return null;
}

async function readBounded(body: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body.subarray(0, READ_CONTENT_MAX_BYTES + 1);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    chunks.push(buf);
    size += buf.length;
    if (size > READ_CONTENT_MAX_BYTES) break;
  }
  const maybeDestroy = body as { destroy?: () => void };
  if (size > READ_CONTENT_MAX_BYTES) maybeDestroy.destroy?.();
  return Buffer.concat(chunks).subarray(0, READ_CONTENT_MAX_BYTES + 1);
}

async function callerCanManageTickets(auth: AuthContext): Promise<boolean> {
  const perms = await getUserPermissions(auth.user.id, {
    partnerId: auth.partnerId ?? undefined,
    orgId: auth.orgId ?? undefined,
    scope: auth.scope,
  });
  return perms ? hasPermission(perms, PERMISSIONS.TICKETS_MANAGE.resource, PERMISSIONS.TICKETS_MANAGE.action) : false;
}

/** One attachment (id, ticket) plus its parent comment's visibility fields — the byte-path read. */
async function loadAttachmentRow(ticketId: string, attachmentId: string) {
  const rows = await db
    .select({
      attachment: {
        id: ticketAttachments.id,
        orgId: ticketAttachments.orgId,
        ticketId: ticketAttachments.ticketId,
        commentId: ticketAttachments.commentId,
        uploadedByUserId: ticketAttachments.uploadedByUserId,
        storageBackend: ticketAttachments.storageBackend,
        storageKey: ticketAttachments.storageKey,
        data: ticketAttachments.data,
        artifactId: ticketAttachments.artifactId,
        contentType: ticketAttachments.contentType,
        byteSize: ticketAttachments.byteSize,
        originalFilename: ticketAttachments.originalFilename,
        sha256: ticketAttachments.sha256,
      },
      comment: { id: ticketComments.id, deletedAt: ticketComments.deletedAt },
    })
    .from(ticketAttachments)
    .leftJoin(ticketComments, eq(ticketComments.id, ticketAttachments.commentId))
    .where(and(eq(ticketAttachments.id, attachmentId), eq(ticketAttachments.ticketId, ticketId)))
    .limit(1);
  return rows[0] ?? null;
}

export function registerTicketAttachmentTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('manage_ticket_attachments', {
    tier: 1,
    domain: 'tickets',
    searchHint: 'ticket attachments: list files on a ticket, read text content, attach a run artifact, delete an attachment',
    deviceArgs: [],
    definition: {
      name: 'manage_ticket_attachments',
      description:
        'Ticket attachments. Actions: list,read_content (text only, images and PDFs give metadata),attach_from_artifact (staged for a person to post),delete (needs approval, permanent).',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...TICKET_ATTACHMENT_ACTIONS], description: 'The action to perform' },
          ticketId: { type: 'string', description: 'Ticket UUID (required for every action)' },
          attachmentId: { type: 'string', description: 'Attachment UUID from list (read_content/delete)' },
          artifactId: { type: 'string', description: 'attach_from_artifact: artifact handle UUID of a run artifact in the ticket organization' },
          ...pageParamSchema(50, 200),
        },
        required: ['action', 'ticketId'],
        additionalProperties: false,
      },
    },

    handler: async (input, auth) => {
      const action = input.action as AttachmentAction;
      if (!TICKET_ATTACHMENT_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      if (auth.scope === 'organization' && !auth.orgId) return jsonError('Organization context required', 'ACCESS_DENIED');
      if (action !== 'list' && action !== 'read_content' && isAgentPrincipal(auth)) return agentRefusal(action);

      const ticketId = guid.safeParse(input.ticketId);
      if (!ticketId.success) return jsonError('ticketId must be a ticket UUID', 'VALIDATION_ERROR');
      const ticket = await findTicketWithAccess(ticketId.data, auth, { includeDeleted: true });
      if (!ticket) return jsonError('Ticket not found', 'TICKET_NOT_FOUND');

      try {
        if (action === 'list') {
          // The feed hides a soft-deleted ticket (GET /tickets/:id has no includeDeleted).
          if (ticket.deletedAt) return jsonError('Ticket not found', 'TICKET_NOT_FOUND');
          const page = readPageArgs('manage_ticket_attachments', input, LIST_PAGE);
          if (!page.ok) return jsonError(page.error, page.code);
          const rows = await db
            .select({ ...ATTACHMENT_META_COLUMNS, uploadedByUserId: ticketAttachments.uploadedByUserId, commentDeletedAt: ticketComments.deletedAt })
            .from(ticketAttachments)
            .leftJoin(ticketComments, eq(ticketComments.id, ticketAttachments.commentId))
            .where(eq(ticketAttachments.ticketId, ticket.id));
          // The feed's visibility: posted attachments of live comments; a pending row only to its uploader.
          const visible = rows
            .filter((r) => (r.commentId ? !r.commentDeletedAt : r.uploadedByUserId === auth.user.id))
            .map(({ uploadedByUserId: _u, commentDeletedAt: _d, ...meta }) => ({ ...meta, pending: !meta.commentId }));
          const items = visible.slice(page.offset, page.offset + page.limit + 1);
          return json(pageEnvelope({ key: 'attachments', items, limit: page.limit, offset: page.offset, fingerprint: page.fingerprint, total: visible.length }));
        }

        if (action === 'attach_from_artifact') {
          // uploaded_by_user_id is a users FK; a tier-2 agent intent has no approver to substitute (#6206).
          if (isAiAgentPrincipal(auth)) return agentRefusal(action);
          const handle = guid.safeParse(input.artifactId);
          if (!handle.success) return jsonError('artifactId must be an artifact handle UUID', 'VALIDATION_ERROR');
          if (ticket.deletedAt) return jsonError('Cannot attach files to a deleted ticket', 'TICKET_DELETED');
          // Lazy, as in the route: artifactService reads aiRunArtifacts off the schema barrel.
          const { findArtifactForAuth } = await import('./artifacts/artifactService');
          const artifact = await findArtifactForAuth(handle.data, auth);
          // The artifact must belong to the TICKET's org, never the caller's: a partner token reaches many orgs.
          if (!artifact || artifact.orgId !== ticket.orgId) {
            return jsonError('No such artifact is available to this organization', 'ARTIFACT_NOT_FOUND');
          }
          const locked = await lockTicketForWrite(db, ticket.id);
          if (!locked || locked.orgId !== ticket.orgId) return jsonError('Ticket not found', 'TICKET_NOT_FOUND');
          if (locked.deletedAt) return jsonError('Cannot attach files to a deleted ticket', 'TICKET_DELETED');
          if (isMergedTombstone(locked)) return json(new TicketMergedError(locked.id, locked.mergedIntoTicketId!).toBody());
          const [row] = await db
            .insert(ticketAttachments)
            .values({
              id: randomUUID(),
              orgId: ticket.orgId,
              ticketId: ticket.id,
              commentId: null,
              uploadedByUserId: auth.user.id,
              storageBackend: 'artifact',
              storageKey: null,
              data: null,
              artifactId: artifact.id,
              contentType: artifact.contentType,
              byteSize: artifact.bytes,
              originalFilename: artifact.name,
              sha256: artifact.sha256,
            })
            .returning(ATTACHMENT_META_COLUMNS);
          return json({ attachment: { ...row, pending: true } });
        }

        // read_content / delete address one attachment.
        const attachmentId = guid.safeParse(input.attachmentId);
        if (!attachmentId.success) return jsonError('attachmentId must be an attachment UUID from list', 'VALIDATION_ERROR');
        const canManage = await callerCanManageTickets(auth);
        // A soft-deleted ticket is reachable only by a ticket manager (route: includeDeleted: canManage).
        if (ticket.deletedAt && !canManage) return jsonError('Attachment not found', 'ATTACHMENT_NOT_FOUND');
        const row = await loadAttachmentRow(ticket.id, attachmentId.data);
        if (!row) return jsonError('Attachment not found', 'ATTACHMENT_NOT_FOUND');
        const att = row.attachment;

        if (action === 'read_content') {
          // Every rung is the same bare not-found, so existence never leaks.
          if (!att.commentId) {
            if (att.uploadedByUserId !== auth.user.id) return jsonError('Attachment not found', 'ATTACHMENT_NOT_FOUND');
          } else if (row.comment?.deletedAt && !canManage) {
            return jsonError('Attachment not found', 'ATTACHMENT_NOT_FOUND');
          }
          const meta = { id: att.id, contentType: att.contentType, byteSize: att.byteSize, originalFilename: att.originalFilename };
          if (!isTextSafeContentType(att.contentType)) {
            return json({ attachment: meta, contentReturned: false, reason: 'Only text files are returned; this is binary content (image, PDF or other).' });
          }
          let opened: Awaited<ReturnType<typeof openBytes>>;
          try {
            opened = await openBytes(att, { orgId: att.orgId });
          } catch (err) {
            if (err instanceof AttachmentExpiredError) return jsonError(err.message, 'ATTACHMENT_EXPIRED');
            return jsonError('Attachment storage is unavailable — try again shortly', 'STORAGE_UNAVAILABLE');
          }
          if (!opened.body) return jsonError('Attachment not found', 'ATTACHMENT_NOT_FOUND');
          const decoded = decodeTextSafely(await readBounded(opened.body));
          if (!decoded) {
            return json({ attachment: meta, contentReturned: false, reason: 'The content is not valid UTF-8 text, so it is not returned.' });
          }
          return json({ attachment: meta, contentReturned: true, truncated: decoded.truncated, text: decoded.text });
        }

        // delete — owner, or a ticket manager (route: ATTACHMENT_NOT_DELETABLE otherwise).
        if (att.uploadedByUserId !== auth.user.id && !canManage) {
          return jsonError("Deleting another user's attachment requires ticket management permission", 'ATTACHMENT_NOT_DELETABLE');
        }
        if (ticket.mergedIntoTicketId) return json(new TicketMergedError(ticket.id, ticket.mergedIntoTicketId).toBody());
        // Object BEFORE row (a failed object delete leaves the row, so the delete is retryable).
        try {
          await deleteBytes(att);
        } catch {
          return jsonError('Attachment storage is unavailable — try again shortly', 'STORAGE_UNAVAILABLE');
        }
        await lockTicketForWrite(db, ticket.id);
        await db.delete(ticketAttachments).where(eq(ticketAttachments.id, att.id));
        return json({ deleted: true, attachmentId: att.id });
      } catch (err) {
        const mapped = serviceErrorJson(err);
        if (mapped) return mapped;
        throw err;
      }
    },
  });
}
