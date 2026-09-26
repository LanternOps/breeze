import { createHash } from 'node:crypto';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { TopologyScope } from '@breeze/shared';
import { assertInTransaction, db } from '../../db';
import { devices, topologyCollectionSources, unifiCollectors, unifiSiteMappings } from '../../db/schema';
import { loadTopologyFlags } from './flags';
import { isTopologyProducerAuthorityRegistered, registerTopologyProducerAuthority, revokeTopologySources, topologySourceIdentity, type TopologyProducerAuthority } from './collectionAuthority';

/**
 * UniFi controller-site authority (M2 Task 5, amendments D1/D9/D16).
 *
 * A UniFi topology source is authorized per (collector, controller site): the
 * collector must belong to the reporting device and the controller site must be
 * an EXACT `unifi_site_mappings` row for the collector's integration + host axis.
 * There is no fallback to the collector's own site (unlike legacy telemetry).
 *
 * Generations are derived from authority-bearing fields only. `updated_at` is
 * deliberately NOT an input: the cloud sync bumps `unifi_site_mappings.updated_at`
 * on every WAN-metrics refresh and every poll bumps `unifi_collectors.updated_at`,
 * which would rotate the producer epoch (and re-baseline every source) each poll.
 * `topology_generation` (mapping and collector) is the explicit counter instead:
 * every revocation helper below advances it, so re-authorizing the same
 * mapping/collector later (e.g. a remap back) derives a new epoch — a source
 * fenced under its current epoch never re-baselines.
 */
export type UnifiCollectorAuthority = {
  id: string; integrationId: string; orgId: string; siteId: string; unifiHostId: string | null;
  collectorDeviceId: string; controllerUrl: string; isEnabled: boolean; topologyGeneration: number;
};
type MappingIdentity = { id: string; orgId: string; siteId: string; topologyGeneration: number };

