import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { buildOrgExportZip } from '../../services/tenantExport';
import { cascadeDeleteOrg } from '../../services/tenantCascade';

/**
 * End-to-end proof for the GDPR export + erasure round-trip (Task 30,
 * Tier-2 launch gate "tenant data export + delete proven end-to-end").
 *
 * The sibling `tenantCascade.integration.test.ts` is a *structural*
 * contract test (the cascade list matches the schema + FK topology). It
 * never seeds real rows. This test closes that gap: it seeds two orgs
 * with real org-scoped rows, then exercises the actual service functions
 * against the live `breeze_app` pool to prove:
 *
 *   1. buildOrgExportZip() emits a real ZIP whose manifest row-counts
 *      reflect ONLY the requested org's rows (cross-tenant isolation on
 *      the read path).
 *   2. cascadeDeleteOrg() removes every org-scoped row + the org itself
 *      for the target org, and leaves a second org's rows untouched
 *      (cross-tenant isolation on the delete path).
 *
 * Seeding goes through getTestDb() (superuser, RLS-bypassing). The code
 * under test imports `db` (breeze_app pool) where RLS is enforced.
 */

const PERFORMED_BY = '00000000-0000-0000-0000-0000000000aa';
const PERFORMED_EMAIL = 'platform-admin@breeze.test';

interface SeededOrgs {
  partnerId: string;
  orgA: string;
  orgB: string;
}

async function seedTwoOrgs(): Promise<SeededOrgs> {
  const db = getTestDb();
  const partnerId = crypto.randomUUID();
  const orgA = crypto.randomUUID();
  const orgB = crypto.randomUUID();
  const suffix = partnerId.slice(0, 8);

  await db.execute(sql`
    INSERT INTO partners (id, name, slug)
    VALUES (${partnerId}, ${'RoundtripCo ' + suffix}, ${'roundtrip-' + suffix})
  `);
  await db.execute(sql`
    INSERT INTO organizations (id, partner_id, name, slug) VALUES
      (${orgA}, ${partnerId}, ${'Org A ' + suffix}, ${'org-a-' + suffix}),
      (${orgB}, ${partnerId}, ${'Org B ' + suffix}, ${'org-b-' + suffix})
  `);

  // Org A: 2 sites + 2 device_groups. Org B: 1 site + 1 device_group.
  await db.execute(sql`
    INSERT INTO sites (id, org_id, name) VALUES
      (${crypto.randomUUID()}, ${orgA}, 'A-Site-1'),
      (${crypto.randomUUID()}, ${orgA}, 'A-Site-2'),
      (${crypto.randomUUID()}, ${orgB}, 'B-Site-1')
  `);
  await db.execute(sql`
    INSERT INTO device_groups (id, org_id, name) VALUES
      (${crypto.randomUUID()}, ${orgA}, 'A-Group-1'),
      (${crypto.randomUUID()}, ${orgA}, 'A-Group-2'),
      (${crypto.randomUUID()}, ${orgB}, 'B-Group-1')
  `);

  return { partnerId, orgA, orgB };
}

function rowCount(db: ReturnType<typeof getTestDb>, table: string, orgId: string) {
  return db
    .execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(`"${table}"`)} WHERE org_id = ${orgId}`)
    .then((r) => (r as unknown as Array<{ n: number }>)[0].n);
}

describe('tenant export + erasure round-trip (live DB)', () => {
  beforeEach(async () => {
    // cleanupDatabase() in setup.ts already TRUNCATEs sites/device_groups/
    // organizations/partners before each test.
  });

  it('export manifest reflects only the target org rows', async () => {
    const { orgA } = await seedTwoOrgs();

    const { manifest, zipBuffer } = await buildOrgExportZip(orgA, PERFORMED_BY, PERFORMED_EMAIL);

    // It's a real, non-empty ZIP (local-file-header magic "PK\x03\x04").
    expect(zipBuffer.length).toBeGreaterThan(0);
    expect(zipBuffer.subarray(0, 2).toString('latin1')).toBe('PK');

    const byName = new Map(manifest.files.map((f) => [f.name, f]));
    // Org A has exactly 2 sites + 2 device_groups; Org B's rows must not leak.
    expect(byName.get('sites.json')?.rowCount).toBe(2);
    expect(byName.get('device_groups.json')?.rowCount).toBe(2);
    // organizations.json is the org's own id-keyed row.
    expect(byName.get('organizations.json')?.rowCount).toBe(1);
    // Every manifest entry carries a sha256.
    for (const f of manifest.files) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(manifest.orgId).toBe(orgA);
  });

  it('cascade erases the target org and leaves the other org intact', async () => {
    const db = getTestDb();
    const { orgA, orgB } = await seedTwoOrgs();

    // Sanity: both orgs populated before erasure.
    expect(await rowCount(db, 'sites', orgA)).toBe(2);
    expect(await rowCount(db, 'sites', orgB)).toBe(1);

    const stats = await cascadeDeleteOrg(orgA, PERFORMED_BY, PERFORMED_EMAIL);

    // Target org fully wiped.
    expect(await rowCount(db, 'sites', orgA)).toBe(0);
    expect(await rowCount(db, 'device_groups', orgA)).toBe(0);
    const orgARows = (await db.execute(
      sql`SELECT count(*)::int AS n FROM organizations WHERE id = ${orgA}`,
    )) as unknown as Array<{ n: number }>;
    expect(orgARows[0].n).toBe(0);

    // Cross-tenant rows untouched.
    expect(await rowCount(db, 'sites', orgB)).toBe(1);
    expect(await rowCount(db, 'device_groups', orgB)).toBe(1);
    const orgBRows = (await db.execute(
      sql`SELECT count(*)::int AS n FROM organizations WHERE id = ${orgB}`,
    )) as unknown as Array<{ n: number }>;
    expect(orgBRows[0].n).toBe(1);

    // Stats account for at least the 5 rows we seeded into org A.
    expect(stats.totalRowsDeleted).toBeGreaterThanOrEqual(5);
    expect(stats.tablesDeleted['sites']).toBe(2);
    expect(stats.tablesDeleted['device_groups']).toBe(2);
    expect(stats.tablesDeleted['organizations']).toBe(1);
  });
});
