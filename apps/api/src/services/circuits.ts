/**
 * Circuits (WAN service records), terminations, and served sites.
 * Spec: docs/superpowers/specs/monitoring/2026-10-07-physical-placement-circuits-design.md
 *   §5.2 WAN role, §5.3-§5.5 tables, §6 derived primary site and lifecycle,
 *   §7.2 site-scoped technicians, §8.2 interface role, §8.3 circuit writes,
 *   §8.4 read DTO.
 *
 * The primary site is derived from the termination's current interface and is
 * never stored. terminationState is derived at read time from the termination
 * row, the interface (retired or not), its owner node binding, and the
 * server-managed needs_reassociation flag written by the hard-delete trigger.
 */

import { and, asc, eq, exists, gt, inArray, isNull, notExists, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import {
  assetPhysicalPlacements,
  circuits,
  circuitServedSites,
  circuitTerminations,
  devices,
  discoveredAssets,
  sites,
  topologyInterfaces,
  topologyNodeBindings,
} from '../db/schema';
import { isPgUniqueViolation } from '../utils/pgErrors';

export type TerminationState = 'assigned' | 'unassigned' | 'needs_reassociation';

export class CircuitError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: 403 | 404 | 409 | 422,
  ) {
    super(message);
    this.name = 'CircuitError';
  }
}

export const circuitBodySchema = z.object({
  providerName: z.string().trim().min(1).max(255),
  cid: z.string().trim().min(1).max(255),
  bandwidthBps: z.number().int().positive().nullish(),
  serviceType: z.string().trim().min(1).max(64).nullish(),
  administrativeStatus: z.enum(['active', 'planned', 'suspended', 'disconnected']).optional(),
});

// `orgId` is create-route context only. Keep it out of circuitBodySchema so the
// PATCH schema can never turn organization ownership into a mutable circuit field.
export const circuitCreateBodySchema = circuitBodySchema.extend({
  orgId: z.string().uuid().optional(),
});

export const circuitPatchSchema = circuitBodySchema.partial();

export const circuitListQuerySchema = z
  .object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export const terminationBodySchema = z.object({ interfaceId: z.string().uuid() });

export const servedSitesBodySchema = z.object({
  siteIds: z.array(z.string().uuid()).max(100),
});

export const interfaceRoleBodySchema = z.object({
  role: z.literal('wan').nullable(),
});

export interface CircuitDto {
  id: string;
  orgId: string;
  providerName: string;
  cid: string;
  bandwidthBps: number | null;
  serviceType: string | null;
  administrativeStatus: string;
  terminationState: TerminationState;
  termination: null | {
    interfaceId: string;
    interfaceName: string | null;
    asset: { kind: 'device' | 'discovered'; id: string; label: string } | null;
    primarySite: { id: string; name: string };
    placement: { room: string | null; rack: string | null; rackUnit: number | null; heightU: number | null } | null;
  };
  additionalServedSites: { id: string; name: string }[];
  createdAt: string;
  updatedAt: string;
}

/**
 * The sites the caller may reach (spec §7.2). `null` means unrestricted; otherwise
 * the exact site ids. Resolved by the route layer from the token ceiling and the
 * live permission allowlist.
 */
export interface CircuitSiteScope {
  allowedSiteIds: string[] | null;
}

type CircuitRow = typeof circuits.$inferSelect;
type Placement = NonNullable<CircuitDto['termination']>['placement'];

/**
 * Spec §7.2: a circuit with a current termination is visible through its primary
 * site. A circuit without one is visible to a restricted caller only through an
 * accessible served site. Unrestricted callers see every circuit in their org.
 */
export function canSeeCircuit(dto: CircuitDto, scope: CircuitSiteScope): boolean {
  const allowed = scope.allowedSiteIds;
  if (allowed === null) return true;
  if (dto.terminationState === 'assigned' && dto.termination) {
    return allowed.includes(dto.termination.primarySite.id);
  }
  return dto.additionalServedSites.some((s) => allowed.includes(s.id));
}

