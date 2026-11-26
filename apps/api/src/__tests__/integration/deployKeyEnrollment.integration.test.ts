/**
 * POST /agents/enroll with a holding-area deploy key (#8318 wave D-1, plan §4)
 * against real Postgres + Redis, through the real enroll route.
 *
 * Proven here:
 *   - happy path: the device is parked in the partner's holding org + site,
 *     the `enrolled` ledger row names the key, the key's use count and last
 *     use are stamped, the response is the pre-assignment body, the parked
 *     list shows the key name, and the enrollment secret is not asked for;
 *   - refusals: unknown / malformed / revoked / expired / exhausted keys,
 *     source CIDRs, switch off, platform flag off, ineligible partner,
 *     suspended partner, Redis unavailable (fail closed) — none writes a row;
 *   - caps: the key's max_parked and the partner's holding-area cap;
 *   - concurrent enrollments racing for the last uses: exactly max_usage win;
 *   - in-place re-enrollment onto a parked row writes a second `enrolled` row
 *     with the new key, and revoking either key expires the device;
 *   - a customer-org row or an expired parked row with the same hostname is
 *     never re-enrolled through a deploy key.
 *
 * Run (needs `pnpm test-stack up`):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts --maxWorkers 1 \
 *     src/__tests__/integration/deployKeyEnrollment.integration.test.ts
 */
import './setup';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';

const { clientIpState, redisState } = vi.hoisted(() => ({
  clientIpState: { ip: '203.0.113.10' },
  // Calls of getRedis() in the current request after which it returns null.
  redisState: { nullAfterCalls: Number.POSITIVE_INFINITY, calls: 0 },
}));

vi.mock('../../services/clientIp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/clientIp')>()),
  getTrustedClientIp: vi.fn(() => clientIpState.ip),
}));

vi.mock('../../services/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/redis')>();
  return {
    ...actual,
    getRedis: vi.fn(() => {
      redisState.calls += 1;
      return redisState.calls > redisState.nullAfterCalls ? null : actual.getRedis();
    }),
  };
});

import { getTestDb } from './setup';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { insertDevice, seedHoldingOrg, seedParkedDevice } from './unassignedPoolFixtures';
import {
  devicePoolAssignmentEvents,
  devices,
  organizations,
  partnerDeployKeys,
  partners,
} from '../../db/schema';
import { enrollmentRoutes } from '../../routes/agents/enrollment';
import { generateDeployKey, hashDeployKey } from '../../services/deployKeys/keyFormat';
import { listParkedDevices } from '../../services/unassignedPool/parkedDeviceReads';
import { revokeDeployKey, type DeployKeyActor } from '../../services/deployKeys/manage';
import { PARKED_DEVICES_PER_PARTNER_MAX } from '../../services/unassignedPool/limits';
import { UNASSIGNED_POOL_ORG_TYPE } from '../../services/unassignedPool/orgType';
import { createHash } from 'node:crypto';

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const name of ['PRE_ASSIGNMENT_ENROLLMENT_ENABLED', 'AGENT_ENROLL_RATE_LIMIT', 'AGENT_ENROLLMENT_SECRET', 'BREEZE_BILLING_URL']) {
    saved[name] = process.env[name];
  }
  process.env.PRE_ASSIGNMENT_ENROLLMENT_ENABLED = 'true';
  process.env.AGENT_ENROLL_RATE_LIMIT = '1000';
  delete process.env.BREEZE_BILLING_URL;
});
afterAll(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

let partnerId: string;

beforeEach(async () => {
  clientIpState.ip = '203.0.113.10';
  redisState.nullAfterCalls = Number.POSITIVE_INFINITY;
  redisState.calls = 0;
  process.env.PRE_ASSIGNMENT_ENROLLMENT_ENABLED = 'true';
  delete process.env.AGENT_ENROLLMENT_SECRET;
  const partner = await createPartner({ status: 'active' });
  partnerId = partner.id;
  await getTestDb().update(partners).set({ deployKeyEnrollmentEnabled: true }).where(eq(partners.id, partnerId));
});

function app(): Hono {
  const a = new Hono();
  a.route('/agents', enrollmentRoutes);
  return a;
}

async function enroll(enrollmentKey: string, hostname = `parked-${randomUUID().slice(0, 8)}`, headers: Record<string, string> = {}) {
  redisState.calls = 0;
  const res = await app().request('/agents/enroll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      enrollmentKey,
      hostname,
      osType: 'windows',
      osVersion: '11',
      architecture: 'amd64',
      agentVersion: '1.0.0-test',
      hardwareInfo: { serialNumber: `SN-${hostname}`, manufacturer: 'Acme' },
      networkInfo: [{ name: 'eth0', mac: '00:11:22:33:44:55', ip: '10.0.0.5', isPrimary: true }],
    }),
  });
  return { res, body: await res.json() as Record<string, any> };
}

