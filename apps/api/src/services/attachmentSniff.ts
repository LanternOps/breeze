import type { TicketAttachmentMime } from '@breeze/shared';
import { sniffImageMime } from './avatarStorage';

const PDF_MAGIC = Buffer.from('%PDF-');

/**
 * Magic-byte sniff for ticket attachments (W08 #3902, spec D4). The client
 * Content-Type is NEVER consulted. Images reuse the avatar sniffer
 * (PNG/JPEG/WebP); PDF is the 5-byte `%PDF-` header AT OFFSET 0. HEIC, SVG,
 * HTML and everything else -> null (415 UNSUPPORTED_ATTACHMENT_TYPE at the
 * route).
 */
export function sniffAttachmentMime(buf: Buffer): TicketAttachmentMime | null {
  if (buf.length >= PDF_MAGIC.length && buf.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    return 'application/pdf';
  }
  return sniffImageMime(buf);
}
