import { createHash, randomUUID } from 'node:crypto';
import { TICKET_ATTACHMENT_LIMITS } from '@breeze/shared';
import { getFileAttachmentBytes, listMessageAttachments, type GraphAttachmentMeta } from './graphMailClient';
import { getMailboxToken } from './mailboxToken';
import { deleteBytes, putBytes } from '../ticketAttachmentStorage';
import { sniffAttachmentMime } from '../attachmentSniff';
import { sanitizeAttachmentFilename } from '../attachmentFilename';
import { captureException } from '../sentry';
import type { InboundEmailAttachment, NormalizedInboundEmail } from '../inboundEmail/types';

/**
 * M365 ticket-mailbox attachments (#6688).
 *
 * WHERE this runs matters. The poll worker only puts metadata on the queue
 * (attachment bytes do not belong in Redis), and `processInboundEmail` runs
 * inside one system DB transaction — Graph or S3 I/O in there would hold a
 * connection idle-in-transaction for as long as Microsoft takes to answer
 * (the #6348 wedge shape). So the inbound worker calls this BEFORE it opens
 * the transaction: bytes are fetched and put into attachment storage here,
 * and the transaction only inserts `ticket_attachments` rows. Anything stored
 * here whose row never lands is deleted by `discardUnpersistedAttachments`.
 *
 * Limits are the ticket-attachment upload route's (routes/tickets/attachments.ts):
 * `TICKET_ATTACHMENT_LIMITS.maxBytes` per file (also the table's size CHECK),
 * the magic-byte type allowlist (`sniffAttachmentMime` — the sender's declared
 * type is never trusted), and at most `maxPerComment` files per email, which
 * also bounds how many bytes one job holds in memory. Everything that does not
 * make it is kept as metadata with a `skipReason`, so the ticket can say so.
 */

const FILE_ATTACHMENT = '#microsoft.graph.fileAttachment';

/**
 * Graph's `size` is the attachment's size in the message store, a little more
 * than the file itself. The pre-download check only refuses what is clearly
 * over the cap; the decoded byte length is the authoritative check.
 */
const GRAPH_SIZE_SLACK_BYTES = 256 * 1024;

export interface PrepareAttachmentsContext {
  tenantId: string;
  /**
   * True on the job's last BullMQ attempt. Earlier attempts THROW on a Graph
   * failure so the job retries; the last one degrades to a `fetch_failed` note
   * rather than losing the whole email over its attachments.
   */
  finalAttempt: boolean;
}

function metaOnly(a: GraphAttachmentMeta, skipReason: InboundEmailAttachment['skipReason']): InboundEmailAttachment {
  return {
    filename: sanitizeAttachmentFilename(a.name ?? ''),
    contentType: a.contentType ?? 'application/octet-stream',
    size: typeof a.size === 'number' ? a.size : 0,
    skipReason,
  };
}

/**
 * Populate `email.attachments` for an M365 message whose Graph `hasAttachments`
 * is set. No-op for any other email. Must run OUTSIDE any DB context.
 */
export async function prepareM365Attachments(
  email: NormalizedInboundEmail,
  ctx: PrepareAttachmentsContext,
): Promise<void> {
  if (email.provider !== 'm365' || !email.hasAttachments) return;

  const out: InboundEmailAttachment[] = [];
  try {
    const token = await getMailboxToken(ctx.tenantId);
    const listed = await listMessageAttachments(token, email.to, email.providerMessageId);
    let storedCount = 0;

    for (const a of listed) {
      const isFile = a['@odata.type'] === FILE_ATTACHMENT;
      // Inline parts (signature logos, pasted screenshots) belong to the body
      // rendering, not the ticket — dropped without a note, as a mail client does.
      if (isFile && a.isInline === true) continue;
      // itemAttachment (a forwarded Outlook item) / referenceAttachment (a cloud
      // link) have no file bytes we can store.
      if (!isFile) { out.push(metaOnly(a, 'unsupported_type')); continue; }
      if (typeof a.size === 'number' && a.size > TICKET_ATTACHMENT_LIMITS.maxBytes + GRAPH_SIZE_SLACK_BYTES) {
        out.push(metaOnly(a, 'too_large'));
        continue;
      }
      if (storedCount >= TICKET_ATTACHMENT_LIMITS.maxPerComment) { out.push(metaOnly(a, 'too_many')); continue; }

      let buf: Buffer;
      try {
        buf = await getFileAttachmentBytes(token, email.to, email.providerMessageId, a.id);
      } catch (err) {
        if (!ctx.finalAttempt) throw err;
        out.push(metaOnly(a, 'fetch_failed'));
        continue;
      }
      if (buf.length > TICKET_ATTACHMENT_LIMITS.maxBytes) { out.push(metaOnly(a, 'too_large')); continue; }
      const contentType = buf.length > 0 ? sniffAttachmentMime(buf) : null;
      if (!contentType) { out.push(metaOnly(a, 'unsupported_type')); continue; }

      const attachmentId = randomUUID();
      const sha256 = createHash('sha256').update(buf).digest('hex');
      let stored: Awaited<ReturnType<typeof putBytes>>;
      try {
        stored = await putBytes(attachmentId, buf, contentType, sha256);
      } catch (err) {
        captureException(err instanceof Error ? err : new Error(String(err)));
        out.push(metaOnly(a, 'storage_failed'));
        continue;
      }
      out.push({
        filename: sanitizeAttachmentFilename(a.name ?? ''),
        contentType,
        size: buf.length,
        stored: {
          attachmentId,
          contentType,
          byteSize: buf.length,
          sha256,
          storageBackend: stored.backend === 's3' ? 's3' : 'db',
          storageKey: stored.storageKey,
          data: stored.data,
        },
      });
      storedCount++;
    }
  } catch (err) {
    // Blobs already put for this attempt would otherwise be orphaned.
    await discardUnpersisted(out);
    if (!ctx.finalAttempt) throw err;
    console.warn('[inboundEmail] M365 attachments could not be retrieved on the final attempt', {
      providerMessageId: email.providerMessageId,
      err: err instanceof Error ? err.message : err,
    });
    captureException(err instanceof Error ? err : new Error(String(err)));
    email.attachments = [{ filename: '', contentType: '', size: 0, skipReason: 'fetch_failed' }];
    return;
  }
  email.attachments = out;
}

async function discardUnpersisted(attachments: InboundEmailAttachment[]): Promise<void> {
  for (const a of attachments) {
    if (!a.stored || a.persisted) continue;
    try {
      await deleteBytes({
        storageBackend: a.stored.storageBackend,
        storageKey: a.stored.storageKey,
        data: a.stored.data,
      });
    } catch (err) {
      // Never mask the caller's outcome over cleanup; the object is only an
      // unreferenced blob, never customer-visible.
      captureException(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

/**
 * Delete storage for every attachment prepared above whose `ticket_attachments`
 * row was never inserted — the email was a duplicate, quarantined, dropped, or
 * its transaction failed. Never throws.
 */
export async function discardUnpersistedAttachments(email: NormalizedInboundEmail): Promise<void> {
  await discardUnpersisted(email.attachments);
}
