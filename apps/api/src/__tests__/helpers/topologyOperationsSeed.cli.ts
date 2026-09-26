/**
 * Seed the M3 operations fixture into a running worktree stack for the
 * Playwright gate (`e2e-tests/tests/topology-operations.spec.ts`).
 *
 * Runs INSIDE the stack's api container (apps/api/src is bind-mounted there):
 *
 *   docker compose -p <project> ... exec -T api npx tsx src/__tests__/helpers/topologyOperationsSeed.cli.ts
 *
 * Builds on the M2 `physical-enrichment` fixture (real routes, authority,
 * ingest and publisher), then adds what M3 reads: an SNMP `if_metrics`
 * telemetry source with 20 minutes of raw samples on one physical port (a
 * measured zero, a collection gap and a previous interface generation) and a
 * site monitoring policy with activation intent written through the real
 * configuration service. Nothing is armed and no command is queued here.
 * Refuses to run in production; never contacts a network.
 */
import { sql } from 'drizzle-orm';
import { closeDb, db, withSystemDbAccessContext } from '../../db';
import type { AuthContext } from '../../middleware/auth';
import { getUserPermissions } from '../../services/permissions';
import type { TopologyRequestContext } from '../../services/topology/access';
import { upsertTopologyMonitoringPolicy } from '../../services/topology/configurationObjects';
import { loadTopologyConfiguration } from '../../services/topology/siteConfiguration';
import { seedTopologyPhysicalFixture } from './topologyPhysical';

