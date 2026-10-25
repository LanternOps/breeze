/**
 * Fixtures for the reinstall-reattach integration suites (#8318 wave 1b):
 * a partner with two customer orgs and its holding org, a full partner admin
 * and a technician limited to org A, and devices seeded with real credentials
 * (so the REAL agent router authenticates them) over the privileged test
 * connection.
 */
import { createHash, randomUUID } from 'node:crypto';
import { eq, notInArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { deviceReattachIntents, devices, manifestSigningKeys, partnerUsers } from '../../db/schema';
import { ensureActiveSigningKey, invalidateManifestTrustCaches } from '../../services/manifestSigning';
import { declareParkedDeviceAdmission } from '../../services/unassignedPool/admission';
import { createOrganization, createPartner, createRole, createSite, createUser, grantRolePermissions } from './db-utils';
import { getTestDb } from './setup';
import { seedHoldingOrg } from './unassignedPoolFixtures';

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * The directive is signed with the deployment key, which the server never
 * creates on its own. A suite that needs one creates it before each test and
 * removes what it created afterwards: `manifest_signing_keys` is not truncated
 * between tests, and later suites in the same run expect a deployment without
 * a key (heartbeatRetainState pins `"manifestTrustKeys":[]`).
 */
export function useDeploymentSigningKey(): void {
  let preexisting: string[] = [];
  beforeAll(async () => {
    preexisting = (await getTestDb().select({ keyId: manifestSigningKeys.keyId }).from(manifestSigningKeys)).map((r) => r.keyId);
  });
  beforeEach(async () => {
    await ensureActiveSigningKey();
  });
  afterAll(async () => {
    await getTestDb().delete(manifestSigningKeys).where(
      preexisting.length > 0 ? notInArray(manifestSigningKeys.keyId, preexisting) : sql`true`,
    );
    invalidateManifestTrustCaches();
  });
}

const DEVICE_GRANTS = [
  { resource: 'devices', action: 'read' },
  { resource: 'devices', action: 'write' },
  { resource: 'devices', action: 'delete' },
];

async function partnerUser(
  partnerId: string,
  label: string,
  access: { orgAccess: 'all' | 'selected'; orgIds?: string[] },
  grants = DEVICE_GRANTS,
) {
  const user = await createUser({ partnerId, email: `${label}-${randomUUID()}@reattach.test`, name: label });
  const role = await createRole({ scope: 'partner', partnerId, name: `${label} ${randomUUID().slice(0, 8)}` });
  await grantRolePermissions(role.id, grants);
  await getTestDb().insert(partnerUsers).values({
    userId: user.id,
    partnerId,
    roleId: role.id,
    orgAccess: access.orgAccess,
    orgIds: access.orgIds ?? null,
  });
  return user;
}

export async function seedReattachTenant() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: orgA.id });
  const siteB = await createSite({ orgId: orgB.id });
  const pool = await seedHoldingOrg(partner.id);
  const admin = await partnerUser(partner.id, 'admin', { orgAccess: 'all' });
  const techA = await partnerUser(partner.id, 'tech', { orgAccess: 'selected', orgIds: [orgA.id] });
  return {
    partnerId: partner.id,
    orgA: { orgId: orgA.id, siteId: siteA.id },
    orgB: { orgId: orgB.id, siteId: siteB.id },
    pool,
    admin,
    techA,
  };
}
export type ReattachTenant = Awaited<ReturnType<typeof seedReattachTenant>>;

export interface SeededAgentDevice {
  id: string;
  agentId: string;
  orgId: string;
  siteId: string;
  agentToken: string;
  watchdogToken: string;
  helperToken: string;
}

export interface SeedDeviceOptions {
  parked?: boolean;
  rebindProtocolVersion?: number;
  status?: 'online' | 'offline' | 'pending' | 'decommissioned' | 'quarantined';
  lastSeenAt?: Date | null;
  watchdogLastSeen?: Date | null;
  isEphemeral?: boolean;
  hostname?: string;
}

