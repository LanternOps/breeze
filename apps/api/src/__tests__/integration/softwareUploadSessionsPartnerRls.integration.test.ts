/**
 * Partner-owned software_upload_sessions (#11412 W01, origin #9246): a session
 * uploading into a partner-wide catalog row is owned by the partner (org_id
 * NULL, partner_id set), never booked under a child org.
 *
 * Runs under vitest.integration.config.ts as the unprivileged `breeze_app`
 * role, so RLS is enforced. Pins:
 *   - partner A reads its own partner session; partner B cannot read, update,
 *     delete or forge one (42501);
 *   - a child-org (org scope) session never sees the partner session — there is
 *     deliberately no partner-wide SELECT branch (plan D3, the reports/webhooks
 *     precedent);
 *   - org XOR partner via software_upload_sessions_one_owner_chk (23514);
 *   - erasing a child org leaves the partner session; erasing the partner
 *     removes it (the partner sweep discovers the table from
 *     information_schema, not a static list).
 *
 * Raw SQL is used so each test pins the database contract (RLS, CHECK, FK)
 * independent of the Drizzle schema.
 */
import { getTestDb } from './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { createOrganization, createPartner } from './db-utils';
import { cascadeDeleteOrg, cascadeDeletePartner } from '../../services/tenantCascade';

const runDb = it.runIf(!!process.env.DATABASE_URL && !!process.env.DATABASE_URL_APP);

const SYSTEM: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};
const partnerContext = (partnerId: string, orgIds: string[] = []): DbAccessContext => ({
  scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], userId: null,
});
const orgContext = (orgId: string, partnerId: string): DbAccessContext => ({
  scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [],
  currentPartnerId: partnerId, userId: null,
});

async function insertCatalog(owner: { orgId: string | null; partnerId: string | null }): Promise<string> {
  const rows = await db.execute(sql`
    INSERT INTO software_catalog (org_id, partner_id, name)
    VALUES (${owner.orgId}, ${owner.partnerId}, 'Synthetic upload package') RETURNING id
  `);
  return String(rows[0]!.id);
}

async function insertSession(
  owner: { orgId: string | null; partnerId: string | null },
  catalogId: string,
): Promise<string> {
  const rows = await db.execute(sql`
    INSERT INTO software_upload_sessions
      (org_id, partner_id, catalog_id, file_name, file_size, chunk_size, temp_path, owner_instance_id, version_metadata)
    VALUES
      (${owner.orgId}, ${owner.partnerId}, ${catalogId}, 'installer.msi', 1024, 512,
       ${`/tmp/breeze-uploads/session-${randomUUID()}.part`}, 'itest-instance', '{"version":"1.0.0"}'::jsonb)
    RETURNING id
  `);
  return String(rows[0]!.id);
}

async function sessionExists(id: string): Promise<boolean> {
  const rows = await withDbAccessContext(SYSTEM, () =>
    db.execute(sql`SELECT id FROM software_upload_sessions WHERE id = ${id}`));
  return rows.length === 1;
}

async function seedPartnerSession() {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const childA = await createOrganization({ partnerId: partnerA.id });
  const { catalogId, sessionId } = await withDbAccessContext(SYSTEM, async () => {
    const catalogId = await insertCatalog({ orgId: null, partnerId: partnerA.id });
    const sessionId = await insertSession({ orgId: null, partnerId: partnerA.id }, catalogId);
    return { catalogId, sessionId };
  });
  return { partnerA, partnerB, childA, catalogId, sessionId };
}

