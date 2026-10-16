import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { evaluateOrgPresence, PRESENCE_FRESH_CAP_MS } from '../../services/topology/presenceEvaluator';
import { runTopologyPresenceTick } from '../../jobs/topologyPresenceWorker';
import { closeDb, twoSiteOrg, type PresenceDeviceSpec } from './topology-presence-fixtures';
import { getTestDb } from './setup';

afterAll(() => closeDb());

/**
 * Site location W2 Task 5 (#7886): the Main Office / Lakeside scenario of the spec, evaluated end to end over the
 * real collection seam. Fictional names only. The evaluator classifies and displays; it never writes devices.site_id.
 */
const LAN_A = { address: '10.1.2.', gateway: '10.1.2.100' };
const LAN_B = { address: '10.1.5.', gateway: '10.1.5.1' };
const GW_A = '00:00:5e:00:01:0a';
const GW_B = '00:00:5e:00:01:0b';
const HOME_MAC = '00:00:5e:00:01:99';

function lakesideScenario(opts: { lakesideObservers?: boolean } = {}): PresenceDeviceSpec[] {
  const lakeside = opts.lakesideObservers ?? true;
  return [
    { key: 'W1', site: 'A', hostname: 'WIN-HD4M8T2C9', address: `${LAN_A.address}10`, gateway: LAN_A.gateway, gatewayMac: GW_A },
    { key: 'W2', site: 'A', hostname: 'WIN-HD4M8T2D1', address: `${LAN_A.address}11`, gateway: LAN_A.gateway, gatewayMac: GW_A },
    ...(lakeside ? [
      { key: 'L1', site: 'B', hostname: 'LAKESIDE-PC-01', address: `${LAN_B.address}20`, gateway: LAN_B.gateway, gatewayMac: GW_B },
      { key: 'L2', site: 'B', hostname: 'LAKESIDE-PC-02', address: `${LAN_B.address}21`, gateway: LAN_B.gateway, gatewayMac: GW_B },
    ] as PresenceDeviceSpec[] : []),
    { key: 'MIS1', site: 'A', hostname: 'DESKTOP-HD7K2QF', address: `${LAN_B.address}30`, gateway: LAN_B.gateway, gatewayMac: GW_B },
    { key: 'MIS2', site: 'A', hostname: 'WIN-HD4M8T2C8', address: `${LAN_B.address}31`, gateway: LAN_B.gateway, gatewayMac: GW_B },
    { key: 'LAP', site: 'B', hostname: 'LAPTOP-LOV-01', address: `${LAN_A.address}40`, gateway: LAN_A.gateway, gatewayMac: GW_A },
    { key: 'HOME', site: 'A', hostname: 'LAPTOP-HOME-01', address: '192.168.1.50', gateway: '192.168.1.1', gatewayMac: HOME_MAC },
  ];
}

async function scenario(opts: { lakesideObservers?: boolean } = {}) {
  const f = await twoSiteOrg({ declare: { A: ['10.1.2.0/24'], B: ['10.1.5.0/24'] }, devices: lakesideScenario(opts) });
  await f.reportAll();
  await f.publishAll();
  return f;
}

const sitesOf = async (deviceId: string) => {
  const [row] = await getTestDb().execute(sql`SELECT site_id FROM devices WHERE id = ${deviceId}::uuid`) as unknown as Array<{ site_id: string }>;
  return row!.site_id;
};
const state = async (orgId: string) => {
  const [row] = await getTestDb().execute(sql`SELECT fingerprint_version::text AS version, coverage, coverage_reason, dirty_at, next_evaluation_at
    FROM topology_org_presence_state WHERE org_id = ${orgId}::uuid`) as unknown as Array<Record<string, unknown>>;
  return row;
};

