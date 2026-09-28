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
 *   - once, before any upload, resume a journaled snapshot id it already owns
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
  createMultipart(cfg: StorageProviderConfig, key: string, sse: WriteSse): Promise<string>;
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
    const snapshotId = existing?.snapshotId ?? await reserveNewSnapshotId({
      orgId: input.orgId,
      deviceId: input.deviceId,
      configId: input.configId,
      storageIdentity: identity,
      jobId: input.jobId,
    }, { now, random: deps.random });
    const generationOfReservation = existing?.writeGeneration ?? 1;
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

// ── Multipart lifecycle ─────────────────────────────────────────────────────

/**
 * Locks the reservation for this call and requires it to still be writable
 * by this session (reserved, same generation, same job). Held until the
 * agent request's transaction ends, so a completion and the publication of
 * the snapshot (which locks the same row) are serialized.
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

export async function createWriteSessionMultipart(
  session: StorageSessionRow,
  key: string,
  deps: WriteSessionDeps = defaultWriteSessionDeps,
): Promise<{ status: 200; body: { uploadId: string } } | WriteFailure> {
  const keyDecision = authorizeWriteKey(key, session.reservationSnapshotId ?? '');
  if (keyDecision !== 'ok') return { status: 403, code: keyDecision };
  if (session.readOnly) return { status: 403, code: 'read_only' };
  const destination = await sessionDestination(session);
  if (!destination) return { status: 410, code: 'storage_changed' };
  const failure = await consume(session, 0, deps.now());
  if (failure) return failure;
  const reservation = await lockWritableReservation(session);
  if (!reservation) return { status: 409, code: 'reservation_sealed' };

  // The row exists BEFORE the upload does, so a crash after the storage call
  // still leaves the cleanup job something to find (it also lists the
  // prefix's multipart uploads directly).
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
  let uploadId: string;
  try {
    uploadId = await deps.storage.createMultipart(destination.providerConfig, key, destination.sse);
  } catch (err) {
    await db.update(backupStorageSessionUploads).set({ state: 'aborted', updatedAt: new Date() })
      .where(eq(backupStorageSessionUploads.id, row!.id));
    console.warn('[backupStorageWriteSessions] multipart create failed', {
      sessionId: session.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: 502, code: 'storage_error' };
  }
  await db.update(backupStorageSessionUploads).set({ uploadId, state: 'open', updatedAt: new Date() })
    .where(eq(backupStorageSessionUploads.id, row!.id));
  return { status: 200, body: { uploadId } };
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
  deps: WriteSessionDeps = defaultWriteSessionDeps,
): Promise<{ status: 200; body: Record<string, never> } | WriteFailure> {
  const keyDecision = authorizeWriteKey(key, session.reservationSnapshotId ?? '');
  if (keyDecision !== 'ok') return { status: 403, code: keyDecision };
  if (session.readOnly) return { status: 403, code: 'read_only' };
  const destination = await sessionDestination(session);
  if (!destination) return { status: 410, code: 'storage_changed' };
  const failure = await consume(session, 0, deps.now());
  if (failure) return failure;
  const reservation = await lockWritableReservation(session);
  if (!reservation) return { status: 409, code: 'reservation_sealed' };
  const [upload] = await db
    .select({ id: backupStorageSessionUploads.id })
    .from(backupStorageSessionUploads)
    .where(and(
      eq(backupStorageSessionUploads.objectKey, key),
      eq(backupStorageSessionUploads.uploadId, uploadId),
      eq(backupStorageSessionUploads.reservationSnapshotId, reservation.snapshotId),
      eq(backupStorageSessionUploads.reservationGeneration, reservation.writeGeneration),
      eq(backupStorageSessionUploads.state, 'open'),
    ))
    .limit(1);
  if (!upload) return { status: 403, code: 'unknown_upload' };

  await db.update(backupStorageSessionUploads).set({ state: 'completing', updatedAt: new Date() })
    .where(eq(backupStorageSessionUploads.id, upload.id));
  try {
    await deps.storage.completeMultipart(destination.providerConfig, key, uploadId, parts, {
      ifNoneMatch: session.conditionalWrites === true,
    });
  } catch (err) {
    await db.update(backupStorageSessionUploads).set({ state: 'open', updatedAt: new Date() })
      .where(eq(backupStorageSessionUploads.id, upload.id));
    if (err instanceof ObjectExistsError) return { status: 412, code: 'object_exists' };
    console.warn('[backupStorageWriteSessions] multipart complete failed', {
      sessionId: session.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: 502, code: 'storage_error' };
  }
  await db.update(backupStorageSessionUploads).set({ state: 'completed', updatedAt: new Date() })
    .where(eq(backupStorageSessionUploads.id, upload.id));
  return { status: 200, body: {} };
}

export async function abortWriteSessionMultipart(
  session: StorageSessionRow,
  key: string,
  uploadId: string,
  deps: WriteSessionDeps = defaultWriteSessionDeps,
): Promise<{ status: 200; body: Record<string, never> } | WriteFailure> {
  const keyDecision = authorizeWriteKey(key, session.reservationSnapshotId ?? '');
  if (keyDecision !== 'ok') return { status: 403, code: keyDecision };
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
  try {
    await deps.storage.abortMultipart(destination.providerConfig, key, uploadId);
  } catch (err) {
    console.warn('[backupStorageWriteSessions] multipart abort failed; cleanup will retry', {
      sessionId: session.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { status: 502, code: 'storage_error' };
  }
  await db.update(backupStorageSessionUploads).set({ state: 'aborted', updatedAt: new Date() })
    .where(eq(backupStorageSessionUploads.id, upload.id));
  return { status: 200, body: {} };
}

// ── List / delete ───────────────────────────────────────────────────────────

export async function listWriteSessionPrefix(
  session: StorageSessionRow,
  prefix: string,
  continuationToken: string | null,
  deps: WriteSessionDeps = defaultWriteSessionDeps,
): Promise<{ status: 200; body: { keys: string[]; nextToken: string | null } } | WriteFailure> {
  if (!isAllowedWriteListPrefix(prefix, session.reservationSnapshotId ?? '')) return { status: 403, code: 'outside_reservation' };
  const destination = await sessionDestination(session);
  if (!destination) return { status: 410, code: 'storage_changed' };
  const failure = await consume(session, 0, deps.now());
  if (failure) return failure;
  const out = await deps.storage.listKeys(destination.providerConfig, prefix, {
    maxKeys: STORAGE_WRITE_LIST_MAX_KEYS,
    continuationToken,
  });
  return { status: 200, body: out };
}

export async function deleteWriteSessionKeys(
  session: StorageSessionRow,
  reservation: SnapshotIdReservation,
  keys: string[],
  deps: WriteSessionDeps = defaultWriteSessionDeps,
): Promise<{ status: 200; body: { deleted: string[]; denied: Array<{ key: string; code: string }>; failed: Array<{ key: string; code: string }> } } | WriteFailure> {
  if (session.readOnly) return { status: 403, code: 'read_only' };
  const destination = await sessionDestination(session);
  if (!destination) return { status: 410, code: 'storage_changed' };
  const failure = await consume(session, 0, deps.now());
  if (failure) return failure;
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
  const result = allowed.length > 0
    ? await deps.storage.deleteKeys(destination.providerConfig, allowed)
    : { deleted: [], failed: [] };
  return { status: 200, body: { deleted: result.deleted, denied, failed: result.failed } };
}

// ── Resume ──────────────────────────────────────────────────────────────────

export type ResumeResult =
  | { status: 200; body: { snapshotId: string; mode: 'write' | 'read_only_completion' } }
  | { status: 400; code: 'invalid_snapshot_id' }
  | { status: 409; code: 'not_resumable' | 'previous_writer_active' }
  | WriteFailure;

/**
 * Lets a helper continue a snapshot id named by its local journal instead of
 * the id this session was issued. Allowed once per session, before the
 * session has issued any upload URL or multipart upload, and only for an id
 * reserved to the SAME device in the same organization:
 *   - published (or sealing): the session becomes read-only on that prefix,
 *     so the helper can read the published manifest and report it;
 *   - reserved: only once the previous writer is fenced — its job has ended,
 *     every session of that reservation is revoked, every upload URL issued
 *     for it has expired, and its open multipart uploads are aborted (done
 *     here; if an abort fails the call is refused and may be retried). The
 *     reservation's write generation then moves to this session's job.
 * The id this session was issued is abandoned when the resume succeeds.
 * Every other case is `not_resumable` and the helper starts fresh under the
 * issued id.
 */
