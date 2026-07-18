import { createWriteStream } from 'node:fs';
import archiver from 'archiver';

/**
 * A single payload member to pack into a `.breeze-ext` archive: a safe
 * relative path plus its raw bytes.
 */
export interface DeterministicZipMember {
  path: string;
  bytes: Buffer;
}

export interface WriteDeterministicZipOptions {
  /** Seconds since the Unix epoch. Pinned into every entry's timestamp. */
  sourceDateEpoch: number;
}

/**
 * Archive limits, duplicated (not imported) from
 * `apps/api/src/extensions/bundleVerifier.ts` (`DEFAULT_ARCHIVE_LIMITS`).
 * This package must not import from `apps/api`; a conformance test in a
 * later task cross-checks these values against the real verifier export.
 */
const MAX_MEMBERS = 10_000;
const MAX_MEMBER_BYTES = 32 * 1024 * 1024; // 32 MiB per member
const MAX_TOTAL_BYTES = 128 * 1024 * 1024; // 128 MiB total payload

/** Fixed unix mode for every file entry. No directory entries are ever emitted. */
const FILE_MODE = 0o644;

/**
 * Reject any member path that is not a safe forward-relative path, mirroring
 * `assertSafeMemberName` in `apps/api/src/extensions/bundleVerifier.ts`:
 * no absolute paths, no backslashes, no `.`/`..`/empty segments (which also
 * catches a `./` prefix and any doubled `//`), and no `.node` suffix.
 */
function assertSafeMemberPath(rawPath: string): void {
  if (rawPath === '') {
    throw new Error('deterministic zip rejected: empty member path');
  }
  if (rawPath.startsWith('/')) {
    throw new Error(`deterministic zip rejected: absolute member path "${rawPath}"`);
  }
  if (rawPath.includes('\\')) {
    throw new Error(`deterministic zip rejected: backslash in member path "${rawPath}"`);
  }
  for (const segment of rawPath.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(`deterministic zip rejected: unsafe path segment in "${rawPath}"`);
    }
  }
  if (rawPath.endsWith('.node')) {
    throw new Error(`deterministic zip rejected: native .node member "${rawPath}"`);
  }
}

/**
 * Validate every member up front — path safety, duplicate/case-fold
 * collisions, and the three archive limits — so a bad tree is rejected
 * before any bytes are written to disk.
 */
function validateMembers(members: readonly DeterministicZipMember[]): void {
  if (members.length > MAX_MEMBERS) {
    throw new Error(`deterministic zip rejected: too many members (>${MAX_MEMBERS})`);
  }

  const seenExact = new Set<string>();
  const seenCaseFold = new Set<string>();
  let totalBytes = 0;

  for (const member of members) {
    assertSafeMemberPath(member.path);

    if (member.bytes.length > MAX_MEMBER_BYTES) {
      throw new Error(
        `deterministic zip rejected: member "${member.path}" exceeds ${MAX_MEMBER_BYTES} bytes`,
      );
    }
    totalBytes += member.bytes.length;

    if (seenExact.has(member.path)) {
      throw new Error(`deterministic zip rejected: duplicate member path "${member.path}"`);
    }
    seenExact.add(member.path);

    // toLowerCase (NOT toLocaleLowerCase): case folding here must be
    // locale-independent so the same member set is accepted or rejected
    // identically on every machine, matching the determinism contract.
    const folded = member.path.toLowerCase();
    if (seenCaseFold.has(folded)) {
      throw new Error(`deterministic zip rejected: case-fold collision for member path "${member.path}"`);
    }
    seenCaseFold.add(folded);
  }

  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error(`deterministic zip rejected: total payload exceeds ${MAX_TOTAL_BYTES} bytes`);
  }
}

/**
 * Bytewise comparison of UTF-8 path bytes. Deliberately NOT `localeCompare`
 * — locale-aware sorting is non-deterministic across environments/locales,
 * and archive byte order must be pinned.
 */
function compareBytewise(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Write a `.breeze-ext` payload as a deterministic ZIP archive: identical
 * `members` always produce byte-identical output, regardless of input order
 * or the host environment (locale, timezone, platform). Every field archiver
 * could otherwise vary is pinned: bytewise-sorted entry order, a fixed
 * per-entry date derived from `sourceDateEpoch`, fixed unix file mode, no
 * directory entries, and fixed zlib level 9 compression.
 *
 * Rejects (before writing anything to disk) unsafe member paths, `.node`
 * members, duplicate or case-folded-colliding names, and archives that
 * exceed the member-count, per-member-size, or total-size limits enforced
 * by the frozen verifier (`apps/api/src/extensions/bundleVerifier.ts`).
 */
export async function writeDeterministicZip(
  members: DeterministicZipMember[],
  destination: string,
  options: WriteDeterministicZipOptions,
): Promise<void> {
  validateMembers(members);

  const sortedMembers = [...members].sort((a, b) => compareBytewise(a.path, b.path));
  const entryDate = new Date(options.sourceDateEpoch * 1000);

  const output = createWriteStream(destination);
  const archive = archiver('zip', { zlib: { level: 9 } });

  const finished = new Promise<void>((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', (err) => {
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });

  archive.pipe(output);

  for (const member of sortedMembers) {
    archive.append(member.bytes, {
      name: member.path,
      date: entryDate,
      mode: FILE_MODE,
    });
  }

  // Await BOTH promises together. If we awaited `finalize()` first and it
  // rejected (e.g. the output stream failed with ENOENT on a missing --out
  // directory), `finished` — which also rejects on that same stream error —
  // would be left with no awaiter: an orphaned unhandled rejection that Node's
  // default --unhandled-rejections=throw turns into a hard process crash the
  // CLI's top-level catch never sees. Promise.all attaches a handler to both
  // up front, so either failure surfaces as a clean rejection of this call.
  await Promise.all([archive.finalize(), finished]);
}
