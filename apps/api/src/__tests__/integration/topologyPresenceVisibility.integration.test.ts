import './setup';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { presenceResponseSchema, type PresenceAssignedEntry, type PresenceResponse } from '@breeze/shared';
import { authMiddleware, type AuthContext } from '../../middleware/auth';
import { clearPermissionCache } from '../../services/permissions';
import { topologyPresenceRoutes } from '../../routes/topology/presence';
import { evaluateOrgPresence } from '../../services/topology/presenceEvaluator';
import { closeDb, PRESENCE_GRANTS, twoSiteOrg, type PresenceDeviceSpec, type TwoSiteOrg } from './topology-presence-fixtures';
import { getTestDb } from './setup';
import { setupTestEnvironment } from './db-utils';

afterAll(() => closeDb());

/**
 * Site location W2 Task 6 (#7886), MANDATORY leak tests (plan "Review Focus" 1 and 2, spec S§8 R1–R7).
 * A viewer restricted to one site must learn nothing about a site it cannot see: no name, no id, no count, no
 * reason, no truncation hint. Real Postgres, real auth middleware, real permission re-read. Fictional names only.
 */
const GW_A = '00:00:5e:00:01:0a';
const GW_B = '00:00:5e:00:01:0b';
const GW_C = '00:00:5e:00:01:0c';
const DEVICES: PresenceDeviceSpec[] = [
  { key: 'W1', site: 'A', hostname: 'WIN-HD4M8T2C9', address: '10.1.2.10', gateway: '10.1.2.100', gatewayMac: GW_A },
  { key: 'W2', site: 'A', hostname: 'WIN-HD4M8T2D1', address: '10.1.2.11', gateway: '10.1.2.100', gatewayMac: GW_A },
  { key: 'L1', site: 'B', hostname: 'LAKESIDE-PC-01', address: '10.1.5.20', gateway: '10.1.5.1', gatewayMac: GW_B },
  { key: 'L2', site: 'B', hostname: 'LAKESIDE-PC-02', address: '10.1.5.21', gateway: '10.1.5.1', gatewayMac: GW_B },
  { key: 'MIS1', site: 'A', hostname: 'DESKTOP-HD7K2QF', address: '10.1.5.30', gateway: '10.1.5.1', gatewayMac: GW_B },
  { key: 'MIS2', site: 'A', hostname: 'WIN-HD4M8T2C8', address: '10.1.5.31', gateway: '10.1.5.1', gatewayMac: GW_B },
  { key: 'LAP', site: 'B', hostname: 'LAPTOP-LOV-01', address: '10.1.2.40', gateway: '10.1.2.100', gatewayMac: GW_A },
  { key: 'HOME', site: 'A', hostname: 'LAPTOP-HOME-01', address: '192.168.1.50', gateway: '192.168.1.1', gatewayMac: '00:00:5e:00:01:99' },
  // A Main Office device on Lakeside's declared range through a different router: gateway_mismatch names Lakeside.
  { key: 'GWM', site: 'A', hostname: 'DESKTOP-GWM-01', address: '10.1.5.60', gateway: '10.1.5.254' },
  // Annex (site C) and Lakeside both declare 192.168.7.0/24: ambiguous for a Main Office device there.
  { key: 'C1', site: 'C', hostname: 'ANNEX-PC-01', address: '192.168.7.20', gateway: '192.168.7.1', gatewayMac: GW_C },
  { key: 'AMB', site: 'A', hostname: 'DESKTOP-AMB-01', address: '192.168.7.30', gateway: '192.168.7.1', gatewayMac: GW_C },
  // Lakeside declares a consumer-default range with one observer: a Main Office device there is consumer_uncorroborated.
  { key: 'L3', site: 'B', hostname: 'LAKESIDE-PC-03', address: '192.168.0.20', gateway: '192.168.0.1', gatewayMac: '00:00:5e:00:01:1b' },
  { key: 'CON', site: 'A', hostname: 'DESKTOP-CON-01', address: '192.168.0.30', gateway: '192.168.0.1', gatewayMac: '00:00:5e:00:01:1b' },
];

