/**
 * History of the storage keys each S3 backup destination has used, and the
 * evidence that replaced keys no longer work.
 *
 * Backups to S3 storage are written only through write-scoped storage
 * sessions; no backup command carries a storage key. Keys that devices
 * received before that was required (`broadcast_until` set) keep working until
 * they are disabled with the storage provider, so each one stays listed until
 * there is evidence:
 *   - probe_denied: the API tried the old key (ListObjectsV2, one key at most)
 *     and storage refused it;
 *   - provider_admin_confirmed: an administrator of the storage provider
 *     confirmed it (recorded by platform operators);
 *   - operator_attested: a user confirmed they disabled it (weaker evidence).
 *
 * Rows:
 *   - every destination's CURRENT key has one row (`superseded_at` NULL);
 *   - replacing the key, or deleting the destination, supersedes that row and
 *     keeps the old connection settings sealed on it (application key, bound
 *     to the row id) so the old key can be checked; the sealed settings are
 *     erased once the key is recorded as disabled, and 30 days after it was
 *     replaced;
 *   - keys in use before this release are recorded at the API's first start
 *     on it (`baselineCredentialHistory`) with `broadcast_until` = the time
 *     this release's migrations ran; keys configured afterwards are recorded
 *     by the configuration write paths with `broadcast_until` NULL.
 *
 * The key id is never stored: rows carry sha256(`<key id>|<storage identity>`).
 * Nothing here logs a key id, a secret or the sealed settings.
 */
import { createHash } from 'node:crypto';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { backupConfigs } from '../db/schema/backup';
import { backupStorageCredentialHistory } from '../db/schema/backupStorageCredentialHistory';
import { normalizeStorageIdentity } from '../jobs/backupRetention';
import { buildS3StorageClient } from './backupSnapshotStorage';
import { columnAad, encryptedColumnRegistry, type EncryptedColumnSpec } from './encryptedColumnRegistry';
import { decryptSecret, encryptSecret } from './secretCrypto';

/** The migration that created the history; its ledger time is the moment backups stopped carrying keys. */
export const CREDENTIAL_HISTORY_MIGRATION = '2026-11-12-100000-backup-storage-credential-history.sql';
/** Sealed connection settings of a replaced key are erased this long after it was replaced. */
export const SEALED_PREVIOUS_SECRET_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** A check of an old key gives up after this long (inconclusive). */
export const CREDENTIAL_PROBE_TIMEOUT_MS = 15_000;

export type RevocationEvidence = 'probe_denied' | 'provider_admin_confirmed' | 'operator_attested';
export const REVOCATION_EVIDENCE: readonly RevocationEvidence[] = ['probe_denied', 'provider_admin_confirmed', 'operator_attested'];

const SEALED_SPEC: EncryptedColumnSpec = (() => {
  const spec = encryptedColumnRegistry.find(
    (s) => s.table === 'backup_storage_credential_history' && s.column === 'sealed_previous_secret',
  );
  if (!spec) throw new Error('backup_storage_credential_history.sealed_previous_secret is missing from encryptedColumnRegistry');
  return spec;
})();

// ── Pure helpers ────────────────────────────────────────────────────────────

export function credentialFingerprint(accessKeyId: string, storageIdentity: string): string {
  return createHash('sha256').update(`${accessKeyId}|${storageIdentity}`).digest('hex');
}

/** The settings needed to reach the bucket with one key pair — nothing else from the destination. */
export type S3Connection = {
  endpoint?: string;
  region?: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  sessionToken?: string;
};

export type S3Credential = {
  fingerprint: string;
  storageIdentity: string;
  /** sha256 of the secret, in memory only: tells a changed secret from an unchanged one. */
  secretDigest: string;
  connection: S3Connection;
};

