/**
 * #4186 W1 Task 5: listLocationSites against real Postgres as breeze_app.
 * Proves the tenancy contract of GET /time-entries/location-sites: RLS plus the
 * app-layer org/site allowlists, hidden + soft-deleted orgs excluded, numeric
 * lat/lng returned as JS numbers, truncation.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import { sites, partners } from '../../db/schema';
import { listLocationSites } from '../../services/siteLocation';
import { getLocationSuggestionSettings } from '../../services/timeSuggestionSettings';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const partnerCtx = (partnerId: string, accessibleOrgIds: string[]): DbAccessContext => ({
  scope: 'partner',
  orgId: null,
  accessibleOrgIds,
  accessiblePartnerIds: [partnerId],
  userId: null,
});

async function pinned(orgId: string, name: string, lat = 40.7128, lng = -74.006) {
  const site = await createSite({ orgId, name });
  await (getTestDb() as any).update(sites)
    .set({ latitude: lat, longitude: lng, geofenceRadiusM: 120, locationSource: 'technician' })
    .where(eq(sites.id, site.id));
  return site;
}

describe('listLocationSites (real RLS)', () => {
  it('returns sites of granted orgs only, with numeric coordinates', async () => {
    const p1 = await createPartner();
    const orgA = await createOrganization({ partnerId: p1.id, name: 'Acme' });
    const orgB = await createOrganization({ partnerId: p1.id, name: 'Beta' });
    const siteA = await pinned(orgA.id, 'Main Office');
    await pinned(orgB.id, 'HQ');

    const out = await withDbAccessContext(partnerCtx(p1.id, [orgA.id]), () =>
      listLocationSites({ accessibleOrgIds: [orgA.id] }));

    expect(out.truncated).toBe(false);
    expect(out.sites.map((s) => s.id)).toEqual([siteA.id]);
    const row = out.sites[0]!;
    expect(row).toMatchObject({ orgId: orgA.id, orgName: 'Acme', name: 'Main Office', geofenceRadiusM: 120, locationSource: 'technician' });
    expect(typeof row.latitude).toBe('number');
    expect(typeof row.longitude).toBe('number');
    expect(row.latitude).toBeCloseTo(40.7128, 6);
    expect(row.longitude).toBeCloseTo(-74.006, 6);
  });

  it('keeps coordinate-less sites (the pin button needs them) with null coordinates', async () => {
    const p1 = await createPartner();
    const org = await createOrganization({ partnerId: p1.id });
    await createSite({ orgId: org.id, name: 'Unpinned' });
    const out = await withDbAccessContext(partnerCtx(p1.id, [org.id]), () =>
      listLocationSites({ accessibleOrgIds: [org.id] }));
    expect(out.sites).toHaveLength(1);
    expect(out.sites[0]).toMatchObject({ latitude: null, longitude: null, locationSource: null });
  });

  it('never returns another partner\'s sites, even when the allowlist is unrestricted or names the foreign org', async () => {
    const p1 = await createPartner();
    const p2 = await createPartner();
    const org1 = await createOrganization({ partnerId: p1.id });
    const org2 = await createOrganization({ partnerId: p2.id });
    const s1 = await pinned(org1.id, 'Mine');
    await pinned(org2.id, 'Theirs');

    const unrestricted = await withDbAccessContext(partnerCtx(p1.id, [org1.id]), () =>
      listLocationSites({ accessibleOrgIds: null }));
    expect(unrestricted.sites.map((s) => s.id)).toEqual([s1.id]);

    const forged = await withDbAccessContext(partnerCtx(p1.id, [org1.id]), () =>
      listLocationSites({ accessibleOrgIds: [org1.id, org2.id] }));
    expect(forged.sites.map((s) => s.id)).toEqual([s1.id]);
  });

  it('excludes hidden quick-support and unassigned-pool orgs', async () => {
    const p1 = await createPartner();
    const real = await createOrganization({ partnerId: p1.id });
    const quick = await createOrganization({ partnerId: p1.id, type: 'quick_support' });
    const pool = await createOrganization({ partnerId: p1.id, type: 'unassigned_pool' });
    const visible = await pinned(real.id, 'Real');
    await pinned(quick.id, 'Stranger machine');
    await pinned(pool.id, 'Holding');

    const out = await withDbAccessContext(partnerCtx(p1.id, [real.id, quick.id, pool.id]), () =>
      listLocationSites({ accessibleOrgIds: [real.id, quick.id, pool.id] }));
    expect(out.sites.map((s) => s.id)).toEqual([visible.id]);
  });

  it('excludes sites of soft-deleted orgs', async () => {
    const p1 = await createPartner();
    const live = await createOrganization({ partnerId: p1.id });
    const gone = await createOrganization({ partnerId: p1.id, deletedAt: new Date() });
    const visible = await pinned(live.id, 'Live');
    await pinned(gone.id, 'Deleted');

    const out = await withDbAccessContext(partnerCtx(p1.id, [live.id, gone.id]), () =>
      listLocationSites({ accessibleOrgIds: [live.id, gone.id] }));
    expect(out.sites.map((s) => s.id)).toEqual([visible.id]);
  });

  it('a site-confined caller sees only allowedSiteIds', async () => {
    const p1 = await createPartner();
    const org = await createOrganization({ partnerId: p1.id });
    const a = await pinned(org.id, 'A');
    await pinned(org.id, 'B');

    const out = await withDbAccessContext(partnerCtx(p1.id, [org.id]), () =>
      listLocationSites({ accessibleOrgIds: [org.id], allowedSiteIds: [a.id] }));
    expect(out.sites.map((s) => s.id)).toEqual([a.id]);

    const none = await withDbAccessContext(partnerCtx(p1.id, [org.id]), () =>
      listLocationSites({ accessibleOrgIds: [org.id], allowedSiteIds: [] }));
    expect(none).toEqual({ sites: [], truncated: false });
  });

  it('flags truncation when more than the limit exist and returns exactly the limit', async () => {
    const p1 = await createPartner();
    const org = await createOrganization({ partnerId: p1.id });
    await createSite({ orgId: org.id, name: 'S1' });
    await createSite({ orgId: org.id, name: 'S2' });
    await createSite({ orgId: org.id, name: 'S3' });

    const out = await withDbAccessContext(partnerCtx(p1.id, [org.id]), () =>
      listLocationSites({ accessibleOrgIds: [org.id] }, 2));
    expect(out.sites).toHaveLength(2);
    expect(out.truncated).toBe(true);

    const exact = await withDbAccessContext(partnerCtx(p1.id, [org.id]), () =>
      listLocationSites({ accessibleOrgIds: [org.id] }, 3));
    expect(exact.sites).toHaveLength(3);
    expect(exact.truncated).toBe(false);
  });

  it('getLocationSuggestionSettings reads the caller\'s own partner flag', async () => {
    const p1 = await createPartner();
    await (getTestDb() as any).update(partners)
      .set({ settings: { timeTracking: { locationSuggestions: { enabled: true, defaultRadiusM: 220 } } } })
      .where(eq(partners.id, p1.id));
    const out = await withDbAccessContext(partnerCtx(p1.id, []), () => getLocationSuggestionSettings(p1.id));
    expect(out).toEqual({ enabled: true, defaultRadiusM: 220 });
  });
});