describe('presence evaluation', () => {
  it('Main Office/Lakeside: misassigned desktops visit Lakeside, Lakeside laptop visits Main Office, home laptop unrecognized', async () => {
    const f = await scenario();
    const result = await evaluateOrgPresence(f.orgId);
    expect(result).toMatchObject({ status: 'evaluated', coverage: 'complete' });
    const rows = await f.presenceRows();
    expect(rows.MIS1).toMatchObject({ state: 'visiting', matched_site_id: f.siteB, assigned_site_id: f.siteA, mac_corroborated: true });
    expect(rows.MIS2).toMatchObject({ state: 'visiting', matched_site_id: f.siteB });
    expect(rows.LAP).toMatchObject({ state: 'visiting', matched_site_id: f.siteA, assigned_site_id: f.siteB });
    expect(rows.HOME).toMatchObject({ state: 'unrecognized', reason: 'not_declared', matched_site_id: null });
    expect(rows.W1).toMatchObject({ state: 'home', matched_site_id: null });
    expect(rows.L1).toMatchObject({ state: 'home' });
    expect(new Set(Object.values(rows).map((x) => x.fingerprint_version))).toEqual(new Set([result.version.toString()]));
    // Never an automatic move: assignments are untouched.
    expect(await sitesOf(f.ids.MIS1!)).toBe(f.siteA);
    expect(await sitesOf(f.ids.LAP!)).toBe(f.siteB);

    const fingerprints = await getTestDb().execute(sql`SELECT site_id, prefix::text AS prefix, host(gateway_address) AS gateway, status, observer_device_ids::text[] AS observers
      FROM topology_site_fingerprints WHERE org_id = ${f.orgId}::uuid ORDER BY prefix`) as unknown as Array<Record<string, unknown>>;
    expect(fingerprints).toEqual([
      expect.objectContaining({ site_id: f.siteA, prefix: '10.1.2.0/24', gateway: '10.1.2.100', status: 'anchored' }),
      expect.objectContaining({ site_id: f.siteB, prefix: '10.1.5.0/24', gateway: '10.1.5.1', status: 'anchored' }),
    ]);
    // Only Lakeside-assigned observers anchor Lakeside's fingerprint (the misassigned desktops never do).
    expect([...(fingerprints[1]!.observers as string[])].sort()).toEqual([f.ids.L1, f.ids.L2].sort());
  });

  it('a Lakeside with no own observers yields declared_unconfirmed for the misassigned desktops (bootstrap gap, S§6.4)', async () => {
    const f = await scenario({ lakesideObservers: false });
    await evaluateOrgPresence(f.orgId);
    const rows = await f.presenceRows();
    expect(rows.MIS1).toMatchObject({ state: 'unrecognized', reason: 'declared_unconfirmed', matched_site_id: null });
    const [fp] = await getTestDb().execute(sql`SELECT status, gateway_address FROM topology_site_fingerprints
      WHERE org_id = ${f.orgId}::uuid AND site_id = ${f.siteB}::uuid`) as unknown as Array<Record<string, unknown>>;
    expect(fp).toMatchObject({ status: 'unconfirmed', gateway_address: null });
  });

  it('two evaluators race: one gets busy (advisory lock), versions never interleave', async () => {
    const f = await scenario();
    const results = await Promise.all([evaluateOrgPresence(f.orgId), evaluateOrgPresence(f.orgId)]);
    expect(results.map((r) => r.status).sort()).toEqual(['busy', 'evaluated']);
    const rows = await f.presenceRows();
    const evaluated = results.find((r) => r.status === 'evaluated')!;
    expect(new Set(Object.values(rows).map((x) => x.fingerprint_version))).toEqual(new Set([evaluated.version.toString()]));
    expect((await state(f.orgId))!.version).toBe(evaluated.version.toString());
  });

  it('fresh_until never exceeds now + 75 min and never exceeds the supporting evidence', async () => {
    const f = await scenario();
    const before = Date.now();
    await evaluateOrgPresence(f.orgId);
    const rows = await f.presenceRows();
    for (const row of Object.values(rows)) {
      expect(new Date(row.fresh_until as string).getTime()).toBeLessThanOrEqual(Date.now() + PRESENCE_FRESH_CAP_MS);
      expect(new Date(row.fresh_until as string).getTime()).toBeGreaterThan(before);
    }
    // Shrink MIS1's supporting evidence to expire in 5 minutes: its row must not outlive it.
    await getTestDb().execute(sql`UPDATE topology_relationship_support s SET fresh_until = now() + interval '5 minutes'
      FROM topology_node_bindings b WHERE b.device_id = ${f.ids.MIS1}::uuid AND s.org_id = b.org_id
        AND s.relationship_id IN (SELECT r.id FROM topology_relationships r WHERE r.source_node_id = b.node_id)`);
    await getTestDb().execute(sql`UPDATE topology_collection_sources SET fresh_until = now() + interval '5 minutes', confirmed_through_at = now()
      WHERE producer_id = ${f.ids.MIS1}::uuid`);
    await evaluateOrgPresence(f.orgId);
    const after = await f.presenceRows();
    expect(after.MIS1).toMatchObject({ state: 'visiting' });
    expect(new Date(after.MIS1!.fresh_until as string).getTime()).toBeLessThanOrEqual(Date.now() + 5 * 60_000 + 1000);
  });

  it('clears dirty_at only when it is unchanged since the evaluation started (a change during evaluation stays dirty)', async () => {
    const f = await scenario();
    await getTestDb().execute(sql`UPDATE topology_org_presence_state SET dirty_at = now() - interval '1 minute' WHERE org_id = ${f.orgId}::uuid`);
    await evaluateOrgPresence(f.orgId);
    expect((await state(f.orgId))!.dirty_at).toBeNull();
    expect((await state(f.orgId))!.next_evaluation_at).not.toBeNull();

    await getTestDb().execute(sql`UPDATE topology_org_presence_state SET dirty_at = now() - interval '1 minute' WHERE org_id = ${f.orgId}::uuid`);
    // A declaration change committed while the evaluation runs, through the REAL invalidation trigger. The org is
    // already dirty, so the trigger keeps the first dirty_at stamp (debounce anchor): only a generation counter can
    // tell the evaluator its snapshot is stale.
    await evaluateOrgPresence(f.orgId, new Date(), {
      beforeFinalize: () => getTestDb().execute(sql`INSERT INTO network_baselines (org_id, site_id, subnet)
        VALUES (${f.orgId}::uuid, ${f.siteB}::uuid, '10.1.9.0/24')`).then(() => undefined),
    });
    expect((await state(f.orgId))!.dirty_at).not.toBeNull();

    // And a change while the org was clean at the start is kept too.
    await evaluateOrgPresence(f.orgId);
    expect((await state(f.orgId))!.dirty_at).toBeNull();
    await evaluateOrgPresence(f.orgId, new Date(), {
      beforeFinalize: () => getTestDb().execute(sql`UPDATE network_baselines SET subnet = '10.1.8.0/24'
        WHERE org_id = ${f.orgId}::uuid AND subnet = '10.1.9.0/24'`).then(() => undefined),
    });
    expect((await state(f.orgId))!.dirty_at).not.toBeNull();
  });

  it('not_configured org: no declarations → all fingerprints and presence rows deleted', async () => {
    const f = await scenario();
    await evaluateOrgPresence(f.orgId);
    expect(Object.keys(await f.presenceRows()).length).toBeGreaterThan(0);
    await getTestDb().execute(sql`DELETE FROM discovery_profiles WHERE org_id = ${f.orgId}::uuid`);
    const result = await evaluateOrgPresence(f.orgId);
    expect(result).toMatchObject({ status: 'not_configured', coverage: 'not_configured' });
    expect(await f.presenceRows()).toEqual({});
    const [count] = await getTestDb().execute(sql`SELECT count(*)::int AS n FROM topology_site_fingerprints WHERE org_id = ${f.orgId}::uuid`) as unknown as Array<{ n: number }>;
    expect(count!.n).toBe(0);
    expect((await state(f.orgId))!.coverage).toBe('not_configured');
  });

  it('the worker tick enrols an org with pre-existing declarations and evaluates it once the dirty debounce passes', async () => {
    const f = await scenario();
    // Declarations that predate the migration: no state row at all.
    await getTestDb().execute(sql`DELETE FROM topology_org_presence_state WHERE org_id = ${f.orgId}::uuid`);
    const first = await runTopologyPresenceTick(new Date());
    expect(first.enrolled).toBeGreaterThanOrEqual(1);
    expect(await state(f.orgId)).toBeDefined();
    // Debounced: 30 s after the dirty mark it is due.
    await getTestDb().execute(sql`UPDATE topology_org_presence_state SET dirty_at = now() - interval '31 seconds' WHERE org_id = ${f.orgId}::uuid`);
    await runTopologyPresenceTick(new Date());
    expect((await f.presenceRows()).MIS1).toMatchObject({ state: 'visiting' });
  });
});
