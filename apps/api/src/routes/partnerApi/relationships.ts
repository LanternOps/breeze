import { Hono } from 'hono';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  deviceIpHistory,
  deviceNetwork,
  devices,
  hypervVms,
  networkTopology,
  partnerExportDeviceMaterialState,
  partnerExportSiteMaterialState,
  sites,
} from '../../db/schema';
import { requirePartnerApiScope } from '../../middleware/partnerApiAuth';
import { acquirePartnerExportReadLocks } from './consistency';
import { getPartnerExportFetchLimit, type PartnerExportPageRow } from './pagination';
import {
  bindPartnerExportSnapshot,
  buildEnvelope,
  clientError,
  isKnownClientError,
  normalizeSourceRow,
  paginationConditions,
  paginationOrder,
  parseExportQuery,
  type ExportQueryInput,
} from './organizations';
import { deviceRelationshipsExportEnvelopeSchema } from './schemas';
import { stablePartnerExportUuid } from './identity';

export const PARTNER_RELATIONSHIP_EDGE_LIMIT = 500;

type SourceRecord = Record<string, unknown>;
type EndpointType = 'organization' | 'site' | 'device' | 'interface' | 'address' | 'virtual_machine' | 'discovered_asset';
type EdgeType = 'organization_site' | 'site_device' | 'device_interface' | 'interface_address' | 'hyperv_host_vm' | 'network_topology' | 'device_link';

interface Edge {
  key: string;
  type: EdgeType;
  from: { type: EndpointType; id: unknown };
  to: { type: EndpointType; id: unknown };
  metadata: Record<string, unknown>;
}

function records(value: unknown): SourceRecord[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is SourceRecord => !!entry && typeof entry === 'object' && !Array.isArray(entry))
    : [];
}

function stableBatchId(namespace: string, column: unknown) {
  return sql<string>`public.breeze_partner_export_stable_uuid(${namespace}, ${column})`;
}

function edgeKey(type: EdgeType, from: Edge['from'], to: Edge['to'], qualifier = ''): string {
  const identity = `${type}:${from.type}:${String(from.id)}:${to.type}:${String(to.id)}:${qualifier}`;
  return stablePartnerExportUuid('partner-export-edge', identity);
}

function edge(
  type: EdgeType,
  from: Edge['from'],
  to: Edge['to'],
  metadata: Record<string, unknown> = {},
  qualifier = '',
): Edge {
  return { key: edgeKey(type, from, to, qualifier), type, from, to, metadata };
}

function relationCollection(value: unknown, included: number) {
  if (!Number.isSafeInteger(value) || (value as number) < included || (value as number) < 0) {
    throw new TypeError('Invalid partner relationship count.');
  }
  const total = value as number;
  const complete = total === included;
  return { total, included, complete, reason: complete ? null : 'collection_limit_exceeded' as const };
}

function topologyEndpoint(type: unknown, id: unknown): Edge['from'] | null {
  if (type !== 'device' && type !== 'discovered_asset') return null;
  return { type, id };
}

function topologyEdges(row: SourceRecord): Edge[] {
  const projected: Edge[] = [];
  for (const source of records(row.topologyEdges)) {
    if (source.durable === false) continue;
    const from = topologyEndpoint(source.sourceType, source.sourceId);
    const to = topologyEndpoint(source.targetType, source.targetId);
    if (!from || !to) continue;
    projected.push(edge('network_topology', from, to, {
      connectionType: typeof source.connectionType === 'string' ? source.connectionType.slice(0, 50) : null,
      interfaceName: typeof source.interfaceName === 'string' ? source.interfaceName.slice(0, 1000) : null,
      vlan: Number.isInteger(source.vlan) && (source.vlan as number) >= 0 && (source.vlan as number) <= 4095
        ? source.vlan : null,
    }, String(source.id ?? '')));
  }
  return projected;
}

