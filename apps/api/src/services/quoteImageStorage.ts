import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { quoteImages } from '../db/schema/quotes';
import { sniffImageMime } from './avatarStorage';

export { sniffImageMime };
export const MAX_QUOTE_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // reuse the avatar cap

/**
 * Persist a proposal image as a bytea blob on `quote_images`, scoped to its
 * quote + org. The org-axis RLS on `quote_images` is the access boundary; the
 * caller must be inside a request/system DB access context. Magic-byte sniffing
 * and the size cap are enforced by the route before this is reached.
 */
export async function writeQuoteImage(quoteId: string, orgId: string, mime: string, buffer: Buffer): Promise<{ id: string; byteSize: number; sha256: string }> {
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const [row] = await db.insert(quoteImages).values({
    quoteId, orgId, imageData: buffer, mime, byteSize: buffer.length, sha256,
  }).returning({ id: quoteImages.id });
  return { id: row!.id, byteSize: buffer.length, sha256 };
}

/** Read constrained to BOTH the image id AND its quote (closes same-org cross-quote embed). */
export async function readQuoteImage(imageId: string, quoteId: string): Promise<{ data: Buffer; mime: string; byteSize: number } | null> {
  const [img] = await db.select({ data: quoteImages.imageData, mime: quoteImages.mime, byteSize: quoteImages.byteSize })
    .from(quoteImages).where(and(eq(quoteImages.id, imageId), eq(quoteImages.quoteId, quoteId))).limit(1);
  return img?.data ? { data: img.data, mime: img.mime, byteSize: img.byteSize } : null;
}
