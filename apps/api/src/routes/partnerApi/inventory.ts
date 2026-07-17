import { Hono } from 'hono';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  deviceDisks,
  deviceHardware,
  deviceIpHistory,
  deviceNetwork,
  devices,
  deviceWarranty,
  discoveredAssets,
  hypervVms,
  networkBaselines,
  partnerExportDeviceMaterialState,
  partnerExportSiteMaterialState,
  sites,
  softwareInventory,
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
import {
  deviceInventoryExportEnvelopeSchema,
  deviceSoftwareExportEnvelopeSchema,
} from './schemas';
import {
  PARTNER_EXPORT_DERIVED_ID_NAMESPACE,
} from './identity';

export const PARTNER_INVENTORY_CHILD_LIMIT = 500;
export const PARTNER_SOFTWARE_CHILD_LIMIT = 1000;

type SourceRecord = Record<string, unknown>;

function object(value: unknown): SourceRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as SourceRecord : {};
}

function array(value: unknown, limit: number): SourceRecord[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is SourceRecord => !!entry && typeof entry === 'object' && !Array.isArray(entry)).slice(0, limit)
    : [];
}

function nullableString(value: unknown, max = 1000): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;
}

function nonnegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function finiteNonnegative(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new TypeError('Invalid inventory capacity.');
  return value;
}

function boolean(value: unknown): boolean {
  return value === true;
}

function timestamp(value: unknown): string {
  const date = value instanceof Date ? value : new Date(typeof value === 'string' ? value : '');
  if (!Number.isFinite(date.getTime())) throw new TypeError('Invalid inventory timestamp.');
  return date.toISOString();
}

function dateOnly(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const raw = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  return /^\d{4}-\d{2}-\d{2}$/u.test(raw) ? raw : null;
}

function total(value: unknown, included: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < included || (value as number) < 0) {
    throw new TypeError('Invalid partner inventory collection count.');
  }
  return value as number;
}

function collection(value: unknown, included: number) {
  const collectionTotal = total(value, included);
  const complete = collectionTotal === included;
  return {
    total: collectionTotal, included, complete,
    reason: complete ? null : 'collection_limit_exceeded' as const,
  };
}

function stableBatchId(namespace: string, column: unknown) {
  return sql<string>`public.breeze_partner_export_stable_uuid(${namespace}, ${column})`;
}

function effectiveTimestamp(primary: unknown, fallback: unknown) {
  return sql<Date>`COALESCE(${primary}, ${fallback})`.mapWith(devices.partnerExportUpdatedAt);
}

function mergeRows<T extends PartnerExportPageRow>(rows: T[], query: ExportQueryInput): T[] {
  const sorted = rows.sort((left, right) => {
    if (query.traversal.mode === 'incremental') {
      const timestampComparison = new Date(left.updatedAt).getTime() - new Date(right.updatedAt).getTime();
      if (timestampComparison !== 0) return timestampComparison;
    }
    const idComparison = String(left.id).localeCompare(String(right.id));
    return idComparison !== 0 ? idComparison : String(left.orgId).localeCompare(String(right.orgId));
  });
  return sorted.slice(0, getPartnerExportFetchLimit(query.limit));
}

