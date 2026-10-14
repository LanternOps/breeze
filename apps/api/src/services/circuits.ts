/**
 * Circuits (WAN service records), terminations, and served sites.
 * Spec: docs/superpowers/specs/monitoring/2026-10-07-physical-placement-circuits-design.md
 *   §5.2 WAN role, §5.3-§5.5 tables, §6 derived primary site and lifecycle,
 *   §8.2 interface role, §8.3 circuit writes, §8.4 read DTO.
 *
 * The primary site is derived from the termination's current interface and is
 * never stored. terminationState is derived at read time from the termination
 * row, the interface (retired or not), its owner node binding, and the
 * server-managed needs_reassociation flag written by the hard-delete trigger.
 */

import { and, eq, inArray, type SQL } from 'drizzle-orm';
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
    public readonly status: 404 | 409 | 422,
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

export const circuitPatchSchema = circuitBodySchema.partial();

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

/** Reads the circuit's derived view. Returns null when the circuit is not visible (RLS). */
export async function getCircuitDto(circuitId: string): Promise<CircuitDto | null> {
  const [circuit] = await db.select().from(circuits).where(eq(circuits.id, circuitId)).limit(1);
  if (!circuit) return null;

  const [termRow] = await db
    .select({
      interfaceId: circuitTerminations.interfaceId,
      ifaceName: topologyInterfaces.name,
      ifaceSiteId: topologyInterfaces.siteId,
      ownerNodeId: topologyInterfaces.ownerNodeId,
      retiredAt: topologyInterfaces.retiredAt,
    })
    .from(circuitTerminations)
    .innerJoin(topologyInterfaces, eq(topologyInterfaces.id, circuitTerminations.interfaceId))
    .where(eq(circuitTerminations.circuitId, circuitId))
    .limit(1);

  let terminationState: TerminationState;
  let termination: CircuitDto['termination'] = null;

  if (termRow) {
    const [binding] = await db
      .select({ deviceId: topologyNodeBindings.deviceId, discoveredAssetId: topologyNodeBindings.discoveredAssetId })
      .from(topologyNodeBindings)
      .where(eq(topologyNodeBindings.nodeId, termRow.ownerNodeId))
      .limit(1);

    if (termRow.retiredAt || !binding) {
      terminationState = 'needs_reassociation';
    } else {
      terminationState = 'assigned';
      const [site] = await db.select({ id: sites.id, name: sites.name }).from(sites).where(eq(sites.id, termRow.ifaceSiteId)).limit(1);

      let asset: { kind: 'device' | 'discovered'; id: string; label: string } | null = null;
      let placement: NonNullable<CircuitDto['termination']>['placement'] = null;
      if (binding.deviceId) {
        const [d] = await db.select({ id: devices.id, hostname: devices.hostname }).from(devices).where(eq(devices.id, binding.deviceId)).limit(1);
        if (d) asset = { kind: 'device', id: d.id, label: d.hostname };
        placement = await readPlacementRow(eq(assetPhysicalPlacements.deviceId, binding.deviceId));
      } else if (binding.discoveredAssetId) {
        const [a] = await db.select({ id: discoveredAssets.id, hostname: discoveredAssets.hostname }).from(discoveredAssets).where(eq(discoveredAssets.id, binding.discoveredAssetId)).limit(1);
        if (a) asset = { kind: 'discovered', id: a.id, label: a.hostname ?? a.id };
        placement = await readPlacementRow(eq(assetPhysicalPlacements.discoveredAssetId, binding.discoveredAssetId));
      }

      termination = {
        interfaceId: termRow.interfaceId,
        interfaceName: termRow.ifaceName ?? null,
        asset,
        primarySite: site ?? { id: termRow.ifaceSiteId, name: '' },
        placement,
      };
    }
  } else {
    terminationState = circuit.needsReassociation ? 'needs_reassociation' : 'unassigned';
  }

  const primarySiteId = termination?.primarySite.id ?? null;
  const served = await db
    .select({ id: sites.id, name: sites.name })
    .from(circuitServedSites)
    .innerJoin(sites, eq(sites.id, circuitServedSites.siteId))
    .where(eq(circuitServedSites.circuitId, circuitId));

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
    additionalServedSites: served.filter((s) => s.id !== primarySiteId),
    createdAt: circuit.createdAt.toISOString(),
    updatedAt: circuit.updatedAt.toISOString(),
  };
}

async function readPlacementRow(where: SQL | undefined) {
  const [row] = await db
    .select({
      room: assetPhysicalPlacements.room,
      rack: assetPhysicalPlacements.rack,
      rackUnit: assetPhysicalPlacements.rackUnit,
      heightU: assetPhysicalPlacements.heightU,
    })
    .from(assetPhysicalPlacements)
    .where(where)
    .limit(1);
  return row ?? null;
}

