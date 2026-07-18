/**
 * `breeze-ext pack` — writes a deterministic `.breeze-ext` ZIP bundle (with
 * integrity inventory) from an extension source directory.
 *
 * Signing is not implemented yet — `sign` (Task 5 of this plan) turns the
 * unsigned artifact this command produces into a verifiable one by adding a
 * `signature` member. An unsigned artifact is a valid intermediate.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseExtensionManifestV1 } from '@breeze/extension-sdk';
import { collectPayload } from '../artifact/collectPayload';
import { writeDeterministicZip } from '../artifact/deterministicZip';
import { buildIntegrityDocument } from '../artifact/integrity';

export interface PackOptions {
  /** Path to the extension source directory (contains the manifest). */
  path: string;
  /**
   * Output path for the produced `.breeze-ext` bundle. If this names an
   * existing directory, the artifact is written inside it as
   * `<name>-<version>.breeze-ext`, taken from the manifest.
   */
  out: string;
  /**
   * Unix timestamp (seconds) baked into every archive entry so identical
   * source trees produce byte-identical artifacts. When omitted, resolved from
   * the `SOURCE_DATE_EPOCH` environment variable, falling back to `0`.
   */
  sourceDateEpoch?: number;
}

export interface PackResult {
  /** Path the `.breeze-ext` artifact was actually written to. */
  artifactPath: string;
  /** `sha256:` + hex digest of the whole artifact file (not a bare payload member hash). */
  digest: string;
}

/**
 * Resolve the timestamp baked into every archive entry. Precedence: an explicit
 * `options.sourceDateEpoch`, then the `SOURCE_DATE_EPOCH` environment variable
 * (the reproducible-builds convention), then `0`. Pinning it — rather than
 * using the current time — is what makes packing the same source tree twice, on
 * any machine at any time, produce byte-identical archives.
 *
 * A present-but-unparseable env value is an error, not a silent fallback to 0:
 * a caller who sets `SOURCE_DATE_EPOCH` expects it honored, and quietly
 * ignoring a typo would produce a differently-timestamped artifact than intended.
 */
function resolveSourceDateEpoch(explicit: number | undefined): number {
  if (explicit !== undefined) return explicit;
  const raw = process.env.SOURCE_DATE_EPOCH;
  if (raw === undefined || raw === '') return 0;
  if (!/^\d+$/.test(raw)) {
    throw new Error('SOURCE_DATE_EPOCH must be a non-negative integer number of seconds');
  }
  return Number(raw);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

async function resolveArtifactPath(out: string, name: string, version: string): Promise<string> {
  const outIsDirectory = await stat(out).then((info) => info.isDirectory(), () => false);
  return outIsDirectory ? join(out, `${name}-${version}.breeze-ext`) : out;
}

/**
 * Pack an extension source directory into an unsigned `.breeze-ext` bundle.
 *
 * Order is load-bearing:
 *   1. Collect payload members (manifest, server entry, optional web,
 *      optional migrations) via `collectPayload` — which also validates the
 *      manifest and refuses symlinks and reserved member names.
 *   2. Build `integrity.json` over exactly those members.
 *   3. Write the ZIP containing the payload members plus `integrity.json` —
 *      no `signature` yet.
 *   4. Hash the finished artifact file for the returned digest.
 */
export async function packExtension(options: PackOptions): Promise<PackResult> {
  const members = await collectPayload(options.path);

  // collectPayload already validates manifest.json and guarantees its
  // presence; re-parse the already-known-good bytes here only to read
  // name/version for the output filename.
  const manifestMember = members.find((member) => member.path === 'manifest.json')!;
  const manifest = parseExtensionManifestV1(JSON.parse(manifestMember.bytes.toString('utf8')));

  const integrityBytes = buildIntegrityDocument(members);
  const artifactPath = await resolveArtifactPath(options.out, manifest.name, manifest.version);
  const sourceDateEpoch = resolveSourceDateEpoch(options.sourceDateEpoch);

  await writeDeterministicZip(
    [...members, { path: 'integrity.json', bytes: integrityBytes }],
    artifactPath,
    { sourceDateEpoch },
  );

  const digest = `sha256:${await sha256File(artifactPath)}`;
  return { artifactPath, digest };
}

export async function runPack(options: PackOptions): Promise<void> {
  const result = await packExtension(options);
  console.log(result.artifactPath);
  console.log(result.digest);
}
