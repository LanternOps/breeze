import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  backupJobs,
  backupSnapshotFiles,
  backupSnapshots,
  backupPolicies,
  configPolicyBackupSettings,
  backupConfigs,
  IN_FLIGHT_BACKUP_JOB_STATUSES,
  STALE_BACKUP_REAP_MARKER,
} from '../db/schema';
import { captureException, captureMessage } from './sentry';
import { backupChains } from '../db/schema/applicationBackup';
import {
  applyGfsTagsToSnapshot,
  computeExpiresAt,
  resolveGfsConfigForJob,
} from '../jobs/backupRetention';
import type { ParsedBackupCommandResult } from '../routes/backup/resultSchemas';
import {
  applyBackupSnapshotImmutability,
  checkBackupProviderCapabilities,
} from './backupSnapshotStorage';
import { resolveBackupProtectionForDevice } from './featureConfigResolver';
import { redactSecretsDeep, redactSecretsFromOutput } from './secretRedaction';

type SnapshotImmutabilityEnforcement = 'application' | 'provider';

type SnapshotProtectionSettings = {
  legalHold: boolean;
  legalHoldReason: string | null;
  isImmutable: boolean;
  immutableUntil: Date | null;
  immutabilityEnforcement: SnapshotImmutabilityEnforcement | null;
  requestedImmutabilityEnforcement: SnapshotImmutabilityEnforcement | null;
  legalHoldSource: 'policy' | 'manual' | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Prefix stamped onto a job's pre-existing `error_log` when a #3006 reconcile
 * adoption flips it to `completed`. The run really did fail as far as the
 * agent was concerned; the objects merely survived. Keeping the original text
 * (rather than nulling it, as the agent path does) preserves why.
 */
export const RECONCILE_PRIOR_ERROR_PREFIX = '[reconciled-from-storage] prior failure: ';

function normalizeMetadata(
  metadata: ParsedBackupCommandResult['metadata']
): Record<string, unknown> {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? { ...metadata }
    : {};
}

/**
 * Bounds on the agent-supplied VSS diagnostics blob persisted to
 * `backup_jobs.vss_metadata` (#3027).
 *
 * The result schema is deliberately permissive (an unmodeled field must never
 * fail the parse and take the snapshot id down with it — the F13 lesson), so
 * the bounding lives HERE, at the last hop before the column. It has to: the
 * only ceiling on the way in is the 5 MB `stdout` cap in agentWs's
 * `commandResultSchema`, which `backup_run` rides because it is not a
 * "critical family" and so never reaches the 512 KB structured cap in
 * `ensureCriticalResultSizeLimits`.
 *
 * Real-world size is tiny — a Windows box registers a few dozen VSS writers —
 * so any result anywhere near these limits is a bug or a hostile agent, and
 * truncating it is strictly better than storing it.
 */
const MAX_VSS_METADATA_BYTES = 64 * 1024;
const MAX_VSS_STRING_LENGTH = 1024;
/**
 * Deliberately small enough that the two string arrays cannot, together, blow
 * the total budget: 2 × 24 × (1024 + overhead) stays well under 64 KiB. An
 * earlier 200 let `unprotectedVolumes` alone reach ~205 KB, which forced the
 * pathological tier and threw away the very field the tier above it exists to
 * preserve. 24 is also far more than any real machine reports — a box with 24
 * unprotected volumes has a bigger problem than a truncated list.
 */
const MAX_VSS_ARRAY_ENTRIES = 24;

/** Actual jsonb cost. `String.length` counts UTF-16 code units, so a non-ASCII
 *  volume label or writer name can be 3× its length in bytes. */
function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

function boundVssString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length > MAX_VSS_STRING_LENGTH
    ? `${value.slice(0, MAX_VSS_STRING_LENGTH)}…[truncated]`
    : value;
}

/**
 * Bound a string array, reporting BOTH loss modes separately: entries past the
 * cap, and entries removed because they were not strings.
 *
 * The second is the one that matters. `unprotectedVolumes: [{volume:'D:\\'}]`
 * from a future or buggy agent would otherwise reduce to `[]`, the UI's
 * `length > 0` check would read "no unprotected volumes", and a degraded
 * snapshot would present as clean — #3027's exact failure mode, reintroduced a
 * layer up. Silence is the bug; a note is the fix.
 */
function boundVssStringArray(
  value: unknown,
): { entries: string[]; dropped: number; illTyped: number } | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((entry): entry is string => typeof entry === 'string');
  return {
    entries: strings
      .slice(0, MAX_VSS_ARRAY_ENTRIES)
      .map((entry) => boundVssString(entry) as string),
    dropped: Math.max(0, strings.length - MAX_VSS_ARRAY_ENTRIES),
    illTyped: value.length - strings.length,
  };
}

/**
 * Normalize + bound + redact the agent's `vssMetadata` before it becomes a
 * jsonb column value. Returns `undefined` when there is nothing to persist, so
 * a legacy agent (which omits the field entirely) leaves the column untouched
 * rather than overwriting a previously-recorded value with NULL.
 *
 * Rebuilt field-by-field rather than stored verbatim: the field arrives as
 * `z.unknown()` at both validation boundaries (deliberately — see the schema
 * comments), so nothing upstream has constrained its shape or size at all.
 * Handing an arbitrary agent-authored object straight to jsonb would persist
 * exactly the unbounded surface these caps exist to remove.
 *
 * Unmodeled TOP-LEVEL keys survive only when scalar — the same "keep scalars,
 * drop containers" rule the agent's own IPC bounding uses (`reduceToScalars`,
 * agent/cmd/breeze-backup/result_bounds.go), so a future agent field is
 * forward-compatible without reopening the hole.
 *
 * NOTHING IS DROPPED SILENTLY. Every loss — count caps, type mismatches,
 * unmodeled containers, size tiers — is named in the persisted `warnings`
 * array, which the UI renders. That is not tidiness: this whole issue exists
 * because a degraded backup reached the server looking clean, and a sanitizer
 * that quietly reduces `unprotectedVolumes` to `[]` would recreate it here.
 */
