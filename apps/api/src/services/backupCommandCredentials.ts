/**
 * Storage destinations for backup/restore/verify agent commands are resolved
 * at DELIVERY, never embedded at enqueue.
 *
 * `device_commands.payload` is a system-scoped, unbounded-retention JSONB
 * column; anything written there is readable by every path that reads command
 * rows (history, audit export, dumps) for as long as the row lives. So the
 * enqueue sites persist only a stable reference — `providerConfigRef:
 * { configId, orgId }` next to the non-secret `provider` (and, for writes, the
 * `storageEncryption` plan) — and the delivery refreshers registered in
 * `commandDelivery.ts` resolve the destination and put `providerConfig` into
 * the outgoing frame only. The agent receives exactly the payload shape it
 * always has; `providerConfigRef` itself never goes on the wire.
 *
 * The reference is bound to the device at delivery: the destination is
 * resolved only when the target device belongs to the SAME organization that
 * owns the referenced configuration. A reference therefore cannot be used to
 * obtain another organization's destination, whoever authored it.
 */
import { and, eq } from 'drizzle-orm';
import { db, hasDbAccessContext, withDbAccessContext } from '../db';
import { devices } from '../db/schema';
import { resolveBackupProviderConfig, resolveBackupWriteCommandDestination } from './backupProviderConfig';
import { CommandTypes } from './commandTypes';
import { CommandDeliveryRefusedError, type DeliveryRefreshContext } from './commandDeliveryRefusal';
import { BACKUP_READ_CREDENTIAL_COMMAND_TYPES } from './backupReadHelperGate';
import { recordBackupWriteDispatch } from './backupMetrics';

export const PROVIDER_CONFIG_REF_FIELD = 'providerConfigRef';

export type BackupProviderConfigRef = { configId: string; orgId: string };

export type BackupStorageEncryptionPlan =
  | { required: false; mode: 'disabled' }
  | { required: true; mode: string; keyReference: string | null };

/** Commands that READ a snapshot back from the destination named in their payload. */
export { BACKUP_READ_CREDENTIAL_COMMAND_TYPES };

/**
 * Commands that WRITE to the destination named in their payload. `backup_run`
 * is deliberately absent: the backup worker sends it over the live socket (or
 * the sealed cross-process relay) without ever persisting a command row.
 */
export const BACKUP_WRITE_CREDENTIAL_COMMAND_TYPES: readonly string[] = [
  CommandTypes.MSSQL_BACKUP,
  CommandTypes.HYPERV_BACKUP,
];

const READ_TYPES = new Set(BACKUP_READ_CREDENTIAL_COMMAND_TYPES);
const WRITE_TYPES = new Set(BACKUP_WRITE_CREDENTIAL_COMMAND_TYPES);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Payload fields for a read command: provider name + reference, no credential. */
export function backupReadCredentialPayload(
  configId: string,
  orgId: string,
  provider: string,
): { provider: string; providerConfigRef: BackupProviderConfigRef } {
  return { provider, [PROVIDER_CONFIG_REF_FIELD]: { configId, orgId } } as {
    provider: string;
    providerConfigRef: BackupProviderConfigRef;
  };
}

/**
 * Payload fields for a write command: provider name, the non-secret encryption
 * plan decided at enqueue (the agent enforces it), and the reference.
 */
export function backupWriteCredentialPayload(
  configId: string,
  orgId: string,
  destination: { provider: string; storageEncryption: BackupStorageEncryptionPlan },
): {
  provider: string;
  storageEncryption: BackupStorageEncryptionPlan;
  providerConfigRef: BackupProviderConfigRef;
} {
  return {
    provider: destination.provider,
    storageEncryption: destination.storageEncryption,
    [PROVIDER_CONFIG_REF_FIELD]: { configId, orgId },
  } as {
    provider: string;
    storageEncryption: BackupStorageEncryptionPlan;
    providerConfigRef: BackupProviderConfigRef;
  };
}

function parseRef(value: unknown): BackupProviderConfigRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CommandDeliveryRefusedError('The queued command carries a malformed storage destination reference.');
  }
  const { configId, orgId } = value as Record<string, unknown>;
  if (typeof configId !== 'string' || !UUID_PATTERN.test(configId)
    || typeof orgId !== 'string' || !UUID_PATTERN.test(orgId)) {
    throw new CommandDeliveryRefusedError('The queued command carries a malformed storage destination reference.');
  }
  return { configId, orgId };
}

