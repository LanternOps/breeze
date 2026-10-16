import { sql } from 'drizzle-orm';
import { topologyNetworkClass, type TopologyScope } from '@breeze/shared';
import type { db } from '../../db';
import { nodeFilter, observedAtSql, observedFreshUntilSql, relationshipFilter, scoped, type ReadExposure } from './graphRead';
import { parseIpAddress, parsePrefix } from './ipAddress';
import { addressKey, buildNeighborEvidenceIndex, readNeighborEvidence, type NeighborEvidenceIndex } from './neighborEvidence';
import type { PresenceAttachment } from './presenceClassifier';

/**
 * Presence inputs (site location W2, spec S§5, S§6.1, S§6.3,
 * docs/superpowers/specs/monitoring/2026-10-03-topology-site-location-design.md).
 *
 * One bounded read per site graph: the published `network_member` + `default_route` relationships of every
 * endpoint bound to a live device whose CURRENT `devices.site_id` is this site (a device is observed only in its
 * assigned site's graph; a binding left behind in a former site's graph never counts), plus the site's published
 * neighbour baselines for the gateway MACs. From it come both
 *   - device attachments (classification input; the classifier drops anything not fresh now), and
 *   - anchor evidence for this site's fingerprints (S§6.3: confirmed within the anchor horizon, devices assigned to
 *     this site only — inference from other sites' agents never anchors, and nothing anchors an undeclared prefix).
 * Reads only; never writes, never touches devices.site_id.
 */

/** Relationship rows read per site (memberships + default routes). Beyond it the org's coverage is limited. */
export const PRESENCE_RELATIONSHIP_CAP = 20_000;

/** The overview's exposure without the physical layer: presence uses only logical evidence. */
const LOGICAL_EXPOSURE: ReadExposure = { physical: false, excluded: new Set() };

type MembershipRow = {
  id: string; endpointId: string; prefix: string | null; interfaceId: string | null; interfaceKind: string | null;
  interfaceName: string | null; context: string | null; freshUntil: string | null; observedAt: string | null;
};
type RouteRow = {
  id: string; endpointId: string; address: string | null; interfaceId: string | null; context: string | null;
  freshUntil: string | null; observedAt: string | null;
};
type BindingRow = { nodeId: string; deviceId: string };
export type SiteObservations = { memberships: MembershipRow[]; routes: RouteRow[]; bindings: BindingRow[]; truncated: boolean };

/** Attachment plus the gateway MAC as seen within the anchor horizon (fingerprint input). */
export type ObservedAttachment = PresenceAttachment & { anchorMac: string | null };

const iso = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const time = new Date(value as string).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

/** Read the site's published logical attachments within `horizonSeconds` of now (0 = fresh only). */
export async function readSiteObservations(tx: Pick<typeof db, 'execute'>, scope: TopologyScope, horizonSeconds: number): Promise<SiteObservations> {
  const siteNodes = nodeFilter(scope, { view: 'overview', hops: 1, includeHealth: false, limit: 1 }, 'n', LOGICAL_EXPOSURE);
  const horizon = Math.max(0, Math.floor(horizonSeconds));
  const [row] = await tx.execute<{ memberships: unknown; routes: unknown; bindings: unknown; total: number | string }>(sql`WITH bound AS MATERIALIZED (
      SELECT DISTINCT ON (b.node_id) b.node_id, b.device_id FROM topology_node_bindings b
        JOIN devices d ON d.id = b.device_id AND d.org_id = b.org_id
      WHERE ${scoped(scope, 'b')} AND b.device_id IS NOT NULL AND d.site_id = ${scope.siteId}::uuid AND d.status <> 'decommissioned'
      ORDER BY b.node_id, b.id
    ), site_nodes AS MATERIALIZED (
      SELECT n.id, n.kind, n.attributes FROM topology_nodes n WHERE ${siteNodes}
    ), rels AS MATERIALIZED (
      SELECT r.id, r.kind, r.source_node_id, r.target_node_id, r.source_interface_id, r.logical_context->>'contextKey' AS context,
        ${observedFreshUntilSql('r')} AS fresh_until, ${observedAtSql('r')} AS observed_at
      FROM topology_relationships r
      WHERE ${relationshipFilter(scope, 'overview', 'r', LOGICAL_EXPOSURE)} AND r.kind IN ('network_member', 'default_route')
        AND EXISTS (SELECT 1 FROM bound bd WHERE bd.node_id = r.source_node_id)
        AND EXISTS (SELECT 1 FROM site_nodes t WHERE t.id = r.target_node_id)
    ), current_rels AS MATERIALIZED (
      SELECT * FROM rels WHERE fresh_until > now() - make_interval(secs => ${horizon})
      ORDER BY id LIMIT ${PRESENCE_RELATIONSHIP_CAP + 1}
    ) SELECT
      (SELECT count(*) FROM current_rels) AS total,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'endpointId', m.source_node_id, 'prefix', t.attributes->>'prefix',
          'interfaceId', m.source_interface_id, 'interfaceKind', i.kind, 'interfaceName', nullif(btrim(i.name), ''), 'context', m.context,
          'freshUntil', m.fresh_until, 'observedAt', m.observed_at) ORDER BY m.id), '[]'::jsonb)
        FROM current_rels m JOIN site_nodes t ON t.id = m.target_node_id AND t.kind = 'network'
          LEFT JOIN topology_interfaces i ON i.id = m.source_interface_id AND ${scoped(scope, 'i')}
        WHERE m.kind = 'network_member') AS memberships,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'endpointId', r.source_node_id, 'address', nullif(btrim(g.attributes->>'label'), ''),
          'interfaceId', r.source_interface_id, 'context', r.context, 'freshUntil', r.fresh_until, 'observedAt', r.observed_at) ORDER BY r.id), '[]'::jsonb)
        FROM current_rels r JOIN site_nodes g ON g.id = r.target_node_id AND g.kind = 'gateway'
        WHERE r.kind = 'default_route') AS routes,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('nodeId', bd.node_id, 'deviceId', bd.device_id) ORDER BY bd.node_id), '[]'::jsonb) FROM bound bd) AS bindings`);
  const truncated = Number(row?.total ?? 0) > PRESENCE_RELATIONSHIP_CAP;
  const list = <T>(value: unknown): T[] => (Array.isArray(value) ? value as T[] : []);
  return { memberships: list<MembershipRow>(row?.memberships), routes: list<RouteRow>(row?.routes), bindings: list<BindingRow>(row?.bindings), truncated };
}

