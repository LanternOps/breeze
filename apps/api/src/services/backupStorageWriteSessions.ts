/**
 * Brokered storage WRITES for backups (backup_run, mssql_backup,
 * hyperv_backup to S3).
 *
 * When the device's installed backup helper reports the brokered-write
 * protocol, a backup is delivered with a short-lived, write-scoped storage
 * session instead of the storage destination. The session is bound to the
 * backup job, to ONE server-issued snapshot id (reserved in
 * backup_snapshot_id_reservations before the device sees it) and to that
 * reservation's write generation. Through the agent API
 * (routes/agents/storageSessions.ts) the helper can then:
 *   - obtain presigned PUT / UploadPart URLs for keys under
 *     `snapshots/<its id>/` only (exact-key rule: the key must parse, and its
 *     snapshot segment must equal the reserved id verbatim);
 *   - ask the server to create, complete and abort multipart uploads, list
 *     and delete inside that prefix;
 *   - read the server-selected base manifest (control key) and its own
 *     prefix;
 *   - once, before any upload, resume a journaled snapshot id: one it already
 *     owns, a published one (read-only), or an unfinished one of an earlier
 *     job of the same device, configuration, destination and dispatched base
 *     (see resumeWriteSession).
 * It never receives a storage credential.
 *
 * Until helpers report the protocol this path is dark: every other backup is
 * delivered exactly as before.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, max, ne, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  backupConfigs,
  backupJobs,
  backupSnapshotIdReservations,
  backupStorageSessionUploads,
  backupStorageSessions,
  devices,
} from '../db/schema';
import { normalizeStorageIdentity } from '../jobs/backupRetention';
import { recordStorageSessionMint } from './backupMetrics';
import { parseBackupObjectKey } from './backupObjectKey';
import { resolveBackupWriteCommandDestination } from './backupProviderConfig';
import {
  SNAPSHOT_TAKEOVER_MAX_AGE_MS,
  findReservedForJob,
  loadReservation,
  reserveNewSnapshotId,
  type SnapshotIdReservation,
} from './backupSnapshotIdReservations';
import { conditionalWriteProbeDue, readConditionalWrites, scheduleConditionalWriteProbe } from './backupStorageCapabilityProbe';
import {
  MAX_PARTS,
  MAX_SINGLE_PUT_BYTES,
  MAX_WRITE_URL_TTL_SECONDS,
  ObjectExistsError,
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  deleteKeys,
  listKeysUnderPrefix,
  listMultipartUploads,
  presignPutObject,
  presignUploadPart,
  type ConfirmedSse,
  type PresignedWrite,
  type StorageProviderConfig,
  type WriteSse,
} from './backupStoragePresign';
import {
  STORAGE_SESSION_CALL_BURST,
  STORAGE_SESSION_MAX_BATCH,
  STORAGE_SESSION_OBJECT_BURST,
} from './backupStorageSessionBudget';
import { drizzleBrokeredReadStore } from './backupStorageSessionStore';
import {
  STORAGE_SESSION_LEASE_MS,
  STORAGE_SESSION_PROTOCOL_VERSION,
  hashStorageSessionToken,
  httpsEndpoint,
  originOf,
  rfc3339,
  type StorageSessionRow,
} from './backupStorageSessions';
import { CommandTypes } from './commandTypes';

// ── Contract constants ──────────────────────────────────────────────────────

export const STORAGE_WRITE_CAPABILITIES = ['resolve_batch', 'renew', 'put', 'multipart', 'list', 'delete', 'resume'] as const;
export const STORAGE_WRITE_PART_SIZE_BYTES = 64 * 1024 * 1024;
/** Lifetime ceilings of one write session (calls, and presigned URLs issued). */
export const STORAGE_WRITE_SESSION_MAX_CALLS = 200_000;
export const STORAGE_WRITE_SESSION_MAX_OBJECTS = 2_000_000;
/**
 * Absolute session deadline: the longest a backup job may run before the
 * stale-job reaper fails it (its absolute timeout, 24 h).
 */
export const STORAGE_WRITE_SESSION_DEADLINE_MS = 24 * 60 * 60 * 1000;
export const STORAGE_WRITE_LIST_MAX_KEYS = 1000;
export const STORAGE_WRITE_DELETE_MAX_KEYS = 1000;
/** The helper's publish lease object; the only key deletable after sealing. */
export const UPLOAD_LEASE_OBJECT = 'upload.lease';
/** Backup commands whose storage writes may be brokered. */
export const BROKERED_WRITE_COMMAND_TYPES: readonly string[] = [
  CommandTypes.BACKUP_RUN,
  CommandTypes.MSSQL_BACKUP,
  CommandTypes.HYPERV_BACKUP,
];
export const MIN_BACKUP_WRITE_PROTOCOL_VERSION = 1;

/**
 * How long an upload may still be running after the URL it started with has
 * expired. Storage checks a presigned URL's expiry only when the request
 * starts, so a PUT or part (at most STORAGE_WRITE_PART_SIZE_BYTES through
 * multipart; 64 MiB takes about 9 minutes at 1 Mbit/s) begun just before
 * expiry can still land afterwards. Every "has the earlier writer's last URL
 * expired" decision — redelivery, resume and takeover fencing, abandonment,
 * and sealing at publication (migration 2026-11-08-160000, as
 * `interval '15 minutes'`) — waits out URL expiry PLUS this margin.
 */
export const STORAGE_WRITE_TRANSFER_MARGIN_MS = 15 * 60 * 1000;

const MAX_KEY_LENGTH = 1024;
const LIVE_JOB_STATUSES = ['pending', 'running'];
const TOKEN_BYTES = 32;

// ── Pure decisions ──────────────────────────────────────────────────────────

export type WriteKeyDecision = 'ok' | 'invalid_key' | 'outside_reservation';

/**
 * Exact-key rule for every brokered write operation: the key must be a
 * well-formed object key (backupObjectKey.ts), and its snapshot segment must
 * be the reserved id, compared verbatim.
 */
export function authorizeWriteKey(key: unknown, reservedSnapshotId: string): WriteKeyDecision {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH || key.includes('\0')) {
    return 'invalid_key';
  }
  const parsed = parseBackupObjectKey(key);
  if (!parsed) return 'invalid_key';
  return parsed.snapshotId === reservedSnapshotId ? 'ok' : 'outside_reservation';
}

/** A list prefix is `snapshots/<id>/` or a slash-terminated sub-prefix of it. */
export function isAllowedWriteListPrefix(prefix: unknown, reservedSnapshotId: string): boolean {
  if (typeof prefix !== 'string' || prefix.length > MAX_KEY_LENGTH || prefix.includes('\0')) return false;
  const root = `snapshots/${reservedSnapshotId}/`;
  if (!prefix.startsWith(root) || !prefix.endsWith('/')) return false;
  const segments = prefix.slice(0, -1).split('/');
  return segments.every((s) => s !== '' && s !== '.' && s !== '..');
}

export type WriteDeleteDecision = WriteKeyDecision | 'reservation_sealed' | 'upload_completing';

export function writeDeleteDecision(
  key: string,
  reservedSnapshotId: string,
  reservationState: string,
  completingKeys: ReadonlySet<string>,
): WriteDeleteDecision {
  const keyDecision = authorizeWriteKey(key, reservedSnapshotId);
  if (keyDecision !== 'ok') return keyDecision;
  if (reservationState === 'reserved') return completingKeys.has(key) ? 'upload_completing' : 'ok';
  if ((reservationState === 'sealing' || reservationState === 'published')
    && key === `snapshots/${reservedSnapshotId}/${UPLOAD_LEASE_OBJECT}`) {
    return 'ok';
  }
  return 'reservation_sealed';
}

export type WriteUnbrokeredReason =
  | 'helper_unsupported'
  | 'provider_not_s3'
  | 'insecure_endpoint'
  | 'server_origin_mismatch'
  | 'server_origin_unavailable'
  | 'insecure_server_origin'
  | 'device_org_mismatch'
  | 'job_not_live';