const hash = (...parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const uuid = z.uuid();
const AUTHORITY_KEY = /^[^\s\u0000-\u001f\u007f/]{1,200}$/u;

/** Mapping host axis: cloud collectors carry a UniFi host id; self-hosted mappings use the collector id sentinel. */
export const unifiHostKey = (collector: Pick<UnifiCollectorAuthority, 'id' | 'unifiHostId'>) => collector.unifiHostId ?? collector.id;
/** `<collectorId>:<controllerSiteId>`, or null when ingest could never accept it (namespace rule of collectionAuthority). */
export function unifiAuthorityKey(collectorId: string, controllerSiteId: string): string | null {
  const key = `${collectorId}:${controllerSiteId}`;
  return controllerSiteId.length > 0 && AUTHORITY_KEY.test(key) ? key : null;
}
export function unifiCollectorRevision(c: UnifiCollectorAuthority): string {
  return hash('unifi-collector-revision-v1', c.id, c.integrationId, c.orgId, c.siteId, c.unifiHostId, c.collectorDeviceId, c.controllerUrl, c.isEnabled, c.topologyGeneration);
}
export function unifiAuthorityGeneration(mapping: MappingIdentity, collector: UnifiCollectorAuthority): string {
  return hash('unifi-authority-generation-v1', mapping.id, mapping.orgId, mapping.siteId, mapping.topologyGeneration, unifiCollectorRevision(collector));
}
/** Collector-level credentials the agent binds its resource digests and sequence to.
 * Rotates with the device's heartbeat root epoch/configuration and the collector
 * revision; each rotation also rotates every per-site physical epoch derived from
 * the same root and generation, so an agent-side sequence restart is always safe. */
export function unifiCollectorTopologyCredentials(input: {
  root: { producerEpoch: string; configurationRevision: string }; collector: UnifiCollectorAuthority; deviceId: string;
}): { producerEpoch: string; sourceIdentity: string } {
  return {
    producerEpoch: hash('unifi-collector-epoch-v1', input.root.producerEpoch, input.root.configurationRevision, unifiCollectorRevision(input.collector)),
    sourceIdentity: topologySourceIdentity({ scope: { orgId: input.collector.orgId, siteId: input.collector.siteId }, producerKind: 'unifi', deviceId: input.deviceId, collectorId: input.collector.id }),
  };
}

// Lazy: agent route suites mock ../db/schema without the UniFi tables, and this
// module is imported (for its authority registration) by the agent routes.
const collectorColumns = () => ({
  id: unifiCollectors.id, integrationId: unifiCollectors.integrationId, orgId: unifiCollectors.orgId, siteId: unifiCollectors.siteId,
  unifiHostId: unifiCollectors.unifiHostId, collectorDeviceId: unifiCollectors.collectorDeviceId, controllerUrl: unifiCollectors.controllerUrl, isEnabled: unifiCollectors.isEnabled,
  topologyGeneration: unifiCollectors.topologyGeneration,
});
export async function loadUnifiCollector(collectorId: string): Promise<UnifiCollectorAuthority | null> {
  if (!uuid.safeParse(collectorId).success) return null;
  const [row] = await db.select(collectorColumns()).from(unifiCollectors).where(eq(unifiCollectors.id, collectorId)).limit(1);
  return row ?? null;
}
async function exactMapping(collector: UnifiCollectorAuthority, controllerSiteId: string): Promise<MappingIdentity | null> {
  const [row] = await db.select({ id: unifiSiteMappings.id, orgId: unifiSiteMappings.orgId, siteId: unifiSiteMappings.siteId, topologyGeneration: unifiSiteMappings.topologyGeneration }).from(unifiSiteMappings)
    .where(and(eq(unifiSiteMappings.integrationId, collector.integrationId), eq(unifiSiteMappings.unifiHostId, unifiHostKey(collector)),
      eq(unifiSiteMappings.unifiSiteId, controllerSiteId))).limit(1);
  return row ?? null;
}

/** Exact integration/host/controller-site mapping → one scope; anything else → null. Never the collector's own site. */
export async function resolveUnifiSourceScope(collectorId: string, controllerSiteId: string): Promise<TopologyScope | null> {
  const collector = await loadUnifiCollector(collectorId);
  if (!collector) return null;
  const mapping = await exactMapping(collector, controllerSiteId);
  return mapping ? { orgId: mapping.orgId, siteId: mapping.siteId } : null;
}

export const unifiTopologyAuthority: TopologyProducerAuthority = async request => {
  if (!request.collectorId) return { authorized: false, reason: 'collector_not_owned' };
  const collector = await loadUnifiCollector(request.collectorId);
  if (!collector || !collector.isEnabled || collector.collectorDeviceId !== request.device.id || collector.orgId !== request.device.orgId) {
    return { authorized: false, reason: 'collector_not_owned' };
  }
  const mapping = await exactMapping(collector, request.authorityKey.slice(request.collectorId.length + 1));
  if (!mapping) return { authorized: false, reason: 'controller_site_unmapped' };
  if (mapping.orgId !== request.scope.orgId || mapping.siteId !== request.scope.siteId) return { authorized: false, reason: 'controller_site_remapped' };
  return { authorized: true, configurationGeneration: unifiAuthorityGeneration(mapping, collector) };
};
/** Idempotent explicit registration (called by `registerTopologyPhysicalAuthorities`
 * at API/worker boot and by the ingest entry points). Never an import side effect:
 * an unregistered kind must fail closed, not depend on module load order. */
export function ensureUnifiTopologyAuthority(): void {
  if (!isTopologyProducerAuthorityRegistered('unifi')) registerTopologyProducerAuthority('unifi', unifiTopologyAuthority);
}

/** Collector credentials to advertise, or null (legacy-only). Requires: the
 * collector is enabled and owned by this device, the device has a live heartbeat
 * root, at least one exact same-org controller-site mapping exists, and topology
 * materialization is on for that org (D9: capability attributed to mapped sites). */
export async function currentUnifiCollectorTopology(deviceId: string, collector: UnifiCollectorAuthority): Promise<{ producerEpoch: string; sourceIdentity: string } | null> {
  if (!collector.isEnabled || collector.collectorDeviceId !== deviceId || !uuid.safeParse(deviceId).success) return null;
  const [device] = await db.select({ orgId: devices.orgId, siteId: devices.siteId }).from(devices).where(eq(devices.id, deviceId)).limit(1);
  if (!device || device.orgId !== collector.orgId) return null;
  const [root] = await db.select({ producerEpoch: topologyCollectionSources.producerEpoch, configurationRevision: topologyCollectionSources.configurationRevision })
    .from(topologyCollectionSources).where(and(eq(topologyCollectionSources.orgId, device.orgId), eq(topologyCollectionSources.siteId, device.siteId),
      eq(topologyCollectionSources.producerId, deviceId), eq(topologyCollectionSources.producerKind, 'agent'), eq(topologyCollectionSources.protocol, 'envelope'),
      eq(topologyCollectionSources.contextKey, 'root'), eq(topologyCollectionSources.addressFamily, 'any'), isNull(topologyCollectionSources.revokedAt))).limit(1);
  if (!root) return null;
  const [mapped] = await db.select({ id: unifiSiteMappings.id }).from(unifiSiteMappings).where(and(eq(unifiSiteMappings.integrationId, collector.integrationId),
    eq(unifiSiteMappings.unifiHostId, unifiHostKey(collector)), eq(unifiSiteMappings.orgId, collector.orgId))).limit(1);
  if (!mapped) return null;
  if (!(await loadTopologyFlags({ scope: { orgId: collector.orgId, siteId: collector.siteId } })).materialization) return null;
  return unifiCollectorTopologyCredentials({ root, collector, deviceId });
}

export type UnifiTopologyAdvertisement = { acceptedUnifiTopologyVersions: number[]; topologyProducerEpoch: string; topologySourceIdentity: string };
/** Advertisement for GET /agents/:id/unifi-collectors. Never breaks legacy config
 * delivery: failures run in a savepoint and degrade to "not advertised". */
export async function unifiTopologyAdvertisement(deviceId: string, collectorId: string): Promise<UnifiTopologyAdvertisement | null> {
  try {
    return await db.transaction(async () => {
      const collector = await loadUnifiCollector(collectorId);
      const current = collector ? await currentUnifiCollectorTopology(deviceId, collector) : null;
      return current ? { acceptedUnifiTopologyVersions: [1], topologyProducerEpoch: current.producerEpoch, topologySourceIdentity: current.sourceIdentity } : null;
    });
  } catch (error) {
    console.error('[unifi] topology advertisement failed; collector stays legacy-only:', error instanceof Error ? error.message : error);
    return null;
  }
}

// ---- Source lifecycle revocation (D1): controller remap, collector change/delete ----

/** Revoke every live UniFi source of a collector, in every site holding one, and
 * advance the collector's generation (a no-op when the collector row is gone). */
export async function revokeUnifiCollectorTopology(collectorId: string): Promise<number> {
  assertInTransaction('revokeUnifiCollectorTopology');
  if (!uuid.safeParse(collectorId).success) return 0;
  await db.update(unifiCollectors).set({ topologyGeneration: sql`${unifiCollectors.topologyGeneration}+1` }).where(eq(unifiCollectors.id, collectorId));
  const scopes = await db.selectDistinct({ orgId: topologyCollectionSources.orgId, siteId: topologyCollectionSources.siteId }).from(topologyCollectionSources)
    .where(and(eq(topologyCollectionSources.producerKind, 'unifi'), isNull(topologyCollectionSources.revokedAt),
      sql`starts_with(${topologyCollectionSources.contextKey}, ${`${collectorId}:`})`));
  let revoked = 0;
  for (const scope of scopes) revoked += await revokeTopologySources(scope, { producerKind: 'unifi', collectorId });
  return revoked;
}
export async function revokeUnifiIntegrationTopology(integrationId: string): Promise<number> {
  assertInTransaction('revokeUnifiIntegrationTopology');
  const collectors = await db.select({ id: unifiCollectors.id }).from(unifiCollectors).where(eq(unifiCollectors.integrationId, integrationId));
  let revoked = 0;
  for (const collector of collectors) revoked += await revokeUnifiCollectorTopology(collector.id);
  return revoked;
}
/** A mapping row changed scope or was deleted: revoke the sources it authorized in
 * its OLD scope and advance the (surviving) mapping's generation. */
export async function revokeUnifiMappingTopology(mapping: { integrationId: string; unifiHostId: string; unifiSiteId: string; orgId: string; siteId: string }): Promise<number> {
  assertInTransaction('revokeUnifiMappingTopology');
  await db.update(unifiSiteMappings).set({ topologyGeneration: sql`${unifiSiteMappings.topologyGeneration}+1` }).where(and(eq(unifiSiteMappings.integrationId, mapping.integrationId),
    eq(unifiSiteMappings.unifiHostId, mapping.unifiHostId), eq(unifiSiteMappings.unifiSiteId, mapping.unifiSiteId)));
  const collectors = await db.select({ id: unifiCollectors.id }).from(unifiCollectors).where(and(eq(unifiCollectors.integrationId, mapping.integrationId),
    or(eq(unifiCollectors.unifiHostId, mapping.unifiHostId), and(isNull(unifiCollectors.unifiHostId), sql`${unifiCollectors.id}::text = ${mapping.unifiHostId}`))));
  let revoked = 0;
  for (const collector of collectors) {
    const authorityKey = unifiAuthorityKey(collector.id, mapping.unifiSiteId);
    if (authorityKey) revoked += await revokeTopologySources({ orgId: mapping.orgId, siteId: mapping.siteId }, { producerKind: 'unifi', authorityKey });
  }
  return revoked;
}
/** Collector upsert: revoke only when the authority-bearing revision changed.
 * Revoking under an unchanged revision would fence the sources permanently (a
 * fenced source re-baselines only under a new epoch). */
export async function revokeUnifiCollectorTopologyIfChanged(before: UnifiCollectorAuthority | null, after: UnifiCollectorAuthority | null): Promise<number> {
  if (!before) return 0;
  if (after && unifiCollectorRevision(before) === unifiCollectorRevision(after)) return 0;
  return revokeUnifiCollectorTopology(before.id);
}

// ---- Drift detection for the mapping/collector mutation routes ----
// Routes snapshot the integration's rows before a mutation and call the drift
// helper after it; any row that was deleted, re-pointed or (collectors) whose
// authority revision changed has its topology sources revoked.

export type UnifiMappingSnapshot = { id: string; integrationId: string; unifiHostId: string; unifiSiteId: string; orgId: string; siteId: string };
export async function snapshotUnifiMappings(integrationId: string): Promise<UnifiMappingSnapshot[]> {
  return db.select({ id: unifiSiteMappings.id, integrationId: unifiSiteMappings.integrationId, unifiHostId: unifiSiteMappings.unifiHostId,
    unifiSiteId: unifiSiteMappings.unifiSiteId, orgId: unifiSiteMappings.orgId, siteId: unifiSiteMappings.siteId }).from(unifiSiteMappings)
    .where(eq(unifiSiteMappings.integrationId, integrationId));
}
export async function revokeUnifiMappingDrift(integrationId: string, before: UnifiMappingSnapshot[]): Promise<number> {
  if (!before.length) return 0;
  const after = new Map((await snapshotUnifiMappings(integrationId)).map(m => [JSON.stringify([m.unifiHostId, m.unifiSiteId]), m]));
  let revoked = 0;
  for (const old of before) {
    const now = after.get(JSON.stringify([old.unifiHostId, old.unifiSiteId]));
    if (!now || now.id !== old.id || now.orgId !== old.orgId || now.siteId !== old.siteId) revoked += await revokeUnifiMappingTopology(old);
  }
  return revoked;
}
export async function snapshotUnifiCollectors(integrationId: string): Promise<UnifiCollectorAuthority[]> {
  return db.select(collectorColumns()).from(unifiCollectors).where(eq(unifiCollectors.integrationId, integrationId));
}
export async function revokeUnifiCollectorDrift(integrationId: string, before: UnifiCollectorAuthority[]): Promise<number> {
  if (!before.length) return 0;
  const after = new Map((await snapshotUnifiCollectors(integrationId)).map(c => [c.id, c]));
  let revoked = 0;
  for (const old of before) revoked += await revokeUnifiCollectorTopologyIfChanged(old, after.get(old.id) ?? null);
  return revoked;
}
