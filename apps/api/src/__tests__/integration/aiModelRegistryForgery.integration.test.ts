/**
 * AI model registry W02 (#7600): direct-SQL forgery and RLS proofs for every
 * registry table, composite FK and trigger, run through the breeze_app pool
 * (`db` from ../../db) so FORCE RLS applies.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import {
  closeRegistryFixtures,
  fixtureSql as adminSql,
  orgContext,
  partnerContext,
  seedByokConnection,
  seedOffering,
  seedAgent,
  seedPlatformModel,
} from './aiModelRegistryFixtures';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

describe.skipIf(!RUN)('partner_ai_connections (#7600 W02)', () => {
  it('partner A cannot INSERT a connection for partner B (42501)', async () => {
    const [a, b] = [await createPartner(), await createPartner()];
    await expect(withDbAccessContext(partnerContext(a.id), () => db.execute(sql`
      INSERT INTO partner_ai_connections (partner_id, kind, name, api_key_encrypted, key_last4, key_fingerprint)
      VALUES (${b.id}, 'anthropic_byok', 'forged', 'enc:x', 'x', 'x')`)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('partner A cannot SELECT partner B connections, and an org token cannot read any', async () => {
    const [a, b] = [await createPartner(), await createPartner()];
    const orgB = await createOrganization({ partnerId: b.id });
    const id = await seedByokConnection(b.id);
    const asA = await withDbAccessContext(partnerContext(a.id), () =>
      db.execute(sql`SELECT id FROM partner_ai_connections WHERE id = ${id}`));
    const asOrgB = await withDbAccessContext(orgContext(orgB.id, b.id), () =>
      db.execute(sql`SELECT id FROM partner_ai_connections WHERE id = ${id}`));
    expect([...asA]).toEqual([]);
    expect([...asOrgB]).toEqual([]);
  });

  it('rejects a catalog connection without a catalog entry (23514)', async () => {
    const p = await createPartner();
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO partner_ai_connections (partner_id, kind, name, api_key_encrypted, key_last4, key_fingerprint)
      VALUES (${p.id}, 'catalog', 'no entry', 'enc:x', 'x', 'x')`)))
      .rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('enforces one compat (anthropic_byok|catalog) connection per partner during W02–W03 (23505)', async () => {
    const p = await createPartner();
    await seedByokConnection(p.id);
    await expect(seedByokConnection(p.id)).rejects.toMatchObject({ code: '23505' });
  });
});

describe.skipIf(!RUN)('partner_ai_models (#7600 W02)', () => {
  it('an offering cannot point at another partner\'s connection (23503 composite FK)', async () => {
    const [a, b] = [await createPartner(), await createPartner()];
    const connB = await seedByokConnection(b.id);
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO partner_ai_models (partner_id, connection_id, model_id, source)
      VALUES (${a.id}, ${connB}, 'claude-sonnet-5-5', 'manual')`)))
      .rejects.toMatchObject({ cause: { code: '23503', constraint_name: 'partner_ai_models_connection_fk' } });
  });

  it('partner A cannot INSERT an offering for partner B (42501)', async () => {
    const [a, b] = [await createPartner(), await createPartner()];
    const platformModelId = await seedPlatformModel();
    await expect(withDbAccessContext(partnerContext(a.id), () => db.execute(sql`
      INSERT INTO partner_ai_models (partner_id, platform_model_id, source)
      VALUES (${b.id}, ${platformModelId}, 'platform')`)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it.each([
    ['a connection offering claiming source platform', (p: string, c: string, pm: string) => sql`
      INSERT INTO partner_ai_models (partner_id, connection_id, platform_model_id, source) VALUES (${p}, ${c}, ${pm}, 'platform')`],
    ['a platform offering with a copied price', (p: string, _c: string, pm: string) => sql`
      INSERT INTO partner_ai_models (partner_id, platform_model_id, source, price_input_cents_per_m, price_output_cents_per_m, price_cache_read_cents_per_m, price_cache_write_cents_per_m)
      VALUES (${p}, ${pm}, 'platform', 1, 1, 1, 1)`],
    ['a platform offering with a wire id', (p: string, _c: string, pm: string) => sql`
      INSERT INTO partner_ai_models (partner_id, platform_model_id, model_id, source) VALUES (${p}, ${pm}, 'claude-x', 'platform')`],
    ['a connection offering without a model id', (p: string, c: string) => sql`
      INSERT INTO partner_ai_models (partner_id, connection_id, source) VALUES (${p}, ${c}, 'manual')`],
    ['a partial price', (p: string, c: string) => sql`
      INSERT INTO partner_ai_models (partner_id, connection_id, model_id, source, price_input_cents_per_m) VALUES (${p}, ${c}, 'm', 'manual', 1)`],
    ['a catalog offering with a price', (p: string, c: string) => sql`
      INSERT INTO partner_ai_models (partner_id, connection_id, model_id, source, price_input_cents_per_m, price_output_cents_per_m, price_cache_read_cents_per_m, price_cache_write_cents_per_m)
      VALUES (${p}, ${c}, 'claude-x', 'catalog', 1, 1, 1, 1)`],
  ])('rejects %s (23514)', async (_label, statement) => {
    const p = await createPartner();
    const c = await seedByokConnection(p.id);
    const pm = await seedPlatformModel();
    await expect(withSystemDbAccessContext(() => db.execute(statement(p.id, c, pm))))
      .rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('a refusal fallback must belong to the same partner (23503) and sit on the same connection (23514)', async () => {
    const [a, b] = [await createPartner(), await createPartner()];
    const connA = await seedByokConnection(a.id);
    const byokA = await seedOffering({ partnerId: a.id, connectionId: connA, modelId: 'claude-opus-5-5' });
    const platformA = await seedOffering({ partnerId: a.id, platformModelId: await seedPlatformModel() });
    const platformB = await seedOffering({ partnerId: b.id, platformModelId: await seedPlatformModel() });

    await expect(withSystemDbAccessContext(() => db.execute(sql`
      UPDATE partner_ai_models SET refusal_fallback_offering_id = ${platformB} WHERE id = ${byokA}`)))
      .rejects.toMatchObject({ cause: { code: '23503' } });
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      UPDATE partner_ai_models SET refusal_fallback_offering_id = ${platformA} WHERE id = ${byokA}`)))
      .rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      UPDATE partner_ai_models SET refusal_fallback_offering_id = ${byokA} WHERE id = ${byokA}`)))
      .rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('rejects a fallback forward-referenced within one multi-row INSERT (fail-closed, 23503)', async () => {
    const p = await createPartner();
    const conn = await seedByokConnection(p.id);
    const pm = await seedPlatformModel();
    const [byokId, platformId] = [randomUUID(), randomUUID()];
    // Row 1 (BYOK) names row 2 (platform) as its fallback: different connections.
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO partner_ai_models (id, partner_id, connection_id, model_id, source, refusal_fallback_offering_id, platform_model_id)
      VALUES (${byokId}, ${p.id}, ${conn}, 'claude-opus-5-5', 'manual', ${platformId}, NULL),
             (${platformId}, ${p.id}, NULL, NULL, 'platform', NULL, ${pm})`)))
      .rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('id and partner_id are immutable (23514), so an offering can never move partners under an assignment array', async () => {
    const [p, q] = [await createPartner(), await createPartner()];
    const off = await seedOffering({ partnerId: p.id, platformModelId: await seedPlatformModel() });
    await expect(withSystemDbAccessContext(() => db.execute(sql`UPDATE partner_ai_models SET partner_id = ${q.id} WHERE id = ${off}`)))
      .rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(withSystemDbAccessContext(() => db.execute(sql`UPDATE partner_ai_models SET id = ${randomUUID()} WHERE id = ${off}`)))
      .rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('connection_id is immutable (23514)', async () => {
    const p = await createPartner();
    const c = await seedByokConnection(p.id);
    const offering = await seedOffering({ partnerId: p.id, connectionId: c, modelId: 'claude-haiku-4-5' });
    const pm = await seedPlatformModel();
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      UPDATE partner_ai_models SET connection_id = NULL, source = 'platform', model_id = NULL,
             platform_model_id = ${pm} WHERE id = ${offering}`)))
      .rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('an org token reads only ENABLED offerings of its own partner and can modify none', async () => {
    const [p, q] = [await createPartner(), await createPartner()];
    const org = await createOrganization({ partnerId: p.id });
    const enabledP = await seedOffering({ partnerId: p.id, platformModelId: await seedPlatformModel(), enabled: true });
    await seedOffering({ partnerId: p.id, platformModelId: await seedPlatformModel(), enabled: false });
    await seedOffering({ partnerId: q.id, platformModelId: await seedPlatformModel(), enabled: true });

    const visible = await withDbAccessContext(orgContext(org.id, p.id), () =>
      db.execute(sql`SELECT id FROM partner_ai_models ORDER BY id`));
    expect([...visible].map((r) => (r as { id: string }).id)).toEqual([enabledP]);

    const updated = await withDbAccessContext(orgContext(org.id, p.id), () =>
      db.execute(sql`UPDATE partner_ai_models SET enabled = false WHERE id = ${enabledP} RETURNING id`));
    expect([...updated]).toEqual([]);
  });

  it('deleting a connection cascades its offerings', async () => {
    const p = await createPartner();
    const c = await seedByokConnection(p.id);
    await seedOffering({ partnerId: p.id, connectionId: c, modelId: 'claude-sonnet-5-5' });
    await adminSql`DELETE FROM partner_ai_connections WHERE id = ${c}`;
    const [left] = await adminSql`SELECT count(*)::int AS n FROM partner_ai_models WHERE connection_id = ${c}`;
    expect(left!.n).toBe(0);
  });
});

describe.skipIf(!RUN)('ai_sessions / ai_agents offering bindings (#7600 W02)', () => {
  async function twoPartners() {
    const [a, b] = [await createPartner(), await createPartner()];
    const [orgA, orgB] = [await createOrganization({ partnerId: a.id }), await createOrganization({ partnerId: b.id })];
    const offA = await seedOffering({ partnerId: a.id, platformModelId: await seedPlatformModel() });
    const offB = await seedOffering({ partnerId: b.id, platformModelId: await seedPlatformModel() });
    return { a, b, orgA, orgB, offA, offB };
  }
  async function seedSession(orgId: string): Promise<string> {
    const [row] = await adminSql`INSERT INTO ai_sessions (org_id, model) VALUES (${orgId}, 'claude-sonnet-5-5') RETURNING id`;
    return String(row!.id);
  }

  it('a session cannot bind another partner\'s offering (23503 on either composite FK)', async () => {
    const t = await twoPartners();
    const s = await seedSession(t.orgA.id);
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      UPDATE ai_sessions SET offering_id = ${t.offB}, offering_partner_id = ${t.b.id} WHERE id = ${s}`)))
      .rejects.toMatchObject({ cause: { code: '23503', constraint_name: 'ai_sessions_offering_org_partner_fk' } });
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      UPDATE ai_sessions SET offering_id = ${t.offB}, offering_partner_id = ${t.a.id} WHERE id = ${s}`)))
      .rejects.toMatchObject({ cause: { code: '23503', constraint_name: 'ai_sessions_offering_fk' } });
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      UPDATE ai_sessions SET offering_id = ${t.offA} WHERE id = ${s}`)))
      .rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('a cross-partner org change (device move) clears the session offering instead of aborting', async () => {
    const t = await twoPartners();
    const s = await seedSession(t.orgA.id);
    await adminSql`UPDATE ai_sessions SET offering_id = ${t.offA}, offering_partner_id = ${t.a.id}, options = '{"effort":"high"}' WHERE id = ${s}`;
    await withSystemDbAccessContext(() => db.execute(sql`UPDATE ai_sessions SET org_id = ${t.orgB.id} WHERE id = ${s}`));
    const [row] = await adminSql`SELECT org_id, offering_id, offering_partner_id, options FROM ai_sessions WHERE id = ${s}`;
    expect(row).toMatchObject({ org_id: t.orgB.id, offering_id: null, offering_partner_id: null, options: null });
  });

  it('a real cross-partner device move re-stamps the device-bound session through the cascade trigger and clears its offering', async () => {
    const t = await twoPartners();
    const [siteA, siteB] = [await createSite({ orgId: t.orgA.id }), await createSite({ orgId: t.orgB.id })];
    const [device] = await adminSql`
      INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version, status)
      VALUES (${t.orgA.id}, ${siteA!.id}, ${`w02-move-${randomUUID()}`}, 'w02-move-host', 'linux', '22.04', 'x86_64', '0.0.0-test', 'offline')
      RETURNING id`;
    const [session] = await adminSql`
      INSERT INTO ai_sessions (org_id, device_id, model, offering_id, offering_partner_id, options)
      VALUES (${t.orgA.id}, ${device!.id}, 'claude-sonnet-5-5', ${t.offA}, ${t.a.id}, '{"effort":"high"}')
      RETURNING id`;
    await withSystemDbAccessContext(() => db.execute(sql`
      UPDATE devices SET org_id = ${t.orgB.id}, site_id = ${siteB!.id} WHERE id = ${device!.id}`));
    const [row] = await adminSql`SELECT org_id, offering_id, offering_partner_id, options FROM ai_sessions WHERE id = ${session!.id}`;
    expect(row).toMatchObject({ org_id: t.orgB.id, offering_id: null, offering_partner_id: null, options: null });
  });

  it('a same-partner org change keeps the binding', async () => {
    const t = await twoPartners();
    const orgA2 = await createOrganization({ partnerId: t.a.id });
    const s = await seedSession(t.orgA.id);
    await adminSql`UPDATE ai_sessions SET offering_id = ${t.offA}, offering_partner_id = ${t.a.id} WHERE id = ${s}`;
    await withSystemDbAccessContext(() => db.execute(sql`UPDATE ai_sessions SET org_id = ${orgA2.id} WHERE id = ${s}`));
    const [row] = await adminSql`SELECT offering_id FROM ai_sessions WHERE id = ${s}`;
    expect(row!.offering_id).toBe(t.offA);
  });

  it('removing a connection unbinds sessions on its offerings (ON DELETE SET NULL)', async () => {
    const p = await createPartner();
    const org = await createOrganization({ partnerId: p.id });
    const conn = await seedByokConnection(p.id);
    const off = await seedOffering({ partnerId: p.id, connectionId: conn, modelId: 'claude-sonnet-5-5' });
    const s = await seedSession(org.id);
    await adminSql`UPDATE ai_sessions SET offering_id = ${off}, offering_partner_id = ${p.id} WHERE id = ${s}`;
    await adminSql`DELETE FROM partner_ai_connections WHERE id = ${conn}`;
    const [row] = await adminSql`SELECT offering_id, offering_partner_id FROM ai_sessions WHERE id = ${s}`;
    expect(row).toMatchObject({ offering_id: null, offering_partner_id: null });
  });

  it('an agent policy cannot bind another partner\'s offering (23514 partner row, 23503 org row)', async () => {
    const t = await twoPartners();
    const user = await createUser({ partnerId: t.a.id });
    const partnerAgent = await seedAgent({ partnerId: t.a.id, createdBy: user.id });
    const orgAgent = await seedAgent({ orgId: t.orgA.id, createdBy: user.id });
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      UPDATE ai_agents SET offering_id = ${t.offB}, offering_partner_id = ${t.b.id} WHERE id = ${partnerAgent}`)))
      .rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      UPDATE ai_agents SET offering_id = ${t.offB}, offering_partner_id = ${t.b.id} WHERE id = ${orgAgent}`)))
      .rejects.toMatchObject({ cause: { code: '23503', constraint_name: 'ai_agents_offering_org_partner_fk' } });
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      UPDATE ai_agents SET offering_id = ${t.offB}, offering_partner_id = ${t.a.id} WHERE id = ${orgAgent}`)))
      .rejects.toMatchObject({ cause: { code: '23503', constraint_name: 'ai_agents_offering_fk' } });
    // The legitimate binding works.
    await withSystemDbAccessContext(() => db.execute(sql`
      UPDATE ai_agents SET offering_id = ${t.offA}, offering_partner_id = ${t.a.id} WHERE id = ${partnerAgent}`));
    const [row] = await adminSql`SELECT offering_id, offering_partner_id FROM ai_agents WHERE id = ${partnerAgent}`;
    expect(row).toMatchObject({ offering_id: t.offA, offering_partner_id: t.a.id });
  });

  it.each(['ai_sessions_offering_org_partner_fk', 'ai_agents_offering_org_partner_fk'])(
    '%s is deferrable (merge contract) and validated',
    async (name) => {
      const [row] = await adminSql`SELECT condeferrable, condeferred, convalidated FROM pg_constraint WHERE conname = ${name}`;
      expect(row).toMatchObject({ condeferrable: true, condeferred: false, convalidated: true });
    },
  );
});
