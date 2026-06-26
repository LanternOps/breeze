import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { catalogItemImages } from '../db/schema/catalog';
import { sniffImageMime } from './avatarStorage';
import { safeFetch } from './urlSafety';

export { sniffImageMime };
export const MAX_CATALOG_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // reuse the avatar/quote cap

/**
 * Download a product image from a user-supplied URL, SSRF-guarded. The fetch goes
 * through `safeFetch` (never global fetch) so a tenant URL can't reach internal
 * addresses; a 10s timeout bounds the request. Size is checked twice: an early
 * Content-Length reject, then the actual byte count after read. The format is
 * confirmed by magic-byte sniffing (the Content-Type header is untrusted).
 * Throws plain Errors; the route maps them to a generic 4xx.
 */
export async function fetchImageFromUrl(url: string): Promise<{ mime: string; buffer: Buffer }> {
  const res = await safeFetch(url, { timeoutMs: 10_000 });
  if (!res.ok) throw new Error(`Image download failed (HTTP ${res.status})`);

  const declaredLength = Number(res.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CATALOG_IMAGE_SIZE_BYTES) {
    throw new Error('Image too large (max 5 MB)');
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0) throw new Error('Downloaded image is empty');
  if (buffer.length > MAX_CATALOG_IMAGE_SIZE_BYTES) throw new Error('Image too large (max 5 MB)');

  const mime = sniffImageMime(buffer);
  if (!mime) throw new Error('Unsupported image format. Allowed: PNG, JPEG, WebP.');

  return { mime, buffer };
}

/**
 * Persist a catalog item's product image as a bytea blob on `catalog_item_images`,
 * scoped to its partner. One image per item: any existing row is cleared first
 * (upload replaces). The partner-axis RLS on `catalog_item_images` is the access
 * boundary; the caller must be inside a request/system DB access context.
 * Magic-byte sniffing and the size cap are enforced by the route before this.
 */
export async function writeCatalogItemImage(
  catalogItemId: string,
  partnerId: string,
  mime: string,
  buffer: Buffer
): Promise<{ id: string; byteSize: number; sha256: string }> {
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  await db.delete(catalogItemImages).where(eq(catalogItemImages.catalogItemId, catalogItemId));
  const [row] = await db.insert(catalogItemImages).values({
    catalogItemId, partnerId, imageData: buffer, mime, byteSize: buffer.length, sha256,
  }).returning({ id: catalogItemImages.id });
  return { id: row!.id, byteSize: buffer.length, sha256 };
}

/** Read the (single) image for a catalog item. RLS + the route's ownership check
 *  are the access boundary. */
export async function readCatalogItemImage(
  catalogItemId: string
): Promise<{ data: Buffer; mime: string; byteSize: number } | null> {
  const [img] = await db.select({
    data: catalogItemImages.imageData, mime: catalogItemImages.mime, byteSize: catalogItemImages.byteSize,
  }).from(catalogItemImages).where(eq(catalogItemImages.catalogItemId, catalogItemId)).limit(1);
  return img?.data ? { data: img.data, mime: img.mime, byteSize: img.byteSize } : null;
}

export async function deleteCatalogItemImage(catalogItemId: string): Promise<void> {
  await db.delete(catalogItemImages).where(eq(catalogItemImages.catalogItemId, catalogItemId));
}