/** Whether a backup to this destination can be brokered for this device. */
export function decideWriteBrokering(input: {
  device: { orgId: string; backupWriteProtocolVersion: number; agentServerUrl: string | null } | null;
  orgId: string;
  provider: string;
  providerConfig: Record<string, unknown>;
  publicOrigins: string[];
  reportedWriteProtocolVersion?: number;
}): { ok: true; baseUrl: string } | { ok: false; reason: WriteUnbrokeredReason } {
  const { device } = input;
  if (!device || device.orgId !== input.orgId) return { ok: false, reason: 'device_org_mismatch' };
  const protocol = typeof input.reportedWriteProtocolVersion === 'number'
    ? input.reportedWriteProtocolVersion
    : device.backupWriteProtocolVersion;
  if (!(protocol >= MIN_BACKUP_WRITE_PROTOCOL_VERSION)) return { ok: false, reason: 'helper_unsupported' };
  if (input.provider !== 's3') return { ok: false, reason: 'provider_not_s3' };
  if (!httpsEndpoint(input.providerConfig)) return { ok: false, reason: 'insecure_endpoint' };

  // The helper accepts only a bare https origin equal to a server URL it is
  // configured with: prefer the origin the device reported, when served here.
  const configured = input.publicOrigins.map(originOf).filter((o): o is string => o !== null);
  let baseUrl: string | null;
  if (device.agentServerUrl) {
    const reported = originOf(device.agentServerUrl);
    if (!reported || !configured.includes(reported)) return { ok: false, reason: 'server_origin_mismatch' };
    baseUrl = reported;
  } else {
    baseUrl = configured[0] ?? null;
  }
  if (!baseUrl) return { ok: false, reason: 'server_origin_unavailable' };
  if (!baseUrl.startsWith('https://')) return { ok: false, reason: 'insecure_server_origin' };
  return { ok: true, baseUrl };
}

export function buildWriteEnvelope(input: {
  sessionId: string;
  token: string;
  baseUrl: string;
  expiresAt: Date;
  deadline: Date;
  snapshotId: string;
  conditionalWrites: boolean;
  storageIdentity: string;
}): Record<string, unknown> {
  return {
    version: STORAGE_SESSION_PROTOCOL_VERSION,
    scope: 'snapshot_write',
    sessionId: input.sessionId,
    token: input.token,
    baseUrl: input.baseUrl,
    expiresAt: rfc3339(input.expiresAt),
    deadline: rfc3339(input.deadline),
    snapshotId: input.snapshotId,
    capabilities: [...STORAGE_WRITE_CAPABILITIES],
    maxBatch: STORAGE_SESSION_MAX_BATCH,
    partSizeBytes: STORAGE_WRITE_PART_SIZE_BYTES,
    conditionalWrites: input.conditionalWrites,
    storageIdentity: input.storageIdentity,
  };
}

function configString(config: Record<string, unknown>, field: string): string {
  const v = config[field];
  return typeof v === 'string' ? v : '';
}

/**
 * The destination identity delivered in a write session (`storageIdentity`):
 * exactly the string the helper's own S3 provider reports for the same
 * destination when it is given the storage configuration
 * (`s3|<endpoint>|<region>|<bucket>`, each field verbatim as configured, an
 * absent one empty). A helper uses it as its checkpoint-journal identity, so
 * a journal written by an earlier unbrokered run to the same destination
 * still matches. It names the destination only; it carries no credential.
 */
export function helperStorageIdentity(provider: string, providerConfig: Record<string, unknown>): string {
  return `${provider}|${configString(providerConfig, 'endpoint')}|${configString(providerConfig, 'region')}|${configString(providerConfig, 'bucket')}`;
}

type EncryptionSpec = { algorithm: 'AES256' } | { algorithm: 'aws:kms'; kmsKeyId: string };

/**
 * Server-side encryption as reported to the helper by multipart:create
 * (`appliedEncryption`): what STORAGE confirmed in its answer (`algorithm`,
 * and `kmsKeyId` when it named a key — AWS names the key ARN), what the
 * server requested (`requested`, null when none), and whether the two match
 * (`matches`). Null only when nothing was requested and storage confirmed
 * nothing. A request that storage did not confirm is reported explicitly as
 * `{ algorithm: null, requested, matches: false }` — a backend that ignored
 * the encryption headers.
 */
export type AppliedEncryption = {
  algorithm: string | null;
  kmsKeyId?: string;
  requested: EncryptionSpec | null;
  matches: boolean;
};

function requestedSpec(sse: WriteSse): EncryptionSpec | null {
  if (sse.mode === 's3-sse-s3') return { algorithm: 'AES256' };
  if (sse.mode === 's3-sse-kms') return { algorithm: 'aws:kms', kmsKeyId: sse.keyId };
  return null;
}

/**
 * Whether the key storage confirmed is the key requested. A key ARN must be
 * the same ARN; a bare key id must be the id the confirmed ARN ends with; an
 * alias (`alias/…` or an alias ARN) cannot be resolved here, so the
 * algorithm alone decides; a confirmation that names no key is accepted.
 */
