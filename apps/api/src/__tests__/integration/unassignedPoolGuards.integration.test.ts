/**
 * Holding-org guards against real Postgres.
 * Migration under test: 2026-11-08-190100-unassigned-pool-org-guards.sql.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { devices, organizations, partnerUsers, sites } from '../../db/schema';
import { computeAccessibleOrgIds } from '../../middleware/auth';
import { _resolvePartnerAccessibleOrgIdsForTests } from '../../middleware/bearerTokenAuth';
import { resolvePartnerReportOrgIds } from '../../services/reportScope';
import { beginOrgArchive, OrgArchiveStateError } from '../../services/orgArchive';
import { validateMergePair } from '../../services/orgMerge';
import { getOrCreateUnassignedPoolOrg } from '../../services/unassignedPool/poolOrg';
import { declareParkedDeviceAdmission } from '../../services/unassignedPool/admission';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { assignUserToPartner, createOrganization, createPartner, createRole, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';
import { insertDevice, parkedDeviceValues, seedHoldingOrg, seedParkedDevice } from './unassignedPoolFixtures';

async function pgCause(fn: () => Promise<unknown>): Promise<{ code?: string; message?: string } | undefined> {
  try { await fn(); return undefined; } catch (err) {
    const e = err as { cause?: { code?: string; message?: string }; code?: string; message?: string };
    return e.cause ?? { code: e.code, message: e.message };
  }
}

describe('holding org uniqueness', () => {
  it('allows exactly one unassigned_pool org per partner', async () => {
    const partner = await createPartner();
    await seedHoldingOrg(partner.id);
    const cause = await pgCause(() => createOrganization({ partnerId: partner.id, slug: 'second-pool', type: 'unassigned_pool' }));
    expect(cause?.code).toBe('23505');
    expect(cause?.message).toMatch(/organizations_partner_unassigned_pool_uniq/);
  });
});

describe('holding org identity is immutable (organizations trigger)', () => {
  it.each([
    ['type', sql`type = 'customer'`],
    ['name', sql`name = 'Renamed'`],
    ['slug', sql`slug = 'renamed'`],
  ])('refuses changing %s of a holding org, even in system scope', async (_label, setClause) => {
    const partner = await createPartner();
    const { orgId } = await seedHoldingOrg(partner.id);
    const cause = await pgCause(() => withSystemDbAccessContext(() =>
      db.execute(sql`UPDATE organizations SET ${setClause} WHERE id = ${orgId}::uuid`)));
    expect(cause?.code).toBe('P0001');
    expect(cause?.message).toMatch(/unassigned_pool organizations cannot be renamed/);
  });

  it('refuses converting a customer org into a holding org', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const cause = await pgCause(() => withSystemDbAccessContext(() =>
      db.execute(sql`UPDATE organizations SET type = 'unassigned_pool' WHERE id = ${org.id}::uuid`)));
    expect(cause?.code).toBe('P0001');
    expect(cause?.message).toMatch(/cannot be converted into an unassigned_pool/);
  });

  it('still allows unrelated column updates on a holding org', async () => {
    const partner = await createPartner();
    const { orgId } = await seedHoldingOrg(partner.id);
    await withSystemDbAccessContext(() =>
      db.update(organizations).set({ updatedAt: new Date() }).where(eq(organizations.id, orgId)));
  });
});

describe('device membership is one-way (devices triggers)', () => {
  it('refuses moving an existing device into a holding org (system scope)', async () => {
    const partner = await createPartner();
    const customer = await createOrganization({ partnerId: partner.id });
    const customerSite = await createSite({ orgId: customer.id });
    const pool = await seedHoldingOrg(partner.id);
    const device = await insertDevice(customer.id, customerSite.id);
    const cause = await pgCause(() => withSystemDbAccessContext(() =>
      db.update(devices).set({ orgId: pool.orgId, siteId: pool.siteId }).where(eq(devices.id, device.id))));
    expect(cause?.code).toBe('P0001');
    expect(cause?.message).toMatch(/cannot be moved into an unassigned_pool/);
  });

  it('refuses creating a device in a holding org without an admission declaration', async () => {
    const partner = await createPartner();
    const pool = await seedHoldingOrg(partner.id);
    const cause = await pgCause(() => insertDevice(pool.orgId, pool.siteId));
    expect(cause?.code).toBe('P0001');
    expect(cause?.message).toMatch(/only by enrollment admission/);
  });

  it('allows creating a device in a holding org inside a declared enrollment admission', async () => {
    const partner = await createPartner();
    const pool = await seedHoldingOrg(partner.id);
    const device = await seedParkedDevice(pool.orgId, pool.siteId);
    const [row] = await getTestDb().select({ orgId: devices.orgId }).from(devices).where(eq(devices.id, device.id));
    expect(row?.orgId).toBe(pool.orgId);
  });

  it('does not carry the admission declaration past its transaction', async () => {
    const partner = await createPartner();
    const pool = await seedHoldingOrg(partner.id);
    await seedParkedDevice(pool.orgId, pool.siteId);
    const cause = await pgCause(() => insertDevice(pool.orgId, pool.siteId));
    expect(cause?.code).toBe('P0001');
  });

  it('leaves ordinary device inserts and moves untouched', async () => {
    const partner = await createPartner();
    const a = await createOrganization({ partnerId: partner.id });
    const b = await createOrganization({ partnerId: partner.id });
    const siteA = await createSite({ orgId: a.id });
    const siteB = await createSite({ orgId: b.id });
    const device = await insertDevice(a.id, siteA.id);
    await withSystemDbAccessContext(() =>
      db.update(devices).set({ orgId: b.id, siteId: siteB.id }).where(eq(devices.id, device.id)));
  });
});

describe('parked-device admission declaration is transaction-local', () => {
  // One dedicated connection, so "a later transaction" is provably on the same
  // backend session the declaration was made on (a pooled client could hand
  // the second transaction to a different connection and pass vacuously).
  async function withOneConnection<T>(fn: (one: ReturnType<typeof drizzle>) => Promise<T>): Promise<T> {
    const client = postgres(process.env.DATABASE_URL!, { max: 1 });
    try { return await fn(drizzle(client)); } finally { await client.end(); }
  }
  const settingAndPid = async (one: ReturnType<typeof drizzle>) => {
    const [row] = await one.execute(sql`
      SELECT current_setting('breeze.parked_device_admission', true) AS value, pg_backend_pid() AS pid`) as unknown as
      Array<{ value: string | null; pid: number }>;
    return row!;
  };

  it('declareParkedDeviceAdmission admits one transaction and does not persist into the next', async () => {
    const partner = await createPartner();
    const pool = await seedHoldingOrg(partner.id);
    await withOneConnection(async (one) => {
      const pidInside = await one.transaction(async (tx) => {
        await declareParkedDeviceAdmission(tx);
        await tx.insert(devices).values(parkedDeviceValues(pool.orgId, pool.siteId));
        return (await settingAndPid(tx as unknown as ReturnType<typeof drizzle>)).pid;
      });
      const after = await settingAndPid(one);
      expect(after.pid).toBe(pidInside);
      expect(after.value ?? '').toBe('');
      const cause = await pgCause(() => one.transaction(async (tx) => {
        await tx.insert(devices).values(parkedDeviceValues(pool.orgId, pool.siteId));
      }));
      expect(cause?.code).toBe('P0001');
      expect(cause?.message).toMatch(/only by enrollment admission/);
    });
  });

  it('control: a session-level declaration would persist on the same connection', async () => {
    await withOneConnection(async (one) => {
      await one.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('breeze.parked_device_admission', 'enrollment', false)`);
      });
      expect((await settingAndPid(one)).value).toBe('enrollment');
    });
  });
});

describe('getOrCreateUnassignedPoolOrg', () => {
  it('creates exactly one holding org and one site under concurrent first calls', async () => {
    const partner = await createPartner();
    const results = await Promise.all(Array.from({ length: 8 }, () => getOrCreateUnassignedPoolOrg(partner.id)));
    expect(new Set(results.map((r) => r.orgId)).size).toBe(1);
    expect(new Set(results.map((r) => r.siteId)).size).toBe(1);
    const orgRows = await getTestDb().select().from(organizations)
      .where(sql`${organizations.partnerId} = ${partner.id}::uuid AND ${organizations.type} = 'unassigned_pool'`);
    expect(orgRows).toHaveLength(1);
    expect(orgRows[0]).toMatchObject({ status: 'active', name: 'Unassigned devices' });
    const siteRows = await getTestDb().select().from(sites).where(eq(sites.orgId, orgRows[0]!.id));
    expect(siteRows).toHaveLength(1);
  });

  it('is idempotent across sequential calls', async () => {
    const partner = await createPartner();
    const first = await getOrCreateUnassignedPoolOrg(partner.id);
    const second = await getOrCreateUnassignedPoolOrg(partner.id);
    expect(second).toEqual(first);
  });

  it('rejects an unknown partner', async () => {
    await expect(getOrCreateUnassignedPoolOrg('00000000-0000-4000-8000-000000000000')).rejects.toThrow(/partner not found/);
  });
});

describe('holding org is never in a human access list', () => {
  async function seed(orgAccess: 'all' | 'selected') {
    const partner = await createPartner();
    const customer = await createOrganization({ partnerId: partner.id });
    const pool = await getOrCreateUnassignedPoolOrg(partner.id);
    const user = await createUser({ partnerId: partner.id });
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    await assignUserToPartner(user.id, partner.id, role.id, orgAccess);
    if (orgAccess === 'selected') {
      // Hand-edited selection naming the holding org must still not reach it.
      await getTestDb().update(partnerUsers).set({ orgIds: [customer.id, pool.orgId] })
        .where(eq(partnerUsers.userId, user.id));
    }
    return { partner, customer, pool, user };
  }

  it.each(['all', 'selected'] as const)('session auth (%s) excludes the holding org', async (access) => {
    const { partner, customer, pool, user } = await seed(access);
    const reach = await computeAccessibleOrgIds('partner', partner.id, null, user.id);
    expect(reach.orgIds).toContain(customer.id);
    expect(reach.orgIds).not.toContain(pool.orgId);
  });

  it.each(['all', 'selected'] as const)('bearer/OAuth auth (%s) excludes the holding org', async (access) => {
    const { partner, customer, pool, user } = await seed(access);
    const orgIds = await _resolvePartnerAccessibleOrgIdsForTests(partner.id, user.id);
    expect(orgIds).toContain(customer.id);
    expect(orgIds).not.toContain(pool.orgId);
  });

  it('partner report scope excludes the holding org', async () => {
    const { partner, customer, pool } = await seed('all');
    const orgIds = await resolvePartnerReportOrgIds(partner.id);
    expect(orgIds).toContain(customer.id);
    expect(orgIds).not.toContain(pool.orgId);
  });
});

describe('protected lifecycle against real rows', () => {
  it('archive refuses a holding org and leaves it untouched', async () => {
    const partner = await createPartner();
    const pool = await getOrCreateUnassignedPoolOrg(partner.id);
    await expect(beginOrgArchive({ orgId: pool.orgId, retentionDays: 30, actor: null }))
      .rejects.toBeInstanceOf(OrgArchiveStateError);
    const [row] = await getTestDb().select({ status: organizations.status }).from(organizations)
      .where(eq(organizations.id, pool.orgId));
    expect(row?.status).toBe('active');
  });

  it('merge validation refuses a holding org read from the database', async () => {
    const partner = await createPartner();
    const pool = await getOrCreateUnassignedPoolOrg(partner.id);
    const customer = await createOrganization({ partnerId: partner.id });
    const rows = await getTestDb().select().from(organizations)
      .where(sql`${organizations.id} IN (${pool.orgId}::uuid, ${customer.id}::uuid)`);
    const poolRow = rows.find((r) => r.id === pool.orgId)!;
    const customerRow = rows.find((r) => r.id === customer.id)!;
    expect(validateMergePair(poolRow, customerRow)).toMatch(/holding area/i);
    expect(validateMergePair(customerRow, poolRow)).toMatch(/holding area/i);
  });
});
