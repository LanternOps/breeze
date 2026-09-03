/**
 * Real-DB truth table for the #4693 contract_lines site stamp, as breeze_app
 * (forced RLS, no bypass). Mirrors contractLinesDeviceGroupConstraints.
 *
 * Also replays the migration file to prove the backfill and idempotency, which
 * is the only way to test a backfill whose precondition the shipped CHECK now
 * forbids: drop the constraint, null a stamp, re-run the file.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, sites, contracts, contractLines, deviceGroups } from '../../db/schema';
import { getTestDb } from './setup';

const MIGRATION_FILE = join(__dirname, '../../../migrations/2026-10-08-100600-contract-lines-site-stamp.sql');
const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seed() {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `SS ${sfx}`, slug: `ss-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [o] = await db.insert(organizations)
      .values({ currencyCode: 'USD', partnerId: p!.id, name: 'SO', slug: `so-${sfx}` })
      .returning({ id: organizations.id });
    const [site] = await db.insert(sites).values({ orgId: o!.id, name: `Dallas ${sfx}` }).returning({ id: sites.id, name: sites.name });
    const [g] = await db.insert(deviceGroups).values({ orgId: o!.id, name: `VIP ${sfx}`, type: 'static' }).returning({ id: deviceGroups.id, name: deviceGroups.name });
    const [c] = await db.insert(contracts).values({
      partnerId: p!.id, orgId: o!.id, name: 'C', intervalMonths: 1, startDate: '2026-07-01', currencyCode: 'USD',
    }).returning({ id: contracts.id });
    return { orgId: o!.id, site: site!, group: g!, contractId: c!.id };
  });
}

/** Raw insert as breeze_app so the CHECK — not Drizzle typing — is what rejects. */
async function rawLine(f: Awaited<ReturnType<typeof seed>>, cols: Record<string, unknown>) {
  return withSystemDbAccessContext(() => db.insert(contractLines).values({
    contractId: f.contractId, orgId: f.orgId, description: 'x', unitPrice: '1.00', taxable: false,
    ...cols,
  } as never).returning({ id: contractLines.id }));
}

async function expectConstraint(operation: () => Promise<unknown>, constraint: RegExp) {
  try {
    await operation();
  } catch (error) {
    const wrapped = error as { message?: string; cause?: { message?: string; constraint_name?: string } };
    expect(`${wrapped.message ?? ''} ${wrapped.cause?.message ?? ''} ${wrapped.cause?.constraint_name ?? ''}`)
      .toMatch(constraint);
    return;
  }
  throw new Error(`expected constraint ${constraint} to reject the write`);
}

describe('contract_lines site stamp constraints (#4693)', () => {
  runDb('accepts a site-scoped line WITH a stamp on both site-scopable types', async () => {
    const f = await seed();
    for (const lineType of ['per_device', 'per_device_role'] as const) {
      const rows = await rawLine(f, {
        lineType, siteId: f.site.id, siteName: f.site.name,
        ...(lineType === 'per_device_role' ? { deviceRoles: ['server'] } : {}),
      });
      expect(rows).toHaveLength(1);
    }
  });

  runDb('rejects site_id without site_name', async () => {
    const f = await seed();
    await expectConstraint(() => rawLine(f, { lineType: 'per_device', siteId: f.site.id }), /contract_lines_site_stamp_chk/);
  });

  runDb('rejects a site stamp on flat, manual, per_seat and per_device_group', async () => {
    const f = await seed();
    await expectConstraint(() => rawLine(f, { lineType: 'flat', siteName: 'Dallas' }), /contract_lines_site_stamp_chk/);
    await expectConstraint(() => rawLine(f, { lineType: 'per_seat', siteName: 'Dallas' }), /contract_lines_site_stamp_chk/);
    await expectConstraint(() => rawLine(f, { lineType: 'manual', manualQuantity: '2', siteName: 'Dallas' }), /contract_lines_site_stamp_chk/);
    // The re-added wave-2 constraint is the one that fires for a group line.
    await expectConstraint(() => rawLine(f, {
      lineType: 'per_device_group', deviceGroupId: f.group.id, deviceGroupName: f.group.name, siteName: 'Dallas',
    }), /contract_lines_(device_group|site_stamp)_chk/);
  });

  runDb('accepts a line that never had a site, and one whose site was deleted', async () => {
    const f = await seed();
    expect(await rawLine(f, { lineType: 'per_device' })).toHaveLength(1);
    const [scoped] = await rawLine(f, { lineType: 'per_device', siteId: f.site.id, siteName: f.site.name });
    await withSystemDbAccessContext(() => db.delete(sites).where(eq(sites.id, f.site.id)));
    const [after] = await withSystemDbAccessContext(() =>
      db.select({ siteId: contractLines.siteId, siteName: contractLines.siteName })
        .from(contractLines).where(eq(contractLines.id, scoped!.id)));
    // The FK nulls the ID ONLY. The stamp is what survives — the whole fix.
    expect(after).toEqual({ siteId: null, siteName: f.site.name });
  });

  runDb('the backfill stamps a pre-existing site-scoped row, and re-applying is a no-op', async () => {
    const f = await seed();
    const [line] = await rawLine(f, { lineType: 'per_device', siteId: f.site.id, siteName: f.site.name });
    const migration = readFileSync(MIGRATION_FILE, 'utf8');
    const adminDb = getTestDb();
    await adminDb.transaction(async (tx) => {
      // Reproduce the pre-migration world: no CHECK, no stamp.
      await tx.execute(sql.raw('ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_site_stamp_chk'));
      await tx.execute(sql`UPDATE contract_lines SET site_name = NULL WHERE id = ${line!.id}`);
      await tx.execute(sql.raw(migration));
    });
    const [restamped] = await withSystemDbAccessContext(() =>
      db.select({ siteName: contractLines.siteName }).from(contractLines).where(eq(contractLines.id, line!.id)));
    expect(restamped!.siteName).toBe(f.site.name);
    // Idempotency: a second run changes nothing and raises no error.
    await adminDb.execute(sql.raw(migration));
    const [again] = await withSystemDbAccessContext(() =>
      db.select({ siteName: contractLines.siteName }).from(contractLines).where(eq(contractLines.id, line!.id)));
    expect(again!.siteName).toBe(f.site.name);
    // And the constraint is back, so a forged row is rejected again.
    await expectConstraint(() => rawLine(f, { lineType: 'per_device', siteId: f.site.id }), /contract_lines_site_stamp_chk/);
  });
});
