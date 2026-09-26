import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { topologyChangePageSchema, topologyImpactResponseSchema, type TopologyImpactResponse } from '@breeze/shared';
import { authMiddleware } from '../../middleware/auth';
import { topologyInvestigationRoutes } from '../../routes/topology/investigation';
import { canonicalIdentityKey } from '../../services/topology/identity';
import { createSite, setupTestEnvironment, type TestEnvironment } from './db-utils';
import { getTestDb } from './setup';

/**
 * M3 Task 10 against real Postgres through the authenticated routes (request
 * RLS): impact on a fixture with a FAILED UPLINK is bounded, cited and labels
 * its uncertainty; per-view exclusions do not change it; it is scoped to the
 * exact site/org and the physical capability; and neither impact nor change
 * history writes, dispatches, correlates or touches an alert.
 */
const READ = [{ resource: 'topology', action: 'read' }, { resource: 'devices', action: 'read' }];
const app = () => new Hono().use('*', authMiddleware).route('/topology', topologyInvestigationRoutes);
const get = (env: TestEnvironment, siteId: string, path: string) =>
  app().request(`/topology/sites/${siteId}/${path}`, { headers: { Authorization: `Bearer ${env.token}` } });
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

async function setFlags(orgId: string, flags: Record<string, boolean>) {
  await getTestDb().execute(sql`UPDATE organizations SET settings = ${JSON.stringify({ topologyFeatureFlags: { materialization: true, ui: true, ...flags } })}::jsonb WHERE id = ${orgId}::uuid`);
}

/**
 * gateway G ─uplink(LLDP, port DOWN)─ switch S1 ─LLDP─ host H1 ─member─ network NET
 *           ─LLDP─ switch S2                   └─FDB attachment (inferred)─ host H2
 * A fresh SNMP sample reports the S1 uplink port operationally down (the measured failure).
 */