function sameEncryptionPlan(a: unknown, b: BackupStorageEncryptionPlan): boolean {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  return left.required === right.required
    && left.mode === right.mode
    && (left.keyReference ?? null) === (right.keyReference ?? null);
}

/**
 * Join the context the delivery path already holds (the heartbeat's
 * org-scoped transaction, the REST poll's system context, a request context on
 * the enqueue-time push) rather than opening a second pooled connection inside
 * it. Only a caller holding no context at all — the direct `executeCommand`
 * push, which runs outside the request transaction — gets a fresh,
 * organization-scoped one for the referenced org. Every query below also
 * filters on the org explicitly, so the result is the same under a joined
 * system context.
 */
async function inReferencedOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  if (hasDbAccessContext()) return fn();
  return withDbAccessContext(
    {
      scope: 'organization',
      orgId,
      accessibleOrgIds: [orgId],
      label: 'backupCommandCredentials.delivery',
    },
    fn,
  );
}

/**
 * Delivery refresher for every storage-destination command type. Returns the
 * wire payload: the stored payload minus `providerConfigRef`, plus the
 * resolved `provider`/`providerConfig` (and, for writes, the re-checked
 * `storageEncryption`). For a READ it resolves only a local destination: an
 * S3 read is served through a storage session instead, and is refused here.
 *
 * A payload with no reference is returned untouched. That covers rows queued
 * before references existed (their inline destination is still delivered, and
 * is erased when the row goes terminal) and rows whose inline destination was
 * sealed at persistence (opened later by `decryptCommandForDelivery`).
 *
 * Refuses (CommandDeliveryRefusedError) when the command can never be
 * delivered as queued; any other error is transient and propagates so the row
 * is released for a later attempt.
 */
export async function materializeBackupStorageCredentials(
  payload: Record<string, unknown>,
  ctx: DeliveryRefreshContext,
): Promise<Record<string, unknown>> {
  if (!(PROVIDER_CONFIG_REF_FIELD in payload)) return payload;

  const isWrite = WRITE_TYPES.has(ctx.type);
  if (!isWrite && !READ_TYPES.has(ctx.type)) {
    throw new CommandDeliveryRefusedError(
      `Command type ${ctx.type} does not take a storage destination reference.`,
    );
  }
  const ref = parseRef(payload[PROVIDER_CONFIG_REF_FIELD]);
  const { [PROVIDER_CONFIG_REF_FIELD]: _ref, ...rest } = payload;

  return inReferencedOrg(ref.orgId, async () => {
    const [device] = await db
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.id, ctx.deviceId), eq(devices.orgId, ref.orgId)))
      .limit(1);
    if (!device) {
      throw new CommandDeliveryRefusedError(
        'The target device no longer belongs to the organization that owns this backup destination.',
      );
    }

    if (isWrite) {
      const result = await resolveBackupWriteCommandDestination(ref.configId, ref.orgId);
      if (!result.ok) {
        throw new CommandDeliveryRefusedError(`The backup destination can no longer be used: ${result.message}`);
      }
      const { destination } = result;
      if (destination.provider !== rest.provider) {
        throw new CommandDeliveryRefusedError(
          'The backup destination changed provider after this command was queued; run it again.',
        );
      }
      if (!sameEncryptionPlan(rest.storageEncryption, destination.storageEncryption)) {
        throw new CommandDeliveryRefusedError(
          'The backup destination encryption settings changed after this command was queued; run it again.',
        );
      }
      if (destination.provider === 'local') {
        recordBackupWriteDispatch(ctx.type, 'local', 'no_credential');
      } else {
        recordBackupWriteDispatch(ctx.type, 'legacy_credential', 'delivery_refresher');
      }
      return {
        ...rest,
        provider: destination.provider,
        providerConfig: destination.providerConfig,
        storageEncryption: destination.storageEncryption,
      };
    }

    const resolved = await resolveBackupProviderConfig(ref.configId, ref.orgId);
    if (!resolved) {
      throw new CommandDeliveryRefusedError('The backup destination configuration for this command no longer exists.');
    }
    if (resolved.provider !== rest.provider) {
      throw new CommandDeliveryRefusedError(
        'The backup destination changed provider after this command was queued; run it again.',
      );
    }
    // A read is served through a storage session (backupStorageSessions.ts);
    // only a local destination — a path, not a credential — is ever resolved
    // into a read command here.
    if (resolved.provider !== 'local') {
      throw new CommandDeliveryRefusedError('This backup can only be read through a secure storage session.');
    }
    return { ...rest, provider: resolved.provider, providerConfig: resolved.providerConfig };
  });
}
