/**
 * W03 Task 6A (#7601) against real Postgres and W02's real reconcile: the
 * per-partner cutover happens exactly once, durably, under a single
 * coordinator; a sweep resumes after interruption; a request cuts its partner
 * over on demand; completion is monotonic; offerings the projection no longer
 * produces are disabled in the cutover transaction; the partner-axis cutover
 * table refuses tenant writes.
 */
import './setup';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { getLegacyModelRates } from '../../services/aiModels/legacySurfaceModels';
import type { LegacyProjectionEnv } from '../../services/aiModels/legacyProjection';
import { reconcilePartnerFromLegacy, reconcilePartnerFromLegacyInTx } from '../../services/aiModels/legacyReconcile';
import { resolveModel } from '../../services/aiModels/resolveModel';
import {
  __resetRegistryCutoverMemoForTests, cutoverPartner, runRegistryCutoverSweep, type PartnerCutoverResult,
} from '../../services/aiModels/registryCutover';
import { closeRegistryFixtures, fixtureSql, partnerContext, seedOffering } from './aiModelRegistryFixtures';
import { seedPricedPlatformModel } from './helpers/aiModelRegistrySeed';
import { createOrganization, createPartner } from './db-utils';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

// The platform offering's key must be usable for resolveModel to return ok.
const savedKey = process.env.ANTHROPIC_API_KEY;
beforeEach(() => { process.env.ANTHROPIC_API_KEY = 'sk-ant-w03-integration-placeholder'; });
afterEach(() => { if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey; });

const resetState = () => fixtureSql`
  UPDATE ai_model_registry_state SET cutover_completed_at = NULL, lease_owner = NULL, lease_expires_at = NULL WHERE id = 1`;
const completedAt = async () =>
  (await fixtureSql`SELECT cutover_completed_at AS c FROM ai_model_registry_state WHERE id = 1`)[0]!.c as Date | null;
const cutoverRows = async (ids: string[]) =>
  fixtureSql`SELECT partner_id FROM ai_model_registry_partner_cutover WHERE partner_id = ANY(${ids}::uuid[])`;

/** A projection env whose every deployment default is `modelId`. */
const envFor = (modelId: string): LegacyProjectionEnv => ({
  defaultModel: modelId, reviewerModel: modelId, extensionModel: modelId,
  legacyRates: (m) => getLegacyModelRates(m).rates,
});

/** Like Postgres reports it: the wrapped cause carries the SQLSTATE. */
async function sqlstate(run: () => Promise<unknown>): Promise<string | undefined> {
  try { await run(); } catch (error) {
    const chain: unknown[] = [];
    for (let e: unknown = error; e && chain.length < 6; e = (e as { cause?: unknown }).cause) chain.push(e);
    return chain.map((e) => (e as { code?: string }).code).find((c) => typeof c === 'string');
  }
  return undefined;
}

