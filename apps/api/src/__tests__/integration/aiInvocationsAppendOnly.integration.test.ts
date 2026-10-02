/**
 * ai_invocations (AI model registry W02, #7600): append-only privilege +
 * trigger contract, merge re-point, erasure path, and CHECKs, through the
 * breeze_app pool.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { createOrganization, createPartner } from './db-utils';
import {
  closeRegistryFixtures,
  fixtureSql as adminSql,
  orgContext,
  partnerContext,
  seedByokConnection,
  seedOffering,
  seedPlatformModel,
} from './aiModelRegistryFixtures';
import { pruneAiInvocations } from '../../jobs/aiInvocationRetention';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

async function insertRow(orgId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const [row] = await adminSql`
    INSERT INTO ai_invocations ${adminSql({
      org_id: orgId, surface: 'chat', funding_source: 'platform',
      requested_model: 'claude-sonnet-5-5', served_model: 'claude-sonnet-5-5', ...extra,
    })} RETURNING id`;
  return String(row!.id);
}

describe.skipIf(!RUN)('ai_invocations append-only ledger (#7600 W02)', () => {
  it('breeze_app holds SELECT/INSERT and only a column-level UPDATE on org_id', async () => {
    const [p] = (await db.execute(sql`
      SELECT has_table_privilege('breeze_app', 'ai_invocations', 'INSERT') AS ins,
             has_table_privilege('breeze_app', 'ai_invocations', 'UPDATE') AS upd,
             has_table_privilege('breeze_app', 'ai_invocations', 'DELETE') AS del,
             has_column_privilege('breeze_app', 'ai_invocations', 'org_id', 'UPDATE') AS upd_org,
             has_column_privilege('breeze_app', 'ai_invocations', 'cost_cents', 'UPDATE') AS upd_cost`)) as unknown as Array<Record<string, boolean>>;
    expect(p).toEqual({ ins: true, upd: false, del: false, upd_org: true, upd_cost: false });
  });

  it('an org writes only its own rows: the provenance guard refuses an invisible org (23503)', async () => {
    const partner = await createPartner();
    const [orgA, orgB] = [await createOrganization({ partnerId: partner.id }), await createOrganization({ partnerId: partner.id })];
    await withDbAccessContext(orgContext(orgA.id, partner.id), () => db.execute(sql`
      INSERT INTO ai_invocations (org_id, surface, funding_source, requested_model, served_model)
      VALUES (${orgA.id}, 'chat', 'platform', 'm', 'm')`));
    // BEFORE ROW triggers run before the RLS WITH CHECK, and the guard's org
    // lookup runs under the writer's RLS, so the guard is the first wall.
    await expect(withDbAccessContext(orgContext(orgA.id, partner.id), () => db.execute(sql`
      INSERT INTO ai_invocations (org_id, surface, funding_source, requested_model, served_model)
      VALUES (${orgB.id}, 'chat', 'platform', 'm', 'm')`)))
      .rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('RLS alone also refuses a cross-org insert (42501) when the provenance guard is out of the way', async () => {
    // The guard's org lookup and the INSERT policy share one predicate
    // (breeze_has_org_access), so no row can pass the guard and still fail
    // RLS. To prove RLS is an independent second wall, the superuser fixture
    // suppresses ordinary triggers for this transaction only
    // (session_replication_role = replica — RLS is unaffected), then drops to
    // breeze_app with org A's context.
    const partner = await createPartner();
    const [orgA, orgB] = [await createOrganization({ partnerId: partner.id }), await createOrganization({ partnerId: partner.id })];
    const forge = (target: string) => adminSql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`SET LOCAL ROLE breeze_app`;
      await tx`SELECT set_config('breeze.scope', 'organization', true),
                      set_config('breeze.org_id', ${orgA.id}, true),
                      set_config('breeze.accessible_org_ids', ${orgA.id}, true),
                      set_config('breeze.accessible_partner_ids', '', true),
                      set_config('breeze.current_partner_id', ${partner.id}, true)`;
      const [who] = await tx`SELECT current_user AS u`;
      expect(who!.u).toBe('breeze_app');
      await tx`INSERT INTO ai_invocations (org_id, surface, funding_source, requested_model, served_model)
               VALUES (${target}, 'chat', 'platform', 'm', 'm')`;
      throw new Error('rollback');
    });
    // Control: the same path writes org A's own row (rolled back afterwards).
    await expect(forge(orgA.id)).rejects.toThrow('rollback');
    await expect(forge(orgB.id)).rejects.toMatchObject({ code: '42501' });
  });

  it('no column but org_id can be updated (42501), and org_id only during a same-partner merge (55000 otherwise)', async () => {
    const partner = await createPartner();
    const [loser, survivor] = [await createOrganization({ partnerId: partner.id }), await createOrganization({ partnerId: partner.id })];
    const foreign = await createOrganization({ partnerId: (await createPartner()).id });
    const id = await insertRow(loser.id, { cost_cents: 1, rate_snapshot: { source: 'platform' } });

    await expect(withSystemDbAccessContext(() => db.execute(sql`UPDATE ai_invocations SET cost_cents = 0 WHERE id = ${id}`)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(withSystemDbAccessContext(() => db.execute(sql`UPDATE ai_invocations SET org_id = ${survivor.id} WHERE id = ${id}`)))
      .rejects.toMatchObject({ cause: { code: '55000' } });

    await adminSql`UPDATE organizations SET status = 'merging' WHERE id = ${loser.id}`;
    await expect(withSystemDbAccessContext(() => db.execute(sql`UPDATE ai_invocations SET org_id = ${foreign.id} WHERE id = ${id}`)))
      .rejects.toMatchObject({ cause: { code: '55000' } });
    // A partner caller that forged the fence still can't move history: system scope is required.
    await expect(withDbAccessContext(partnerContext(partner.id, [loser.id, survivor.id]), () =>
      db.execute(sql`UPDATE ai_invocations SET org_id = ${survivor.id} WHERE id = ${id}`)))
      .rejects.toMatchObject({ cause: { code: '55000' } });
    await withSystemDbAccessContext(() => db.execute(sql`UPDATE ai_invocations SET org_id = ${survivor.id} WHERE org_id = ${loser.id}`));
    const [row] = await adminSql`SELECT org_id FROM ai_invocations WHERE id = ${id}`;
    expect(row!.org_id).toBe(survivor.id);
  });

  it('the retention GUC set by breeze_app itself does not authorize a delete', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const id = await insertRow(org.id);
    // breeze_app lacks DELETE anyway (42501); the trigger's role check is the
    // second wall for the window in which a replica's boot re-grants it.
    await expect(withSystemDbAccessContext(async () => {
      await db.execute(sql`SET LOCAL breeze.allow_audit_retention = '1'`);
      await db.execute(sql`DELETE FROM ai_invocations WHERE id = ${id}`);
    })).rejects.toMatchObject({ cause: { code: expect.stringMatching(/^(42501|55000)$/) } });
  });

  it('provenance guard: cross-org session / agent run, foreign offering or connection, funding mismatch are rejected', async () => {
    const [p, q] = [await createPartner(), await createPartner()];
    const [orgA, orgB] = [await createOrganization({ partnerId: p.id }), await createOrganization({ partnerId: p.id })];
    const [sessionB] = await adminSql`INSERT INTO ai_sessions (org_id, model) VALUES (${orgB.id}, 'claude-sonnet-5-5') RETURNING id`;
    const platformOfferQ = await seedOffering({ partnerId: q.id, platformModelId: await seedPlatformModel() });
    const platformOfferP = await seedOffering({ partnerId: p.id, platformModelId: await seedPlatformModel() });
    const connQ = await seedByokConnection(q.id);
    const insert = (extra: Record<string, unknown>) => withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO ai_invocations (org_id, surface, funding_source, requested_model, served_model, session_id, offering_id, connection_id)
      VALUES (${orgA.id}, 'chat', ${(extra.funding as string) ?? 'platform'}, 'm', 'm',
              ${(extra.session as string) ?? null}, ${(extra.offering as string) ?? null}, ${(extra.connection as string) ?? null})`));
    await expect(insert({ session: String(sessionB!.id) })).rejects.toMatchObject({ cause: { code: '23503' } });
    await expect(insert({ offering: platformOfferQ })).rejects.toMatchObject({ cause: { code: '23503' } });
    await expect(insert({ connection: connQ, funding: 'partner_key' })).rejects.toMatchObject({ cause: { code: '23503' } });
    await expect(insert({ offering: platformOfferP, funding: 'partner_key' })).rejects.toMatchObject({ cause: { code: '23514' } });
    await insert({ offering: platformOfferP, funding: 'platform' });
  });

  it('breeze_app cannot DELETE (42501); breeze_audit_admin deletes only with the retention GUC (55000 otherwise)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const id = await insertRow(org.id);
    await expect(withSystemDbAccessContext(() => db.execute(sql`DELETE FROM ai_invocations WHERE id = ${id}`)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(withSystemDbAccessContext(async () => {
      await db.execute(sql`SET LOCAL ROLE breeze_audit_admin`);
      await db.execute(sql`DELETE FROM ai_invocations WHERE id = ${id}`);
    })).rejects.toMatchObject({ cause: { code: '55000' } });
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`SET LOCAL ROLE breeze_audit_admin`);
      await db.execute(sql`SET LOCAL breeze.allow_audit_retention = '1'`);
      await db.execute(sql`DELETE FROM ai_invocations WHERE id = ${id}`);
    });
    const left = await adminSql`SELECT 1 FROM ai_invocations WHERE id = ${id}`;
    expect(left).toHaveLength(0);
  });

  it.each([
    ['a price without a rate snapshot', { cost_cents: 1 }],
    ['an unknown surface', { surface: 'telepathy' }],
    ['an unknown funding source', { funding_source: 'gift_card' }],
    ['a role outside the surface', { role: 'triage' }],
    ['legacy cost on an authoritative row', { ledger_mode: 'authoritative', legacy_cost_cents: 1 }],
  ])('rejects %s (23514)', async (_label, extra) => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await expect(insertRow(org.id, extra)).rejects.toMatchObject({ code: '23514' });
  });
});

describe.skipIf(!RUN)('ai_invocations retention (#7600 W02)', () => {
  it('prunes only rows older than the window, through the audit-admin path', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const old = await insertRow(org.id, { created_at: new Date(Date.now() - 60 * 86_400_000).toISOString() });
    const fresh = await insertRow(org.id);
    const result = await pruneAiInvocations({ retentionDays: 30, batchSize: 1000, maxBatches: 5 });
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(await adminSql`SELECT 1 FROM ai_invocations WHERE id = ${old}`).toHaveLength(0);
    expect(await adminSql`SELECT 1 FROM ai_invocations WHERE id = ${fresh}`).toHaveLength(1);
  });
});