async function seed(orgId: string, siteId: string, options: { runAgeMs?: number } = {}) {
  const db = getTestDb();
  const scope = { orgId, siteId };
  const ids = {
    g: randomUUID(), s1: randomUUID(), s2: randomUUID(), h1: randomUUID(), h2: randomUUID(), net: randomUUID(),
    s1Port: randomUUID(), gPort: randomUUID(), uplink: randomUUID(), gs2: randomUUID(), s1h1: randomUUID(), s1h2: randomUUID(), member: randomUUID(),
    device: randomUUID(), metrics: randomUUID(), lldp: randomUUID(), run: randomUUID(), gapRun: randomUUID(),
  };
  const now = Date.now();
  await db.execute(sql`INSERT INTO topology_site_state (org_id, site_id, graph_revision, health_revision) VALUES (${orgId}::uuid, ${siteId}::uuid, 5, 3) ON CONFLICT DO NOTHING`);
  await db.execute(sql`INSERT INTO devices (id, org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
    VALUES (${ids.device}::uuid, ${orgId}::uuid, ${siteId}::uuid, ${ids.device}, 'poller', 'linux', '1', 'amd64', '1')`);
  const nodes: [string, string, string | null, string][] = [
    [ids.g, 'gateway', null, 'gw'], [ids.s1, 'endpoint', 'switch', 'sw1'], [ids.s2, 'endpoint', 'switch', 'sw2'],
    [ids.h1, 'endpoint', null, 'h1'], [ids.h2, 'endpoint', null, 'h2'], [ids.net, 'network', null, 'lan'],
  ];
  for (const [id, kind, role, label] of nodes) {
    const key = `net:${id}`;
    await db.execute(sql`INSERT INTO topology_nodes (id, org_id, site_id, identity_key, identity_material, kind, role, attributes)
      VALUES (${id}::uuid, ${orgId}::uuid, ${siteId}::uuid, ${canonicalIdentityKey(scope, kind as 'endpoint', key)}, ${JSON.stringify({ version: 1, kind, sourceKey: key })}::jsonb,
        ${kind}, ${role}, ${JSON.stringify({ label })}::jsonb)`);
  }
  for (const [id, owner, key] of [[ids.s1Port, ids.s1, 'if:1'], [ids.gPort, ids.g, 'if:9']] as const) {
    await db.execute(sql`INSERT INTO topology_interfaces (id, org_id, site_id, owner_node_id, interface_key, epoch, name)
      VALUES (${id}::uuid, ${orgId}::uuid, ${siteId}::uuid, ${owner}::uuid, ${key}, 'gen:1', ${key})`);
  }
  const rel = (id: string, kind: string, source: string, target: string, evidence: string, attributes: object, ports: [string | null, string | null] = [null, null], directness = 'direct') =>
    db.execute(sql`INSERT INTO topology_relationships (id, org_id, site_id, canonical_key, identity_material, kind, source_node_id, target_node_id,
        source_interface_id, target_interface_id, directness, confidence, evidence_class, support_count, last_supported_at, attributes)
      VALUES (${id}::uuid, ${orgId}::uuid, ${siteId}::uuid, ${canonicalIdentityKey(scope, kind as 'attachment', id)}, ${JSON.stringify({ version: 1, kind, sourceKey: id })}::jsonb,
        ${kind}, ${source}::uuid, ${target}::uuid, ${ports[0]}::uuid, ${ports[1]}::uuid, ${directness}, ${evidence === 'inferred' ? 'low' : 'high'}, ${evidence}, 1, now(), ${JSON.stringify(attributes)}::jsonb)`);
  await rel(ids.uplink, 'physical_link', ids.s1, ids.g, 'observed', { method: 'lldp', physical: { resolution: 'resolved' } }, [ids.s1Port, ids.gPort]);
  await rel(ids.gs2, 'physical_link', ids.g, ids.s2, 'observed', { method: 'lldp' });
  await rel(ids.s1h1, 'physical_link', ids.s1, ids.h1, 'observed', { method: 'lldp' });
  await rel(ids.s1h2, 'attachment', ids.s1, ids.h2, 'inferred', { method: 'fdb', physical: { fdbSelection: 'selected' } }, [null, null], 'unknown');
  await rel(ids.member, 'network_member', ids.h1, ids.net, 'inferred', {});
  // Structural source (LLDP discovery) supporting the physical rows; the FDB attachment's detail has aged out.
  await db.execute(sql`INSERT INTO topology_collection_sources (id, org_id, site_id, producer_id, producer_kind, producer_epoch, protocol, context_key, address_family,
      expected_interval_seconds, last_outcome, last_received_at, epoch_issued_at, accepted_sequence, confirmed_sequence)
    VALUES (${ids.lldp}::uuid, ${orgId}::uuid, ${siteId}::uuid, ${ids.device}::uuid, 'discovery', 'd1', 'lldp', 'snmp:192.0.2.1', 'any', 300, 'complete', now(),
      ${iso(now - 2 * 86_400_000)}::timestamptz, 3, 3)`);
  for (const [relationshipId, firstAt] of [[ids.uplink, now - 2 * 86_400_000], [ids.gs2, now - 2 * 86_400_000], [ids.s1h1, now - 2 * 86_400_000], [ids.s1h2, now - 10 * MIN]] as const) {
    await db.execute(sql`INSERT INTO topology_relationship_support (org_id, site_id, relationship_id, source_id, producer_epoch, sequence, content_digest,
        first_positive_at, last_positive_at, effective_at, fresh_until)
      VALUES (${orgId}::uuid, ${siteId}::uuid, ${relationshipId}::uuid, ${ids.lldp}::uuid, 'd1', 3, ${'a'.repeat(64)},
        ${iso(firstAt)}::timestamptz, now(), now(), now() + interval '1 hour')`);
  }
  // Telemetry source and a fresh port-down sample on the S1 uplink port.
  await db.execute(sql`INSERT INTO topology_collection_sources (id, org_id, site_id, producer_id, producer_kind, producer_epoch, protocol, context_key, address_family,
      expected_interval_seconds, last_outcome, last_received_at, accepted_sequence, confirmed_sequence)
    VALUES (${ids.metrics}::uuid, ${orgId}::uuid, ${siteId}::uuid, ${ids.device}::uuid, 'snmp', 'p1', 'if_metrics', 'snmp:192.0.2.10', 'any', 60, 'complete', now(), 2, 2)`);
  await db.execute(sql`SELECT public.breeze_ensure_topology_interface_sample_partition('raw', ${iso(now).slice(0, 10)}::date)`);
  await db.execute(sql`SELECT public.breeze_ensure_topology_interface_sample_partition('raw', ${iso(now - 2 * MIN).slice(0, 10)}::date)`);
  for (const [i, oper] of [[0, 'up'], [1, 'down']] as const) {
    const readings = { v: 1, expectedIntervalSeconds: 60, counterWidth: 64, inOctets: String(1000 * (i + 1)), outOctets: '0', inErrors: '0', outErrors: '0', inDiscards: '0', outDiscards: '0',
      inPackets: null, outPackets: null, capacityBps: '1000000', discontinuityTicks: '0', deviceUptimeTicks: String(1_000_000 + i * 6000), reportedInBps: null, reportedOutBps: null,
      adminStatus: 'up', operStatus: oper, unavailable: {} };
    await db.execute(sql`INSERT INTO topology_interface_samples (org_id, site_id, interface_id, interface_epoch, source_id, producer_epoch, source_sequence, sampled_at, resolution, readings, sample_count)
      VALUES (${orgId}::uuid, ${siteId}::uuid, ${ids.s1Port}::uuid, 'gen:1', ${ids.metrics}::uuid, 'p1', ${String(i + 1)}, ${iso(now - (1 - i) * MIN)}::timestamptz, 'raw', ${JSON.stringify(readings)}::jsonb, 1)`);
  }
  // A completed reachability check from G that failed toward H1 one minute ago (fresh corroborating evidence).
  const runAt = now - (options.runAgeMs ?? MIN);
  await db.execute(sql`INSERT INTO topology_diagnostic_runs (id, org_id, site_id, recipe_id, recipe_version, requester_id, subject_node_id, origin_node_id, origin_snapshot, plan,
      plan_digest, idempotency_key, body_hash, attempt_id, state, assessment, coverage, queued_at, queue_deadline, deadline, finished_at)
    VALUES (${ids.run}::uuid, ${orgId}::uuid, ${siteId}::uuid, 'reachability', 1, ${randomUUID()}::uuid, ${ids.h1}::uuid, ${ids.g}::uuid, '{}'::jsonb, '{}'::jsonb,
      ${'b'.repeat(64)}, ${randomUUID()}, ${'c'.repeat(64)}, ${randomUUID()}::uuid, 'completed', 'failed_check', 'complete',
      ${iso(runAt - 2 * MIN)}::timestamptz, ${iso(runAt - MIN)}::timestamptz, ${iso(runAt + MIN)}::timestamptz, ${iso(runAt)}::timestamptz)`);
  // An open alert on the poller: impact must never acknowledge, suppress, resolve or re-evaluate it.
  await db.execute(sql`INSERT INTO alerts (org_id, device_id, status, severity, title) VALUES (${orgId}::uuid, ${ids.device}::uuid, 'active', 'critical', 'Uplink port down')`);
  // An incomplete structural collection run: a collection gap.
  await db.execute(sql`INSERT INTO topology_collection_runs (id, org_id, site_id, source_id, producer_id, producer_epoch, sequence, snapshot_id, content_digest,
      observed_at, effective_at, received_at, outcome, snapshot, normalized_bytes, expected_interval_seconds)
    VALUES (${ids.gapRun}::uuid, ${orgId}::uuid, ${siteId}::uuid, ${ids.lldp}::uuid, ${ids.device}::uuid, 'd1', 2, ${randomUUID()}::uuid, ${'d'.repeat(64)},
      ${iso(now - 5 * MIN)}::timestamptz, ${iso(now - 5 * MIN)}::timestamptz, ${iso(now - 5 * MIN)}::timestamptz, 'partial', '{}'::jsonb, 2, 300)`);
  return { ids, now };
}

