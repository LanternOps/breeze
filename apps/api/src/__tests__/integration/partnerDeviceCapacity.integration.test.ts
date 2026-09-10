import './setup';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';
import { devices, organizations, partners, sites } from '../../db/schema';
import { admitPartnerDeviceCapacity } from '../../services/partnerDeviceCapacity';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const cleanupPartnerIds: string[] = [];

async function fixture(maxDevices: number | null) {
  const suffix = randomUUID();
  const partner = await createPartner({ slug: `capacity-${suffix}` });
  cleanupPartnerIds.push(partner.id);
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  await withSystemDbAccessContext(() => db.update(partners)
    .set({ maxDevices })
    .where(eq(partners.id, partner.id)));
  return { suffix, partner, org, site };
}

async function createLicensedDevice(
  input: { partnerId: string; orgId: string; siteId: string; label: string },
  hooks?: {
    onTransactionStarted?: (pid: number) => void;
    afterAdmission?: () => Promise<void>;
  },
): Promise<boolean> {
  return withSystemDbAccessContext(() => db.transaction(async (tx) => {
    const [pidRow] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid()::int as pid`);
    hooks?.onTransactionStarted?.(pidRow!.pid);
    const admission = await admitPartnerDeviceCapacity(tx, {
      orgId: input.orgId,
      expectedPartnerId: input.partnerId,
    });
    if (!admission.allowed) return false;
    await hooks?.afterAdmission?.();
    await tx.insert(devices).values({
      orgId: input.orgId,
      siteId: input.siteId,
      agentId: `capacity-${input.label}-${randomUUID()}`,
      hostname: `capacity-${input.label}-${randomUUID()}`,
      osType: 'linux',
      osVersion: 'test',
      architecture: 'amd64',
      agentVersion: '0.0.0-test',
      status: 'pending',
      isEphemeral: false,
    });
    return true;
  }));
}

async function waitForBlockedBackend(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const [row] = await getTestDb().execute<{ blocked: boolean }>(sql`
      select cardinality(pg_catalog.pg_blocking_pids(${pid})) > 0 as blocked
    `);
    if (row?.blocked) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`capacity contender backend ${pid} did not block on the partner admission lock`);
}

afterEach(async () => {
  if (cleanupPartnerIds.length === 0 || !process.env.DATABASE_URL) return;
  const ids = cleanupPartnerIds.splice(0);
  await withSystemDbAccessContext(async () => {
    for (const partnerId of ids) {
      const orgRows = await db.select({ id: organizations.id })
        .from(organizations).where(eq(organizations.partnerId, partnerId));
      for (const org of orgRows) {
        await db.delete(devices).where(eq(devices.orgId, org.id));
        await db.delete(sites).where(eq(sites.orgId, org.id));
        await db.delete(organizations).where(eq(organizations.id, org.id));
      }
      await db.delete(partners).where(eq(partners.id, partnerId));
    }
  });
});

describe('partner licensed-device capacity — real PostgreSQL', () => {
  runDb.each([
    ['provision/provision', 'provision', 'provision'],
    ['provision/enroll', 'provision', 'enroll'],
    ['off-mode enroll/enroll', 'enroll-off-a', 'enroll-off-b'],
  ])('serializes %s at one remaining slot', async (_name, first, second) => {
    const f = await fixture(1);
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstAdmitted!: () => void;
    const firstHasLock = new Promise<void>((resolve) => { firstAdmitted = resolve; });
    let secondPid!: number;

    const firstPromise = createLicensedDevice(
      { partnerId: f.partner.id, orgId: f.org.id, siteId: f.site.id, label: first },
      { afterAdmission: async () => { firstAdmitted(); await holdFirst; } },
    );
    await firstHasLock;
    const secondPromise = createLicensedDevice(
      { partnerId: f.partner.id, orgId: f.org.id, siteId: f.site.id, label: second },
      { onTransactionStarted: (pid) => { secondPid = pid; } },
    );
    while (!secondPid) await new Promise<void>((resolve) => setTimeout(resolve, 1));
    await waitForBlockedBackend(secondPid);
    releaseFirst();

    const results = await Promise.all([firstPromise, secondPromise]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const rows = await withSystemDbAccessContext(() => db.select({ id: devices.id })
      .from(devices).where(eq(devices.orgId, f.org.id)));
    expect(rows).toHaveLength(1);
  });

  runDb('excludes decommissioned and ephemeral rows and preserves uncapped admission', async () => {
    const f = await fixture(1);
    await withSystemDbAccessContext(() => db.insert(devices).values([
      {
        orgId: f.org.id, siteId: f.site.id, agentId: `decom-${f.suffix}`,
        hostname: `decom-${f.suffix}`, osType: 'linux', osVersion: 'test',
        architecture: 'amd64', agentVersion: '0.0.0-test', status: 'decommissioned', isEphemeral: false,
      },
      {
        orgId: f.org.id, siteId: f.site.id, agentId: `ephemeral-${f.suffix}`,
        hostname: `ephemeral-${f.suffix}`, osType: 'linux', osVersion: 'test',
        architecture: 'amd64', agentVersion: '0.0.0-test', status: 'offline', isEphemeral: true,
      },
    ]));
    expect(await createLicensedDevice({
      partnerId: f.partner.id, orgId: f.org.id, siteId: f.site.id, label: 'licensed',
    })).toBe(true);
    expect(await createLicensedDevice({
      partnerId: f.partner.id, orgId: f.org.id, siteId: f.site.id, label: 'denied',
    })).toBe(false);

    await withSystemDbAccessContext(() => db.update(partners)
      .set({ maxDevices: null }).where(eq(partners.id, f.partner.id)));
    const uncapped = await Promise.all(['u1', 'u2'].map((label) => createLicensedDevice({
      partnerId: f.partner.id, orgId: f.org.id, siteId: f.site.id, label,
    })));
    expect(uncapped).toEqual([true, true]);
  });

  runDb('re-reads a lowered cap while holding the partner lock', async () => {
    const f = await fixture(2);
    expect(await createLicensedDevice({
      partnerId: f.partner.id, orgId: f.org.id, siteId: f.site.id, label: 'before-lowering',
    })).toBe(true);
    await withSystemDbAccessContext(() => db.update(partners)
      .set({ maxDevices: 1 }).where(eq(partners.id, f.partner.id)));
    expect(await createLicensedDevice({
      partnerId: f.partner.id, orgId: f.org.id, siteId: f.site.id, label: 'after-lowering',
    })).toBe(false);
  });
});