/** Served-site names are returned only for sites the caller can access (spec §7.2). */
export function redactCircuitDto(dto: CircuitDto, scope: CircuitSiteScope): CircuitDto {
  const allowed = scope.allowedSiteIds;
  if (allowed === null) return dto;
  return { ...dto, additionalServedSites: dto.additionalServedSites.filter((s) => allowed.includes(s.id)) };
}

/** The current primary site when the circuit is assigned (spec §7.2 write rule). */
export function circuitPrimarySiteIds(dto: CircuitDto): string[] {
  return dto.terminationState === 'assigned' && dto.termination ? [dto.termination.primarySite.id] : [];
}

/**
 * Sites that must be writable to edit a circuit's own fields. Assigned circuits
 * need their primary site. A circuit without one needs org-wide authority, so a
 * restricted caller must be able to write every served site.
 */
export function circuitWriteSiteIds(dto: CircuitDto, scope: CircuitSiteScope): string[] {
  const primary = circuitPrimarySiteIds(dto);
  if (primary.length > 0 || scope.allowedSiteIds === null) return primary;
  return dto.additionalServedSites.map((s) => s.id);
}

/** Deleting a circuit also drops its served-site links: primary plus every served site. */
export function circuitDeleteSiteIds(dto: CircuitDto): string[] {
  return [...circuitPrimarySiteIds(dto), ...dto.additionalServedSites.map((s) => s.id)];
}

/**
 * Builds read DTOs for a set of circuit rows with a fixed number of queries,
 * independent of how many circuits are in the set. Result order follows `rows`.
 */