async function seedKey(overrides: Partial<{
  name: string; imageLabel: string; maxUsage: number; maxParked: number; usageCount: number;
  status: 'active' | 'revoked'; expired: boolean; sourceCidrs: string[]; forPartner: string;
}> = {}) {
  const plaintext = generateDeployKey();
  const [row] = await getTestDb().insert(partnerDeployKeys).values({
    partnerId: overrides.forPartner ?? partnerId,
    name: overrides.name ?? 'Front desk image',
    imageLabel: overrides.imageLabel ?? 'win11',
    keyHash: hashDeployKey(plaintext),
    createdAt: overrides.expired ? sql`now() - interval '40 days'` : sql`now()`,
    expiresAt: overrides.expired ? sql`now() - interval '1 day'` : sql`now() + interval '30 days'`,
    maxUsage: overrides.maxUsage ?? 100,
    usageCount: overrides.usageCount ?? 0,
    maxParked: overrides.maxParked ?? 20,
    ...(overrides.status === 'revoked' ? { status: 'revoked', revokedAt: new Date() } : {}),
    ...(overrides.sourceCidrs ? { sourceCidrs: sql`${`{${overrides.sourceCidrs.join(',')}}`}::cidr[]` } : {}),
  } as any).returning({ id: partnerDeployKeys.id });
  return { id: row!.id, plaintext };
}

async function keyRow(id: string) {
  const [row] = await getTestDb().select().from(partnerDeployKeys).where(eq(partnerDeployKeys.id, id));
  return row!;
}

async function holdingOrg() {
  const [org] = await getTestDb().select({ id: organizations.id }).from(organizations)
    .where(and(eq(organizations.partnerId, partnerId), eq(organizations.type, UNASSIGNED_POOL_ORG_TYPE)));
  return org ?? null;
}

async function partnerDeviceCount() {
  const rows = await getTestDb().select({ id: devices.id }).from(devices)
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .where(eq(organizations.partnerId, partnerId));
  return rows.length;
}

async function enrolledRows(deviceId: string) {
  return getTestDb().select().from(devicePoolAssignmentEvents)
    .where(and(eq(devicePoolAssignmentEvents.deviceId, deviceId), eq(devicePoolAssignmentEvents.eventType, 'enrolled')))
    .orderBy(devicePoolAssignmentEvents.createdAt);
}

async function actorFor(forPartnerId: string): Promise<DeployKeyActor> {
  const user = await createUser({ partnerId: forPartnerId, email: `keys-${randomUUID()}@example.com` });
  return {
    partnerId: forPartnerId,
    auth: {
      scope: 'partner', partnerId: forPartnerId, partnerOrgAccess: 'all',
      user: { id: user.id, email: user.email, name: 'Admin' },
      token: { aep: user.authEpoch, mep: user.mfaEpoch, sid: randomUUID() },
    } as any,
  };
}

