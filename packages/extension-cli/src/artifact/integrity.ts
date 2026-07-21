import { createHash } from 'node:crypto';
import type { ExtensionManifestV1 } from '@breeze/extension-sdk';
import { canonicalJson } from './canonicalJson';

/**
 * Reserved metadata members that a payload's own integrity inventory must
 * never list, per `apps/api/src/extensions/bundleVerifier.ts` (RESERVED_MEMBERS).
 * They are authenticated by the signature envelope itself, so inventorying
 * them would be a recursive hash — the verifier rejects it.
 */
export const RESERVED_MEMBERS: ReadonlySet<string> = new Set(['integrity.json', 'signature']);

export interface IntegrityMemberInput {
  path: string;
  bytes: Buffer;
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Build the `integrity.json` bytes for a set of payload members. Throws if
 * any path is a reserved member or duplicated. Keys are emitted in sorted
 * order (via {@link canonicalJson}, which sorts regardless of insertion
 * order) so the output bytes are deterministic. Matches the verifier's
 * `.strict()` Zod schema at both levels: no keys beyond `algorithm` and
 * `members`, and no member keys beyond `sha256` and `size`.
 */
export function buildIntegrityDocument(members: readonly IntegrityMemberInput[]): Buffer {
  const entries: Record<string, { sha256: string; size: number }> = {};
  const seen = new Set<string>();
  for (const { path, bytes } of members) {
    if (RESERVED_MEMBERS.has(path)) {
      throw new Error(`integrity inventory must not include the reserved member "${path}"`);
    }
    if (seen.has(path)) {
      throw new Error(`integrity inventory has a duplicate member path "${path}"`);
    }
    seen.add(path);
    entries[path] = { sha256: sha256Hex(bytes), size: bytes.length };
  }
  return Buffer.from(canonicalJson({ algorithm: 'sha256', members: entries }), 'utf8');
}

/**
 * The Ed25519 signing payload: canonical JSON binding the extension identity
 * to the raw manifest.json and integrity.json bytes. Exactly five fields;
 * the two hashes are bare lowercase hex (no `sha256:` prefix). Must match
 * `canonicalSigningPayload` in `apps/api/src/extensions/bundleVerifier.ts`
 * byte-for-byte.
 */
export function signingPayload(
  manifest: Pick<ExtensionManifestV1, 'apiVersion' | 'name' | 'version'>,
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