async function buildCircuitDtos(rows: CircuitRow[]): Promise<CircuitDto[]> {
  if (rows.length === 0) return [];
  const circuitIds = rows.map((r) => r.id);

  const termRows = await db
    .select({
      circuitId: circuitTerminations.circuitId,
      interfaceId: circuitTerminations.interfaceId,
      ifaceName: topologyInterfaces.name,
      ifaceSiteId: topologyInterfaces.siteId,
      ownerNodeId: topologyInterfaces.ownerNodeId,
      retiredAt: topologyInterfaces.retiredAt,
    })
    .from(circuitTerminations)
    .innerJoin(topologyInterfaces, eq(topologyInterfaces.id, circuitTerminations.interfaceId))
    .where(inArray(circuitTerminations.circuitId, circuitIds));
  const termByCircuit = new Map(termRows.map((t) => [t.circuitId, t]));

  const nodeIds = [...new Set(termRows.map((t) => t.ownerNodeId))];
  const bindingRows = nodeIds.length === 0
    ? []
    : await db
        .select({
          nodeId: topologyNodeBindings.nodeId,
          deviceId: topologyNodeBindings.deviceId,
          discoveredAssetId: topologyNodeBindings.discoveredAssetId,
        })
        .from(topologyNodeBindings)
        .where(inArray(topologyNodeBindings.nodeId, nodeIds));
  const bindingByNode = new Map<string, (typeof bindingRows)[number]>();
  for (const b of bindingRows) if (!bindingByNode.has(b.nodeId)) bindingByNode.set(b.nodeId, b);

  const assignedTerms = termRows.filter((t) => !t.retiredAt && bindingByNode.has(t.ownerNodeId));
  const siteIds = [...new Set(assignedTerms.map((t) => t.ifaceSiteId))];
  const deviceIds = [...new Set(assignedTerms.map((t) => bindingByNode.get(t.ownerNodeId)!.deviceId).filter((id): id is string => !!id))];
  const discoveredIds = [...new Set(
    assignedTerms
      .filter((t) => !bindingByNode.get(t.ownerNodeId)!.deviceId)
      .map((t) => bindingByNode.get(t.ownerNodeId)!.discoveredAssetId)
      .filter((id): id is string => !!id),
  )];

  const siteNameById = new Map<string, string>();
  if (siteIds.length > 0) {
    for (const s of await db.select({ id: sites.id, name: sites.name }).from(sites).where(inArray(sites.id, siteIds))) {
      siteNameById.set(s.id, s.name);
    }
  }
  const deviceLabelById = new Map<string, string>();
  if (deviceIds.length > 0) {
    for (const d of await db.select({ id: devices.id, hostname: devices.hostname }).from(devices).where(inArray(devices.id, deviceIds))) {
      deviceLabelById.set(d.id, d.hostname);
    }
  }
  const discoveredLabelById = new Map<string, string>();
  if (discoveredIds.length > 0) {
    for (const a of await db.select({ id: discoveredAssets.id, hostname: discoveredAssets.hostname }).from(discoveredAssets).where(inArray(discoveredAssets.id, discoveredIds))) {
      discoveredLabelById.set(a.id, a.hostname ?? a.id);
    }
  }

  const placementByDevice = new Map<string, Placement>();
  const placementByDiscovered = new Map<string, Placement>();
  const placementFilters: SQL[] = [];
  if (deviceIds.length > 0) placementFilters.push(inArray(assetPhysicalPlacements.deviceId, deviceIds));
  if (discoveredIds.length > 0) placementFilters.push(inArray(assetPhysicalPlacements.discoveredAssetId, discoveredIds));
  if (placementFilters.length > 0) {
    const placementRows = await db
      .select({
        deviceId: assetPhysicalPlacements.deviceId,
        discoveredAssetId: assetPhysicalPlacements.discoveredAssetId,
        room: assetPhysicalPlacements.room,
        rack: assetPhysicalPlacements.rack,
        rackUnit: assetPhysicalPlacements.rackUnit,
        heightU: assetPhysicalPlacements.heightU,
      })
      .from(assetPhysicalPlacements)
      .where(or(...placementFilters));
    for (const p of placementRows) {
      const value: Placement = { room: p.room, rack: p.rack, rackUnit: p.rackUnit, heightU: p.heightU };
      if (p.deviceId) placementByDevice.set(p.deviceId, value);
      else if (p.discoveredAssetId) placementByDiscovered.set(p.discoveredAssetId, value);
    }
  }

  const servedRows = await db
    .select({ circuitId: circuitServedSites.circuitId, id: sites.id, name: sites.name })
    .from(circuitServedSites)
    .innerJoin(sites, eq(sites.id, circuitServedSites.siteId))
    .where(inArray(circuitServedSites.circuitId, circuitIds));
  const servedByCircuit = new Map<string, { id: string; name: string }[]>();
  for (const s of servedRows) {
    const list = servedByCircuit.get(s.circuitId) ?? [];
    list.push({ id: s.id, name: s.name });
    servedByCircuit.set(s.circuitId, list);
  }

  return rows.map((circuit): CircuitDto => {
    const termRow = termByCircuit.get(circuit.id);
    let terminationState: TerminationState;
    let termination: CircuitDto['termination'] = null;

    if (termRow) {
      const binding = bindingByNode.get(termRow.ownerNodeId);
      if (termRow.retiredAt || !binding) {
        terminationState = 'needs_reassociation';
      } else {
        terminationState = 'assigned';
        let asset: NonNullable<CircuitDto['termination']>['asset'] = null;
        let placement: Placement = null;
        if (binding.deviceId) {
          const label = deviceLabelById.get(binding.deviceId);
          if (label !== undefined) asset = { kind: 'device', id: binding.deviceId, label };
          placement = placementByDevice.get(binding.deviceId) ?? null;
        } else if (binding.discoveredAssetId) {
          const label = discoveredLabelById.get(binding.discoveredAssetId);
          if (label !== undefined) asset = { kind: 'discovered', id: binding.discoveredAssetId, label };
          placement = placementByDiscovered.get(binding.discoveredAssetId) ?? null;
        }
        termination = {
          interfaceId: termRow.interfaceId,
          interfaceName: termRow.ifaceName ?? null,
          asset,
          primarySite: { id: termRow.ifaceSiteId, name: siteNameById.get(termRow.ifaceSiteId) ?? '' },
          placement,
        };
      }
    } else {
      terminationState = circuit.needsReassociation ? 'needs_reassociation' : 'unassigned';
    }

    const primarySiteId = termination?.primarySite.id ?? null;
    return {
      id: circuit.id,
      orgId: circuit.orgId,
      providerName: circuit.providerName,
      cid: circuit.cid,
      bandwidthBps: circuit.bandwidthBps ?? null,
      serviceType: circuit.serviceType ?? null,
      administrativeStatus: circuit.administrativeStatus,
      terminationState,
      termination,
      // The derived primary site always wins over an additional-site row (§5.5).
      additionalServedSites: (servedByCircuit.get(circuit.id) ?? []).filter((s) => s.id !== primarySiteId),
      createdAt: circuit.createdAt.toISOString(),
      updatedAt: circuit.updatedAt.toISOString(),
    };
  });
}