describe('happy path', () => {
  it('parks the device in the holding org, writes the ledger row, stamps the key and skips the enrollment secret', async () => {
    process.env.AGENT_ENROLLMENT_SECRET = 'a-global-secret-the-image-does-not-carry';
    const key = await seedKey({ name: 'Lobby kiosk image' });
    const { res, body } = await enroll(key.plaintext, 'kiosk-01');
    expect(res.status, JSON.stringify(body)).toBe(201);

    const pool = await holdingOrg();
    expect(pool).not.toBeNull();
    expect(body.orgId).toBe(pool!.id);
    expect(body).not.toHaveProperty('manifestTrustKeys');
    expect(body).not.toHaveProperty('manifestKeyDelegations');
    expect(body).not.toHaveProperty('backupServerUrl');
    expect(body.authToken).toMatch(/^brz_/);

    const [device] = await getTestDb().select().from(devices).where(eq(devices.id, body.deviceId));
    expect(device).toMatchObject({ orgId: pool!.id, siteId: body.siteId, hostname: 'kiosk-01', status: 'pending', enrollmentIp: '203.0.113.10', isEphemeral: false });
    expect(device!.agentTokenHash).toBe(createHash('sha256').update(body.authToken).digest('hex'));

    const ledger = await enrolledRows(body.deviceId);
    expect(ledger).toEqual([expect.objectContaining({
      partnerId, deployKeyId: key.id, deployKeyName: 'Lobby kiosk image', toOrgId: pool!.id, fromOrgId: null, deviceAgentId: body.agentId,
    })]);
    expect(ledger[0]!.parkedAt!.getTime()).toBe(device!.createdAt.getTime());

    const stamped = await keyRow(key.id);
    expect(stamped.usageCount).toBe(1);
    expect(stamped.lastUsedAt).toBeInstanceOf(Date);
    expect(stamped.lastUsedIp).toBe('203.0.113.10');

    const parked = await listParkedDevices(partnerId);
    expect(parked).toEqual([expect.objectContaining({ id: body.deviceId, hostname: 'kiosk-01', deployKeyName: 'Lobby kiosk image', serialNumber: 'SN-kiosk-01', primaryMacAddress: '00:11:22:33:44:55' })]);
  });

  it('accepts an enrollment from inside the key\'s source CIDRs (IPv4-mapped too)', async () => {
    const key = await seedKey({ sourceCidrs: ['198.51.100.0/24'] });
    clientIpState.ip = '::ffff:198.51.100.77';
    const { res } = await enroll(key.plaintext);
    expect(res.status).toBe(201);
  });
});

describe('refusals write nothing', () => {
  async function expectRefused(enrollmentKey: string, status: number, reason: string) {
    const before = await partnerDeviceCount();
    const { res, body } = await enroll(enrollmentKey);
    expect(res.status, JSON.stringify(body)).toBe(status);
    expect(body.reason).toBe(reason);
    expect(await partnerDeviceCount()).toBe(before);
    return body;
  }

  it('an unknown or malformed deploy key is not found', async () => {
    await expectRefused(generateDeployKey(), 401, 'deploy_key_not_found');
    await expectRefused('bdk_not-a-key', 401, 'deploy_key_not_found');
    expect(await holdingOrg()).toBeNull();
  });

  it('a revoked, expired or exhausted key is refused with its own reason, its use count untouched', async () => {
    const revoked = await seedKey({ status: 'revoked' });
    const expired = await seedKey({ expired: true });
    const exhausted = await seedKey({ maxUsage: 2, usageCount: 2 });
    await expectRefused(revoked.plaintext, 401, 'deploy_key_revoked');
    await expectRefused(expired.plaintext, 401, 'deploy_key_expired');
    await expectRefused(exhausted.plaintext, 401, 'deploy_key_exhausted');
    expect((await keyRow(exhausted.id)).usageCount).toBe(2);
  });

  it('a source outside the key\'s CIDRs is refused', async () => {
    const key = await seedKey({ sourceCidrs: ['10.20.0.0/16'] });
    clientIpState.ip = '10.21.0.1';
    await expectRefused(key.plaintext, 403, 'deploy_key_source_not_allowed');
    clientIpState.ip = 'unknown';
    await expectRefused(key.plaintext, 403, 'deploy_key_source_not_allowed');
    expect((await keyRow(key.id)).usageCount).toBe(0);
  });

  it('switch off, platform flag off, and an ineligible partner share one public reason', async () => {
    const key = await seedKey();
    await getTestDb().update(partners).set({ deployKeyEnrollmentEnabled: false }).where(eq(partners.id, partnerId));
    await expectRefused(key.plaintext, 403, 'deploy_key_enrollment_unavailable');
    await getTestDb().update(partners).set({ deployKeyEnrollmentEnabled: true }).where(eq(partners.id, partnerId));
    process.env.PRE_ASSIGNMENT_ENROLLMENT_ENABLED = 'false';
    await expectRefused(key.plaintext, 403, 'deploy_key_enrollment_unavailable');
    process.env.PRE_ASSIGNMENT_ENROLLMENT_ENABLED = 'true';
    await getTestDb().update(partners).set({ trustState: 'restricted' }).where(eq(partners.id, partnerId));
    const body = await expectRefused(key.plaintext, 403, 'deploy_key_enrollment_unavailable');
    expect(JSON.stringify(body)).not.toMatch(/trust|restricted/);
    expect(await holdingOrg()).toBeNull();
  });

  it('a suspended partner is refused by the tenant gate', async () => {
    const key = await seedKey();
    await getTestDb().update(partners).set({ status: 'suspended' }).where(eq(partners.id, partnerId));
    await expectRefused(key.plaintext, 403, 'tenant_inactive');
  });

  it('with Redis unavailable the deploy-key buckets fail closed', async () => {
    const key = await seedKey();
    // The per-IP limiter's getRedis() call is the first; the buckets' is next.
    redisState.nullAfterCalls = 1;
    const before = await partnerDeviceCount();
    const res = await app().request('/agents/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enrollmentKey: key.plaintext, hostname: 'no-redis', osType: 'linux', osVersion: '1', architecture: 'x64', agentVersion: '1' }),
    });
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(429);
    expect(body.reason).toBe('deploy_key_rate_limited');
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(await partnerDeviceCount()).toBe(before);
  });
});

