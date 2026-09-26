import './setup';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { AdjacencySection } from '@breeze/shared';
import vector from '../../../../../packages/shared/src/testing/topology-adjacency-transport-v1.json';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { orgContext, createTopologyTenant } from './topology-fixtures';
import { topologyIngestFixture } from '../helpers/topologyIngest';
import { topologyAdjacencyRoutes } from '../../routes/agents/topologyAdjacency';
import { prepareDiscoveryTopologyDispatch } from '../../services/topology/discoveryDispatch';
import { adjacencyDigestFormSection, adjacencyReportDigest, adjacencyScopeDigest } from '../../services/topology/discoveryAdjacency';
import { discoveryProfiles } from '../../db/schema';
import { eq } from 'drizzle-orm';

type Agent = { deviceId: string; orgId: string; siteId: string; role?: string };
function appFor(agent: Agent) {
  const app = new Hono();
  // Stand-in for agentAuthMiddleware (token auth is covered by agentAuth.test.ts):
  // the route must read authority only from this token-resolved context.
  app.use('*', async (c, next) => { c.set('agent' as never, { role: 'agent', partnerId: null, ...agent } as never); await next(); });
  app.route('/agents', topologyAdjacencyRoutes);
  return app;
}

async function fixture() {
  const f = await topologyIngestFixture();
  const scoped = <T>(fn: () => Promise<T>) => withDbAccessContext(orgContext(f.orgId), fn);
  const profileId = crypto.randomUUID(), jobId = crypto.randomUUID();
  await scoped(async () => {
    await db.execute(sql`INSERT INTO discovery_profiles (id, org_id, site_id, name, subnets, exclude_ips, methods)
      VALUES (${profileId}::uuid, ${f.orgId}::uuid, ${f.siteId}::uuid, 'fixture', ARRAY['192.0.2.0/24'], ARRAY['192.0.2.99'], ARRAY['ping','snmp']::discovery_method[])`);
    await db.execute(sql`INSERT INTO discovery_jobs (id, profile_id, org_id, site_id, status) VALUES (${jobId}::uuid, ${profileId}::uuid, ${f.orgId}::uuid, ${f.siteId}::uuid, 'scheduled')`);
  });
  const [profile] = await scoped(() => db.select().from(discoveryProfiles).where(eq(discoveryProfiles.id, profileId)));
  const block = await withSystemDbAccessContext(() => prepareDiscoveryTopologyDispatch({ jobId, orgId: f.orgId, siteId: f.siteId, profile: profile!, agentId: f.deviceId }));
  if (!block) throw new Error('fixture dispatch not prepared');
  await scoped(() => db.execute(sql`UPDATE discovery_jobs SET status='running', agent_id=${f.deviceId} WHERE id=${jobId}::uuid`));
  const app = appFor({ deviceId: f.deviceId, orgId: f.orgId, siteId: f.siteId });
  let sequence = 1;
  const build = (opts: { address?: string; sections?: AdjacencySection[]; mutate?: (r: Record<string, any>) => void; capturedAt?: string } = {}) => {
    const address = opts.address ?? '192.0.2.10';
    const source = { sourceKey: `snmp:${address}`, address, zone: null };
    const identity = { sourceIdentity: block.sourceIdentity, producerEpoch: block.producerEpoch, source };
    const sections = structuredClone(opts.sections ?? (vector.sections as AdjacencySection[]));
    const forms = sections.map(adjacencyDigestFormSection);
    for (const [i, s] of sections.entries()) s.contentDigest = adjacencyScopeDigest(identity, forms[i]!);
    const report: Record<string, any> = {
      version: 2, parentJobId: jobId, parentCommandId: jobId, producerEpoch: block.producerEpoch, snapshotId: crypto.randomUUID(), sequence: String(sequence++),
      capturedAt: opts.capturedAt ?? new Date().toISOString(), captureAgeAtSendMs: 5, expectedIntervalSeconds: block.expectedIntervalSeconds,
      contentDigest: adjacencyReportDigest(identity, forms), source, reportKind: 'full', sections,
      finalManifest: { scopes: sections.map(s => ({ kind: s.kind, contextKey: s.contextKey, outcome: s.outcome, rowCount: s.rowCount, ...(s.omittedRowCount ? { omittedRowCount: s.omittedRowCount } : {}), contentDigest: s.contentDigest })) },
    };
    opts.mutate?.(report);
    return report;
  };
  const unchangedOf = (full: Record<string, any>, over: Record<string, unknown> = {}) => ({
    version: 2, parentJobId: jobId, parentCommandId: jobId, producerEpoch: block.producerEpoch, snapshotId: crypto.randomUUID(), sequence: String(sequence++),
    capturedAt: new Date(Date.now() + 1000).toISOString(), captureAgeAtSendMs: 5, expectedIntervalSeconds: block.expectedIntervalSeconds,
    contentDigest: full.contentDigest, source: full.source, reportKind: 'unchanged', baseSnapshotId: full.snapshotId, ...over,
  });
  const post = (report: unknown, a = app, parentJobId = jobId) => a.request(`/agents/${f.deviceId}/topology/adjacency`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parentJobId, report }),
  });
  const counts = () => scoped(async () => {
    const [row] = await db.execute(sql`SELECT (SELECT count(*)::int FROM topology_collection_runs r JOIN topology_collection_sources s ON s.id=r.source_id WHERE s.producer_kind='discovery' AND r.org_id=${f.orgId}::uuid) AS runs,
      (SELECT count(*)::int FROM topology_collection_sources WHERE producer_kind='discovery' AND org_id=${f.orgId}::uuid) AS sources`);
    return { runs: Number(row!.runs), sources: Number(row!.sources) };
  });
  const sources = () => scoped(() => db.execute(sql`SELECT protocol, context_key, confirmed_sequence, content_digest, current_baseline FROM topology_collection_sources
    WHERE producer_kind='discovery' AND org_id=${f.orgId}::uuid ORDER BY protocol`)) as Promise<Record<string, any>[]>;
  return { ...f, scoped, jobId, profileId, block, app, build, unchangedOf, post, counts, sources };
}

