import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { db } from '../db';
import {
  backupConfigs,
  backupJobs,
  backupSnapshots,
  devices,
  recoveryMediaArtifacts,
  recoveryTokens,
  restoreJobs,
} from '../db/schema';
import { getGithubReleasePageUrl } from './binarySource';

export const BMR_BOOTSTRAP_VERSION = 1;
export const BMR_MIN_HELPER_VERSION =
  process.env.BREEZE_VERSION ||
  process.env.BINARY_VERSION ||
  '0.5.0';
export const RECOVERY_DOWNLOAD_SESSION_TTL_MS = 60 * 60 * 1000;
export const RECOVERY_TOKEN_REGEX = /^brz_rec_[a-f0-9]{64}$/;

export function hashRecoveryToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateRecoveryToken(): string {
  return `brz_rec_${randomBytes(32).toString('hex')}`;
}

export function isValidRecoveryTokenFormat(token: string): boolean {
  return RECOVERY_TOKEN_REGEX.test(token);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

export function asNullableRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : null;
}

export function getStringValue(record: Record<string, unknown> | null, key: string): string | null {
  if (!record) return null;
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function toIsoString(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function resolveServerUrl(requestUrl?: string): string {
  return (
    process.env.BREEZE_SERVER ||
    process.env.PUBLIC_API_URL ||
    (requestUrl ? new URL(requestUrl).origin : 'http://localhost:3001')
  ).replace(/\/+$/, '');
}

export function computeRecoveryDownloadExpiry(
  authenticatedAt: Date | string | null | undefined,
  tokenExpiresAt: Date | string | null | undefined
): Date | null {
  if (!authenticatedAt || !tokenExpiresAt) return null;

  const authenticated = authenticatedAt instanceof Date ? authenticatedAt : new Date(authenticatedAt);
  const tokenExpiry = tokenExpiresAt instanceof Date ? tokenExpiresAt : new Date(tokenExpiresAt);
  if (Number.isNaN(authenticated.getTime()) || Number.isNaN(tokenExpiry.getTime())) return null;

  return new Date(
    Math.min(
      authenticated.getTime() + RECOVERY_DOWNLOAD_SESSION_TTL_MS,
      tokenExpiry.getTime()
    )
  );
}

export function buildRecoveryDownloadDescriptor(args: {
  requestUrl?: string;
  providerSnapshotId: string;
  authenticatedAt?: Date | string | null;
  tokenExpiresAt?: Date | string | null;
}) {
  const serverUrl = resolveServerUrl(args.requestUrl);
  const expiresAt = computeRecoveryDownloadExpiry(args.authenticatedAt, args.tokenExpiresAt);
  const advertiseQueryToken =
    process.env.BMR_RECOVERY_ADVERTISE_QUERY_TOKEN === '1' ||
    process.env.BMR_RECOVERY_ADVERTISE_QUERY_TOKEN === 'true';

  return {
    type: 'breeze_proxy',
    method: 'GET',
    url: `${serverUrl}/api/v1/backup/bmr/recover/download`,
    ...(advertiseQueryToken ? { tokenQueryParam: 'token' } : {}),
    tokenHeaderName: 'authorization',
    tokenHeaderFormat: 'Bearer <recovery-token>',
    pathQueryParam: 'path',
    requiresAuthentication: true,
    pathPrefix: `snapshots/${args.providerSnapshotId}`,
    expiresAt: expiresAt?.toISOString() ?? null,
  };
}

export async function expireUnusedRecoveryTokens(): Promise<void> {
  await db
    .update(recoveryTokens)
    .set({ status: 'expired' })
    .where(
      and(
        inArray(recoveryTokens.status, ['active', 'authenticated']),
        lt(recoveryTokens.expiresAt, new Date())
      )
    );
}

export async function syncExpiredRecoveryMediaArtifacts(orgId?: string): Promise<void> {
  const inactiveTokens = await db
    .select({ id: recoveryTokens.id })
    .from(recoveryTokens)
    .where(
      orgId
        ? and(
            eq(recoveryTokens.orgId, orgId),
            inArray(recoveryTokens.status, ['expired', 'revoked', 'used'])
          )
        : inArray(recoveryTokens.status, ['expired', 'revoked', 'used'])
    );

  const tokenIds = inactiveTokens.map((row) => row.id);
  if (tokenIds.length === 0) return;

  await db
    .update(recoveryMediaArtifacts)
    .set({ status: 'expired' })
    .where(
      and(
        inArray(recoveryMediaArtifacts.tokenId, tokenIds),
        inArray(recoveryMediaArtifacts.status, ['pending', 'building', 'ready', 'failed'])
      )
    );
}

export async function resolveSnapshotProviderConfig(snapshotDbId: string) {
  const [snapshot] = await db
    .select({
      id: backupSnapshots.id,
      orgId: backupSnapshots.orgId,
      jobId: backupSnapshots.jobId,
      deviceId: backupSnapshots.deviceId,
      snapshotId: backupSnapshots.snapshotId,
      configId: backupSnapshots.configId,
      label: backupSnapshots.label,
      location: backupSnapshots.location,
      timestamp: backupSnapshots.timestamp,
      size: backupSnapshots.size,
      fileCount: backupSnapshots.fileCount,
      metadata: backupSnapshots.metadata,
      backupType: backupSnapshots.backupType,
      hardwareProfile: backupSnapshots.hardwareProfile,
      systemStateManifest: backupSnapshots.systemStateManifest,
      isIncremental: backupSnapshots.isIncremental,
    })
    .from(backupSnapshots)
    .where(eq(backupSnapshots.id, snapshotDbId))
    .limit(1);

  if (!snapshot) return null;

  const metadata = asRecord(snapshot.metadata);
  let configId = snapshot.configId ?? getStringValue(metadata, 'configId');
  if (!configId && snapshot.jobId) {
    const [job] = await db
      .select({ configId: backupJobs.configId })
      .from(backupJobs)
      .where(eq(backupJobs.id, snapshot.jobId))
      .limit(1);
    configId = job?.configId ?? null;
  }

  if (!configId) {
    return {
      snapshot,
      config: null,
      providerType:
        getStringValue(metadata, 'provider') ||
        getStringValue(metadata, 'providerType') ||
        getStringValue(metadata, 'storageProvider'),
      providerConfig:
        asNullableRecord(metadata.providerConfig) ||
        asNullableRecord(metadata.providerDetails) ||
        asNullableRecord(metadata.storageConfig),
    };
  }

  const [config] = await db
    .select({
      id: backupConfigs.id,
      orgId: backupConfigs.orgId,
      name: backupConfigs.name,
      type: backupConfigs.type,
      provider: backupConfigs.provider,
      providerConfig: backupConfigs.providerConfig,
      schedule: backupConfigs.schedule,
      retention: backupConfigs.retention,
      isActive: backupConfigs.isActive,
    })
    .from(backupConfigs)
    .where(eq(backupConfigs.id, configId))
    .limit(1);

  return {
    snapshot,
    config: config ?? null,
    providerType:
      config?.provider ||
      getStringValue(metadata, 'provider') ||
      getStringValue(metadata, 'providerType') ||
      getStringValue(metadata, 'storageProvider'),
    providerConfig:
      asNullableRecord(config?.providerConfig) ||
      asNullableRecord(metadata.providerConfig) ||
      asNullableRecord(metadata.providerDetails) ||
      asNullableRecord(metadata.storageConfig),
  };
}

export async function resolveRecoveryTokenPresentation(orgId: string, tokenId: string, requestUrl?: string) {
  const [row] = await db
    .select()
    .from(recoveryTokens)
    .where(and(eq(recoveryTokens.id, tokenId), eq(recoveryTokens.orgId, orgId)))
    .limit(1);

  if (!row) return null;

  const resolvedSnapshot = await resolveSnapshotProviderConfig(row.snapshotId);
  const snapshot = resolvedSnapshot?.snapshot ?? null;
  const config = resolvedSnapshot?.config ?? null;

  const [device] = await db
    .select({
      id: devices.id,
      hostname: devices.hostname,
      osType: devices.osType,
      architecture: devices.architecture,
      displayName: devices.displayName,
    })
    .from(devices)
    .where(eq(devices.id, row.deviceId))
    .limit(1);

  const [restoreJob] = await db
    .select({
      id: restoreJobs.id,
      status: restoreJobs.status,
      createdAt: restoreJobs.createdAt,
      startedAt: restoreJobs.startedAt,
      completedAt: restoreJobs.completedAt,
      restoredFiles: restoreJobs.restoredFiles,
      restoredSize: restoreJobs.restoredSize,
      targetConfig: restoreJobs.targetConfig,
    })
    .from(restoreJobs)
    .where(eq(restoreJobs.recoveryTokenId, row.id))
    .orderBy(desc(restoreJobs.createdAt))
    .limit(1);

  const serverUrl = resolveServerUrl(requestUrl);
  const sessionStatus =
    row.status === 'revoked' || row.status === 'expired'
      ? row.status
      : row.completedAt || row.status === 'used'
        ? 'completed'
        : row.status === 'authenticated' || row.authenticatedAt || row.usedAt
          ? 'authenticated'
          : 'pending';

  return {
    id: row.id,
    deviceId: row.deviceId,
    snapshotId: row.snapshotId,
    restoreType: row.restoreType,
    status: row.status,
    sessionStatus,
    createdAt: toIsoString(row.createdAt),
    expiresAt: toIsoString(row.expiresAt),
    authenticatedAt: toIsoString(row.authenticatedAt),
    completedAt: toIsoString(row.completedAt),
    usedAt: toIsoString(row.usedAt),
    targetConfig: asNullableRecord(row.targetConfig),
    device: device
      ? {
          id: device.id,
          hostname: device.hostname,
          displayName: device.displayName ?? null,
          osType: device.osType,
          architecture: device.architecture,
        }
      : null,
    snapshot: snapshot
      ? {
          id: snapshot.id,
          orgId: snapshot.orgId,
          jobId: snapshot.jobId,
          deviceId: snapshot.deviceId,
          configId: snapshot.configId ?? null,
          snapshotId: snapshot.snapshotId,
          label: snapshot.label,
          location: snapshot.location,
          timestamp: toIsoString(snapshot.timestamp),
          size: snapshot.size,
          fileCount: snapshot.fileCount,
          hardwareProfile: snapshot.hardwareProfile,
          systemStateManifest: snapshot.systemStateManifest,
          backupType: snapshot.backupType,
          isIncremental: snapshot.isIncremental,
          metadata: asRecord(snapshot.metadata),
        }
      : null,
    linkedRestoreJob: restoreJob
      ? {
          id: restoreJob.id,
          status: restoreJob.status,
          createdAt: toIsoString(restoreJob.createdAt),
          startedAt: toIsoString(restoreJob.startedAt),
          completedAt: toIsoString(restoreJob.completedAt),
          restoredFiles: restoreJob.restoredFiles,
          restoredSize: restoreJob.restoredSize,
          result: asRecord(restoreJob.targetConfig).result ?? null,
        }
      : null,
    bootstrap: {
      version: BMR_BOOTSTRAP_VERSION,
      minHelperVersion: BMR_MIN_HELPER_VERSION,
      serverUrl,
      releaseUrl: getGithubReleasePageUrl(),
      commandTemplate: `breeze-backup bmr-recover --token <recovery-token> --server "${serverUrl}"`,
      prerequisites: [
        'Boot the target machine into a compatible recovery environment.',
        'Ensure the environment can reach the Breeze server and backup storage.',
        'Download the current breeze-backup helper before starting recovery.',
        'Have storage or network drivers ready if the target hardware needs them.',
      ],
      restoreType: row.restoreType,
      providerType: resolvedSnapshot?.providerType ?? null,
      backupConfig: config
        ? {
            id: config.id,
            orgId: config.orgId,
            name: config.name,
            type: config.type,
            provider: config.provider,
            isActive: config.isActive,
          }
        : null,
      download:
        snapshot?.snapshotId
          ? buildRecoveryDownloadDescriptor({
              requestUrl,
              providerSnapshotId: snapshot.snapshotId,
              authenticatedAt: row.authenticatedAt,
              tokenExpiresAt: row.expiresAt,
            })
          : null,
    },
  };
}

export function buildAuthenticatedBootstrapPayload(args: {
  tokenId: string;
  deviceId: string;
  snapshotId: string;
  restoreType: string;
  targetConfig: unknown;
  authenticatedAt: Date;
  device: Record<string, unknown> | null;
  snapshot: Record<string, unknown> | null;
  providerType: string | null | undefined;
  config: Record<string, unknown> | null | undefined;
  requestUrl?: string;
  tokenExpiresAt?: Date | string | null;
}) {
  const providerSnapshotId =
    getStringValue(asNullableRecord(args.snapshot), 'snapshotId') ?? args.snapshotId;
  const bootstrap = {
    version: BMR_BOOTSTRAP_VERSION,
    minHelperVersion: BMR_MIN_HELPER_VERSION,
    tokenId: args.tokenId,
    device: args.device,
    snapshot: args.snapshot,
    restoreType: args.restoreType,
    targetConfig: args.targetConfig ?? null,
    providerType: args.providerType ?? null,
    backupConfig: args.config
      ? {
          id: args.config.id ?? null,
          name: args.config.name ?? null,
          type: args.config.type ?? null,
          provider: args.config.provider ?? null,
          isActive: args.config.isActive ?? null,
        }
      : null,
    download: providerSnapshotId
      ? buildRecoveryDownloadDescriptor({
          requestUrl: args.requestUrl,
          providerSnapshotId,
          authenticatedAt: args.authenticatedAt,
          tokenExpiresAt: args.tokenExpiresAt,
        })
      : null,
  };

  return {
    version: BMR_BOOTSTRAP_VERSION,
    minHelperVersion: BMR_MIN_HELPER_VERSION,
    tokenId: args.tokenId,
    deviceId: args.deviceId,
    snapshotId: args.snapshotId,
    restoreType: args.restoreType,
    targetConfig: args.targetConfig ?? null,
    device: args.device,
    snapshot: args.snapshot,
    authenticatedAt: args.authenticatedAt.toISOString(),
    bootstrap,
  };
}