export async function listCircuitDtos(): Promise<CircuitDto[]> {
  const rows = await db.select({ id: circuits.id }).from(circuits);
  const out: CircuitDto[] = [];
  for (const row of rows) {
    const dto = await getCircuitDto(row.id);
    if (dto) out.push(dto);
  }
  return out;
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
 */
export async function setCircuitTermination(circuitId: string, interfaceId: string): Promise<CircuitDto> {
  const [circuit] = await db.select({ id: circuits.id, orgId: circuits.orgId }).from(circuits).where(eq(circuits.id, circuitId)).limit(1);
  if (!circuit) throw new CircuitError('Circuit not found', 'CIRCUIT_NOT_FOUND', 404);

  const [iface] = await db
    .select({ id: topologyInterfaces.id, orgId: topologyInterfaces.orgId, role: topologyInterfaces.role, retiredAt: topologyInterfaces.retiredAt })
    .from(topologyInterfaces)
    .where(eq(topologyInterfaces.id, interfaceId))
    .limit(1);
  if (!iface || iface.orgId !== circuit.orgId) throw new CircuitError('Interface not found', 'INTERFACE_NOT_FOUND', 404);
  if (iface.retiredAt) throw new CircuitError('A retired interface cannot terminate a circuit', 'INTERFACE_RETIRED', 422);
  if (iface.role !== 'wan') throw new CircuitError('Interface must be marked as WAN before it can terminate a circuit', 'INTERFACE_NOT_WAN', 422);

  try {
    await db.transaction(async (tx) => {
      await tx.delete(circuitTerminations).where(eq(circuitTerminations.circuitId, circuitId));
      await tx.insert(circuitTerminations).values({ circuitId, orgId: circuit.orgId, interfaceId });
      await tx.update(circuits).set({ needsReassociation: false, updatedAt: new Date() }).where(eq(circuits.id, circuitId));
    });
  } catch (err) {
    if (isPgUniqueViolation(err)) {
      throw new CircuitError('This interface already terminates another circuit', 'INTERFACE_ALREADY_TERMINATING', 409);
    }
    throw err;
  }

  // Spec §5.5: the new primary site must not also appear as an additional served site.
  const [term] = await db.select({ siteId: topologyInterfaces.siteId }).from(topologyInterfaces).where(eq(topologyInterfaces.id, interfaceId)).limit(1);
  if (term) {
    await db.delete(circuitServedSites).where(and(eq(circuitServedSites.circuitId, circuitId), eq(circuitServedSites.siteId, term.siteId)));
  }

  return (await getCircuitDto(circuitId))!;
}

/**
 * Intentional detach. Leaves the circuit unassigned with needs_reassociation = false
 * (spec §5.4); the flag is only ever set by the hard-delete trigger.
 */
export async function clearCircuitTermination(circuitId: string): Promise<CircuitDto> {
  const [circuit] = await db.select({ id: circuits.id }).from(circuits).where(eq(circuits.id, circuitId)).limit(1);
  if (!circuit) throw new CircuitError('Circuit not found', 'CIRCUIT_NOT_FOUND', 404);
  await db.transaction(async (tx) => {
    await tx.delete(circuitTerminations).where(eq(circuitTerminations.circuitId, circuitId));
    await tx.update(circuits).set({ needsReassociation: false, updatedAt: new Date() }).where(eq(circuits.id, circuitId));
  });
  return (await getCircuitDto(circuitId))!;
}

/** Replaces the additional served sites. The derived primary site is rejected. */
export async function setCircuitServedSites(circuitId: string, siteIds: string[]): Promise<CircuitDto> {
  const current = await getCircuitDto(circuitId);
  if (!current) throw new CircuitError('Circuit not found', 'CIRCUIT_NOT_FOUND', 404);

  const unique = [...new Set(siteIds)];
  if (current.termination && unique.includes(current.termination.primarySite.id)) {
    throw new CircuitError('The primary site cannot also be an additional served site', 'PRIMARY_SITE_AS_SERVED', 422);
  }

  if (unique.length > 0) {
    const found = await db.select({ id: sites.id, orgId: sites.orgId }).from(sites).where(inArray(sites.id, unique));
    if (found.length !== unique.length || found.some((s) => s.orgId !== current.orgId)) {
      throw new CircuitError('Every served site must belong to the circuit organization', 'SITE_NOT_IN_ORG', 422);
    }
  }

  await db.transaction(async (tx) => {
    await tx.delete(circuitServedSites).where(eq(circuitServedSites.circuitId, circuitId));
    if (unique.length > 0) {
      await tx.insert(circuitServedSites).values(unique.map((siteId) => ({ circuitId, siteId, orgId: current.orgId })));
    }
  });

  return (await getCircuitDto(circuitId))!;
}

/**
 * Sets or clears the WAN role on a current interface (spec §8.2). Clearing is
 * rejected while a current termination still references the interface.
 */
export async function setInterfaceWanRole(interfaceId: string, role: 'wan' | null): Promise<{ id: string; siteId: string; role: string | null }> {
  const [iface] = await db
    .select({ id: topologyInterfaces.id, siteId: topologyInterfaces.siteId, retiredAt: topologyInterfaces.retiredAt })
    .from(topologyInterfaces)
    .where(eq(topologyInterfaces.id, interfaceId))
    .limit(1);
  if (!iface) throw new CircuitError('Interface not found', 'INTERFACE_NOT_FOUND', 404);
  if (iface.retiredAt) throw new CircuitError('A retired interface cannot change role', 'INTERFACE_RETIRED', 422);

  if (role === null) {
    const [term] = await db
      .select({ circuitId: circuitTerminations.circuitId })
      .from(circuitTerminations)
      .where(eq(circuitTerminations.interfaceId, interfaceId))
      .limit(1);
    if (term) throw new CircuitError('Detach the circuit from this interface before clearing WAN', 'WAN_HAS_TERMINATION', 409);
  }

  const [updated] = await db
    .update(topologyInterfaces)
    .set({ role, updatedAt: new Date() })
    .where(eq(topologyInterfaces.id, interfaceId))
    .returning({ id: topologyInterfaces.id, siteId: topologyInterfaces.siteId, role: topologyInterfaces.role });
  return updated!;
}