function kmsKeyMatches(requested: string, confirmed: string | null): boolean {
  if (!confirmed) return true;
  if (requested.startsWith('alias/') || /^arn:[^:]+:kms:[^:]*:[^:]*:alias\//.test(requested)) return true;
  if (requested.startsWith('arn:')) return requested === confirmed;
  return confirmed === requested || confirmed.endsWith(`:key/${requested}`);
}

/** The encryption a multipart upload was created with, as storage confirmed it (see AppliedEncryption). */
export function appliedEncryptionOf(sse: WriteSse, confirmed: ConfirmedSse): AppliedEncryption | null {
  const requested = requestedSpec(sse);
  if (!requested && !confirmed.algorithm) return null;
  let matches: boolean;
  if (!requested) matches = true;
  else if (confirmed.algorithm !== requested.algorithm) matches = false;
  else matches = requested.algorithm === 'aws:kms' ? kmsKeyMatches(requested.kmsKeyId, confirmed.kmsKeyId) : true;
  return {
    algorithm: confirmed.algorithm,
    ...(confirmed.kmsKeyId ? { kmsKeyId: confirmed.kmsKeyId } : {}),
    requested,
    matches,
  };
}

function sseFromPlan(plan: unknown): WriteSse {
  const p = plan && typeof plan === 'object' ? (plan as Record<string, unknown>) : {};
  if (p.required === true && p.mode === 's3-sse-s3') return { mode: 's3-sse-s3' };
  if (p.required === true && p.mode === 's3-sse-kms' && typeof p.keyReference === 'string' && p.keyReference) {
    return { mode: 's3-sse-kms', keyId: p.keyReference };
  }
  return { mode: 'disabled' };
}

// ── Dependencies ────────────────────────────────────────────────────────────

export interface WriteStorage {
  presignPut(cfg: StorageProviderConfig, key: string, size: number, sse: WriteSse, opts: { expiresInSeconds: number; ifNoneMatch: boolean }): Promise<PresignedWrite>;
  presignPart(cfg: StorageProviderConfig, key: string, uploadId: string, partNumber: number, size: number, expiresInSeconds: number): Promise<PresignedWrite>;
  presignGet(cfg: StorageProviderConfig, key: string, expiresInSeconds: number): Promise<string>;
  createMultipart(cfg: StorageProviderConfig, key: string, sse: WriteSse): Promise<{ uploadId: string; encryption: ConfirmedSse }>;
  completeMultipart(cfg: StorageProviderConfig, key: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>, opts: { ifNoneMatch: boolean }): Promise<void>;
  abortMultipart(cfg: StorageProviderConfig, key: string, uploadId: string): Promise<void>;
  listMultipart(cfg: StorageProviderConfig, prefix: string): Promise<Array<{ key: string; uploadId: string }>>;
  listKeys(cfg: StorageProviderConfig, prefix: string, opts: { maxKeys: number; continuationToken?: string | null }): Promise<{ keys: string[]; nextToken: string | null }>;
  deleteKeys(cfg: StorageProviderConfig, keys: string[]): Promise<{ deleted: string[]; failed: Array<{ key: string; code: string }> }>;
}

export interface WriteSessionDeps {
  now(): Date;
  randomToken(): string;
  random(n: number): Buffer;
  storage: WriteStorage;
  publicOrigins(): string[];
  scheduleProbe(configId: string, orgId: string): void;
}

export const defaultWriteStorage: WriteStorage = {
  presignPut: (...a) => presignPutObject(...a),
  presignPart: (...a) => presignUploadPart(...a),
  presignGet: async (cfg, key, expiresInSeconds) => {
    const { presignSnapshotObjectGet } = await import('./recoveryDownloadService');
    return presignSnapshotObjectGet({ providerConfig: cfg, key, expiresInSeconds });
  },
  createMultipart: (...a) => createMultipartUpload(...a),
  completeMultipart: (...a) => completeMultipartUpload(...a),
  abortMultipart: (...a) => abortMultipartUpload(...a),
  listMultipart: (...a) => listMultipartUploads(...a),
  listKeys: (...a) => listKeysUnderPrefix(...a),
  deleteKeys: (...a) => deleteKeys(...a),
};

export const defaultWriteSessionDeps: WriteSessionDeps = {
  now: () => new Date(),
  randomToken: () => randomBytes(TOKEN_BYTES).toString('base64url'),
  random: (n) => randomBytes(n),
  storage: defaultWriteStorage,
  publicOrigins: () => [process.env.PUBLIC_API_URL, process.env.BREEZE_SERVER].filter(
    (v): v is string => typeof v === 'string' && v.trim().length > 0,
  ),
  scheduleProbe: (configId, orgId) => scheduleConditionalWriteProbe(configId, orgId),
};

// ── Mint ────────────────────────────────────────────────────────────────────

export type WriteMintInput = {
  orgId: string;
  jobId: string;
  deviceId: string;
  configId: string;
  provider: string;
  providerConfig: Record<string, unknown>;
  /** Server-selected base manifest (dispatch pin) — never taken from the agent. */
  baseManifestKey: string | null;
  reportedWriteProtocolVersion?: number;
};

export type WriteMintResult =
  | { mode: 'brokered'; envelope: Record<string, unknown>; snapshotId: string; sessionId: string }
  | { mode: 'unbrokered'; reason: WriteUnbrokeredReason };

/**
 * Issues a write session for one backup job, in the caller's DB context (the
 * worker's system context, or the delivery path's context). Reuses the
 * job's current reservation on redelivery; otherwise issues and reserves a
 * new snapshot id. Records the backup job's snapshot id. The plaintext token
 * exists only in the returned envelope.
 */
export async function mintBackupWriteSession(
  input: WriteMintInput,
  deps: WriteSessionDeps = defaultWriteSessionDeps,
): Promise<WriteMintResult> {
  const [device] = await db
    .select({
      orgId: devices.orgId,
      backupWriteProtocolVersion: devices.backupWriteProtocolVersion,
      agentServerUrl: devices.agentServerUrl,
    })
    .from(devices)
    .where(eq(devices.id, input.deviceId))
    .limit(1);
  const decision = decideWriteBrokering({
    device: device ?? null,
    orgId: input.orgId,
    provider: input.provider,
    providerConfig: input.providerConfig,
    publicOrigins: deps.publicOrigins(),
    reportedWriteProtocolVersion: input.reportedWriteProtocolVersion,
  });
  if (!decision.ok) {
    recordStorageSessionMint('snapshot_write', 'legacy', decision.reason);
    return { mode: 'unbrokered', reason: decision.reason };
  }

  const [job] = await db
    .select({ orgId: backupJobs.orgId, deviceId: backupJobs.deviceId, status: backupJobs.status })
    .from(backupJobs)
    .where(eq(backupJobs.id, input.jobId))
    .limit(1);
  if (!job || job.orgId !== input.orgId || job.deviceId !== input.deviceId || !LIVE_JOB_STATUSES.includes(job.status)) {
    recordStorageSessionMint('snapshot_write', 'legacy', 'job_not_live');
    return { mode: 'unbrokered', reason: 'job_not_live' };
  }

  const identity = normalizeStorageIdentity(input.provider, input.providerConfig);
  const [config] = await db
    .select({ providerCapabilities: backupConfigs.providerCapabilities })
    .from(backupConfigs)
    .where(and(eq(backupConfigs.id, input.configId), eq(backupConfigs.orgId, input.orgId)))
    .limit(1);
  const now = deps.now();
  const conditionalWrites = readConditionalWrites(config?.providerCapabilities, identity).supported;
  if (conditionalWriteProbeDue(config?.providerCapabilities, identity, now)) {
    deps.scheduleProbe(input.configId, input.orgId);
  }

  const baseManifestKey = input.baseManifestKey && parseBackupObjectKey(input.baseManifestKey)
    ? input.baseManifestKey
    : null;
  const deadline = new Date(Math.floor((now.getTime() + STORAGE_WRITE_SESSION_DEADLINE_MS) / 1000) * 1000);
  const expiresAt = new Date(Math.min(Math.floor((now.getTime() + STORAGE_SESSION_LEASE_MS) / 1000) * 1000, deadline.getTime()));
  const token = deps.randomToken();
  if (!/^[A-Za-z0-9_-]{43,512}={0,2}$/.test(token)) throw new Error('storage session token generator produced an invalid token');

  // One savepoint: a guard refusal or id collision leaves the caller's
  // transaction usable and writes nothing.
  const minted = await db.transaction(async () => {
    const existing = await findReservedForJob(input.jobId);
    let snapshotId: string;
    let generationOfReservation: number;
    if (existing) {
      // A redelivery of the same job: the new session writes the same id, and
      // becomes its only writer — every earlier session of the job is revoked
      // and the reservation moves to a new write generation, so an earlier
      // session's calls and its multipart uploads are refused from now on
      // (the cleanup job aborts those uploads).
      await db.update(backupStorageSessions)
        .set({ revokedAt: now, revokedReason: 'superseded_by_redelivery' })
        .where(and(
          eq(backupStorageSessions.jobId, input.jobId),
          eq(backupStorageSessions.scope, 'snapshot_write'),
          isNull(backupStorageSessions.revokedAt),
        ));
      const [bumped] = await db.update(backupSnapshotIdReservations)
        .set({ writeGeneration: sql`${backupSnapshotIdReservations.writeGeneration} + 1`, updatedAt: now })
        .where(eq(backupSnapshotIdReservations.snapshotId, existing.snapshotId))
        .returning({ writeGeneration: backupSnapshotIdReservations.writeGeneration });
      snapshotId = existing.snapshotId;
      generationOfReservation = bumped?.writeGeneration ?? existing.writeGeneration + 1;
    } else {
      snapshotId = await reserveNewSnapshotId({
        orgId: input.orgId,
        deviceId: input.deviceId,
        configId: input.configId,
        storageIdentity: identity,
        jobId: input.jobId,
      }, { now, random: deps.random });
      generationOfReservation = 1;
    }
    const [g] = await db
      .select({ g: max(backupStorageSessions.generation) })
      .from(backupStorageSessions)
      .where(eq(backupStorageSessions.jobId, input.jobId));
    const sessionId = randomUUID();
    await db.insert(backupStorageSessions).values({
      id: sessionId,
      orgId: input.orgId,
      commandId: null,
      deviceId: input.deviceId,
      sourceDeviceId: input.deviceId,
      snapshotId: null,
      configId: input.configId,
      storageIdentity: identity,
      scope: 'snapshot_write',
      controlKeys: baseManifestKey ? [baseManifestKey] : [],
      useFileIndex: false,
      tokenHash: hashStorageSessionToken(token),
      generation: Number(g?.g ?? 0) + 1,
      maxCalls: STORAGE_WRITE_SESSION_MAX_CALLS,
      maxResolvedObjects: STORAGE_WRITE_SESSION_MAX_OBJECTS,
      expiresAt,
      deadline,
      rateCallsAvailable: STORAGE_SESSION_CALL_BURST,
      rateObjectsAvailable: STORAGE_SESSION_OBJECT_BURST,
      rateRefilledAt: now,
      jobId: input.jobId,
      reservationSnapshotId: snapshotId,
      reservationGeneration: generationOfReservation,
      conditionalWrites,
    });
    await db.update(backupJobs).set({ snapshotId, updatedAt: now }).where(eq(backupJobs.id, input.jobId));
    return { snapshotId, sessionId };
  });

  recordStorageSessionMint('snapshot_write', 'minted', 'ok');
  return {
    mode: 'brokered',
    snapshotId: minted.snapshotId,
    sessionId: minted.sessionId,
    envelope: buildWriteEnvelope({
      sessionId: minted.sessionId,
      token,
      baseUrl: decision.baseUrl,
      expiresAt,
      deadline,
      snapshotId: minted.snapshotId,
      conditionalWrites,
      storageIdentity: helperStorageIdentity(input.provider, input.providerConfig),
    }),
  };
}

// ── Use: liveness, destination ──────────────────────────────────────────────

export type WriteFailure = { status: 400 | 403 | 409 | 410 | 412 | 429 | 502; code: string; retryAfterSeconds?: number };

async function revoke(sessionId: string, reason: string): Promise<void> {
  await db
    .update(backupStorageSessions)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(and(eq(backupStorageSessions.id, sessionId), isNull(backupStorageSessions.revokedAt)));
}

/**
 * Re-checks what a write session is bound to, on every call: its job is
 * still pending/running on the session's device, and the reservation it names
 * is in the session's organization and device, still at the session's write
 * generation for this job (reserved), or — after resuming onto a published
 * id — sealing/published. Anything else revokes the session (410).
 */
export async function ensureWriteSessionLive(
  session: StorageSessionRow,
): Promise<{ ok: true; reservation: SnapshotIdReservation } | { ok: false; status: 410; error: string }> {
  if (session.scope !== 'snapshot_write' || !session.jobId || !session.reservationSnapshotId) {
    return { ok: false, status: 410, error: 'Storage session is not a write session' };
  }
  const [job] = await db
    .select({ status: backupJobs.status, deviceId: backupJobs.deviceId, orgId: backupJobs.orgId })
    .from(backupJobs)
    .where(eq(backupJobs.id, session.jobId))
    .limit(1);
  if (!job || !LIVE_JOB_STATUSES.includes(job.status) || job.deviceId !== session.deviceId || job.orgId !== session.orgId) {
    await revoke(session.id, job ? `job_${job.status}` : 'job_missing');
    return { ok: false, status: 410, error: 'Storage session has ended with its backup' };
  }
  const reservation = await loadReservation(session.reservationSnapshotId);
  const bound = reservation
    && reservation.orgId === session.orgId
    && (reservation.deviceId === null || reservation.deviceId === session.deviceId)
    && (session.readOnly
      ? reservation.state === 'sealing' || reservation.state === 'published'
      : reservation.state === 'reserved'
        && reservation.writeGeneration === session.reservationGeneration
        && reservation.currentJobId === session.jobId);
  if (!reservation || !bound) {
    await revoke(session.id, 'reservation_changed');
    return { ok: false, status: 410, error: 'The snapshot this session was writing is no longer writable' };
  }
  return { ok: true, reservation };
}

type ResolvedDestination = { providerConfig: StorageProviderConfig; sse: WriteSse };

/** The session's destination as configured now; a changed destination ends the session. */
async function sessionDestination(session: StorageSessionRow): Promise<ResolvedDestination | null> {
  const result = await resolveBackupWriteCommandDestination(session.configId, session.orgId);
  if (
    !result.ok
    || result.destination.provider !== 's3'
    || !httpsEndpoint(result.destination.providerConfig)
    || normalizeStorageIdentity(result.destination.provider, result.destination.providerConfig) !== session.storageIdentity
  ) {
    await revoke(session.id, 'storage_changed');
    return null;
  }
  return { providerConfig: result.destination.providerConfig, sse: sseFromPlan(result.destination.storageEncryption) };
}

async function consume(session: StorageSessionRow, objects: number, now: Date): Promise<WriteFailure | null> {
  const budget = await drizzleBrokeredReadStore.consumeBudget(session.id, { calls: 1, objects }, now);
  if (!budget) return { status: 410, code: 'session_revoked' };
  if (budget.kind === 'throttled') return { status: 429, code: 'throttled', retryAfterSeconds: budget.retryAfterSeconds };
  if (budget.kind === 'exhausted') {
    await revoke(session.id, 'budget_exhausted');
    return { status: 410, code: 'budget_exhausted' };
  }
  return null;
}

function urlTtl(session: StorageSessionRow, now: Date): number {
  return Math.min(MAX_WRITE_URL_TTL_SECONDS, Math.floor((session.deadline.getTime() - now.getTime()) / 1000));
}

async function advanceHorizon(sessionId: string, horizon: Date): Promise<void> {
  await db
    .update(backupStorageSessions)
    .set({
      urlHorizonAt: sql`GREATEST(COALESCE(${backupStorageSessions.urlHorizonAt}, ${horizon.toISOString()}::timestamptz), ${horizon.toISOString()}::timestamptz)`,
    })
    .where(eq(backupStorageSessions.id, sessionId));
}

/**
 * Until when an upload started with a URL that ANOTHER session of the same
 * reservation issued may still land: the latest expiry of those URLs plus
 * the transfer margin, when that is still in the future. A redelivered,
 * resumed or continuing session may not upload until then: the earlier
 * process could still write the same keys.
 */
async function otherWriterHorizon(session: StorageSessionRow, reservationSnapshotId: string, now: Date): Promise<Date | null> {
  const [row] = await db
    .select({ h: max(backupStorageSessions.urlHorizonAt) })
    .from(backupStorageSessions)
    .where(and(
      eq(backupStorageSessions.reservationSnapshotId, reservationSnapshotId),
      ne(backupStorageSessions.id, session.id),
    ));
  const h = row?.h ? new Date(new Date(row.h as unknown as string).getTime() + STORAGE_WRITE_TRANSFER_MARGIN_MS) : null;
  return h && h.getTime() >= now.getTime() ? h : null;
}

/**
 * When a delete through ANOTHER session of the same reservation can no longer
 * be running (its marker plus STORAGE_DELETE_SETTLE_MS), if that is still in
 * the future.
 */
async function otherWriterDeleteSettles(session: StorageSessionRow, reservationSnapshotId: string, now: Date): Promise<Date | null> {
  const [row] = await db
    .select({ d: max(backupStorageSessions.deletingSince) })
    .from(backupStorageSessions)
    .where(and(
      eq(backupStorageSessions.reservationSnapshotId, reservationSnapshotId),
      ne(backupStorageSessions.id, session.id),
    ));
  const settles = row?.d ? new Date(new Date(row.d as unknown as string).getTime() + STORAGE_DELETE_SETTLE_MS) : null;
  return settles && settles.getTime() > now.getTime() ? settles : null;
}

function previousWriterActive(horizon: Date, now: Date): WriteFailure {
  return {
    status: 409,
    code: 'previous_writer_active',
    retryAfterSeconds: Math.max(1, Math.ceil((horizon.getTime() - now.getTime()) / 1000) + 1),
  };
}

// ── Resolve (PUT / UPLOAD_PART / GET) ───────────────────────────────────────

export type WriteResolveRequest =
  | { method: 'GET'; key: string }
  | { method: 'PUT'; key: string; size: number }
  | { method: 'UPLOAD_PART'; key: string; uploadId: string; partNumber: number; size: number };

export type WriteResolvedObject = {
  key: string;
  method: 'GET' | 'PUT' | 'UPLOAD_PART';
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
  uploadId?: string;
  partNumber?: number;
};

export type WriteDenied = { key: string; method: string; partNumber?: number; code: string };

export type WriteResolveResult =
  | { status: 200; body: { objects: WriteResolvedObject[]; denied: WriteDenied[] } }
  | WriteFailure;

/** Exchanges write requests for presigned URLs; every request is answered once, in order. */
export async function resolveWriteSessionObjects(
  session: StorageSessionRow,
  reservation: SnapshotIdReservation,
  requests: WriteResolveRequest[],
  deps: WriteSessionDeps = defaultWriteSessionDeps,
): Promise<WriteResolveResult> {
  const destination = await sessionDestination(session);
  if (!destination) return { status: 410, code: 'storage_changed' };
  const reservedId = reservation.snapshotId;
  const control = new Set(session.controlKeys);
  const writable = !session.readOnly && reservation.state === 'reserved';

  type Decision = { request: WriteResolveRequest; code: string | null };
  const decisions: Decision[] = [];
  const partRequests = requests.filter((r): r is Extract<WriteResolveRequest, { method: 'UPLOAD_PART' }> => r.method === 'UPLOAD_PART');
  const openUploads = new Set<string>();
  if (partRequests.length > 0 && writable) {
    const rows = await db
      .select({ objectKey: backupStorageSessionUploads.objectKey, uploadId: backupStorageSessionUploads.uploadId })
      .from(backupStorageSessionUploads)
      .where(and(
        eq(backupStorageSessionUploads.reservationSnapshotId, reservedId),
        eq(backupStorageSessionUploads.reservationGeneration, reservation.writeGeneration),
        eq(backupStorageSessionUploads.state, 'open'),
        inArray(backupStorageSessionUploads.uploadId, [...new Set(partRequests.map((r) => r.uploadId))]),
      ));
    for (const r of rows) openUploads.add(`${r.objectKey}\u0000${r.uploadId}`);
  }

  for (const request of requests) {
    if (request.method === 'GET') {
      if (control.has(request.key)) decisions.push({ request, code: null });
      else {
        const d = authorizeWriteKey(request.key, reservedId);
        decisions.push({ request, code: d === 'ok' ? null : d });
      }
      continue;
    }
    const d = authorizeWriteKey(request.key, reservedId);
    if (d !== 'ok') { decisions.push({ request, code: d }); continue; }
    if (session.readOnly) { decisions.push({ request, code: 'read_only' }); continue; }
    if (!writable) { decisions.push({ request, code: 'reservation_sealed' }); continue; }
    if (!Number.isSafeInteger(request.size) || request.size < 0 || request.size > MAX_SINGLE_PUT_BYTES) {
      decisions.push({ request, code: 'invalid_size' });
      continue;
    }
    if (request.method === 'UPLOAD_PART') {
      if (!Number.isInteger(request.partNumber) || request.partNumber < 1 || request.partNumber > MAX_PARTS) {
        decisions.push({ request, code: 'invalid_part' });
        continue;
      }
      if (!openUploads.has(`${request.key}\u0000${request.uploadId}`)) {
        decisions.push({ request, code: 'unknown_upload' });
        continue;
      }
    }
    decisions.push({ request, code: null });
  }

  const granted = decisions.filter((d) => d.code === null);
  const now = deps.now();
  if (granted.some((d) => d.request.method !== 'GET')) {
    const horizon = await otherWriterHorizon(session, reservedId, now);
    if (horizon) return previousWriterActive(horizon, now);
  }
  const failure = await consume(session, granted.length, now);
  if (failure) return failure;
  const ttl = urlTtl(session, now);
  if (ttl < 1) return { status: 410, code: 'session_expired' };

  const objects: WriteResolvedObject[] = [];
  const denied: WriteDenied[] = [];
  let horizon: Date | null = null;
  for (const { request, code } of decisions) {
    if (code !== null) {
      denied.push({
        key: request.key,
        method: request.method,
        ...(request.method === 'UPLOAD_PART' ? { partNumber: request.partNumber } : {}),
        code,
      });
      continue;
    }
    if (request.method === 'GET') {
      const url = await deps.storage.presignGet(destination.providerConfig, request.key, ttl);
      objects.push({ key: request.key, method: 'GET', url, headers: {}, expiresAt: rfc3339(new Date(now.getTime() + ttl * 1000)) });
      continue;
    }
    const signed = request.method === 'PUT'
      ? await deps.storage.presignPut(destination.providerConfig, request.key, request.size, destination.sse, {
        expiresInSeconds: ttl,
        ifNoneMatch: session.conditionalWrites === true,
      })
      : await deps.storage.presignPart(destination.providerConfig, request.key, request.uploadId, request.partNumber, request.size, ttl);
    const expiry = new Date(now.getTime() + ttl * 1000);
    if (!horizon || expiry > horizon) horizon = expiry;
    objects.push({
      key: request.key,
      method: request.method,
      url: signed.url,
      headers: signed.headers,
      expiresAt: rfc3339(expiry),
      ...(request.method === 'UPLOAD_PART' ? { uploadId: request.uploadId, partNumber: request.partNumber } : {}),
    });
  }
  // Recorded before the URLs leave the server: publication and resume use
  // it to know when every issued upload URL has expired.
  if (horizon) await advanceHorizon(session.id, horizon);
  return { status: 200, body: { objects, denied } };
}

// ── Multipart lifecycle, list, delete, resume ───────────────────────────────
//
// These operations call storage over the network. None of them holds a
// database transaction across that call: each does its checks in one short
// phase in the agent's organization context (`run`), commits, calls storage
// with no DB context held, and records the outcome in a second short phase.
// A multipart completion is recorded as `completing` before the storage call,
// so publication of the snapshot while it is in flight leaves the snapshot
// sealing (not restorable) until the cleanup job has settled it.

/** Runs one short DB phase in the calling agent's organization context. */
export type OrgRunner = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * Locks the reservation for the rest of the phase and requires it to still be
 * writable by this session (reserved, same generation, same job).
 */
async function lockWritableReservation(session: StorageSessionRow): Promise<SnapshotIdReservation | null> {
  const reservation = await loadReservation(session.reservationSnapshotId!, { forUpdate: true });
  if (
    !reservation
    || session.readOnly
    || reservation.state !== 'reserved'
    || reservation.writeGeneration !== session.reservationGeneration
    || reservation.currentJobId !== session.jobId
  ) {
    return null;
  }
  return reservation;
}

function logStorageFailure(what: string, sessionId: string, err: unknown): void {
  console.warn(`[backupStorageWriteSessions] ${what}`, {
    sessionId,
    error: err instanceof Error ? err.message : String(err),
  });
}

export async function createWriteSessionMultipart(
  session: StorageSessionRow,
  key: string,
  run: OrgRunner,
  deps: WriteSessionDeps = defaultWriteSessionDeps,
): Promise<{ status: 200; body: { uploadId: string; appliedEncryption: AppliedEncryption | null } } | WriteFailure> {
  const keyDecision = authorizeWriteKey(key, session.reservationSnapshotId ?? '');
  if (keyDecision !== 'ok') return { status: 403, code: keyDecision };
  if (session.readOnly) return { status: 403, code: 'read_only' };

  const prepared = await run(async (): Promise<WriteFailure | { destination: ResolvedDestination; rowId: string }> => {
    const destination = await sessionDestination(session);
    if (!destination) return { status: 410, code: 'storage_changed' };
    const failure = await consume(session, 0, deps.now());
    if (failure) return failure;
    const reservation = await lockWritableReservation(session);
    if (!reservation) return { status: 409, code: 'reservation_sealed' };
    const now = deps.now();
    const horizon = await otherWriterHorizon(session, reservation.snapshotId, now);
    if (horizon) return previousWriterActive(horizon, now);
    // The row exists BEFORE the upload does, so a crash after the storage
    // call still leaves the cleanup job something to find (it also lists the
    // prefix's multipart uploads directly once the snapshot is finished).
    const [row] = await db
      .insert(backupStorageSessionUploads)
      .values({
        orgId: session.orgId,
        deviceId: session.deviceId,
        sessionId: session.id,
        reservationSnapshotId: reservation.snapshotId,
        reservationGeneration: reservation.writeGeneration,
        objectKey: key,
        state: 'creating',
      })
      .returning({ id: backupStorageSessionUploads.id });
    return { destination, rowId: row!.id };
  });
  if ('status' in prepared) return prepared;

  let uploadId: string;
  let confirmed: ConfirmedSse;
  try {
    ({ uploadId, encryption: confirmed } = await deps.storage.createMultipart(prepared.destination.providerConfig, key, prepared.destination.sse));
  } catch (err) {
    logStorageFailure('multipart create failed', session.id, err);
    await run(() => db.update(backupStorageSessionUploads).set({ state: 'aborted', updatedAt: new Date() })
      .where(and(eq(backupStorageSessionUploads.id, prepared.rowId), eq(backupStorageSessionUploads.state, 'creating'))));
    return { status: 502, code: 'storage_error' };
  }
  const opened = await run(() => db.update(backupStorageSessionUploads)
    .set({ uploadId, state: 'open', updatedAt: new Date() })
    .where(and(eq(backupStorageSessionUploads.id, prepared.rowId), eq(backupStorageSessionUploads.state, 'creating')))
    .returning({ id: backupStorageSessionUploads.id }));
  if (opened.length === 0) {
    // The cleanup job settled the row meanwhile: the upload must not stay open.
    await deps.storage.abortMultipart(prepared.destination.providerConfig, key, uploadId).catch((err) =>
      logStorageFailure('abort of an unrecorded multipart upload failed; cleanup will retry', session.id, err));
    return { status: 409, code: 'reservation_sealed' };
  }
  // The encryption storage confirmed for the upload, so the helper can refuse
  // to send parts to an upload that does not carry the encryption it expects.
  return { status: 200, body: { uploadId, appliedEncryption: appliedEncryptionOf(prepared.destination.sse, confirmed) } };
}

export function validateCompletedParts(parts: unknown): Array<{ partNumber: number; etag: string }> | null {
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > MAX_PARTS) return null;
  const seen = new Set<number>();
  const out: Array<{ partNumber: number; etag: string }> = [];
  for (const p of parts) {
    if (!p || typeof p !== 'object') return null;
    const { partNumber, etag } = p as Record<string, unknown>;
    if (!Number.isInteger(partNumber) || (partNumber as number) < 1 || (partNumber as number) > MAX_PARTS) return null;
    if (typeof etag !== 'string' || etag.length < 1 || etag.length > 256) return null;
    if (seen.has(partNumber as number)) return null;
    seen.add(partNumber as number);
    out.push({ partNumber: partNumber as number, etag });
  }
  return out;
}