function projectDeviceInventory(input: unknown) {
  const row = object(input);
  const hardware = object(row.hardware);
  const disks = array(row.disks, PARTNER_INVENTORY_CHILD_LIMIT).map((disk) => ({
    id: disk.id, mountPoint: String(disk.mountPoint ?? '').slice(0, 255),
    device: nullableString(disk.device), fileSystem: nullableString(disk.fileSystem ?? disk.fsType, 50),
    totalGb: finiteNonnegative(disk.totalGb),
  }));
  const interfaces = array(row.interfaces, PARTNER_INVENTORY_CHILD_LIMIT).map((networkInterface) => ({
    id: networkInterface.id, name: String(networkInterface.name ?? networkInterface.interfaceName ?? '').slice(0, 1000),
    macAddress: nullableString(networkInterface.macAddress, 17), primary: boolean(networkInterface.primary ?? networkInterface.isPrimary),
  }));
  const interfacesByName = new Map<string, typeof interfaces>();
  for (const networkInterface of interfaces) {
    const candidates = interfacesByName.get(networkInterface.name) ?? [];
    candidates.push(networkInterface);
    interfacesByName.set(networkInterface.name, candidates);
  }
  for (const candidates of interfacesByName.values()) {
    candidates.sort((left, right) => {
      if (left.macAddress === null && right.macAddress !== null) return 1;
      if (left.macAddress !== null && right.macAddress === null) return -1;
      const macComparison = String(left.macAddress ?? '').localeCompare(String(right.macAddress ?? ''));
      return macComparison !== 0 ? macComparison : String(left.id).localeCompare(String(right.id));
    });
  }
  const addresses = array(row.addresses, PARTNER_INVENTORY_CHILD_LIMIT).flatMap((address) => {
    const assignment = String(address.assignment ?? address.assignmentType ?? 'unknown');
    const interfaceName = String(address.interfaceName ?? '').slice(0, 1000);
    const historyMacAddress = typeof address.macAddress === 'string' ? address.macAddress : null;
    const candidates = interfacesByName.get(interfaceName) ?? [];
    const resolvedInterface = (historyMacAddress
      ? candidates.find((candidate) => candidate.macAddress === historyMacAddress)
      : undefined) ?? candidates[0];
    if (!resolvedInterface) return [];
    return [{
      id: address.id,
      interfaceId: resolvedInterface.id,
      interfaceName: resolvedInterface.name,
      address: String(address.address ?? address.ipAddress ?? '').slice(0, 45),
      family: address.family ?? address.ipType ?? 'ipv4', assignment,
      reservationEligible: assignment === 'static',
      subnetMask: nullableString(address.subnetMask, 45), gateway: nullableString(address.gateway, 45),
      dnsServers: Array.isArray(address.dnsServers)
        ? address.dnsServers.filter((entry): entry is string => typeof entry === 'string').slice(0, 20)
        : [],
      active: boolean(address.active ?? address.isActive), firstSeenAt: timestamp(address.firstSeenAt ?? address.firstSeen),
      deactivatedAt: address.deactivatedAt ? timestamp(address.deactivatedAt) : null,
    }];
  });
  const virtualMachines = array(row.virtualMachines, PARTNER_INVENTORY_CHILD_LIMIT).map((vm) => ({
    id: vm.id, externalId: String(vm.externalId ?? vm.vmId ?? '').slice(0, 64),
    name: String(vm.name ?? vm.vmName ?? '').slice(0, 256), generation: nonnegativeInteger(vm.generation),
    memoryMb: nonnegativeInteger(vm.memoryMb), processorCount: nonnegativeInteger(vm.processorCount),
    rctEnabled: boolean(vm.rctEnabled), passthroughDisks: boolean(vm.passthroughDisks ?? vm.hasPassthroughDisks),
  }));
  const warrantySource = row.warranty ? object(row.warranty) : null;
  return {
    id: row.id, orgId: row.orgId, siteId: row.siteId, sourceUpdatedAt: row.updatedAt,
    subjectType: 'device' as const, deviceId: row.subjectId,
    hardware: {
      processor: { model: nullableString(hardware.cpuModel, 255), cores: nonnegativeInteger(hardware.cpuCores), threads: nonnegativeInteger(hardware.cpuThreads) },
      memory: { totalMb: nonnegativeInteger(hardware.ramTotalMb) },
      graphics: { model: nullableString(hardware.gpuModel, 255) },
      motherboard: {
        manufacturer: nullableString(hardware.motherboardManufacturer, 255),
        product: nullableString(hardware.motherboardProduct, 255), version: nullableString(hardware.motherboardVersion, 255),
      },
      firmware: { biosVersion: nullableString(hardware.biosVersion, 100) },
    },
    disks, interfaces, addresses,
    warranty: warrantySource ? {
      status: warrantySource.status, startsOn: dateOnly(warrantySource.startsOn ?? warrantySource.warrantyStartDate),
      endsOn: dateOnly(warrantySource.endsOn ?? warrantySource.warrantyEndDate),
      subscription: boolean(warrantySource.subscription ?? warrantySource.isSubscription),
    } : null,
    virtualMachines,
    collections: {
      disks: collection(row.diskCount, disks.length), interfaces: collection(row.interfaceCount, interfaces.length),
      addresses: collection(row.addressCount, addresses.length),
      virtualMachines: collection(row.virtualMachineCount, virtualMachines.length),
    },
  };
}

const DURABLE_EQUIPMENT_TYPES = new Set(['printer', 'router', 'switch', 'firewall', 'access_point', 'nas']);

