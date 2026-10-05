/**
 * AI model registry W08 (#7606): the registry-native bootstrap behind
 * ensurePartnerCutover, against real Postgres.
 *  - a new partner gets one platform offering and a partner assignment per
 *    surface, exactly once (cutover row in the same transaction), and resolves;
 *  - a partner with one W02-copied BYOK connection routes every surface but
 *    patch_test through that connection (funding is kept); a soft-disconnected
 *    connection (#7700) is ignored;
 *  - rows that already exist are never overwritten; a failed bootstrap rolls
 *    back and leaves the partner un-rowed;
 *  - on self-host an unlisted ANTHROPIC_MODEL gets a platform row at the
 *    bootstrap rate; on hosted nothing is created and the operator default wins;
 *  - two concurrent gates bootstrap once;
 *  - the partner-axis cutover table refuses tenant writes (moved here from the
 *    deleted W03 cutover suite).
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { AI_SURFACES } from '@breeze/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { aiModelAssignments, aiPlatformModels, partnerAiModels } from '../../db/schema';
import { createConnection } from '../../services/aiModels/connections';
import { bootstrapPartnerRegistryInTx } from '../../services/aiModels/registryBootstrap';
import { __resetRegistryCutoverMemoForTests, cutoverPartner, ensurePartnerCutover } from '../../services/aiModels/registryCutover';
import { withPartnerCutoverTx } from '../../services/aiModels/registryCutoverStore';
import { resolveModel } from '../../services/aiModels/resolveModel';
import { closeRegistryFixtures, fixtureSql, partnerContext, seedPricedPlatformModel } from './aiModelRegistryFixtures';
import { createOrganization, createPartner } from './db-utils';

const RUN = !!process.env.DATABASE_URL;

const sys = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

const newPartner = async (): Promise<string> => (await createPartner()).id;

const partnerAssignments = (partnerId: string) => sys(() => db.select().from(aiModelAssignments)
  .where(and(eq(aiModelAssignments.partnerId, partnerId), isNull(aiModelAssignments.orgId))));

const cutoverRows = (ids: string[]) =>
  fixtureSql`SELECT partner_id FROM ai_model_registry_partner_cutover WHERE partner_id = ANY(${ids}::uuid[])`;

/** Like Postgres reports it: the wrapped cause carries the SQLSTATE. */
async function sqlstate(run: () => Promise<unknown>): Promise<string | undefined> {
  try { await run(); } catch (error) {
    const chain: unknown[] = [];
    for (let e: unknown = error; e && chain.length < 6; e = (e as { cause?: unknown }).cause) chain.push(e);
    return chain.map((e) => (e as { code?: string }).code).find((c) => typeof c === 'string');
  }
  return undefined;
}

const savedEnv = { model: process.env.ANTHROPIC_MODEL, hosted: process.env.IS_HOSTED, key: process.env.ANTHROPIC_API_KEY };
const restore = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
};

// The suite moves the global platform default; put the original back so later suites see the seeded one.
let originalDefaultId: string | null = null;
beforeAll(async () => {
  if (!RUN) return;
  const [row] = await fixtureSql`SELECT id FROM ai_platform_models WHERE is_platform_default`;
  originalDefaultId = row ? String(row.id) : null;
});
afterAll(async () => {
  if (RUN) {
    await fixtureSql`UPDATE ai_platform_models SET is_platform_default = false WHERE is_platform_default`;
    if (originalDefaultId) await fixtureSql`UPDATE ai_platform_models SET is_platform_default = true WHERE id = ${originalDefaultId}`;
  }
  await closeRegistryFixtures();
});

beforeEach(() => {
  __resetRegistryCutoverMemoForTests();
  // The platform offering's key must be usable for resolveModel to return ok.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-w08-integration-placeholder';
});
afterEach(() => {
  restore('ANTHROPIC_MODEL', savedEnv.model);
  restore('IS_HOSTED', savedEnv.hosted);
  restore('ANTHROPIC_API_KEY', savedEnv.key);
});

