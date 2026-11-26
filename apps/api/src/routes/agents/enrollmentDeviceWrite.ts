/**
 * Device-write steps shared by the two enrollment paths of POST /agents/enroll:
 * the org enrollment key (routes/agents/enrollment.ts) and the holding-area
 * deploy key (routes/agents/enrollmentDeployKey.ts, #8318 wave D-1).
 *
 * Only what both paths must do identically lives here: minting the install's
 * credentials, recognising the agent's own row among the hostname colliders,
 * the column sets of a fresh device row and of an in-place re-enrollment, and
 * the hardware / network inventory written in the device transaction. Each
 * path keeps its own lookups, gates, refusals and audit rows.
 *
 * No schema object is touched at module level, so suites that replace
 * db/schema with a partial mock can import this file.
 */
import { createHash, timingSafeEqual } from 'crypto';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { db } from '../../db';
import { deviceHardware, deviceNetwork, devices } from '../../db/schema';
import { CLEARED_AGENT_CREDENTIALS } from '../../services/agentCredentialHashes';
import { normalizeRebindProtocolVersion } from '../../services/deviceReattach/protocol';
import { markTopologyIdentityDirty } from '../../services/topology/identityDirty';
import { generateAgentId, generateApiKey } from './helpers';
import type { enrollSchema } from './schemas';

export type EnrollBody = z.infer<typeof enrollSchema>;
export type EnrollmentTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left);
  const rightBuf = Buffer.from(right);
  return leftBuf.length === rightBuf.length && timingSafeEqual(leftBuf, rightBuf);
}

/** The existing install's bearer token, presented to prove a re-enrollment. */
export function getProvidedExistingDeviceToken(c: { req: { header(name: string): string | undefined } }): string {
  const explicit = c.req.header('x-agent-reenrollment-token')?.trim();
  if (explicit) {
    return explicit;
  }

  const authorization = c.req.header('authorization')?.trim() ?? '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? '';
}

export function tokenHashMatches(storedHash: string | null | undefined, presentedToken: string, now: Date, expiresAt?: Date | null): boolean {
  if (!storedHash || !presentedToken) {
    return false;
  }
  if (expiresAt && expiresAt <= now) {
    return false;
  }
  const presentedHash = createHash('sha256').update(presentedToken).digest('hex');
  return timingSafeStringEqual(storedHash, presentedHash);
}

/** The columns read for each hostname collider. */
export function collidingDeviceColumns() {
  return {
    id: devices.id,
    agentId: devices.agentId,
    status: devices.status,
    agentTokenHash: devices.agentTokenHash,
    previousTokenHash: devices.previousTokenHash,
    previousTokenExpiresAt: devices.previousTokenExpiresAt,
    pendingTokenHash: devices.pendingTokenHash,
    // #8318 §6.4: re-enroll revokes EVERY hash of the row it rewrites —
    // watchdog and helper, current, previous and pending — not the agent
    // hashes alone.
    watchdogTokenHash: devices.watchdogTokenHash,
    previousWatchdogTokenHash: devices.previousWatchdogTokenHash,
    pendingWatchdogTokenHash: devices.pendingWatchdogTokenHash,
    helperTokenHash: devices.helperTokenHash,
    previousHelperTokenHash: devices.previousHelperTokenHash,
    pendingHelperTokenHash: devices.pendingHelperTokenHash,
    agentTokenSuspendedAt: devices.agentTokenSuspendedAt,
  };
}

/**
 * The collider whose credential the agent presented, if any. A suspended row
 * can never authenticate (suspension binds its credential).
 */
export function findAuthenticatedCollider<T extends {
  agentTokenSuspendedAt: Date | null;
  agentTokenHash: string | null;
  previousTokenHash: string | null;
  previousTokenExpiresAt: Date | null;
}>(colliders: readonly T[], presentedToken: string, now: Date): T | undefined {
  if (!presentedToken) return undefined;
  return colliders.find(
    (candidate) =>
      !candidate.agentTokenSuspendedAt &&
      (tokenHashMatches(candidate.agentTokenHash, presentedToken, now) ||
        tokenHashMatches(candidate.previousTokenHash, presentedToken, now, candidate.previousTokenExpiresAt)),
  );
}

export interface EnrollmentCredentials {
  agentId: string;
  apiKey: string;
  watchdogApiKey: string;
  helperApiKey: string;
  tokenIssuedAt: Date;
  tokenHash: string;
  watchdogTokenHash: string;
  helperTokenHash: string;
}

