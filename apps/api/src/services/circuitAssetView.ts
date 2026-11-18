/**
 * Circuits and interfaces of one asset (device or discovered asset).
 * Spec: docs/superpowers/specs/monitoring/2026-10-07-physical-placement-circuits-design.md
 *   §5.4 asset -> binding -> owner node -> interface -> termination,
 *   §6.1/§6.2/§6.4 derived state, §7.2 site-scoped technicians, §9.1.
 *
 * Reads only. The asset is resolved through its OWN topology binding (a discovered
 * asset linked to a device does not borrow the device's node). Every query filters
 * org_id / site_id explicitly on top of RLS.
 */

import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import { circuitTerminations, topologyInterfaces, topologyNodeBindings, topologyNodes } from '../db/schema';
import {
  canSeeCircuit,
  getCircuitDtosByIds,
  redactCircuitDto,
  type CircuitDto,
  type CircuitSiteScope,
} from './circuits';

/** Fixed ceiling on current interfaces returned (retired ones with a visible termination are extra). */
export const INTERFACE_LIST_CAP = 1000;

export interface AssetCircuitSubject {
  kind: 'device' | 'discovered';
  id: string;
  orgId: string;
  siteId: string;
}

export interface AssetInterfaceDto {
  id: string;
  name: string | null;
  kind: string;
  role: string | null;
  retired: boolean;
  circuitId: string | null;
}

export interface AssetCircuitsView {
  bound: boolean;
  interfaces: AssetInterfaceDto[];
  interfacesTruncated: boolean;
  circuits: CircuitDto[];
}

export interface AssetCircuitOptions {
  /** Token ceiling intersected with the permission allowlist. */
  scope: CircuitSiteScope;
  /** Org ceiling of the caller (`auth.canAccessOrg`). */
  canAccessOrg: (orgId: string) => boolean;
  /** Caller holds topology read on the subject's site; otherwise no interface rows are returned. */
  includeInterfaces: boolean;
}

export async function listAssetCircuitDtos(
  subject: AssetCircuitSubject,
  opts: AssetCircuitOptions,
): Promise<AssetCircuitsView> {
  const ownBinding = subject.kind === 'device'
    ? eq(topologyNodeBindings.deviceId, subject.id)
    : eq(topologyNodeBindings.discoveredAssetId, subject.id);

  // Only a live, canonical node counts: a soft-deleted or alias node is not the asset's node.
  const [binding] = await db
    .select({ nodeId: topologyNodeBindings.nodeId })
    .from(topologyNodeBindings)
    .innerJoin(topologyNodes, eq(topologyNodes.id, topologyNodeBindings.nodeId))
    .where(and(
      ownBinding,
      eq(topologyNodeBindings.orgId, subject.orgId),
      eq(topologyNodeBindings.siteId, subject.siteId),
      isNull(topologyNodes.deletedAt),
      isNull(topologyNodes.aliasTargetId),
    ))
    .limit(1);
  if (!binding) return { bound: false, interfaces: [], interfacesTruncated: false, circuits: [] };
  const nodeId = binding.nodeId;

  // Terminations on ANY interface of the node, current or retired (retired => needs_reassociation).
  const terminations = await db
    .select({
      circuitId: circuitTerminations.circuitId,
      interfaceId: circuitTerminations.interfaceId,
      name: topologyInterfaces.name,
      kind: topologyInterfaces.kind,
      role: topologyInterfaces.role,
      retiredAt: topologyInterfaces.retiredAt,
    })
    .from(circuitTerminations)
    .innerJoin(topologyInterfaces, eq(topologyInterfaces.id, circuitTerminations.interfaceId))
    .where(and(
      eq(topologyInterfaces.ownerNodeId, nodeId),
      eq(topologyInterfaces.orgId, subject.orgId),
      eq(topologyInterfaces.siteId, subject.siteId),
      eq(circuitTerminations.orgId, subject.orgId),
    ));

  const candidates = terminations.length === 0
    ? []
    : await getCircuitDtosByIds(terminations.map((t) => t.circuitId), subject.orgId);
  const circuits = candidates
    .filter((dto) => opts.canAccessOrg(dto.orgId) && canSeeCircuit(dto, opts.scope))
    .map((dto) => redactCircuitDto(dto, opts.scope));
  const visibleCircuitIds = new Set(circuits.map((c) => c.id));
  const visibleTerminations = terminations.filter((t) => visibleCircuitIds.has(t.circuitId));
  const circuitByInterface = new Map(visibleTerminations.map((t) => [t.interfaceId, t.circuitId]));

  if (!opts.includeInterfaces) {
    return { bound: true, interfaces: [], interfacesTruncated: false, circuits };
  }

  const current = await db
    .select({
      id: topologyInterfaces.id,
      name: topologyInterfaces.name,
      kind: topologyInterfaces.kind,
      role: topologyInterfaces.role,
      retiredAt: topologyInterfaces.retiredAt,
    })
    .from(topologyInterfaces)
    .where(and(
      eq(topologyInterfaces.ownerNodeId, nodeId),
      eq(topologyInterfaces.orgId, subject.orgId),
      eq(topologyInterfaces.siteId, subject.siteId),
      isNull(topologyInterfaces.retiredAt),
    ))
    .orderBy(asc(topologyInterfaces.name), asc(topologyInterfaces.id))
    .limit(INTERFACE_LIST_CAP + 1);
  const interfacesTruncated = current.length > INTERFACE_LIST_CAP;

  const toDto = (i: { id: string; name: string | null; kind: string; role: string | null }, retired: boolean): AssetInterfaceDto => ({
    id: i.id,
    name: i.name,
    kind: i.kind,
    role: i.role,
    retired,
    circuitId: circuitByInterface.get(i.id) ?? null,
  });
  const retired = visibleTerminations
    .filter((t) => t.retiredAt)
    .map((t) => toDto({ id: t.interfaceId, name: t.name, kind: t.kind, role: t.role }, true))
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || a.id.localeCompare(b.id));

  return {
    bound: true,
    interfaces: [...current.slice(0, INTERFACE_LIST_CAP).map((i) => toDto(i, false)), ...retired],
    interfacesTruncated,
    circuits,
  };
}