export async function completeWriteSessionMultipart(
  session: StorageSessionRow,
  key: string,
  uploadId: string,
  parts: Array<{ partNumber: number; etag: string }>,
  run: OrgRunner,
  deps: WriteSessionDeps = defaultWriteSessionDeps,
): Promise<{ status: 200; body: Record<string, never> } | WriteFailure> {
  const keyDecision = authorizeWriteKey(key, session.reservationSnapshotId ?? '');
  if (keyDecision !== 'ok') return { status: 403, code: keyDecision };
  if (session.readOnly) return { status: 403, code: 'read_only' };

  // Phase 1, serialized with publication on the reservation row: only a
  // still-writable reservation may start a completion, and the completion is
  // recorded before storage is called.
  const prepared = await run(async (): Promise<WriteFailure | { destination: ResolvedDestination; rowId: string }> => {
    const destination = await sessionDestination(session);
    if (!destination) return { status: 410, code: 'storage_changed' };
    const failure = await consume(session, 0, deps.now());
    if (failure) return failure;
    const reservation = await lockWritableReservation(session);
    if (!reservation) return { status: 409, code: 'reservation_sealed' };
    const [upload] = await db
      .update(backupStorageSessionUploads)
      .set({ state: 'completing', updatedAt: new Date() })
      .where(and(
        eq(backupStorageSessionUploads.objectKey, key),
        eq(backupStorageSessionUploads.uploadId, uploadId),
        eq(backupStorageSessionUploads.reservationSnapshotId, reservation.snapshotId),
        eq(backupStorageSessionUploads.reservationGeneration, reservation.writeGeneration),
        eq(backupStorageSessionUploads.state, 'open'),
      ))
      .returning({ id: backupStorageSessionUploads.id });
    if (!upload) return { status: 403, code: 'unknown_upload' };
    return { destination, rowId: upload.id };
  });
  if ('status' in prepared) return prepared;

  let outcome: { status: 200; body: Record<string, never> } | WriteFailure = { status: 200, body: {} };
  try {
    await deps.storage.completeMultipart(prepared.destination.providerConfig, key, uploadId, parts, {
      ifNoneMatch: session.conditionalWrites === true,
    });
  } catch (err) {
    if (err instanceof ObjectExistsError) outcome = { status: 412, code: 'object_exists' };
    else {
      logStorageFailure('multipart complete failed', session.id, err);
      outcome = { status: 502, code: 'storage_error' };
    }
  }
  await run(() => db.update(backupStorageSessionUploads)
    .set({ state: outcome.status === 200 ? 'completed' : 'open', updatedAt: new Date() })
    .where(and(eq(backupStorageSessionUploads.id, prepared.rowId), eq(backupStorageSessionUploads.state, 'completing'))));
  return outcome;
}

