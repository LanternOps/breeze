/**
 * Real-PostgreSQL proof for the `device_warranty` XOR subject (#4622 W03).
 *
 * A CHECK constraint, a composite same-org FK and its ON DELETE CASCADE cannot
 * be proven against a mocked db — the unit tests in
 * `services/warrantySync.manualAsset.test.ts` pin the application shape, and
 * this file pins what the database will actually enforce.
 *
 * Ordering trap this file exists for: RLS is evaluated BEFORE table CHECK
 * constraints, so a forge run in the wrong tenant context returns 42501 and
 * never reaches 23514. Every XOR assertion below therefore runs in a context
 * that is allowed to write the row, so the only thing left to reject it is the
 * constraint under test.
 */
import './setup';

import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

async function causeOf(work: () => Promise<unknown>): Promise<{ code?: string; message?: string } | undefined> {
  try {
    await work();
    return undefined;
  } catch (error) {
    return (
      (error as { cause?: { code?: string; message?: string } }).cause ??
      (error as { code?: string; message?: string })
    );
  }
}

async function seedManualAsset(orgId: string, siteId: string, serial: string): Promise<string> {
  const [row] = (await getTestDb().execute(sql`
    INSERT INTO manual_assets (org_id, site_id, name, manufacturer, serial_number)
    VALUES (${orgId}, ${siteId}, ${'XOR fixture ' + serial}, 'Dell', ${serial})
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return row!.id;
}

async function seedDevice(orgId: string, siteId: string, agentId: string): Promise<string> {
  const [row] = (await getTestDb().execute(sql`
    INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
    VALUES (${orgId}, ${siteId}, ${agentId}, ${'xor-host-' + agentId}, 'windows', '11', 'amd64', '1.0.0')
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return row!.id;
}

async function seedTenant() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  return { org, site };
}

describe('device_warranty XOR subject (#4622)', () => {
  runDb('accepts a manual-asset subject and cascades when the asset is deleted', async () => {
    const { org, site } = await seedTenant();
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const manualAssetId = await seedManualAsset(org.id, site.id, `SN-OK-${suffix}`);

    // Positive control, in the SAME context the negatives below use: a green
    // rejection cannot be the fixture being broken.
    await withDbAccessContext(orgContext(org.id), async () => {
      await db.execute(sql`
        INSERT INTO device_warranty (org_id, manual_asset_id, manufacturer, serial_number, status)
        VALUES (${org.id}, ${manualAssetId}, 'dell', ${`SN-OK-${suffix}`}, 'unknown')
      `);
    });

    const before = (await getTestDb().execute(sql`
      SELECT device_id, manual_asset_id FROM device_warranty WHERE manual_asset_id = ${manualAssetId}
    `)) as unknown as Array<{ device_id: string | null; manual_asset_id: string }>;
    expect(before).toHaveLength(1);
    expect(before[0]!.device_id).toBeNull();

    await getTestDb().execute(sql`DELETE FROM manual_assets WHERE id = ${manualAssetId}`);

    const after = (await getTestDb().execute(sql`
      SELECT 1 AS n FROM device_warranty WHERE manual_asset_id = ${manualAssetId}
    `)) as unknown as unknown[];
    expect(after, 'ON DELETE CASCADE must remove the warranty row with its subject').toHaveLength(0);
  });

  runDb('rejects a row carrying BOTH subjects with 23514', async () => {
    const { org, site } = await seedTenant();
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const manualAssetId = await seedManualAsset(org.id, site.id, `SN-BOTH-${suffix}`);
    const deviceId = await seedDevice(org.id, site.id, `xor-agent-both-${suffix}`);

    const cause = await causeOf(() =>
      withDbAccessContext(orgContext(org.id), () =>
        db.execute(sql`
          INSERT INTO device_warranty (org_id, device_id, manual_asset_id, manufacturer, serial_number, status)
          VALUES (${org.id}, ${deviceId}, ${manualAssetId}, 'dell', ${`SN-BOTH-${suffix}`}, 'unknown')
        `),
      ),
    );

    expect(cause?.code, `expected a CHECK violation, got ${cause?.code}: ${cause?.message}`).toBe('23514');
    expect(cause?.message).toContain('device_warranty_one_subject_chk');
  });

  runDb('rejects a row carrying NEITHER subject with 23514', async () => {
    const { org } = await seedTenant();
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    const cause = await causeOf(() =>
      withDbAccessContext(orgContext(org.id), () =>
        db.execute(sql`
          INSERT INTO device_warranty (org_id, manufacturer, serial_number, status)
          VALUES (${org.id}, 'dell', ${`SN-NONE-${suffix}`}, 'unknown')
        `),
      ),
    );

    expect(cause?.code, `expected a CHECK violation, got ${cause?.code}: ${cause?.message}`).toBe('23514');
    expect(cause?.message).toContain('device_warranty_one_subject_chk');
  });

  runDb('refuses to bind a warranty row to a manual asset in another org', async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const a = await seedTenant();
    const b = await seedTenant();
    const foreignAssetId = await seedManualAsset(b.org.id, b.site.id, `SN-XORG-${suffix}`);

    const cause = await causeOf(() =>
      withDbAccessContext(orgContext(a.org.id), () =>
        db.execute(sql`
          INSERT INTO device_warranty (org_id, manual_asset_id, manufacturer, serial_number, status)
          VALUES (${a.org.id}, ${foreignAssetId}, 'dell', ${`SN-XORG-${suffix}`}, 'unknown')
        `),
      ),
    );

    // The composite (manual_asset_id, org_id) FK is what makes this
    // unrepresentable — a single-column FK would happily accept it.
    expect(cause?.code, `expected an FK violation, got ${cause?.code}: ${cause?.message}`).toBe('23503');
  });

  runDb('declares the composite manual-asset FK DEFERRABLE INITIALLY IMMEDIATE', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT condeferrable, condeferred
      FROM pg_constraint
      WHERE conname = 'device_warranty_manual_asset_fk'
        AND conrelid = 'public.device_warranty'::regclass
    `)) as unknown as Array<{ condeferrable: boolean; condeferred: boolean }>;

    expect(rows, 'the composite FK must exist').toHaveLength(1);
    // Org merge runs SET CONSTRAINTS ALL DEFERRED and re-points parent and
    // child org_id in separate statements; a non-deferrable FK aborts it 23503.
    expect(rows[0]).toMatchObject({ condeferrable: true, condeferred: false });
  });

  runDb('keeps device_id nullable with a partial unique index per subject kind', async () => {
    const [col] = (await getTestDb().execute(sql`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'device_warranty' AND column_name = 'device_id'
    `)) as unknown as Array<{ is_nullable: string }>;
    expect(col!.is_nullable).toBe('YES');

    const indexes = (await getTestDb().execute(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'device_warranty'
        AND indexname IN ('device_warranty_device_id_idx', 'device_warranty_manual_asset_id_idx')
      ORDER BY indexname
    `)) as unknown as Array<{ indexname: string; indexdef: string }>;

    expect(indexes.map((i) => i.indexname)).toEqual([
      'device_warranty_device_id_idx',
      'device_warranty_manual_asset_id_idx',
    ]);
    for (const index of indexes) {
      expect(index.indexdef).toContain('UNIQUE');
      // Partial: a NULL subject column must not occupy the conflict target.
      expect(index.indexdef).toContain('IS NOT NULL');
    }
  });
});