function projectSiteInventory(input: unknown) {
  const row = object(input);
  const networkEquipment = array(row.networkEquipment, PARTNER_INVENTORY_CHILD_LIMIT)
    .filter((entry) => DURABLE_EQUIPMENT_TYPES.has(String(entry.type ?? entry.assetType)))
    .map((entry) => ({
      id: entry.id, type: entry.type ?? entry.assetType, name: nullableString(entry.name ?? entry.label ?? entry.hostname, 255),
      address: String(entry.address ?? entry.ipAddress ?? '').slice(0, 45), macAddress: nullableString(entry.macAddress, 17),
      manufacturer: nullableString(entry.manufacturer, 255), model: nullableString(entry.model, 255),
    }));
  const networkSegments = array(row.networkSegments, PARTNER_INVENTORY_CHILD_LIMIT).map((entry) => ({
    id: entry.id, cidr: String(entry.cidr ?? entry.subnet ?? '').slice(0, 50),
  }));
  return {
    id: row.id, orgId: row.orgId, siteId: row.siteId, sourceUpdatedAt: row.updatedAt,
    subjectType: 'site' as const, siteSubjectId: row.subjectId,
    networkEquipment, networkSegments,
    collections: {
      networkEquipment: collection(row.networkEquipmentCount, networkEquipment.length),
      networkSegments: collection(row.networkSegmentCount, networkSegments.length),
    },
  };
}

function projectSoftware(input: unknown) {
  const row = object(input);
  const software = array(row.software, PARTNER_SOFTWARE_CHILD_LIMIT).map((entry) => ({
    id: entry.id, name: String(entry.name ?? '').slice(0, 500), version: nullableString(entry.version, 100),
    vendor: nullableString(entry.vendor ?? entry.publisher, 255), installedOn: dateOnly(entry.installedOn ?? entry.installDate),
    managed: boolean(entry.managed ?? entry.isManaged),
  }));
  return {
    id: row.id, orgId: row.orgId, siteId: row.siteId, sourceUpdatedAt: row.updatedAt,
    subjectType: 'device' as const, deviceId: row.subjectId,
    software, collection: collection(row.softwareCount, software.length),
  };
}