describe('discovery adjacency transport (M2 Task 4b, D7/D14)', () => {
  it('persists a secret-free dispatch snapshot and admits one per-target report per section', async () => {
    const f = await fixture();
    const [job] = await f.scoped(() => db.execute(sql`SELECT topology_dispatch, topology_config_generation, topology_deadline_at FROM discovery_jobs WHERE id=${f.jobId}::uuid`));
    const snapshot = job!.topology_dispatch as Record<string, any>;
    expect(snapshot).toMatchObject({ deviceId: f.deviceId, includedTargets: ['192.0.2.0/24'], excludedTargets: ['192.0.2.99'], protocols: ['lldp', 'cdp', 'fdb', 'interfaces'], acceptedAdjacencyVersions: [2] });
    expect(JSON.stringify(snapshot)).not.toMatch(/community|passphrase|password/i);
    expect(job!.topology_config_generation).toBe(snapshot.configurationGeneration);

    const report = f.build();
    const res = await f.post(report);
    const body = await res.json() as Record<string, any>;
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ accepted: true, contentDigest: report.contentDigest });
    expect(body.receipts.map((r: any) => [r.kind, r.accepted])).toEqual([['lldp', true], ['cdp', true], ['fdb', true], ['interfaces', true]]);
    expect(await f.counts()).toEqual({ runs: 4, sources: 4 });
    const rows = await f.sources();
    expect(rows.map(r => [r.protocol, r.context_key])).toEqual([['cdp', 'snmp:192.0.2.10/default'], ['fdb', 'snmp:192.0.2.10/default'],
      ['lldp', 'snmp:192.0.2.10/default'], ['snmp_interfaces', 'snmp:192.0.2.10/default']]);
    // FDB is retained in the D13 normalized form, digested server-side.
    const fdb = rows.find(r => r.protocol === 'fdb')!;
    expect(fdb.current_baseline.section.metadata).toEqual({ ineligibleRowCount: 7, sharedPortCount: 2, collapsedRowCount: 34 });
    expect(fdb.content_digest).toBe(report.sections[2].contentDigest);

    // Duplicate retry: identical response, no new run (M1 confirm of the same capture).
    const retry = await f.post(report);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(body);
    expect((await f.counts()).runs).toBe(4);

    // Unchanged confirmation of a later actual read: accepted, no run created.
    const unchanged = await f.post(f.unchangedOf(report, { baseSnapshotId: body.baseSnapshotId }));
    const ub = await unchanged.json() as Record<string, any>;
    expect(unchanged.status).toBe(200);
    expect(ub).toMatchObject({ accepted: true, baseSnapshotId: body.baseSnapshotId });
    expect((await f.counts()).runs).toBe(4);
    expect((await f.sources()).every(r => BigInt(r.confirmed_sequence) > 1n)).toBe(true);

    // An unchanged claim whose digest no longer matches the retained scopes needs a full report.
    const stale = await f.post(f.unchangedOf(report, { contentDigest: 'b'.repeat(64) }));
    expect(await stale.json()).toMatchObject({ accepted: false, reason: 'full_snapshot_required' });
    expect((await f.counts()).runs).toBe(4);
  });

  it('rejects reports outside the dispatched authority without writing anything', async () => {
    const f = await fixture();
    const expectReject = async (res: Response, status: number, error: string) => {
      expect({ status: res.status, body: await res.json() }).toEqual({ status, body: { error } });
    };
    await expectReject(await f.post(f.build({ address: '192.0.3.5' })), 403, 'target_not_authorized');
    await expectReject(await f.post(f.build({ address: '192.0.2.99' })), 403, 'target_not_authorized');
    const extra = structuredClone(vector.sections[0]) as AdjacencySection;
    extra.contextKey = 'vlan-9';
    await expectReject(await f.post(f.build({ sections: [...(vector.sections as AdjacencySection[]), extra] })), 403, 'protocol_not_requested');
    await expectReject(await f.post(f.build({ mutate: r => { r.sections[0].contentDigest = 'c'.repeat(64); r.finalManifest.scopes[0].contentDigest = 'c'.repeat(64); } })), 400, 'section_digest_mismatch');
    await expectReject(await f.post(f.build({ mutate: r => { r.contentDigest = 'd'.repeat(64); } })), 400, 'content_digest_mismatch');
    await expectReject(await f.post(f.build({ mutate: r => { r.producerEpoch = 'e'.repeat(64); } })), 409, 'producer_epoch_changed');
    await expectReject(await f.post(f.build({ capturedAt: new Date(Date.now() - 3_600_000).toISOString() })), 403, 'capture_outside_dispatch');

    // Wrong device: another device of the same org names this job.
    const otherDevice = crypto.randomUUID();
    await f.scoped(() => db.execute(sql`INSERT INTO devices (id, org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version, agent_token_hash)
      VALUES (${otherDevice}::uuid, ${f.orgId}::uuid, ${f.siteId}::uuid, ${otherDevice}, 'other', 'linux', '1', 'amd64', '1', ${'b'.repeat(64)})`));
    await expectReject(await f.post(f.build(), appFor({ deviceId: otherDevice, orgId: f.orgId, siteId: f.siteId })), 403, 'foreign_job');

    // Foreign job: an agent of another tenant names this job id.
    const foreign = await createTopologyTenant();
    await withDbAccessContext(orgContext(foreign.orgId), () => db.execute(sql`UPDATE organizations SET settings='{"topologyFeatureFlags":{"materialization":true}}' WHERE id=${foreign.orgId}::uuid`));
    await expectReject(await f.post(f.build(), appFor({ deviceId: f.deviceId, orgId: foreign.orgId, siteId: foreign.siteId })), 403, 'foreign_job');

    // Watchdog credential cannot write topology.
    const watchdog = await appFor({ deviceId: f.deviceId, orgId: f.orgId, siteId: f.siteId, role: 'watchdog' }).request(`/agents/${f.deviceId}/topology/adjacency`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parentJobId: f.jobId, report: f.build() }) });
    expect(watchdog.status).toBe(403);

    // Profile edited after dispatch: the stored generation no longer authorizes.
    await f.scoped(() => db.execute(sql`UPDATE discovery_profiles SET subnets=ARRAY['192.0.2.0/25'] WHERE id=${f.profileId}::uuid`));
    await expectReject(await f.post(f.build()), 409, 'configuration_changed');
    await f.scoped(() => db.execute(sql`UPDATE discovery_profiles SET subnets=ARRAY['192.0.2.0/24'] WHERE id=${f.profileId}::uuid`));

    // Expired deadline: nothing after it creates current support.
    await f.scoped(() => db.execute(sql`UPDATE discovery_jobs SET topology_deadline_at=now()-interval '1 second' WHERE id=${f.jobId}::uuid`));
    await expectReject(await f.post(f.build()), 410, 'parent_expired');
    expect(await f.counts()).toEqual({ runs: 0, sources: 0 });
  });

  it('refuses a failed/cancelled parent and admits a completed one only within the grace', async () => {
    const f = await fixture();
    await f.scoped(() => db.execute(sql`UPDATE discovery_jobs SET status='failed' WHERE id=${f.jobId}::uuid`));
    expect((await f.post(f.build())).status).toBe(409);
    await f.scoped(() => db.execute(sql`UPDATE discovery_jobs SET status='completed', completed_at=(now() AT TIME ZONE 'UTC') - interval '10 minutes' WHERE id=${f.jobId}::uuid`));
    expect(await (await f.post(f.build())).json()).toEqual({ error: 'parent_not_running' });
    await f.scoped(() => db.execute(sql`UPDATE discovery_jobs SET status='completed', completed_at=(now() AT TIME ZONE 'UTC') - interval '1 minute' WHERE id=${f.jobId}::uuid`));
    expect(await (await f.post(f.build())).json()).toMatchObject({ accepted: true });
  });
});
