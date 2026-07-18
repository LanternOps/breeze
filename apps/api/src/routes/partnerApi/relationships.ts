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
import {
  PARTNER_EXPORT_DERIVED_ID_NAMESPACE,
  stablePartnerExportUuid,
} from './identity';

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
  const interfaceIds = new Set(records(row.interfaceEdges).map((source) => String(source.interfaceId)));
  for (const source of records(row.addressEdges)) {
    if (!interfaceIds.has(String(source.interfaceId))) continue;
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
        'interfaceId', public.breeze_partner_export_stable_uuid(
          ${PARTNER_EXPORT_DERIVED_ID_NAMESPACE.interface},
          array_to_json(ARRAY[n.device_id::text, n.interface_name, COALESCE(n.mac_address, '')]::text[])::text
        ),
        'interfaceName', n.interface_name
      ) item FROM ${deviceNetwork} n WHERE n.device_id = ${devices.id} AND n.org_id = ${devices.orgId}
      ORDER BY n.interface_name, n.mac_address NULLS LAST LIMIT ${PARTNER_RELATIONSHIP_EDGE_LIMIT}
    ) bounded), '[]'::jsonb)`,
    addressEdges: sql<unknown[]>`COALESCE((SELECT jsonb_agg(item ORDER BY item->>'addressId') FROM (
      SELECT jsonb_build_object(
        'addressId', public.breeze_partner_export_stable_uuid(
          ${PARTNER_EXPORT_DERIVED_ID_NAMESPACE.address},
          array_to_json(ARRAY[a.device_id::text, resolved_interface.interface_name, a.ip_address, a.ip_type]::text[])::text
        ),
        'interfaceId', public.breeze_partner_export_stable_uuid(
          ${PARTNER_EXPORT_DERIVED_ID_NAMESPACE.interface},
          array_to_json(ARRAY[
            a.device_id::text, resolved_interface.interface_name, COALESCE(resolved_interface.mac_address, '')
          ]::text[])::text
        ),
        'assignment', a.assignment_type
      ) item FROM ${deviceIpHistory} a
      JOIN LATERAL (
        SELECT current_interface.interface_name, current_interface.mac_address
        FROM ${deviceNetwork} current_interface
        WHERE current_interface.device_id = a.device_id AND current_interface.org_id = a.org_id
          AND current_interface.interface_name = a.interface_name
        ORDER BY
          CASE WHEN a.mac_address IS NOT NULL AND current_interface.mac_address = a.mac_address THEN 0 ELSE 1 END,
          current_interface.mac_address ASC NULLS LAST,
          current_interface.id
        LIMIT 1
      ) resolved_interface ON TRUE
      WHERE a.device_id = ${devices.id} AND a.org_id = ${devices.orgId}
      ORDER BY a.interface_name, a.ip_address, a.ip_type LIMIT ${PARTNER_RELATIONSHIP_EDGE_LIMIT}
    ) bounded), '[]'::jsonb)`,
    vmEdges: sql<unknown[]>`COALESCE((SELECT jsonb_agg(item ORDER BY item->>'vmId') FROM (
      SELECT jsonb_build_object(
        'vmId', public.breeze_partner_export_stable_uuid(
          ${PARTNER_EXPORT_DERIVED_ID_NAMESPACE.virtualMachine},
          array_to_json(ARRAY[v.device_id::text, v.vm_id]::text[])::text
        )
      ) item
      FROM ${hypervVms} v WHERE v.device_id = ${devices.id} AND v.org_id = ${devices.orgId}
      ORDER BY v.vm_id LIMIT ${PARTNER_RELATIONSHIP_EDGE_LIMIT}
    ) bounded), '[]'::jsonb)`,
    peerEdges: sql<unknown[]>`COALESCE((SELECT jsonb_agg(item ORDER BY item->>'deviceId') FROM (
      SELECT jsonb_build_object('deviceId', p.id, 'role', p.link_group_role) item
      FROM ${devices} p WHERE p.link_group_id = ${devices.linkGroupId}
        AND p.org_id = ${devices.orgId} AND p.id <> ${devices.id}
      ORDER BY p.id LIMIT ${PARTNER_RELATIONSHIP_EDGE_LIMIT}
    ) bounded), '[]'::jsonb)`,
    edgeCount: sql<number>`(
      1
      + (SELECT COUNT(*) FROM ${deviceNetwork} n WHERE n.device_id = ${devices.id} AND n.org_id = ${devices.orgId})
      + (SELECT COUNT(*) FROM ${deviceIpHistory} a
          WHERE a.device_id = ${devices.id} AND a.org_id = ${devices.orgId}
            AND EXISTS (
              SELECT 1 FROM ${deviceNetwork} current_interface
              WHERE current_interface.device_id = a.device_id AND current_interface.org_id = a.org_id
                AND current_interface.interface_name = a.interface_name
            ))
      + (SELECT COUNT(*) FROM ${hypervVms} v WHERE v.device_id = ${devices.id} AND v.org_id = ${devices.orgId})
      + (SELECT COUNT(*) FROM ${devices} p WHERE p.link_group_id = ${devices.linkGroupId}
          AND p.org_id = ${devices.orgId} AND p.id <> ${devices.id})
    )::integer`,
  }).from(devices)
    .innerJoin(sites, and(eq(sites.id, devices.siteId), eq(sites.orgId, devices.orgId)))
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
        AND (t.source_type <> 'device' OR EXISTS (
          SELECT 1 FROM public.devices endpoint_device
          WHERE endpoint_device.id = t.source_id AND endpoint_device.org_id = t.org_id
            AND endpoint_device.site_id = t.site_id
        ))
        AND (t.source_type <> 'discovered_asset' OR EXISTS (
          SELECT 1 FROM (
            SELECT endpoint_asset.id FROM public.discovered_assets endpoint_asset
            WHERE endpoint_asset.org_id = t.org_id AND endpoint_asset.site_id = t.site_id
              AND endpoint_asset.approval_status = 'approved'
              AND endpoint_asset.asset_type IN ('printer', 'router', 'switch', 'firewall', 'access_point', 'nas')
            ORDER BY endpoint_asset.id LIMIT ${PARTNER_RELATIONSHIP_EDGE_LIMIT}
          ) exported_asset WHERE exported_asset.id = t.source_id
        ))
        AND (t.target_type <> 'device' OR EXISTS (
          SELECT 1 FROM public.devices endpoint_device
          WHERE endpoint_device.id = t.target_id AND endpoint_device.org_id = t.org_id
            AND endpoint_device.site_id = t.site_id
        ))
        AND (t.target_type <> 'discovered_asset' OR EXISTS (
          SELECT 1 FROM (
            SELECT endpoint_asset.id FROM public.discovered_assets endpoint_asset
            WHERE endpoint_asset.org_id = t.org_id AND endpoint_asset.site_id = t.site_id
              AND endpoint_asset.approval_status = 'approved'
              AND endpoint_asset.asset_type IN ('printer', 'router', 'switch', 'firewall', 'access_point', 'nas')
            ORDER BY endpoint_asset.id LIMIT ${PARTNER_RELATIONSHIP_EDGE_LIMIT}
          ) exported_asset WHERE exported_asset.id = t.target_id
        ))
      ORDER BY t.id LIMIT ${topologyLimit}
    ) bounded), '[]'::jsonb)`,
    edgeCount: sql<number>`(1 + (
      SELECT COUNT(*) FROM ${networkTopology} t
      WHERE t.site_id = ${sites.id} AND t.org_id = ${sites.orgId}
        AND t.source_type IN ('device', 'discovered_asset') AND t.target_type IN ('device', 'discovered_asset')
        AND (t.source_type <> 'device' OR EXISTS (
          SELECT 1 FROM public.devices endpoint_device
          WHERE endpoint_device.id = t.source_id AND endpoint_device.org_id = t.org_id
            AND endpoint_device.site_id = t.site_id
        ))
        AND (t.source_type <> 'discovered_asset' OR EXISTS (
          SELECT 1 FROM (
            SELECT endpoint_asset.id FROM public.discovered_assets endpoint_asset
            WHERE endpoint_asset.org_id = t.org_id AND endpoint_asset.site_id = t.site_id
              AND endpoint_asset.approval_status = 'approved'
              AND endpoint_asset.asset_type IN ('printer', 'router', 'switch', 'firewall', 'access_point', 'nas')
            ORDER BY endpoint_asset.id LIMIT ${PARTNER_RELATIONSHIP_EDGE_LIMIT}
          ) exported_asset WHERE exported_asset.id = t.source_id
        ))
        AND (t.target_type <> 'device' OR EXISTS (
          SELECT 1 FROM public.devices endpoint_device
          WHERE endpoint_device.id = t.target_id AND endpoint_device.org_id = t.org_id
            AND endpoint_device.site_id = t.site_id
        ))
        AND (t.target_type <> 'discovered_asset' OR EXISTS (
          SELECT 1 FROM (
            SELECT endpoint_asset.id FROM public.discovered_assets endpoint_asset
            WHERE endpoint_asset.org_id = t.org_id AND endpoint_asset.site_id = t.site_id
              AND endpoint_asset.approval_status = 'approved'
              AND endpoint_asset.asset_type IN ('printer', 'router', 'switch', 'firewall', 'access_point', 'nas')
            ORDER BY endpoint_asset.id LIMIT ${PARTNER_RELATIONSHIP_EDGE_LIMIT}
          ) exported_asset WHERE exported_asset.id = t.target_id
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
