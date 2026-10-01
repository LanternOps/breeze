/**
 * AI model registry W02 (#7600): connections / offerings / assignments
 * services against real Postgres, under the caller contexts that will use them.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { withDbAccessContext } from '../../db';
import { createConnection, decryptConnectionKey, getConnectionKeyMaterial, listConnections } from '../../services/aiModels/connections';
import { createOrganization, createPartner } from './db-utils';
import { closeRegistryFixtures, orgContext, partnerContext } from './aiModelRegistryFixtures';

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