describe.skipIf(!RUN)('registry bootstrap (W08)', () => {
  it('a new partner: one platform offering of the default model, one partner assignment per surface, once; then it resolves', async () => {
    delete process.env.ANTHROPIC_MODEL;
    const platform = await seedPricedPlatformModel({ modelId: `w08-default-${randomUUID()}`, isPlatformDefault: true });
    const partnerId = await newPartner();
    const org = await createOrganization({ partnerId });

    expect(await ensurePartnerCutover(partnerId)).toBe(true);
    expect(await ensurePartnerCutover(partnerId)).toBe(true);
    expect(await cutoverPartner(partnerId)).toBe('already');
    expect(await cutoverRows([partnerId])).toHaveLength(1);

    const offerings = await sys(() => db.select().from(partnerAiModels).where(eq(partnerAiModels.partnerId, partnerId)));
    expect(offerings).toHaveLength(1);
    expect(offerings[0]).toMatchObject({ connectionId: null, platformModelId: platform.id, source: 'platform', enabled: true });
    const rows = await partnerAssignments(partnerId);
    expect(rows).toHaveLength(AI_SURFACES.length);
    expect(new Set(rows.map((r) => r.surface))).toEqual(new Set(AI_SURFACES));
    expect(new Set(rows.map((r) => r.defaultOfferingId))).toEqual(new Set([offerings[0]!.id]));
    expect(rows.filter((r) => r.allowUserChoice).map((r) => r.surface)).toEqual(['chat']);
    expect(rows.every((r) => r.fallbackOfferingIds === null && r.fallbackMayCrossFunding === false)).toBe(true);
    expect(rows.every((r) => r.permittedOfferingIds === null && r.options === null && r.role === 'default')).toBe(true);

    expect(await resolveModel({ partnerId, orgId: org.id, surface: 'chat' }))
      .toMatchObject({ ok: true, funding: 'platform', logicalModel: platform.modelId });
  });

  it('bootstrap of a W02-copied BYOK connection routes chat through the connection; patch_test stays on the platform', async () => {
    delete process.env.ANTHROPIC_MODEL;
    const platform = await seedPricedPlatformModel({ modelId: `w08-default-${randomUUID()}`, isPlatformDefault: true });
    const partnerId = await newPartner();
    const conn = await sys(() => createConnection({
      partnerId, kind: 'anthropic_byok', name: 'Anthropic API key', apiKey: 'sk-ant-test-0000000000', connectedBy: null, verifiedAt: null,
    }));

    expect(await ensurePartnerCutover(partnerId)).toBe(true);

    const rows = await partnerAssignments(partnerId);
    const byok = await sys(() => db.select().from(partnerAiModels).where(eq(partnerAiModels.connectionId, conn.id)));
    expect(byok).toHaveLength(1);
    expect(byok[0]).toMatchObject({ source: 'discovered', platformModelId: platform.id, modelId: platform.modelId, enabled: true });
    const [platformOffering] = await sys(() => db.select().from(partnerAiModels)
      .where(and(eq(partnerAiModels.partnerId, partnerId), isNull(partnerAiModels.connectionId))));
    expect(rows).toHaveLength(AI_SURFACES.length);
    for (const r of rows) {
      expect(r.defaultOfferingId).toBe(r.surface === 'patch_test' ? platformOffering!.id : byok[0]!.id);
    }
  });

  it('a soft-disconnected connection is ignored: the partner is bootstrapped onto the platform', async () => {
    delete process.env.ANTHROPIC_MODEL;
    const platform = await seedPricedPlatformModel({ modelId: `w08-default-${randomUUID()}`, isPlatformDefault: true });
    const partnerId = await newPartner();
    const conn = await sys(() => createConnection({
      partnerId, kind: 'anthropic_byok', name: 'Anthropic API key', apiKey: 'sk-ant-test-1111111111', connectedBy: null, verifiedAt: null,
    }));
    await fixtureSql`
      UPDATE partner_ai_connections
         SET status = 'disconnected', api_key_encrypted = NULL, key_last4 = NULL, key_fingerprint = NULL
       WHERE id = ${conn.id}`;

    expect(await ensurePartnerCutover(partnerId)).toBe(true);

    expect(await sys(() => db.select().from(partnerAiModels).where(eq(partnerAiModels.connectionId, conn.id)))).toHaveLength(0);
    const offerings = await sys(() => db.select().from(partnerAiModels).where(eq(partnerAiModels.partnerId, partnerId)));
    expect(offerings).toHaveLength(1);
    expect(offerings[0]).toMatchObject({ connectionId: null, platformModelId: platform.id });
    const rows = await partnerAssignments(partnerId);
    expect(rows.every((r) => r.defaultOfferingId === offerings[0]!.id)).toBe(true);
  });

  it('never overwrites an assignment that already exists', async () => {
    const platform = await seedPricedPlatformModel({ modelId: `w08-default-${randomUUID()}`, isPlatformDefault: true });
    const partnerId = await newPartner();
    await sys(() => db.insert(aiModelAssignments).values({
      partnerId, orgId: null, offeringPartnerId: partnerId, surface: 'chat', role: 'default',
      defaultOfferingId: null, permittedOfferingIds: null, allowUserChoice: false, options: null, fallbackOfferingIds: null, fallbackMayCrossFunding: false,
    }));
    await withPartnerCutoverTx(partnerId, async (exists) => {
      if (!exists) await bootstrapPartnerRegistryInTx(partnerId, { defaultModelId: platform.modelId });
    });
    const rows = await partnerAssignments(partnerId);
    expect(rows).toHaveLength(AI_SURFACES.length);
    expect(rows.find((r) => r.surface === 'chat')).toMatchObject({ defaultOfferingId: null, allowUserChoice: false });
  });

  it('a failure inside the bootstrap transaction rolls everything back and leaves the partner un-rowed', async () => {
    await seedPricedPlatformModel({ modelId: `w08-default-${randomUUID()}`, isPlatformDefault: true });
    const partnerId = await newPartner();
    await expect(cutoverPartner(partnerId, {
      bootstrapInTx: async (id) => {
        await bootstrapPartnerRegistryInTx(id);
        throw new Error('fail after bootstrapping');
      },
    })).rejects.toThrow('fail after bootstrapping');
    expect(await cutoverRows([partnerId])).toHaveLength(0);
    expect(await fixtureSql`SELECT 1 FROM partner_ai_models WHERE partner_id = ${partnerId}`).toHaveLength(0);
    expect(await fixtureSql`SELECT 1 FROM ai_model_assignments WHERE partner_id = ${partnerId}`).toHaveLength(0);
  });

  it('self-host: an unlisted ANTHROPIC_MODEL gets a platform row at the bootstrap rate; hosted creates nothing', async () => {
    const selfHosted = `w08-vllm-${randomUUID()}`;
    process.env.ANTHROPIC_MODEL = selfHosted;
    const p1 = await newPartner();
    await withPartnerCutoverTx(p1, async () => { await bootstrapPartnerRegistryInTx(p1, { hosted: false }); });
    const [row] = await sys(() => db.select().from(aiPlatformModels).where(eq(aiPlatformModels.modelId, selfHosted)));
    expect(row).toMatchObject({ platformOffered: true, isPlatformDefault: false });
    expect(Number(row!.inputCentsPerM)).toBe(500);
    expect(Number(row!.outputCentsPerM)).toBe(2500);
    expect(Number(row!.cacheReadCentsPerM)).toBe(50);
    expect(Number(row!.cacheWriteCentsPerM)).toBe(625);
    const [selfHostedOffering] = await sys(() => db.select().from(partnerAiModels).where(eq(partnerAiModels.partnerId, p1)));
    expect(selfHostedOffering).toMatchObject({ platformModelId: row!.id });

    // Hosted: the env never overrides the operator default and never creates a row.
    const hostedDefault = await seedPricedPlatformModel({ isPlatformDefault: true });
    const hostedModel = `w08-hosted-${randomUUID()}`;
    process.env.ANTHROPIC_MODEL = hostedModel;
    const p2 = await newPartner();
    await withPartnerCutoverTx(p2, async () => { await bootstrapPartnerRegistryInTx(p2, { hosted: true }); });
    expect(await sys(() => db.select().from(aiPlatformModels).where(eq(aiPlatformModels.modelId, hostedModel)))).toHaveLength(0);
    const hostedOfferings = await sys(() => db.select().from(partnerAiModels).where(eq(partnerAiModels.partnerId, p2)));
    expect(hostedOfferings).toHaveLength(1);
    expect(hostedOfferings[0]).toMatchObject({ platformModelId: hostedDefault.id });
  });

  it('two concurrent gates bootstrap once', async () => {
    await seedPricedPlatformModel({ modelId: `w08-default-${randomUUID()}`, isPlatformDefault: true });
    const partnerId = await newPartner();
    const [a, b] = await Promise.all([ensurePartnerCutover(partnerId), ensurePartnerCutover(partnerId)]);
    expect(a && b).toBe(true);
    expect(await partnerAssignments(partnerId)).toHaveLength(AI_SURFACES.length);
    expect(await sys(() => db.select().from(partnerAiModels).where(eq(partnerAiModels.partnerId, partnerId)))).toHaveLength(1);
  });
});