describe.skipIf(!RUN)('registry cutover (findings 7, 8, 10)', () => {
  it('two concurrent sweeps: exactly one coordinates; every partner is cut over exactly once', async () => {
    await resetState();
    __resetRegistryCutoverMemoForTests();
    const ps = await Promise.all(Array.from({ length: 30 }, () => createPartner()));
    const results: PartnerCutoverResult[] = [];
    const spy = vi.fn(async (id: string) => { const r = await cutoverPartner(id); results.push(r); return r; });
    const [a, b] = await Promise.all([
      runRegistryCutoverSweep({ owner: 'A', deps: { cutover: spy } }),
      runRegistryCutoverSweep({ owner: 'B', deps: { cutover: spy } }),
    ]);
    expect([a.outcome, b.outcome].sort()).toEqual(['complete', 'not_coordinator']);
    expect(results.filter((r) => r === 'done')).toHaveLength(30);
    expect(await cutoverRows(ps.map((p) => p.id))).toHaveLength(30);
    expect(await completedAt()).not.toBeNull();
  });

  it('an interrupted sweep resumes where it stopped (the anti-join is the cursor)', async () => {
    await resetState();
    const ps = await Promise.all(Array.from({ length: 10 }, () => createPartner()));
    let calls = 0;
    const flaky = vi.fn(async (id: string) => { calls += 1; if (calls === 4) throw new Error('crash'); return cutoverPartner(id); });
    const first = await runRegistryCutoverSweep({ owner: 'A', deps: { cutover: flaky } });
    expect(first).toMatchObject({ outcome: 'incomplete', processed: 9 });
    expect(first.failed).toHaveLength(1);
    expect(await cutoverRows(ps.map((p) => p.id))).toHaveLength(9);
    expect(await completedAt()).toBeNull();

    // The failed sweep released its lease: a second owner takes over at once.
    const spy = vi.fn(cutoverPartner);
    const second = await runRegistryCutoverSweep({ owner: 'B', deps: { cutover: spy } });
    expect(second).toMatchObject({ outcome: 'complete', processed: 1, failed: [] });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(first.failed[0]);
    expect(await cutoverRows(ps.map((p) => p.id))).toHaveLength(10);
    expect(await completedAt()).not.toBeNull();
  });

  it('a request for a partner the sweep has not reached cuts it over on demand, then resolves', async () => {
    __resetRegistryCutoverMemoForTests();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    expect(await cutoverRows([partner.id])).toHaveLength(0);
    expect(await resolveModel({ partnerId: partner.id, orgId: org.id, surface: 'chat' })).toMatchObject({ ok: true });
    expect(await cutoverRows([partner.id])).toHaveLength(1);
    // Never projected again: a second cutover is a no-op.
    expect(await cutoverPartner(partner.id)).toBe('already');
  });

  it('completion is monotonic: a later sweep never clears or moves it', async () => {
    await resetState();
    await createPartner();
    expect((await runRegistryCutoverSweep({ owner: 'A' })).outcome).toBe('complete');
    const before = await completedAt();
    expect(before).not.toBeNull();
    // New un-cut partner + a failing cutover: the completed stamp short-circuits the sweep entirely.
    await createPartner();
    const failing = vi.fn(async () => { throw new Error('x'); });
    expect((await runRegistryCutoverSweep({ owner: 'B', deps: { cutover: failing } })).outcome).toBe('complete');
    expect(failing).not.toHaveBeenCalled();
    expect(await completedAt()).toEqual(before);
  });

  it('a failure inside the cutover transaction rolls the projection back and leaves the partner un-rowed', async () => {
    const partner = await createPartner();
    const modelId = `w03-cutover-${crypto.randomUUID()}`;
    await seedPricedPlatformModel(modelId);
    await expect(cutoverPartner(partner.id, {
      reconcileInTx: async (id) => {
        await reconcilePartnerFromLegacyInTx(id, envFor(modelId));
        throw new Error('fail after projecting');
      },
    })).rejects.toThrow('fail after projecting');
    expect(await cutoverRows([partner.id])).toHaveLength(0);
    expect(await fixtureSql`SELECT 1 FROM partner_ai_models WHERE partner_id = ${partner.id}`).toHaveLength(0);
    expect(await fixtureSql`SELECT 1 FROM ai_model_assignments WHERE partner_id = ${partner.id}`).toHaveLength(0);
  });
});

describe.skipIf(!RUN)('stale enabled offerings are disabled at cutover (W02 handoff)', () => {
  it('a default-model change leaves the old projection\'s offerings enabled under W02; the cutover disables them and keeps the produced set', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const oldModel = `w03-old-${crypto.randomUUID()}`;
    const newModel = `w03-new-${crypto.randomUUID()}`;
    const strayModel = `w03-stray-${crypto.randomUUID()}`;
    await seedPricedPlatformModel(oldModel);
    await seedPricedPlatformModel(newModel);
    const strayPlatformId = await seedPricedPlatformModel(strayModel);

    // W02's boot re-projection under the OLD default, plus a stray enabled leftover.
    await reconcilePartnerFromLegacy(partner.id, envFor(oldModel));
    const strayId = await seedOffering({ partnerId: partner.id, platformModelId: strayPlatformId, enabled: true });
    // An already-disabled offering stays exactly as it is (not re-touched).
    await fixtureSql`UPDATE partner_ai_models SET enabled = false, updated_at = '2020-01-01' WHERE id = ${strayId}`;
    const alreadyOff = strayId;
    const liveStrayId = await seedOffering({
      partnerId: partner.id, platformModelId: (await seedPricedPlatformModel()), enabled: true,
    });

    expect(await cutoverPartner(partner.id, {
      reconcileInTx: (id) => reconcilePartnerFromLegacyInTx(id, envFor(newModel)),
    })).toBe('done');

    const rows = await fixtureSql`
      SELECT o.id, o.enabled, o.updated_at, p.model_id FROM partner_ai_models o
        JOIN ai_platform_models p ON p.id = o.platform_model_id
       WHERE o.partner_id = ${partner.id}`;
    const byModel = (m: string) => rows.filter((r) => r.model_id === m);
    expect(byModel(newModel).map((r) => r.enabled)).toEqual([true]);       // produced: untouched, enabled
    expect(byModel(oldModel).map((r) => r.enabled)).toEqual([false]);      // previous projection: disabled
    expect(rows.find((r) => r.id === liveStrayId)!.enabled).toBe(false);   // stray leftover: disabled
    const off = rows.find((r) => r.id === alreadyOff)!;
    expect(off.enabled).toBe(false);
    expect(new Date(off.updated_at as string).getTime()).toBeLessThan(Date.parse('2021-01-01T00:00:00Z'));   // not re-touched
    expect(rows).toHaveLength(4);                                          // disabled, never deleted

    // Nothing that routes references a disabled offering.
    const dangling = await fixtureSql`
      SELECT a.id FROM ai_model_assignments a
        JOIN partner_ai_models o ON o.id = a.default_offering_id OR o.id = ANY(coalesce(a.permitted_offering_ids, '{}'::uuid[]))
       WHERE a.offering_partner_id = ${partner.id} AND o.enabled = false`;
    expect(dangling).toHaveLength(0);
    expect(await resolveModel({ partnerId: partner.id, orgId: org.id, surface: 'chat' }))
      .toMatchObject({ ok: true, logicalModel: newModel });
  });
});

