import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { parseExtensionManifestV1 } from '@breeze/extension-sdk';
import { RESERVED_MEMBERS } from './integrity';

/** A single collected payload member: a source-relative path and its raw bytes. */
export interface PayloadMember {
  path: string;
  bytes: Buffer;
}

function toPosixPath(rawPath: string): string {
  return rawPath.split(sep).join('/');
}

/**
 * Bytewise comparison of UTF-8 path bytes, matching
 * `writeDeterministicZip`'s own sort so the integrity document and the
 * archive agree on member order.
 */
function compareBytewise(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Recursively walk `dir`, appending every regular file found to `out` as a
 * root-relative, forward-slash path. Uses `lstat` (never `stat`) on every
 * entry so a symlink is detected and refused rather than silently
 * dereferenced — a followed symlink could pull arbitrary bytes outside the
 * source tree into a signed bundle.
 */
async function walk(dir: string, root: string, out: PayloadMember[]): Promise<void> {
  const entryNames = await readdir(dir);
  for (const name of entryNames) {
    const fullPath = join(dir, name);
    const info = await lstat(fullPath);
    const relPath = toPosixPath(relative(root, fullPath));

    if (info.isSymbolicLink()) {
      throw new Error(`collectPayload: refusing to follow symlink at "${relPath}"`);
    }
    if (info.isDirectory()) {
      await walk(fullPath, root, out);
      continue;
    }
    if (!info.isFile()) {
      throw new Error(`collectPayload: unsupported file type at "${relPath}"`);
    }

    out.push({ path: relPath, bytes: await readFile(fullPath) });
  }
}

/**
 * Collect an extension source directory into sorted payload members, ready
 * to be inventoried (`buildIntegrityDocument`) and archived
 * (`writeDeterministicZip`).
 *
 * Refuses (throws, writes nothing): symlinks anywhere in the tree; a source
 * tree that already contains a file named `integrity.json` or `signature`
 * (those are reserved, generated during packing — never carried in from
 * source); a missing or schema-invalid `manifest.json`. `manifest.json`
 * itself IS included in the returned members — it is a normal payload
 * member and must be inventoried like any other.
 */
export async function collectPayload(sourceDir: string): Promise<PayloadMember[]> {
  const members: PayloadMember[] = [];
  await walk(sourceDir, sourceDir, members);
  members.sort((a, b) => compareBytewise(a.path, b.path));

  for (const member of members) {
    if (RESERVED_MEMBERS.has(member.path)) {
      throw new Error(
        `collectPayload: source tree contains reserved member "${member.path}"; `
          + 'this file is generated during packing and must not be part of the source tree',
      );
    }
  }

  const manifestMember = members.find((member) => member.path === 'manifest.json');
  if (!manifestMember) {
    throw new Error('collectPayload: source tree is missing required "manifest.json"');
  }

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestMember.bytes.toString('utf8'));
  } catch {
    throw new Error('collectPayload: manifest.json is not valid JSON');
  }
  // Throws with a schema-validation message on any manifest the host would
  // reject — packing a bundle the verifier can't accept is a wasted release.
  parseExtensionManifestV1(manifestJson);

  return members;
}
