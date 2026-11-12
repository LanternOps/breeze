import { randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rmdir,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * API-side access to local backup destinations.
 *
 * A destination's stored path is the agent's path on the device and is never
 * used here. The API reads and writes only below
 * <BACKUP_LOCAL_ROOT>/<organization id>/<configuration id>/, with both ids
 * taken from database rows or the authorized request.
 *
 * Every access walks that directory one component at a time through open
 * handles: each directory is opened with O_DIRECTORY | O_NOFOLLOW, and each
 * object with O_NOFOLLOW, so no symbolic link below the root is followed.
 * On Linux the next component is opened through the parent's handle
 * (/proc/self/fd/<fd>/<name>), so replacing a directory after it was opened
 * does not change what later opens see. That is the supported deployment
 * (the shipped containers). Elsewhere (macOS, for development only) the walk
 * is path based and the whole chain is checked against the open handles
 * (device and inode) before the object is used; a component swapped and
 * swapped back between those steps is not detected there. Reads and streams use the one handle that was
 * checked. Writes go to a new exclusive file in the checked directory and are
 * renamed into place.
 */

const DENIED = 'API local backup storage is unavailable for this destination. Configure an operator-managed BACKUP_LOCAL_ROOT.';
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const MAX_PATH_LENGTH = 4096;
const MAX_KEY_DEPTH = 64;

const O_NOFOLLOW = constants.O_NOFOLLOW as number | undefined;
const O_DIRECTORY = constants.O_DIRECTORY as number | undefined;
const O_NONBLOCK = (constants.O_NONBLOCK as number | undefined) ?? 0;
const O_NOCTTY = (constants.O_NOCTTY as number | undefined) ?? 0;

/**
 * Why a destination has no usable API-side directory: BACKUP_LOCAL_ROOT is
 * not set, the destination's directory does not exist, or it cannot be used
 * (a link, not a directory, not accessible, an unusable root, ...).
 */
export type ApiLocalBackupUnavailableReason = 'not_configured' | 'missing' | 'refused';

class ApiLocalBackupUnavailableError extends Error {
  constructor(readonly reason: ApiLocalBackupUnavailableReason) {
    super(DENIED);
    this.name = 'ApiLocalBackupUnavailableError';
  }
}

function denied(reason: ApiLocalBackupUnavailableReason = 'refused'): Error {
  return new ApiLocalBackupUnavailableError(reason);
}

/** The reason behind a refusal from this module, if `error` is one. */
export function apiLocalBackupUnavailableReason(error: unknown): ApiLocalBackupUnavailableReason | undefined {
  return error instanceof ApiLocalBackupUnavailableError ? error.reason : undefined;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** A link where a directory or object was expected. */
function isLinkRefusal(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ELOOP' || code === 'EMLINK' || code === 'EFTYPE';
}

/**
 * An object open that failed on a link or a special file (a socket fails
 * with ENXIO on Linux and EOPNOTSUPP on macOS) is refused; anything else
 * (a missing object, a permission error) keeps its own error.
 */
async function objectOpenRefusal(path: string, error: unknown): Promise<Error | undefined> {
  if (isLinkRefusal(error) || errorCode(error) === 'ENXIO') return denied();
  try {
    if (!(await lstat(path)).isFile()) return denied();
  } catch {
    // fall through to the original error
  }
  return undefined;
}

type OpenDir = { handle: FileHandle; path: string; dev: number; ino: number };

let handleRelativePaths: boolean | undefined;

/** Whether /proc/self/fd/<fd> resolves to the open directory itself (Linux). */
async function detectHandleRelativePaths(probe: OpenDir): Promise<boolean> {
  if (handleRelativePaths !== undefined) return handleRelativePaths;
  let supported = false;
  if (process.platform === 'linux') {
    try {
      const viaHandle = await stat(`/proc/self/fd/${probe.handle.fd}`);
      supported = viaHandle.dev === probe.dev && viaHandle.ino === probe.ino;
    } catch {
      supported = false;
    }
  }
  handleRelativePaths = supported;
  return supported;
}

function dirPathOf(dir: OpenDir): string {
  return handleRelativePaths ? `/proc/self/fd/${dir.handle.fd}` : dir.path;
}

function childPathOf(dir: OpenDir, name: string): string {
  return `${dirPathOf(dir)}/${name}`;
}

/** Splits a destination-relative key into checked path components. */
function keyComponents(key: string): string[] {
  if (key.length > MAX_PATH_LENGTH || key.includes('\0')) throw denied();
  const parts = key.split('/').filter((part) => part !== '');
  if (parts.length > MAX_KEY_DEPTH) throw denied();
  for (const part of parts) {
    if (part === '.' || part === '..') throw denied();
  }
  return parts;
}

async function closeAll(chain: OpenDir[]): Promise<void> {
  await Promise.all(chain.map((dir) => dir.handle.close().catch(() => undefined)));
}

/**
 * Some platforms report a link opened with O_DIRECTORY | O_NOFOLLOW as
 * ENOTDIR rather than ELOOP; nothing was followed either way.
 */
async function directoryOpenRefusal(path: string, error: unknown): Promise<Error | undefined> {
  if (isLinkRefusal(error)) return denied();
  if (errorCode(error) !== 'ENOTDIR') return undefined;
  try {
    if ((await lstat(path)).isSymbolicLink()) return denied();
  } catch {
    // fall through to the original error
  }
  return undefined;
}

async function openChildDir(parent: OpenDir, name: string, create: boolean): Promise<OpenDir> {
  const flags = constants.O_RDONLY | O_DIRECTORY! | O_NOFOLLOW!;
  const path = childPathOf(parent, name);
  let handle: FileHandle;
  try {
    handle = await open(path, flags);
  } catch (error) {
    const refusal = await directoryOpenRefusal(path, error);
    if (refusal) throw refusal;
    if (!(create && errorCode(error) === 'ENOENT')) throw error;
    try {
      await mkdir(path, 0o750);
    } catch (mkdirError) {
      if (errorCode(mkdirError) !== 'EEXIST') throw mkdirError;
    }
    try {
      handle = await open(path, flags);
    } catch (reopenError) {
      throw (await directoryOpenRefusal(path, reopenError)) ?? reopenError;
    }
  }
  const info = await handle.stat();
  if (!info.isDirectory()) {
    await handle.close();
    throw denied();
  }
  return { handle, path: join(parent.path, name), dev: info.dev, ino: info.ino };
}

/**
 * Path-based platforms only: every directory in the chain (and the object, if
 * given) must still be the one that was opened, and none may be a link.
 */
async function verifyChain(chain: OpenDir[], object?: { path: string; dev: number; ino: number }): Promise<void> {
  if (handleRelativePaths) return;
  for (const entry of object ? [...chain, object] : chain) {
    let info;
    try {
      info = await lstat(entry.path);
    } catch {
      throw denied();
    }
    if (info.isSymbolicLink() || info.dev !== entry.dev || info.ino !== entry.ino) throw denied();
  }
}

function operatorRoot(): string {
  const configured = process.env.BACKUP_LOCAL_ROOT;
  if (!configured || !configured.trim()) throw denied('not_configured');
  if (!isAbsolute(configured) || configured.length > MAX_PATH_LENGTH || configured.includes('\0')) {
    throw denied();
  }
  const base = resolve(configured);
  if (base === dirname(base)) throw denied();
  return base;
}

/** Opens <root>/<orgId>/<configId>; the caller closes every returned handle. */
async function openDestination(orgId: string | undefined, configId: string | undefined): Promise<OpenDir[]> {
  if (!orgId || !ID_PATTERN.test(orgId) || !configId || !ID_PATTERN.test(configId)) throw denied();
  if (O_NOFOLLOW === undefined || O_DIRECTORY === undefined) throw denied();
  const base = operatorRoot();

  const chain: OpenDir[] = [];
  let missing = false;
  try {
    const canonicalBase = await realpath(base).catch((error) => {
      missing = errorCode(error) === 'ENOENT';
      throw error;
    });
    const handle = await open(canonicalBase, constants.O_RDONLY | O_DIRECTORY);
    const info = await handle.stat();
    chain.push({ handle, path: canonicalBase, dev: info.dev, ino: info.ino });
    if (!info.isDirectory()) throw denied();
    await detectHandleRelativePaths(chain[0]!);
    for (const name of [orgId, configId]) {
      chain.push(await openChildDir(chain[chain.length - 1]!, name, false).catch((error) => {
        missing = errorCode(error) === 'ENOENT';
        throw error;
      }));
    }
    await verifyChain(chain);
    return chain;
  } catch {
    await closeAll(chain);
    throw denied(missing ? 'missing' : 'refused');
  }
}

/** Opens the directories of `components` below the destination. */
async function openDirectories(chain: OpenDir[], components: string[], create: boolean): Promise<OpenDir> {
  let dir = chain[chain.length - 1]!;
  for (const name of components) {
    dir = await openChildDir(dir, name, create);
    chain.push(dir);
  }
  return dir;
}

export type ApiLocalBackupObject = {
  /** Open read-only handle on the checked object; the caller closes it or streams from it. */
  handle: FileHandle;
  size: number;
  lastModified: Date;
};

/**
 * Opens one object for reading. A missing object rejects with the
 * filesystem's ENOENT error; anything that is not a regular file, or is
 * reached through a link, is refused.
 */
export async function openApiLocalBackupObject(key: string, orgId?: string, configId?: string): Promise<ApiLocalBackupObject> {
  const components = keyComponents(key);
  const name = components.pop();
  if (!name) throw denied();
  const chain = await openDestination(orgId, configId);
  try {
    const dir = await openDirectories(chain, components, false);
    let handle: FileHandle;
    try {
      handle = await open(childPathOf(dir, name), constants.O_RDONLY | O_NOFOLLOW! | O_NONBLOCK | O_NOCTTY);
    } catch (error) {
      throw (await objectOpenRefusal(childPathOf(dir, name), error)) ?? error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw denied();
      await verifyChain(chain, { path: join(dir.path, name), dev: info.dev, ino: info.ino });
      return { handle, size: info.size, lastModified: info.mtime };
    } catch (error) {
      await handle.close();
      throw error;
    }
  } finally {
    await closeAll(chain);
  }
}

/** Streams one object from its checked handle. */
export async function streamApiLocalBackupObject(key: string, orgId?: string, configId?: string): Promise<{ stream: Readable; size: number }> {
  const object = await openApiLocalBackupObject(key, orgId, configId);
  return { stream: object.handle.createReadStream({ autoClose: true }), size: object.size };
}

/** Copies one object to a path the API owns (for example a work directory). */
export async function copyApiLocalBackupObjectTo(key: string, orgId: string | undefined, configId: string | undefined, destinationPath: string): Promise<void> {
  const object = await openApiLocalBackupObject(key, orgId, configId);
  try {
    await mkdir(dirname(destinationPath), { recursive: true });
    await pipeline(object.handle.createReadStream({ autoClose: false }), createWriteStream(destinationPath));
  } finally {
    await object.handle.close();
  }
}

/**
 * Publishes `sourcePath` (a file the API owns) as one object. Missing
 * directories are created one level at a time and reopened without following
 * links; the bytes go to a new exclusive file that is renamed into place.
 */
export async function writeApiLocalBackupObject(key: string, orgId: string | undefined, configId: string | undefined, sourcePath: string): Promise<void> {
  const components = keyComponents(key);
  const name = components.pop();
  if (!name) throw denied();
  const chain = await openDestination(orgId, configId);
  try {
    const dir = await openDirectories(chain, components, true);
    const partial = `.breeze-partial-${randomUUID()}`;
    let handle: FileHandle;
    try {
      handle = await open(
        childPathOf(dir, partial),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW!,
        0o640,
      );
    } catch (error) {
      if (isLinkRefusal(error)) throw denied();
      throw error;
    }
    let renamed = false;
    try {
      try {
        await handle.writeFile(createReadStream(sourcePath));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await verifyChain(chain);
      await rename(childPathOf(dir, partial), childPathOf(dir, name));
      renamed = true;
    } finally {
      if (!renamed) await unlink(childPathOf(dir, partial)).catch(() => undefined);
    }
  } finally {
    await closeAll(chain);
  }
}

/** Removes one object. A missing object or directory is not an error. */
export async function removeApiLocalBackupObject(key: string, orgId?: string, configId?: string): Promise<void> {
  const components = keyComponents(key);
  const name = components.pop();
  if (!name) throw denied();
  const chain = await openDestination(orgId, configId);
  try {
    let dir: OpenDir;
    try {
      dir = await openDirectories(chain, components, false);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      throw error;
    }
    await verifyChain(chain);
    try {
      await unlink(childPathOf(dir, name));
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  } finally {
    await closeAll(chain);
  }
}

async function removeDirectoryContents(dir: OpenDir, chain: OpenDir[], depth: number): Promise<void> {
  if (depth > MAX_KEY_DEPTH) throw denied();
  await verifyChain([...chain, dir]);
  const entries = await opendir(dirPathOf(dir));
  for await (const entry of entries) {
    if (entry.isDirectory()) {
      let child: OpenDir;
      try {
        child = await openChildDir(dir, entry.name, false);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue;
        throw error;
      }
      try {
        await removeDirectoryContents(child, [...chain, dir], depth + 1);
      } finally {
        await child.handle.close();
      }
      await rmdir(childPathOf(dir, entry.name));
    } else {
      try {
        await unlink(childPathOf(dir, entry.name));
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
    }
  }
}

/** Removes everything under a non-empty prefix (an object or a directory tree). */
export async function removeApiLocalBackupTree(prefix: string, orgId?: string, configId?: string): Promise<void> {
  const components = keyComponents(prefix);
  const name = components.pop();
  if (!name) throw denied();
  const chain = await openDestination(orgId, configId);
  try {
    let parent: OpenDir;
    try {
      parent = await openDirectories(chain, components, false);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      throw error;
    }
    let info;
    try {
      info = await lstat(childPathOf(parent, name));
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      throw error;
    }
    if (!info.isDirectory()) {
      await verifyChain(chain);
      await unlink(childPathOf(parent, name)).catch((error) => {
        if (errorCode(error) !== 'ENOENT') throw error;
      });
      return;
    }
    const dir = await openChildDir(parent, name, false);
    try {
      await removeDirectoryContents(dir, chain, components.length + 1);
    } finally {
      await dir.handle.close();
    }
    await rmdir(childPathOf(parent, name));
  } finally {
    await closeAll(chain);
  }
}

export type ApiLocalBackupListing = { key: string; lastModified: Date };

/**
 * Lists every regular file under a prefix, depth first, in pages. Directory
 * entries are read one at a time (fs.opendir), so a large prefix is never held
 * in memory at once. Links are skipped and never followed. A missing prefix
 * lists nothing.
 */
export async function* listApiLocalBackupObjects(
  prefix: string,
  orgId: string | undefined,
  configId: string | undefined,
  pageSize: number,
): AsyncGenerator<ApiLocalBackupListing[]> {
  const components = keyComponents(prefix);
  const chain = await openDestination(orgId, configId);
  try {
    let start: OpenDir;
    try {
      start = await openDirectories(chain, components, false);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      throw error;
    }

    async function* walk(dir: OpenDir, parents: OpenDir[], keyPrefix: string, depth: number): AsyncGenerator<ApiLocalBackupListing[]> {
      if (depth > MAX_KEY_DEPTH) throw denied();
      await verifyChain([...parents, dir]);
      const entries = await opendir(dirPathOf(dir));
      let files: ApiLocalBackupListing[] = [];
      for await (const entry of entries) {
        const childKey = keyPrefix ? `${keyPrefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (files.length > 0) { yield files; files = []; }
          let child: OpenDir;
          try {
            child = await openChildDir(dir, entry.name, false);
          } catch (error) {
            if (errorCode(error) === 'ENOENT') continue;
            throw error;
          }
          try {
            yield* walk(child, [...parents, dir], childKey, depth + 1);
          } finally {
            await child.handle.close();
          }
        } else if (entry.isFile()) {
          const info = await lstat(childPathOf(dir, entry.name));
          if (!info.isFile()) continue;
          files.push({ key: childKey, lastModified: info.mtime });
          if (files.length >= pageSize) { yield files; files = []; }
        }
      }
      if (files.length > 0) yield files;
    }

    const parents = chain.slice(0, -1);
    yield* walk(start, parents, components.join('/'), components.length);
  } finally {
    await closeAll(chain);
  }
}

/**
 * Connection test: the destination's directory exists, is not reached
 * through a link, and the API can read and write it. Creates nothing.
 */
export async function probeApiLocalBackupDestination(orgId: string, configId: string): Promise<void> {
  const chain = await openDestination(orgId, configId);
  try {
    await access(dirPathOf(chain[chain.length - 1]!), constants.R_OK | constants.W_OK);
    await verifyChain(chain);
  } catch {
    throw denied();
  } finally {
    await closeAll(chain);
  }
}

/** Test seam: how this process walks destination directories. */
export function apiLocalBackupWalkModeForTests(): 'handle' | 'path' | 'undetected' {
  if (handleRelativePaths === undefined) return 'undetected';
  return handleRelativePaths ? 'handle' : 'path';
}
