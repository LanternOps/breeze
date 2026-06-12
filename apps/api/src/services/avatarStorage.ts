import { createHash } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import { captureException } from './sentry';

/**
 * Avatar storage service (database-backed).
 *
 * Avatars live as a `bytea` blob on the user's row (`users.avatar_data`),
 * alongside `avatar_mime` and `avatar_updated_at`. This replaced the previous
 * filesystem implementation (`/data/avatars/<id>.<ext>`), which depended on a
 * writable `api_data` volume owned by the API's runtime uid — a root-owned
 * volume failed uploads with EACCES → 500 (#1059). Storing the bytes in
 * Postgres removes the volume dependency and works across replicas.
 *
 * The `users` table's row-level security is the access boundary: a user can
 * read/write their own row, and cross-user reads (GET /users/:id/avatar) are
 * gated both by the route's explicit `getScopedUser` check and by the same
 * RLS. Callers must be inside a request/system DB access context — outside one
 * RLS fails closed and these functions return null/false ("no avatar"), not an
 * error.
 */

export const MAX_AVATAR_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

export type AvatarMime = 'image/png' | 'image/jpeg' | 'image/webp';

const MIME_TO_EXT: Record<AvatarMime, 'png' | 'jpg' | 'webp'> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

const ALL_EXTS = ['png', 'jpg', 'webp'] as const;
type AvatarExt = (typeof ALL_EXTS)[number];

const EXT_TO_MIME: Record<AvatarExt, AvatarMime> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
};

export function extForMime(mime: AvatarMime): AvatarExt {
  return MIME_TO_EXT[mime];
}

export function mimeForExt(ext: string): AvatarMime | null {
  if (ext in EXT_TO_MIME) {
    return EXT_TO_MIME[ext as AvatarExt];
  }
  return null;
}

/** Narrow an arbitrary DB-stored mime string back to a known AvatarMime. */
function asAvatarMime(mime: string | null): AvatarMime | null {
  if (mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/webp') {
    return mime;
  }
  return null;
}

/**
 * Bytes exist but avatar_mime doesn't narrow — impossible via writeAvatar
 * (which sets both atomically), so it means corruption or a bad backfill.
 * Loudly flag it; the caller still degrades to "no avatar".
 */
function reportInvalidMime(userId: string, mime: string | null): null {
  const err = new Error(
    `[avatarStorage] avatar bytes present but avatar_mime invalid (user ${userId}, mime ${JSON.stringify(mime)})`
  );
  console.error(err.message);
  captureException(err);
  return null;
}

/**
 * Sniff the leading bytes of `buf` and return the matching MIME if it's one of
 * the allowed image formats, or `null` otherwise. Does NOT trust the
 * Content-Type header; the magic bytes are the source of truth.
 */
export function sniffImageMime(buf: Buffer): AvatarMime | null {
  if (buf.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }

  // WebP: "RIFF" .... "WEBP"
  if (
    buf[0] === 0x52 && // R
    buf[1] === 0x49 && // I
    buf[2] === 0x46 && // F
    buf[3] === 0x46 && // F
    buf[8] === 0x57 && // W
    buf[9] === 0x45 && // E
    buf[10] === 0x42 && // B
    buf[11] === 0x50 // P
  ) {
    return 'image/webp';
  }

  return null;
}

function avatarUrlFor(userId: string): string {
  return `/api/v1/users/${userId}/avatar`;
}

export interface WriteAvatarResult {
  ext: AvatarExt;
  size: number;
  avatarUrl: string;
  updatedAt: Date;
}

/**
 * Persist the avatar bytes + metadata on the user's row, atomically, and point
 * `avatar_url` at the serving endpoint. Returns null if the user row does not
 * exist (or is not visible to the caller under RLS).
 */
export async function writeAvatar(
  userId: string,
  mime: AvatarMime,
  data: Buffer
): Promise<WriteAvatarResult | null> {
  const now = new Date();
  const avatarUrl = avatarUrlFor(userId);

  const [updated] = await db
    .update(users)
    .set({
      avatarData: data,
      avatarMime: mime,
      avatarUpdatedAt: now,
      avatarUrl,
      updatedAt: now,
    })
    .where(eq(users.id, userId))
    .returning({ id: users.id, updatedAt: users.updatedAt });

  if (!updated) return null;

  return { ext: extForMime(mime), size: data.length, avatarUrl, updatedAt: updated.updatedAt };
}

export interface AvatarStat {
  mime: AvatarMime;
  size: number;
  mtimeMs: number;
}

/**
 * Lightweight metadata (mime, byte length, mtime) for a user's avatar without
 * pulling the bytes — `octet_length` computes the size in Postgres, so the
 * conditional-GET 304 fast path never transfers the blob. Returns null if no
 * avatar is stored. (`mtimeMs` is `avatar_updated_at` in epoch ms; the name is
 * kept from the filesystem era for ETag-contract compatibility.)
 */
export async function statAvatar(userId: string): Promise<AvatarStat | null> {
  const [row] = await db
    .select({
      mime: users.avatarMime,
      size: sql<number | null>`octet_length(${users.avatarData})`,
      updatedAt: users.avatarUpdatedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!row || row.size === null) return null;
  const mime = asAvatarMime(row.mime);
  if (!mime) return reportInvalidMime(userId, row.mime);

  return {
    mime,
    // postgres.js may hand integers back as strings depending on parser config.
    size: Number(row.size),
    mtimeMs: row.updatedAt ? row.updatedAt.getTime() : 0,
  };
}

export interface AvatarBuffer {
  buffer: Buffer;
  mime: AvatarMime;
  size: number;
  mtimeMs: number;
}

/**
 * Read a user's avatar fully into a Buffer. Avatars are capped at
 * MAX_AVATAR_SIZE_BYTES on write, so buffering is bounded and lets the caller
 * send an exact Content-Length. Returns null if no avatar is stored.
 */
export async function readAvatarBuffer(userId: string): Promise<AvatarBuffer | null> {
  const [row] = await db
    .select({
      data: users.avatarData,
      mime: users.avatarMime,
      updatedAt: users.avatarUpdatedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!row || !row.data) return null;
  const mime = asAvatarMime(row.mime);
  if (!mime) return reportInvalidMime(userId, row.mime);

  return {
    buffer: row.data,
    mime,
    size: row.data.length,
    mtimeMs: row.updatedAt ? row.updatedAt.getTime() : 0,
  };
}

/**
 * Clear the user's avatar (bytes, mime, timestamp, and serving URL) in one
 * UPDATE. Returns true if the user row was updated, false if no such row
 * exists (or it's invisible under RLS). Unlike the filesystem version, this
 * does NOT report whether an avatar previously existed — clearing is
 * idempotent and callers only need to know the write landed.
 */
export async function deleteAvatar(userId: string): Promise<boolean> {
  const [updated] = await db
    .update(users)
    .set({
      avatarData: null,
      avatarMime: null,
      avatarUpdatedAt: null,
      avatarUrl: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning({ id: users.id });

  return Boolean(updated);
}

/**
 * Compute a weak ETag from size + mtimeMs. Cheap, avoids hashing the bytes on
 * every read. Format follows RFC 7232 weak ETag syntax.
 */
export function weakEtagFor(size: number, mtimeMs: number): string {
  const hash = createHash('sha1');
  hash.update(`${size}:${Math.floor(mtimeMs)}`);
  return `W/"${hash.digest('hex').slice(0, 16)}"`;
}
