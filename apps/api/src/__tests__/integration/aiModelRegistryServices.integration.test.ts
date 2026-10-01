/**
 * AI model registry W02 (#7600): connections / offerings / assignments
 * services against real Postgres, under the caller contexts that will use them.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { withDbAccessContext } from '../../db';
import { createConnection, decryptConnectionKey, getConnectionKeyMaterial, listConnections } from '../../services/aiModels/connections';
import { enableOffering, findOfferingIdForModel, listOfferings } from '../../services/aiModels/offerings';
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