function str(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** The key pair an S3 destination uses, or null (local, another provider, or no key pair). */
export function s3CredentialOf(provider: string, providerConfig: unknown): S3Credential | null {
  if (provider !== 's3' || !providerConfig || typeof providerConfig !== 'object' || Array.isArray(providerConfig)) return null;
  const cfg = providerConfig as Record<string, unknown>;
  const accessKey = str(cfg, 'accessKey', 'accessKeyId');
  const secretKey = str(cfg, 'secretKey', 'secretAccessKey');
  const bucket = str(cfg, 'bucket', 'bucketName');
  if (!accessKey || !secretKey || !bucket) return null;
  const storageIdentity = normalizeStorageIdentity('s3', cfg);
  const connection: S3Connection = { bucket, accessKey, secretKey };
  const endpoint = str(cfg, 'endpoint');
  const region = str(cfg, 'region');
  const sessionToken = str(cfg, 'sessionToken');
  if (endpoint) connection.endpoint = endpoint;
  if (region) connection.region = region;
  if (sessionToken) connection.sessionToken = sessionToken;
  return {
    fingerprint: credentialFingerprint(accessKey, storageIdentity),
    storageIdentity,
    secretDigest: createHash('sha256').update(secretKey).digest('hex'),
    connection: {
      ...(connection.endpoint ? { endpoint: connection.endpoint } : {}),
      ...(connection.region ? { region: connection.region } : {}),
      bucket,
      accessKey,
      secretKey,
      ...(connection.sessionToken ? { sessionToken: connection.sessionToken } : {}),
    },
  };
}

export function sealConnection(rowId: string, connection: S3Connection): string {
  const sealed = encryptSecret(JSON.stringify(connection), { aad: columnAad(SEALED_SPEC, rowId) });
  if (!sealed) throw new Error('sealing the replaced storage settings produced nothing');
  return sealed;
}

export function openSealedConnection(rowId: string, sealed: string): S3Connection {
  const plain = decryptSecret(sealed, { aad: columnAad(SEALED_SPEC, rowId) });
  if (!plain) throw new Error('sealed storage settings are empty');
  return JSON.parse(plain) as S3Connection;
}

// ── Checking an old key ─────────────────────────────────────────────────────

export type ProbeResult = { outcome: 'denied' | 'live' | 'inconclusive'; code: string | null };

const DENIED_CODES = new Set(['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'AccessDenied']);

/**
 * Only an explicit refusal of the key by storage counts as denied. Anything
 * else — network errors, timeouts, a missing bucket, a server error, an
 * endpoint this server will not connect to — is inconclusive and never
 * records the key as disabled.
 */
export function classifyProbeError(err: unknown): { outcome: 'denied' | 'inconclusive'; code: string } {
  const e = (err && typeof err === 'object' ? err : {}) as { name?: unknown; Code?: unknown; code?: unknown };
  const candidates = [e.Code, e.name, e.code].filter((v): v is string => typeof v === 'string');
  const denied = candidates.find((c) => DENIED_CODES.has(c));
  if (denied) return { outcome: 'denied', code: denied };
  const code = candidates.find((c) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(c) && c !== 'Error') ?? 'unknown';
  return { outcome: 'inconclusive', code };
}

type ProbeClient = { send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>; destroy?(): void };
export type ProbeDeps = {
  buildClient(connection: S3Connection): { bucket: string; client: ProbeClient };
};
const defaultProbeDeps: ProbeDeps = {
  buildClient: (connection) => buildS3StorageClient(connection as unknown as Record<string, unknown>) as unknown as {
    bucket: string;
    client: ProbeClient;
  },
};

/**
 * Lists at most one key with the old key pair. Runs with no DB context held.
 * Logs only the outcome and an error code.
 */
export async function probeS3Credential(connection: S3Connection, deps: ProbeDeps = defaultProbeDeps): Promise<ProbeResult> {
  let built: { bucket: string; client: ProbeClient };
  try {
    built = deps.buildClient(connection);
  } catch {
    return { outcome: 'inconclusive', code: 'client_unavailable' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CREDENTIAL_PROBE_TIMEOUT_MS);
  try {
    await built.client.send(new ListObjectsV2Command({ Bucket: built.bucket, MaxKeys: 1 }), { abortSignal: controller.signal });
    return { outcome: 'live', code: null };
  } catch (err) {
    const classified = classifyProbeError(err);
    console.warn('[backupStorageCredentialHistory] old storage key check', { outcome: classified.outcome, code: classified.code });
    return classified;
  } finally {
    clearTimeout(timer);
    built.client.destroy?.();
  }
}

// ── Recording keys ──────────────────────────────────────────────────────────

let cachedEnforcementMoment: Date | null = null;

/**
 * When this release's migrations ran — the moment backup commands stopped
 * carrying storage keys. Read from the migration ledger (the time the history
 * table was created). Null if the ledger cannot be read.
 */
export async function loadEnforcementMoment(): Promise<Date | null> {
  if (cachedEnforcementMoment) return cachedEnforcementMoment;
  try {
    const rows = (await db.execute(sql`
      SELECT applied_at FROM breeze_migrations WHERE filename = ${CREDENTIAL_HISTORY_MIGRATION} LIMIT 1
    `)) as unknown as Array<{ applied_at: Date | string | null }>;
    const raw = rows[0]?.applied_at;
    if (!raw) return null;
    const at = raw instanceof Date ? raw : new Date(raw);
    if (Number.isNaN(at.getTime())) return null;
    cachedEnforcementMoment = at;
    return at;
  } catch {
    return null;
  }
}

/** Test seam. */
export function __resetEnforcementMomentForTests(): void {
  cachedEnforcementMoment = null;
}

type DestinationState = { provider: string; providerConfig: unknown } | null;

/**
 * Records a destination's key change, in the caller's DB context (the write
 * that changed the destination). `previous` / `next` are the destination
 * before and after (null = did not exist / deleted). Nothing happens unless
 * the key pair or the storage it reaches changed.
 *
 * The replaced key's row is superseded with its connection settings sealed on
 * it. A replaced key that was never recorded (configured before this release
 * and not yet baselined) is recorded as in use before enforcement. The new
 * key gets a row with `broadcast_until` NULL: it has never been sent to a
 * device.
 */
export async function recordCredentialChange(input: {
  orgId: string;
  configId: string;
  previous: DestinationState;
  next: DestinationState;
  now?: Date;
}): Promise<void> {
  const before = input.previous ? s3CredentialOf(input.previous.provider, input.previous.providerConfig) : null;
  const after = input.next ? s3CredentialOf(input.next.provider, input.next.providerConfig) : null;
  if (before && after && before.fingerprint === after.fingerprint && before.secretDigest === after.secretDigest) return;
  if (!before && !after) return;
  const now = input.now ?? new Date();

  await db.transaction(async () => {
    const [current] = await db
      .select({ id: backupStorageCredentialHistory.id, fingerprint: backupStorageCredentialHistory.accessKeyFingerprint })
      .from(backupStorageCredentialHistory)
      .where(and(
        eq(backupStorageCredentialHistory.configId, input.configId),
        isNull(backupStorageCredentialHistory.supersededAt),
      ))
      .limit(1)
      .for('update');

    if (before) {
      let rowId = current && current.fingerprint === before.fingerprint ? current.id : null;
      if (current && !rowId) {
        // The recorded key is not the one being replaced (it was changed
        // through a path that did not record it): it is no longer in use.
        await db.update(backupStorageCredentialHistory)
          .set({ supersededAt: now, updatedAt: now })
          .where(eq(backupStorageCredentialHistory.id, current.id));
      }
      if (!rowId) {
        rowId = (await db.insert(backupStorageCredentialHistory).values({
          orgId: input.orgId,
          configId: input.configId,
          storageIdentity: before.storageIdentity,
          accessKeyFingerprint: before.fingerprint,
          firstSeenAt: now,
          broadcastUntil: (await loadEnforcementMoment()) ?? now,
        }).returning({ id: backupStorageCredentialHistory.id }))[0]!.id;
      }
      await db.update(backupStorageCredentialHistory)
        .set({ supersededAt: now, sealedPreviousSecret: sealConnection(rowId, before.connection), updatedAt: now })
        .where(eq(backupStorageCredentialHistory.id, rowId));
    } else if (current) {
      // The destination had no usable key pair before (or its row came from
      // a path that did not record it): whatever was current is replaced.
      await db.update(backupStorageCredentialHistory)
        .set({ supersededAt: now, updatedAt: now })
        .where(eq(backupStorageCredentialHistory.id, current.id));
    }

    if (after) {
      await db.insert(backupStorageCredentialHistory).values({
        orgId: input.orgId,
        configId: input.configId,
        storageIdentity: after.storageIdentity,
        accessKeyFingerprint: after.fingerprint,
        firstSeenAt: now,
        broadcastUntil: null,
      });
    }
  });
}

/**
 * First start on this release (and every start after, idempotently): records
 * every S3 destination's current key that has no row yet as in use before
 * enforcement. System context; each destination in its own short
 * transaction; never logs a key.
 */
export async function baselineCredentialHistory(opts: {
  now?: Date;
  batchSize?: number;
  /** Test seam: runs after a destination was listed and before it is locked and recorded. */
  beforeRecord?: (configId: string) => Promise<void>;
} = {}): Promise<{
  scanned: number;
  recorded: number;
  failed: number;
}> {
  const now = opts.now ?? new Date();
  const batchSize = opts.batchSize ?? 200;
  const stats = { scanned: 0, recorded: 0, failed: 0 };
  const enforcement = (await runOutsideDbContext(() => withSystemDbAccessContext(() => loadEnforcementMoment()))) ?? now;

  let afterId: string | null = null;
  for (;;) {
    const cursor: string | null = afterId;
    const batch = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      db.select({
        id: backupConfigs.id,
        orgId: backupConfigs.orgId,
        provider: backupConfigs.provider,
        providerConfig: backupConfigs.providerConfig,
      })
        .from(backupConfigs)
        .where(and(
          eq(backupConfigs.provider, 's3'),
          cursor ? sql`${backupConfigs.id} > ${cursor}` : sql`true`,
        ))
        .orderBy(backupConfigs.id)
        .limit(batchSize)));
    if (batch.length === 0) break;
    afterId = batch[batch.length - 1]!.id;

    for (const listed of batch) {
      stats.scanned += 1;
      if (!s3CredentialOf(listed.provider, listed.providerConfig)) continue;
      try {
        await opts.beforeRecord?.(listed.id);
        const inserted = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
          // Re-read under the destination's row lock: a concurrent key change
          // (which updates this row, then records the change) either landed
          // already — and is seen here — or waits for this transaction.
          const [config] = await db
            .select({
              id: backupConfigs.id,
              orgId: backupConfigs.orgId,
              provider: backupConfigs.provider,
              providerConfig: backupConfigs.providerConfig,
            })
            .from(backupConfigs)
            .where(eq(backupConfigs.id, listed.id))
            .limit(1)
            .for('update');
          const credential = config ? s3CredentialOf(config.provider, config.providerConfig) : null;
          if (!config || !credential) return false;
          const [current] = await db
            .select({ id: backupStorageCredentialHistory.id, fingerprint: backupStorageCredentialHistory.accessKeyFingerprint })
            .from(backupStorageCredentialHistory)
            .where(and(eq(backupStorageCredentialHistory.configId, config.id), isNull(backupStorageCredentialHistory.supersededAt)))
            .limit(1);
          if (current?.fingerprint === credential.fingerprint) return false;
          if (current) {
            // Changed through a path that did not record it: the recorded key
            // is no longer in use (its settings are gone, so it cannot be
            // checked — only confirmed).
            await db.update(backupStorageCredentialHistory)
              .set({ supersededAt: now, updatedAt: now })
              .where(eq(backupStorageCredentialHistory.id, current.id));
          }
          const rows = await db.insert(backupStorageCredentialHistory).values({
            orgId: config.orgId,
            configId: config.id,
            storageIdentity: credential.storageIdentity,
            accessKeyFingerprint: credential.fingerprint,
            firstSeenAt: now,
            broadcastUntil: enforcement,
          }).onConflictDoNothing().returning({ id: backupStorageCredentialHistory.id });
          return rows.length > 0;
        }));
        if (inserted) stats.recorded += 1;
      } catch (err) {
        stats.failed += 1;
        console.error('[backupStorageCredentialHistory] could not record the storage key in use for a destination', {
          configId: listed.id,
          error: err instanceof Error ? err.name : 'unknown',
        });
      }
    }
    if (batch.length < batchSize) break;
  }
  return stats;
}