export async function abortWriteSessionMultipart(
  session: StorageSessionRow,
  key: string,
  uploadId: string,
  run: OrgRunner,
  deps: WriteSessionDeps = defaultWriteSessionDeps,
): Promise<{ status: 200; body: Record<string, never> } | WriteFailure> {
  const keyDecision = authorizeWriteKey(key, session.reservationSnapshotId ?? '');
  if (keyDecision !== 'ok') return { status: 403, code: keyDecision };
  const prepared = await run(async (): Promise<WriteFailure | { destination: ResolvedDestination; rowId: string }> => {
    const destination = await sessionDestination(session);
    if (!destination) return { status: 410, code: 'storage_changed' };
    const failure = await consume(session, 0, deps.now());
    if (failure) return failure;
    const [upload] = await db
      .select({ id: backupStorageSessionUploads.id })
      .from(backupStorageSessionUploads)
      .where(and(
        eq(backupStorageSessionUploads.objectKey, key),
        eq(backupStorageSessionUploads.uploadId, uploadId),
        eq(backupStorageSessionUploads.reservationSnapshotId, session.reservationSnapshotId!),
        inArray(backupStorageSessionUploads.state, ['creating', 'open']),
      ))
      .limit(1);
    if (!upload) return { status: 403, code: 'unknown_upload' };
    return { destination, rowId: upload.id };
  });
  if ('status' in prepared) return prepared;
  try {
    await deps.storage.abortMultipart(prepared.destination.providerConfig, key, uploadId);
  } catch (err) {
    logStorageFailure('multipart abort failed; cleanup will retry', session.id, err);
    return { status: 502, code: 'storage_error' };
  }
  await run(() => db.update(backupStorageSessionUploads).set({ state: 'aborted', updatedAt: new Date() })
    .where(and(eq(backupStorageSessionUploads.id, prepared.rowId), inArray(backupStorageSessionUploads.state, ['creating', 'open']))));
  return { status: 200, body: {} };
}

