/**
 * The site recorded on an analysis run must hold every input device, against
 * real Postgres. AI artifact visibility for site-restricted users relies on it.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifiedAnalysisSiteId } from '../../services/aiAgents/analysisRunSite';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';

const runDb = it.runIf(Boolean(process.env.DATABASE_URL));

describe('verifiedAnalysisSiteId (live DB)', () => {
  runDb('keeps a site only when it is in the org and holds every input device, of which there is at least one', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const otherOrg = await createOrganization({ partnerId: partner.id });
    const siteA = await createSite({ orgId: org.id });
    const siteB = await createSite({ orgId: org.id });
    const foreignSite = await createSite({ orgId: otherOrg.id });
    const deviceA = await createDevice({ orgId: org.id, siteId: siteA.id });
    const deviceA2 = await createDevice({ orgId: org.id, siteId: siteA.id });
    const deviceB = await createDevice({ orgId: org.id, siteId: siteB.id });

    // No input devices: nothing ties the run to a site.
    expect(await verifiedAnalysisSiteId(org.id, siteA.id, [])).toBeNull();
    // The stored id is the database's, in its canonical form.
    expect(await verifiedAnalysisSiteId(org.id, siteA.id.toUpperCase(), [deviceA.id])).toBe(siteA.id);
    expect(await verifiedAnalysisSiteId(org.id, siteA.id, [deviceA.id, deviceA2.id, deviceA.id])).toBe(siteA.id);
    expect(await verifiedAnalysisSiteId(org.id, siteA.id, [deviceA.id, deviceB.id])).toBeNull();
    expect(await verifiedAnalysisSiteId(org.id, siteA.id, [randomUUID()])).toBeNull();
    expect(await verifiedAnalysisSiteId(org.id, foreignSite.id, [])).toBeNull();
    expect(await verifiedAnalysisSiteId(org.id, randomUUID(), [])).toBeNull();
    expect(await verifiedAnalysisSiteId(org.id, 'not-a-uuid', [])).toBeNull();
    expect(await verifiedAnalysisSiteId(org.id, siteA.id, ['not-a-uuid'])).toBeNull();
    expect(await verifiedAnalysisSiteId(org.id, null, [deviceA.id])).toBeNull();
  });
});