/** Reads the circuit's derived view. Returns null when the circuit is not visible (RLS). */
export async function getCircuitDto(circuitId: string): Promise<CircuitDto | null> {
  const [circuit] = await db.select().from(circuits).where(eq(circuits.id, circuitId)).limit(1);
  if (!circuit) return null;
  return (await buildCircuitDtos([circuit]))[0] ?? null;
}

/** Correlated EXISTS: the circuit has a current (non-retired, bound) termination, optionally at one of `siteIds`. */
function currentTerminationExists(siteIds?: string[]) {
  return db
    .select({ one: circuitTerminations.circuitId })
    .from(circuitTerminations)
    .innerJoin(topologyInterfaces, eq(topologyInterfaces.id, circuitTerminations.interfaceId))
    .innerJoin(topologyNodeBindings, eq(topologyNodeBindings.nodeId, topologyInterfaces.ownerNodeId))
    .where(and(
      eq(circuitTerminations.circuitId, circuits.id),
      isNull(topologyInterfaces.retiredAt),
      siteIds ? inArray(topologyInterfaces.siteId, siteIds) : undefined,
    ));
}

/** SQL form of {@link canSeeCircuit} for a restricted caller, so pages are filtered before the limit. */
function restrictedVisibility(allowed: string[]): SQL | undefined {
  return or(
    exists(currentTerminationExists(allowed)),
    and(
      notExists(currentTerminationExists()),
      exists(
        db
          .select({ one: circuitServedSites.circuitId })
          .from(circuitServedSites)
          .where(and(eq(circuitServedSites.circuitId, circuits.id), inArray(circuitServedSites.siteId, allowed))),
      ),
    ),
  );
}

export interface ListCircuitsOptions {
  /** Org ceiling from the caller's auth context (auth.orgCondition(circuits.orgId)). */
  orgCondition?: SQL;
  scope: CircuitSiteScope;
  limit: number;
  cursor?: string;
}

/** One page of circuits visible to the caller, ordered by id, with served-site names redacted. */
export async function listCircuitDtos(opts: ListCircuitsOptions): Promise<{ items: CircuitDto[]; nextCursor: string | null }> {
  const allowed = opts.scope.allowedSiteIds;
  if (allowed !== null && allowed.length === 0) return { items: [], nextCursor: null };

  const rows = await db
    .select()
    .from(circuits)
    .where(and(
      opts.orgCondition,
      allowed === null ? undefined : restrictedVisibility(allowed),
      opts.cursor ? gt(circuits.id, opts.cursor) : undefined,
    ))
    .orderBy(asc(circuits.id))
    .limit(opts.limit + 1);

  const page = rows.slice(0, opts.limit);
  const dtos = await buildCircuitDtos(page);
  return {
    items: dtos.map((dto) => redactCircuitDto(dto, opts.scope)),
    nextCursor: rows.length > opts.limit ? page[opts.limit - 1]!.id : null,
  };
}

export async function createCircuit(orgId: string, body: z.infer<typeof circuitBodySchema>): Promise<CircuitDto> {
  const [row] = await db
    .insert(circuits)
    .values({
      orgId,
      providerName: body.providerName,
      cid: body.cid,
      bandwidthBps: body.bandwidthBps ?? null,
      serviceType: body.serviceType ?? null,
      administrativeStatus: body.administrativeStatus ?? 'active',
    })
    .returning({ id: circuits.id });
  return (await getCircuitDto(row!.id))!;
}

