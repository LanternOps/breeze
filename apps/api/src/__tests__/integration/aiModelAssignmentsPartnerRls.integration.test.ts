/**
 * ai_model_assignments (AI model registry W02, #7600): dual-axis RLS, XOR,
 * composite-FK and array-ownership-trigger proofs through the breeze_app pool.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { buildRepointDedupe } from '../../services/orgMergeExecutors';
import { getOrgMergePolicies } from '../../services/orgMergeRegistry';
import { createOrganization, createPartner } from './db-utils';
import {
  closeRegistryFixtures,
  fixtureSql as adminSql,
  orgContext,
  partnerContext,
  seedOffering,
  seedPlatformModel,
} from './aiModelRegistryFixtures';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

async function partnerWithOffering(enabled = true) {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const offering = await seedOffering({ partnerId: partner.id, platformModelId: await seedPlatformModel(), enabled });
  return { partner, org, offering };
}

async function seedPartnerRow(partnerId: string, surface = 'chat', extra: Record<string, unknown> = {}): Promise<string> {
  const [row] = await adminSql`
    INSERT INTO ai_model_assignments ${adminSql({ partner_id: partnerId, offering_partner_id: partnerId, surface, ...extra })}
    RETURNING id`;
  return String(row!.id);
}

describe.skipIf(!RUN)('ai_model_assignments partner RLS (#7600 W02)', () => {
  it('partner B cannot forge a partner-A row (42501)', async () => {
    const a = await partnerWithOffering();
    const b = await createPartner();
    await expect(withDbAccessContext(partnerContext(b.id), () => db.execute(sql`
      INSERT INTO ai_model_assignments (partner_id, offering_partner_id, surface)
      VALUES (${a.partner.id}, ${a.partner.id}, 'chat')`)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it.each([
    ['both axes', (p: string, o: string) => sql`INSERT INTO ai_model_assignments (org_id, partner_id, offering_partner_id, surface) VALUES (${o}, ${p}, ${p}, 'chat')`],
    ['neither axis', (p: string) => sql`INSERT INTO ai_model_assignments (offering_partner_id, surface) VALUES (${p}, 'chat')`],
    ['a partner row naming another offering partner', (p: string, _o: string, q: string) => sql`INSERT INTO ai_model_assignments (partner_id, offering_partner_id, surface) VALUES (${p}, ${q}, 'chat')`],
    ['a role on a surface without roles', (p: string) => sql`INSERT INTO ai_model_assignments (partner_id, offering_partner_id, surface, role) VALUES (${p}, ${p}, 'chat', 'triage')`],
    ['an unknown surface', (p: string) => sql`INSERT INTO ai_model_assignments (partner_id, offering_partner_id, surface) VALUES (${p}, ${p}, 'telepathy')`],
  ])('rejects %s (23514)', async (_label, statement) => {
    const { partner, org } = await partnerWithOffering();
    const other = await createPartner();
    await expect(withSystemDbAccessContext(() => db.execute(statement(partner.id, org.id, other.id))))
      .rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('an org row cannot claim another partner as offering owner (23503 org_partner_fk)', async () => {
    const a = await partnerWithOffering();
    const b = await partnerWithOffering();
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO ai_model_assignments (org_id, offering_partner_id, surface, default_offering_id)
      VALUES (${a.org.id}, ${b.partner.id}, 'chat', ${b.offering})`)))
      .rejects.toMatchObject({ cause: { code: '23503', constraint_name: 'ai_model_assignments_org_partner_fk' } });
  });

  it('a default cannot be another partner\'s offering (23503 default_offering_fk)', async () => {
    const a = await partnerWithOffering();
    const b = await partnerWithOffering();
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO ai_model_assignments (partner_id, offering_partner_id, surface, default_offering_id)
      VALUES (${a.partner.id}, ${a.partner.id}, 'chat', ${b.offering})`)))
      .rejects.toMatchObject({ cause: { code: '23503', constraint_name: 'ai_model_assignments_default_offering_fk' } });
  });

  it.each(['permitted_offering_ids', 'fallback_offering_ids'] as const)(
    'the %s trigger rejects another partner\'s offering (23503), duplicates (23514) and NULL elements (23514)',
    async (column) => {
      const a = await partnerWithOffering();
      const b = await partnerWithOffering();
      const col = sql.raw(column);
      await expect(withSystemDbAccessContext(() => db.execute(sql`
        INSERT INTO ai_model_assignments (partner_id, offering_partner_id, surface, ${col})
        VALUES (${a.partner.id}, ${a.partner.id}, 'chat', ARRAY[${a.offering}, ${b.offering}]::uuid[])`)))
        .rejects.toMatchObject({ cause: { code: '23503' } });
      await expect(withSystemDbAccessContext(() => db.execute(sql`
        INSERT INTO ai_model_assignments (partner_id, offering_partner_id, surface, ${col})
        VALUES (${a.partner.id}, ${a.partner.id}, 'helper', ARRAY[${a.offering}, ${a.offering}]::uuid[])`)))
        .rejects.toMatchObject({ cause: { code: '23514' } });
      await expect(withSystemDbAccessContext(() => db.execute(sql`
        INSERT INTO ai_model_assignments (partner_id, offering_partner_id, surface, ${col})
        VALUES (${a.partner.id}, ${a.partner.id}, 'office_chat', ARRAY[${a.offering}, NULL]::uuid[])`)))
        .rejects.toMatchObject({ cause: { code: '23514' } });
    },
  );

  it('an org context can reference only ENABLED offerings of its partner (writer-RLS trigger rule)', async () => {
    const { partner, org, offering } = await partnerWithOffering(false);
    await expect(withDbAccessContext(orgContext(org.id, partner.id), () => db.execute(sql`
      INSERT INTO ai_model_assignments (org_id, offering_partner_id, surface, permitted_offering_ids)
      VALUES (${org.id}, ${partner.id}, 'chat', ARRAY[${offering}]::uuid[])`)))
      .rejects.toMatchObject({ cause: { code: '23503' } });
    await adminSql`UPDATE partner_ai_models SET enabled = true WHERE id = ${offering}`;
    await withDbAccessContext(orgContext(org.id, partner.id), () => db.execute(sql`
      INSERT INTO ai_model_assignments (org_id, offering_partner_id, surface, permitted_offering_ids)
      VALUES (${org.id}, ${partner.id}, 'chat', ARRAY[${offering}]::uuid[])`));
  });

  it('an org token reads its partner\'s partner-wide rows but cannot update or delete them', async () => {
    const { partner, org } = await partnerWithOffering();
    const rowId = await seedPartnerRow(partner.id);
    const read = await withDbAccessContext(orgContext(org.id, partner.id), () =>
      db.execute(sql`SELECT id FROM ai_model_assignments WHERE id = ${rowId}`));
    expect([...read]).toHaveLength(1);
    const upd = await withDbAccessContext(orgContext(org.id, partner.id), () =>
      db.execute(sql`UPDATE ai_model_assignments SET allow_user_choice = false WHERE id = ${rowId} RETURNING id`));
    const del = await withDbAccessContext(orgContext(org.id, partner.id), () =>
      db.execute(sql`DELETE FROM ai_model_assignments WHERE id = ${rowId} RETURNING id`));
    expect([...upd]).toEqual([]);
    expect([...del]).toEqual([]);
  });

  it('org A cannot see org B\'s override, and partner Q cannot see partner P\'s rows', async () => {
    const p = await partnerWithOffering();
    const orgB = await createOrganization({ partnerId: p.partner.id });
    await adminSql`INSERT INTO ai_model_assignments (org_id, offering_partner_id, surface) VALUES (${orgB.id}, ${p.partner.id}, 'chat')`;
    const q = await createPartner();
    const fromOrgA = await withDbAccessContext(orgContext(p.org.id, p.partner.id), () =>
      db.execute(sql`SELECT id FROM ai_model_assignments WHERE org_id = ${orgB.id}`));
    const fromQ = await withDbAccessContext(partnerContext(q.id), () =>
      db.execute(sql`SELECT id FROM ai_model_assignments WHERE offering_partner_id = ${p.partner.id}`));
    expect([...fromOrgA]).toEqual([]);
    expect([...fromQ]).toEqual([]);
  });

  it('one row per (owner, surface, role) (23505)', async () => {
    const { partner } = await partnerWithOffering();
    await seedPartnerRow(partner.id, 'helper');
    await expect(seedPartnerRow(partner.id, 'helper')).rejects.toMatchObject({ code: '23505' });
  });

  it('the org-side composite FK is deferrable (merge contract)', async () => {
    const [row] = await adminSql`
      SELECT condeferrable, condeferred FROM pg_constraint WHERE conname = 'ai_model_assignments_org_partner_fk'`;
    expect(row).toMatchObject({ condeferrable: true, condeferred: false });
  });

  it('a merge keeps the survivor\'s override per (surface, role) and repoints the rest', async () => {
    const { partner, org: survivor, offering } = await partnerWithOffering();
    const loser = await createOrganization({ partnerId: partner.id });
    for (const [orgId, surface] of [[survivor.id, 'chat'], [loser.id, 'chat'], [loser.id, 'helper']] as const) {
      await adminSql`INSERT INTO ai_model_assignments (org_id, offering_partner_id, surface, default_offering_id)
                     VALUES (${orgId}, ${partner.id}, ${surface}, ${offering})`;
    }
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      const policy = getOrgMergePolicies().get('ai_model_assignments');
      if (policy?.kind !== 'repoint-dedupe') throw new Error('ai_model_assignments must be repoint-dedupe');
      for (const statement of buildRepointDedupe('ai_model_assignments', policy.key, policy.keyWhere, loser.id, survivor.id)) {
        await db.execute(statement);
      }
    });
    const rows = await adminSql`SELECT org_id, surface FROM ai_model_assignments WHERE offering_partner_id = ${partner.id} ORDER BY surface`;
    expect(rows.map((r) => [r.org_id, r.surface])).toEqual([[survivor.id, 'chat'], [survivor.id, 'helper']]);
  });

  it('a partner context manages its own partner row and its orgs\' override rows', async () => {
    const { partner, org, offering } = await partnerWithOffering();
    await withDbAccessContext(partnerContext(partner.id, [org.id]), async () => {
      await db.execute(sql`INSERT INTO ai_model_assignments (partner_id, offering_partner_id, surface, default_offering_id)
                           VALUES (${partner.id}, ${partner.id}, 'chat', ${offering})`);
      await db.execute(sql`INSERT INTO ai_model_assignments (org_id, offering_partner_id, surface, permitted_offering_ids)
                           VALUES (${org.id}, ${partner.id}, 'chat', ARRAY[${offering}]::uuid[])`);
    });
    const [count] = await adminSql`SELECT count(*)::int AS n FROM ai_model_assignments WHERE offering_partner_id = ${partner.id}`;
    expect(count!.n).toBe(2);
  });
});