const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('refusing to seed a topology fixture in production');
  const email = process.env.E2E_ADMIN_EMAIL ?? 'admin@breeze.local';
  const { user, org, siteId } = await withSystemDbAccessContext(async () => {
    const [user] = await db.execute<{ id: string; email: string; name: string; partner_id: string }>(sql`SELECT id, email, name, partner_id FROM users WHERE email=${email} LIMIT 1`);
    if (!user?.partner_id) throw new Error(`no partner user ${email}`);
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const [org] = await db.execute<{ id: string; partner_id: string }>(sql`INSERT INTO organizations (partner_id, name, slug, currency_code)
      SELECT ${user.partner_id}::uuid, ${`Topology operations ${stamp}`}, ${`topology-operations-${stamp}-${Math.random().toString(36).slice(2, 8)}`}, currency_code
      FROM organizations WHERE partner_id=${user.partner_id}::uuid ORDER BY created_at LIMIT 1 RETURNING id, partner_id`);
    if (!org) throw new Error('admin partner has no organization to copy the currency from');
    const [site] = await db.execute<{ id: string }>(sql`INSERT INTO sites (org_id, name) VALUES (${org.id}::uuid, 'Topology operations fixture') RETURNING id`);
    return { user, org, siteId: site!.id };
  }, 'topology operations e2e seed');

  const permissions = await withSystemDbAccessContext(() => getUserPermissions(user.id, { partnerId: user.partner_id, scope: 'partner' }, { bypassCache: true }));
  if (!permissions) throw new Error('admin has no partner permissions');
  const writer: TopologyRequestContext = {
    scope: { orgId: org.id, siteId },
    auth: { user: { id: user.id, email: user.email, name: user.name }, scope: 'partner', partnerId: user.partner_id, orgId: null, accessibleOrgIds: [org.id],
      allowedSiteIds: undefined, token: { mfa: true }, principal: { kind: 'user_session' }, canAccessOrg: (candidate: string) => candidate === org.id } as unknown as AuthContext,
    permissions,
  };
  const f = await seedTopologyPhysicalFixture({ partnerId: org.partner_id, orgId: org.id, siteId }, { writer, unifiHost: `host:${org.id.slice(0, 8)}` });
  await f.publishPhysical(f.at(-9));

  // M3 exposure: port measurement and on-demand/recurring diagnostics.
  await f.system(() => db.execute(sql`UPDATE organizations SET settings = jsonb_set(settings, '{topologyFeatureFlags}',
    settings->'topologyFeatureFlags' || '{"interfaceHealth":true,"diagnostics":true}'::jsonb) WHERE id = ${org.id}::uuid`));

  const [link] = await f.q<{ id: string; source_node_id: string; target_node_id: string; port_id: string; port: string | null; epoch: string }>(sql`
    SELECT r.id, r.source_node_id, r.target_node_id, i.id AS port_id, i.name AS port, i.epoch FROM topology_relationships r
    JOIN topology_interfaces i ON i.id = r.source_interface_id
    WHERE r.org_id=${org.id}::uuid AND r.site_id=${siteId}::uuid AND r.deleted_at IS NULL AND r.lifecycle='active'
      AND r.kind='physical_link' AND r.attributes->>'method'='lldp' AND r.target_interface_id IS NOT NULL
    ORDER BY i.name LIMIT 1`);
  if (!link) throw new Error('operations seed: the physical fixture published no LLDP link with ports');

  // The physical profile has SNMP enabled but no stored secret; give it a
  // throwaway documentation community so a telemetry arm can pin a credential.
  await f.system(() => db.execute(sql`UPDATE discovery_profiles SET snmp_communities = ARRAY['e2e-public'] WHERE id = ${f.ids.profile}::uuid`));

  // One SNMP if_metrics source measuring the link's source port: 20 one-minute
  // raw samples with a 4-minute collection gap and two identical readings (a
  // measured zero rate), plus 3 samples of a previous interface generation.
  const sourceId = crypto.randomUUID();
  const now = Date.now();
  await f.system(async () => {
    for (const day of new Set([iso(now - 60 * MIN).slice(0, 10), iso(now).slice(0, 10)])) {
      await db.execute(sql`SELECT public.breeze_ensure_topology_interface_sample_partition('raw', ${day}::date)`);
    }
    await db.execute(sql`INSERT INTO topology_collection_sources (id, org_id, site_id, producer_id, producer_kind, producer_epoch, protocol, context_key, address_family,
        expected_interval_seconds, last_outcome, last_received_at, accepted_sequence, confirmed_sequence)
      VALUES (${sourceId}::uuid, ${org.id}::uuid, ${siteId}::uuid, ${f.ids.agentDevice}::uuid, 'snmp', 'e2e-p1', 'if_metrics', 'snmp:e2e-operations', 'any', 60, 'complete', now(), 30, 30)`);
    const reading = (inOctets: number, uptime: number) => ({ v: 1, expectedIntervalSeconds: 60, counterWidth: 64, inOctets: String(inOctets), outOctets: String(inOctets / 2),
      inErrors: '0', outErrors: '0', inDiscards: '0', outDiscards: '0', inPackets: null, outPackets: null, capacityBps: '1000000000', discontinuityTicks: '0',
      deviceUptimeTicks: String(uptime), reportedInBps: null, reportedOutBps: null, adminStatus: 'up', operStatus: 'up', unavailable: {} });
    const insert = (epoch: string, producer: string, sequence: number, at: number, readings: object) => db.execute(sql`INSERT INTO topology_interface_samples
        (org_id, site_id, interface_id, interface_epoch, source_id, producer_epoch, source_sequence, sampled_at, resolution, readings, sample_count)
      VALUES (${org.id}::uuid, ${siteId}::uuid, ${link.port_id}::uuid, ${epoch}, ${sourceId}::uuid, ${producer}, ${String(sequence)}, ${iso(at)}::timestamptz, 'raw', ${JSON.stringify(readings)}::jsonb, 1)`);
    for (let i = 0; i < 3; i += 1) await insert('e2e-previous-generation', 'e2e-p0', i + 1, now - (50 - i) * MIN, reading(1_000_000 + 900_000 * i, 500_000 + i * 6000));
    let octets = 0;
    for (let i = 0; i <= 20; i += 1) {
      if (i >= 8 && i <= 11) continue; // collection gap
      if (i !== 4) octets += 7_500_000; // i=4 repeats i=3: a measured zero rate
      await insert(link.epoch, 'e2e-p1', 10 + i, now - (20 - i) * MIN - 30_000, reading(octets, 1_000_000 + i * 6000));
    }
  });

  // A site policy with activation intent through the real configuration service (compile, no arm).
  const settings = await f.scoped(() => loadTopologyConfiguration(writer));
  const policy = await f.scoped(() => upsertTopologyMonitoringPolicy(writer, {
    key: 'gateway', expectedRevision: settings.settingsRevision,
    definition: { kind: 'policy', enabled: true, recipeId: 'gateway_basic', recipeVersion: 1, subject: 'reported_gateway', targetKeys: [], families: ['ipv4'],
      origin: 'original_reporter', intervalSeconds: 300, jitterPercent: 10, alertsEnabled: false, failureThreshold: 3, recoveryThreshold: 2 },
  })) as { id: string };

  const out = {
    orgId: org.id, siteId,
    nodes: { agent: f.nodes.agent, A: f.nodes.A, B: f.nodes.B, sourceNode: link.source_node_id },
    link: link.id, port: { id: link.port_id, name: link.port, epoch: link.epoch }, telemetrySourceId: sourceId, policyId: policy.id,
    collectorDeviceId: f.ids.agentDevice, credentialProfileId: f.ids.profile,
  };
  process.stdout.write(`TOPOLOGY_OPERATIONS_FIXTURE=${JSON.stringify(out)}\n`);
}

main().then(() => closeDb()).then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
