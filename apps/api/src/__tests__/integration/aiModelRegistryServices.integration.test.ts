/**
 * AI model registry W02 (#7600): connections / offerings / assignments
 * services against real Postgres, under the caller contexts that will use them.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { createConnection, decryptConnectionKey, getConnectionKeyMaterial, listConnections } from '../../services/aiModels/connections';
import { enableOffering, findOfferingIdForModel, listOfferings } from '../../services/aiModels/offerings';
import { getEffectiveAssignment } from '../../services/aiModels/assignments';
import { createOrganization, createPartner } from './db-utils';
import { closeRegistryFixtures, fixtureSql, orgContext, partnerContext, seedByokConnection, seedOffering, seedPlatformModel } from './aiModelRegistryFixtures';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

describe.skipIf(!RUN)('connections service (#7600 W02)', () => {
  it('a partner creates, lists and decrypts its own connection; another partner and an org token see nothing', async () => {
    const [p, q] = [await createPartner(), await createPartner()];
    const org = await createOrganization({ partnerId: p.id });
    const created = await withDbAccessContext(partnerContext(p.id), () => createConnection({
      partnerId: p.id, kind: 'anthropic_byok', name: 'Anthropic API key',
      apiKey: 'sk-ant-api03-integration-9999', connectedBy: null, verifiedAt: new Date(),
    }));
    expect(created.keyLast4).toBe('9999');
    const material = await withDbAccessContext(partnerContext(p.id), () => getConnectionKeyMaterial(created.id));
    expect(decryptConnectionKey(material!)).toBe('sk-ant-api03-integration-9999');
    expect(await withDbAccessContext(partnerContext(q.id), () => listConnections(p.id))).toEqual([]);
    expect(await withDbAccessContext(orgContext(org.id, p.id), () => listConnections(p.id))).toEqual([]);
  });
});

describe.skipIf(!RUN)('offerings service (#7600 W02)', () => {
  it('refuses to enable an unpriced manual offering, enables it once priced', async () => {
    const p = await createPartner();
    const conn = await seedByokConnection(p.id);
    const off = await seedOffering({ partnerId: p.id, connectionId: conn, modelId: 'my-gateway-model', source: 'manual', enabled: false });
    await expect(withDbAccessContext(partnerContext(p.id), () => enableOffering({ partnerId: p.id, offeringId: off, enabled: true })))
      .rejects.toMatchObject({ code: 'unpriced' });
    await fixtureSql`UPDATE partner_ai_models SET price_input_cents_per_m = 0, price_output_cents_per_m = 0,
                     price_cache_read_cents_per_m = 0, price_cache_write_cents_per_m = 0 WHERE id = ${off}`;
    const enabled = await withDbAccessContext(partnerContext(p.id), () => enableOffering({ partnerId: p.id, offeringId: off, enabled: true }));
    expect(enabled.enabled).toBe(true);
  });

  it('cannot enable another partner\'s offering (not_found under its own context)', async () => {
    const [p, q] = [await createPartner(), await createPartner()];
    const off = await seedOffering({ partnerId: q.id, platformModelId: await seedPlatformModel(), enabled: false });
    await expect(withDbAccessContext(partnerContext(p.id), () => enableOffering({ partnerId: p.id, offeringId: off, enabled: true })))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('finds the offering a legacy call ran on, for the platform and a connection', async () => {
    const p = await createPartner();
    const modelId = `w02-find-${Date.now()}`;
    const pm = await seedPlatformModel(modelId);
    const platformOffering = await seedOffering({ partnerId: p.id, platformModelId: pm });
    const conn = await seedByokConnection(p.id);
    const byok = await seedOffering({ partnerId: p.id, connectionId: conn, modelId });
    await withDbAccessContext(partnerContext(p.id), async () => {
      expect(await findOfferingIdForModel({ partnerId: p.id, connectionId: null, modelId })).toBe(platformOffering);
      expect(await findOfferingIdForModel({ partnerId: p.id, connectionId: conn, modelId })).toBe(byok);
      expect(await findOfferingIdForModel({ partnerId: p.id, connectionId: conn, modelId: 'nope' })).toBeNull();
      expect((await listOfferings(p.id, { connectionId: null })).map((o) => o.id)).toEqual([platformOffering]);
    });
  });
});

describe.skipIf(!RUN)('getEffectiveAssignment (#7600 W02)', () => {
  it('merges the partner row with the org override under an org token, and falls back to the default role', async () => {
    const p = await createPartner();
    const org = await createOrganization({ partnerId: p.id });
    const [a, b] = [
      await seedOffering({ partnerId: p.id, platformModelId: await seedPlatformModel() }),
      await seedOffering({ partnerId: p.id, platformModelId: await seedPlatformModel() }),
    ];
    await fixtureSql`INSERT INTO ai_model_assignments (partner_id, offering_partner_id, surface, default_offering_id, allow_user_choice)
                     VALUES (${p.id}, ${p.id}, 'ai_agents', ${a}, true)`;
    await fixtureSql`INSERT INTO ai_model_assignments (org_id, offering_partner_id, surface, default_offering_id, permitted_offering_ids, allow_user_choice)
                     VALUES (${org.id}, ${p.id}, 'ai_agents', ${b}, ARRAY[${b}]::uuid[], false)`;
    const eff = await withDbAccessContext(orgContext(org.id, p.id), () =>
      getEffectiveAssignment({ partnerId: p.id, orgId: org.id, surface: 'ai_agents', role: 'triage' }));
    expect(eff).toMatchObject({ defaultOfferingId: b, defaultSource: 'org', allowUserChoice: false, permitted: { kind: 'list', offeringIds: [b] } });
    expect(eff.sources.partnerRole).toBe('default');
  });

  it('another org\'s override is ignored even in system scope', async () => {
    const p = await createPartner();
    const [orgA, orgB] = [await createOrganization({ partnerId: p.id }), await createOrganization({ partnerId: p.id })];
    const off = await seedOffering({ partnerId: p.id, platformModelId: await seedPlatformModel() });
    await fixtureSql`INSERT INTO ai_model_assignments (org_id, offering_partner_id, surface, default_offering_id)
                     VALUES (${orgB.id}, ${p.id}, 'chat', ${off})`;
    const eff = await withSystemDbAccessContext(() => getEffectiveAssignment({ partnerId: p.id, orgId: orgA.id, surface: 'chat' }));
    expect(eff.defaultSource).toBe('none');
  });
});