describe('caps', () => {
  it('refuses a fresh device once the key holds max_parked parked devices', async () => {
    const key = await seedKey({ maxParked: 2 });
    expect((await enroll(key.plaintext)).res.status).toBe(201);
    expect((await enroll(key.plaintext)).res.status).toBe(201);
    const third = await enroll(key.plaintext);
    expect(third.res.status).toBe(409);
    expect(third.body.reason).toBe('deploy_key_parked_cap_reached');
    expect((await keyRow(key.id)).usageCount).toBe(2);
    // Another key of the same partner still parks.
    const other = await seedKey({ imageLabel: 'kiosk' });
    expect((await enroll(other.plaintext)).res.status).toBe(201);
  });

  it('refuses a fresh device once the partner\'s holding area is full', async () => {
    const pool = await seedHoldingOrg(partnerId);
    for (let i = 0; i < PARKED_DEVICES_PER_PARTNER_MAX; i += 1) await seedParkedDevice(pool.orgId, pool.siteId);
    const key = await seedKey();
    const { res, body } = await enroll(key.plaintext);
    expect(res.status).toBe(409);
    expect(body.reason).toBe('parked_cap_reached');
    expect((await keyRow(key.id)).usageCount).toBe(0);
  });
});

describe('concurrent enrollments racing for the last uses', () => {
  it('exactly max_usage of them win; the rest are refused as exhausted', async () => {
    const key = await seedKey({ maxUsage: 3 });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => enroll(key.plaintext, `race-${i}`)));
    const statuses = results.map((r) => r.res.status).sort();
    expect(statuses).toEqual([201, 201, 201, 401, 401, 401]);
    expect(results.filter((r) => r.res.status === 401).map((r) => r.body.reason)).toEqual(['deploy_key_exhausted', 'deploy_key_exhausted', 'deploy_key_exhausted']);
    expect((await keyRow(key.id)).usageCount).toBe(3);
    const pool = await holdingOrg();
    const parked = await getTestDb().select({ id: devices.id }).from(devices).where(eq(devices.orgId, pool!.id));
    expect(parked).toHaveLength(3);
  });
});