/** A new install's agent id and three bearer tokens; only their hashes are stored. */
export function mintEnrollmentCredentials(): EnrollmentCredentials {
  const agentId = generateAgentId();
  const apiKey = generateApiKey();
  const watchdogApiKey = generateApiKey();
  const helperApiKey = generateApiKey();
  const tokenIssuedAt = new Date();
  // Agent bearer tokens are high-entropy random values; we store only a SHA-256 hash and never persist
  // the plaintext token.
  // lgtm[js/insufficient-password-hash]
  const tokenHash = createHash('sha256').update(apiKey).digest('hex');
  // lgtm[js/insufficient-password-hash]
  const watchdogTokenHash = createHash('sha256').update(watchdogApiKey).digest('hex');
  // lgtm[js/insufficient-password-hash]
  const helperTokenHash = createHash('sha256').update(helperApiKey).digest('hex');
  return { agentId, apiKey, watchdogApiKey, helperApiKey, tokenIssuedAt, tokenHash, watchdogTokenHash, helperTokenHash };
}

/** The columns of an in-place re-enrollment (a full credential reset onto the matched row). */
export function reenrollDeviceSet(input: {
  data: EnrollBody;
  credentials: EnrollmentCredentials;
  enrollmentIp: string | null;
}) {
  const { data, credentials: cr, enrollmentIp } = input;
  return {
    // A full credential reset: every credential column starts from
    // "none" (the one shared set, so a future credential column cannot
    // survive), then the new install's current set is written. Issue
    // #2621: that includes any staged rotation, which would otherwise
    // keep authenticating and be promoted over the fresh credentials.
    ...CLEARED_AGENT_CREDENTIALS,
    agentId: cr.agentId,
    enrollmentIp,
    agentTokenHash: cr.tokenHash,
    watchdogTokenHash: cr.watchdogTokenHash,
    helperTokenHash: cr.helperTokenHash,
    osType: data.osType,
    osVersion: data.osVersion,
    architecture: data.architecture,
    agentVersion: data.agentVersion,
    tokenIssuedAt: cr.tokenIssuedAt,
    watchdogTokenIssuedAt: cr.tokenIssuedAt,
    helperTokenIssuedAt: cr.tokenIssuedAt,
    deviceRole: data.deviceRole || 'unknown',
    deviceRoleSource: 'auto' as const,
    isVirtual: data.isVirtual ?? false,
    virtualizationPlatform: data.virtualizationPlatform ?? null,
    // #8318 §6.2: re-enroll is a new install, so its declared rebind
    // capability is rewritten (not blindly reset to 0).
    rebindProtocolVersion: normalizeRebindProtocolVersion(data.securityCapabilities?.rebindProtocolVersion),
    // A new install: what the previous one reported about its backup
    // helper no longer holds. Backups and restores for this device
    // wait for the new install's first heartbeat, as for a new device.
    backupReadProtocolVersion: null,
    backupIntegrityProtocolVersion: null,
    backupWriteProtocolVersion: null,
    // #8318 §6.4 / §5.7 (review of wave 1b-1): the claims the previous
    // install stamped belong to it, as at a reattach confirm's
    // boundary (deviceInstallBoundary/handlers/deviceRow.ts). Left
    // set, the once-per-install edition-migration claim kept
    // auto-migration off for the new install with nothing logged,
    // and the old install's uninstall intent stayed armed for the
    // reaper until the new install's first beat — no longer covered
    // by the migration-window exemption once that claim is gone.
    editionMigrationDispatchedAt: null,
    uninstallIntentAt: null,
    // #8318 wave T2: a new install on this row. The TPM key baseline
    // stays (device_hardware), but a proof the previous install made
    // is not this one's (services/deviceReattach/evidence.ts).
    installEnrolledAt: cr.tokenIssuedAt,
    status: 'pending' as const,
    updatedAt: new Date(),
  };
}

