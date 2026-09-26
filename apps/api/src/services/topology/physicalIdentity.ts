import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { PortRef, TypedId } from '@breeze/shared';
import { canonicalFactValue } from './collectionFactKeys';

/**
 * Pure physical identity rules (M2 Task 6; amendments D3, D10/D13, D15).
 *
 * Nothing here merges nodes. Resolution only ever *selects* an existing scoped
 * node/interface by a typed, server-trusted identifier:
 *   - node MACs come from agent-reported NIC MACs and from the physAddress of
 *     current SNMP interface generations (never discovered-asset MACs, which
 *     UniFi telemetry may have overwritten — D16);
 *   - names, sysNames and IP addresses never resolve anything.
 */

export type EndpointPort = { nodeId: string; interfaceId: string };
const compareEndpoint = (a: EndpointPort, b: EndpointPort) => a.nodeId.localeCompare(b.nodeId) || a.interfaceId.localeCompare(b.interfaceId);
/** Versioned, order-independent source key of one measured cable. Parallel cables
 * differ by interface, so they never collapse; LAG membership is not part of it. */
export function physicalLinkKey(a: EndpointPort, b: EndpointPort): string {
  const [x, y] = [a, b].sort(compareEndpoint) as [EndpointPort, EndpointPort];
  return `physical-link-v1:${x.nodeId}:${x.interfaceId}:${y.nodeId}:${y.interfaceId}`;
}
export const sortedLinkEndpoints = (a: EndpointPort, b: EndpointPort) => [a, b].sort(compareEndpoint) as [EndpointPort, EndpointPort];

export const opaqueHash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonicalFactValue(value))).digest('hex');
/** Identity values may contain spaces or colons; source keys may not contain whitespace. */
const encode = (value: string) => encodeURIComponent(value);
/** Scoped unbound endpoint for a remote LLDP chassis with no inventory. Never merged by name/IP. */
export const lldpChassisSourceKey = (id: TypedId) => `lldp-chassis:${id.subtype}:${encode(id.value)}`;
export const cdpDeviceSourceKey = (id: TypedId) => `cdp-device:${id.subtype}:${encode(id.value)}`;
/** A MAC learned in a forwarding table with no inventory binding. */
export const macEndpointSourceKey = (mac: string) => `mac-endpoint:${mac}`;
/** An authorized SNMP target that does not (yet) resolve to a scoped inventory node. */
export const physicalTargetSourceKey = (authorityKey: string) => `physical-target:${encode(authorityKey)}`;

export function normalizeMac(value: string | null | undefined): string | null {
  if (!value) return null;
  const hex = value.replace(/[^0-9a-f]/gi, '').toLowerCase();
  if (hex.length !== 12) return null;
  const mac = hex.match(/../g)!.join(':');
  const first = Number.parseInt(hex.slice(0, 2), 16);
  // Group (multicast/broadcast) and zero addresses never identify one device.
  return (first & 1) === 1 || mac === '00:00:00:00:00:00' ? null : mac;
}

/** Physical (SNMP/controller) interface generations are server-owned `gen:<n>` epochs (D10). */
export const PHYSICAL_GENERATION_PREFIX = 'gen:';
export const isPhysicalGeneration = (epoch: string) => epoch.startsWith(PHYSICAL_GENERATION_PREFIX);
export const physicalGenerationNumber = (epoch: string) => isPhysicalGeneration(epoch) ? Number(epoch.slice(PHYSICAL_GENERATION_PREFIX.length)) || 0 : 0;

export type InterfaceIdentityEvidence = { name: string | null; physAddress: string | null; osIndex: string | null };
export type InterfaceContinuity = 'continuous' | 'conflict' | 'unproven';
/** Continuity needs BOTH ifName and ifPhysAddress present on both sides and equal.
 * Either present-and-different is a conflict. Anything else proves nothing. */