export async function listWriteSessionPrefix(
  session: StorageSessionRow,
  prefix: string,
  continuationToken: string | null,
  run: OrgRunner,
  deps: WriteSessionDeps = defaultWriteSessionDeps,
): Promise<{ status: 200; body: { keys: string[]; nextToken: string | null } } | WriteFailure> {
  if (!isAllowedWriteListPrefix(prefix, session.reservationSnapshotId ?? '')) return { status: 403, code: 'outside_reservation' };
  const prepared = await run(async (): Promise<WriteFailure | { destination: ResolvedDestination }> => {
    const destination = await sessionDestination(session);
    if (!destination) return { status: 410, code: 'storage_changed' };
    const failure = await consume(session, 0, deps.now());
    return failure ?? { destination };
  });
  if ('status' in prepared) return prepared;
  const out = await deps.storage.listKeys(prepared.destination.providerConfig, prefix, {
    maxKeys: STORAGE_WRITE_LIST_MAX_KEYS,
    continuationToken,
  });
  return { status: 200, body: out };
}

/** A delete marker older than this was left by a call that never finished. */
export const STORAGE_DELETE_SETTLE_MS = 5 * 60 * 1000;

/**
 * Deletes keys under the reserved prefix, in three steps: a short phase
 * decides which keys may go and records the delete as in flight on the
 * session (`deleting_since`), the storage delete runs with no transaction
 * held, and a second short phase clears the marker. A snapshot published
 * while a delete is in flight stays sealing until the marker is cleared (by
 * this call, or by the cleanup job for a call that never finished). After
 * sealing, only the helper's upload lease may go.
 */