// setup.ts truncates tenant tables before every test, so the org is rebuilt per test.
let f: TwoSiteOrg;
beforeEach(async () => {
  f = await twoSiteOrg({ withSiteC: true, declare: { A: ['10.1.2.0/24'], B: ['10.1.5.0/24', '192.168.7.0/24', '192.168.0.0/24'], C: ['192.168.7.0/24'] }, devices: DEVICES });
  await f.reportAll();
  await f.publishAll();
  const result = await evaluateOrgPresence(f.orgId);
  expect(result.status).toBe('evaluated');
}, 240_000);

async function get(token: string, siteId: string, headers: Record<string, string> = {}, narrow?: (auth: AuthContext) => AuthContext, keepCache = false) {
  // Clearing the cache bumps the permission authority version, which (by design) changes the ETag.
  if (!keepCache) await clearPermissionCache();
  const app = new Hono();
  app.use('*', authMiddleware);
  if (narrow) app.use('*', async (c, next) => { c.set('auth', narrow(c.get('auth') as AuthContext)); await next(); });
  app.route('/topology', topologyPresenceRoutes);
  return app.request(`/topology/sites/${siteId}/presence`, { headers: { Authorization: `Bearer ${token}`, ...headers } });
}
async function body(token: string, siteId: string, narrow?: (auth: AuthContext) => AuthContext): Promise<PresenceResponse & { raw: string }> {
  const response = await get(token, siteId, {}, narrow);
  const raw = await response.text();
  expect(response.status, raw).toBe(200);
  return { ...presenceResponseSchema.parse(JSON.parse(raw)), raw };
}
const entry = (b: PresenceResponse, key: string) => b.assigned.find((x) => x.deviceId === f.ids[key]);
const shape = (x: PresenceAssignedEntry) => ({ state: x.state, reason: x.reason, matchedSite: x.matchedSite, declaringSites: x.declaringSites,
  macCorroborated: x.macCorroborated, suggestion: x.suggestion, keys: Object.keys(x).sort() });