describe('software_upload_sessions partner ownership (breeze_app)', () => {
  runDb('partner A context reads its partner session', async () => {
    const { partnerA, childA, sessionId } = await seedPartnerSession();
    const rows = await withDbAccessContext(partnerContext(partnerA.id, [childA.id]), () =>
      db.execute(sql`SELECT id, org_id, partner_id FROM software_upload_sessions WHERE id = ${sessionId}`));
    expect(rows).toEqual([{ id: sessionId, org_id: null, partner_id: partnerA.id }]);
  });

  runDb('partner B context cannot read, update or delete partner A\'s session', async () => {
    const { partnerB, sessionId } = await seedPartnerSession();
    const ctx = partnerContext(partnerB.id);

    expect(await withDbAccessContext(ctx, () =>
      db.execute(sql`SELECT id FROM software_upload_sessions WHERE id = ${sessionId}`))).toHaveLength(0);
    expect(await withDbAccessContext(ctx, () =>
      db.execute(sql`UPDATE software_upload_sessions SET bytes_received = 999 WHERE id = ${sessionId} RETURNING id`)))
      .toHaveLength(0);
    expect(await withDbAccessContext(ctx, () =>
      db.execute(sql`DELETE FROM software_upload_sessions WHERE id = ${sessionId} RETURNING id`))).toHaveLength(0);

    const survivor = await withDbAccessContext(SYSTEM, () =>
      db.execute(sql`SELECT bytes_received FROM software_upload_sessions WHERE id = ${sessionId}`));
    expect(survivor).toHaveLength(1);
    expect(Number(survivor[0]!.bytes_received)).toBe(0);
  });

  runDb('a forged INSERT with partner_id = partner A under partner B context is rejected (42501)', async () => {
    const { partnerA, partnerB, catalogId } = await seedPartnerSession();
    await expect(withDbAccessContext(partnerContext(partnerB.id), () =>
      insertSession({ orgId: null, partnerId: partnerA.id }, catalogId)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  });

  runDb('a child-org (org scope) context cannot see the partner session (no partner-wide SELECT branch)', async () => {
    const { partnerA, childA, sessionId } = await seedPartnerSession();
    const rows = await withDbAccessContext(orgContext(childA.id, partnerA.id), () =>
      db.execute(sql`SELECT id FROM software_upload_sessions WHERE id = ${sessionId}`));
    expect(rows).toHaveLength(0);
  });

  runDb('a child-org context cannot forge a partner-owned session (42501)', async () => {
    const { partnerA, childA, catalogId } = await seedPartnerSession();
    await expect(withDbAccessContext(orgContext(childA.id, partnerA.id), () =>
      insertSession({ orgId: null, partnerId: partnerA.id }, catalogId)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  });

  // Proven on the owner (migration-role) connection so the CHECK itself is what
  // answers: under breeze_app a row with no owner never reaches it, because
  // every policy branch requires a non-NULL owner column (next test).
  runDb.each(['both', 'neither'] as const)('a row with %s owner columns set violates the one-owner CHECK (23514)', async (shape) => {
    const { partnerA, childA, catalogId } = await seedPartnerSession();
    const owner = shape === 'both'
      ? { orgId: childA.id, partnerId: partnerA.id }
      : { orgId: null, partnerId: null };
    await expect(getTestDb().execute(sql`
      INSERT INTO software_upload_sessions
        (org_id, partner_id, catalog_id, file_name, file_size, chunk_size, temp_path, owner_instance_id)
      VALUES (${owner.orgId}, ${owner.partnerId}, ${catalogId}, 'installer.msi', 1024, 512,
              ${`/tmp/breeze-uploads/session-${randomUUID()}.part`}, 'itest-instance')
    `)).rejects.toMatchObject({ cause: { code: '23514', constraint_name: 'software_upload_sessions_one_owner_chk' } });
  });

  runDb('under breeze_app, an owner-less row is refused even in system context', async () => {
    const { catalogId } = await seedPartnerSession();
    await expect(withDbAccessContext(SYSTEM, () => insertSession({ orgId: null, partnerId: null }, catalogId)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  });

  runDb('cascadeDeleteOrg(child) removes the child\'s org session and leaves the partner session', async () => {
    const { partnerA, childA, sessionId: partnerSessionId } = await seedPartnerSession();
    const childSessionId = await withDbAccessContext(SYSTEM, async () => {
      const childCatalogId = await insertCatalog({ orgId: childA.id, partnerId: null });
      return insertSession({ orgId: childA.id, partnerId: null }, childCatalogId);
    });
    expect(await sessionExists(childSessionId)).toBe(true);

    await cascadeDeleteOrg(childA.id, '00000000-0000-0000-0000-000000000000');

    expect(await sessionExists(childSessionId)).toBe(false);
    expect(await sessionExists(partnerSessionId)).toBe(true);
    const owner = await withDbAccessContext(SYSTEM, () =>
      db.execute(sql`SELECT partner_id FROM software_upload_sessions WHERE id = ${partnerSessionId}`));
    expect(owner[0]!.partner_id).toBe(partnerA.id);
  });

  runDb('the partner sweep discovers software_upload_sessions from information_schema', async () => {
    // The same query cascadeDeletePartner runs (tenantCascade.ts partner sweep).
    const rows = (await db.execute(sql`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'partner_id'
        AND table_name <> 'organizations'
    `)) as unknown as Array<{ table_name: string }>;
    expect(rows.map((r) => r.table_name)).toContain('software_upload_sessions');
  });

  runDb('cascadeDeletePartner removes the partner session; another partner\'s session survives', async () => {
    const { partnerA, partnerB, sessionId } = await seedPartnerSession();
    const otherSessionId = await withDbAccessContext(SYSTEM, async () => {
      const otherCatalogId = await insertCatalog({ orgId: null, partnerId: partnerB.id });
      return insertSession({ orgId: null, partnerId: partnerB.id }, otherCatalogId);
    });

    await cascadeDeletePartner(partnerA.id, randomUUID());

    expect(await sessionExists(sessionId)).toBe(false);
    expect(await sessionExists(otherSessionId)).toBe(true);
  });
});