/** A device with real agent, watchdog and helper tokens (hashes stored). */
export async function seedAgentDevice(
  place: { orgId: string; siteId: string },
  options: SeedDeviceOptions = {},
): Promise<SeededAgentDevice> {
  const suffix = randomUUID().slice(0, 8);
  const agentId = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
  const agentToken = `brz_${randomUUID()}${randomUUID()}`;
  const watchdogToken = `brz_${randomUUID()}${randomUUID()}`;
  const helperToken = `brz_${randomUUID()}${randomUUID()}`;
  const values = {
    orgId: place.orgId,
    siteId: place.siteId,
    agentId,
    hostname: options.hostname ?? `reattach-${suffix}`,
    osType: 'windows' as const,
    osVersion: '11',
    architecture: 'amd64',
    agentVersion: '0.99.0',
    agentTokenHash: sha256(agentToken),
    watchdogTokenHash: sha256(watchdogToken),
    helperTokenHash: sha256(helperToken),
    tokenIssuedAt: new Date(),
    watchdogTokenIssuedAt: new Date(),
    helperTokenIssuedAt: new Date(),
    status: options.status ?? 'online',
    lastSeenAt: options.lastSeenAt === undefined ? new Date() : options.lastSeenAt,
    watchdogLastSeen: options.watchdogLastSeen ?? null,
    isEphemeral: options.isEphemeral ?? false,
    rebindProtocolVersion: options.rebindProtocolVersion ?? 0,
    ...(options.status === 'decommissioned' ? { decommissionedAt: new Date() } : {}),
  };
  const row = options.parked
    ? await getTestDb().transaction(async (tx: any) => {
      await declareParkedDeviceAdmission(tx);
      const [inserted] = await tx.insert(devices).values(values).returning({ id: devices.id });
      return inserted!;
    })
    : (await getTestDb().insert(devices).values(values).returning({ id: devices.id }))[0]!;
  return { id: row.id, agentId, orgId: place.orgId, siteId: place.siteId, agentToken, watchdogToken, helperToken };
}

/** A silent target: its newest credential use is two hours old. */
export function silentTarget(place: { orgId: string; siteId: string }, options: SeedDeviceOptions = {}) {
  const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  return seedAgentDevice(place, { status: 'offline', lastSeenAt: longAgo, ...options });
}

/** A parked source: a new install in the holding org that speaks the rebind protocol. */
export function parkedSource(tenant: ReattachTenant, options: SeedDeviceOptions = {}) {
  return seedAgentDevice(tenant.pool, { parked: true, rebindProtocolVersion: 1, ...options });
}

export async function readIntent(intentId: string) {
  const [row] = await getTestDb().select().from(deviceReattachIntents).where(eq(deviceReattachIntents.id, intentId));
  return row;
}

export async function readDevice(deviceId: string) {
  const [row] = await getTestDb().select().from(devices).where(eq(devices.id, deviceId));
  return row;
}

/**
 * Move an intent's clock back by `ms` (requested_at, staged_at, expires_at).
 * The identity guard pins requested_at, so the shift runs with triggers off
 * (superuser, `session_replication_role = replica`, transaction-local).
 */
export async function ageIntent(intentId: string, ms: number): Promise<void> {
  await getTestDb().transaction(async (tx: any) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.execute(sql`
      UPDATE device_reattach_intents
         SET requested_at = requested_at - make_interval(secs => ${ms / 1000}),
             staged_at = staged_at - make_interval(secs => ${ms / 1000}),
             expires_at = expires_at - make_interval(secs => ${ms / 1000})
       WHERE id = ${intentId}::uuid`);
  });
}

/** Random 64-hex staged set (as the agent would send it) with the confirmation token it hashes. */
export function stagedSet() {
  const token = (prefix = 'brz_') => `${prefix}${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`;
  const agentToken = token();
  const watchdogToken = token();
  const helperToken = token();
  const confirmationToken = token('brz_rbc_');
  return {
    tokens: { agentToken, watchdogToken, helperToken, confirmationToken },
    hashes: {
      stagedTokenHash: sha256(agentToken),
      stagedWatchdogTokenHash: sha256(watchdogToken),
      stagedHelperTokenHash: sha256(helperToken),
      confirmationTokenHash: sha256(confirmationToken),
    },
  };
}