const ipv4Address = (text: string | null | undefined): string | null => {
  if (typeof text !== 'string') return null;
  const parsed = parseIpAddress(text.split('%')[0]!.trim());
  if (!parsed || parsed.family !== 4) return null;
  return [24n, 16n, 8n, 0n].map((shift) => Number((parsed.value >> shift) & 255n)).join('.');
};
/** Canonical IPv4 CIDR with host bits zeroed, or null. */
const ipv4Prefix = (text: string | null | undefined): string | null => {
  if (typeof text !== 'string') return null;
  const parsed = parsePrefix(text.trim());
  if (!parsed || parsed.family !== 4) return null;
  const hostBits = BigInt(32 - parsed.length);
  const network = (parsed.value >> hostBits) << hostBits;
  return `${[24n, 16n, 8n, 0n].map((shift) => Number((network >> shift) & 255n)).join('.')}/${parsed.length}`;
};

/**
 * NC gateway policy (presentationGroups `gatewayMac`): the observer's own qualifying cache row for the route's exact
 * next hop, in its OS context, on its interface. Only under complete neighbour coverage, and only when exactly one MAC
 * is mapped (S§6.1).
 */
function gatewayMacFor(index: NeighborEvidenceIndex | null, route: RouteRow, gateway: string): string | null {
  if (!index || index.coverage !== 'complete' || !route.interfaceId || !route.context) return null;
  const key = addressKey(gateway);
  if (!key) return null;
  const tuples = (index.byAddress.get(key) ?? []).filter((tuple) => tuple.observerNodeId === route.endpointId && tuple.context === route.context
    && tuple.interfaceId === route.interfaceId && tuple.family === 4 && tuple.networkClass === 'lan');
  const macs = new Set(tuples.map((tuple) => tuple.mac));
  return macs.size === 1 ? [...macs][0]! : null;
}

/**
 * Pure: pair memberships with the same endpoint's default routes (S§6.1) into attachments, per bound device.
 * IPv4 `lan` prefixes only (tunnel / overlay / link-local / host never attach); a route pairs with a membership on
 * the same interface and context, or — interface unknown — with the endpoint's only IPv4 LAN membership. One
 * attachment per gateway address. `freshUntil` is the earlier of the membership's and the route's, so both must still
 * be fresh; `confirmedAt` is the earlier of their confirmation times.
 */
