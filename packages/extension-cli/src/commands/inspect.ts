/**
 * `breeze-ext inspect` — an AUTHOR-SIDE DIAGNOSTIC that reports what's
 * inside a `.breeze-ext` artifact: the whole-artifact digest, the manifest
 * identity, whether the archive's actual members still match the committed
 * `integrity.json`, an optional signature check, and the migration list.
 *
 * This is NOT the host's trust decision. `apps/api/src/extensions/bundleVerifier.ts`
 * (`verifyExtensionBundle`) is the only place that enforces publisher trust
 * config, digest pinning, and archive-safety limits before code is allowed
 * to load. `inspect` re-derives the inventory from the archive and,
 * optionally, checks a raw Ed25519 signature against a caller-supplied
 * public key — nothing more. It must never be presented as equivalent to
 * host verification, and it does not import or duplicate `apps/api` trust
 * logic.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import StreamZip from 'node-stream-zip';
import { parseExtensionManifestV1 } from '@breeze/extension-sdk';
import { RESERVED_MEMBERS, signingPayload } from '../artifact/integrity';
import { loadEd25519PublicKey, verifyEd25519 } from '../artifact/signature';

export interface InspectOptions {
  /** Path to the `.breeze-ext` artifact to inspect. */
  artifact: string;
  /** Emit machine-readable JSON instead of human-readable text. */
  json?: boolean;
  /**
   * Path to an Ed25519 public key file. When supplied, the archive's
   * `signature` member is checked against it. When omitted, the signature is
   * NOT checked and is reported as `"unverified"` — inspect never implies a
   * validity it did not actually check.
   */
  publicKey?: string;
}

/**
 * `"unverified"` — no `--public-key` was supplied; the signature was not
 *   checked at all.
 * `"missing"` — a public key was supplied but the archive has no
 *   `signature` member to check it against.
 * `"valid"` / `"invalid"` — the signature was checked against the supplied
 *   public key and either verified or did not.
 */
export type SignatureStatus = 'unverified' | 'missing' | 'valid' | 'invalid';

/**
 * A re-derived inventory disagreement between the archive's actual members
 * and the committed `integrity.json`. `code` is a stable, machine-readable
 * identifier: callers (CI, other tooling) can match on it without parsing
 * `reason` prose.
 */
export interface InspectFinding {
  code: 'integrity_mismatch';
  path: string;
  reason: 'digest_mismatch' | 'missing_from_archive' | 'missing_from_inventory';
}

export interface InspectResult {
  /** `sha256:` + hex digest of the whole artifact file. */
  digest: string;
  manifest: { name: string; version: string; apiVersion: string };
  signature: SignatureStatus;
  integrity: { valid: boolean; findings: InspectFinding[] };
  /** Filenames (relative to the manifest's `migrationsDir`), sorted. */
  migrations: string[];
  /** `true` iff nothing here failed verification — drives the exit code. */
  ok: boolean;
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

/** Read every non-directory member out of a `.breeze-ext` archive, fully into memory. */
async function readArtifactMembers(archivePath: string): Promise<Map<string, Buffer>> {
  const zip = new StreamZip.async({ file: archivePath });
  try {
    const entries = await zip.entries();
    const members = new Map<string, Buffer>();
    for (const entry of Object.values(entries)) {
      if (entry.isDirectory) continue;
      members.set(entry.name, await zip.entryData(entry.name));
    }
    return members;
  } finally {
    await zip.close();
  }
}

interface CommittedIntegrityDocument {
  members: Record<string, { sha256: string; size: number }>;
}

/**
 * Parse the committed `integrity.json` bytes loosely — just enough shape to
 * re-derive against. Schema enforcement (the verifier's `.strict()` Zod
 * shape) is the host's job at trust time, not this diagnostic's.
 */
function parseCommittedIntegrity(bytes: Buffer): CommittedIntegrityDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('integrity.json is not valid JSON');
  }
  if (
    typeof raw !== 'object' || raw === null
    || !('members' in raw) || typeof (raw as { members: unknown }).members !== 'object'
    || (raw as { members: unknown }).members === null
  ) {
    throw new Error('integrity.json has an unexpected shape (missing "members")');
  }
  return raw as CommittedIntegrityDocument;
}

/**
 * Re-derive the inventory from the archive's actual non-reserved members and
 * compare it, member by member, against the committed `integrity.json`.
 * Every disagreement — a changed digest, a member the archive has that the
 * inventory doesn't, or vice versa — becomes an `integrity_mismatch`
 * finding.
 */