function projectDeviceRelationships(input: unknown) {
  const row = input && typeof input === 'object' && !Array.isArray(input) ? input as SourceRecord : {};
  const deviceId = row.subjectId;
  const edges: Edge[] = [edge(
    'site_device', { type: 'site', id: row.siteId }, { type: 'device', id: deviceId },
  )];
  for (const source of records(row.interfaceEdges)) {
    edges.push(edge(
      'device_interface', { type: 'device', id: deviceId }, { type: 'interface', id: source.interfaceId },
      { interfaceName: typeof source.interfaceName === 'string' ? source.interfaceName.slice(0, 1000) : null },
    ));
  }
  for (const source of records(row.addressEdges)) {
    const assignment = typeof source.assignment === 'string' ? source.assignment : 'unknown';
    edges.push(edge(
      'interface_address', { type: 'interface', id: source.interfaceId }, { type: 'address', id: source.addressId },
      { assignment, reservationEligible: assignment === 'static' },
    ));
  }
  for (const source of records(row.vmEdges)) {
    edges.push(edge(
      'hyperv_host_vm', { type: 'device', id: deviceId }, { type: 'virtual_machine', id: source.vmId },
    ));
  }
  for (const source of records(row.peerEdges)) {
    let from = { type: 'device' as const, id: deviceId };
    let to = { type: 'device' as const, id: source.deviceId };
    if (row.linkGroupRole !== 'host' && source.role === 'host') [from, to] = [to, from];
    else if (row.linkGroupRole !== 'host' && source.role !== 'host' && String(from.id) > String(to.id)) [from, to] = [to, from];
    edges.push(edge('device_link', from, to, {
      linkGroupRole: row.linkGroupRole === 'host' || source.role === 'host' ? 'host_guest' : null,
    }));
  }
  const bounded = [...new Map(edges.map((item) => [item.key, item])).values()]
    .sort((left, right) => left.key.localeCompare(right.key))
    .slice(0, PARTNER_RELATIONSHIP_EDGE_LIMIT);
  return {
    id: row.id, orgId: row.orgId, siteId: row.siteId, sourceUpdatedAt: row.updatedAt,
    subjectType: 'device' as const, deviceId, edges: bounded,
    collection: relationCollection(row.edgeCount, bounded.length),
  };
}

function projectSiteRelationships(input: unknown) {
  const row = input && typeof input === 'object' && !Array.isArray(input) ? input as SourceRecord : {};
  const edges = [
    edge('organization_site', { type: 'organization', id: row.orgId }, { type: 'site', id: row.subjectId }),
    ...topologyEdges(row),
  ];
  const bounded = [...new Map(edges.map((item) => [item.key, item])).values()]
    .sort((left, right) => left.key.localeCompare(right.key))
    .slice(0, PARTNER_RELATIONSHIP_EDGE_LIMIT);
  return {
    id: row.id, orgId: row.orgId, siteId: row.siteId, sourceUpdatedAt: row.updatedAt,
    subjectType: 'site' as const, siteSubjectId: row.subjectId, edges: bounded,
    collection: relationCollection(row.edgeCount, bounded.length),
  };
}

function mergeRows<T extends PartnerExportPageRow>(rows: T[], query: ExportQueryInput): T[] {
  return rows.sort((left, right) => {
    if (query.traversal.mode === 'incremental') {
      const updatedComparison = new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime();
      if (updatedComparison !== 0) return updatedComparison;
    }
    const idComparison = String(left.id).localeCompare(String(right.id));
    return idComparison !== 0 ? idComparison : String(left.orgId).localeCompare(String(right.orgId));
  }).slice(0, getPartnerExportFetchLimit(query.limit));
}

