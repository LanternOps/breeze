import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, createReadStream } from 'fs';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';
import type { Readable } from 'stream';

/**
 * Avatar storage service.
 *
 * Mirrors the filesystem-backed pattern used by `fileStorage.ts` for remote
 * transfers. One file per user, named `<userId>.<ext>`. New uploads overwrite.
 *
 * Storage path defaults to /data/avatars (Docker named volume api_data is
 * mounted at /data on the api container, same volume used for transfers and
 * patch-reports).
 */

const STORAGE_PATH = process.env.AVATAR_STORAGE_PATH || './data/avatars';

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

function ensureStorageDir(): void {
  if (!existsSync(STORAGE_PATH)) {
    mkdirSync(STORAGE_PATH, { recursive: true });
  }
}

function avatarPath(userId: string, ext: AvatarExt): string {
  return join(STORAGE_PATH, `${userId}.${ext}`);
}

/**
 * Find the on-disk file for a user's avatar, regardless of extension.
 * Returns null if no avatar exists for this user.
 */
export function findAvatar(userId: string): { path: string; ext: AvatarExt; mime: AvatarMime } | null {
  if (!existsSync(STORAGE_PATH)) return null;
  for (const ext of ALL_EXTS) {
    const path = avatarPath(userId, ext);
    if (existsSync(path)) {
      return { path, ext, mime: EXT_TO_MIME[ext] };
    }
  }
  return null;
}

/**
 * Write avatar bytes atomically. Removes any pre-existing avatar for the same
 * user at a different extension.
 */
export async function writeAvatar(userId: string, mime: AvatarMime, data: Buffer): Promise<{ path: string; ext: AvatarExt; size: number }> {
  ensureStorageDir();
  const ext = extForMime(mime);
  const finalPath = avatarPath(userId, ext);
  const tmpPath = `${finalPath}.tmp`;

  await writeFile(tmpPath, data);
  renameSync(tmpPath, finalPath);

  // Clean up any avatar at a different extension so we don't accumulate.
  for (const otherExt of ALL_EXTS) {
    if (otherExt === ext) continue;
    const otherPath = avatarPath(userId, otherExt);
    if (existsSync(otherPath)) {
      try {
        unlinkSync(otherPath);
      } catch {
        // Best-effort cleanup; ignore.
      }
    }
  }

  return { path: finalPath, ext, size: data.length };
}

/**
 * Open a readable stream for the user's avatar file. Returns null if no
 * avatar exists.
 */
export function readAvatarStream(userId: string): { stream: Readable; mime: AvatarMime; size: number; mtimeMs: number } | null {
  const found = findAvatar(userId);
  if (!found) return null;

  let stat;
  try {
    stat = statSync(found.path);
  } catch {
    return null;
  }

  return {
    stream: createReadStream(found.path),
    mime: found.mime,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

/**
 * Get file stat (size + mtimeMs) for a user's avatar without opening it.
 */
export function statAvatar(userId: string): { mime: AvatarMime; size: number; mtimeMs: number } | null {
  const found = findAvatar(userId);
  if (!found) return null;
  try {
    const stat = statSync(found.path);
    return { mime: found.mime, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Compute a weak ETag from size + mtimeMs. Cheap, avoids hashing file bytes
 * on every read. Format follows RFC 7232 weak ETag syntax.
 */
export function weakEtagFor(size: number, mtimeMs: number): string {
  const hash = createHash('sha1');
  hash.update(`${size}:${Math.floor(mtimeMs)}`);
  return `W/"${hash.digest('hex').slice(0, 16)}"`;
}

/**
 * Delete the user's avatar file (any extension). Returns true if a file was
 * removed, false if no avatar existed.
 */
export function deleteAvatar(userId: string): boolean {
  if (!existsSync(STORAGE_PATH)) return false;
  let removed = false;
  for (const ext of ALL_EXTS) {
    const path = avatarPath(userId, ext);
    if (existsSync(path)) {
      try {
        unlinkSync(path);
        removed = true;
      } catch {
        // ignore
      }
    }
  }
  return removed;
}

/**
 * Test-only helper: list all avatar filenames currently on disk.
 */
export function listAvatarsForTest(): string[] {
  if (!existsSync(STORAGE_PATH)) return [];
  return readdirSync(STORAGE_PATH);
}
