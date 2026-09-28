/**
 * Brokered, read-only storage access for restore-shaped backup commands.
 *
 * A restore, verify, test-restore, MSSQL restore/verify, Hyper-V restore or VM
 * restore/instant-boot command needs to READ one snapshot. Delivering the
 * org-wide storage destination (bucket credentials) for that is far more than
 * the command needs. When the target device's INSTALLED backup helper speaks
 * the storage-session protocol, the command is delivered with a short-lived
 * `storageSession` instead; the helper exchanges exact object keys for
 * short-lived presigned GET URLs through the agent API
 * (routes/agents/storageSessions.ts), and never sees a credential.
 *
 * Delivery (`deliverBrokeredReadCommand`, the delivery refresher for these
 * eight types): a session is minted only when ALL of these hold:
 *   - the device's helper reports `backupReadProtocolVersion >= 1` (the value
 *     this heartbeat reported, else the stored non-sticky column);
 *   - the snapshot resolves uniquely in the command's organization, its
 *     destination is S3 over https, and its pinned storage identity still
 *     matches the destination configuration;
 *   - the API origin the helper will call is https and is the origin the
 *     device itself uses;
 *   - the snapshot's authorized key set is known: a server-verified file
 *     index (`file_index_status = 'complete'`; hydration is requested when it
 *     is not), or, for MSSQL, the snapshot's manifest plus its single backup
 *     file.
 *
 * When one does not hold, the storage destination is NEVER sent instead:
 *   - index not yet server-verified → the delivery is DEFERRED
 *     (CommandDeliveryDeferredError): hydration has been requested and the
 *     row is released for the next claim;
 *   - anything else, for the six types that name a destination → the delivery
 *     is REFUSED (CommandDeliveryRefusedError) with an operator-facing reason;
 *   - the two VM types name no destination: they are delivered as queued
 *     (the helper uses its own configuration) and recorded as `legacy`.
 * A LOCAL destination is not brokered and not withheld: it is a filesystem
 * path, not a credential, and is delivered as before to any helper.
 *
 * Authorization at use: every key is compared VERBATIM against the session's
 * control keys (manifest, layout and system-state manifests) and the EXACT
 * `backup_snapshot_files.backup_path` rows of the snapshot. A key outside the
 * snapshot's own `snapshots/<id>/` prefix (an incremental's reference to an
 * older snapshot) is granted only with a verified origin record of the same
 * organization, source device and storage identity. No prefix is ever
 * granted.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { coerceS3EndpointUrl } from '@breeze/shared';
import { hasDbAccessContext, runAfterDbContextExit, withDbAccessContext, withSystemDbAccessContext } from '../db';
import {
  BACKUP_READ_CREDENTIAL_COMMAND_TYPES,
  PROVIDER_CONFIG_REF_FIELD,
  materializeBackupStorageCredentials,
} from './backupCommandCredentials';
import { recordBackupReadDispatch, recordStorageSessionMint } from './backupMetrics';
import { isSupportedKeyLayout } from './backupKeyLayout';
import { classifyBackupObjectKey, parseBackupObjectKey } from './backupObjectKey';
import {
  STORAGE_SESSION_CALL_BURST,
  STORAGE_SESSION_MAX_BATCH,
  STORAGE_SESSION_OBJECT_BURST,
  storageSessionBudgets,
  type StorageSessionBudgetDecision,
} from './backupStorageSessionBudget';
import { drizzleBrokeredReadStore } from './backupStorageSessionStore';
import {
  CommandDeliveryDeferredError,
  CommandDeliveryRefusedError,
  type DeliveryRefreshContext,
} from './commandDeliveryRefusal';
import { BACKUP_HELPER_UPDATE_REQUIRED_MESSAGE, MIN_BACKUP_READ_PROTOCOL_VERSION } from './backupReadHelperGate';
import { getCommandTimeoutMs } from './commandTimeouts';
import { CommandTypes } from './commandTypes';
import { presignSnapshotObjectGet } from './recoveryDownloadService';
import { normalizeStorageIdentity } from '../jobs/backupRetention';

// ── Contract constants (wire version 1) ─────────────────────────────────────

export {
  STORAGE_SESSION_CALL_BURST,
  STORAGE_SESSION_CALLS_PER_MINUTE,
  STORAGE_SESSION_MAX_BATCH,
  STORAGE_SESSION_OBJECT_BURST,
  STORAGE_SESSION_OBJECTS_PER_MINUTE,
  evaluateStorageSessionBudget,
  storageSessionBudgets,
  type StorageSessionBudgetDecision,
  type StorageSessionBudgetState,
} from './backupStorageSessionBudget';

export const STORAGE_SESSION_PROTOCOL_VERSION = 1;
export const STORAGE_SESSION_HEADER = 'X-Breeze-Storage-Session';
export const STORAGE_SESSION_CAPABILITIES = ['resolve_batch', 'renew'] as const;
/** Lease granted at mint and on every renew, never past the deadline. */
export const STORAGE_SESSION_LEASE_MS = 15 * 60 * 1000;
/** Upper bound for every presigned object URL. */
export const STORAGE_OBJECT_URL_TTL_SECONDS = 300;
/** Every restore-shaped command type whose storage reads may be brokered. */
export const BROKERED_READ_COMMAND_TYPES: readonly string[] = [
  ...BACKUP_READ_CREDENTIAL_COMMAND_TYPES,
  CommandTypes.VM_RESTORE_FROM_BACKUP,
  CommandTypes.VM_INSTANT_BOOT,
];