describe('presence visibility — cross-site leak tests', () => {
  it('viewer with A and B: B shows the A-owned visitors; A roster names Lakeside', async () => {
    const onB = await body(f.users.both.token, f.siteB);
    expect(onB.authority).toBe(false);
    expect(onB.visitors.map((v) => v.deviceId).sort()).toEqual([f.ids.MIS1, f.ids.MIS2].sort());
    expect(onB.visitors[0]).toMatchObject({ assignedSite: { id: f.siteA, name: 'Main Office' }, network: { prefix: '10.1.5.0/24', gatewayAddress: '10.1.5.1' },
      macCorroborated: true, suggestion: null });
    expect(onB.counts.visiting).toBe(2);
    expect(onB.declaredNetworks).toEqual(expect.arrayContaining([expect.objectContaining({ prefix: '10.1.5.0/24', status: 'anchored', gatewayAddresses: ['10.1.5.1'] })]));

    const onA = await body(f.users.both.token, f.siteA);
    expect(entry(onA, 'MIS1')).toMatchObject({ state: 'visiting', reason: null, matchedSite: { id: f.siteB, name: 'Lakeside' } });
    expect(entry(onA, 'HOME')).toMatchObject({ state: 'unrecognized', reason: null, matchedSite: null });
    expect(entry(onA, 'GWM')).toMatchObject({ state: 'unrecognized', reason: 'gateway_mismatch', declaringSites: [{ id: f.siteB, name: 'Lakeside' }] });
    expect(entry(onA, 'W1')).toBeUndefined(); // home devices are not listed
    expect(onA.counts.observedElsewhere).toBe(2);
    expect(onA.visitors.map((v) => v.deviceId)).toEqual([f.ids.LAP]);
  });

  it('viewer with only A: hidden visiting match is byte-identical to unrecognized', async () => {
    const onlyA = await body(f.users.onlyA.token, f.siteA);
    const mis = entry(onlyA, 'MIS1')!;
    const home = entry(onlyA, 'HOME')!; // genuinely unrecognized (not_declared)
    expect(shape(mis)).toEqual(shape(home));
    expect(mis).toMatchObject({ state: 'unrecognized', reason: null, matchedSite: null, declaringSites: null, suggestion: null, macCorroborated: false });
    expect(entry(onlyA, 'GWM')).toMatchObject({ state: 'unrecognized', reason: null, declaringSites: null }); // hint names hidden Lakeside
    expect(onlyA.raw).not.toContain(f.siteB);
    expect(onlyA.raw).not.toContain('Lakeside');
    expect(onlyA.counts.observedElsewhere).toBe(0);
    // A's own visitor from Lakeside (LAP) is hidden too: its owner site is invisible.
    expect(onlyA.visitors).toEqual([]);
    expect(onlyA.counts.visiting).toBe(0);
    expect(onlyA.truncated.visitors).toBe(false);
    expect(onlyA.raw).not.toContain(f.ids.LAP!);
  });

  it('viewer with only B: A-owned visitors are absent, uncounted, untruncated', async () => {
    const onlyB = await body(f.users.onlyB.token, f.siteB);
    expect(onlyB.visitors).toEqual([]);
    expect(onlyB.counts.visiting).toBe(0);
    expect(onlyB.truncated.visitors).toBe(false);
    expect(onlyB.raw).not.toContain(f.ids.MIS1!);
    expect(onlyB.raw).not.toContain(f.siteA);
    expect(onlyB.raw).not.toContain('Main Office');
    // LAP is assigned to Lakeside and visits hidden Main Office: unrecognized, no reason.
    expect(entry(onlyB, 'LAP')).toMatchObject({ state: 'unrecognized', reason: null, matchedSite: null });

    // A viewer of Lakeside AND the Annex (other sites visible, Main Office not): the owner filter, not an empty
    // visible-site list, is what keeps Main Office's visitors out — before the limit, so nothing is counted.
    const bc = await body(f.users.both.token, f.siteB, (auth) => ({ ...auth, allowedSiteIds: [f.siteB, f.siteC] }));
    expect(bc.visitors).toEqual([]);
    expect(bc.counts.visiting).toBe(0);
    expect(bc.truncated.visitors).toBe(false);
    expect(bc.raw).not.toContain(f.ids.MIS1!);
    expect(bc.raw).not.toContain('Main Office');
  });

  it('API key site ceiling hides other-site visitors even when the role is unrestricted', async () => {
    // The unrestricted member's token, narrowed to Main Office only, as a site-limited API key's ceiling is.
    const ceiling = (auth: AuthContext): AuthContext => ({ ...auth, allowedSiteIds: [f.siteA] });
    const viaCeiling = await body(f.users.both.token, f.siteA, ceiling);
    const onlyA = await body(f.users.onlyA.token, f.siteA);
    expect(shape(entry(viaCeiling, 'MIS1')!)).toEqual(shape(entry(onlyA, 'MIS1')!));
    expect(viaCeiling.raw).not.toContain(f.siteB);
    expect(viaCeiling.raw).not.toContain('Lakeside');
    expect(viaCeiling.visitors).toEqual([]);
    // And the ceiling denies Lakeside outright.
    expect((await get(f.users.both.token, f.siteB, {}, ceiling)).status).toBe(404);
  });

  it('ambiguous is shown as unrecognized unless every declaring site is visible', async () => {
    // Every declaring site visible (unrestricted member): ambiguous, naming both declarers.
    const all = await body(f.users.both.token, f.siteA);
    expect(entry(all, 'AMB')).toMatchObject({ state: 'ambiguous', reason: 'multiply_declared',
      declaringSites: expect.arrayContaining([{ id: f.siteB, name: 'Lakeside' }, { id: f.siteC, name: 'Harbor Annex' }]) });
    // A viewer of Main Office and Lakeside but not the Annex: the ambiguity itself is hidden.
    const ab = await body(f.users.both.token, f.siteA, (auth) => ({ ...auth, allowedSiteIds: [f.siteA, f.siteB] }));
    expect(entry(ab, 'AMB')).toMatchObject({ state: 'unrecognized', reason: null, declaringSites: null });
    expect(shape(entry(ab, 'AMB')!)).toEqual(shape(entry(ab, 'HOME')!));
    expect(ab.raw).not.toContain('Harbor Annex');
    expect(ab.raw).not.toContain(f.siteC);
  });

  it('reason hints: a declaring-site reason serializes only when that site is visible', async () => {
    const both = await body(f.users.both.token, f.siteA);
    expect(entry(both, 'CON')).toMatchObject({ state: 'unrecognized', reason: 'consumer_uncorroborated', declaringSites: [{ id: f.siteB, name: 'Lakeside' }] });
    const onlyA = await body(f.users.onlyA.token, f.siteA);
    for (const key of ['CON', 'GWM', 'MIS1', 'AMB']) expect(shape(entry(onlyA, key)!), key).toEqual(shape(entry(onlyA, 'HOME')!));
    expect(onlyA.raw).not.toContain('Lakeside');
  });

  it('declaredNetworks: a prefix shows as ambiguous only when every other declaring site is visible', async () => {
    const onlyB = await body(f.users.both.token, f.siteB, (auth) => ({ ...auth, allowedSiteIds: [f.siteB] }));
    const shared = onlyB.declaredNetworks.find((n) => n.prefix === '192.168.7.0/24');
    expect(shared).toBeDefined();
    expect(shared!.status).not.toBe('ambiguous');
    expect(onlyB.raw).not.toContain(f.siteC);
    expect(onlyB.raw).not.toContain('Harbor Annex');
    const bc = await body(f.users.both.token, f.siteB, (auth) => ({ ...auth, allowedSiteIds: [f.siteB, f.siteC] }));
    expect(bc.declaredNetworks.find((n) => n.prefix === '192.168.7.0/24')!.status).toBe('ambiguous');
  });

  it('declared_unconfirmed hint names B only for B viewers', async () => {
    // Lakeside loses its own observers' evidence for 10.1.5.0/24: its fingerprint becomes unconfirmed.
    const g = await twoSiteOrg({ declare: { B: ['10.1.5.0/24'] }, devices: [DEVICES.find((d) => d.key === 'MIS1')!] });
    await g.reportAll();
    await g.publishAll();
    await evaluateOrgPresence(g.orgId);
    const both = await bodyFor(g, g.users.both.token, g.siteA);
    expect(both.assigned.find((x) => x.deviceId === g.ids.MIS1)).toMatchObject({ state: 'unrecognized', reason: 'declared_unconfirmed',
      declaringSites: [{ id: g.siteB, name: 'Lakeside' }] });
    const onlyA = await bodyFor(g, g.users.onlyA.token, g.siteA);
    expect(onlyA.assigned.find((x) => x.deviceId === g.ids.MIS1)).toMatchObject({ state: 'unrecognized', reason: null, declaringSites: null });
    expect(onlyA.raw).not.toContain('Lakeside');
  });

  it('visitor DTO never carries site A canonical node/relationship/interface ids', async () => {
    const onB = await body(f.users.both.token, f.siteB);
    const ids = await getTestDb().execute(sql`SELECT id::text AS id FROM topology_nodes WHERE site_id = ${f.siteA}::uuid
      UNION ALL SELECT id::text FROM topology_relationships WHERE site_id = ${f.siteA}::uuid
      UNION ALL SELECT id::text FROM topology_interfaces WHERE site_id = ${f.siteA}::uuid`) as unknown as Array<{ id: string }>;
    expect(ids.length).toBeGreaterThan(5);
    const visitors = JSON.stringify(onB.visitors);
    for (const { id } of ids) expect(visitors).not.toContain(id);
    expect(onB.raw).not.toMatch(/relationshipIds|observerNodeId|interfaceName|canonical/);
  });

  it('ETag differs between onlyA and both for the same site, and If-None-Match yields 304', async () => {
    const both = await get(f.users.both.token, f.siteA);
    const onlyA = await get(f.users.onlyA.token, f.siteA);
    const etag = both.headers.get('ETag');
    expect(etag).toMatch(/^W\/"[0-9a-f]{64}"$/);
    expect(onlyA.headers.get('ETag')).not.toBe(etag);
    expect(both.headers.get('Cache-Control')).toContain('private');
    const again = await get(f.users.both.token, f.siteA, {}, undefined, true);
    const stable = again.headers.get('ETag')!;
    expect((await get(f.users.both.token, f.siteA, { 'If-None-Match': stable }, undefined, true)).status).toBe(304);
    expect((await get(f.users.onlyA.token, f.siteA, { 'If-None-Match': stable }, undefined, true)).status).toBe(200);
  });

  it('expired, version-mismatched or assignment-mismatched rows present as unknown/not_current', async () => {
    const g = await twoSiteOrg({ declare: { A: ['10.1.2.0/24'], B: ['10.1.5.0/24'] }, devices: DEVICES.filter((d) => ['W1', 'W2', 'L1', 'L2', 'MIS1', 'MIS2'].includes(d.key)) });
    await g.reportAll();
    await g.publishAll();
    await evaluateOrgPresence(g.orgId);
    await getTestDb().execute(sql`UPDATE topology_device_presence SET fresh_until = now() - interval '1 minute' WHERE device_id = ${g.ids.MIS1}::uuid`);
    await getTestDb().execute(sql`UPDATE topology_device_presence SET fingerprint_version = fingerprint_version - 1 WHERE device_id = ${g.ids.MIS2}::uuid`);
    // A home row that went stale presents too (it is no longer known to be home).
    await getTestDb().execute(sql`UPDATE topology_device_presence SET fresh_until = now() - interval '1 minute' WHERE device_id = ${g.ids.W1}::uuid`);
    const onA = await bodyFor(g, g.users.both.token, g.siteA);
    for (const key of ['MIS1', 'MIS2', 'W1']) {
      expect(onA.assigned.find((x) => x.deviceId === g.ids[key]), key).toMatchObject({ state: 'unknown', reason: 'not_current', matchedSite: null });
    }
    expect(onA.counts).toMatchObject({ observedElsewhere: 0, unknown: 3 });
    const onB = await bodyFor(g, g.users.both.token, g.siteB);
    expect(onB.visitors).toEqual([]); // stale/mismatched visits never render as visitors
  });

  // Site location W3 (#7887): wrong-site suggestions under the same gate (S§8 R2, R3, R5; plan W3 Task 5).
  const suggest = (key: string, siteId: string) => getTestDb().execute(sql`UPDATE topology_device_presence SET suggested_site_id = ${siteId}::uuid,
    suggestion_days = 9, suggestion_first_at = '2026-09-14T08:00:00Z', suggestion_last_at = '2026-10-02T18:00:00Z'
    WHERE device_id = ${f.ids[key]!}::uuid`);
  const SUGGESTION = (siteId: string, siteName: string) => ({ siteId, siteName, days: 9, firstObservedAt: '2026-09-14T08:00:00.000Z', lastObservedAt: '2026-10-02T18:00:00.000Z' });

  it('suggestion is null for onlyA viewers (would name B)', async () => {
    await suggest('MIS1', f.siteB);
    const both = await body(f.users.both.token, f.siteA);
    expect(entry(both, 'MIS1')!.suggestion).toEqual(SUGGESTION(f.siteB, 'Lakeside'));
    const onlyA = await body(f.users.onlyA.token, f.siteA);
    expect(entry(onlyA, 'MIS1')!.suggestion).toBeNull();
    expect(shape(entry(onlyA, 'MIS1')!)).toEqual(shape(entry(onlyA, 'HOME')!));
    expect(onlyA.raw).not.toContain(f.siteB);
    expect(onlyA.raw).not.toContain('Lakeside');
    expect(onlyA.raw).not.toContain('2026-09-14');
    // The token ceiling narrows the same way as the role.
    const ceiling = await body(f.users.both.token, f.siteA, (auth) => ({ ...auth, allowedSiteIds: [f.siteA] }));
    expect(entry(ceiling, 'MIS1')!.suggestion).toBeNull();
    expect(ceiling.raw).not.toContain('Lakeside');
  });

  it("suggestion on B's visitor requires A and B", async () => {
    await suggest('MIS1', f.siteB);
    const both = await body(f.users.both.token, f.siteB);
    expect(both.visitors.find((v) => v.deviceId === f.ids.MIS1)!.suggestion).toEqual(SUGGESTION(f.siteB, 'Lakeside'));
    const ab = await body(f.users.both.token, f.siteB, (auth) => ({ ...auth, allowedSiteIds: [f.siteA, f.siteB] }));
    expect(ab.visitors.find((v) => v.deviceId === f.ids.MIS1)!.suggestion).toEqual(SUGGESTION(f.siteB, 'Lakeside'));
    for (const viewer of [await body(f.users.onlyB.token, f.siteB),
      await body(f.users.both.token, f.siteB, (auth) => ({ ...auth, allowedSiteIds: [f.siteB, f.siteC] }))]) {
      expect(viewer.visitors).toEqual([]);
      expect(viewer.raw).not.toContain(f.ids.MIS1!);
      expect(viewer.raw).not.toContain('2026-09-14');
    }
    // A stored suggestion for a site other than the one the device is visiting is never emitted (stale row).
    await suggest('MIS2', f.siteC);
    const again = await body(f.users.both.token, f.siteB);
    expect(again.visitors.find((v) => v.deviceId === f.ids.MIS2)!.suggestion).toBeNull();
    const onA = await body(f.users.both.token, f.siteA);
    expect(entry(onA, 'MIS2')!.suggestion).toBeNull();
  });

  it('site header suggestion count counts only visible', async () => {
    await suggest('MIS1', f.siteB);
    await suggest('LAP', f.siteA);
    const suggested = (b: PresenceResponse) => b.assigned.filter((x) => x.suggestion).length + b.visitors.filter((v) => v.suggestion).length;
    expect(suggested(await body(f.users.both.token, f.siteB))).toBe(1 + 1); // MIS1 visiting B; LAP assigned to B, suggested A
    expect(suggested(await body(f.users.onlyB.token, f.siteB))).toBe(0);
    expect(suggested(await body(f.users.both.token, f.siteA))).toBe(1 + 1); // MIS1 assigned to A; LAP visiting A
    expect(suggested(await body(f.users.onlyA.token, f.siteA))).toBe(0);
  });

  it('a confirmed device carries its confirmation (no site named) and no suggestion, even before re-evaluation', async () => {
    await suggest('MIS1', f.siteB);
    await getTestDb().execute(sql`UPDATE devices SET site_assignment_confirmed_at = '2026-10-02T09:30:00Z' WHERE id = ${f.ids.MIS1!}::uuid`);
    const both = await body(f.users.both.token, f.siteA);
    expect(entry(both, 'MIS1')).toMatchObject({ siteAssignmentConfirmedAt: '2026-10-02T09:30:00.000Z', suggestion: null });
    expect((await body(f.users.both.token, f.siteB)).visitors.find((v) => v.deviceId === f.ids.MIS1)!.suggestion).toBeNull();
    const onlyA = await body(f.users.onlyA.token, f.siteA);
    expect(entry(onlyA, 'MIS1')).toMatchObject({ siteAssignmentConfirmedAt: '2026-10-02T09:30:00.000Z', suggestion: null });
    expect(onlyA.raw).not.toContain('Lakeside');
  });

  it('a user from another org gets 404 for the site', async () => {
    const other = await setupTestEnvironment({ scope: 'organization', rolePermissions: PRESENCE_GRANTS });
    const response = await get(other.token, f.siteA);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('Main Office');
  });
});

async function bodyFor(g: TwoSiteOrg, token: string, siteId: string) {
  const response = await get(token, siteId);
  const raw = await response.text();
  expect(response.status, raw).toBe(200);
  return { ...presenceResponseSchema.parse(JSON.parse(raw)), raw, g };
}