describe('in-place re-enrollment onto a parked row', () => {
  async function enrollTwiceWithTwoKeys() {
    const keyA = await seedKey({ name: 'Image A', imageLabel: 'a' });
    const keyB = await seedKey({ name: 'Image B', imageLabel: 'b' });
    const first = await enroll(keyA.plaintext, 'reimaged-01');
    expect(first.res.status).toBe(201);
    const second = await enroll(keyB.plaintext, 'reimaged-01', { 'x-agent-reenrollment-token': first.body.authToken });
    expect(second.res.status, JSON.stringify(second.body)).toBe(201);
    return { keyA, keyB, first, second };
  }

  it('re-enrolls the same row, writes a second enrolled row with the new key and does not re-admit', async () => {
    const { keyA, keyB, first, second } = await enrollTwiceWithTwoKeys();
    expect(second.body.deviceId).toBe(first.body.deviceId);
    expect(second.body.agentId).not.toBe(first.body.agentId);
    const rows = await enrolledRows(first.body.deviceId);
    expect(rows.map((r) => [r.deployKeyId, r.deployKeyName])).toEqual([[keyA.id, 'Image A'], [keyB.id, 'Image B']]);
    expect(rows[1]!.parkedAt!.getTime()).toBe(rows[0]!.parkedAt!.getTime());
    expect((await keyRow(keyB.id)).usageCount).toBe(1);
    const [device] = await getTestDb().select().from(devices).where(eq(devices.id, first.body.deviceId));
    expect(device!.agentTokenHash).toBe(createHash('sha256').update(second.body.authToken).digest('hex'));
    expect(await partnerDeviceCount()).toBe(1);
    expect((await listParkedDevices(partnerId))[0]!.deployKeyName).toBe('Image B');
  });

  it.each(['first', 'second'] as const)('revoking the %s key expires the device', async (which) => {
    const { keyA, keyB, first } = await enrollTwiceWithTwoKeys();
    const actor = await actorFor(partnerId);
    const revoked = await revokeDeployKey({ actor, deployKeyId: which === 'first' ? keyA.id : keyB.id });
    expect(revoked).toMatchObject({ ok: true, expiry: { matched: 1, expired: 1, failed: 0 } });
    const [device] = await getTestDb().select({ status: devices.status }).from(devices).where(eq(devices.id, first.body.deviceId));
    expect(device!.status).toBe('decommissioned');
  });

  it('the per-key cap applies when re-enrollment moves a device to a full key', async () => {
    const full = await seedKey({ imageLabel: 'full', maxParked: 1 });
    const other = await seedKey({ imageLabel: 'other' });
    expect((await enroll(full.plaintext, 'occupant')).res.status).toBe(201);
    const mover = await enroll(other.plaintext, 'mover');
    const moved = await enroll(full.plaintext, 'mover', { 'x-agent-reenrollment-token': mover.body.authToken });
    expect(moved.res.status).toBe(409);
    expect(moved.body.reason).toBe('deploy_key_parked_cap_reached');
    expect(await enrolledRows(mover.body.deviceId)).toHaveLength(1);
  });

  it('re-enrolling a device with the full key it is already parked under is not refused', async () => {
    const full = await seedKey({ imageLabel: 'full', maxParked: 1 });
    const occupant = await enroll(full.plaintext, 'occupant');
    const again = await enroll(full.plaintext, 'occupant', { 'x-agent-reenrollment-token': occupant.body.authToken });
    expect(again.res.status, JSON.stringify(again.body)).toBe(201);
    expect(again.body.deviceId).toBe(occupant.body.deviceId);
    expect(await enrolledRows(occupant.body.deviceId)).toHaveLength(2);
  });
});

describe('the collision lookup is scoped to the holding org', () => {
  it('never re-enrolls a customer-org row, even with that row\'s own token', async () => {
    const org = await createOrganization({ partnerId, status: 'active' });
    const site = await createSite({ orgId: org.id });
    const customer = await insertDevice(org.id, site.id);
    const token = `brz_${randomUUID().replace(/-/g, '')}`;
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await getTestDb().update(devices).set({ hostname: 'shared-name', agentTokenHash: tokenHash }).where(eq(devices.id, customer.id));

    const key = await seedKey();
    const { res, body } = await enroll(key.plaintext, 'shared-name', { 'x-agent-reenrollment-token': token });
    expect(res.status).toBe(201);
    expect(body.deviceId).not.toBe(customer.id);
    const [after] = await getTestDb().select().from(devices).where(eq(devices.id, customer.id));
    expect(after).toMatchObject({ orgId: org.id, siteId: site.id, agentTokenHash: tokenHash, agentId: customer.agentId });
    expect(await enrolledRows(customer.id)).toEqual([]);
  });

  it('never brings an expired (decommissioned) parked row back through its old token', async () => {
    const key = await seedKey();
    const first = await enroll(key.plaintext, 'expired-host');
    await getTestDb().update(devices).set({ status: 'decommissioned' }).where(eq(devices.id, first.body.deviceId));
    const second = await enroll(key.plaintext, 'expired-host', { 'x-agent-reenrollment-token': first.body.authToken });
    expect(second.res.status).toBe(201);
    expect(second.body.deviceId).not.toBe(first.body.deviceId);
    const [old] = await getTestDb().select({ status: devices.status }).from(devices).where(eq(devices.id, first.body.deviceId));
    expect(old!.status).toBe('decommissioned');
  });

  it('a key of another partner parks into that partner\'s holding org only', async () => {
    const other = await createPartner({ status: 'active' });
    await getTestDb().update(partners).set({ deployKeyEnrollmentEnabled: true }).where(eq(partners.id, other.id));
    const theirs = await seedKey({ forPartner: other.id });
    const { res, body } = await enroll(theirs.plaintext);
    expect(res.status).toBe(201);
    const [org] = await getTestDb().select({ partnerId: organizations.partnerId, type: organizations.type }).from(organizations).where(eq(organizations.id, body.orgId));
    expect(org).toEqual({ partnerId: other.id, type: UNASSIGNED_POOL_ORG_TYPE });
    expect(await holdingOrg()).toBeNull();
  });
});
