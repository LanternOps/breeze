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
 *   - string fields are printable ASCII without `"`, `\`, `<`, `>` or `&`,
 *     so every JSON encoder produces the same bytes for them.
 */
import { createHash } from 'node:crypto';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';
import {
  backupLayoutManifestKey,
  backupSnapshotManifestKey,
  backupSystemStateManifestKey,
} from './backupSnapshotStorage';
import { BACKUP_SNAPSHOT_ID_MAX_LENGTH } from '../db/schema/backupConstants';
import { db, hasDbAccessContext, runAfterDbContextExit, withDbTransaction } from '../db';
import { backupJobs, backupSnapshots } from '../db/schema/backup';
import { devices } from '../db/schema/devices';
import { settleVerificationsForFailedAttestation } from './backupAttestationFailureSettlement';
import {
  backupSnapshotAttestations,
  type BackupSnapshotIntegrityStatus,
} from '../db/schema/backupSnapshotAttestations';
import { recordBackupAttestation } from './backupMetrics';
import { createAuditLogAsync } from './auditService';
import { captureException } from './sentry';

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
// Printable ASCII except '"', '\', '<', '>' and '&': no JSON encoder escapes
// any of the rest, so every implementation produces identical bytes (Go's
// default encoder escapes the last three).
const PLAIN_ASCII_PATTERN = /^[\x20\x21\x23-\x25\x27-\x3b\x3d\x3f-\x5b\x5d-\x7e]{1,256}$/;
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

// ── Recording (agent result path only) ──────────────────────────────────────

export type RecordAttestationOutcome =
  | 'recorded'
  | 'duplicate_same'
  | 'conflict'
  | 'binding_mismatch'
  | 'invalid'
  | 'missing_from_capable'
  | 'not_offered'
  | 'capability_unknown'
  | 'missing_expectation';

export type RecordSnapshotAttestationInput = {
  snapshotDbId: string;
  orgId: string;
  jobId: string;
  deviceId: string;
  providerSnapshotId: string;
  storageIdentity: string | null;
  /** The job's server-side base pin; '' / null = a full dispatch. */
  pinnedBaseProviderSnapshotId: string | null;
  reportsLayout: boolean;
  reportsSystemState: boolean;
  /** Agent-reported count of manifest entries inherited from the base. */
  referencedFiles: number | undefined;
  deviceAgentId: string | null;
  /**
   * The integrity protocol the device's helper reported; null when it has not
   * reported one. Unreported is not "older helper": it never counts as a
   * helper that does not offer attestations.
   */
  deviceIntegrityProtocolVersion: number | null;
  acceptedVia: 'agent_result' | 'late_agent_result';
  /**
   * True only when the caller consumed this job's dispatch expectation (or
   * received the result on the dispatched command's own channel). A result
   * that was not bound to a dispatch never records an attestation.
   */
  dispatchExpectationVerified: boolean;
  resultReceivedAt: Date;
  /** The result's `attestation` field, unvalidated. */
  attestation: unknown;
};

export type AttestationRowValues = {
  orgId: string;
  snapshotDbId: string;
  jobId: string;
  deviceId: string;
  providerSnapshotId: string;
  storageIdentity: string;
  keyLayout: 'legacy_flat';
  dispatchedBaseProviderSnapshotId: string | null;
  parentProviderSnapshotId: string | null;
  verificationMode: 'server_fetched' | 'producer_only';
  acceptedVia: 'agent_result' | 'late_agent_result';
  resultReceivedAt: Date;
  formatVersion: 1;
  statement: string;
  statementSha256: string;
  manifestKey: string;
  manifestSha256: string;
  manifestSize: number;
  layoutSha256: string | null;
  layoutSize: number | null;
  systemStateManifestSha256: string | null;
  systemStateManifestSize: number | null;
  status: 'pending' | 'producer_only';
};

export type AttestationEvaluation =
  | { kind: 'insert'; row: AttestationRowValues }
  | { kind: 'refuse'; outcome: 'invalid' | 'binding_mismatch'; reason: string }
  | { kind: 'absent'; outcome: 'missing_from_capable' | 'not_offered' | 'capability_unknown' | 'missing_expectation' };

/** The raw statement string of an attestation envelope, or null when the envelope is malformed. */
export function attestationStatementOf(attestation: unknown): string | null {
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) return null;
  const statement = (attestation as Record<string, unknown>).statement;
  return typeof statement === 'string' ? statement : null;
}

/** Device-local destinations cannot be read by the API; everything else is fetched and compared. */
export function attestationVerificationMode(storageIdentity: string): 'server_fetched' | 'producer_only' {
  return storageIdentity.startsWith('local::') ? 'producer_only' : 'server_fetched';
}

/**
 * Pure decision: what an agent result's attestation means for one snapshot.
 * No I/O; `recordSnapshotAttestation` applies it.
 */
export function evaluateSnapshotAttestation(input: RecordSnapshotAttestationInput): AttestationEvaluation {
  if (!input.dispatchExpectationVerified) return { kind: 'absent', outcome: 'missing_expectation' };
  if (input.attestation === undefined || input.attestation === null) {
    const version = input.deviceIntegrityProtocolVersion;
    return {
      kind: 'absent',
      outcome: version === null ? 'capability_unknown' : version >= 1 ? 'missing_from_capable' : 'not_offered',
    };
  }

  const raw = attestationStatementOf(input.attestation);
  if (raw === null) return { kind: 'refuse', outcome: 'invalid', reason: 'envelope_invalid' };
  const parsed = parseAttestationStatement(raw);
  if (!parsed.ok) return { kind: 'refuse', outcome: 'invalid', reason: parsed.reason };
  const statement = parsed.statement;

  const mismatch = (reason: string): AttestationEvaluation => ({ kind: 'refuse', outcome: 'binding_mismatch', reason });
  const pinnedBase = input.pinnedBaseProviderSnapshotId || null;
  if (!input.storageIdentity) return mismatch('storage_identity_missing');
  if (statement.snapshotId !== input.providerSnapshotId) return mismatch('snapshot_id');
  if (statement.jobId !== input.jobId) return mismatch('job_id');
  if (!input.deviceAgentId || statement.agentId !== input.deviceAgentId) return mismatch('agent_id');
  if (statement.dispatchedBaseSnapshotId !== pinnedBase) return mismatch('dispatched_base');
  // A run dispatched with a base may legitimately fall back to a full run
  // (parent null); a full run inherits nothing, which the server-side verifier
  // additionally proves against the manifest itself.
  if (statement.parentSnapshotId === null && (input.referencedFiles ?? 0) > 0) {
    return mismatch('full_run_with_references');
  }

  const byRole = new Map(statement.objects.map((o) => [o.role, o]));
  if (byRole.has('layout') !== input.reportsLayout) return mismatch('layout_presence');
  if (byRole.has('system_state_manifest') !== input.reportsSystemState) return mismatch('system_state_presence');
  const manifest = byRole.get('manifest')!;
  const layout = byRole.get('layout');
  const systemState = byRole.get('system_state_manifest');

  const verificationMode = attestationVerificationMode(input.storageIdentity);
  return {
    kind: 'insert',
    row: {
      orgId: input.orgId,
      snapshotDbId: input.snapshotDbId,
      jobId: input.jobId,
      deviceId: input.deviceId,
      providerSnapshotId: input.providerSnapshotId,
      storageIdentity: input.storageIdentity,
      keyLayout: 'legacy_flat',
      dispatchedBaseProviderSnapshotId: statement.dispatchedBaseSnapshotId,
      parentProviderSnapshotId: statement.parentSnapshotId,
      verificationMode,
      acceptedVia: input.acceptedVia,
      resultReceivedAt: input.resultReceivedAt,
      formatVersion: 1,
      statement: raw,
      statementSha256: parsed.sha256,
      manifestKey: manifest.key,
      manifestSha256: manifest.sha256,
      manifestSize: manifest.size,
      layoutSha256: layout?.sha256 ?? null,
      layoutSize: layout?.size ?? null,
      systemStateManifestSha256: systemState?.sha256 ?? null,
      systemStateManifestSize: systemState?.size ?? null,
      status: verificationMode === 'producer_only' ? 'producer_only' : 'pending',
    },
  };
}

export type RecordSnapshotAttestationDeps = {
  enqueueVerification: (snapshotDbId: string) => Promise<unknown>;
};

const defaultRecordDeps: RecordSnapshotAttestationDeps = {
  enqueueVerification: async (snapshotDbId) => {
    const { enqueueSnapshotAttestationVerification } = await import('../jobs/backupSnapshotAttestationWorker');
    return enqueueSnapshotAttestationVerification(snapshotDbId);
  },
};

const GUARD_REFUSAL_CODES = new Set(['42501', '23514', '23503']);

function pgErrorCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.cause?.code ?? e?.code;
  return typeof code === 'string' ? code : undefined;
}

async function projectIntegrityStatus(snapshotDbId: string, status: BackupSnapshotIntegrityStatus): Promise<void> {
  // A failed attestation decision is final for the snapshot: nothing later
  // downgrades or replaces it.
  await db
    .update(backupSnapshots)
    .set({ integrityStatus: status })
    .where(and(eq(backupSnapshots.id, snapshotDbId), ne(backupSnapshots.integrityStatus, 'attestation_failed')));
  // Nothing can read the snapshot any more: verifications waiting on it end
  // now, with the integrity reason, rather than at their timeout.
  if (status === 'attestation_failed') await settleVerificationsForFailedAttestation(snapshotDbId);
}

/**
 * Records what an authenticated agent result says about one snapshot's
 * attestation. Runs inside the caller's DB context and transaction (the one
 * that wrote the snapshot row); the insert is a savepoint, so a refusal never
 * aborts the caller's transaction.
 *
 * Compare-and-set: the first accepted statement for a snapshot is final. A
 * byte-identical re-send is `duplicate_same`; any other statement is
 * `conflict` and leaves the existing row untouched. Storage reconciliation
 * never calls this.
 */
export async function recordSnapshotAttestation(
  input: RecordSnapshotAttestationInput,
  deps: RecordSnapshotAttestationDeps = defaultRecordDeps,
): Promise<{ outcome: RecordAttestationOutcome; reason?: string }> {
  const evaluation = evaluateSnapshotAttestation(input);

  // Serializes concurrent results for the same snapshot.
  const [snapshot] = await db
    .select({ integrityStatus: backupSnapshots.integrityStatus })
    .from(backupSnapshots)
    .where(eq(backupSnapshots.id, input.snapshotDbId))
    .for('update');

  let outcome: RecordAttestationOutcome;
  let reason: string | undefined;
  let recordedMode: 'server_fetched' | 'producer_only' | null = null;

  const [existing] = snapshot
    ? await db
        .select({ statementSha256: backupSnapshotAttestations.statementSha256 })
        .from(backupSnapshotAttestations)
        .where(eq(backupSnapshotAttestations.snapshotDbId, input.snapshotDbId))
        .limit(1)
    : [];

  if (!snapshot) {
    outcome = 'binding_mismatch';
    reason = 'snapshot_not_visible';
  } else if (existing) {
    if (evaluation.kind === 'absent') {
      outcome = evaluation.outcome;
    } else {
      const raw = attestationStatementOf(input.attestation);
      outcome = raw !== null && statementSha256(raw) === existing.statementSha256 ? 'duplicate_same' : 'conflict';
      if (outcome === 'conflict') reason = 'different_statement';
    }
  } else if (evaluation.kind === 'absent') {
    outcome = evaluation.outcome;
    // Only a helper that reported it predates attestations keeps the legacy
    // projection; an unreported one is treated like a capable one, as the
    // backup worker does when it picks an incremental base.
    const version = input.deviceIntegrityProtocolVersion;
    const knownLegacy = version !== null && version < 1;
    if (outcome === 'missing_from_capable' || outcome === 'capability_unknown'
      || (outcome === 'missing_expectation' && !knownLegacy)) {
      await projectIntegrityStatus(input.snapshotDbId, 'unattested');
    }
  } else if (evaluation.kind === 'refuse') {
    outcome = evaluation.outcome;
    reason = evaluation.reason;
    await projectIntegrityStatus(input.snapshotDbId, 'attestation_failed');
  } else if (snapshot.integrityStatus === 'attestation_failed') {
    outcome = 'conflict';
    reason = 'previously_failed';
  } else {
    let inserted: { id: string }[] = [];
    let refusedByGuard = false;
    try {
      inserted = await db.transaction((tx) =>
        tx
          .insert(backupSnapshotAttestations)
          .values(evaluation.row)
          .onConflictDoNothing({ target: backupSnapshotAttestations.snapshotDbId })
          .returning({ id: backupSnapshotAttestations.id }),
      );
    } catch (err) {
      if (!GUARD_REFUSAL_CODES.has(pgErrorCode(err) ?? '')) throw err;
      refusedByGuard = true;
    }
    if (refusedByGuard) {
      outcome = 'binding_mismatch';
      reason = 'parent_binding';
      await projectIntegrityStatus(input.snapshotDbId, 'attestation_failed');
    } else if (inserted.length > 0) {
      outcome = 'recorded';
      recordedMode = evaluation.row.verificationMode;
      await projectIntegrityStatus(
        input.snapshotDbId,
        recordedMode === 'producer_only' ? 'producer_only' : 'pending',
      );
    } else {
      const [winner] = await db
        .select({ statementSha256: backupSnapshotAttestations.statementSha256 })
        .from(backupSnapshotAttestations)
        .where(eq(backupSnapshotAttestations.snapshotDbId, input.snapshotDbId))
        .limit(1);
      outcome = winner?.statementSha256 === evaluation.row.statementSha256 ? 'duplicate_same' : 'conflict';
      if (outcome === 'conflict') reason = 'different_statement';
    }
  }

  recordBackupAttestation(outcome);

  if (outcome === 'conflict' || outcome === 'binding_mismatch') {
    const details = { snapshotDbId: input.snapshotDbId, jobId: input.jobId, outcome, reason: reason ?? null };
    console.warn(
      `[BackupAttestation] Refused the attestation reported for snapshot ${input.snapshotDbId} ` +
        `(job ${input.jobId}, device ${input.deviceId}): ${outcome}${reason ? ` (${reason})` : ''}`,
    );
    runAfterDbContextExit('backupAttestation.auditRejected', () =>
      createAuditLogAsync({
        orgId: input.orgId,
        actorType: 'system',
        actorId: '00000000-0000-0000-0000-000000000000',
        action: 'backup.snapshot.attestation_rejected',
        resourceType: 'backup_snapshot',
        resourceId: input.snapshotDbId,
        result: 'failure',
        details,
      }),
    );
  }

  if (recordedMode === 'server_fetched') {
    const snapshotDbId = input.snapshotDbId;
    // Idempotent (snapshot-scoped job id); also safe if the caller's
    // transaction rolls back — the verifier then finds no row.
    runAfterDbContextExit('backupAttestation.enqueueVerification', async () => {
      try {
        await deps.enqueueVerification(snapshotDbId);
      } catch (err) {
        // The periodic pending sweep re-enqueues it.
        console.error(`[BackupAttestation] Failed to enqueue verification for snapshot ${snapshotDbId}:`, err);
      }
    });
  }

  return reason ? { outcome, reason } : { outcome };
}

// ── Entry points for backupResultPersistence.ts ─────────────────────────────

/**
 * The job an existing attestation for this snapshot row was recorded for, or
 * null when the snapshot has none. Persistence refuses to rewrite a snapshot
 * row on behalf of any other job, so the row and its attestation keep
 * describing the same run.
 */
export async function attestedJobIdForSnapshot(snapshotDbId: string): Promise<string | null> {
  const [row] = await db
    .select({ jobId: backupSnapshotAttestations.jobId })
    .from(backupSnapshotAttestations)
    .where(eq(backupSnapshotAttestations.snapshotDbId, snapshotDbId))
    .limit(1);
  return row?.jobId ?? null;
}

/** The parts of a parsed backup result the attestation step reads. */
export type AttestationResultFields = {
  attestation?: unknown;
  layoutManifest?: unknown;
  systemStateManifest?: unknown;
  referencedFiles?: number;
};

async function loadDeviceIntegrity(deviceId: string): Promise<{ agentId: string | null; integrityVersion: number | null }> {
  const [device] = await db
    .select({ agentId: devices.agentId, integrityVersion: devices.backupIntegrityProtocolVersion })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  // NULL (not reported) stays null: it is not evidence of an older helper.
  return { agentId: device?.agentId ?? null, integrityVersion: device?.integrityVersion ?? null };
}

/**
 * Runs `work` in a savepoint and never lets it fail the backup result: the
 * snapshot row is already written and must survive. A failure is reported and
 * leaves the snapshot's integrity status as it was.
 */
async function isolated<T>(label: string, snapshotDbId: string, work: () => Promise<T>): Promise<T | null> {
  try {
    // A savepoint with the ambient executor rebound to it, so a failed
    // statement inside never aborts the caller's transaction.
    return hasDbAccessContext() ? await withDbTransaction(work) : await work();
  } catch (err) {
    const message = `[BackupAttestation] ${label} failed for snapshot ${snapshotDbId}`;
    console.error(message, err);
    captureException(err instanceof Error ? err : new Error(message));
    return null;
  }
}

/**
 * The attestation step for a snapshot row written from an agent result. Only
 * called when the row was created by this result, or was already created by
 * an earlier agent result (never for a row storage reconciliation created —
 * that is `attestLateAgentResult`'s job, under its own rules).
 */
export async function attestAgentResultSnapshot(params: {
  snapshotDbId: string;
  orgId: string;
  jobId: string;
  deviceId: string;
  providerSnapshotId: string;
  storageIdentity: string | null;
  pinnedBaseProviderSnapshotId: string | null;
  dispatchExpectationVerified: boolean;
  resultReceivedAt: Date;
  result: AttestationResultFields;
}, deps?: RecordSnapshotAttestationDeps): Promise<RecordAttestationOutcome | null> {
  const recorded = await isolated('attestation step', params.snapshotDbId, async () => {
    const device = await loadDeviceIntegrity(params.deviceId);
    return recordSnapshotAttestation({
      snapshotDbId: params.snapshotDbId,
      orgId: params.orgId,
      jobId: params.jobId,
      deviceId: params.deviceId,
      providerSnapshotId: params.providerSnapshotId,
      storageIdentity: params.storageIdentity,
      pinnedBaseProviderSnapshotId: params.pinnedBaseProviderSnapshotId,
      reportsLayout: Boolean(params.result.layoutManifest),
      reportsSystemState: Boolean(params.result.systemStateManifest),
      referencedFiles: params.result.referencedFiles,
      deviceAgentId: device.agentId,
      deviceIntegrityProtocolVersion: device.integrityVersion,
      acceptedVia: 'agent_result',
      dispatchExpectationVerified: params.dispatchExpectationVerified,
      resultReceivedAt: params.resultReceivedAt,
      attestation: params.result.attestation,
    }, deps);
  });
  return recorded?.outcome ?? null;
}

/**
 * A successful agent result that arrives after storage reconciliation already
 * adopted its snapshot (the job is terminal, so the normal path drops it).
 * The producing device's own statement may still attest that row, and only
 * that row: same job, same device, same snapshot id, a row reconciliation
 * created, and a result bound to a consumed dispatch expectation. Nothing
 * else about the job or snapshot changes.
 *
 * Returns the snapshot row id when such a row exists (whatever the outcome),
 * or null when this result has no reconciled row to speak for.
 */
export async function attestLateAgentResult(params: {
  jobId: string;
  deviceId: string;
  providerSnapshotId: string;
  dispatchExpectationVerified: boolean;
  resultReceivedAt: Date;
  result: AttestationResultFields;
}, deps?: RecordSnapshotAttestationDeps): Promise<{ snapshotDbId: string; outcome: RecordAttestationOutcome | null } | null> {
  if (!params.dispatchExpectationVerified) return null;

  const [row] = await db
    .select({
      id: backupSnapshots.id,
      orgId: backupSnapshots.orgId,
      storageIdentity: backupSnapshots.storageIdentity,
      resultProvenance: backupSnapshots.resultProvenance,
    })
    .from(backupSnapshots)
    .where(
      and(
        eq(backupSnapshots.jobId, params.jobId),
        eq(backupSnapshots.deviceId, params.deviceId),
        eq(backupSnapshots.snapshotId, params.providerSnapshotId),
        inArray(backupSnapshots.resultProvenance, ['reconcile', 'agent_result_after_reconcile']),
      ),
    )
    .limit(1);
  if (!row) return null;

  const outcome = await isolated('late attestation step', row.id, async () => {
    const [job] = await db
      .select({ baseSnapshotId: backupJobs.baseSnapshotId })
      .from(backupJobs)
      .where(and(eq(backupJobs.id, params.jobId), eq(backupJobs.deviceId, params.deviceId)))
      .limit(1);
    if (!job) return null;
    const device = await loadDeviceIntegrity(params.deviceId);
    const recorded = await recordSnapshotAttestation({
      snapshotDbId: row.id,
      orgId: row.orgId,
      jobId: params.jobId,
      deviceId: params.deviceId,
      providerSnapshotId: params.providerSnapshotId,
      storageIdentity: row.storageIdentity,
      pinnedBaseProviderSnapshotId: job.baseSnapshotId,
      reportsLayout: Boolean(params.result.layoutManifest),
      reportsSystemState: Boolean(params.result.systemStateManifest),
      referencedFiles: params.result.referencedFiles,
      deviceAgentId: device.agentId,
      deviceIntegrityProtocolVersion: device.integrityVersion,
      acceptedVia: 'late_agent_result',
      dispatchExpectationVerified: true,
      resultReceivedAt: params.resultReceivedAt,
      attestation: params.result.attestation,
    }, deps);
    if (recorded.outcome === 'recorded') {
      await db
        .update(backupSnapshots)
        .set({ resultProvenance: 'agent_result_after_reconcile' })
        .where(and(eq(backupSnapshots.id, row.id), eq(backupSnapshots.resultProvenance, 'reconcile')));
    }
    return recorded.outcome;
  });
  return { snapshotDbId: row.id, outcome };
}