async function selectDeviceInventoryRows(orgIds: string[], query: ExportQueryInput) {
  const id = stableBatchId('device-inventory:device', devices.id);
  const updatedAt = effectiveTimestamp(partnerExportDeviceMaterialState.inventoryUpdatedAt, devices.partnerExportUpdatedAt);
  return db.select({
    id, subjectId: devices.id, subjectType: sql<string>`'device'`, orgId: devices.orgId, siteId: devices.siteId,
    createdAt: devices.createdAt, updatedAt,
    hardware: sql<unknown>`(
      SELECT jsonb_build_object(
        'cpuModel', h.cpu_model, 'cpuCores', h.cpu_cores, 'cpuThreads', h.cpu_threads,
        'ramTotalMb', h.ram_total_mb, 'gpuModel', h.gpu_model,
        'motherboardManufacturer', h.motherboard_manufacturer, 'motherboardProduct', h.motherboard_product,
        'motherboardVersion', h.motherboard_version, 'biosVersion', h.bios_version
      ) FROM ${deviceHardware} h WHERE h.device_id = ${devices.id} AND h.org_id = ${devices.orgId} LIMIT 1
    )`,
    disks: sql<unknown[]>`COALESCE((SELECT jsonb_agg(item ORDER BY item->>'id') FROM (
      SELECT jsonb_build_object('id', d.id, 'mountPoint', d.mount_point, 'device', d.device, 'fileSystem', d.fs_type, 'totalGb', d.total_gb) item
      FROM ${deviceDisks} d WHERE d.device_id = ${devices.id} AND d.org_id = ${devices.orgId}
      ORDER BY d.id LIMIT ${PARTNER_INVENTORY_CHILD_LIMIT}
    ) bounded), '[]'::jsonb)`,
    diskCount: sql<number>`(SELECT COUNT(*)::integer FROM ${deviceDisks} d WHERE d.device_id = ${devices.id} AND d.org_id = ${devices.orgId})`,
    interfaces: sql<unknown[]>`COALESCE((SELECT jsonb_agg(item ORDER BY item->>'id') FROM (
      SELECT jsonb_build_object(
        'id', public.breeze_partner_export_stable_uuid(
          ${PARTNER_EXPORT_DERIVED_ID_NAMESPACE.interface},
          array_to_json(ARRAY[n.device_id::text, n.interface_name, COALESCE(n.mac_address, '')]::text[])::text
        ),
        'name', n.interface_name, 'macAddress', n.mac_address, 'primary', n.is_primary
      ) item FROM ${deviceNetwork} n WHERE n.device_id = ${devices.id} AND n.org_id = ${devices.orgId}
      ORDER BY n.interface_name, n.mac_address NULLS LAST LIMIT ${PARTNER_INVENTORY_CHILD_LIMIT}
    ) bounded), '[]'::jsonb)`,
    interfaceCount: sql<number>`(SELECT COUNT(*)::integer FROM ${deviceNetwork} n WHERE n.device_id = ${devices.id} AND n.org_id = ${devices.orgId})`,
    addresses: sql<unknown[]>`COALESCE((SELECT jsonb_agg(item ORDER BY item->>'id') FROM (
      SELECT jsonb_build_object(
        'id', public.breeze_partner_export_stable_uuid(
          ${PARTNER_EXPORT_DERIVED_ID_NAMESPACE.address},
          array_to_json(ARRAY[a.device_id::text, resolved_interface.interface_name, a.ip_address, a.ip_type]::text[])::text
        ),
        'interfaceId', public.breeze_partner_export_stable_uuid(
          ${PARTNER_EXPORT_DERIVED_ID_NAMESPACE.interface},
          array_to_json(ARRAY[
            a.device_id::text, resolved_interface.interface_name, COALESCE(resolved_interface.mac_address, '')
          ]::text[])::text
        ),
        'interfaceName', resolved_interface.interface_name, 'macAddress', a.mac_address,
        'address', a.ip_address, 'family', a.ip_type,
        'assignment', a.assignment_type, 'subnetMask', a.subnet_mask, 'gateway', a.gateway,
        'dnsServers', COALESCE(a.dns_servers, ARRAY[]::text[]), 'active', a.is_active,
        'firstSeenAt', a.first_seen, 'deactivatedAt', a.deactivated_at
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
      ORDER BY a.interface_name, a.ip_address, a.ip_type LIMIT ${PARTNER_INVENTORY_CHILD_LIMIT}
    ) bounded), '[]'::jsonb)`,
    addressCount: sql<number>`(
      SELECT COUNT(*)::integer FROM ${deviceIpHistory} a
      WHERE a.device_id = ${devices.id} AND a.org_id = ${devices.orgId}
        AND EXISTS (
          SELECT 1 FROM ${deviceNetwork} current_interface
          WHERE current_interface.device_id = a.device_id AND current_interface.org_id = a.org_id
            AND current_interface.interface_name = a.interface_name
        )
    )`,
    warranty: sql<unknown>`(
      SELECT jsonb_build_object('status', w.status, 'startsOn', w.warranty_start_date, 'endsOn', w.warranty_end_date, 'subscription', w.is_subscription)
      FROM ${deviceWarranty} w WHERE w.device_id = ${devices.id} AND w.org_id = ${devices.orgId} LIMIT 1
    )`,
    virtualMachines: sql<unknown[]>`COALESCE((SELECT jsonb_agg(item ORDER BY item->>'id') FROM (
      SELECT jsonb_build_object(
        'id', public.breeze_partner_export_stable_uuid(
          ${PARTNER_EXPORT_DERIVED_ID_NAMESPACE.virtualMachine},
          array_to_json(ARRAY[v.device_id::text, v.vm_id]::text[])::text
        ),
        'externalId', v.vm_id, 'name', v.vm_name, 'generation', v.generation,
        'memoryMb', v.memory_mb, 'processorCount', v.processor_count,
        'rctEnabled', COALESCE(v.rct_enabled, false), 'passthroughDisks', COALESCE(v.has_passthrough_disks, false)
      ) item FROM ${hypervVms} v WHERE v.device_id = ${devices.id} AND v.org_id = ${devices.orgId}
      ORDER BY v.vm_id LIMIT ${PARTNER_INVENTORY_CHILD_LIMIT}
    ) bounded), '[]'::jsonb)`,
    virtualMachineCount: sql<number>`(SELECT COUNT(*)::integer FROM ${hypervVms} v WHERE v.device_id = ${devices.id} AND v.org_id = ${devices.orgId})`,
  }).from(devices)
    .innerJoin(sites, and(eq(sites.id, devices.siteId), eq(sites.orgId, devices.orgId)))
    .leftJoin(partnerExportDeviceMaterialState, and(
      eq(partnerExportDeviceMaterialState.deviceId, devices.id), eq(partnerExportDeviceMaterialState.orgId, devices.orgId),
    ))
    .where(and(
      inArray(devices.orgId, orgIds), ...(query.siteId ? [eq(devices.siteId, query.siteId)] : []),
      ...paginationConditions({ id, orgId: devices.orgId, createdAt: devices.createdAt, updatedAt, updatedAtParam: partnerExportDeviceMaterialState.inventoryUpdatedAt }, query.traversal),
    ))
    .orderBy(...paginationOrder({ id, orgId: devices.orgId, updatedAt }, query.traversal))
    .limit(getPartnerExportFetchLimit(query.limit));
}