export async function deleteWriteSessionKeys(
  session: StorageSessionRow,
  keys: string[],
  run: OrgRunner,
  deps: WriteSessionDeps = defaultWriteSessionDeps,
): Promise<{ status: 200; body: { deleted: string[]; denied: Array<{ key: string; code: string }>; failed: Array<{ key: string; code: string }> } } | WriteFailure> {
  if (session.readOnly) return { status: 403, code: 'read_only' };
  const prepared = await run(async (): Promise<WriteFailure | { destination: ResolvedDestination; allowed: string[]; denied: Array<{ key: string; code: string }> }> => {
    const destination = await sessionDestination(session);
    if (!destination) return { status: 410, code: 'storage_changed' };
    const failure = await consume(session, 0, deps.now());
    if (failure) return failure;
    const reservation = await loadReservation(session.reservationSnapshotId!, { forUpdate: true });
    if (!reservation) return { status: 410, code: 'reservation_changed' };
    const unique = [...new Set(keys)];
    const completing = new Set(
      (await db
        .select({ objectKey: backupStorageSessionUploads.objectKey })
        .from(backupStorageSessionUploads)
        .where(and(
          eq(backupStorageSessionUploads.reservationSnapshotId, reservation.snapshotId),
          eq(backupStorageSessionUploads.state, 'completing'),
        ))).map((r) => r.objectKey),
    );
    const allowed: string[] = [];
    const denied: Array<{ key: string; code: string }> = [];
    for (const key of unique) {
      const decision = writeDeleteDecision(key, reservation.snapshotId, reservation.state, completing);
      if (decision === 'ok') allowed.push(key);
      else denied.push({ key, code: decision });
    }
    if (allowed.length > 0) {
      await db.update(backupStorageSessions)
        .set({ deletingSince: deps.now() })
        .where(eq(backupStorageSessions.id, session.id));
    }
    return { destination, allowed, denied };
  });
  if ('status' in prepared) return prepared;
  if (prepared.allowed.length === 0) return { status: 200, body: { deleted: [], denied: prepared.denied, failed: [] } };

  let result: { deleted: string[]; failed: Array<{ key: string; code: string }> };
  try {
    result = await deps.storage.deleteKeys(prepared.destination.providerConfig, prepared.allowed);
  } catch (err) {
    logStorageFailure('delete failed', session.id, err);
    result = { deleted: [], failed: prepared.allowed.map((key) => ({ key, code: 'storage_error' })) };
  } finally {
    await run(() => db.update(backupStorageSessions)
      .set({ deletingSince: null })
      .where(eq(backupStorageSessions.id, session.id)));
  }
  return { status: 200, body: { deleted: result.deleted, denied: prepared.denied, failed: result.failed } };
}

// ── Resume ──────────────────────────────────────────────────────────────────

export type ResumeResult =
  | { status: 200; body: { snapshotId: string; mode: 'write' | 'read_only_completion'; takeover: boolean } }
  | { status: 400; code: 'invalid_snapshot_id' }
  | { status: 409; code: 'not_resumable' | 'previous_writer_active' }
  | WriteFailure;

type ResumePhase =
  | ResumeResult
  | { abort: Array<{ id: string; objectKey: string; uploadId: string | null }>; destination: ResolvedDestination };

/** How long a helper is asked to wait before retrying a resume that must wait. */
const RESUME_WAIT_SECONDS = 60;

export type ResumeTargetView = Pick<SnapshotIdReservation,
  | 'source' | 'orgId' | 'deviceId' | 'configId' | 'storageIdentity' | 'state' | 'currentJobId'
  | 'publishedSnapshotDbId' | 'uploadsSweptAt' | 'createdAt'>;
export type ResumeSessionView = { orgId: string; deviceId: string; configId: string; storageIdentity: string; jobId: string };
/** A backup job as a resume sees it: whether it is still live, and the base it was dispatched with. */
export type ResumeJobView = { status: string; baseSnapshotId: string | null };

export type ResumeDecision =
  | { kind: 'read_only' }
  | { kind: 'write'; takeover: boolean }
  | { kind: 'refuse' }
  | { kind: 'wait'; retryAfterSeconds: number };

function dispatchedBase(job: ResumeJobView): string | null {
  return job.baseSnapshotId && job.baseSnapshotId.length > 0 ? job.baseSnapshotId : null;
}

/**
 * Whether a write session may continue the snapshot id its helper's journal
 * names (the target), given the job currently recorded on that id (prior)
 * and the session's own job. Pure; resumePhase supplies locked rows.
 *
 * Every mode requires a server-issued id of the same organization, device,
 * backup configuration and storage destination, and the same dispatched base
 * (the server's base pin) on both jobs; a job that is gone cannot be checked
 * and refuses.
 *   - sealing / published: read-only completion.
 *   - reserved to this same job: continue writing.
 *   - reserved to, or abandoned after the end of, an EARLIER job: taken over
 *     when that job has ended, no snapshot row exists for the id, and the id
 *     was issued less than SNAPSHOT_TAKEOVER_MAX_AGE_MS ago. An abandoned id
 *     also waits until the cleanup job has swept its unfinished multipart
 *     uploads (it would otherwise abort the new writer's). An id abandoned by
 *     a resume onto another id has no job and is never taken over.
 */
export function decideResumeTarget(
  target: ResumeTargetView | null,
  session: ResumeSessionView,
  prior: ResumeJobView | null,
  own: ResumeJobView | null,
  now: Date,
): ResumeDecision {
  if (
    !target
    // Only an id the server issued is ever written through a session.
    || target.source !== 'server_minted'
    || target.orgId !== session.orgId
    || target.deviceId !== session.deviceId
    || target.storageIdentity === null
    || target.storageIdentity !== session.storageIdentity
    || target.configId === null
    || target.configId !== session.configId
    || target.currentJobId === null
    || !prior
    || !own
    || dispatchedBase(prior) !== dispatchedBase(own)
  ) {
    return { kind: 'refuse' };
  }
  if (target.state === 'published' || target.state === 'sealing') return { kind: 'read_only' };
  const sameJob = target.currentJobId === session.jobId;
  if (target.state === 'reserved' && sameJob) return { kind: 'write', takeover: false };
  if (target.state !== 'reserved' && target.state !== 'abandoned') return { kind: 'refuse' };
  if (sameJob || target.publishedSnapshotDbId !== null) return { kind: 'refuse' };
  if (now.getTime() - target.createdAt.getTime() > SNAPSHOT_TAKEOVER_MAX_AGE_MS) return { kind: 'refuse' };
  if (LIVE_JOB_STATUSES.includes(prior.status)) return { kind: 'wait', retryAfterSeconds: RESUME_WAIT_SECONDS };
  if (target.state === 'abandoned' && target.uploadsSweptAt === null) {
    return { kind: 'wait', retryAfterSeconds: RESUME_WAIT_SECONDS };
  }
  return { kind: 'write', takeover: true };
}

async function loadResumeJobs(ids: string[]): Promise<Map<string, ResumeJobView>> {
  const rows = await db
    .select({ id: backupJobs.id, status: backupJobs.status, baseSnapshotId: backupJobs.baseSnapshotId })
    .from(backupJobs)
    .where(inArray(backupJobs.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, { status: r.status, baseSnapshotId: r.baseSnapshotId }]));
}

/**
 * One short phase of a resume, under the session row lock and then the
 * target reservation row lock (two resumes of one id serialize there). Either
 * decides, or returns the earlier uploads that must be aborted before
 * ownership may move.
 */