async function sideEffects(orgId: string) {
  const [row] = await getTestDb().execute<Record<string, string>>(sql`SELECT
    (SELECT count(*) FROM device_commands WHERE device_id IN (SELECT id FROM devices WHERE org_id = ${orgId}::uuid))::text AS commands,
    (SELECT count(*) FROM discovery_jobs WHERE org_id = ${orgId}::uuid)::text AS jobs,
    (SELECT count(*) || '/' || coalesce(max(updated_at)::text, '') FROM topology_diagnostic_runs WHERE org_id = ${orgId}::uuid) AS runs,
    (SELECT count(*) FROM topology_interface_samples WHERE org_id = ${orgId}::uuid)::text AS samples,
    (SELECT count(*) FROM topology_change_outbox WHERE org_id = ${orgId}::uuid)::text AS outbox,
    (SELECT md5(coalesce(string_agg(to_jsonb(a)::text, ',' ORDER BY a.id), '')) FROM alerts a WHERE a.org_id = ${orgId}::uuid) AS alerts,
    (SELECT count(*) FROM alert_correlation_groups WHERE org_id = ${orgId}::uuid)::text AS correlations,
    (SELECT string_agg(graph_revision::text || '/' || health_revision::text, ',') FROM topology_site_state WHERE org_id = ${orgId}::uuid) AS revisions,
    (SELECT max(updated_at) FROM topology_relationships WHERE org_id = ${orgId}::uuid)::text AS relationships,
    (SELECT max(updated_at) FROM topology_collection_sources WHERE org_id = ${orgId}::uuid)::text AS sources`);
  return row;
}