async function selectSiteInventoryRows(orgIds: string[], query: ExportQueryInput) {
  const id = stableBatchId('device-inventory:site', sites.id);
  const updatedAt = sql<Date>`COALESCE(${partnerExportSiteMaterialState.inventoryUpdatedAt}, ${sites.partnerExportUpdatedAt})`.mapWith(sites.partnerExportUpdatedAt);
  return db.select({
    id, subjectId: sites.id, subjectType: sql<string>`'site'`, orgId: sites.orgId, siteId: sites.id,
    createdAt: sites.createdAt, updatedAt,
    networkEquipment: sql<unknown[]>`COALESCE((SELECT jsonb_agg(item ORDER BY item->>'id') FROM (
      SELECT jsonb_build_object(
        'id', a.id, 'type', a.asset_type, 'name', COALESCE(a.label, a.hostname), 'address', host(a.ip_address),
        'macAddress', a.mac_address, 'manufacturer', a.manufacturer, 'model', a.model
      ) item FROM ${discoveredAssets} a
      WHERE a.site_id = ${sites.id} AND a.org_id = ${sites.orgId} AND a.approval_status = 'approved'
        AND a.asset_type IN ('printer', 'router', 'switch', 'firewall', 'access_point', 'nas')
      ORDER BY a.id LIMIT ${PARTNER_INVENTORY_CHILD_LIMIT}
    ) bounded), '[]'::jsonb)`,
    networkEquipmentCount: sql<number>`(
      SELECT COUNT(*)::integer FROM ${discoveredAssets} a
      WHERE a.site_id = ${sites.id} AND a.org_id = ${sites.orgId} AND a.approval_status = 'approved'
        AND a.asset_type IN ('printer', 'router', 'switch', 'firewall', 'access_point', 'nas')
    )`,
    networkSegments: sql<unknown[]>`COALESCE((SELECT jsonb_agg(item ORDER BY item->>'id') FROM (
      SELECT jsonb_build_object('id', b.id, 'cidr', b.subnet) item
      FROM ${networkBaselines} b WHERE b.site_id = ${sites.id} AND b.org_id = ${sites.orgId}
      ORDER BY b.id LIMIT ${PARTNER_INVENTORY_CHILD_LIMIT}
    ) bounded), '[]'::jsonb)`,
    networkSegmentCount: sql<number>`(SELECT COUNT(*)::integer FROM ${networkBaselines} b WHERE b.site_id = ${sites.id} AND b.org_id = ${sites.orgId})`,
  }).from(sites)
    .leftJoin(partnerExportSiteMaterialState, and(
      eq(partnerExportSiteMaterialState.siteId, sites.id), eq(partnerExportSiteMaterialState.orgId, sites.orgId),
    ))
    .where(and(
      inArray(sites.orgId, orgIds), ...(query.siteId ? [eq(sites.id, query.siteId)] : []),
      ...paginationConditions({ id, orgId: sites.orgId, createdAt: sites.createdAt, updatedAt, updatedAtParam: partnerExportSiteMaterialState.inventoryUpdatedAt }, query.traversal),
    ))
    .orderBy(...paginationOrder({ id, orgId: sites.orgId, updatedAt }, query.traversal))
    .limit(getPartnerExportFetchLimit(query.limit));
}