const REF_TYPES = new Set(BACKUP_READ_CREDENTIAL_COMMAND_TYPES);
const MSSQL_TYPES = new Set<string>([CommandTypes.MSSQL_RESTORE, CommandTypes.MSSQL_VERIFY]);
/** device_commands statuses under which a session may still be used. */
const LIVE_COMMAND_STATUSES = new Set(['pending', 'sent']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,512}={0,2}$/;
/** Keys longer than this are denied outright (S3 caps keys at 1024 bytes). */
const MAX_KEY_LENGTH = 1024;
const STRIPPED_DESTINATION_FIELDS = [PROVIDER_CONFIG_REF_FIELD, 'providerConfig', 'providerConfigEnvelope'];

// ── Types ───────────────────────────────────────────────────────────────────

export type StorageSnapshotRow = {
  id: string;
  orgId: string;
  deviceId: string;
  configId: string | null;
  snapshotId: string;
  storageIdentity: string | null;
  /** Object-key layout (services/backupKeyLayout.ts); only a supported one is ever read. */
  keyLayout: string;
  fileIndexStatus: string;
  metadata: unknown;
};

export type StorageSessionRow = {
  id: string;
  orgId: string;
  /** Read scope only (a write session is bound to its backup job instead). */
  commandId: string | null;
  deviceId: string;
  sourceDeviceId: string;
  /** Read scope only: the internal id of the snapshot being read. */
  snapshotId: string | null;
  configId: string;
  storageIdentity: string;
  scope: 'snapshot_read' | 'snapshot_write';
  controlKeys: string[];
  useFileIndex: boolean;
  tokenHash: string;
  generation: number;
  maxCalls: number;
  maxResolvedObjects: number;
  expiresAt: Date;
  deadline: Date;
  revokedAt: Date | null;
  callCount: number;
  resolvedObjectCount: number;
  rateCallsAvailable: number;
  rateObjectsAvailable: number;
  rateRefilledAt: Date;
  // Write scope only (services/backupStorageWriteSessions.ts).
  jobId?: string | null;
  reservationSnapshotId?: string | null;
  reservationGeneration?: number | null;
  urlHorizonAt?: Date | null;
  conditionalWrites?: boolean;
  readOnly?: boolean;
  resumedAt?: Date | null;
};

export type VerifiedOriginRow = {
  originSnapshotId: string;
  originOrgId: string;
  originDeviceId: string;
  originStorageIdentity: string;
};

export type StorageDestination = { provider: string; providerConfig: Record<string, unknown> };

/**
 * How a restore-shaped command was delivered: `brokered` (storage session),
 * `local` (a local destination path, no credential), `deferred` (released
 * until its index is ready), `refused`, or `legacy` (a VM command delivered as
 * queued, with no destination).
 */
export type BackupReadDispatchMode = 'brokered' | 'local' | 'deferred' | 'refused' | 'legacy';

/** Data access used by this module; the default is the Drizzle store. */
export interface BrokeredReadStore {
  loadDevice(deviceId: string): Promise<{
    id: string;
    orgId: string;
    backupReadProtocolVersion: number;
    agentServerUrl: string | null;
  } | null>;
  findSnapshots(args: { orgId: string; externalSnapshotId: string; configId: string | null }): Promise<StorageSnapshotRow[]>;
  loadSnapshotById(snapshotDbId: string): Promise<StorageSnapshotRow | null>;
  resolveConfig(configId: string, orgId: string): Promise<StorageDestination | null>;
  countIndexedFiles(snapshotDbId: string): Promise<number>;
  nextGeneration(commandId: string): Promise<number>;
  insertSession(row: StorageSessionRow): Promise<void>;
  loadSession(sessionId: string): Promise<StorageSessionRow | null>;
  loadCommand(commandId: string): Promise<{ status: string; deviceId: string } | null>;
  revokeSession(sessionId: string, reason: string): Promise<void>;
  filterIndexedKeys(snapshotDbId: string, keys: string[]): Promise<Set<string>>;
  loadVerifiedOrigins(snapshotDbId: string, originSnapshotIds: string[]): Promise<VerifiedOriginRow[]>;
  /**
   * Decide one call against the session's budget with evaluateStorageSessionBudget
   * and, when granted, apply it — atomically with the read the decision was
   * made from. Null when the session is absent or revoked.
   */
  consumeBudget(
    sessionId: string,
    request: { calls: number; objects: number },
    now: Date,
  ): Promise<StorageSessionBudgetDecision | null>;
  /** Raise expires_at to at least `expiresAt`; returns the stored value, or null when revoked/absent. */
  extendLease(sessionId: string, expiresAt: Date): Promise<Date | null>;
  /**
   * True while a brokered write of this snapshot id is still sealing: an
   * upload URL issued for it may still be usable, so its bytes are not final.
   */
  isSnapshotSealing?(snapshotId: string): Promise<boolean>;
}

