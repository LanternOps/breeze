import {
  createHash,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import StreamZip from 'node-stream-zip';
import { z } from 'zod';
import {
  parseExtensionManifestV1,
  type ExtensionManifestV1,
} from '@breeze/extension-sdk';
import type { ExtensionSelection } from './config';

/**
 * Verifies the trust of a signed `.breeze-ext` bundle before anything is
 * installed. This is a security trust boundary: the crypto and archive-safety
 * checks here decide whether third-party code is allowed to load into the stock
 * Breeze API image.
 *
 * Verification, in order:
 *   1. Hash the whole artifact; if the selection pins a digest, it must match.
 *   2. Read the archive through a bounded, hostile-input-safe reader.
 *   3. Parse manifest.json (via the SDK) and integrity.json.
 *   4. Verify the Ed25519 signature over a canonical JSON payload binding the
 *      extension identity + the raw manifest/integrity hashes.
 *   5. Verify every non-reserved member's sha256 against the signed inventory,
 *      with an exact 1:1 correspondence (no extra members, none missing).
 *   6. If a version is selected, the verified manifest version must match.
 *
 * Nothing here logs bundle bytes, key material, or raw exceptions.
 */

/** A trusted publisher and its Ed25519 public key. */
export interface TrustedPublisher {
  publisher: string;
  publicKey: KeyObject;
}

/** The result of a successful bundle verification. Frozen. */
export interface VerifiedExtensionBundle {
  archivePath: string;
  /** `sha256:` + hex digest of the whole artifact. */
  artifactDigest: string;
  manifest: ExtensionManifestV1;
  /** Non-reserved payload members and their verified hashes. */
  files: ReadonlyMap<string, { sha256: string; uncompressedSize: number }>;
}

/**
 * Reserved metadata members. These are authenticated by the pinned whole-artifact
 * digest and the signature envelope, so they MUST NOT appear as self-hashed
 * entries in their own inventory (that would be a recursive hash).
 */
export const RESERVED_MEMBERS: ReadonlySet<string> = new Set(['integrity.json', 'signature']);

export interface ArchiveLimits {
  maxMembers: number;
  maxMemberBytes: number;
  maxTotalBytes: number;
}

/** Hard limits enforced while reading, before any content is trusted. */
export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxMembers: 10_000,
  maxMemberBytes: 32 * 1024 * 1024, // 32 MiB per member
  maxTotalBytes: 128 * 1024 * 1024, // 128 MiB total payload
};

interface BoundedArchive {
  files: ReadonlyMap<string, { sha256: string; uncompressedSize: number }>;
  read(name: string): Promise<Buffer>;
  close(): Promise<void>;
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return `sha256:${hash.digest('hex')}`;
}

/**
 * Reject any member name that is not a safe forward relative path. Guards
 * against absolute paths, `..` traversal, backslashes, empty/`.` segments, and
 * native `.node` modules. Directory names are normalized (trailing slash
 * stripped) before checking.
 */
function assertSafeMemberName(rawName: string): void {
  const name = rawName.endsWith('/') ? rawName.slice(0, -1) : rawName;
  if (name === '' || name.startsWith('/') || name.includes('\\')) {
    throw new Error('archive rejected: unsafe member path');
  }
  for (const segment of name.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error('archive rejected: unsafe member path');
    }
  }
  if (name.endsWith('.node')) {
    throw new Error('archive rejected: native .node modules are not permitted');
  }
}

function isSymlinkEntry(entry: StreamZip.ZipEntry): boolean {
  // Unix file type is encoded in the high 16 bits of the external attributes.
  const unixMode = (entry.attr >>> 16) & 0xffff;
  return (unixMode & 0o170000) === 0o120000; // S_IFLNK
}

/**
 * Open a `.breeze-ext` archive through a bounded, hostile-input-safe reader.
 * All limits and structural safety checks are enforced up front, before any
 * member content is decompressed or trusted. Non-reserved members are hashed
 * eagerly into `files`; the caller must `close()` the returned handle.
 */
export async function readBoundedZipDirectory(
  archivePath: string,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): Promise<BoundedArchive> {
  // skipEntryNameValidation: our own assertSafeMemberName owns the decision so
  // the security boundary lives here, not in the third-party reader's defaults.
  const zip = new StreamZip.async({ file: archivePath, skipEntryNameValidation: true });
  try {
    const declaredCount = await zip.entriesCount;
    if (declaredCount > limits.maxMembers) {
      throw new Error(`archive rejected: too many members (>${limits.maxMembers})`);
    }

    const entries = await zip.entries();
    // node-stream-zip keys entries by name, collapsing duplicates. A mismatch
    // between the central-directory count and the deduped map reveals a
    // duplicate-path (zip confusion) attack.
    if (Object.keys(entries).length !== declaredCount) {
      throw new Error('archive rejected: duplicate member paths');
    }

    let totalBytes = 0;
    for (const entry of Object.values(entries)) {
      assertSafeMemberName(entry.name);
      if (isSymlinkEntry(entry)) {
        throw new Error('archive rejected: symlinks are not permitted');
      }
      if (entry.isDirectory) continue;
      if (entry.size > limits.maxMemberBytes) {
        throw new Error('archive rejected: member exceeds the per-member size limit');
      }
      totalBytes += entry.size;
      if (totalBytes > limits.maxTotalBytes) {
        throw new Error('archive rejected: total payload exceeds the size limit');
      }
    }

    const files = new Map<string, { sha256: string; uncompressedSize: number }>();
    for (const entry of Object.values(entries)) {
      if (entry.isDirectory || RESERVED_MEMBERS.has(entry.name)) continue;
      const data = await zip.entryData(entry.name);
      files.set(entry.name, { sha256: sha256Hex(data), uncompressedSize: data.length });
    }

    return {
      files,
      async read(name: string): Promise<Buffer> {
        const entry = entries[name];
        if (!entry || entry.isDirectory) {
          throw new Error(`archive is missing required member "${name}"`);
        }
        return zip.entryData(entry);
      },
      close: () => zip.close(),
    };
  } catch (error) {
    await zip.close().catch(() => {});
    throw error;
  }
}