async function selectSoftwareRows(orgIds: string[], query: ExportQueryInput) {
  const id = stableBatchId('device-software:device', devices.id);
  const updatedAt = effectiveTimestamp(partnerExportDeviceMaterialState.softwareUpdatedAt, devices.partnerExportUpdatedAt);
  return db.select({
    id, subjectId: devices.id, subjectType: sql<string>`'device'`, orgId: devices.orgId, siteId: devices.siteId,
    createdAt: devices.createdAt, updatedAt,
    software: sql<unknown[]>`COALESCE((SELECT jsonb_agg(item ORDER BY item->>'id') FROM (
      SELECT jsonb_build_object(
        'id', s.id, 'name', s.name, 'version', s.version, 'vendor', s.vendor,
        'installedOn', s.install_date, 'managed', s.is_managed
      ) item FROM ${softwareInventory} s WHERE s.device_id = ${devices.id} AND s.org_id = ${devices.orgId}
      ORDER BY s.id LIMIT ${PARTNER_SOFTWARE_CHILD_LIMIT}
    ) bounded), '[]'::jsonb)`,
    softwareCount: sql<number>`(SELECT COUNT(*)::integer FROM ${softwareInventory} s WHERE s.device_id = ${devices.id} AND s.org_id = ${devices.orgId})`,
  }).from(devices)
    .innerJoin(sites, and(eq(sites.id, devices.siteId), eq(sites.orgId, devices.orgId)))
    .leftJoin(partnerExportDeviceMaterialState, and(
      eq(partnerExportDeviceMaterialState.deviceId, devices.id), eq(partnerExportDeviceMaterialState.orgId, devices.orgId),
    ))
    .where(and(
      inArray(devices.orgId, orgIds), ...(query.siteId ? [eq(devices.siteId, query.siteId)] : []),
      ...paginationConditions({ id, orgId: devices.orgId, createdAt: devices.createdAt, updatedAt, updatedAtParam: partnerExportDeviceMaterialState.softwareUpdatedAt }, query.traversal),
    ))
    .orderBy(...paginationOrder({ id, orgId: devices.orgId, updatedAt }, query.traversal))
    .limit(getPartnerExportFetchLimit(query.limit));
}

export const partnerInventoryRoutes = new Hono();

partnerInventoryRoutes.get('/device-inventory', requirePartnerApiScope('inventory:read'), async (c) => {
  const principal = c.get('partnerApiPrincipal');
  const parsed = parseExportQuery(c, 'device-inventory', principal);
  if (parsed instanceof Response) return parsed;
  try {
    const orgIds = parsed.orgId ? [parsed.orgId] : principal.accessibleOrgIds;
    bindPartnerExportSnapshot(parsed, await acquirePartnerExportReadLocks(orgIds));
    const rows = orgIds.length > 0 ? await (async () => {
      const [deviceRows, siteRows] = await Promise.all([
        selectDeviceInventoryRows(orgIds, parsed), selectSiteInventoryRows(orgIds, parsed),
      ]);
      return mergeRows([...deviceRows, ...siteRows].map(normalizeSourceRow), parsed);
    })() : [];
    const envelope = buildEnvelope({
      resource: 'device-inventory', partnerId: principal.partnerId, rows, query: parsed,
      makeRecord: (row) => row.subjectType === 'site' ? projectSiteInventory(row) : projectDeviceInventory(row),
    });
    return c.json(deviceInventoryExportEnvelopeSchema.parse(envelope));
  } catch (error) {
    if (isKnownClientError(error)) return clientError(c, error);
    return c.json({ error: 'Partner device inventory export failed.', code: 'partner_export_failed' }, 500);
  }
});

partnerInventoryRoutes.get('/device-software', requirePartnerApiScope('inventory:read'), async (c) => {
  const principal = c.get('partnerApiPrincipal');
  const parsed = parseExportQuery(c, 'device-software', principal);
  if (parsed instanceof Response) return parsed;
  try {
    const orgIds = parsed.orgId ? [parsed.orgId] : principal.accessibleOrgIds;
    bindPartnerExportSnapshot(parsed, await acquirePartnerExportReadLocks(orgIds));
    const rows = orgIds.length > 0 ? (await selectSoftwareRows(orgIds, parsed)).map(normalizeSourceRow) : [];
    const envelope = buildEnvelope({
      resource: 'device-software', partnerId: principal.partnerId, rows, query: parsed,
      makeRecord: projectSoftware,
    });
    return c.json(deviceSoftwareExportEnvelopeSchema.parse(envelope));
  } catch (error) {
    if (isKnownClientError(error)) return clientError(c, error);
    return c.json({ error: 'Partner device software export failed.', code: 'partner_export_failed' }, 500);
  }
});