export function sanitizeVssMetadata(
  raw: ParsedBackupCommandResult['vssMetadata'],
): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;

  const source = raw as Record<string, unknown>;
  const notes: string[] = [];
  const out: Record<string, unknown> = {};
  const MODELED_KEYS = new Set([
    'shadowCopyId', 'creationTime', 'writers', 'exposedPaths',
    'unprotectedVolumes', 'warnings', 'durationMs',
  ]);

  // Unmodeled scalars are kept; unmodeled containers are dropped — but NAMED,
  // so a new agent field that silently does nothing in production is findable
  // instead of a mystery. Modeled keys are handled below and skipped here so a
  // modeled key can never be shadowed by this pass.
  const droppedContainers: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (MODELED_KEYS.has(key)) continue;
    if (value === null || typeof value === 'boolean' || typeof value === 'number') {
      out[key] = value;
    } else if (typeof value === 'string') {
      out[key] = boundVssString(value);
    } else if (value !== undefined) {
      droppedContainers.push(key);
    }
  }
  if (droppedContainers.length > 0) {
    notes.push(`unmodeled VSS field(s) dropped: ${droppedContainers.sort().join(', ')}`);
  }

  const shadowCopyId = boundVssString(source.shadowCopyId);
  if (shadowCopyId !== undefined) out.shadowCopyId = shadowCopyId;
  const creationTime = boundVssString(source.creationTime);
  if (creationTime !== undefined) out.creationTime = creationTime;
  if (typeof source.durationMs === 'number' && Number.isFinite(source.durationMs)) {
    out.durationMs = source.durationMs;
  }

  if (Array.isArray(source.writers)) {
    const writers = source.writers.filter(
      (writer): writer is Record<string, unknown> =>
        Boolean(writer) && typeof writer === 'object' && !Array.isArray(writer),
    );
    out.writers = writers.slice(0, MAX_VSS_ARRAY_ENTRIES).map((writer) => {
      const bounded: Record<string, unknown> = {};
      for (const field of ['name', 'id', 'state', 'lastError'] as const) {
        const value = boundVssString(writer[field]);
        if (value !== undefined) bounded[field] = value;
      }
      return bounded;
    });
    if (writers.length > MAX_VSS_ARRAY_ENTRIES) {
      notes.push(`${writers.length - MAX_VSS_ARRAY_ENTRIES} additional VSS writer entries were dropped`);
    }
    if (source.writers.length > writers.length) {
      notes.push(`${source.writers.length - writers.length} VSS writer entries were dropped: not objects`);
    }
  } else if (source.writers !== undefined && source.writers !== null) {
    notes.push('VSS writer detail was dropped: the agent did not report it as a list');
  }

  const unprotected = boundVssStringArray(source.unprotectedVolumes);
  if (unprotected) {
    out.unprotectedVolumes = unprotected.entries;
    if (unprotected.dropped > 0) {
      notes.push(`${unprotected.dropped} additional unprotected-volume entries were dropped`);
    }
    if (unprotected.illTyped > 0) {
      // Load-bearing: an empty unprotectedVolumes reads as "clean snapshot".
      notes.push(`${unprotected.illTyped} unprotected-volume entries were dropped: not strings — this run may have read volumes live`);
    }
  } else if (source.unprotectedVolumes !== undefined && source.unprotectedVolumes !== null) {
    notes.push('unprotected-volume detail was dropped: the agent did not report it as a list — this run may have read volumes live');
  }

  if (source.exposedPaths && typeof source.exposedPaths === 'object' && !Array.isArray(source.exposedPaths)) {
    const all = Object.entries(source.exposedPaths as Record<string, unknown>);
    const entries = all.filter((entry): entry is [string, string] => typeof entry[1] === 'string');
    out.exposedPaths = Object.fromEntries(
      entries.slice(0, MAX_VSS_ARRAY_ENTRIES).map(([volume, path]) => [volume, boundVssString(path) as string]),
    );
    if (entries.length > MAX_VSS_ARRAY_ENTRIES) {
      notes.push(`${entries.length - MAX_VSS_ARRAY_ENTRIES} additional shadow-path entries were dropped`);
    }
    if (all.length > entries.length) {
      notes.push(`${all.length - entries.length} shadow-path entries were dropped: not strings`);
    }
  }

  const warnings = boundVssStringArray(source.warnings);
  const warningEntries = warnings ? [...warnings.entries] : [];
  if (warnings) {
    if (warnings.dropped > 0) {
      notes.push(`${warnings.dropped} additional VSS warnings were dropped`);
    }
    if (warnings.illTyped > 0) {
      notes.push(`${warnings.illTyped} VSS warnings were dropped: not strings`);
    }
  } else if (typeof source.warnings === 'string') {
    // A scalar `warnings` used to be copied by the unmodeled-scalar pass and
    // then ERASED by finish()'s delete. Keep the text — it is a warning.
    warningEntries.push(boundVssString(source.warnings) as string);
  } else if (source.warnings !== undefined && source.warnings !== null) {
    notes.push('VSS warning text was dropped: the agent did not report it as a list');
  }

  const finish = (extraNotes: string[]): Record<string, unknown> => {
    const combined = [...warningEntries, ...notes, ...extraNotes];
    if (combined.length > 0) out.warnings = combined;
    else delete out.warnings;
    return redactSecretsDeep(out) as Record<string, unknown>;
  };

  let result = finish([]);
  if (jsonByteLength(result) <= MAX_VSS_METADATA_BYTES) return result;

  // Still oversize: drop the bulk containers, keeping the scalars and the
  // unprotected-volume list (the field that actually says "this snapshot is
  // incomplete"). Mirrors the agent's tier-2 bulk-field drop.
  delete out.writers;
  delete out.exposedPaths;
  result = finish(['VSS writer and shadow-path detail was dropped: the reported metadata exceeded the size limit']);
  if (jsonByteLength(result) <= MAX_VSS_METADATA_BYTES) return result;

  // Pathological — only reachable if the caps above were somehow not enough.
  // Even here, keep `unprotectedVolumes`: discarding it is the one loss that
  // turns a degraded snapshot back into a clean-looking one, which is the
  // entire bug class this function guards.
  //
  // Redacted like every other return: `out` holds pre-redaction values (finish()
  // returns a redacted COPY and leaves `out` untouched), so reading fields off it
  // here without redacting would make this the one path that persists agent text
  // raw. Every exit from this function must be redacted, or the guarantee is not
  // a guarantee.
  const survivingVolumes = Array.isArray(out.unprotectedVolumes)
    ? (out.unprotectedVolumes as string[]).slice(0, MAX_VSS_ARRAY_ENTRIES)
    : [];
  return redactSecretsDeep({
    ...(survivingVolumes.length > 0 ? { unprotectedVolumes: survivingVolumes } : {}),
    warnings: ['VSS metadata was discarded: the reported payload exceeded the size limit'],
  }) as Record<string, unknown>;
}

function resolveSnapshotEncryptionKeyId(metadata: Record<string, unknown>): string | null {
  const direct = getStringValue(metadata, 'encryptionKeyId');
  if (direct && UUID_PATTERN.test(direct)) {
    return direct;
  }

  const encryption = metadata.encryption;
  if (encryption && typeof encryption === 'object' && !Array.isArray(encryption)) {
    const nested = getStringValue(encryption as Record<string, unknown>, 'keyId');
    if (nested && UUID_PATTERN.test(nested)) {
      return nested;
    }
  }

  return null;
}

