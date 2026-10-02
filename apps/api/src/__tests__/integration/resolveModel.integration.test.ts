/**
 * AI model registry W03 (#7601): the candidate loader against real rows.
 * The resolver half (Task 3) runs resolveModel end to end on the same seeds.
 */
import './setup';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activateRevision } from '../../services/llmProviderCatalog';
import { findOfferingIdByModel, loadOfferingCandidate } from '../../services/aiModels/candidateLoader';
import { resolveModel } from '../../services/aiModels/resolveModel';
import { chooseSessionModel, InvalidSessionModelError } from '../../services/aiModels/sessionModel';
import { closeRegistryFixtures, fixtureSql, seedOffering } from './aiModelRegistryFixtures';
import { seedCatalogRevision, seedPricedPlatformModel, seedRegistryPartner } from './helpers/aiModelRegistrySeed';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

describe.skipIf(!RUN)('candidate loader against real rows', () => {
  it('an offering owned by partner B is invisible when resolving for partner A', async () => {
    const a = await seedRegistryPartner('platform');
    const b = await seedRegistryPartner('byok');
    const offeringOfB = await seedOffering({ partnerId: b.partnerId, platformModelId: a.platformModelId, enabled: true });
    await expect(loadOfferingCandidate(offeringOfB, a.partnerId)).resolves.toBeNull();
    await expect(loadOfferingCandidate(b.offeringId, a.partnerId)).resolves.toBeNull();
  });

  it('un-offering the platform row takes effect on the very next load (quorum #2)', async () => {
    const a = await seedRegistryPartner('platform');
    expect((await loadOfferingCandidate(a.offeringId, a.partnerId))!.facts.platform?.platformOffered).toBe(true);
    await fixtureSql`UPDATE ai_platform_models SET platform_offered = false WHERE id = ${a.platformModelId}`;
    expect((await loadOfferingCandidate(a.offeringId, a.partnerId))!.facts.platform?.platformOffered).toBe(false);
  });

  it('a seeded platform row (option_support.inferenceGeo []) serves the platform key\'s geos (W01 D3)', async () => {
    const a = await seedRegistryPartner('platform');
    const c = (await loadOfferingCandidate(a.offeringId, a.partnerId))!;
    expect(c.facts.supportedInferenceGeos).toEqual(['us', 'global']);
    expect(c.optionSupport.inferenceGeo).toEqual(['us', 'global']);
  });

  it('BYOK key decrypts live into a partner config; status error → connection unusable on the very next load', async () => {
    const b = await seedRegistryPartner('byok');
    const ok = (await loadOfferingCandidate(b.offeringId, b.partnerId))!;
    expect(ok.facts.connection).toEqual({ kind: 'anthropic_byok', status: 'active', keyUsable: true });
    expect(ok.connection?.config).toMatchObject({ source: 'partner', configId: b.connectionId, endpoint: { kind: 'anthropic' } });
    expect(ok.facts.rate?.source).toBe('linked_platform');
    await fixtureSql`UPDATE partner_ai_connections SET status = 'error' WHERE id = ${b.connectionId}`;
    expect((await loadOfferingCandidate(b.offeringId, b.partnerId))!.facts.connection.status).toBe('error');
  });

  it('catalog revision rotated to drop the model → catalog unusable on the very next load (quorum #7)', async () => {
    const c = await seedRegistryPartner('catalog');
    const first = (await loadOfferingCandidate(c.offeringId, c.partnerId))!;
    expect(first.facts.catalog).toEqual({ usable: true });
    expect(first.wireModel).toBe(`gw/${c.modelId}`);
    expect(first.facts.rate?.source).toBe('catalog');
    const otherModel = `w03-other-${Date.now()}`;
    await seedPricedPlatformModel(otherModel);   // catalog model maps must key registry models
    const revisionId = await seedCatalogRevision(c.catalogEntryId!, [otherModel], c.userId);
    await activateRevision({ entryId: c.catalogEntryId!, revisionId });
    const after = (await loadOfferingCandidate(c.offeringId, c.partnerId))!;
    expect(after.facts.catalog).toEqual({ usable: false });
    expect(after.connection).toBeNull();
  });

  it('a legacy model id present on BOTH platform and BYOK maps to the surface default\'s connection only (finding 11)', async () => {
    const b = await seedRegistryPartner('byok');            // BYOK offering for modelId is every surface's default
    const platformTwin = await seedOffering({ partnerId: b.partnerId, platformModelId: b.platformModelId, enabled: true });
    const find = () => findOfferingIdByModel({ partnerId: b.partnerId, orgId: b.orgId, surface: 'chat', modelId: b.modelId });
    expect(await find()).toBe(b.offeringId);
    await fixtureSql`
      UPDATE ai_model_assignments SET default_offering_id = ${platformTwin}
       WHERE partner_id = ${b.partnerId} AND org_id IS NULL AND surface = 'chat' AND role = 'default'`;
    expect(await find()).toBe(platformTwin);
    expect(await findOfferingIdByModel({ partnerId: b.partnerId, orgId: b.orgId, surface: 'chat', modelId: 'claude-not-offered' })).toBeNull();
  });
});

