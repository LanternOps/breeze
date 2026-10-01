/**
 * AI model registry W03 (#7601): the candidate loader against real rows.
 * Task 3 appends the resolver half.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { activateRevision } from '../../services/llmProviderCatalog';
import { findOfferingIdByModel, loadOfferingCandidate } from '../../services/aiModels/candidateLoader';
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