async function selectDeviceRows(orgIds: string[], query: ExportQueryInput) {
  const id = stableBatchId('device-relationships:device', devices.id);
  const updatedAt = sql<Date>`COALESCE(${partnerExportDeviceMaterialState.relationshipsUpdatedAt}, ${devices.partnerExportUpdatedAt})`.mapWith(devices.partnerExportUpdatedAt);
  return db.select({
    id, subjectId: devices.id, subjectType: sql<string>`'device'`, orgId: devices.orgId, siteId: devices.siteId,
    createdAt: devices.createdAt, updatedAt, linkGroupId: devices.linkGroupId, linkGroupRole: devices.linkGroupRole,
    interfaceEdges: sql<unknown[]>`COALESCE((SELECT jsonb_agg(item ORDER BY item->>'interfaceId') FROM (
      SELECT jsonb_build_object(
        'interfaceId', md5('interface:' || n.device_id::text || ':' || n.interface_name || ':' || COALESCE(n.mac_address, ''))::uuid,
        'interfaceName', n.interface_name
      ) item FROM ${deviceNetwork} n WHERE n.device_id = ${devices.id} AND n.org_id = ${devices.orgId}
      ORDER BY n.interface_name, n.mac_address NULLS LAST LIMIT ${PARTNER_RELATIONSHIP_EDGE_LIMIT}
    ) bounded), '[]'::jsonb)`,
    addressEdges: sql<unknown[]>`COALESCE((SELECT jsonb_agg(item ORDER BY item->>'addressId') FROM (
      SELECT jsonb_build_object(
        'addressId', md5('address:' || a.device_id::text || ':' || a.interface_name || ':' || a.ip_address || ':' || a.ip_type)::uuid,
        'interfaceId', md5('interface:' || a.device_id::text || ':' || a.interface_name || ':' || COALESCE(a.mac_address, ''))::uuid,
        'assignment', a.assignment_type
      ) item FROM ${deviceIpHistory} a WHERE a.device_id = ${devices.id} AND a.org_id = ${devices.orgId}
      ORDER BY a.interface_name, a.ip_address, a.ip_type LIMIT ${PARTNER_RELATIONSHIP_EDGE_LIMIT}
    ) bounded), '[]'::jsonb)`,
    vmEdges: sql<unknown[]>`COALESCE((SELECT jsonb_agg(item ORDER BY item->>'vmId') FROM (
      SELECT jsonb_build_object('vmId', md5('hyperv-vm:' || v.device_id::text || ':' || v.vm_id)::uuid) item
      FROM ${hypervVms} v WHERE v.device_id = ${devices.id} AND v.org_id = ${devices.orgId}
      ORDER BY v.vm_id LIMIT ${PARTNER_RELATIONSHIP_EDGE_LIMIT}
    ) bounded), '[]'::jsonb)`,
    peerEdges: sql<unknown[]>`COALESCE((SELECT jsonb_agg(item ORDER BY item->>'deviceId') FROM (
      SELECT jsonb_build_object('deviceId', p.id, 'role', p.link_group_role) item
      FROM ${devices} p WHERE p.link_group_id = ${devices.linkGroupId} AND p.org_id = ${devices.orgId} AND p.id <> ${devices.id}
      ORDER BY p.id LIMIT ${PARTNER_RELATIONSHIP_EDGE_LIMIT}
    ) bounded), '[]'::jsonb)`,
    edgeCount: sql<number>`(
      1
      + (SELECT COUNT(*) FROM ${deviceNetwork} n WHERE n.device_id = ${devices.id} AND n.org_id = ${devices.orgId})
      + (SELECT COUNT(*) FROM ${deviceIpHistory} a WHERE a.device_id = ${devices.id} AND a.org_id = ${devices.orgId})
      + (SELECT COUNT(*) FROM ${hypervVms} v WHERE v.device_id = ${devices.id} AND v.org_id = ${devices.orgId})
      + (SELECT COUNT(*) FROM ${devices} p WHERE p.link_group_id = ${devices.linkGroupId} AND p.org_id = ${devices.orgId} AND p.id <> ${devices.id})
    )::integer`,
  }).from(devices)
    .leftJoin(partnerExportDeviceMaterialState, and(
      eq(partnerExportDeviceMaterialState.deviceId, devices.id), eq(partnerExportDeviceMaterialState.orgId, devices.orgId),
    ))
    .where(and(
      inArray(devices.orgId, orgIds), ...(query.siteId ? [eq(devices.siteId, query.siteId)] : []),
      ...paginationConditions({ id, orgId: devices.orgId, createdAt: devices.createdAt, updatedAt, updatedAtParam: partnerExportDeviceMaterialState.relationshipsUpdatedAt }, query.traversal),
    ))
    .orderBy(...paginationOrder({ id, orgId: devices.orgId, updatedAt }, query.traversal))
    .limit(getPartnerExportFetchLimit(query.limit));
}