describe.skipIf(!RUN)('resolveModel against real assignments, plans and settings', () => {
  // The platform candidate is dispatchable only with platform credentials;
  // set a placeholder so the gate under test (not "unconfigured") decides.
  const saved = { key: process.env.ANTHROPIC_API_KEY, hosted: process.env.IS_HOSTED };
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  };
  beforeEach(() => { process.env.ANTHROPIC_API_KEY = 'sk-ant-w03-integration-placeholder'; });
  afterEach(() => { restore('ANTHROPIC_API_KEY', saved.key); restore('IS_HOSTED', saved.hosted); });

  it('resolves the seeded platform default end to end (control for the refusals below)', async () => {
    const a = await seedRegistryPartner('platform');
    expect(await resolveModel({ partnerId: a.partnerId, orgId: a.orgId, userId: a.userId, surface: 'chat' }))
      .toMatchObject({
        ok: true, funding: 'platform', wireModel: a.modelId, offering: { id: a.offeringId }, fellBack: false,
        rateSnapshot: { source: 'platform', standard: { inputCentsPerM: 200, outputCentsPerM: 1000 } },
      });
  });

  it('a user cannot request another partner\'s offering', async () => {
    const a = await seedRegistryPartner('platform');
    const b = await seedRegistryPartner('byok');
    expect(await resolveModel({
      partnerId: a.partnerId, orgId: a.orgId, userId: a.userId, surface: 'chat',
      requested: { offeringId: b.offeringId, origin: 'user' },
    })).toEqual({
      ok: false, reason: 'not_permitted', recoverable: true, offeringId: b.offeringId,
      message: 'This AI model is not available here. Choose another model.',
    });
  });

  it('hosted plan below the platform row\'s min_plan → plan_required (real partners.plan)', async () => {
    const a = await seedRegistryPartner('platform');
    await fixtureSql`UPDATE ai_platform_models SET min_plan = 'enterprise' WHERE id = ${a.platformModelId}`;
    await fixtureSql`UPDATE partners SET plan = 'community' WHERE id = ${a.partnerId}`;
    process.env.IS_HOSTED = 'true';
    expect(await resolveModel({ partnerId: a.partnerId, orgId: a.orgId, surface: 'chat' }))
      .toMatchObject({ ok: false, reason: 'plan_required' });
  });

  it('residency required with no geography → residency_unavailable (fails closed, real partners.settings)', async () => {
    const a = await seedRegistryPartner('platform');
    await fixtureSql`
      UPDATE partners SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{ai}', '{"residencyRequired": true}'::jsonb)
       WHERE id = ${a.partnerId}`;
    expect(await resolveModel({ partnerId: a.partnerId, orgId: a.orgId, surface: 'chat' }))
      .toMatchObject({ ok: false, reason: 'residency_unavailable' });
  });

  it('a stored BYOK choice whose key flipped to error refuses instead of crossing to the platform key', async () => {
    const b = await seedRegistryPartner('byok');
    const platformDefault = await seedOffering({ partnerId: b.partnerId, platformModelId: b.platformModelId, enabled: true });
    await fixtureSql`
      UPDATE ai_model_assignments SET default_offering_id = ${platformDefault}, fallback_may_cross_funding = true
       WHERE partner_id = ${b.partnerId} AND org_id IS NULL AND surface = 'chat' AND role = 'default'`;
    await fixtureSql`UPDATE partner_ai_connections SET status = 'error' WHERE id = ${b.connectionId}`;
    expect(await resolveModel({
      partnerId: b.partnerId, orgId: b.orgId, surface: 'chat', requested: { offeringId: b.offeringId, origin: 'session' },
    })).toMatchObject({ ok: false, reason: 'connection_unavailable', offeringId: b.offeringId });
  });
});

describe.skipIf(!RUN)('session creation (chooseSessionModel) against real rows — W03 Task 9', () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => { process.env.ANTHROPIC_API_KEY = 'sk-ant-w03-integration-placeholder'; });
  afterEach(() => { if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved; });

  it('creates on the surface default: offering, its partner and funding (control)', async () => {
    const a = await seedRegistryPartner('platform');
    expect(await chooseSessionModel({ partnerId: a.partnerId, orgId: a.orgId, userId: a.userId, surface: 'chat' }))
      .toMatchObject({ offeringId: a.offeringId, offeringPartnerId: a.partnerId, options: null, model: a.modelId, billingSource: 'platform' });
  });

  it('a forged cross-partner offering id is not_permitted with no detail about the foreign offering', async () => {
    const a = await seedRegistryPartner('platform');
    const b = await seedRegistryPartner('byok');
    await fixtureSql`UPDATE partner_ai_models SET display_name = 'Partner B secret model' WHERE id = ${b.offeringId}`;
    const err = await chooseSessionModel({
      partnerId: a.partnerId, orgId: a.orgId, userId: a.userId, surface: 'chat', offeringId: b.offeringId,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidSessionModelError);
    expect(err).toMatchObject({ status: 400, code: 'not_permitted', message: 'This AI model is not available here. Choose another model.' });
    expect(String((err as Error).message)).not.toContain('Partner B');
  });

  it('a disabled own offering requested by id is refused (400), never stored', async () => {
    const a = await seedRegistryPartner('platform');
    const other = await seedOffering({ partnerId: a.partnerId, platformModelId: await seedPricedPlatformModel(), enabled: false });
    await expect(chooseSessionModel({
      partnerId: a.partnerId, orgId: a.orgId, userId: a.userId, surface: 'chat', offeringId: other,
    })).rejects.toBeInstanceOf(InvalidSessionModelError);
  });

  it('ai_sessions.model has no default: an insert without a model fails (W02 handoff #5)', async () => {
    const s = await seedRegistryPartner('platform');
    await expect(fixtureSql`INSERT INTO ai_sessions (org_id, user_id, type) VALUES (${s.orgId}, ${s.userId}, 'general')`)
      .rejects.toMatchObject({ code: '23502' });
  });
});