export function assembleAttachments(
  obs: SiteObservations, neighbors: { fresh: NeighborEvidenceIndex | null; anchor: NeighborEvidenceIndex | null },
): Map<string, ObservedAttachment[]> {
  const deviceOf = new Map(obs.bindings.map((b) => [b.nodeId, b.deviceId]));
  const lan = obs.memberships.flatMap((m) => {
    const prefix = ipv4Prefix(m.prefix);
    if (!prefix || topologyNetworkClass(prefix, m.interfaceKind) !== 'lan') return [];
    return [{ ...m, prefix }];
  });
  const lanCount = new Map<string, number>();
  for (const m of lan) lanCount.set(m.endpointId, (lanCount.get(m.endpointId) ?? 0) + 1);
  const routesBy = new Map<string, RouteRow[]>();
  for (const route of obs.routes) routesBy.set(route.endpointId, [...(routesBy.get(route.endpointId) ?? []), route]);

  const out = new Map<string, ObservedAttachment[]>();
  for (const m of lan) {
    const deviceId = deviceOf.get(m.endpointId);
    if (!deviceId) continue;
    const single = lanCount.get(m.endpointId) === 1;
    for (const route of routesBy.get(m.endpointId) ?? []) {
      const gateway = ipv4Address(route.address);
      if (!gateway) continue;
      const sameInterface = route.interfaceId && m.interfaceId ? route.interfaceId === m.interfaceId : single;
      const sameContext = !route.context || !m.context || route.context === m.context;
      if (!sameInterface || !sameContext) continue;
      const freshUntil = [iso(m.freshUntil), iso(route.freshUntil)].filter((v): v is string => !!v).sort()[0];
      const confirmedAt = [iso(m.observedAt), iso(route.observedAt)].filter((v): v is string => !!v).sort()[0];
      if (!freshUntil || !confirmedAt) continue;
      const list = out.get(deviceId) ?? [];
      list.push({
        prefix: m.prefix, gateway, mac: gatewayMacFor(neighbors.fresh, route, gateway), anchorMac: gatewayMacFor(neighbors.anchor, route, gateway),
        confirmedAt, freshUntil, relationshipIds: [m.id, route.id].sort(), observerNodeId: m.endpointId, interfaceName: m.interfaceName ?? null,
      });
      out.set(deviceId, list);
    }
  }
  return out;
}

export type SitePresenceInputs = {
  /** Every live device assigned to this site and bound to an endpoint of its graph (sorted). */
  devices: string[];
  /** deviceId -> attachments (confirmed within the horizon; the classifier keeps the fresh ones). */
  attachments: Map<string, ObservedAttachment[]>;
  neighborCoverage: 'complete' | 'limited';
  truncated: boolean;
};

/** Devices assigned to `scope.siteId`: attachments within `horizonSeconds`, with fresh and anchor-horizon gateway MACs. */
export async function readSitePresenceInputs(
  tx: Pick<typeof db, 'execute'>, scope: TopologyScope, now: Date, horizonSeconds: number,
): Promise<SitePresenceInputs> {
  const obs = await readSiteObservations(tx, scope, horizonSeconds);
  const gateways = new Set<string>();
  for (const route of obs.routes) { const gateway = ipv4Address(route.address); if (gateway) gateways.add(gateway); }
  const read = await readNeighborEvidence(tx, scope, 'overview', LOGICAL_EXPOSURE, gateways);
  const fresh = buildNeighborEvidenceIndex(read, now);
  const anchor = buildNeighborEvidenceIndex(read, now, { freshnessHorizonSeconds: horizonSeconds });
  const devices = [...new Set(obs.bindings.map((b) => b.deviceId))].sort();
  return { devices, attachments: assembleAttachments(obs, { fresh, anchor }), neighborCoverage: read.limited ? 'limited' : fresh.coverage, truncated: obs.truncated };
}

export type AnchorEvidence = { prefix: string; gateway: string; observerDeviceId: string; mac: string | null; confirmedAt: string };

/** Pure: S§6.3 anchor evidence for `prefixes` from a site's own inputs (devices assigned to that site only). */
export function anchorEvidenceFrom(inputs: SitePresenceInputs, prefixes: Iterable<string>): AnchorEvidence[] {
  const wanted = new Set(prefixes);
  const out: AnchorEvidence[] = [];
  for (const [deviceId, attachments] of inputs.attachments) {
    for (const a of attachments) {
      if (wanted.has(a.prefix)) out.push({ prefix: a.prefix, gateway: a.gateway, observerDeviceId: deviceId, mac: a.anchorMac, confirmedAt: a.confirmedAt });
    }
  }
  return out.sort((x, y) => x.prefix.localeCompare(y.prefix) || x.gateway.localeCompare(y.gateway) || x.observerDeviceId.localeCompare(y.observerDeviceId));
}

/** Plan W2 Task 4 interface: anchor evidence for one declaring site, within the horizon. */
export async function readSiteAnchorEvidence(
  tx: Pick<typeof db, 'execute'>, scope: TopologyScope, prefixes: string[], horizonSeconds: number, now = new Date(),
): Promise<{ evidence: AnchorEvidence[]; neighborCoverage: 'complete' | 'limited' }> {
  const inputs = await readSitePresenceInputs(tx, scope, now, horizonSeconds);
  return { evidence: anchorEvidenceFrom(inputs, prefixes), neighborCoverage: inputs.neighborCoverage };
}

/** Plan W2 Task 4 interface: the fresh attachments of devices assigned to the site. */
export async function readDeviceAttachments(tx: Pick<typeof db, 'execute'>, scope: TopologyScope, now = new Date()): Promise<Map<string, PresenceAttachment[]>> {
  const inputs = await readSitePresenceInputs(tx, scope, now, 0);
  const out = new Map<string, PresenceAttachment[]>();
  for (const [deviceId, attachments] of inputs.attachments) {
    const fresh = attachments.filter((a) => Date.parse(a.freshUntil) > now.getTime()).map(({ anchorMac: _anchor, ...a }) => a);
    if (fresh.length) out.set(deviceId, fresh);
  }
  return out;
}