async function selectSiteRows(orgIds: string[], query: ExportQueryInput) {
  const id = stableBatchId('device-relationships:site', sites.id);
  const updatedAt = sql<Date>`COALESCE(${partnerExportSiteMaterialState.relationshipsUpdatedAt}, ${sites.partnerExportUpdatedAt})`.mapWith(sites.partnerExportUpdatedAt);
  const topologyLimit = PARTNER_RELATIONSHIP_EDGE_LIMIT - 1;
  return db.select({
    id, subjectId: sites.id, subjectType: sql<string>`'site'`, orgId: sites.orgId, siteId: sites.id,
    createdAt: sites.createdAt, updatedAt,
    topologyEdges: sql<unknown[]>`COALESCE((SELECT jsonb_agg(item ORDER BY item->>'id') FROM (
      SELECT jsonb_build_object(
        'id', t.id, 'sourceType', t.source_type, 'sourceId', t.source_id,
        'targetType', t.target_type, 'targetId', t.target_id,
        'connectionType', t.connection_type, 'interfaceName', t.interface_name, 'vlan', t.vlan
      ) item FROM ${networkTopology} t
      WHERE t.site_id = ${sites.id} AND t.org_id = ${sites.orgId}
        AND t.source_type IN ('device', 'discovered_asset') AND t.target_type IN ('device', 'discovered_asset')
        AND (t.source_type = 'device' OR EXISTS (
          SELECT 1 FROM public.discovered_assets source_asset
          WHERE source_asset.id = t.source_id AND source_asset.org_id = t.org_id
            AND source_asset.approval_status = 'approved'
            AND source_asset.asset_type IN ('router', 'switch', 'firewall', 'access_point', 'nas')
        ))
        AND (t.target_type = 'device' OR EXISTS (
          SELECT 1 FROM public.discovered_assets target_asset
          WHERE target_asset.id = t.target_id AND target_asset.org_id = t.org_id
            AND target_asset.approval_status = 'approved'
            AND target_asset.asset_type IN ('router', 'switch', 'firewall', 'access_point', 'nas')
        ))
      ORDER BY t.id LIMIT ${topologyLimit}
    ) bounded), '[]'::jsonb)`,
    edgeCount: sql<number>`(1 + (
      SELECT COUNT(*) FROM ${networkTopology} t
      WHERE t.site_id = ${sites.id} AND t.org_id = ${sites.orgId}
        AND t.source_type IN ('device', 'discovered_asset') AND t.target_type IN ('device', 'discovered_asset')
        AND (t.source_type = 'device' OR EXISTS (
          SELECT 1 FROM public.discovered_assets source_asset
          WHERE source_asset.id = t.source_id AND source_asset.org_id = t.org_id
            AND source_asset.approval_status = 'approved'
            AND source_asset.asset_type IN ('router', 'switch', 'firewall', 'access_point', 'nas')
        ))
        AND (t.target_type = 'device' OR EXISTS (
          SELECT 1 FROM public.discovered_assets target_asset
          WHERE target_asset.id = t.target_id AND target_asset.org_id = t.org_id
            AND target_asset.approval_status = 'approved'
            AND target_asset.asset_type IN ('router', 'switch', 'firewall', 'access_point', 'nas')
        ))
    ))::integer`,
  }).from(sites)
    .leftJoin(partnerExportSiteMaterialState, and(
      eq(partnerExportSiteMaterialState.siteId, sites.id), eq(partnerExportSiteMaterialState.orgId, sites.orgId),
    ))
    .where(and(
      inArray(sites.orgId, orgIds), ...(query.siteId ? [eq(sites.id, query.siteId)] : []),
      ...paginationConditions({ id, orgId: sites.orgId, createdAt: sites.createdAt, updatedAt, updatedAtParam: partnerExportSiteMaterialState.relationshipsUpdatedAt }, query.traversal),
    ))
    .orderBy(...paginationOrder({ id, orgId: sites.orgId, updatedAt }, query.traversal))
    .limit(getPartnerExportFetchLimit(query.limit));
}

export const partnerRelationshipRoutes = new Hono();

partnerRelationshipRoutes.get('/device-relationships', requirePartnerApiScope('inventory:read'), async (c) => {
  const principal = c.get('partnerApiPrincipal');
  const parsed = parseExportQuery(c, 'device-relationships', principal);
  if (parsed instanceof Response) return parsed;
  try {
    const orgIds = parsed.orgId ? [parsed.orgId] : principal.accessibleOrgIds;
    bindPartnerExportSnapshot(parsed, await acquirePartnerExportReadLocks(orgIds));
    const rows = orgIds.length > 0 ? await (async () => {
      const [deviceRows, siteRows] = await Promise.all([selectDeviceRows(orgIds, parsed), selectSiteRows(orgIds, parsed)]);
      return mergeRows([...deviceRows, ...siteRows].map(normalizeSourceRow), parsed);
    })() : [];
    const envelope = buildEnvelope({
      resource: 'device-relationships', partnerId: principal.partnerId, rows, query: parsed,
      makeRecord: (row) => row.subjectType === 'site' ? projectSiteRelationships(row) : projectDeviceRelationships(row),
    });
    return c.json(deviceRelationshipsExportEnvelopeSchema.parse(envelope));
  } catch (error) {
    if (isKnownClientError(error)) return clientError(c, error);
    return c.json({ error: 'Partner device relationship export failed.', code: 'partner_export_failed' }, 500);
  }
});