/** The columns every fresh device row starts with; each path adds its own. */
export function freshDeviceValues(input: {
  data: EnrollBody;
  credentials: EnrollmentCredentials;
  enrollmentIp: string | null;
  orgId: string;
  siteId: string;
}) {
  const { data, credentials: cr, enrollmentIp } = input;
  return {
    orgId: input.orgId,
    siteId: input.siteId,
    agentId: cr.agentId,
    agentTokenHash: cr.tokenHash,
    watchdogTokenHash: cr.watchdogTokenHash,
    helperTokenHash: cr.helperTokenHash,
    hostname: data.hostname,
    enrollmentIp,
    osType: data.osType,
    osVersion: data.osVersion,
    architecture: data.architecture,
    agentVersion: data.agentVersion,
    tokenIssuedAt: cr.tokenIssuedAt,
    watchdogTokenIssuedAt: cr.tokenIssuedAt,
    helperTokenIssuedAt: cr.tokenIssuedAt,
    deviceRole: data.deviceRole || 'unknown',
    deviceRoleSource: 'auto' as const,
    isVirtual: data.isVirtual ?? false,
    virtualizationPlatform: data.virtualizationPlatform ?? null,
    // #8318 §6.2: a new install is what a reattach makes the source.
    rebindProtocolVersion: normalizeRebindProtocolVersion(data.securityCapabilities?.rebindProtocolVersion),
    status: 'pending' as const,
  };
}

/**
 * The inventory the agent sent with its enrollment, on the device transaction:
 * the hardware row (upserted) and the NIC list (replaced).
 */
export async function writeEnrollmentInventory(
  tx: EnrollmentTx,
  dev: { id: string; orgId: string; siteId: string },
  data: EnrollBody,
  options: { freshRow: boolean },
): Promise<void> {
  if (data.hardwareInfo) {
    await tx
      .insert(deviceHardware)
      .values({
        deviceId: dev.id,
        orgId: dev.orgId,
        cpuModel: data.hardwareInfo.cpuModel,
        cpuCores: data.hardwareInfo.cpuCores,
        cpuThreads: data.hardwareInfo.cpuThreads,
        ramTotalMb: data.hardwareInfo.ramTotalMb,
        diskTotalGb: data.hardwareInfo.diskTotalGb,
        gpuModel: data.hardwareInfo.gpuModel,
        serialNumber: data.hardwareInfo.serialNumber,
        productSku: data.hardwareInfo.productSku,
        manufacturer: data.hardwareInfo.manufacturer,
        model: data.hardwareInfo.model,
        motherboardManufacturer: data.hardwareInfo.motherboardManufacturer,
        motherboardProduct: data.hardwareInfo.motherboardProduct,
        motherboardVersion: data.hardwareInfo.motherboardVersion,
        biosVersion: data.hardwareInfo.biosVersion,
        // #8318 §7.2: normalized by the schema; undefined (not sent) is
        // skipped, null (rejected) is stored as NULL.
        systemUuid: data.hardwareInfo.systemUuid
      })
      .onConflictDoUpdate({
        target: deviceHardware.deviceId,
        set: {
          cpuModel: data.hardwareInfo.cpuModel,
          cpuCores: data.hardwareInfo.cpuCores,
          cpuThreads: data.hardwareInfo.cpuThreads,
          ramTotalMb: data.hardwareInfo.ramTotalMb,
          diskTotalGb: data.hardwareInfo.diskTotalGb,
          gpuModel: data.hardwareInfo.gpuModel,
          serialNumber: data.hardwareInfo.serialNumber,
          productSku: data.hardwareInfo.productSku,
          manufacturer: data.hardwareInfo.manufacturer,
          model: data.hardwareInfo.model,
          motherboardManufacturer: data.hardwareInfo.motherboardManufacturer,
          motherboardProduct: data.hardwareInfo.motherboardProduct,
          motherboardVersion: data.hardwareInfo.motherboardVersion,
          biosVersion: data.hardwareInfo.biosVersion,
          systemUuid: data.hardwareInfo.systemUuid,
          updatedAt: new Date()
        }
      });
  }

  if (data.networkInfo && data.networkInfo.length > 0) {
    await tx.delete(deviceNetwork).where(eq(deviceNetwork.deviceId, dev.id));
    for (const nic of data.networkInfo) {
      await tx
        .insert(deviceNetwork)
        .values({
          deviceId: dev.id,
          orgId: dev.orgId,
          interfaceName: nic.name,
          macAddress: nic.mac,
          ipAddress: nic.ip,
          ipType: nic.ip?.includes(':') ? 'ipv6' : 'ipv4',
          isPrimary: nic.isPrimary ?? false
        });
    }
    // M2 D15.2/D16: NIC MACs are the physical topology publisher's trusted
    // MAC binding source. A re-enrolled (in-place) device may have new NICs
    // that the next inventory report will then see as unchanged, so mark
    // here; a fresh row has no topology binding yet.
    if (!options.freshRow) await markTopologyIdentityDirty(tx, { orgId: dev.orgId, siteId: dev.siteId });
  }
}