describe.skipIf(!RUN)('ai_model_registry_partner_cutover RLS (shape 3)', () => {
  it('a partner context cannot write a cutover row (cross-partner or its own), and reads only its own', async () => {
    const a = await createPartner();
    const b = await createPartner();
    await fixtureSql`INSERT INTO ai_model_registry_partner_cutover (partner_id) VALUES (${b.id})`;

    expect(await sqlstate(() => withDbAccessContext(partnerContext(a.id), () =>
      db.execute(sql`INSERT INTO ai_model_registry_partner_cutover (partner_id) VALUES (${b.id}::uuid)`)))).toBe('42501');
    expect(await sqlstate(() => withDbAccessContext(partnerContext(a.id), () =>
      db.execute(sql`INSERT INTO ai_model_registry_partner_cutover (partner_id) VALUES (${a.id}::uuid)`)))).toBe('42501');

    const seenByA = await withDbAccessContext(partnerContext(a.id), () =>
      db.execute(sql`SELECT partner_id FROM ai_model_registry_partner_cutover WHERE partner_id IN (${a.id}::uuid, ${b.id}::uuid)`));
    expect(seenByA).toHaveLength(0);
    const seenByB = await withDbAccessContext(partnerContext(b.id), () =>
      db.execute(sql`SELECT partner_id FROM ai_model_registry_partner_cutover WHERE partner_id IN (${a.id}::uuid, ${b.id}::uuid)`));
    expect(seenByB).toHaveLength(1);

    // Writes are system-only: a partner can neither delete nor rewrite its OWN
    // row (deleting it would re-bootstrap the partner).
    const deletedByB = await withDbAccessContext(partnerContext(b.id), () =>
      db.execute(sql`DELETE FROM ai_model_registry_partner_cutover WHERE partner_id = ${b.id}::uuid RETURNING partner_id`));
    expect(deletedByB).toHaveLength(0);
    const updatedByB = await withDbAccessContext(partnerContext(b.id), () =>
      db.execute(sql`UPDATE ai_model_registry_partner_cutover SET cutover_at = now() WHERE partner_id = ${b.id}::uuid RETURNING partner_id`))
      .catch(() => []);
    expect(updatedByB).toHaveLength(0);
    expect(await cutoverRows([b.id])).toHaveLength(1);
  });

  it('deleting the partner removes its cutover row (FK ON DELETE CASCADE)', async () => {
    const p = await createPartner();
    await fixtureSql`INSERT INTO ai_model_registry_partner_cutover (partner_id) VALUES (${p.id})`;
    await fixtureSql`DELETE FROM partners WHERE id = ${p.id}`;
    expect(await cutoverRows([p.id])).toHaveLength(0);
  });
});