// ── Evidence ────────────────────────────────────────────────────────────────

export type OrgRunner = <T>(fn: () => Promise<T>) => Promise<T>;

export type CheckResult =
  | { status: 'revoked'; code: string }
  | { status: 'still_live' }
  | { status: 'inconclusive'; code: string | null }
  | { status: 'not_found' }
  | { status: 'not_checkable'; reason: 'in_use' | 'already_revoked' | 'no_sealed_settings' };

/**
 * Checks a replaced key. Reads the row in the caller's organization (`inOrg`),
 * tries the old key with no DB context held, then records the outcome. A
 * refused key is recorded as disabled (probe_denied, with the storage error
 * code) and its sealed settings erased; when storage says the key id itself
 * no longer exists, the organization's other replaced rows with the same
 * fingerprint are recorded too, since it is the same key on the same storage.
 */
export async function checkReplacedCredential(input: {
  historyId: string;
  /** The organization the caller is acting in; a row of any other is not found. */
  orgId: string;
  inOrg: OrgRunner;
  userId: string | null;
  now?: () => Date;
  probe?: (connection: S3Connection) => Promise<ProbeResult>;
}): Promise<CheckResult> {
  const now = input.now ?? (() => new Date());
  const probe = input.probe ?? ((c: S3Connection) => probeS3Credential(c));

  const loaded = await input.inOrg(async () => {
    const [row] = await db
      .select({
        id: backupStorageCredentialHistory.id,
        supersededAt: backupStorageCredentialHistory.supersededAt,
        revokedAt: backupStorageCredentialHistory.revokedAt,
        sealed: backupStorageCredentialHistory.sealedPreviousSecret,
        fingerprint: backupStorageCredentialHistory.accessKeyFingerprint,
      })
      .from(backupStorageCredentialHistory)
      .where(and(eq(backupStorageCredentialHistory.id, input.historyId), eq(backupStorageCredentialHistory.orgId, input.orgId)))
      .limit(1);
    return row ?? null;
  });
  if (!loaded) return { status: 'not_found' };
  if (loaded.revokedAt) return { status: 'not_checkable', reason: 'already_revoked' };
  if (!loaded.supersededAt) return { status: 'not_checkable', reason: 'in_use' };
  if (!loaded.sealed) return { status: 'not_checkable', reason: 'no_sealed_settings' };

  const connection = openSealedConnection(loaded.id, loaded.sealed);
  const result = await probe(connection);
  const at = now();

  if (result.outcome === 'denied') {
    const code = result.code ?? 'denied';
    await input.inOrg(() => db.update(backupStorageCredentialHistory)
      .set({
        revokedAt: at,
        revocationEvidence: 'probe_denied',
        evidenceDetail: code,
        verifiedByUserId: input.userId,
        sealedPreviousSecret: null,
        lastProbeAt: at,
        lastProbeOutcome: null,
        updatedAt: at,
      })
      .where(and(eq(backupStorageCredentialHistory.id, loaded.id), isNull(backupStorageCredentialHistory.revokedAt))));
    if (code === 'InvalidAccessKeyId') {
      // Storage says the key id no longer exists: the organization's other
      // replaced destinations using the same key on the same storage are
      // recorded too. Never another organization's — the fingerprint names a
      // key id and a storage location, not who can reach it — and never a
      // destination still using the key.
      await input.inOrg(() => db.update(backupStorageCredentialHistory)
        .set({
          revokedAt: at,
          revocationEvidence: 'probe_denied',
          evidenceDetail: `${code} (checked through another destination using the same key)`,
          sealedPreviousSecret: null,
          updatedAt: at,
        })
        .where(and(
          eq(backupStorageCredentialHistory.orgId, input.orgId),
          eq(backupStorageCredentialHistory.accessKeyFingerprint, loaded.fingerprint),
          isNull(backupStorageCredentialHistory.revokedAt),
          isNotNull(backupStorageCredentialHistory.supersededAt),
        )));
    }
    return { status: 'revoked', code };
  }

  const outcome = result.outcome === 'live' ? 'still_live' : 'inconclusive';
  await input.inOrg(() => db.update(backupStorageCredentialHistory)
    .set({ lastProbeAt: at, lastProbeOutcome: outcome, updatedAt: at })
    .where(eq(backupStorageCredentialHistory.id, loaded.id)));
  return outcome === 'still_live' ? { status: 'still_live' } : { status: 'inconclusive', code: result.code };
}