export async function updateCircuit(circuitId: string, patch: z.infer<typeof circuitPatchSchema>): Promise<CircuitDto> {
  const values: Partial<typeof circuits.$inferInsert> = { updatedAt: new Date() };
  if (patch.providerName !== undefined) values.providerName = patch.providerName;
  if (patch.cid !== undefined) values.cid = patch.cid;
  if (patch.bandwidthBps !== undefined) values.bandwidthBps = patch.bandwidthBps ?? null;
  if (patch.serviceType !== undefined) values.serviceType = patch.serviceType ?? null;
  if (patch.administrativeStatus !== undefined) values.administrativeStatus = patch.administrativeStatus;
  const updated = await db.update(circuits).set(values).where(eq(circuits.id, circuitId)).returning({ id: circuits.id });
  if (updated.length === 0) throw new CircuitError('Circuit not found', 'CIRCUIT_NOT_FOUND', 404);
  return (await getCircuitDto(circuitId))!;
}

export async function deleteCircuit(circuitId: string): Promise<void> {
  const deleted = await db.delete(circuits).where(eq(circuits.id, circuitId)).returning({ id: circuits.id });
  if (deleted.length === 0) throw new CircuitError('Circuit not found', 'CIRCUIT_NOT_FOUND', 404);
}

/**
 * Assigns (or reassigns) the circuit's termination to a current WAN interface.
 * A successful assignment clears the server-managed needs_reassociation flag.
 *
 * The circuit and interface rows are locked and every precondition is re-read
 * inside the write transaction, so a concurrent role clear or served-site change
 * cannot slip between the check and the write.
 */
export async function setCircuitTermination(circuitId: string, interfaceId: string): Promise<CircuitDto> {
  try {
    await db.transaction(async (tx) => {
      const [circuit] = await tx
        .select({ id: circuits.id, orgId: circuits.orgId })
        .from(circuits)
        .where(eq(circuits.id, circuitId))
        .limit(1)
        .for('update');
      if (!circuit) throw new CircuitError('Circuit not found', 'CIRCUIT_NOT_FOUND', 404);

      const [iface] = await tx
        .select({
          id: topologyInterfaces.id,
          orgId: topologyInterfaces.orgId,
          siteId: topologyInterfaces.siteId,
          role: topologyInterfaces.role,
          retiredAt: topologyInterfaces.retiredAt,
        })
        .from(topologyInterfaces)
        .where(eq(topologyInterfaces.id, interfaceId))
        .limit(1)
        .for('update');
      if (!iface || iface.orgId !== circuit.orgId) throw new CircuitError('Interface not found', 'INTERFACE_NOT_FOUND', 404);
      if (iface.retiredAt) throw new CircuitError('A retired interface cannot terminate a circuit', 'INTERFACE_RETIRED', 422);
      if (iface.role !== 'wan') throw new CircuitError('Interface must be marked as WAN before it can terminate a circuit', 'INTERFACE_NOT_WAN', 422);

      await tx.delete(circuitTerminations).where(eq(circuitTerminations.circuitId, circuitId));
      await tx.insert(circuitTerminations).values({ circuitId, orgId: circuit.orgId, interfaceId });
      await tx.update(circuits).set({ needsReassociation: false, updatedAt: new Date() }).where(eq(circuits.id, circuitId));
      // Spec §5.5: the new primary site must not also appear as an additional served site.
      await tx.delete(circuitServedSites).where(and(eq(circuitServedSites.circuitId, circuitId), eq(circuitServedSites.siteId, iface.siteId)));
    });
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      throw new CircuitError('This interface already terminates another circuit', 'INTERFACE_ALREADY_TERMINATING', 409);
    }
    throw err;
  }

  return (await getCircuitDto(circuitId))!;
}

/**
 * Intentional detach. Leaves the circuit unassigned with needs_reassociation = false
 * (spec §5.4); the flag is only ever set by the hard-delete trigger.
 */
