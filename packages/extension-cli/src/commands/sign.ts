/**
 * `breeze-ext sign` — signs a `.breeze-ext` bundle's payload with an Ed25519
 * private key, per the frozen wire format that
 * `apps/api/src/extensions/bundleVerifier.ts` expects: the `signature`
 * archive member is RAW Ed25519 signature bytes over `signingPayload`
 * (`../artifact/integrity.ts`, kept byte-identical to the verifier's
 * `canonicalSigningPayload`) — no JSON envelope, no keyId, no algorithm field.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import StreamZip from 'node-stream-zip';
import { parseExtensionManifestV1 } from '@breeze/extension-sdk';
import { type DeterministicZipMember, writeDeterministicZip } from '../artifact/deterministicZip';
import { signingPayload } from '../artifact/integrity';
import { loadEd25519PrivateKey, signEd25519 } from '../artifact/signature';
import { resolveSourceDateEpoch } from './pack';

export interface SignOptions {
  /** Path to the `.breeze-ext` artifact to sign. */
  artifact: string;
  /**
   * Path to a file holding the Ed25519 private key. Mutually exclusive with
   * {@link keyEnv}; exactly one is supplied.
   */
  key?: string;
  /**
   * Name of an environment variable holding the Ed25519 private key. The key
   * value is never accepted on argv, which is world-readable via `ps`.
   * Mutually exclusive with {@link key}; exactly one is supplied.
   */
  keyEnv?: string;
  /** Output path for the signed bundle. Defaults to signing in place. */
  out?: string;
}

export interface SignResult {
  /** Path the signed `.breeze-ext` artifact was actually written to. */
  artifactPath: string;
  /** `sha256:` + hex digest of the signed artifact file. */
  digest: string;
}

/**
 * Read every non-directory member out of a `.breeze-ext` archive, fully into
 * memory, and close the reader. Reading everything up front (rather than
 * streaming lazily) is what makes signing in place safe: the reader is closed
 * before {@link writeDeterministicZip} ever opens the same path for writing.
 */
async function readArtifactMembers(archivePath: string): Promise<DeterministicZipMember[]> {
  const zip = new StreamZip.async({ file: archivePath });
  try {
    const entries = await zip.entries();
    const members: DeterministicZipMember[] = [];
    for (const entry of Object.values(entries)) {
      if (entry.isDirectory) continue;
      members.push({ path: entry.name, bytes: await zip.entryData(entry.name) });
    }
    return members;
  } finally {
    await zip.close();
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

/**
 * Sign a `.breeze-ext` artifact.
 *
 * Steps (order is load-bearing):
 *   1. Read every member out of the artifact (payload members, `integrity.json`,
 *      and any pre-existing `signature`).
 *   2. Parse `manifest.json` (via the SDK) for the payload's identity fields.
 *   3. Rebuild the signing payload with the SAME `signingPayload` function
 *      `pack` relied on to build `integrity.json`.
 *   4. Sign with the loaded Ed25519 private key.
 *   5. Re-emit the archive through the same deterministic ZIP writer `pack`
 *      uses: every existing member except any prior `signature`, plus the new
 *      `signature`.
 *
 * Re-signing an already-signed artifact REPLACES the existing `signature`
 * member rather than refusing. The caller supplied a key and explicitly asked
 * to sign this artifact; producing a freshly (re-)signed artifact under that
 * key is the useful behavior for re-keying or re-signing after a `pack`
 * re-run, and the archive still ends up with exactly one `signature` member,
 * matching the frozen verifier's expectations.
 */
export async function signArtifact(options: SignOptions): Promise<SignResult> {
  const members = await readArtifactMembers(options.artifact);
  const memberBytes = new Map(members.map((member) => [member.path, member.bytes]));

  const manifestBytes = memberBytes.get('manifest.json');
  if (!manifestBytes) {
    throw new Error('artifact is missing required member "manifest.json"');
  }
  const integrityBytes = memberBytes.get('integrity.json');
  if (!integrityBytes) {
    throw new Error('artifact is missing required member "integrity.json"');
  }

  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new Error('manifest.json is not valid JSON');
  }
  const manifest = parseExtensionManifestV1(manifestRaw);

  const privateKey = await loadEd25519PrivateKey({ key: options.key, keyEnv: options.keyEnv });
  const payload = signingPayload(manifest, manifestBytes, integrityBytes);
  const signature = signEd25519(privateKey, payload);

  // Drop any prior `signature` member -- re-signing replaces it, never stacks.
  const payloadMembers = members.filter((member) => member.path !== 'signature');
  const artifactPath = options.out ?? options.artifact;
  const sourceDateEpoch = resolveSourceDateEpoch(undefined);

  await writeDeterministicZip(
    [...payloadMembers, { path: 'signature', bytes: signature }],
    artifactPath,
    { sourceDateEpoch },
  );

  const digest = `sha256:${await sha256File(artifactPath)}`;
  return { artifactPath, digest };
}

export async function runSign(options: SignOptions): Promise<void> {
  const result = await signArtifact(options);
  console.log(result.artifactPath);
  console.log(result.digest);
}