const integritySchema = z.object({
  algorithm: z.literal('sha256'),
  members: z.record(
    z.string().min(1),
    z.object({
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      size: z.number().int().nonnegative(),
    }).strict(),
  ),
}).strict();

type IntegrityInventory = Map<string, { sha256: string; size: number }>;

function parseIntegrityInventory(bytes: Buffer): IntegrityInventory {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('integrity.json is not valid JSON');
  }
  let parsed: z.infer<typeof integritySchema>;
  try {
    parsed = integritySchema.parse(raw);
  } catch (error) {
    if (error instanceof z.ZodError) throw new Error(`integrity.json is invalid: ${z.prettifyError(error)}`);
    throw error;
  }
  for (const name of Object.keys(parsed.members)) {
    if (RESERVED_MEMBERS.has(name)) {
      throw new Error(`integrity.json must not inventory the reserved member "${name}"`);
    }
  }
  return new Map(Object.entries(parsed.members));
}

/** Deterministic, key-sorted JSON so signer and verifier agree byte-for-byte. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
  );
  return `{${entries.join(',')}}`;
}

/**
 * The Ed25519 signing payload: canonical JSON binding the extension identity to
 * the raw manifest.json and integrity.json bytes. The signed integrity document
 * in turn covers every non-reserved member, which avoids a recursive archive
 * hash.
 */
export function canonicalSigningPayload(
  manifest: ExtensionManifestV1,
  manifestBytes: Buffer,
  integrityBytes: Buffer,
): Buffer {
  return Buffer.from(
    canonicalJson({
      apiVersion: manifest.apiVersion,
      name: manifest.name,
      version: manifest.version,
      manifestSha256: sha256Hex(manifestBytes),
      integritySha256: sha256Hex(integrityBytes),
    }),
    'utf8',
  );
}

function verifyEd25519(publicKey: KeyObject, payload: Buffer, signature: Buffer): void {
  let ok = false;
  try {
    ok = cryptoVerify(null, payload, publicKey, signature);
  } catch {
    // A malformed key or signature must be treated as a failed verification,
    // never surfaced as a raw crypto exception.
    ok = false;
  }
  if (!ok) {
    throw new Error('extension bundle signature verification failed');
  }
}

/**
 * Verify an exact 1:1 correspondence between the archive's non-reserved members
 * and the signed inventory: every member is inventoried with a matching hash and
 * size, and every inventoried member is present.
 */
function verifyPayloadMembers(
  files: ReadonlyMap<string, { sha256: string; uncompressedSize: number }>,
  inventory: IntegrityInventory,
): void {
  for (const [name, actual] of files) {
    const expected = inventory.get(name);
    if (!expected) {
      throw new Error(`archive member "${name}" is not covered by the signed integrity inventory`);
    }
    if (expected.sha256 !== actual.sha256 || expected.size !== actual.uncompressedSize) {
      throw new Error(`archive member "${name}" failed its integrity check`);
    }
  }
  for (const name of inventory.keys()) {
    if (!files.has(name)) {
      throw new Error(`integrity inventory lists member "${name}" that is missing from the archive`);
    }
  }
}

export async function verifyExtensionBundle(
  archivePath: string,
  selection: ExtensionSelection,
  trust: TrustedPublisher,
): Promise<VerifiedExtensionBundle> {
  if (trust.publisher !== selection.publisher) {
    throw new Error('trusted publisher does not match the selected publisher');
  }

  const artifactDigest = await sha256File(archivePath);
  if (selection.digest && selection.digest !== artifactDigest) {
    throw new Error('pinned artifact digest does not match the bundle');
  }

  const archive = await readBoundedZipDirectory(archivePath);
  try {
    const manifestBytes = await archive.read('manifest.json');
    const integrityBytes = await archive.read('integrity.json');
    const signature = await archive.read('signature');

    let manifestRaw: unknown;
    try {
      manifestRaw = JSON.parse(manifestBytes.toString('utf8'));
    } catch {
      throw new Error('manifest.json is not valid JSON');
    }
    const manifest = parseExtensionManifestV1(manifestRaw);
    const inventory = parseIntegrityInventory(integrityBytes);

    verifyEd25519(
      trust.publicKey,
      canonicalSigningPayload(manifest, manifestBytes, integrityBytes),
      signature,
    );

    verifyPayloadMembers(archive.files, inventory);

    if (selection.version && manifest.version !== selection.version) {
      throw new Error(
        `selected version ${selection.version} does not match the verified manifest version ${manifest.version}`,
      );
    }

    return Object.freeze({
      archivePath,
      artifactDigest,
      manifest,
      files: archive.files,
    });
  } finally {
    await archive.close().catch(() => {});
  }
}