function getStringValue(
  metadata: Record<string, unknown>,
  key: string
): string | null {
  const value = metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function getFirstStringValue(
  metadata: Record<string, unknown>,
  keys: string[]
): string | null {
  for (const key of keys) {
    const value = getStringValue(metadata, key);
    if (value) {
      return value;
    }
  }
  return null;
}

function buildSnapshotLabel(
  metadata: Record<string, unknown>,
  timestamp: Date,
): string {
  const vmName = getStringValue(metadata, 'vmName');
  if (metadata.backupKind === 'hyperv_export' && vmName) {
    return `Hyper-V ${vmName} ${timestamp.toISOString().slice(0, 10)}`;
  }

  const database = getFirstStringValue(metadata, ['database', 'databaseName']);
  if ((metadata.backupKind === 'mssql_database' || metadata.backupKind === 'mssql_backup') && database) {
    const subtype = getFirstStringValue(metadata, ['backupSubtype', 'mssqlBackupType']);
    const suffix = subtype ? ` ${subtype}` : '';
    return `MSSQL ${database}${suffix} ${timestamp.toISOString().slice(0, 10)}`;
  }

  return `Backup ${timestamp.toISOString().slice(0, 10)}`;
}

function computeImmutableUntil(
  timestamp: Date,
  immutableDays: number | null,
): Date | null {
  if (!immutableDays || immutableDays < 1) {
    return null;
  }

  const immutableUntil = new Date(timestamp);
  immutableUntil.setUTCDate(immutableUntil.getUTCDate() + immutableDays);
  return immutableUntil;
}

function mergeSnapshotProtectionMetadata(
  metadata: Record<string, unknown>,
  updates: { legalHoldSource?: 'policy' | 'manual' | null },
): Record<string, unknown> {
  const currentProtection =
    metadata.snapshotProtection && typeof metadata.snapshotProtection === 'object' && !Array.isArray(metadata.snapshotProtection)
      ? { ...(metadata.snapshotProtection as Record<string, unknown>) }
      : {};

  const nextProtection = {
    ...currentProtection,
    ...(updates.legalHoldSource === undefined
      ? {}
      : updates.legalHoldSource === null
        ? { legalHoldSource: null }
        : { legalHoldSource: updates.legalHoldSource }),
  };

  return {
    ...metadata,
    snapshotProtection: nextProtection,
  };
}

async function resolveSnapshotProtectionSettingsForJob(
  jobId: string,
  timestamp: Date,
): Promise<SnapshotProtectionSettings> {
  const defaults: SnapshotProtectionSettings = {
    legalHold: false,
    legalHoldReason: null,
    isImmutable: false,
    immutableUntil: null,
    immutabilityEnforcement: null,
    requestedImmutabilityEnforcement: null,
    legalHoldSource: null,
  };

  const [job] = await db
    .select({
      featureLinkId: backupJobs.featureLinkId,
      policyId: backupJobs.policyId,
      deviceId: backupJobs.deviceId,
    })
    .from(backupJobs)
    .where(eq(backupJobs.id, jobId))
    .limit(1);

  if (!job) {
    return defaults;
  }

  if (job.deviceId && job.featureLinkId) {
    const resolved = await resolveBackupProtectionForDevice(job.deviceId);
    if (resolved) {
      const immutableUntil = computeImmutableUntil(timestamp, resolved.immutableDays);
      return {
        legalHold: resolved.legalHold,
        legalHoldReason: resolved.legalHoldReason,
        isImmutable: resolved.immutabilityMode !== null && immutableUntil !== null,
        immutableUntil,
        immutabilityEnforcement: resolved.immutabilityMode,
        requestedImmutabilityEnforcement: resolved.immutabilityMode,
        legalHoldSource: resolved.legalHold ? 'policy' : null,
      };
    }
  }

  if (job.featureLinkId) {
    const [settings] = await db
      .select({
        retention: configPolicyBackupSettings.retention,
      })
      .from(configPolicyBackupSettings)
      .where(eq(configPolicyBackupSettings.featureLinkId, job.featureLinkId))
      .limit(1);

    const retention =
      settings?.retention && typeof settings.retention === 'object' && !Array.isArray(settings.retention)
        ? settings.retention as Record<string, unknown>
        : null;

    const legalHold = retention?.legalHold === true;
    const legalHoldReason =
      typeof retention?.legalHoldReason === 'string' && retention.legalHoldReason.trim().length > 0
        ? retention.legalHoldReason.trim()
        : null;
    const immutabilityMode =
      retention?.immutabilityMode === 'application' || retention?.immutabilityMode === 'provider'
        ? retention.immutabilityMode
        : null;
    const immutableDays =
      typeof retention?.immutableDays === 'number' && retention.immutableDays > 0
        ? retention.immutableDays
        : null;

    const immutableUntil =
      immutabilityMode === 'application' || immutabilityMode === 'provider'
        ? computeImmutableUntil(timestamp, immutableDays)
        : null;

    return {
      legalHold,
      legalHoldReason,
      isImmutable:
        (immutabilityMode === 'application' || immutabilityMode === 'provider') &&
        immutableUntil !== null,
      immutableUntil,
      immutabilityEnforcement: immutabilityMode,
      requestedImmutabilityEnforcement: immutabilityMode,
      legalHoldSource: legalHold ? 'policy' : null,
    };
  }

  if (job.policyId) {
    const [policy] = await db
      .select({
        legalHold: backupPolicies.legalHold,
        legalHoldReason: backupPolicies.legalHoldReason,
      })
      .from(backupPolicies)
      .where(eq(backupPolicies.id, job.policyId))
      .limit(1);

    return {
      ...defaults,
      legalHold: policy?.legalHold === true,
      legalHoldReason:
        typeof policy?.legalHoldReason === 'string' && policy.legalHoldReason.trim().length > 0
          ? policy.legalHoldReason.trim()
          : null,
      legalHoldSource: policy?.legalHold === true ? 'policy' : null,
    };
  }

  return defaults;
}

async function resolveBackupConfigStorage(
  configId: string | null,
): Promise<{ provider: string | null; providerConfig: unknown } | null> {
  if (!configId) return null;

  const [config] = await db
    .select({
      provider: backupConfigs.provider,
      providerConfig: backupConfigs.providerConfig,
    })
    .from(backupConfigs)
    .where(eq(backupConfigs.id, configId))
    .limit(1);

  return config ?? null;
}

async function reconcileMssqlBackupChain(params: {
  orgId: string;
  deviceId: string;
  configId: string | null;
  snapshotDbId: string;
  timestamp: Date;
  metadata: Record<string, unknown>;
}): Promise<void> {
  const { orgId, deviceId, configId, snapshotDbId, timestamp, metadata } = params;

  if ((metadata.backupKind !== 'mssql_database' && metadata.backupKind !== 'mssql_backup') || !configId) {
    return;
  }

  const instance = getFirstStringValue(metadata, ['instance', 'instanceName']);
  const database = getFirstStringValue(metadata, ['database', 'databaseName']);
  const backupSubtype = getFirstStringValue(metadata, ['backupSubtype', 'mssqlBackupType']) ?? 'full';
  if (!instance || !database) {
    return;
  }

  const firstLsn = getStringValue(metadata, 'firstLsn');
  const lastLsn = getStringValue(metadata, 'lastLsn');
  const databaseBackupLsn = getStringValue(metadata, 'databaseBackupLsn');

  const [existingChain] = await db
    .select({
      id: backupChains.id,
      fullSnapshotId: backupChains.fullSnapshotId,
      chainMetadata: backupChains.chainMetadata,
    })
    .from(backupChains)
    .where(
      and(
        eq(backupChains.orgId, orgId),
        eq(backupChains.deviceId, deviceId),
        eq(backupChains.configId, configId),
        eq(backupChains.chainType, 'mssql'),
        eq(backupChains.targetName, database),
        eq(backupChains.targetId, instance)
      )
    )
    .limit(1);

  const existingMetadata =
    existingChain?.chainMetadata &&
    typeof existingChain.chainMetadata === 'object' &&
    !Array.isArray(existingChain.chainMetadata)
      ? { ...(existingChain.chainMetadata as Record<string, unknown>) }
      : {};

  const baseDatabaseBackupLsn =
    backupSubtype === 'full'
      ? databaseBackupLsn
      : getStringValue(existingMetadata, 'baseDatabaseBackupLsn');

  let health = 'active';
  let continuity = 'ok';
  let isActive = true;
  if (backupSubtype !== 'full') {
    if (!existingChain?.fullSnapshotId) {
      health = 'broken';
      continuity = 'missing_full_backup';
      isActive = false;
    } else if (
      baseDatabaseBackupLsn &&
      databaseBackupLsn &&
      baseDatabaseBackupLsn !== databaseBackupLsn
    ) {
      health = 'broken';
      continuity = 'database_backup_lsn_mismatch';
      isActive = false;
    }
  }

  const chainMetadata = {
    ...existingMetadata,
    health,
    continuity,
    instance,
    database,
    lastBackupAt: timestamp.toISOString(),
    lastBackupType: backupSubtype,
    lastFirstLsn: firstLsn,
    lastLastLsn: lastLsn,
    lastDatabaseBackupLsn: databaseBackupLsn,
    baseDatabaseBackupLsn,
    fullFirstLsn:
      backupSubtype === 'full'
        ? firstLsn
        : getStringValue(existingMetadata, 'fullFirstLsn'),
    fullLastLsn:
      backupSubtype === 'full'
        ? lastLsn
        : getStringValue(existingMetadata, 'fullLastLsn'),
  };

  const values = {
    orgId,
    deviceId,
    configId,
    chainType: 'mssql',
    targetName: database,
    targetId: instance,
    isActive,
    fullSnapshotId: backupSubtype === 'full' ? snapshotDbId : existingChain?.fullSnapshotId ?? null,
    chainMetadata,
    updatedAt: new Date(),
  };

  if (existingChain?.id) {
    await db
      .update(backupChains)
      .set(values)
      .where(eq(backupChains.id, existingChain.id));
    return;
  }

  await db.insert(backupChains).values({
    ...values,
    createdAt: new Date(),
  });
}

/**
 * #3036 — one-shot guard for the diagnostic re-read's own failure capture. The
 * condition that breaks the re-read (renamed column, statement timeout) breaks
 * it for EVERY dropped result, and BullMQ retries multiply that, so Sentry gets
 * the first occurrence and `console.warn` keeps the rest. Same shape as
 * `reportedContextlessSites` in db/index.ts.
 */
let predicateMissDiagnosticFailureReported = false;

/** Test-only reset so the one-shot guard cannot leak across cases. */
export function __resetBackupPredicateMissDiagnosticGuardForTests(): void {
  predicateMissDiagnosticFailureReported = false;
}

/**
 * #3036 — explain a 0-row backup-job UPDATE.
 *
 * The write predicate is `id = jobId AND device_id = deviceId AND <status
 * guard>`. Three different things produce no row: the job is not in an adoptable
 * status (routine — a user cancel, an already-terminal job, a duplicate result);
 * the caller named a device that does not own the job (never expected; a bug or
 * a genuine cross-tenant attempt); or the job is gone/invisible. Collapsing them
 * into one "job was not in-flight" log is how a narrowed predicate becomes a
 * silent no-op, so re-read the row and say which it was.
 *
 * Every branch emits a line, including the routine status-guard case: the
 * caller's pre-existing orphan warning only fires for `isSuccessResult &&
 * providerSnapshotId`, so a dropped FAILED result (or a success with no snapshot
 * id, e.g. the `skipped` zero-file run) would otherwise leave no trace anywhere —
 * and `backupWorker.processResults` discards this function's return value and
 * logs "result processed" regardless.
 *
 * Diagnostic only: the result is dropped either way.
 *
 * The re-read runs in a NESTED `db.transaction`, i.e. a postgres.js SAVEPOINT
 * with its own `uncaughtError` scope. This is load-bearing, not cosmetic. Every
 * caller runs inside `withDbAccessContext`/`withSystemDbAccessContext`, which is
 * `sql.begin`; a statement that fails on the ambient `db` proxy both aborts the
 * outer transaction (every later statement then gets 25P02 — on the hyperv/mssql
 * routes that is the `markBackupJobFailedIfInFlight` in their catch, leaving the
 * job stuck `running`) and is re-thrown at commit even though we handled it. A
 * bare try/catch here cannot prevent either. See
 * `__tests__/integration/dbSavepointErrorIsolation.integration.test.ts` (#2189);
 * per its caveat the query MUST be issued on `tx`, not the ambient proxy.
 *
 * The re-read is subject to the ambient RLS context. Under the org-scoped
 * callers that means another tenant's job reads back as absent — but the path
 * that motivated this change (agent → BullMQ → backupWorker) runs system-scoped,
 * where RLS hides nothing, so do not treat that as the control.
 */
async function reportBackupJobPredicateMiss(params: {
  jobId: string;
  deviceId: string;
  source: 'agent' | 'reconcile';
}): Promise<void> {
  const { jobId, deviceId, source } = params;
  try {
    const [row] = await db.transaction((tx) =>
      tx
        .select({
          deviceId: backupJobs.deviceId,
          orgId: backupJobs.orgId,
          status: backupJobs.status,
        })
        .from(backupJobs)
        .where(eq(backupJobs.id, jobId))
        .limit(1)
    );

    if (!row) {
      // The job does not exist, or is invisible under the caller's RLS context.
      // NOT an error-level event: `backup_jobs` is in both the device and org
      // cascade lists, so offboarding a device (or erasing an org) with a result
      // still in the BullMQ queue reaches here legitimately, and BullMQ retries
      // would multiply it. Warning level keeps it findable without burying a
      // real cross-tenant miss.
      const msg =
        `[BackupPersistence] Backup result for job ${jobId} (reported device ${deviceId}, source: ${source}) ` +
        `matched no job row — the job was deleted, or is not visible in this tenant context.`;
      console.warn(msg);
      captureMessage(msg, {
        eventCode: 'backup_result_job_not_found',
        tags: { backup_result_source: source },
      });
      return;
    }

    if (row.deviceId !== deviceId) {
      const msg =
        `[BackupPersistence] Rejected a backup result for job ${jobId} (source: ${source}): reported by device ` +
        `${deviceId} but the job belongs to device ${row.deviceId}. The result was dropped.`;
      console.error(msg);
      captureException(new Error(msg));
      return;
    }

    // Device matches ⇒ the status guard rejected this. Routine, so log-only —
    // but log it, because for a failed result this is the ONLY signal produced.
    // `row.status` is the status at diagnosis time, read after the UPDATE.
    console.warn(
      `[BackupPersistence] Dropped a backup result for job ${jobId} (device ${deviceId}, source: ${source}): ` +
      `the job is in status "${row.status}", which the result's status guard does not admit.`
    );
  } catch (err) {
    // The re-read failed. Normally the savepoint's rollback has already restored
    // the outer transaction, so the caller's drop still lands cleanly. (Not an
    // unconditional guarantee: if the outer transaction were ALREADY aborted on
    // entry, `savepoint sN` fails before postgres.js's try block and nothing is
    // rolled back — but that caller is doomed regardless.)
    //
    // Captured, because a diagnostic that fails 100% of the time — a renamed
    // column, a statement timeout — is otherwise invisible forever. But captured
    // ONCE: that same always-failing condition fires per dropped result times
    // BullMQ retries, and this repo has burned its Sentry quota on exactly that
    // shape before (see reportContextlessWrite's per-site dedup and the
    // held-context throttle in db/index.ts). Logs stay complete either way.
    console.warn(
      `[BackupPersistence] Could not diagnose why the backup result for job ${jobId} matched no row:`,
      err instanceof Error ? err.message : err
    );
    if (!predicateMissDiagnosticFailureReported) {
      predicateMissDiagnosticFailureReported = true;
      captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
        backup_predicate_miss_diagnostic: 'true',
      });
    }
  }
}