export interface BrokeredReadDeps {
  store: BrokeredReadStore;
  now(): Date;
  /** Opaque session token, >= 256 bits, base64url. */
  randomToken(): string;
  presignGet(args: { providerConfig: Record<string, unknown>; key: string; expiresInSeconds: number }): Promise<string>;
  requestIndexHydration(snapshotDbId: string): Promise<void>;
  /** API origins this deployment serves agents on. */
  publicOrigins(): string[];
  /** Resolves a LOCAL destination reference into the command (a path, never a credential). */
  materializeLocalDestination(payload: Record<string, unknown>, ctx: DeliveryRefreshContext): Promise<Record<string, unknown>>;
  recordDispatch(commandType: string, mode: BackupReadDispatchMode, reason: string): void;
  /** One storage-session issuance decision (minted, or why not). */
  recordMint(scope: 'snapshot_read', outcome: 'minted' | 'refused' | 'deferred' | 'legacy', reason: string): void;
  /** Run `fn` inside the delivery path's DB context, or an org-scoped one when none is held. */
  inOrgContext<T>(orgId: string, fn: () => Promise<T>): Promise<T>;
  lookupDeviceOrg(deviceId: string): Promise<string | null>;
}

function defaultInOrgContext<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  // Join the context the delivery path already holds (heartbeat org
  // transaction, poll/drain system context, request context) rather than
  // opening a second pooled connection inside it.
  if (hasDbAccessContext()) return fn();
  return withDbAccessContext(
    { scope: 'organization', orgId, accessibleOrgIds: [orgId], label: 'backupStorageSessions.delivery' },
    fn,
  );
}

async function defaultLookupDeviceOrg(deviceId: string): Promise<string | null> {
  const load = () => drizzleBrokeredReadStore.loadDevice(deviceId).then((d) => d?.orgId ?? null);
  // Only the context-free direct push reaches here without a context; it holds
  // no transaction, so a short system read does not double-hold a connection.
  return hasDbAccessContext() ? load() : withSystemDbAccessContext(load);
}

function defaultPublicOrigins(): string[] {
  return [process.env.PUBLIC_API_URL, process.env.BREEZE_SERVER].filter(
    (v): v is string => typeof v === 'string' && v.trim().length > 0,
  );
}

// Every default is a thin wrapper, never a module-load-time reference to an
// imported binding: this module sits on the command-delivery import path, and
// unit suites routinely mock its dependencies with partial export sets.
export const defaultBrokeredReadDeps: BrokeredReadDeps = {
  get store() {
    return drizzleBrokeredReadStore;
  },
  now: () => new Date(),
  randomToken: () => randomBytes(32).toString('base64url'),
  presignGet: (args) => presignSnapshotObjectGet(args),
  requestIndexHydration: async (snapshotDbId) => {
    // Delivery runs inside the heartbeat / poll / request transaction; the
    // queue request is several Redis round trips, so it starts only after
    // that transaction has closed, and never delays delivery.
    runAfterDbContextExit('backupStorageSessions.requestIndexHydration', async () => {
      // Loaded on demand: the queue module opens a Redis connection and is not
      // needed on the command-delivery import path until a hydration is asked for.
      const { enqueueSnapshotFileIndexHydration } = await import('../jobs/backupSnapshotFileIndexWorker');
      await enqueueSnapshotFileIndexHydration(snapshotDbId, 'brokered_read');
    });
  },
  publicOrigins: () => defaultPublicOrigins(),
  materializeLocalDestination: (payload, ctx) => materializeBackupStorageCredentials(payload, ctx),
  recordDispatch: (commandType, mode, reason) => recordBackupReadDispatch(commandType, mode, reason),
  recordMint: (scope, outcome, reason) => recordStorageSessionMint(scope, outcome, reason),
  inOrgContext: (orgId, fn) => defaultInOrgContext(orgId, fn),
  lookupDeviceOrg: (deviceId) => defaultLookupDeviceOrg(deviceId),
};

// ── Helpers ─────────────────────────────────────────────────────────────────

