/**
 * Snapshot attestations — statement format, binding and recording.
 *
 * A capable backup helper reports, with its terminal backup result, a
 * canonical JSON statement (format 1) over the exact bytes it uploaded for
 * the snapshot's control objects: the manifest, the layout manifest and the
 * system-state manifest. The API parses it strictly, binds it to its own
 * records (job, device, snapshot, storage identity, dispatched base), stores
 * it VERBATIM in backup_snapshot_attestations (the digest is over those
 * bytes; nothing re-serializes it) and, for destinations it can read, later
 * fetches the objects itself and compares (jobs/backupSnapshotAttestationWorker.ts).
 *
 * Statement format 1 (shared vectors:
 * agent/internal/backup/testdata/attestation-vectors.json):
 *   - UTF-8 JSON, at most 16 KiB, no insignificant whitespace;
 *   - keys exactly `v, snapshotId, jobId, agentId, dispatchedBaseSnapshotId,
 *     parentSnapshotId, keyLayout, objects`, and per object
 *     `role, key, sha256, size`, in that order;
 *   - `objects` sorted by role, one per role, the manifest always present,
 *     every key equal to the role's control key under the snapshot;
 *   - `parentSnapshotId` is null (a full run, including one that fell back
 *     from a dispatched base) or equal to `dispatchedBaseSnapshotId`;
 *   - string fields are printable ASCII without `"` or `\`, so every JSON
 *     encoder produces the same bytes for them.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  backupLayoutManifestKey,
  backupSnapshotManifestKey,
  backupSystemStateManifestKey,
} from './backupSnapshotStorage';
import { BACKUP_SNAPSHOT_ID_MAX_LENGTH } from '../db/schema/backupConstants';

export const SNAPSHOT_ATTESTATION_FORMAT = 1;
export const SNAPSHOT_ATTESTATION_MAX_BYTES = 16 * 1024;

export type AttestationObjectRole = 'layout' | 'manifest' | 'system_state_manifest';

export type SnapshotAttestationObject = {
  role: AttestationObjectRole;
  key: string;
  sha256: string;
  size: number;
};

export type SnapshotAttestationStatement = {
  v: 1;
  snapshotId: string;
  jobId: string;
  agentId: string;
  dispatchedBaseSnapshotId: string | null;
  parentSnapshotId: string | null;
  keyLayout: 'legacy_flat';
  objects: SnapshotAttestationObject[];
};

export type ParseAttestationFailure =
  | 'too_large'
  | 'not_json'
  | 'invalid_shape'
  | 'unsupported_version'
  | 'unsupported_key_layout'
  | 'not_canonical'
  | 'duplicate_role'
  | 'objects_not_sorted'
  | 'manifest_missing'
  | 'object_key_mismatch'
  | 'parent_not_dispatched_base';

export type ParseAttestationResult =
  | { ok: true; statement: SnapshotAttestationStatement; sha256: string }
  | { ok: false; reason: ParseAttestationFailure };

const SNAPSHOT_ID_PATTERN = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,${BACKUP_SNAPSHOT_ID_MAX_LENGTH - 1}}$`);
// Printable ASCII except '"' and '\': identical bytes from every JSON encoder.
const PLAIN_ASCII_PATTERN = /^[\x20\x21\x23-\x5b\x5d-\x7e]{1,256}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const snapshotIdSchema = z.string().regex(SNAPSHOT_ID_PATTERN);

const statementObjectSchema = z
  .object({
    role: z.enum(['layout', 'manifest', 'system_state_manifest']),
    key: z.string().min(1).max(512),
    sha256: z.string().regex(SHA256_PATTERN),
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

// Deliberately loose on `v` and `keyLayout` so an unsupported value gets its
// own reason instead of a generic shape failure.
const statementShapeSchema = z
  .object({
    v: z.number().int(),
    snapshotId: snapshotIdSchema,
    jobId: z.string().regex(PLAIN_ASCII_PATTERN),
    agentId: z.string().regex(PLAIN_ASCII_PATTERN),
    dispatchedBaseSnapshotId: snapshotIdSchema.nullable(),
    parentSnapshotId: snapshotIdSchema.nullable(),
    keyLayout: z.string().regex(PLAIN_ASCII_PATTERN),
    objects: z.array(statementObjectSchema).max(3),
  })
  .strict();

const ROLE_ORDER: readonly AttestationObjectRole[] = ['layout', 'manifest', 'system_state_manifest'];

export function expectedControlKey(snapshotId: string, role: AttestationObjectRole): string {
  switch (role) {
    case 'manifest':
      return backupSnapshotManifestKey(snapshotId);
    case 'layout':
      return backupLayoutManifestKey(snapshotId);
    case 'system_state_manifest':
      return backupSystemStateManifestKey(snapshotId);
  }
}

/** Rebuilds the statement in canonical key order (JSON.stringify keeps insertion order). */
function canonicalize(statement: SnapshotAttestationStatement): string {
  return JSON.stringify({
    v: statement.v,
    snapshotId: statement.snapshotId,
    jobId: statement.jobId,
    agentId: statement.agentId,
    dispatchedBaseSnapshotId: statement.dispatchedBaseSnapshotId,
    parentSnapshotId: statement.parentSnapshotId,
    keyLayout: statement.keyLayout,
    objects: statement.objects.map((o) => ({ role: o.role, key: o.key, sha256: o.sha256, size: o.size })),
  });
}

export function statementSha256(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Parses a statement exactly as received. On success `sha256` is over the
 * received bytes, which are also what the caller stores.
 */
export function parseAttestationStatement(raw: string): ParseAttestationResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'invalid_shape' };
  if (Buffer.byteLength(raw, 'utf8') > SNAPSHOT_ATTESTATION_MAX_BYTES) return { ok: false, reason: 'too_large' };

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'not_json' };
  }

  const shape = statementShapeSchema.safeParse(json);
  if (!shape.success) return { ok: false, reason: 'invalid_shape' };
  const data = shape.data;
  if (data.v !== SNAPSHOT_ATTESTATION_FORMAT) return { ok: false, reason: 'unsupported_version' };
  if (data.keyLayout !== 'legacy_flat') return { ok: false, reason: 'unsupported_key_layout' };

  const statement: SnapshotAttestationStatement = { ...data, v: 1, keyLayout: 'legacy_flat' };
  if (canonicalize(statement) !== raw) return { ok: false, reason: 'not_canonical' };

  const roles = statement.objects.map((o) => o.role);
  if (new Set(roles).size !== roles.length) return { ok: false, reason: 'duplicate_role' };
  for (let i = 1; i < roles.length; i++) {
    if (ROLE_ORDER.indexOf(roles[i - 1]!) > ROLE_ORDER.indexOf(roles[i]!)) {
      return { ok: false, reason: 'objects_not_sorted' };
    }
  }
  if (!roles.includes('manifest')) return { ok: false, reason: 'manifest_missing' };
  for (const object of statement.objects) {
    if (object.key !== expectedControlKey(statement.snapshotId, object.role)) {
      return { ok: false, reason: 'object_key_mismatch' };
    }
  }
  if (statement.parentSnapshotId !== null && statement.parentSnapshotId !== statement.dispatchedBaseSnapshotId) {
    return { ok: false, reason: 'parent_not_dispatched_base' };
  }

  return { ok: true, statement, sha256: statementSha256(raw) };
}