function checkIntegrity(
  members: ReadonlyMap<string, Buffer>,
  committed: CommittedIntegrityDocument,
): InspectFinding[] {
  const findings: InspectFinding[] = [];
  const actualPaths = new Set([...members.keys()].filter((path) => !RESERVED_MEMBERS.has(path)));
  const committedPaths = new Set(Object.keys(committed.members));

  // Iterate entries (not keys) so `expected` is narrowed to the member shape
  // rather than `... | undefined` under `noUncheckedIndexedAccess` — the value
  // always exists here, but the compiler can't know that from a keyed lookup.
  for (const [path, expected] of Object.entries(committed.members)) {
    if (!actualPaths.has(path)) {
      findings.push({ code: 'integrity_mismatch', path, reason: 'missing_from_archive' });
      continue;
    }
    const bytes = members.get(path)!;
    if (sha256Hex(bytes) !== expected.sha256 || bytes.length !== expected.size) {
      findings.push({ code: 'integrity_mismatch', path, reason: 'digest_mismatch' });
    }
  }
  for (const path of actualPaths) {
    if (!committedPaths.has(path)) {
      findings.push({ code: 'integrity_mismatch', path, reason: 'missing_from_inventory' });
    }
  }

  findings.sort((a, b) => a.path.localeCompare(b.path));
  return findings;
}

/**
 * List the migration filenames: direct `*.sql` children of the manifest's
 * `migrationsDir`, sorted. Mirrors the selection rule
 * `readBundleMigrations` (`apps/api/src/extensions/migrator.ts`) applies at
 * apply-time, kept independent so this package never imports `apps/api`.
 */
function listMigrations(members: ReadonlyMap<string, Buffer>, migrationsDir: string): string[] {
  const prefix = `${migrationsDir}/`;
  return [...members.keys()]
    .filter((path) => (
      !RESERVED_MEMBERS.has(path)
      && path.startsWith(prefix)
      && path.endsWith('.sql')
      && !path.slice(prefix.length).includes('/')
    ))
    .map((path) => path.slice(prefix.length))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Inspect a `.breeze-ext` artifact and report its contents. See the module
 * doc comment for the trust-boundary scoping of this function.
 */
export async function inspectArtifact(options: InspectOptions): Promise<InspectResult> {
  const digest = `sha256:${await sha256File(options.artifact)}`;
  const members = await readArtifactMembers(options.artifact);

  const manifestBytes = members.get('manifest.json');
  if (!manifestBytes) {
    throw new Error('artifact is missing required member "manifest.json"');
  }
  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new Error('manifest.json is not valid JSON');
  }
  const manifest = parseExtensionManifestV1(manifestRaw);

  const integrityBytes = members.get('integrity.json');
  if (!integrityBytes) {
    throw new Error('artifact is missing required member "integrity.json"');
  }
  const committed = parseCommittedIntegrity(integrityBytes);
  const findings = checkIntegrity(members, committed);
  const migrations = listMigrations(members, manifest.migrationsDir);

  let signature: SignatureStatus = 'unverified';
  if (options.publicKey !== undefined) {
    const signatureBytes = members.get('signature');
    if (!signatureBytes) {
      signature = 'missing';
    } else {
      const publicKey = await loadEd25519PublicKey(options.publicKey);
      const payload = signingPayload(manifest, manifestBytes, integrityBytes);
      signature = verifyEd25519(publicKey, payload, signatureBytes) ? 'valid' : 'invalid';
    }
  }

  const ok = findings.length === 0 && signature !== 'invalid' && signature !== 'missing';

  return {
    digest,
    manifest: { name: manifest.name, version: manifest.version, apiVersion: manifest.apiVersion },
    signature,
    integrity: { valid: findings.length === 0, findings },
    migrations,
    ok,
  };
}

/**
 * Human-readable report. Deliberately contains only artifact-relative
 * member paths and result data — never `options.artifact` (an absolute
 * checkout path), environment data, or key material.
 */
function formatHuman(result: InspectResult): string {
  const lines: string[] = [
    `digest: ${result.digest}`,
    `name: ${result.manifest.name}`,
    `version: ${result.manifest.version}`,
    `apiVersion: ${result.manifest.apiVersion}`,
    `signature: ${result.signature}`,
    `integrity: ${result.integrity.valid ? 'ok' : `${result.integrity.findings.length} problem(s) found`}`,
  ];
  for (const finding of result.integrity.findings) {
    lines.push(`  - ${finding.code}: ${finding.path} (${finding.reason})`);
  }
  if (result.migrations.length === 0) {
    lines.push('migrations: none');
  } else {
    lines.push('migrations:');
    for (const migration of result.migrations) {
      lines.push(`  - ${migration}`);
    }
  }
  return lines.join('\n');
}

/**
 * Run `inspect` and print its report. Exit code is nonzero on ANY
 * verification failure (an integrity mismatch, or an invalid/missing
 * signature when a public key was supplied) and zero on a clean artifact —
 * set via `process.exitCode` (not `throw`) so the report itself is still
 * printed before the process exits.
 */
export async function runInspect(options: InspectOptions): Promise<void> {
  const result = await inspectArtifact(options);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatHuman(result));
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}