export function hashStorageSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** RFC 3339, second precision, UTC — truncated, so never later than `d`. */
export function rfc3339(d: Date): string {
  return new Date(Math.floor(d.getTime() / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function originOf(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    // URL.origin drops a default port, so https://host:443 → https://host.
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}

function isSinglePathComponent(name: unknown): name is string {
  return typeof name === 'string'
    && name.length > 0
    && name !== '.'
    && name !== '..'
    && !name.includes('/')
    && !name.includes('\\')
    && !name.includes('\0');
}

/** True when `id` is exactly the snapshot segment of a well-formed object key. */
function isObjectKeySnapshotId(id: string): boolean {
  return parseBackupObjectKey(`snapshots/${id}/manifest.json`)?.snapshotId === id;
}

function mssqlBackupFileName(metadata: unknown): string | null {
  const md = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {};
  if (typeof md.backupFileName === 'string') return md.backupFileName;
  if (typeof md.backupFile === 'string') return md.backupFile.split('/').pop() ?? null;
  return null;
}

function controlKeysFor(snapshotId: string): string[] {
  return [
    `snapshots/${snapshotId}/manifest.json`,
    `snapshots/${snapshotId}/layout.json`,
    `snapshots/${snapshotId}/system-state/manifest.json`,
  ];
}

function stripDestination(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload };
  for (const field of STRIPPED_DESTINATION_FIELDS) delete out[field];
  return out;
}

export function httpsEndpoint(providerConfig: Record<string, unknown>): boolean {
  const raw = providerConfig.endpoint;
  if (raw === undefined || raw === null || raw === '') return true; // AWS default endpoint is https
  if (typeof raw !== 'string') return false;
  const coerced = coerceS3EndpointUrl(raw);
  return typeof coerced === 'string' && coerced.toLowerCase().startsWith('https://');
}

// ── Delivery ────────────────────────────────────────────────────────────────

type Decision =
  | { mode: 'brokered'; payload: Record<string, unknown> }
  | { mode: 'unbrokered'; reason: string };

/**
 * The operator-facing reason a read was refused. Never names a credential or a
 * key; worded for the restore job / command result it ends up on.
 */
const REFUSAL_MESSAGES: Record<string, string> = {
  helper_unsupported: BACKUP_HELPER_UPDATE_REQUIRED_MESSAGE,
  inline_destination:
    'This restore was queued by an earlier version of Breeze and can no longer be delivered. Start it again.',
  malformed_reference: 'This command carries a malformed backup destination reference. Start it again.',
  no_destination_ref: 'This command carries no backup destination reference. Start it again.',
  device_org_mismatch: 'The target device no longer belongs to the organization that owns this backup.',
  server_origin_mismatch:
    'This device connects to Breeze at an address the server is not configured to serve, so a secure storage session '
    + 'cannot be issued. Set PUBLIC_API_URL to the address agents use.',
  server_origin_unavailable:
    'The server address agents use is not configured, so a secure storage session cannot be issued. Set PUBLIC_API_URL.',
  insecure_server_origin:
    'Restoring or verifying backups requires agents to reach Breeze over HTTPS. Serve the agent API over HTTPS.',
  snapshot_unresolved: 'The backup could not be found for this organization, or its backup destination no longer exists.',
  invalid_snapshot_key: 'This backup has an identifier that cannot be read from storage.',
  key_layout_unsupported:
    'This backup was written in a storage format this server version cannot read. Update the server, then try again.',
  provider_not_s3: 'This backup is stored with a provider that restores do not support.',
  provider_changed: 'The backup destination changed provider after this command was queued. Start it again.',
  insecure_endpoint:
    'Restoring or verifying backups requires the storage endpoint to use HTTPS. Change the backup destination endpoint to HTTPS.',
  storage_identity_unrecorded:
    'The storage location of this backup has not been confirmed yet. Try again after the next storage check, or run a new backup.',
  storage_identity_mismatch:
    'This backup was written to a different bucket or endpoint than its backup configuration now uses. '
    + 'Point the configuration back to where the backup was written.',
  invalid_backup_file: 'This database backup does not record a readable backup file name.',
  deadline_passed: 'This command reached its time limit before it could be delivered. Start it again.',
};

const DEFERRAL_MESSAGE = "The backup's file list was still being prepared for a secure restore.";
const SEALING_DEFERRAL_MESSAGE = 'The backup was still being finalized in storage.';

function refusalMessage(reason: string): string {
  return REFUSAL_MESSAGES[reason] ?? 'This backup cannot be read securely.';
}

/**
 * Delivery refresher for the eight restore-shaped command types. Returns the
 * wire payload: a storage session (and no destination) when the command can
 * be brokered, a local destination path, or a VM command as queued. Throws
 * CommandDeliveryDeferredError (index not ready) or CommandDeliveryRefusedError
 * otherwise — a storage destination is never delivered for a read.
 */
export async function deliverBrokeredReadCommand(
  payload: Record<string, unknown>,
  ctx: DeliveryRefreshContext,
  deps: BrokeredReadDeps = defaultBrokeredReadDeps,
): Promise<Record<string, unknown>> {
  if (REF_TYPES.has(ctx.type) && payload.provider === 'local' && !hasInlineDestination(payload)) {
    // A local destination is a path the device reaches itself. The resolver
    // refuses if the referenced configuration is no longer local.
    deps.recordDispatch(ctx.type, 'local', 'no_credential');
    return deps.materializeLocalDestination(payload, ctx);
  }

  const decision = await decide(payload, ctx, deps);
  if (decision.mode === 'brokered') {
    deps.recordMint('snapshot_read', 'minted', 'ok');
    deps.recordDispatch(ctx.type, 'brokered', 'ok');
    return decision.payload;
  }
  if (decision.reason === 'index_unavailable' || decision.reason === 'snapshot_sealing') {
    deps.recordMint('snapshot_read', 'deferred', decision.reason);
    deps.recordDispatch(ctx.type, 'deferred', decision.reason);
    throw new CommandDeliveryDeferredError(
      decision.reason === 'snapshot_sealing' ? SEALING_DEFERRAL_MESSAGE : DEFERRAL_MESSAGE,
    );
  }
  if (REF_TYPES.has(ctx.type)) {
    deps.recordMint('snapshot_read', 'refused', decision.reason);
    deps.recordDispatch(ctx.type, 'refused', decision.reason);
    throw new CommandDeliveryRefusedError(refusalMessage(decision.reason));
  }
  // VM commands name no destination; they go as queued.
  deps.recordMint('snapshot_read', 'legacy', decision.reason);
  deps.recordDispatch(ctx.type, 'legacy', decision.reason);
  return payload;
}

function hasInlineDestination(payload: Record<string, unknown>): boolean {
  return 'providerConfig' in payload || 'providerConfigEnvelope' in payload;
}

async function decide(
  payload: Record<string, unknown>,
  ctx: DeliveryRefreshContext,
  deps: BrokeredReadDeps,
): Promise<Decision> {
  if (!BROKERED_READ_COMMAND_TYPES.includes(ctx.type)) return { mode: 'unbrokered', reason: 'unsupported_type' };
  if (hasInlineDestination(payload)) {
    // Queued before destination references existed: its only way to be
    // delivered is its inline destination, which is never sent for a read.
    return { mode: 'unbrokered', reason: 'inline_destination' };
  }

  let orgId: string;
  let refConfigId: string | null = null;
  const hasRef = PROVIDER_CONFIG_REF_FIELD in payload;
  if (hasRef) {
    const ref = payload[PROVIDER_CONFIG_REF_FIELD] as Record<string, unknown> | null;
    const configId = ref && typeof ref === 'object' ? ref.configId : undefined;
    const refOrg = ref && typeof ref === 'object' ? ref.orgId : undefined;
    if (typeof configId !== 'string' || !UUID_PATTERN.test(configId) || typeof refOrg !== 'string' || !UUID_PATTERN.test(refOrg)) {
      return { mode: 'unbrokered', reason: 'malformed_reference' };
    }
    orgId = refOrg;
    refConfigId = configId;
  } else if (REF_TYPES.has(ctx.type)) {
    return { mode: 'unbrokered', reason: 'no_destination_ref' };
  } else {
    const deviceOrg = await deps.lookupDeviceOrg(ctx.deviceId);
    if (!deviceOrg) return { mode: 'unbrokered', reason: 'device_org_mismatch' };
    orgId = deviceOrg;
  }

  return deps.inOrgContext(orgId, () => mint(payload, ctx, deps, orgId, refConfigId));
}

async function mint(
  payload: Record<string, unknown>,
  ctx: DeliveryRefreshContext,
  deps: BrokeredReadDeps,
  orgId: string,
  refConfigId: string | null,
): Promise<Decision> {
  const { store } = deps;
  const device = await store.loadDevice(ctx.deviceId);
  if (!device || device.orgId !== orgId) return { mode: 'unbrokered', reason: 'device_org_mismatch' };

  const protocol = typeof ctx.reportedBackupReadProtocolVersion === 'number'
    ? ctx.reportedBackupReadProtocolVersion
    : device.backupReadProtocolVersion;
  if (!(protocol >= MIN_BACKUP_READ_PROTOCOL_VERSION)) return { mode: 'unbrokered', reason: 'helper_unsupported' };

  // The helper only accepts a bare https origin equal to a server URL it is
  // configured with. Prefer the origin the device itself reported using, and
  // only when this deployment actually serves it.
  const configured = deps.publicOrigins().map(originOf).filter((o): o is string => o !== null);
  let baseUrl: string | null;
  if (device.agentServerUrl) {
    const reported = originOf(device.agentServerUrl);
    if (!reported || !configured.includes(reported)) return { mode: 'unbrokered', reason: 'server_origin_mismatch' };
    baseUrl = reported;
  } else {
    baseUrl = configured[0] ?? null;
  }
  if (!baseUrl) return { mode: 'unbrokered', reason: 'server_origin_unavailable' };
  if (!baseUrl.startsWith('https://')) return { mode: 'unbrokered', reason: 'insecure_server_origin' };

  const externalSnapshotId = typeof payload.snapshotId === 'string' ? payload.snapshotId : '';
  if (!externalSnapshotId) return { mode: 'unbrokered', reason: 'snapshot_unresolved' };
  const candidates = await store.findSnapshots({ orgId, externalSnapshotId, configId: refConfigId });
  if (candidates.length !== 1) return { mode: 'unbrokered', reason: 'snapshot_unresolved' };
  const snapshot = candidates[0]!;
  if (!snapshot.configId || snapshot.orgId !== orgId) return { mode: 'unbrokered', reason: 'snapshot_unresolved' };
  // A layout this server does not understand is a permanent property of the
  // snapshot: its keys cannot be derived, so it is refused, never guessed.
  if (!isSupportedKeyLayout(snapshot.keyLayout)) return { mode: 'unbrokered', reason: 'key_layout_unsupported' };
  // The snapshot id is agent-reported and every authorized key is built from
  // it: it must be a single segment of the object-key grammar.
  if (!isObjectKeySnapshotId(snapshot.snapshotId)) return { mode: 'unbrokered', reason: 'invalid_snapshot_key' };
  // Not final yet: an upload URL issued for this snapshot may still be usable.
  if (store.isSnapshotSealing && (await store.isSnapshotSealing(snapshot.snapshotId))) {
    return { mode: 'unbrokered', reason: 'snapshot_sealing' };
  }

  const destination = await store.resolveConfig(snapshot.configId, orgId);
  if (!destination) return { mode: 'unbrokered', reason: 'snapshot_unresolved' };
  if (hasRefProviderMismatch(payload, destination.provider)) return { mode: 'unbrokered', reason: 'provider_changed' };
  if (destination.provider !== 's3') return { mode: 'unbrokered', reason: 'provider_not_s3' };
  if (!httpsEndpoint(destination.providerConfig)) return { mode: 'unbrokered', reason: 'insecure_endpoint' };
  const identity = normalizeStorageIdentity(destination.provider, destination.providerConfig);
  if (!snapshot.storageIdentity) return { mode: 'unbrokered', reason: 'storage_identity_unrecorded' };
  if (snapshot.storageIdentity !== identity) return { mode: 'unbrokered', reason: 'storage_identity_mismatch' };

  let controlKeys: string[];
  let useFileIndex: boolean;
  let authorizedKeyCount: number;
  if (MSSQL_TYPES.has(ctx.type)) {
    const fileName = mssqlBackupFileName(snapshot.metadata);
    // A permanent property of the snapshot, not a pending index: refused.
    if (!isSinglePathComponent(fileName)) return { mode: 'unbrokered', reason: 'invalid_backup_file' };
    const fileKey = `snapshots/${snapshot.snapshotId}/files/${fileName}`;
    if (classifyBackupObjectKey(fileKey, snapshot.snapshotId)?.kind !== 'own') {
      return { mode: 'unbrokered', reason: 'invalid_backup_file' };
    }
    controlKeys = [`snapshots/${snapshot.snapshotId}/manifest.json`, fileKey];
    useFileIndex = false;
    authorizedKeyCount = controlKeys.length;
  } else {
    if (snapshot.fileIndexStatus !== 'complete') {
      // Ask for a server-verified index so the next delivery attempt can be
      // brokered; this one is deferred. Queue-only, started after the delivery
      // transaction closes (no DB connection, no Redis round trip while it is
      // held); a failure to queue is logged and the deferral stands.
      await deps.requestIndexHydration(snapshot.id).catch((err: unknown) => {
        console.warn('[backupStorageSessions] could not request file-index hydration', {
          snapshotDbId: snapshot.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      return { mode: 'unbrokered', reason: 'index_unavailable' };
    }
    controlKeys = controlKeysFor(snapshot.snapshotId);
    useFileIndex = true;
    authorizedKeyCount = controlKeys.length + (await store.countIndexedFiles(snapshot.id));
  }

  const now = deps.now();
  const base = ctx.claimedAt && ctx.claimedAt.getTime() > now.getTime() ? ctx.claimedAt : now;
  const deadline = new Date(Math.floor((base.getTime() + getCommandTimeoutMs(ctx.type, payload)) / 1000) * 1000);
  const expiresAt = new Date(Math.min(Math.floor((now.getTime() + STORAGE_SESSION_LEASE_MS) / 1000) * 1000, deadline.getTime()));
  if (expiresAt.getTime() <= now.getTime()) return { mode: 'unbrokered', reason: 'deadline_passed' };

  const token = deps.randomToken();
  if (!TOKEN_PATTERN.test(token)) throw new Error('storage session token generator produced an invalid token');
  const budgets = storageSessionBudgets(authorizedKeyCount, (deadline.getTime() - now.getTime()) / 1000);
  const row: StorageSessionRow = {
    id: randomUUID(),
    orgId,
    commandId: ctx.commandId,
    deviceId: ctx.deviceId,
    sourceDeviceId: snapshot.deviceId,
    snapshotId: snapshot.id,
    configId: snapshot.configId,
    storageIdentity: identity,
    scope: 'snapshot_read',
    controlKeys,
    useFileIndex,
    tokenHash: hashStorageSessionToken(token),
    generation: await store.nextGeneration(ctx.commandId),
    maxCalls: budgets.maxCalls,
    maxResolvedObjects: budgets.maxResolvedObjects,
    expiresAt,
    deadline,
    revokedAt: null,
    callCount: 0,
    resolvedObjectCount: 0,
    rateCallsAvailable: STORAGE_SESSION_CALL_BURST,
    rateObjectsAvailable: STORAGE_SESSION_OBJECT_BURST,
    rateRefilledAt: now,
  };
  await store.insertSession(row);

  const out = stripDestination(payload);
  if (REF_TYPES.has(ctx.type) || out.provider !== undefined) out.provider = 's3';
  // The canonical (provider-side) snapshot id the key set was built for.
  out.snapshotId = snapshot.snapshotId;
  out.storageSession = {
    version: STORAGE_SESSION_PROTOCOL_VERSION,
    sessionId: row.id,
    token,
    baseUrl,
    expiresAt: rfc3339(expiresAt),
    deadline: rfc3339(deadline),
    capabilities: [...STORAGE_SESSION_CAPABILITIES],
    maxBatch: STORAGE_SESSION_MAX_BATCH,
  };
  return { mode: 'brokered', payload: out };
}

function hasRefProviderMismatch(payload: Record<string, unknown>, provider: string): boolean {
  return PROVIDER_CONFIG_REF_FIELD in payload && payload.provider !== undefined && payload.provider !== provider;
}

// ── Use (agent endpoints) ───────────────────────────────────────────────────

export type StorageSessionAuthResult =
  | { ok: true; session: StorageSessionRow }
  | { ok: false; status: 401 | 403 | 404 | 410; error: string };

/**
 * Authenticates one storage-session call. The caller has already passed normal
 * agent authentication; `agent` is that authenticated identity, which must be
 * the session's executing device in the session's organization.
 */
export async function authenticateStorageSession(
  input: { sessionId: string; token: string | undefined | null; agent: { deviceId: string; orgId: string } },
  deps: BrokeredReadDeps = defaultBrokeredReadDeps,
): Promise<StorageSessionAuthResult> {
  if (!UUID_PATTERN.test(input.sessionId)) return { ok: false, status: 404, error: 'Unknown storage session' };
  const token = typeof input.token === 'string' ? input.token.trim() : '';
  if (!TOKEN_PATTERN.test(token)) return { ok: false, status: 401, error: 'Missing or invalid storage session token' };

  const session = await deps.store.loadSession(input.sessionId);
  if (!session) return { ok: false, status: 404, error: 'Unknown storage session' };

  const presented = Buffer.from(hashStorageSessionToken(token), 'hex');
  const stored = Buffer.from(session.tokenHash, 'hex');
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
    return { ok: false, status: 401, error: 'Invalid storage session token' };
  }
  if (session.orgId !== input.agent.orgId || session.deviceId !== input.agent.deviceId) {
    return { ok: false, status: 403, error: 'Storage session belongs to another device' };
  }
  if (session.revokedAt) return { ok: false, status: 410, error: 'Storage session has been revoked' };
  const now = deps.now().getTime();
  if (now >= session.deadline.getTime() || now >= session.expiresAt.getTime()) {
    return { ok: false, status: 410, error: 'Storage session has expired' };
  }

  // A write session is bound to its backup job, not to a command; the write
  // endpoints check the job and the snapshot id reservation on every call
  // (backupStorageWriteSessions.ensureWriteSessionLive).
  if (session.scope === 'snapshot_write') return { ok: true, session };

  const command = session.commandId ? await deps.store.loadCommand(session.commandId) : null;
  if (!command || !LIVE_COMMAND_STATUSES.has(command.status) || command.deviceId !== session.deviceId) {
    await deps.store.revokeSession(session.id, command ? `command_${command.status}` : 'command_missing');
    return { ok: false, status: 410, error: 'Storage session has ended with its command' };
  }
  return { ok: true, session };
}

export type ResolvedObject = {
  key: string;
  method: 'GET';
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
};

export type ResolveResult =
  | { status: 200; body: { objects: ResolvedObject[]; denied: string[] } }
  | { status: 429; retryAfterSeconds: number }
  | { status: 410; error: string };

/**
 * Exchanges exact keys for presigned GET URLs. Every distinct requested key is
 * answered exactly once, in `objects` or in `denied`, in request order.
 */
export async function resolveStorageSessionObjects(
  session: StorageSessionRow,
  requestedKeys: string[],
  deps: BrokeredReadDeps = defaultBrokeredReadDeps,
): Promise<ResolveResult> {
  const { store } = deps;
  const keys = [...new Set(requestedKeys)];
  if (session.scope !== 'snapshot_read' || !session.snapshotId) {
    return { status: 410, error: 'Storage session is not a read session' };
  }

  // Re-validate what the session was pinned to on every call: a snapshot or
  // destination that moved, disappeared or was re-pointed ends the session.
  const snapshot = await store.loadSnapshotById(session.snapshotId);
  const destination = snapshot ? await store.resolveConfig(session.configId, session.orgId) : null;
  if (
    !snapshot
    || snapshot.orgId !== session.orgId
    || snapshot.deviceId !== session.sourceDeviceId
    || snapshot.storageIdentity !== session.storageIdentity
    || !isSupportedKeyLayout(snapshot.keyLayout)
    || !destination
    || destination.provider !== 's3'
    || !httpsEndpoint(destination.providerConfig)
    || normalizeStorageIdentity(destination.provider, destination.providerConfig) !== session.storageIdentity
  ) {
    await store.revokeSession(session.id, 'storage_changed');
    return { status: 410, error: 'The snapshot or its storage destination changed' };
  }

  const granted = new Set<string>();
  const control = new Set(session.controlKeys);
  const indexCandidates: string[] = [];
  for (const key of keys) {
    if (!key || key.length > MAX_KEY_LENGTH || key.includes('\0')) continue;
    if (control.has(key)) {
      granted.add(key);
    } else if (session.useFileIndex) {
      indexCandidates.push(key);
    }
  }

  if (indexCandidates.length > 0 && snapshot.fileIndexStatus === 'complete') {
    const members = await store.filterIndexedKeys(snapshot.id, indexCandidates);
    const external = new Map<string, string[]>();
    for (const key of indexCandidates) {
      if (!members.has(key)) continue;
      // Index rows are grammar-checked where they are written, but a grant is
      // decided here: a row that is not a well-formed object key is never
      // granted, whichever snapshot's prefix it sits under.
      const scope = classifyBackupObjectKey(key, snapshot.snapshotId);
      if (!scope) continue;
      if (scope.kind === 'own') {
        granted.add(key);
        continue;
      }
      const list = external.get(scope.originSnapshotId) ?? [];
      list.push(key);
      external.set(scope.originSnapshotId, list);
    }
    if (external.size > 0) {
      const origins = await store.loadVerifiedOrigins(snapshot.id, [...external.keys()]);
      for (const origin of origins) {
        if (
          origin.originOrgId !== session.orgId
          || origin.originDeviceId !== session.sourceDeviceId
          || origin.originStorageIdentity !== session.storageIdentity
        ) continue;
        for (const key of external.get(origin.originSnapshotId) ?? []) granted.add(key);
      }
    }
  }

  const now = deps.now();
  const budget = await store.consumeBudget(session.id, { calls: 1, objects: granted.size }, now);
  if (!budget) return { status: 410, error: 'Storage session has been revoked' };
  if (budget.kind === 'throttled') return { status: 429, retryAfterSeconds: budget.retryAfterSeconds };
  if (budget.kind === 'exhausted') {
    await store.revokeSession(session.id, 'budget_exhausted');
    return { status: 410, error: 'Storage session has used its entire resolution allowance' };
  }

  const remainingSeconds = Math.floor((session.deadline.getTime() - now.getTime()) / 1000);
  const ttl = Math.min(STORAGE_OBJECT_URL_TTL_SECONDS, remainingSeconds);
  if (ttl < 1) return { status: 410, error: 'Storage session has expired' };

  const objects: ResolvedObject[] = [];
  const denied: string[] = [];
  for (const key of keys) {
    if (!granted.has(key)) {
      denied.push(key);
      continue;
    }
    const url = await deps.presignGet({ providerConfig: destination.providerConfig, key, expiresInSeconds: ttl });
    objects.push({ key, method: 'GET', url, headers: {}, expiresAt: rfc3339(new Date(now.getTime() + ttl * 1000)) });
  }
  return { status: 200, body: { objects, denied } };
}

export type RenewResult =
  | { status: 200; body: { expiresAt: string } }
  | { status: 410; error: string };

/** Extends the lease by STORAGE_SESSION_LEASE_MS, never past the deadline. */
export async function renewStorageSession(
  session: StorageSessionRow,
  deps: BrokeredReadDeps = defaultBrokeredReadDeps,
): Promise<RenewResult> {
  const now = deps.now();
  const target = new Date(Math.min(
    Math.floor((now.getTime() + STORAGE_SESSION_LEASE_MS) / 1000) * 1000,
    session.deadline.getTime(),
  ));
  if (target.getTime() <= now.getTime()) return { status: 410, error: 'Storage session has reached its deadline' };
  const stored = await deps.store.extendLease(session.id, target);
  if (!stored || stored.getTime() <= now.getTime()) return { status: 410, error: 'Storage session has been revoked' };
  const clamped = new Date(Math.min(stored.getTime(), session.deadline.getTime()));
  return { status: 200, body: { expiresAt: rfc3339(clamped) } };
}
