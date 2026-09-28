/**
 * Seed the `physical-enrichment` fixture into a running worktree stack for the
 * Playwright gate (`e2e-tests/tests/topology-physical.spec.ts`).
 *
 * Runs INSIDE the stack's api container (apps/api/src is bind-mounted there):
 *
 *   docker compose -p <project> ... exec -T api npx tsx src/__tests__/helpers/topologyPhysicalSeed.cli.ts
 *
 * It creates a fresh organization + site under the seeded admin's partner, then drives
 * `seedTopologyPhysicalFixture` — the same real routes, authority, ingest and
 * publisher the vertical integration test uses — and prints one JSON line of
 * ids for the spec. Refuses to run in production. Never contacts a network:
 * the switches and the controller are simulated at the transport boundary.
 */
import { sql } from 'drizzle-orm';
import { closeDb, db, withSystemDbAccessContext } from '../../db';
import type { AuthContext } from '../../middleware/auth';
import { getUserPermissions } from '../../services/permissions';
import type { TopologyRequestContext } from '../../services/topology/access';
import { PHYSICAL_FIXTURE, seedTopologyPhysicalFixture } from './topologyPhysical';

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('refusing to seed a topology fixture in production');
  const email = process.env.E2E_ADMIN_EMAIL ?? 'admin@breeze.local';
  const { user, org, siteId } = await withSystemDbAccessContext(async () => {
    const [user] = await db.execute<{ id: string; email: string; name: string; partner_id: string }>(sql`SELECT id, email, name, partner_id FROM users WHERE email=${email} LIMIT 1`);
    if (!user?.partner_id) throw new Error(`no partner user ${email}`);
    // A fresh organization per run: the fixture's documentation-range switch IPs are unique per org.
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const [org] = await db.execute<{ id: string; partner_id: string }>(sql`INSERT INTO organizations (partner_id, name, slug, currency_code)
      SELECT ${user.partner_id}::uuid, ${`Physical topology ${stamp}`}, ${`physical-topology-${stamp}-${Math.random().toString(36).slice(2, 8)}`}, currency_code
      FROM organizations WHERE partner_id=${user.partner_id}::uuid ORDER BY created_at LIMIT 1 RETURNING id, partner_id`);
    if (!org) throw new Error('admin partner has no organization to copy the currency from');
    const [site] = await db.execute<{ id: string }>(sql`INSERT INTO sites (org_id, name) VALUES (${org.id}::uuid, 'Physical topology fixture') RETURNING id`);
    return { user, org, siteId: site!.id };
  }, 'topology physical e2e seed');

  const permissions = await withSystemDbAccessContext(() => getUserPermissions(user.id, { partnerId: user.partner_id, scope: 'partner' }, { bypassCache: true }));
  if (!permissions) throw new Error('admin has no partner permissions');
  const writer: TopologyRequestContext = {
    scope: { orgId: org.id, siteId },
    auth: { user: { id: user.id, email: user.email, name: user.name }, scope: 'partner', partnerId: user.partner_id, orgId: null, accessibleOrgIds: [org.id],
      allowedSiteIds: undefined, token: { mfa: true }, canAccessOrg: (candidate: string) => candidate === org.id } as unknown as AuthContext,
    permissions,
  };
  const f = await seedTopologyPhysicalFixture({ partnerId: org.partner_id, orgId: org.id, siteId }, { writer, unifiHost: `host:${org.id.slice(0, 8)}` });
  await f.publishPhysical(f.at(-9));

  const rows = await f.q<{ id: string; kind: string; method: string | null; association: string | null; source_node_id: string; target_node_id: string;
    fdb_selection: string | null; legacy: boolean; port: string | null }>(sql`
    SELECT r.id, r.kind, r.attributes->>'method' AS method, r.attributes->'physical'->>'association' AS association, r.source_node_id, r.target_node_id,
      r.attributes->'physical'->>'fdbSelection' AS fdb_selection, (r.legacy_source_id IS NOT NULL) AS legacy, i.name AS port
    FROM topology_relationships r LEFT JOIN topology_interfaces i ON i.id = r.source_interface_id
    WHERE r.org_id=${org.id}::uuid AND r.site_id=${siteId}::uuid AND r.deleted_at IS NULL AND r.lifecycle='active' ORDER BY r.id`);
  const links = rows.filter(r => r.kind === 'physical_link' && r.method === 'lldp').sort((a, b) => String(a.port).localeCompare(String(b.port)));
  const touches = (r: { source_node_id: string; target_node_id: string }, node: string) => r.source_node_id === node || r.target_node_id === node;
  const out = {
    orgId: org.id, siteId, nodes: f.nodes, pins: PHYSICAL_FIXTURE.pins,
    relationships: {
      parallelA: links[0]?.id, parallelB: links[1]?.id,
      fdbOnly: rows.find(r => r.method === 'fdb' && touches(r, f.nodes.agent))?.id,
      competing: rows.filter(r => r.method === 'fdb' && touches(r, f.nodes.desk)).map(r => r.id),
      vpn: rows.find(r => r.association === 'vpn')?.id, wireless: rows.find(r => r.association === 'wireless')?.id,
      uplink: rows.find(r => r.association === 'uplink')?.id,
      legacy: rows.find(r => r.legacy && touches(r, f.nodes.A) && touches(r, f.nodes.B))?.id,
    },
    ports: { parallelA: links[0]?.port, parallelB: links[1]?.port },
  };
  process.stdout.write(`TOPOLOGY_PHYSICAL_FIXTURE=${JSON.stringify(out)}\n`);
}

main().then(() => closeDb()).then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
