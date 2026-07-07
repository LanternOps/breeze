import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext } from '../db';
import { quoteImages } from '../db/schema/quotes';
import { sniffImageMime } from './avatarStorage';
import { safeFetch, SsrfBlockedError } from './urlSafety';

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

export type RemoteImageFailureReason = 'unreachable' | 'not_image' | 'too_large' | 'timeout';

/** Typed failure from `fetchRemoteImage`; the images route maps `reason` → HTTP. */
export class RemoteImageError extends Error {
  constructor(public readonly reason: RemoteImageFailureReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RemoteImageError';
  }
}

const REMOTE_IMAGE_TIMEOUT_MS = 8000;

/**
 * Fetch an image from a user-supplied URL and return its bytes for storage — a
 * server-side copy, never a hotlink. SSRF is fully delegated to `safeFetch`
 * (strict mode: private/loopback/link-local/metadata ranges blocked, IP pinned
 * against rebinding, cert validation never disabled, no redirect following). The
 * source's Content-Type is untrusted — only magic-byte sniffing decides the mime.
 *
 * `safeFetch` does network I/O and asserts it runs OUTSIDE a held RLS
 * transaction (#1105), so the fetch is wrapped in `runOutsideDbContext`.
 */
export async function fetchRemoteImage(url: string): Promise<{ mime: string; buffer: Buffer }> {
  let res: Response;
  try {
    res = await runOutsideDbContext(() => safeFetch(url, { timeoutMs: REMOTE_IMAGE_TIMEOUT_MS }));
  } catch (err) {
    // These failures (blocked SSRF target, DNS/host failure, timeout) are almost
    // always caused by the user-supplied URL, so we surface a deliberately generic
    // message (no SSRF-probe fingerprinting) and do NOT alert to Sentry — `cause`
    // still carries the original error for local debugging.
    if (err instanceof SsrfBlockedError) throw new RemoteImageError('unreachable', "Couldn't reach that URL", { cause: err });
    if (err instanceof Error && /timed out/i.test(err.message)) {
      throw new RemoteImageError('timeout', 'The image took too long to download', { cause: err });
    }
    throw new RemoteImageError('unreachable', "Couldn't reach that URL", { cause: err });
  }

  if (!res.ok) throw new RemoteImageError('unreachable', "Couldn't reach that URL", { cause: new Error(`upstream responded ${res.status}`) });

  // Fast-reject on a truthful Content-Length. Note `safeFetch` already buffers the
  // entire response body before returning, so this doesn't bound peak memory — it
  // just skips the extra `Buffer.from(arrayBuffer())` copy for honest servers.
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_QUOTE_IMAGE_SIZE_BYTES) {
    throw new RemoteImageError('too_large', 'Image is larger than 5 MB');
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  // The header can lie (or be absent) — re-check the real length.
  if (buffer.length > MAX_QUOTE_IMAGE_SIZE_BYTES) {
    throw new RemoteImageError('too_large', 'Image is larger than 5 MB');
  }

  const mime = sniffImageMime(buffer);
  if (!mime) throw new RemoteImageError('not_image', "That URL isn't a PNG, JPEG, or WebP image");

  return { mime, buffer };
}