export function interfaceContinuity(current: InterfaceIdentityEvidence, reported: InterfaceIdentityEvidence): InterfaceContinuity {
  const mac = (v: string | null) => normalizeMac(v) ?? (v ? v.toLowerCase() : null);
  const [cm, rm] = [mac(current.physAddress), mac(reported.physAddress)];
  if (current.name && reported.name && current.name !== reported.name) return 'conflict';
  if (cm && rm && cm !== rm) return 'conflict';
  return current.name && reported.name && cm && rm ? 'continuous' : 'unproven';
}
export type GenerationDecision = { action: 'keep' } | { action: 'allocate'; epoch: string; retireCurrent: boolean };
/**
 * `current` is the owner+key's non-retired physical generation; `highest` is the
 * largest generation number ever allocated for owner+key (retired included).
 * Missing evidence never proves continuity: a report that adds, drops or changes
 * identity evidence without corroborating it starts a new generation. A report
 * that repeats exactly the stored (uncorroborated) tuple carries no new evidence
 * of change and keeps the generation — otherwise every MAC-less interface would
 * churn a generation on each unrelated section change.
 */
export function planInterfaceGeneration(current: InterfaceIdentityEvidence | null, highest: number, reported: InterfaceIdentityEvidence): GenerationDecision {
  const next = `${PHYSICAL_GENERATION_PREFIX}${highest + 1}`;
  if (!current) return { action: 'allocate', epoch: next, retireCurrent: false };
  const continuity = interfaceContinuity(current, reported);
  if (continuity === 'continuous') return { action: 'keep' };
  const same = current.name === reported.name && normalizeMac(current.physAddress) === normalizeMac(reported.physAddress) && current.osIndex === reported.osIndex;
  if (continuity === 'unproven' && same) return { action: 'keep' };
  return { action: 'allocate', epoch: next, retireCurrent: true };
}

export type PhysicalInterfaceView = {
  id: string; ownerNodeId: string; interfaceKey: string; epoch: string; name?: string | null; alias?: string | null;
  osIndex?: string | null; physAddress?: string | null; retiredAt?: Date | null;
};
export type PhysicalIdentityIndex = {
  /** Current (non-retired) interfaces by owner node. */
  interfaces: Map<string, PhysicalInterfaceView[]>;
  /** Normalized MAC -> nodes claiming it (agent NICs, current SNMP interface MACs, targets' own MAC chassis ids). */
  nodesByMac: Map<string, Set<string>>;
  /** Non-MAC typed chassis id (`<subtype>:<value>`) -> targets claiming it as their own. */
  nodesByChassis: Map<string, Set<string>>;
};
/** A target's own LLDP chassis (lldpLocChassisId*), attributed to its subject node. */
export type PhysicalChassisClaim = { nodeId: string; id: TypedId };
export const typedChassisKey = (id: TypedId) => `${id.subtype}:${id.value}`;
export function buildPhysicalIdentityIndex(input: { interfaces: Iterable<PhysicalInterfaceView>; deviceMacs: { nodeId: string; mac: string }[]; chassisIds?: PhysicalChassisClaim[]; resolveNode?: (id: string) => string }): PhysicalIdentityIndex {
  const resolve = input.resolveNode ?? ((id: string) => id);
  const interfaces = new Map<string, PhysicalInterfaceView[]>();
  const nodesByMac = new Map<string, Set<string>>();
  const nodesByChassis = new Map<string, Set<string>>();
  const claim = (mac: string | null, nodeId: string) => { if (mac) nodesByMac.set(mac, (nodesByMac.get(mac) ?? new Set()).add(resolve(nodeId))); };
  // Trusted: the authorized target's own report about itself. A MAC chassis joins
  // the MAC claims (a base MAC often matches no interface); any other subtype
  // resolves only by exact typed equality.
  for (const { nodeId, id } of input.chassisIds ?? []) {
    if (id.subtype === 'mac_address') claim(normalizeMac(id.value), nodeId);
    else { const k = typedChassisKey(id); nodesByChassis.set(k, (nodesByChassis.get(k) ?? new Set()).add(resolve(nodeId))); }
  }
  for (const row of input.interfaces) {
    if (row.retiredAt) continue;
    const owner = resolve(row.ownerNodeId);
    interfaces.set(owner, [...(interfaces.get(owner) ?? []), row]);
    if (isPhysicalGeneration(row.epoch)) claim(normalizeMac(row.physAddress), owner);
  }
  for (const { nodeId, mac } of input.deviceMacs) claim(normalizeMac(mac), nodeId);
  return { interfaces, nodesByMac, nodesByChassis };
}
const unique = <T>(rows: T[]): T | null => rows.length === 1 ? rows[0]! : null;