const stable = (body: TopologyImpactResponse) => ({ ...body, asOf: null, window: { ...body.window, from: null, to: null } });
const impactPath = (subjectId: string, extra = '') => `impact?subjectKind=relationship&subjectId=${subjectId}${extra}`;

describe('M3 Task 10 impact and change history (real DB)', () => {
  it('explains a failed uplink cautiously: bounded, cited, uncertainty labelled, no writes', async () => {
    const env = await setupTestEnvironment({ rolePermissions: READ });
    await setFlags(env.organization.id, { physical: true, interfaceHealth: true });
    const { ids } = await seed(env.organization.id, env.site.id);
    const before = await sideEffects(env.organization.id);

    const res = await get(env, env.site.id, impactPath(ids.uplink, '&graphRevision=5&windowMinutes=5'));
    const raw = await res.json();
    expect(res.status, JSON.stringify(raw)).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = topologyImpactResponseSchema.parse(raw);
    expect(body).toMatchObject({ graphRevision: '5', healthRevision: '3', coverage: 'complete', subject: { kind: 'relationship', id: ids.uplink, measured: true } });

    // Measured: the uplink port is down (fresh port evidence). H1's failed check is measured too.
    expect(body.measuredFailures).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'relationship', id: ids.uplink, status: 'failed_check', evidenceIds: [`interface:${ids.s1Port}`] }),
      expect.objectContaining({ kind: 'node', id: ids.h1, evidenceIds: [ids.run] }),
    ]));
    // Possible: everything behind the uplink, none of it promoted to a certain loss.
    const affected = new Map(body.potentiallyAffected.map((entry) => [entry.id, entry]));
    expect([...affected.keys()].sort()).toEqual([ids.s1, ids.h1, ids.h2].sort());
    expect(affected.get(ids.s1)).toMatchObject({ basis: 'dependency_path', hops: 1, evidenceIds: [ids.uplink] });
    expect(affected.get(ids.h1)).toMatchObject({ hops: 2, evidenceIds: [ids.uplink, ids.s1h1] });
    for (const entry of affected.values()) expect(entry.reasons).toContain('no_known_alternative_path');
    expect(affected.get(ids.h1)!.reasons).not.toContain('path_evidence_stale');
    expect(affected.get(ids.h1)!.reasons).toContain('failure_measured');
    // The FDB-inferred attachment never becomes a certain downstream claim.
    expect(affected.get(ids.h2)!.reasons).toEqual(expect.arrayContaining(['path_via_attachment', 'path_via_fdb_inference', 'path_via_inferred_relationship', 'path_directness_unknown', 'path_low_confidence']));
    // S2 has its own uplink; the network is reached only by membership, never cable dependence.
    expect(affected.has(ids.s2)).toBe(false);
    expect(affected.has(ids.net)).toBe(false);
    expect(body.causeSuggestion).toEqual({ state: 'possible', corroboratingIds: [ids.h1], reasons: ['corroborated_by_dependent_failures', 'context_compatibility_unverified'] });
    expect(body.evidence).toEqual(expect.arrayContaining([{ id: ids.uplink, kind: 'relationship' }, { id: ids.run, kind: 'diagnostic_run' }, { id: `interface:${ids.s1Port}`, kind: 'interface_measurement' }]));

    // Per-view exclusions are presentation state: hiding the uplink and the attachment changes nothing.
    for (const [relationshipId, view] of [[ids.uplink, 'physical'], [ids.uplink, 'overview'], [ids.s1h2, 'physical']] as const) {
      await getTestDb().execute(sql`INSERT INTO topology_view_exclusions (org_id, site_id, relationship_id, view, reason)
        VALUES (${env.organization.id}::uuid, ${env.site.id}::uuid, ${relationshipId}::uuid, ${view}, 'decluttering')`);
    }
    const excluded = topologyImpactResponseSchema.parse(await (await get(env, env.site.id, impactPath(ids.uplink, '&graphRevision=5'))).json());
    expect(stable(excluded)).toEqual(stable(body));

    // A stale pinned revision is a conflict, not a silent re-read.
    const conflict = await get(env, env.site.id, impactPath(ids.uplink, '&graphRevision=4'));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'graph_revision_changed' });

    expect(await sideEffects(env.organization.id)).toEqual(before);
  });

  it('never counts an expired on-demand check as fresh, however wide the window', async () => {
    const env = await setupTestEnvironment({ rolePermissions: READ });
    await setFlags(env.organization.id, { physical: true, interfaceHealth: true });
    // The H1 check finished 12 minutes ago: inside a 30-minute window, but past its 5-minute freshness.
    const { ids } = await seed(env.organization.id, env.site.id, { runAgeMs: 12 * MIN });
    const body = topologyImpactResponseSchema.parse(await (await get(env, env.site.id, impactPath(ids.uplink, '&windowMinutes=30'))).json());
    expect(body.measuredFailures.some((failure) => failure.id === ids.h1)).toBe(false);
    expect(body.reasons).toContain('failure_evidence_stale');
    expect(body.causeSuggestion.state).toBe('not_suggested');
    expect(body.potentiallyAffected.find((entry) => entry.id === ids.h1)!.reasons).not.toContain('failure_measured');
  });

  it('serves bounded change history with evidence, expired-detail markers and signed paging, and writes nothing', async () => {
    const env = await setupTestEnvironment({ rolePermissions: READ });
    await setFlags(env.organization.id, { physical: true, interfaceHealth: true });
    const { ids, now } = await seed(env.organization.id, env.site.id);
    const before = await sideEffects(env.organization.id);
    const window = `since=${iso(now - 60 * MIN)}&until=${iso(now + MIN)}`;

    const res = await get(env, env.site.id, `changes?${window}`);
    const raw = await res.json();
    expect(res.status, JSON.stringify(raw)).toBe(200);
    const page = topologyChangePageSchema.parse(raw);
    const byKind = (kind: string) => page.changes.filter((change) => change.kind === kind);
    expect(byKind('relationship_observed')).toEqual([expect.objectContaining({
      category: 'attachment', subject: { kind: 'relationship', id: ids.s1h2 }, detail: 'expired',
      attributes: expect.objectContaining({ method: 'fdb', evidenceClass: 'inferred', producerKind: 'discovery' }) })]);
    expect(byKind('measurement_result')).toEqual([expect.objectContaining({ subject: { kind: 'node', id: ids.h1 }, evidenceIds: [ids.run],
      attributes: expect.objectContaining({ recipeId: 'reachability', assessment: 'failed_check', observedRoutedPath: false }) })]);
    expect(byKind('collection_gap')).toEqual([expect.objectContaining({ subject: { kind: 'source', id: ids.lldp }, evidenceIds: [ids.gapRun, ids.lldp], attributes: expect.objectContaining({ outcome: 'partial' }) })]);
    // The telemetry source starting is a source change; its fresh port samples (health freshness) are not changes at all.
    expect(byKind('source_epoch_changed')).toEqual([expect.objectContaining({ subject: { kind: 'source', id: ids.metrics }, attributes: { producerKind: 'snmp', protocol: 'if_metrics' } })]);
    expect(page.changes.map((change) => change.kind).sort()).toEqual(['collection_gap', 'measurement_result', 'relationship_observed', 'source_epoch_changed']);
    const times = page.changes.map((change) => Date.parse(change.at));
    expect(times).toEqual([...times].sort((a, b) => b - a));

    // Page one row at a time: the same set, no duplicates, cursors bound to the window.
    const walked: string[] = [];
    let cursor: string | null = null;
    do {
      const next = topologyChangePageSchema.parse(await (await get(env, env.site.id, `changes?${window}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)).json());
      walked.push(...next.changes.map((change) => change.id));
      cursor = next.cursor;
    } while (cursor && walked.length < 50);
    expect(walked).toEqual(page.changes.map((change) => change.id));
    const first = topologyChangePageSchema.parse(await (await get(env, env.site.id, `changes?${window}&limit=1`)).json());
    expect((await get(env, env.site.id, `changes?since=${iso(now - 30 * MIN)}&until=${iso(now + MIN)}&limit=1&cursor=${encodeURIComponent(first.cursor!)}`)).status).toBe(400);

    expect(await sideEffects(env.organization.id)).toEqual(before);
  });

  it('is scoped to the exact site and org and respects the physical capability', async () => {
    const env = await setupTestEnvironment({ rolePermissions: READ });
    await setFlags(env.organization.id, { physical: true, interfaceHealth: true });
    const siteB = (await createSite({ orgId: env.organization.id })).id;
    const inB = await seed(env.organization.id, siteB);
    const inA = await seed(env.organization.id, env.site.id);
    expect((await get(env, env.site.id, impactPath(inB.ids.uplink))).status).toBe(404);
    expect((await get(env, siteB, impactPath(inB.ids.uplink))).status).toBe(200);
    const aChanges = topologyChangePageSchema.parse(await (await get(env, env.site.id, `changes?since=${iso(inA.now - 60 * MIN)}&until=${iso(inA.now + MIN)}`)).json());
    expect(JSON.stringify(aChanges)).not.toContain(inB.ids.s1h2);

    const other = await setupTestEnvironment({ rolePermissions: READ });
    await setFlags(other.organization.id, { physical: true, interfaceHealth: true });
    const foreign = await seed(other.organization.id, other.site.id);
    expect((await get(env, other.site.id, impactPath(foreign.ids.uplink))).status).toBe(404);
    expect((await get(env, env.site.id, impactPath(foreign.ids.uplink))).status).toBe(404);

    const denied = await setupTestEnvironment({ rolePermissions: [{ resource: 'devices', action: 'read' }] });
    const d = await seed(denied.organization.id, denied.site.id);
    expect((await get(denied, denied.site.id, impactPath(d.ids.uplink))).status).toBe(403);

    // Physical capability off: physical links are hidden from traversal, counts and citations.
    await setFlags(env.organization.id, { physical: false, interfaceHealth: false });
    expect((await get(env, env.site.id, impactPath(inA.ids.uplink))).status).toBe(404);
    const gateway = topologyImpactResponseSchema.parse(await (await get(env, env.site.id, `impact?subjectKind=node&subjectId=${inA.ids.g}`)).json());
    expect(gateway.potentiallyAffected).toEqual([]);
    expect(gateway.assumptions).toContain('physical_evidence_unavailable');
    for (const hidden of [inA.ids.uplink, inA.ids.s1h1, inA.ids.s1h2, inA.ids.s1Port]) expect(JSON.stringify(gateway)).not.toContain(hidden);
    expect(gateway.counts.relationships).toBe(1);
    const hiddenChanges = topologyChangePageSchema.parse(await (await get(env, env.site.id, `changes?since=${iso(inA.now - 60 * MIN)}&until=${iso(inA.now + MIN)}`)).json());
    expect(hiddenChanges.changes.filter((change) => change.kind === 'relationship_observed' || change.kind === 'collection_gap')).toEqual([]);
  });
});