export async function clearCircuitTermination(circuitId: string): Promise<CircuitDto> {
  await db.transaction(async (tx) => {
    const [circuit] = await tx.select({ id: circuits.id }).from(circuits).where(eq(circuits.id, circuitId)).limit(1).for('update');
    if (!circuit) throw new CircuitError('Circuit not found', 'CIRCUIT_NOT_FOUND', 404);
    await tx.delete(circuitTerminations).where(eq(circuitTerminations.circuitId, circuitId));
    await tx.update(circuits).set({ needsReassociation: false, updatedAt: new Date() }).where(eq(circuits.id, circuitId));
  });
  return (await getCircuitDto(circuitId))!;
}

/**
 * Replaces the additional served sites. The derived primary site is rejected.
 * The circuit row is locked and the primary site and site ownership are read
 * inside the write transaction.
 */
export async function setCircuitServedSites(circuitId: string, siteIds: string[]): Promise<CircuitDto> {
  const unique = [...new Set(siteIds)];

  await db.transaction(async (tx) => {
    const [circuit] = await tx
      .select({ id: circuits.id, orgId: circuits.orgId })
      .from(circuits)
      .where(eq(circuits.id, circuitId))
      .limit(1)
      .for('update');
    if (!circuit) throw new CircuitError('Circuit not found', 'CIRCUIT_NOT_FOUND', 404);

    const [primary] = await tx
      .select({ siteId: topologyInterfaces.siteId })
      .from(circuitTerminations)
      .innerJoin(topologyInterfaces, eq(topologyInterfaces.id, circuitTerminations.interfaceId))
      .innerJoin(topologyNodeBindings, eq(topologyNodeBindings.nodeId, topologyInterfaces.ownerNodeId))
      .where(and(eq(circuitTerminations.circuitId, circuitId), isNull(topologyInterfaces.retiredAt)))
      .limit(1);
    if (primary && unique.includes(primary.siteId)) {
      throw new CircuitError('The primary site cannot also be an additional served site', 'PRIMARY_SITE_AS_SERVED', 422);
    }

    if (unique.length > 0) {
      const found = await tx.select({ id: sites.id, orgId: sites.orgId }).from(sites).where(inArray(sites.id, unique));
      if (found.length !== unique.length || found.some((s) => s.orgId !== circuit.orgId)) {
        throw new CircuitError('Every served site must belong to the circuit organization', 'SITE_NOT_IN_ORG', 422);
      }
    }

    await tx.delete(circuitServedSites).where(eq(circuitServedSites.circuitId, circuitId));
    if (unique.length > 0) {
      await tx.insert(circuitServedSites).values(unique.map((siteId) => ({ circuitId, siteId, orgId: circuit.orgId })));
    }
  });

  return (await getCircuitDto(circuitId))!;
}

/**
 * Sets or clears the WAN role on a current interface (spec §8.2). Clearing is
 * rejected while a current termination still references the interface. The
 * interface row is locked so a concurrent termination assignment is serialized
 * with the role change.
 */
export async function setInterfaceWanRole(interfaceId: string, role: 'wan' | null): Promise<{ id: string; siteId: string; role: string | null }> {
  return db.transaction(async (tx) => {
    const [iface] = await tx
      .select({ id: topologyInterfaces.id, siteId: topologyInterfaces.siteId, retiredAt: topologyInterfaces.retiredAt })
      .from(topologyInterfaces)
      .where(eq(topologyInterfaces.id, interfaceId))
      .limit(1)
      .for('update');
    if (!iface) throw new CircuitError('Interface not found', 'INTERFACE_NOT_FOUND', 404);
    if (iface.retiredAt) throw new CircuitError('A retired interface cannot change role', 'INTERFACE_RETIRED', 422);

    if (role === null) {
      const [term] = await tx
        .select({ circuitId: circuitTerminations.circuitId })
        .from(circuitTerminations)
        .where(eq(circuitTerminations.interfaceId, interfaceId))
        .limit(1);
      if (term) throw new CircuitError('Detach the circuit from this interface before clearing WAN', 'WAN_HAS_TERMINATION', 409);
    }

    const [updated] = await tx
      .update(topologyInterfaces)
      .set({ role, updatedAt: new Date() })
      .where(eq(topologyInterfaces.id, interfaceId))
      .returning({ id: topologyInterfaces.id, siteId: topologyInterfaces.siteId, role: topologyInterfaces.role });
    return updated!;
  });
}