/**
 * Records a replaced key as disabled on someone's word (operator_attested, or
 * provider_admin_confirmed for platform operators). Weaker than a refused
 * check; the evidence kind says so. Only a replaced key: the current key is
 * still in use by its destination.
 */
export async function attestCredentialDisabled(input: {
  historyId: string;
  orgId: string;
  inOrg: OrgRunner;
  userId: string | null;
  evidence: Exclude<RevocationEvidence, 'probe_denied'>;
  detail: string | null;
  now?: Date;
}): Promise<{ status: 'revoked' } | { status: 'not_found' } | { status: 'not_checkable'; reason: 'in_use' | 'already_revoked' }> {
  const at = input.now ?? new Date();
  return input.inOrg(async () => {
    const [row] = await db
      .select({ id: backupStorageCredentialHistory.id, supersededAt: backupStorageCredentialHistory.supersededAt, revokedAt: backupStorageCredentialHistory.revokedAt })
      .from(backupStorageCredentialHistory)
      .where(and(eq(backupStorageCredentialHistory.id, input.historyId), eq(backupStorageCredentialHistory.orgId, input.orgId)))
      .limit(1);
    if (!row) return { status: 'not_found' as const };
    if (row.revokedAt) return { status: 'not_checkable' as const, reason: 'already_revoked' as const };
    if (!row.supersededAt) return { status: 'not_checkable' as const, reason: 'in_use' as const };
    await db.update(backupStorageCredentialHistory)
      .set({
        revokedAt: at,
        revocationEvidence: input.evidence,
        evidenceDetail: input.detail,
        verifiedByUserId: input.userId,
        sealedPreviousSecret: null,
        updatedAt: at,
      })
      .where(and(eq(backupStorageCredentialHistory.id, row.id), isNull(backupStorageCredentialHistory.revokedAt)));
    return { status: 'revoked' as const };
  });
}