export async function resumeWriteSession(
  session: StorageSessionRow,
  journalSnapshotId: unknown,
  deps: WriteSessionDeps = defaultWriteSessionDeps,
): Promise<ResumeResult> {
  if (typeof journalSnapshotId !== 'string'
    || parseBackupObjectKey(`snapshots/${journalSnapshotId}/manifest.json`)?.snapshotId !== journalSnapshotId) {
    return { status: 400, code: 'invalid_snapshot_id' };
  }
  const now = deps.now();
  const failure = await consume(session, 0, now);
  if (failure) return failure;
  if (journalSnapshotId === session.reservationSnapshotId) {
    return { status: 200, body: { snapshotId: journalSnapshotId, mode: session.readOnly ? 'read_only_completion' : 'write' } };
  }
  if (session.resumedAt || session.readOnly || session.urlHorizonAt) return { status: 409, code: 'not_resumable' };
  const [anyUpload] = await db
    .select({ id: backupStorageSessionUploads.id })
    .from(backupStorageSessionUploads)
    .where(eq(backupStorageSessionUploads.sessionId, session.id))
    .limit(1);
  if (anyUpload) return { status: 409, code: 'not_resumable' };

  // Lock this session's row, then the target reservation: two resumes by
  // sessions of one device serialize on the reservation.
  const [fresh] = await db
    .select({ resumedAt: backupStorageSessions.resumedAt, urlHorizonAt: backupStorageSessions.urlHorizonAt })
    .from(backupStorageSessions)
    .where(eq(backupStorageSessions.id, session.id))
    .for('update');
  if (!fresh || fresh.resumedAt || fresh.urlHorizonAt) return { status: 409, code: 'not_resumable' };

  const target = await loadReservation(journalSnapshotId, { forUpdate: true });
  if (
    !target
    || target.orgId !== session.orgId
    || target.deviceId !== session.deviceId
    || (target.storageIdentity !== null && target.storageIdentity !== session.storageIdentity)
  ) {
    return { status: 409, code: 'not_resumable' };
  }

  const issuedId = session.reservationSnapshotId!;
  const abandonIssued = async () => {
    await db
      .update(backupSnapshotIdReservations)
      .set({ state: 'abandoned', updatedAt: now })
      .where(and(
        eq(backupSnapshotIdReservations.snapshotId, issuedId),
        eq(backupSnapshotIdReservations.state, 'reserved'),
        eq(backupSnapshotIdReservations.currentJobId, session.jobId!),
      ));
  };

  if (target.state === 'published' || target.state === 'sealing') {
    await db.update(backupStorageSessions).set({
      reservationSnapshotId: target.snapshotId,
      reservationGeneration: target.writeGeneration,
      readOnly: true,
      resumedAt: now,
    }).where(eq(backupStorageSessions.id, session.id));
    await abandonIssued();
    await db.update(backupJobs).set({ snapshotId: target.snapshotId, updatedAt: now }).where(eq(backupJobs.id, session.jobId!));
    return { status: 200, body: { snapshotId: target.snapshotId, mode: 'read_only_completion' } };
  }
  if (target.state !== 'reserved') return { status: 409, code: 'not_resumable' };

  if (target.currentJobId && target.currentJobId !== session.jobId) {
    const [previous] = await db
      .select({ status: backupJobs.status })
      .from(backupJobs)
      .where(eq(backupJobs.id, target.currentJobId))
      .limit(1);
    if (previous && LIVE_JOB_STATUSES.includes(previous.status)) return { status: 409, code: 'previous_writer_active' };
  }
  // Every other session of that reservation: revoked, and every URL expired.
  const others = await db
    .select({ id: backupStorageSessions.id, revokedAt: backupStorageSessions.revokedAt, urlHorizonAt: backupStorageSessions.urlHorizonAt })
    .from(backupStorageSessions)
    .where(and(eq(backupStorageSessions.reservationSnapshotId, target.snapshotId), ne(backupStorageSessions.id, session.id)));
  if (others.some((o) => o.urlHorizonAt && o.urlHorizonAt.getTime() >= now.getTime())) {
    return { status: 409, code: 'previous_writer_active' };
  }
  const unrevoked = others.filter((o) => !o.revokedAt).map((o) => o.id);
  if (unrevoked.length > 0) {
    await db.update(backupStorageSessions)
      .set({ revokedAt: now, revokedReason: 'superseded_by_resume' })
      .where(inArray(backupStorageSessions.id, unrevoked));
  }
  // Earlier uploads of that reservation are aborted before ownership moves.
  const open = await db
    .select({ id: backupStorageSessionUploads.id, objectKey: backupStorageSessionUploads.objectKey, uploadId: backupStorageSessionUploads.uploadId })
    .from(backupStorageSessionUploads)
    .where(and(
      eq(backupStorageSessionUploads.reservationSnapshotId, target.snapshotId),
      inArray(backupStorageSessionUploads.state, ['creating', 'open', 'completing']),
    ));
  if (open.length > 0) {
    const destination = await sessionDestination(session);
    if (!destination) return { status: 410, code: 'storage_changed' };
    for (const u of open) {
      if (u.uploadId) {
        try {
          await deps.storage.abortMultipart(destination.providerConfig, u.objectKey, u.uploadId);
        } catch {
          return { status: 409, code: 'previous_writer_active' };
        }
      }
      await db.update(backupStorageSessionUploads).set({ state: 'aborted', updatedAt: now })
        .where(eq(backupStorageSessionUploads.id, u.id));
    }
  }

  const nextGeneration = target.writeGeneration + 1;
  await db.update(backupSnapshotIdReservations)
    .set({ writeGeneration: nextGeneration, currentJobId: session.jobId!, updatedAt: now })
    .where(eq(backupSnapshotIdReservations.snapshotId, target.snapshotId));
  await db.update(backupStorageSessions).set({
    reservationSnapshotId: target.snapshotId,
    reservationGeneration: nextGeneration,
    resumedAt: now,
  }).where(eq(backupStorageSessions.id, session.id));
  await abandonIssued();
  await db.update(backupJobs).set({ snapshotId: target.snapshotId, updatedAt: now }).where(eq(backupJobs.id, session.jobId!));
  return { status: 200, body: { snapshotId: target.snapshotId, mode: 'write' } };
}

// Exposed for the cleanup job.
export const __writeSessionInternals = { sseFromPlan, revoke };