/** Local port -> the subject's current interface. Tagged namespaces never cross:
 * an lldp_local or bridge_port number is never compared with an ifIndex. */
export function resolveLocalInterface(index: PhysicalIdentityIndex, ownerNodeId: string, port: PortRef): PhysicalInterfaceView | null {
  const rows = index.interfaces.get(ownerNodeId) ?? [];
  if (port.resolvedInterfaceKey) return unique(rows.filter(i => i.interfaceKey === port.resolvedInterfaceKey && isPhysicalGeneration(i.epoch)));
  if (port.namespace === 'if_index') return unique(rows.filter(i => isPhysicalGeneration(i.epoch) && i.osIndex === port.value));
  if (port.namespace === 'if_name') return unique(rows.filter(i => isPhysicalGeneration(i.epoch) && i.name === port.value));
  return null;
}
/** A typed remote identity resolves by MAC, or by a target's exact typed chassis
 * claim, and only to exactly one node. */
export function resolveTypedNode(index: PhysicalIdentityIndex, id: TypedId | undefined): string | null {
  if (!id) return null;
  let nodes: Set<string> | undefined;
  if (id.subtype === 'mac_address') { const mac = normalizeMac(id.value); nodes = mac ? index.nodesByMac.get(mac) : undefined; }
  else nodes = index.nodesByChassis?.get(typedChassisKey(id));
  return nodes && nodes.size === 1 ? [...nodes][0]! : null;
}
/** Remote port on a resolved node: name/alias/MAC, uniquely, current generation only. */
export function resolveRemoteInterface(index: PhysicalIdentityIndex, nodeId: string, port: TypedId): PhysicalInterfaceView | null {
  const rows = (index.interfaces.get(nodeId) ?? []).filter(i => isPhysicalGeneration(i.epoch));
  if (port.subtype === 'interface_name') return unique(rows.filter(i => i.name === port.value));
  if (port.subtype === 'interface_alias') return unique(rows.filter(i => i.alias === port.value));
  if (port.subtype === 'mac_address') { const mac = normalizeMac(port.value); return mac ? unique(rows.filter(i => normalizeMac(i.physAddress) === mac)) : null; }
  return null;
}

export type SubjectAsset = { id: string; ipAddress: string | null };
/**
 * D3: the subject of an SNMP snapshot is the authorized dispatch target, named
 * by the source's authority key (`asset:<uuid>` or `<scheme>:<ip>`), resolved
 * to the node bound to that scoped discovered asset. The target address selects
 * the discovery record of that very target; it never merges two nodes.
 */
export function resolvePhysicalSubjectAsset(authorityKey: string, assets: SubjectAsset[]): string | null {
  const [scheme, ...rest] = authorityKey.split(':');
  const value = rest.join(':');
  if (scheme === 'asset') return unique(assets.filter(a => a.id === value.toLowerCase()))?.id ?? null;
  if (!value || !isIP(value)) return null;
  return unique(assets.filter(a => a.ipAddress !== null && a.ipAddress.replace(/\/\d+$/, '') === value))?.id ?? null;
}
export const physicalAuthorityOf = (contextKey: string) => contextKey.split('/')[0]!;