async function resumePhase(
  session: StorageSessionRow,
  journalSnapshotId: string,
  now: Date,
  firstPass: boolean,
): Promise<ResumePhase> {
  if (firstPass) {
    const failure = await consume(session, 0, now);
    if (failure) return failure;
  }
  const [fresh] = await db
    .select({ resumedAt: backupStorageSessions.resumedAt, urlHorizonAt: backupStorageSessions.urlHorizonAt })
    .from(backupStorageSessions)
    .where(eq(backupStorageSessions.id, session.id))
    .for('update');
  if (!fresh || fresh.resumedAt || fresh.urlHorizonAt) return { status: 409, code: 'not_resumable' };
  const [anyUpload] = await db
    .select({ id: backupStorageSessionUploads.id })
    .from(backupStorageSessionUploads)
    .where(eq(backupStorageSessionUploads.sessionId, session.id))
    .limit(1);
  if (anyUpload) return { status: 409, code: 'not_resumable' };

  const target = await loadReservation(journalSnapshotId, { forUpdate: true });
  const jobs = await loadResumeJobs([session.jobId!, ...(target?.currentJobId ? [target.currentJobId] : [])]);
  const decision = decideResumeTarget(
    target,
    {
      orgId: session.orgId,
      deviceId: session.deviceId,
      configId: session.configId,
      storageIdentity: session.storageIdentity,
      jobId: session.jobId!,
    },
    target?.currentJobId ? jobs.get(target.currentJobId) ?? null : null,
    jobs.get(session.jobId!) ?? null,
    now,
  );
  if (decision.kind === 'refuse') return { status: 409, code: 'not_resumable' };
  if (decision.kind === 'wait') {
    return { status: 409, code: 'previous_writer_active', retryAfterSeconds: decision.retryAfterSeconds };
  }
  const reservation = target!;

  const issuedId = session.reservationSnapshotId!;
  const abandonIssued = async () => {
    await db
      .update(backupSnapshotIdReservations)
      // No job: an id given up for another one is never adoptable later.
      .set({ state: 'abandoned', currentJobId: null, updatedAt: now })
      .where(and(
        eq(backupSnapshotIdReservations.snapshotId, issuedId),
        eq(backupSnapshotIdReservations.state, 'reserved'),
        eq(backupSnapshotIdReservations.currentJobId, session.jobId!),
      ));
  };

  if (decision.kind === 'read_only') {
    await db.update(backupStorageSessions).set({
      reservationSnapshotId: reservation.snapshotId,
      reservationGeneration: reservation.writeGeneration,
      readOnly: true,
      resumedAt: now,
    }).where(eq(backupStorageSessions.id, session.id));
    await abandonIssued();
    await db.update(backupJobs).set({ snapshotId: reservation.snapshotId, updatedAt: now }).where(eq(backupJobs.id, session.jobId!));
    return { status: 200, body: { snapshotId: reservation.snapshotId, mode: 'read_only_completion', takeover: false } };
  }

  // Revoke every other session of that reservation FIRST (the UPDATE waits
  // for any call still holding one of their rows), THEN read the latest URL
  // expiry they issued: a URL issued by a call that committed meanwhile is
  // therefore always seen.
  await db.update(backupStorageSessions)
    .set({ revokedAt: now, revokedReason: 'superseded_by_resume' })
    .where(and(
      eq(backupStorageSessions.reservationSnapshotId, reservation.snapshotId),
      ne(backupStorageSessions.id, session.id),
      isNull(backupStorageSessions.revokedAt),
    ));
  const horizon = await otherWriterHorizon(session, reservation.snapshotId, now);
  if (horizon) return previousWriterActive(horizon, now);
  // A delete through another session may still be running against storage
  // (and could remove a key this session writes again) until its marker is
  // cleared, or until it is older than the time such a call can take.
  const deleting = await otherWriterDeleteSettles(session, reservation.snapshotId, now);
  if (deleting) return previousWriterActive(deleting, now);
  const open = await db
    .select({ id: backupStorageSessionUploads.id, objectKey: backupStorageSessionUploads.objectKey, uploadId: backupStorageSessionUploads.uploadId })
    .from(backupStorageSessionUploads)
    .where(and(
      eq(backupStorageSessionUploads.reservationSnapshotId, reservation.snapshotId),
      inArray(backupStorageSessionUploads.state, ['creating', 'open', 'completing']),
    ));
  if (open.length > 0) {
    const destination = await sessionDestination(session);
    if (!destination) return { status: 410, code: 'storage_changed' };
    return { abort: open, destination };
  }

  // Ownership moves: a new write generation for this job. A taken-over
  // abandoned id is reserved again, and its prefix is swept again once it is
  // finished.
  const nextGeneration = reservation.writeGeneration + 1;
  await db.update(backupSnapshotIdReservations)
    .set({
      writeGeneration: nextGeneration,
      currentJobId: session.jobId!,
      state: 'reserved',
      uploadsSweptAt: null,
      updatedAt: now,
    })
    .where(eq(backupSnapshotIdReservations.snapshotId, reservation.snapshotId));
  await db.update(backupStorageSessions).set({
    reservationSnapshotId: reservation.snapshotId,
    reservationGeneration: nextGeneration,
    resumedAt: now,
  }).where(eq(backupStorageSessions.id, session.id));
  await abandonIssued();
  await db.update(backupJobs).set({ snapshotId: reservation.snapshotId, updatedAt: now }).where(eq(backupJobs.id, session.jobId!));
  return { status: 200, body: { snapshotId: reservation.snapshotId, mode: 'write', takeover: decision.takeover } };
}

/**
 * Lets a helper continue a snapshot id named by its local journal instead of
 * the id this session was issued. Allowed once per session, before the
 * session has issued any upload URL or multipart upload, and only for a
 * server-issued id of the SAME organization, device, backup configuration,
 * storage destination and dispatched base (decideResumeTarget):
 *   - published (or sealing): the session becomes read-only on that prefix,
 *     so the helper can read the published manifest and report it;
 *   - reserved to this job, or left unfinished by an earlier job of the same
 *     device (reserved, or abandoned by the cleanup job after that job ended,
 *     issued less than SNAPSHOT_TAKEOVER_MAX_AGE_MS ago): only once the
 *     previous writer is fenced — its job has ended, every other session of
 *     that reservation is revoked, every upload URL issued for it has expired
 *     and the transfer margin has passed, and its open multipart uploads are
 *     aborted (here, with no DB context held; if an abort fails the call is
 *     refused and may be retried). The reservation's write generation then
 *     moves to this session's job, which becomes the only job whose result
 *     may publish the id (`takeover: true` in the answer when the id was an
 *     earlier job's).
 * The id this session was issued is abandoned when the resume succeeds.
 * `previous_writer_active` (with Retry-After) means the id may become
 * continuable shortly; every other refusal is `not_resumable` and the helper
 * starts fresh under the issued id.
 */
export async function resumeWriteSession(
  session: StorageSessionRow,
  journalSnapshotId: unknown,
  run: OrgRunner,
  deps: WriteSessionDeps = defaultWriteSessionDeps,
): Promise<ResumeResult> {
  if (typeof journalSnapshotId !== 'string'
    || parseBackupObjectKey(`snapshots/${journalSnapshotId}/manifest.json`)?.snapshotId !== journalSnapshotId) {
    return { status: 400, code: 'invalid_snapshot_id' };
  }
  if (journalSnapshotId === session.reservationSnapshotId) {
    return { status: 200, body: { snapshotId: journalSnapshotId, mode: session.readOnly ? 'read_only_completion' : 'write', takeover: false } };
  }
  if (session.resumedAt || session.readOnly || session.urlHorizonAt) return { status: 409, code: 'not_resumable' };

  const now = deps.now();
  let phase = await run(() => resumePhase(session, journalSnapshotId, now, true));
  if (!('abort' in phase)) return phase;
  for (const u of phase.abort) {
    if (u.uploadId) {
      try {
        await deps.storage.abortMultipart(phase.destination.providerConfig, u.objectKey, u.uploadId);
      } catch (err) {
        logStorageFailure('abort of an earlier writer\'s upload failed; resume refused for now', session.id, err);
        return { status: 409, code: 'previous_writer_active' };
      }
    }
  }
  const abortedIds = phase.abort.map((u) => u.id);
  phase = await run(async () => {
    await db.update(backupStorageSessionUploads).set({ state: 'aborted', updatedAt: now })
      .where(inArray(backupStorageSessionUploads.id, abortedIds));
    return resumePhase(session, journalSnapshotId, now, false);
  });
  // An upload opened between the two phases means a writer is still active.
  if ('abort' in phase) return { status: 409, code: 'previous_writer_active' };
  return phase;
}

// Exposed for the cleanup job.
export const __writeSessionInternals = { sseFromPlan, revoke };