export async function applyBackupCommandResultToJob(params: {
  jobId: string;
  orgId: string;
  deviceId: string;
  resultStatus: string;
  /**
   * The AGENT's own terminal status for the run, when it reported one. Passed
   * separately from `resultStatus` (which is the outer, binary
   * completed/failed command status) because the two collide by name on the
   * queue payload — see backupProcessResultSchema. `partial` can only ever
   * arrive here (#3000).
   */
  agentStatus?: string;
  result: ParsedBackupCommandResult & { error?: string };
  /**
   * Where this "result" came from. `'agent'` (the default) is a real terminal
   * result off the WS/queue path. `'reconcile'` (#3006) is a result synthesized
   * from a snapshot manifest found in storage by
   * `reconcileOrphanedBackupSnapshots`, which adopts already-uploaded objects
   * into a restore point for a job whose terminal result was lost in transit.
   *
   * The only behavioural difference is the status guard: a reconcile
   * completion may also flip a job the agent itself reported `failed` (no
   * stale-reaper marker), because the manifest in the bucket is direct
   * evidence the upload finished regardless of what the job row says. It still
   * must NOT resurrect a `cancelled` job — see the guard below.
   */
  source?: 'agent' | 'reconcile';
}): Promise<{
  applied: boolean;
  snapshotDbId: string | null;
  providerSnapshotId: string | null;
}> {
  const { jobId, orgId, deviceId, resultStatus, agentStatus, result, source = 'agent' } = params;
  const providerSnapshotId = result.snapshot?.id ?? result.snapshotId ?? null;
  const metadata = normalizeMetadata(result.metadata);
  const now = new Date();

  const updateData: Record<string, unknown> = {
    updatedAt: now,
    completedAt: now,
  };

  // The outer resultStatus is binary (completed/failed) — it is derived from
  // the agent's success bool, not from the agent's own terminal status. A run
  // that produced a real snapshot but lost a disproportionate share of its work
  // reports success:true with an inner status of `partial` (#3000), and MUST
  // still take the whole success path below: the snapshot is real, restorable
  // and has to get its backup_snapshots row. The ONLY difference is the status
  // value written to the job.
  //
  // Any inner status other than `partial` collapses to `completed` on purpose:
  // the agent's vocabulary includes `skipped`/`stopped`, which are not
  // backup_status enum values and would fail the UPDATE outright.
  const isSuccessResult = resultStatus === 'completed';
  let terminalStatus: 'completed' | 'partial' | 'failed';
  if (!isSuccessResult) {
    terminalStatus = 'failed';
  } else if (agentStatus === 'partial') {
    terminalStatus = 'partial';
  } else {
    // Collapse LOUDLY. Silently greening an agent status we do not model is the
    // #3000 bug class itself — `skipped` (a run that protected zero files)
    // already reaches here as success:true, and a future `degraded`/`incomplete`
    // would too. We still record `completed` (the alternative is a non-enum
    // value that fails the UPDATE outright and loses the whole result), but an
    // operator must be able to find it afterwards.
    if (agentStatus && agentStatus !== 'completed') {
      const msg =
        `[BackupPersistence] Unrecognized agent terminal status "${agentStatus}" for job ${jobId} ` +
        `(device ${deviceId}) recorded as 'completed' — the run may not be a good restore point.`;
      console.warn(msg);
      captureException(new Error(msg));
    }
    terminalStatus = 'completed';
  }

  if (isSuccessResult) {
    updateData.status = terminalStatus;
    updateData.fileCount = result.filesBackedUp ?? null;
    updateData.totalSize = result.bytesBackedUp ?? null;
    updateData.backupType = result.backupType ?? null;
    if (result.warning) {
      // #2434: warning/error are agent-supplied free text surfaced in the
      // backup UI — redact secrets before persisting to errorLog.
      updateData.errorLog = redactSecretsFromOutput(result.warning);
    } else if (source === 'reconcile') {
      // #3006: a reconcile adoption may flip a job the AGENT genuinely failed
      // (no reaper marker). Nulling error_log there would destroy the only
      // record of why the run reported failure — the exact forensic trail
      // someone needs to explain a snapshot attributed by write time alone.
      // Preserve it, marked as historical, instead of clearing it.
      // The self-match arm keeps this idempotent. Re-adoption is an EXPECTED
      // path (that is the whole reason `completed` is adoptable — see
      // ADOPTABLE_JOB_STATUSES), and without it each retry would re-prefix,
      // yielding "[reconciled-from-storage] prior failure: [reconciled-from-
      // storage] prior failure: disk full". Postgres LIKE treats only % _ \
      // as special, so the literal `[` needs no escaping.
      updateData.errorLog = sql`
        CASE
          WHEN ${backupJobs.errorLog} IS NULL THEN NULL
          WHEN ${backupJobs.errorLog} LIKE ${`%${STALE_BACKUP_REAP_MARKER}%`} THEN NULL
          WHEN ${backupJobs.errorLog} LIKE ${`${RECONCILE_PRIOR_ERROR_PREFIX}%`} THEN ${backupJobs.errorLog}
          ELSE ${RECONCILE_PRIOR_ERROR_PREFIX} || ${backupJobs.errorLog}
        END
      `;
    } else {
      // FIX 7: clear any prior error_log so a job that ultimately SUCCEEDED
      // doesn't keep showing a leftover error — in particular the stale-reaper
      // failure note when this completion is flipping a reaped job back to
      // completed (see the widened status guard below).
      updateData.errorLog = null;
    }
    if (result.errorCount !== undefined) {
      // Partial success: the agent uploaded some files but N failed — record
      // the count so the job list doesn't render a green job with 0 errors
      // over an incomplete restore point.
      updateData.errorCount = result.errorCount;
    }
    if (result.referencedBytes !== undefined) {
      // Incremental dedup: bytes referenced from a prior snapshot instead of
      // re-uploaded this run. Only write when the agent reports it — a
      // legacy agent omits the field entirely, and the column must stay NULL
      // rather than being coerced to 0.
      updateData.referencedSize = result.referencedBytes;
    }
    if (result.referencedFiles !== undefined) {
      updateData.referencedFiles = result.referencedFiles;
    }
  } else {
    updateData.status = terminalStatus;
    // Both, not either. `error` is the failure reason; `warning` is the run's
    // degradation note — on a Windows run that is where "VSS shadow copy could
    // not be created, every path was read live" lives, and there is no
    // vssMetadata on that branch to carry it instead. The old `??` chain always
    // picked `error` (it is populated on every failure path) and discarded the
    // warning entirely, so the one diagnostic explaining WHY the run was
    // degraded never reached the UI.
    const failureParts = [result.error, result.warning].filter(
      (part): part is string => typeof part === 'string' && part.length > 0
    );
    updateData.errorLog = redactSecretsFromOutput(
      // Dedupe: some paths route the same text to both fields.
      [...new Set(failureParts)].join('; ') || 'Unknown error'
    );
    if (result.backupType) {
      updateData.backupType = result.backupType;
    }
  }

  if (providerSnapshotId) {
    updateData.snapshotId = providerSnapshotId;
  }

  // #3027: VSS diagnostics land on BOTH the success and failure branches, on
  // purpose. A failed run's writer states are the more valuable of the two —
  // "which writer wedged" is the question you ask about a failure — and a
  // *successful* run whose volumes were read live is precisely the
  // "backed up, but every locked file was skipped" case that motivated this.
  // Only written when the agent reported it: a legacy agent omits the key
  // entirely, and the column must keep whatever it already held rather than be
  // overwritten with NULL.
  const vssMetadata = sanitizeVssMetadata(result.vssMetadata);
  if (vssMetadata !== undefined) {
    updateData.vssMetadata = vssMetadata;
  } else if (result.vssMetadata !== undefined && result.vssMetadata !== null) {
    // The agent sent SOMETHING and it was unusable (a bare string, a number, an
    // array). `z.unknown()` at both boundaries means nothing upstream rejected
    // it, which is correct — but absent and present-but-broken must not look
    // identical, or a fleet-wide agent regression that malformed this field is
    // invisible forever. Same treatment as an unmodeled terminal status above.
    const msg =
      `[BackupPersistence] Agent sent unusable vssMetadata (${Array.isArray(result.vssMetadata) ? 'array' : typeof result.vssMetadata}) ` +
      `for job ${jobId} (device ${deviceId}); VSS diagnostics discarded for this run.`;
    console.warn(msg);
    captureException(new Error(msg));
  }

  // FIX 7: a genuinely-successful backup whose result lands AFTER the stale
  // reaper already flagged the job `failed` must still be recorded — otherwise
  // the real, restorable snapshot sitting in the bucket is stranded with no
  // backup_snapshots row and the run is permanently mislabelled a failure. A
  // completed result may therefore flip a job that is still in-flight OR one the
  // reaper failed (its error_log carries STALE_BACKUP_REAP_MARKER). A user
  // `cancelled` job and a genuine, non-reaper agent `failed` are NOT resurrected
  // (they carry no marker / a different status).
  //
  // #3006: a reconcile-sourced completion widens the terminal half of that
  // guard to ANY `failed` job (dropping the marker requirement) plus
  // `completed`. The evidence is stronger here than for a late agent result:
  // the caller has already read `snapshots/<id>/manifest.json` out of the
  // destination bucket, so the upload demonstrably finished no matter which
  // code path failed the job. `completed` is included because this write is not
  // atomic — the job UPDATE below commits before the backup_snapshots insert,
  // so a crash between them leaves a completed job with no restore point, and
  // reconcile only ever passes such a job after confirming no row exists. The
  // snapshot write is an upsert keyed on (jobId, snapshotId), so a repeat is a
  // no-op.
  //
  // `cancelled` and `partial` remain excluded under BOTH sources: a user cancel
  // is a deliberate decision, and a `partial` job already recorded its own
  // outcome. (backupStatusEnum is pending|running|completed|failed|cancelled|
  // partial — all six are accounted for here.)
  const terminalJobGuard =
    source === 'reconcile'
      ? inArray(backupJobs.status, ['failed', 'completed'])
      : and(
          eq(backupJobs.status, 'failed'),
          like(backupJobs.errorLog, `%${STALE_BACKUP_REAP_MARKER}%`)
        );
  const statusGuard = isSuccessResult
    ? or(inArray(backupJobs.status, IN_FLIGHT_BACKUP_JOB_STATUSES), terminalJobGuard)
    : inArray(backupJobs.status, IN_FLIGHT_BACKUP_JOB_STATUSES);

  // #3036 — tenant scoping of this write.
  //
  // Until now the predicate was `id = jobId AND <status guard>` and nothing
  // else, even though `orgId`/`deviceId` are both parameters and both get
  // stamped onto the derived rows below (backup_snapshots, backup_chains).
  // RLS does NOT backstop that on the busiest path: the agent WS handler
  // enqueues the result to BullMQ and jobs/backupWorker.ts runs the write under
  // `withSystemDbAccessContext`, where `breeze_has_org_access` short-circuits to
  // TRUE. On that leg the app-layer predicate is the ONLY tenant control there
  // is. (The six other call sites do run org/request-scoped, where RLS holds:
  // agentWs.ts:327, :337 and :1631; routes/backup/hyperv.ts; routes/backup/
  // mssql.ts; services/backupSnapshotReconcile.ts.)
  //
  // The two identifiers are deliberately treated DIFFERENTLY, because they have
  // different mutability:
  //
  // - `device_id` is immutable for the life of a job — a job is created against
  //   one device and stays there; moveOrg rewrites org_id *keyed on* device_id
  //   (routes/devices/core.ts), it never rewrites device_id, and no UPDATE in
  //   apps/api/src ever targets backup_jobs.device_id. Of the seven call sites,
  //   five pass a deviceId they read off this very row (backupWorker via the
  //   Zod-required queue payload copied from it; agentWs x3; reconcile) and the
  //   two route sites (hyperv, mssql) pass the same `payload.deviceId` they
  //   INSERTed the job with two statements earlier. So binding it into the
  //   predicate cannot turn a legitimate write into a 0-row no-op, and it is the
  //   strongest available assertion: this result belongs to the device that was
  //   asked to run it.
  //
  // - `org_id` is MUTABLE and must NOT be bound here. `backup_jobs` is in
  //   CORE_DEVICE_ORG_DENORMALIZED_TABLES, so moving a device to another
  //   organization rewrites org_id in place with no drain of in-flight jobs.
  //   The worker's `orgId` is a snapshot serialized into the queue payload
  //   minutes earlier, so an org move mid-flight makes it stale. Binding a stale
  //   org_id would silently drop a real, completed backup — the "silent 0-row
  //   write" class this repo keeps re-learning, and here it would strand a
  //   restorable snapshot with no backup_snapshots row (the #3006 shape).
  //   Instead the AUTHORITATIVE org_id is read back off the updated row and used
  //   for everything derived from it (see `effectiveOrgId` below). That is what
  //   actually fixes the cross-tenant outcome: previously the stale value was
  //   written straight into backup_snapshots.org_id, producing a restore point
  //   attributed to the org the device no longer belongs to.
  //
  // Reviewed alternative (declined): bind org_id too and REJECT the write on
  // drift, on the grounds that the run was produced under the old org's config
  // and storage. Declined because moveOrg *already* re-tenants this device's
  // entire backup history — backup_jobs, backup_snapshots, backup_chains and
  // backup_verifications are all in CORE_DEVICE_ORG_DENORMALIZED_TABLES — so
  // "backup history follows the device" is a decision the product has already
  // made, and every one of that device's older snapshots was likewise produced
  // under the previous org's config. Singling out the one run that happened to
  // be in flight would be inconsistent with that, and rejecting does not undo
  // the backup: the agent has already uploaded the objects, so the only effect
  // would be to leave them with no restore point in either org.
  //
  // Known residual (not closed here): a move landing BETWEEN this UPDATE and the
  // backup_snapshots insert below still misattributes, because this function
  // deliberately is not one transaction (it makes S3 calls). This change shrinks
  // that window from enqueue-to-write (minutes) to a few statements.
  const [updatedJob] = await db
    .update(backupJobs)
    .set(updateData)
    .where(and(eq(backupJobs.id, jobId), eq(backupJobs.deviceId, deviceId), statusGuard))
    .returning({
      id: backupJobs.id,
      orgId: backupJobs.orgId,
      configId: backupJobs.configId,
      backupType: backupJobs.backupType,
      backupMode: backupJobs.backupMode,
    });

  if (!updatedJob) {
    // Narrowing the predicate above means a 0-row result now has one more
    // possible cause, so disambiguate it rather than letting a device mismatch
    // hide inside the pre-existing "not in an adoptable status" path. Diagnostic
    // only — the outcome (drop the result) is unchanged either way, and a
    // failure here must not mask the drop itself.
    await reportBackupJobPredicateMiss({ jobId, deviceId, source });

    if (isSuccessResult && providerSnapshotId) {
      // A late terminal-success we could NOT record: the job was user-cancelled,
      // already terminal by other means, or genuinely failed without the reaper
      // marker. The snapshot exists in storage but now has no backup_snapshots
      // row — surface it loudly so it is recoverable rather than silently
      // orphaned (FIX 7 fallback for the non-flippable cases).
      const orphanMsg =
        source === 'reconcile'
          ? `[BackupPersistence] Reconcile could not adopt snapshot ${providerSnapshotId} into job ${jobId} ` +
            `(device ${deviceId}): the job was no longer in an adoptable status (cancelled/partial, or it ` +
            `changed underneath the reconcile run). The snapshot remains in storage with no ` +
            `backup_snapshots row.`
          : `[BackupPersistence] Dropped a late completed backup result for job ${jobId} ` +
            `(device ${deviceId}): snapshot ${providerSnapshotId} may be orphaned in storage ` +
            `with no backup_snapshots row (job was not in-flight and not reaper-failed).`;
      console.error(orphanMsg);
      captureException(new Error(orphanMsg));
    }
    return {
      applied: false,
      snapshotDbId: null,
      providerSnapshotId,
    };
  }

  // #3036 — the org this result is actually attributed to. Read back off the row
  // we just updated, NOT taken from the caller: an org move that lands between
  // enqueue and this write leaves the caller's `orgId` pointing at the device's
  // FORMER organization, and stamping that onto backup_snapshots/backup_chains
  // creates a restore point owned by a tenant the device has left. Under the
  // worker's system context RLS would not have stopped that row either.
  //
  // A divergence has two possible causes and this branch is the only place that
  // would ever notice EITHER, so name both rather than filing a wrong caller
  // under "org move" and never investigating it. Warning level, not error: an
  // org move is a supported admin action, and a bulk move with several in-flight
  // jobs would emit one of these per job.
  const effectiveOrgId = updatedJob.orgId;
  if (effectiveOrgId !== orgId) {
    const msg =
      `[BackupPersistence] Job ${jobId} (device ${deviceId}) was reported for org ${orgId} but the job row ` +
      `belongs to org ${effectiveOrgId} — either the device moved organizations while this result was in ` +
      `flight, or the caller passed an org that was never this job's. Attributing the snapshot to ` +
      `${effectiveOrgId} (the job row's current owner).`;
    console.warn(msg);
    captureMessage(msg, {
      eventCode: 'backup_result_org_divergence',
      tags: { backup_result_source: source },
    });
  }

  // NB: isSuccessResult, not `terminalStatus === 'completed'` — a `partial` run
  // produced a genuine snapshot and must still get its backup_snapshots row.
  // Gating this on the narrower status would strand a restorable snapshot in
  // the bucket with no DB row, the exact failure mode FIX 7 above exists for.
  if (!isSuccessResult || !providerSnapshotId) {
    return {
      applied: true,
      snapshotDbId: null,
      providerSnapshotId,
    };
  }

  const timestamp = result.snapshot?.timestamp
    ? new Date(result.snapshot.timestamp)
    : now;
  // A system_image job dispatches a generic backup_run whose result carries no
  // backupType, so derive it from the job's backup_mode; otherwise the snapshot
  // (and BMR restore, which keys off snapshot.backupType) mislabels it 'file'.
  const derivedBackupType =
    updatedJob.backupMode === 'system_image' ? 'system_image' : undefined;
  const snapshotBackupType =
    result.backupType ?? derivedBackupType ?? updatedJob.backupType ?? 'file';
  const systemStateManifest = result.systemStateManifest ?? null;
  const hardwareProfile = systemStateManifest?.hardwareProfile ?? null;
  const snapshotMetadata: Record<string, unknown> = {
    ...metadata,
    hasIndexedFiles: Boolean(result.snapshot?.files?.length),
    fileIndexVersion: result.snapshot?.files?.length ? 1 : 0,
  };
  const snapshotLabel = buildSnapshotLabel(snapshotMetadata, timestamp);

  const snapshotValues = {
    orgId: effectiveOrgId,
    jobId,
    deviceId,
    configId: updatedJob.configId ?? null,
    snapshotId: providerSnapshotId,
    label: snapshotLabel,
    location:
      typeof snapshotMetadata.storagePrefix === 'string'
        ? snapshotMetadata.storagePrefix
        : null,
    size: result.snapshot?.size ?? result.bytesBackedUp ?? null,
    fileCount: result.filesBackedUp ?? result.snapshot?.files?.length ?? null,
    timestamp,
    metadata: snapshotMetadata,
    encryptionKeyId: resolveSnapshotEncryptionKeyId(snapshotMetadata),
    backupType: snapshotBackupType,
    systemStateManifest,
    hardwareProfile,
  } as const;

  const [existingSnapshot] = await db
    .select({ id: backupSnapshots.id })
    .from(backupSnapshots)
    .where(
      and(
        eq(backupSnapshots.jobId, jobId),
        eq(backupSnapshots.snapshotId, providerSnapshotId)
      )
    )
    .limit(1);

  const [snapshot] = existingSnapshot
    ? await db
        .update(backupSnapshots)
        .set(snapshotValues)
        .where(eq(backupSnapshots.id, existingSnapshot.id))
        .returning()
    : await db.insert(backupSnapshots).values(snapshotValues).returning();

  if (snapshot && result.snapshot?.files) {
    await db
      .delete(backupSnapshotFiles)
      .where(eq(backupSnapshotFiles.snapshotDbId, snapshot.id));

    if (result.snapshot.files.length > 0) {
      const BATCH_SIZE = 1000;
      const fileRows = result.snapshot.files.map((file) => ({
        snapshotDbId: snapshot.id,
        sourcePath: file.sourcePath,
        backupPath: file.backupPath,
        size: file.size ?? null,
        modifiedAt: file.modTime ? new Date(file.modTime) : null,
      }));

      for (let i = 0; i < fileRows.length; i += BATCH_SIZE) {
        await db.insert(backupSnapshotFiles).values(fileRows.slice(i, i + BATCH_SIZE));
      }
    }
  }

  if (snapshot) {
    try {
      const protection = await resolveSnapshotProtectionSettingsForJob(jobId, timestamp);
      let protectionUpdate = {
        legalHold: protection.legalHold,
        legalHoldReason: protection.legalHoldReason,
        isImmutable: protection.isImmutable,
        immutableUntil: protection.immutableUntil,
        immutabilityEnforcement: protection.immutabilityEnforcement,
        requestedImmutabilityEnforcement: protection.requestedImmutabilityEnforcement,
        immutabilityFallbackReason: null as string | null,
        metadata: mergeSnapshotProtectionMetadata(snapshotMetadata, {
          legalHoldSource: protection.legalHoldSource,
        }),
      };

      if (
        protection.immutabilityEnforcement === 'provider' &&
        protection.isImmutable &&
        protection.immutableUntil
      ) {
        try {
          const storage = await resolveBackupConfigStorage(updatedJob.configId ?? null);
          if (!storage) {
            throw new Error('Backup config storage details unavailable');
          }

          const capability = await checkBackupProviderCapabilities({
            provider: storage.provider,
            providerConfig: storage.providerConfig,
          });
          if (!capability.objectLock.supported) {
            throw new Error(capability.objectLock.error ?? 'Bucket object lock is not enabled');
          }

          await applyBackupSnapshotImmutability({
            provider: storage.provider,
            providerConfig: storage.providerConfig,
            snapshotId: providerSnapshotId,
            metadata: snapshotMetadata,
            retainUntil: protection.immutableUntil,
          });
        } catch (err) {
          // COMPLIANCE EVENT — never let this pass quietly. The operator asked
          // for provider-enforced WORM (S3 Object Lock, i.e. immutability the
          // storage provider guarantees and nobody can revoke); we failed to
          // apply it and are recording the weaker application-level
          // enforcement, which any admin with DB access can undo. The row is
          // still written so the DB reflects REALITY rather than claiming a
          // provider lock that does not exist — but a silent downgrade of a
          // compliance control is not acceptable, so this escalates to Sentry
          // at error level rather than a console.warn nobody reads.
          //
          // Note this is reachable from an ordinary config mistake: a
          // malformed stored endpoint now throws out of
          // checkBackupProviderCapabilities -> buildS3StorageClient ->
          // coerceS3EndpointUrl, so a typo in the endpoint field would
          // otherwise silently cost every snapshot its WORM guarantee.
          const reason = err instanceof Error
            ? err.message
            : 'Provider-enforced immutability unavailable';
          console.error(
            `[BackupPersistence] WORM DOWNGRADE for snapshot ${snapshot.id}: provider-enforced immutability was requested but could not be applied; recording application-level enforcement instead:`,
            reason
          );
          captureException(
            err instanceof Error ? err : new Error(reason),
            undefined,
            {
              worm_downgrade: 'true',
              snapshot_id: snapshot.id,
              config_id: String(updatedJob.configId ?? 'unknown'),
              requested_enforcement: 'provider',
              recorded_enforcement: 'application',
            }
          );
          protectionUpdate = {
            ...protectionUpdate,
            immutabilityEnforcement: 'application',
            immutabilityFallbackReason: reason,
          };
        }
      }

      await db
        .update(backupSnapshots)
        .set(protectionUpdate)
        .where(eq(backupSnapshots.id, snapshot.id));
    } catch (err) {
      console.error(
        `[BackupPersistence] Failed to apply protection settings to snapshot ${snapshot.id}:`,
        err instanceof Error ? err.message : err
      );
    }

    try {
      await reconcileMssqlBackupChain({
        // #3036: the job row's org, not the caller's — a stale value here would
        // miss the device's real chain and fork a duplicate under the old org.
        orgId: effectiveOrgId,
        deviceId,
        configId: updatedJob.configId ?? null,
        snapshotDbId: snapshot.id,
        timestamp,
        metadata: snapshotMetadata,
      });
    } catch (err) {
      console.error(
        `[BackupPersistence] Failed to reconcile MSSQL chain for snapshot ${snapshot.id}:`,
        err instanceof Error ? err.message : err
      );
    }

    try {
      const tags = await applyGfsTagsToSnapshot(snapshot.id, timestamp, jobId);
      const gfsConfig = await resolveGfsConfigForJob(jobId);
      const expiresAt = computeExpiresAt(timestamp, tags, gfsConfig);
      if (expiresAt) {
        await db
          .update(backupSnapshots)
          .set({ expiresAt })
          .where(eq(backupSnapshots.id, snapshot.id));
      }
    } catch (err) {
      console.error(
        `[BackupPersistence] Failed to apply GFS tags to snapshot ${snapshot.id}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  if (!snapshot) {
    // The job row was flipped to `completed` and stamped with the snapshot id,
    // but neither the UPDATE nor the INSERT above returned a row — a concurrent
    // delete of the row selected at `existingSnapshot`, most plausibly. The
    // caller would otherwise read `applied: true` and count this as a restore
    // point that does not exist, which is exactly the #3006 silent-orphan
    // shape. Surface it.
    const missingSnapshotMsg =
      `[BackupPersistence] Job ${jobId} (device ${deviceId}) was marked completed for snapshot ` +
      `${providerSnapshotId} but no backup_snapshots row was written (source: ${source}); the ` +
      `snapshot is in storage with no restore point.`;
    console.error(missingSnapshotMsg);
    captureException(new Error(missingSnapshotMsg));
  }

  return {
    applied: true,
    snapshotDbId: snapshot?.id ?? null,
    providerSnapshotId,
  };
}

export async function markBackupJobFailedIfInFlight(
  jobId: string,
  errorLog: string,
): Promise<boolean> {
  const rows = await db
    .update(backupJobs)
    .set({
      status: 'failed',
      completedAt: new Date(),
      updatedAt: new Date(),
      errorLog,
    })
    .where(
      and(
        eq(backupJobs.id, jobId),
        inArray(backupJobs.status, IN_FLIGHT_BACKUP_JOB_STATUSES)
      )
    )
    .returning({ id: backupJobs.id });

  return rows.length > 0;
}