describe.skipIf(!RUN)('self-hosted env model with no platform row keeps AI after cutover (#7601 gap A)', () => {
  it('the env-bootstrapped platform row is offered and priced at the legacy rate; tool surfaces resolve it on the platform', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const gatewayModel = `w03-selfhost-gw-${crypto.randomUUID()}`;
    expect(await cutoverPartner(partner.id, {
      reconcileInTx: (id) => reconcilePartnerFromLegacyInTx(id, envFor(gatewayModel)),
    })).toBe('done');

    const legacy = getLegacyModelRates(gatewayModel);
    expect(legacy.source).toBe('default_pricing');   // legacy billed an unknown id at the default rate
    const [row] = await fixtureSql`
      SELECT platform_offered, input_cents_per_m::float8 AS input_cents_per_m, output_cents_per_m::float8 AS output_cents_per_m,
             cache_read_cents_per_m::float8 AS cache_read_cents_per_m, cache_write_cents_per_m::float8 AS cache_write_cents_per_m, capabilities
        FROM ai_platform_models WHERE model_id = ${gatewayModel}`;
    expect(row).toEqual({
      platform_offered: true,
      input_cents_per_m: legacy.rates.inputCentsPerM, output_cents_per_m: legacy.rates.outputCentsPerM,
      cache_read_cents_per_m: legacy.rates.cacheReadCentsPerM, cache_write_cents_per_m: legacy.rates.cacheWriteCentsPerM,
      capabilities: null,
    });
    for (const surface of ['chat', 'helper', 'script_builder', 'office_chat'] as const) {
      expect(await resolveModel({ partnerId: partner.id, orgId: org.id, surface })).toMatchObject({
        ok: true, funding: 'platform', logicalModel: gatewayModel, wireModel: gatewayModel,
        rateSnapshot: { source: 'platform', standard: legacy.rates },
      });
    }
  });

  it('an existing platform row is never re-priced or re-offered by the bootstrap', async () => {
    const partner = await createPartner();
    const modelId = `w03-existing-${crypto.randomUUID()}`;
    await fixtureSql`INSERT INTO ai_platform_models (provider, model_id, display_name, platform_offered, is_platform_default, lifecycle)
                     VALUES ('anthropic', ${modelId}, ${modelId}, false, false, 'available')`;
    expect(await cutoverPartner(partner.id, {
      reconcileInTx: (id) => reconcilePartnerFromLegacyInTx(id, envFor(modelId)),
    })).toBe('done');
    const [row] = await fixtureSql`SELECT platform_offered, input_cents_per_m FROM ai_platform_models WHERE model_id = ${modelId}`;
    expect(row).toEqual({ platform_offered: false, input_cents_per_m: null });
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
    // cutover row (deleting it would re-project the partner from legacy).
    const deletedByB = await withDbAccessContext(partnerContext(b.id), () =>
      db.execute(sql`DELETE FROM ai_model_registry_partner_cutover WHERE partner_id = ${b.id}::uuid RETURNING partner_id`));
    expect(deletedByB).toHaveLength(0);
    const updatedByB = await withDbAccessContext(partnerContext(b.id), () =>
      db.execute(sql`UPDATE ai_model_registry_partner_cutover SET cutover_at = now() WHERE partner_id = ${b.id}::uuid RETURNING partner_id`))
      .catch(() => []);
    expect(updatedByB).toHaveLength(0);
    expect(await cutoverRows([b.id])).toHaveLength(1);

    // The singleton is system-only: a partner context sees and updates nothing.
    const leased = await withDbAccessContext(partnerContext(a.id), () =>
      db.execute(sql`UPDATE ai_model_registry_state SET lease_owner = 'tenant' WHERE id = 1 RETURNING id`));
    expect(leased).toHaveLength(0);
    expect(await withSystemDbAccessContext(() => db.execute(sql`SELECT 1 FROM ai_model_registry_state WHERE id = 1`))).toHaveLength(1);
  });

  it('deleting the partner removes its cutover row (FK ON DELETE CASCADE)', async () => {
    const p = await createPartner();
    await fixtureSql`INSERT INTO ai_model_registry_partner_cutover (partner_id) VALUES (${p.id})`;
    await fixtureSql`DELETE FROM partners WHERE id = ${p.id}`;
    expect(await cutoverRows([p.id])).toHaveLength(0);
  });
});
