/**
 * A private on-disk copy of a snapshot manifest while it is hydrated (#11026,
 * D6). The bytes are hashed as they arrive, so nothing is parsed or written to
 * the database until they are known to be the attested ones, and nothing holds
 * them in memory.
 *
 * The spool never goes under os.tmpdir() when it can be avoided: the shipped
 * compose files mount /tmp as a 64 MB tmpfs on the api and worker containers,
 * where a manifest of about 130k entries would already fail with ENOSPC. Same
 * rule and same location convention as recoveryWorkDir.ts and devPush.ts: a
 * sibling of the durable data directory, derived from PATCH_REPORT_STORAGE_PATH.
 */
import { createHash } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Transform, type Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DEFAULT_PATCH_REPORT_STORAGE_PATH } from './patchReportFiles';
import { BackupObjectTooLargeError } from './backupSnapshotStorage';

const SPOOL_DIR_PREFIX = 'breeze-manifest-';
const SPOOL_FILE_NAME = 'manifest.json';
const STALE_SPOOL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function dataDirSpoolBase(): string {
  const patchReportPath = process.env.PATCH_REPORT_STORAGE_PATH || DEFAULT_PATCH_REPORT_STORAGE_PATH;
  return join(dirname(patchReportPath), 'manifest-spool');
}

/** The directory spools are created under: the data volume, else os.tmpdir() with a warning. */
export async function resolveManifestSpoolBase(): Promise<string> {
  const candidate = dataDirSpoolBase();
  try {
    await mkdir(candidate, { recursive: true });
    await access(candidate, constants.W_OK);
    return candidate;
  } catch (err) {
    const fallback = tmpdir();
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[backupManifestSpool] ${candidate} is not writable (${reason}); spooling under ${fallback}. ` +
        'The shipped compose files mount /tmp as a 64 MB tmpfs, so a large manifest will fail with ENOSPC there.',
    );
    return fallback;
  }
}

export type ManifestSpool = {
  sha256: string;
  bytes: number;
  /** The spooled bytes, from the start. */
  open(): Readable;
  /** Removes the spool. Never throws: a leftover is swept on the next worker start. */
  remove(): Promise<void>;
};

export type SpoolManifestOptions = {
  maxBytes: number;
  /** Where to create the spool. Defaults to resolveManifestSpoolBase(). */
  baseDir?: string;
  /** Test seam for a disk failure while writing. */
  openWriter?: (path: string) => Writable;
};

/**
 * Copies `source` to a new private directory (0700, by mkdtemp), hashing as the
 * bytes pass. Rejects with BackupObjectTooLargeError past `maxBytes`, whatever
 * the source declared, and with the source's or the disk's own error otherwise.
 * A rejection leaves nothing behind.
 */
export async function spoolManifest(source: NodeJS.ReadableStream, options: SpoolManifestOptions): Promise<ManifestSpool> {
  let dir: string;
  try {
    const base = options.baseDir ?? (await resolveManifestSpoolBase());
    dir = await mkdtemp(join(base, SPOOL_DIR_PREFIX));
  } catch (err) {
    // pipeline() below owns the source from there on. Until then nothing else
    // would release an open download.
    (source as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
    throw err;
  }
  const remove = async () => {
    await rm(dir, { recursive: true, force: true }).catch((err) => {
      console.warn(`[backupManifestSpool] Could not remove ${dir}; the next worker start sweeps it:`, err);
    });
  };

  const path = join(dir, SPOOL_FILE_NAME);
  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > options.maxBytes) {
        callback(new BackupObjectTooLargeError(SPOOL_FILE_NAME, bytes, options.maxBytes));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const writer = options.openWriter?.(path) ?? createWriteStream(path, { flags: 'wx', mode: 0o600 });

  try {
    await pipeline(source, meter, writer);
  } catch (err) {
    await remove();
    throw err;
  }
  return { sha256: hash.digest('hex'), bytes, open: () => createReadStream(path), remove };
}

/**
 * Removes spools a crashed or killed run left behind. A day is far past the
 * point any live run could still be using one: a claim goes stale in 30 minutes.
 * Best effort: a sweep that cannot run is never a reason to stop the worker.
 */
export async function cleanStaleManifestSpools(baseDirs?: readonly string[]): Promise<void> {
  const bases = baseDirs ?? [dataDirSpoolBase(), tmpdir()];
  const cutoff = Date.now() - STALE_SPOOL_MAX_AGE_MS;
  await Promise.all(
    bases.map(async (base) => {
      let names: string[];
      try {
        names = await readdir(base);
      } catch (err) {
        // Never created is normal. Anything else hides spools this sweep cannot remove.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn(`[backupManifestSpool] Could not read ${base} to sweep it:`, err);
        }
        return;
      }
      await Promise.all(
        names
          .filter((name) => name.startsWith(SPOOL_DIR_PREFIX))
          .map(async (name) => {
            const path = join(base, name);
            try {
              if ((await stat(path)).mtimeMs < cutoff) await rm(path, { recursive: true, force: true });
            } catch (err) {
              console.warn(`[backupManifestSpool] Could not sweep ${path}:`, err);
            }
          }),
      );
    }),
  );
}