export type OutstandingCredential = {
  id: string;
  configId: string | null;
  configName: string | null;
  storageIdentity: string;
  broadcastUntil: Date;
  supersededAt: Date | null;
  canCheck: boolean;
  lastProbeAt: Date | null;
  lastProbeOutcome: string | null;
};

/** Keys that were in use before enforcement and have no evidence of being disabled, in the caller's context. */
export async function listOutstandingCredentials(orgId: string): Promise<OutstandingCredential[]> {
  const rows = await db
    .select({
      id: backupStorageCredentialHistory.id,
      configId: backupStorageCredentialHistory.configId,
      configName: backupConfigs.name,
      storageIdentity: backupStorageCredentialHistory.storageIdentity,
      broadcastUntil: backupStorageCredentialHistory.broadcastUntil,
      supersededAt: backupStorageCredentialHistory.supersededAt,
      sealed: backupStorageCredentialHistory.sealedPreviousSecret,
      lastProbeAt: backupStorageCredentialHistory.lastProbeAt,
      lastProbeOutcome: backupStorageCredentialHistory.lastProbeOutcome,
    })
    .from(backupStorageCredentialHistory)
    .leftJoin(backupConfigs, eq(backupConfigs.id, backupStorageCredentialHistory.configId))
    .where(and(
      eq(backupStorageCredentialHistory.orgId, orgId),
      isNotNull(backupStorageCredentialHistory.broadcastUntil),
      isNull(backupStorageCredentialHistory.revokedAt),
    ))
    .orderBy(backupStorageCredentialHistory.firstSeenAt);
  return rows.map((r) => ({
    id: r.id,
    configId: r.configId,
    configName: r.configName ?? null,
    storageIdentity: r.storageIdentity,
    broadcastUntil: r.broadcastUntil!,
    supersededAt: r.supersededAt,
    canCheck: r.supersededAt !== null && r.sealed !== null,
    lastProbeAt: r.lastProbeAt,
    lastProbeOutcome: r.lastProbeOutcome,
  }));
}

/** Erases sealed settings of keys replaced more than 30 days ago. System context. */
export async function eraseExpiredSealedSettings(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - SEALED_PREVIOUS_SECRET_RETENTION_MS);
  const rows = await withSystemDbAccessContext(() => db.update(backupStorageCredentialHistory)
    .set({ sealedPreviousSecret: null, updatedAt: now })
    .where(and(
      isNotNull(backupStorageCredentialHistory.sealedPreviousSecret),
      lt(backupStorageCredentialHistory.supersededAt, cutoff),
    ))
    .returning({ id: backupStorageCredentialHistory.id }));
  return rows.length;
}
