/**
 * IOC sweeps against real Postgres (#6263 W05, migration
 * 2027-01-04-140000-security-scan-sweeps.sql).
 *
 * tenancy  — security_scan_sweeps RLS (shape 1) through breeze_app, the CHECKs,
 *            and the plain security_scans.sweep_id FK (ON DELETE SET NULL).
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { securityScans, securityScanSweeps } from '../../db/schema';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

function orgCtx(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: partnerId,
  };
}

const as = <T>(ctx: DbAccessContext, fn: () => Promise<T>) => withDbAccessContext(ctx, fn);

const PIN = { id: randomUUID(), version: 1, sha256: 'a'.repeat(64) };

function sweepValues(orgId: string, overrides: Partial<typeof securityScanSweeps.$inferInsert> = {}) {
  return {
    orgId,
    groupId: randomUUID(),
    dedupeKey: 'b'.repeat(64),
    ruleSetIds: [PIN.id],
    ruleSetPins: [PIN],
    scanType: 'quick',
    scope: { kind: 'all' },
    targetedCount: 1,
    origin: 'web',
    expiresAt: new Date(Date.now() + 3_600_000),
    ...overrides,
  } satisfies typeof securityScanSweeps.$inferInsert;
}

async function seedOrgs() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: orgA.id });
  const deviceA = await createDevice({ orgId: orgA.id, siteId: siteA.id });
  return { partnerId: partner.id, orgA: orgA.id, orgB: orgB.id, deviceA: deviceA.id };
}

async function insertSweep(orgId: string, overrides: Partial<typeof securityScanSweeps.$inferInsert> = {}) {
  return as(SYSTEM_CTX, async () => {
    const [row] = await db.insert(securityScanSweeps).values(sweepValues(orgId, overrides)).returning();
    return row!;
  });
}

describe('tenancy', () => {
  it('org A user cannot read org B sweep', async () => {
    const w = await seedOrgs();
    const sweepA = await insertSweep(w.orgA);
    const sweepB = await insertSweep(w.orgB);
    const seen = await as(orgCtx(w.orgA, w.partnerId), () =>
      db.select({ id: securityScanSweeps.id }).from(securityScanSweeps),
    );
    expect(seen.map((r) => r.id)).toEqual([sweepA.id]);
    expect(seen.map((r) => r.id)).not.toContain(sweepB.id);

    // Nor update or delete it.
    const updated = await as(orgCtx(w.orgA, w.partnerId), () =>
      db.update(securityScanSweeps).set({ state: 'cancelled' }).where(eq(securityScanSweeps.id, sweepB.id)).returning(),
    );
    expect(updated).toEqual([]);
    const deleted = await as(orgCtx(w.orgA, w.partnerId), () =>
      db.delete(securityScanSweeps).where(eq(securityScanSweeps.id, sweepB.id)).returning(),
    );
    expect(deleted).toEqual([]);
  });

  it('forged org-B insert under org-A breeze_app context fails WITH CHECK', async () => {
    const w = await seedOrgs();
    await expect(
      as(orgCtx(w.orgA, w.partnerId), () => db.insert(securityScanSweeps).values(sweepValues(w.orgB))),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    // Moving an own row into another org is refused by the UPDATE WITH CHECK.
    const own = await insertSweep(w.orgA);
    await expect(
      as(orgCtx(w.orgA, w.partnerId), () =>
        db.update(securityScanSweeps).set({ orgId: w.orgB }).where(eq(securityScanSweeps.id, own.id)),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('security_scans.sweep_id SET NULL on sweep delete', async () => {
    const w = await seedOrgs();
    const sweep = await insertSweep(w.orgA);
    const scanId = await as(SYSTEM_CTX, async () => {
      const [scan] = await db
        .insert(securityScans)
        .values({ orgId: w.orgA, deviceId: w.deviceA, scanType: 'quick', status: 'queued', sweepId: sweep.id })
        .returning({ id: securityScans.id });
      return scan!.id;
    });
    await as(SYSTEM_CTX, () => db.delete(securityScanSweeps).where(eq(securityScanSweeps.id, sweep.id)));
    const [scan] = await as(SYSTEM_CTX, () =>
      db.select({ sweepId: securityScans.sweepId }).from(securityScans).where(eq(securityScans.id, scanId)),
    );
    expect(scan).toEqual({ sweepId: null });
  });

  it("state CHECK rejects 'done'", async () => {
    const w = await seedOrgs();
    await expect(insertSweep(w.orgA, { state: 'done' })).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('paths and origin CHECKs', async () => {
    const w = await seedOrgs();
    // custom without paths
    await expect(insertSweep(w.orgA, { scanType: 'custom' })).rejects.toMatchObject({ cause: { code: '23514' } });
    // quick with paths
    await expect(insertSweep(w.orgA, { paths: ['/tmp'] })).rejects.toMatchObject({ cause: { code: '23514' } });
    // custom with 21 paths
    await expect(
      insertSweep(w.orgA, { scanType: 'custom', paths: Array.from({ length: 21 }, (_, i) => `/p${i}`) }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    // unknown origin
    await expect(insertSweep(w.orgA, { origin: 'cron' })).rejects.toMatchObject({ cause: { code: '23514' } });
    // 0 and 21 rule sets
    await expect(insertSweep(w.orgA, { ruleSetIds: [] })).rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(
      insertSweep(w.orgA, { ruleSetIds: Array.from({ length: 21 }, () => randomUUID()) }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    // the happy custom shape is accepted
    const ok = await insertSweep(w.orgA, { scanType: 'custom', paths: ['/tmp', 'C:\\Users'], origin: 'mcp' });
    expect(ok.state).toBe('active');
  });
});
