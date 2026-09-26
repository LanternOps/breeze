import { createHash } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { and, eq, getTableColumns, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { devices, discoveryJobs, discoveryProfiles, topologyCollectionSources } from '../../db/schema';
import { registerTopologyProducerAuthority, topologySourceIdentity, type TopologyProducerAuthorityDecision, type TopologyProducerAuthorityRequest } from './collectionAuthority';
import { parseDiscoveryTargetAuthorityKey } from './discoveryAdjacency';
import { loadTopologyFlags } from './flags';

/**
 * M2 D7 discovery dispatch authority. The worker persists a bounded,
 * secret-free authorization snapshot on the job BEFORE the command leaves the
 * server; adjacency admission revalidates every report against it (and the
 * live job/profile/device state) — the snapshot is never taken from an upload.
 */
export const DISCOVERY_TOPOLOGY_PROTOCOLS = ['lldp', 'cdp', 'fdb', 'interfaces'] as const;
export const DISCOVERY_TOPOLOGY_CONTEXTS = ['default'] as const;
/** Matches discoveryWorker's stale-running expiry: nothing is admitted after it. */
export const DISCOVERY_TOPOLOGY_DEADLINE_MS = 15 * 60_000;
/** A completed job still admits in-flight per-target posts for this long (bounded by the deadline). */
export const DISCOVERY_TOPOLOGY_COMPLETED_GRACE_MS = 5 * 60_000;
const MAX_INCLUDED = 256, MAX_EXCLUDED = 1024;

const uuid = z.uuid();
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
export const discoveryTopologyDispatchSchema = z.object({
  version: z.literal(1),
  scope: z.object({ orgId: uuid, siteId: uuid }).strict(),
  deviceId: uuid,
  profileId: uuid,
  includedTargets: z.array(z.string().min(1).max(64)).max(MAX_INCLUDED),
  excludedTargets: z.array(z.string().min(1).max(64)).max(MAX_EXCLUDED),
  protocols: z.array(z.enum(DISCOVERY_TOPOLOGY_PROTOCOLS)).min(1).max(4),
  contexts: z.array(z.string().min(1).max(64)).min(1).max(8),
  configurationGeneration: hex64,
  acceptedAdjacencyVersions: z.array(z.literal(2)).length(1),
  producerEpoch: hex64,
  sourceIdentity: z.string().min(1).max(255),
  expectedIntervalSeconds: z.number().int().min(60).max(86400),
  dispatchedAt: z.iso.datetime(),
  deadline: z.iso.datetime(),
}).strict();
export type DiscoveryTopologyDispatch = z.infer<typeof discoveryTopologyDispatchSchema>;
/** The block added to the network_discovery command payload. Secret-free. */
export type DiscoveryTopologyCommandBlock = {
  acceptedAdjacencyVersions: [2]; producerEpoch: string; sourceIdentity: string; deadline: string;
  protocols: string[]; contexts: string[]; expectedIntervalSeconds: number;
};

const trimmedSorted = (values: readonly string[] | null | undefined) => [...new Set((values ?? []).map(v => v.trim()).filter(Boolean))].sort();
/** Server-owned configuration generation of a profile's topology authority: any
 * change to the target ranges or requested scopes rotates it (and with it the
 * physical producer epoch), so reports under a stale dispatch are refused. */
export function discoveryTopologyConfigurationGeneration(profile: { id: string; siteId: string; subnets: readonly string[] | null; excludeIps: readonly string[] | null }): string {
  return createHash('sha256').update(JSON.stringify(['topology-discovery-config-v1', profile.id, profile.siteId, trimmedSorted(profile.subnets),
    trimmedSorted(profile.excludeIps), [...DISCOVERY_TOPOLOGY_PROTOCOLS], [...DISCOVERY_TOPOLOGY_CONTEXTS]])).digest('hex');
}
/** Epoch the agent echoes and digests under for this dispatch. It changes exactly
 * when the device's heartbeat root epoch/credentials or the generation change. */
export function discoveryDispatchEpoch(root: { producerEpoch: string; configurationRevision: string }, configurationGeneration: string): string {
  return createHash('sha256').update(JSON.stringify(['topology-discovery-dispatch-epoch-v1', root.producerEpoch, root.configurationRevision, configurationGeneration])).digest('hex');
}
function expectedIntervalSeconds(schedule: unknown): number {
  const minutes = schedule && typeof schedule === 'object' && (schedule as { type?: unknown }).type === 'interval' ? Number((schedule as { intervalMinutes?: unknown }).intervalMinutes) : NaN;
  return Number.isFinite(minutes) && minutes > 0 ? Math.min(86400, Math.max(60, Math.round(minutes * 60))) : 86400;
}

/** Target must be inside an included range and not excluded. Subnets are CIDRs or single IPs (agent parseSubnets). */
export function isDiscoveryTargetAuthorized(address: string, snapshot: Pick<DiscoveryTopologyDispatch, 'includedTargets' | 'excludedTargets'>): boolean {
  const family = isIP(address);
  if (!family) return false;
  const type = family === 4 ? 'ipv4' : 'ipv6';
  const included = new BlockList();
  for (const entry of snapshot.includedTargets) {
    const [network, bits] = entry.split('/');
    const netFamily = isIP(network ?? '');
    if (!netFamily) continue;
    const prefix = bits === undefined ? (netFamily === 4 ? 32 : 128) : Number(bits);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > (netFamily === 4 ? 32 : 128)) continue;
    included.addSubnet(network!, prefix, netFamily === 4 ? 'ipv4' : 'ipv6');
  }
  if (!included.check(address, type)) return false;
  // Agent exclusion is an exact string match (scanner.go); match it and its canonical form.
  const excluded = new BlockList();
  for (const entry of snapshot.excludedTargets) {
    const f = isIP(entry);
    if (f) excluded.addAddress(entry, f === 4 ? 'ipv4' : 'ipv6');
  }
  return !excluded.check(address, type);
}

type ProfileRow = typeof discoveryProfiles.$inferSelect;
/**
 * Build and persist the dispatch snapshot for one job. Must run inside a DB
 * context (the worker's short system context) and BEFORE the command is sent.
 * Returns the command block, or null for a legacy-only dispatch
 * (materialization off, no SNMP, no negotiated root, unbounded ranges).
 */
export async function prepareDiscoveryTopologyDispatch(input: { jobId: string; orgId: string; siteId: string; profile: ProfileRow; agentId: string; now?: Date }): Promise<DiscoveryTopologyCommandBlock | null> {
  const { profile } = input;
  if (!(profile.methods ?? []).includes('snmp')) return null;
  const included = trimmedSorted(profile.subnets), excluded = trimmedSorted(profile.excludeIps);
  if (!included.length || included.length > MAX_INCLUDED || excluded.length > MAX_EXCLUDED || [...included, ...excluded].some(v => v.length > 64)) return null;
  const scope = { orgId: input.orgId, siteId: input.siteId };
  if (!(await loadTopologyFlags({ scope })).materialization) return null;
  const [device] = await db.select({ id: devices.id, orgId: devices.orgId, siteId: devices.siteId }).from(devices)
    .where(and(eq(devices.agentId, input.agentId), eq(devices.orgId, input.orgId))).limit(1);
  if (!device) return null;
  const [root] = await db.select().from(topologyCollectionSources).where(and(eq(topologyCollectionSources.orgId, device.orgId),
    eq(topologyCollectionSources.siteId, device.siteId), eq(topologyCollectionSources.producerId, device.id), eq(topologyCollectionSources.producerKind, 'agent'),
    eq(topologyCollectionSources.protocol, 'envelope'), eq(topologyCollectionSources.contextKey, 'root'), eq(topologyCollectionSources.addressFamily, 'any'))).limit(1);
  if (!root || root.revokedAt) return null;
  const now = input.now ?? new Date();
  const configurationGeneration = discoveryTopologyConfigurationGeneration(profile);
  const deadline = new Date(now.getTime() + DISCOVERY_TOPOLOGY_DEADLINE_MS);
  const snapshot: DiscoveryTopologyDispatch = discoveryTopologyDispatchSchema.parse({
    version: 1, scope, deviceId: device.id, profileId: profile.id, includedTargets: included, excludedTargets: excluded,
    protocols: [...DISCOVERY_TOPOLOGY_PROTOCOLS], contexts: [...DISCOVERY_TOPOLOGY_CONTEXTS], configurationGeneration, acceptedAdjacencyVersions: [2],
    producerEpoch: discoveryDispatchEpoch(root, configurationGeneration),
    sourceIdentity: topologySourceIdentity({ scope, producerKind: 'discovery', deviceId: device.id }),
    expectedIntervalSeconds: expectedIntervalSeconds(profile.schedule), dispatchedAt: now.toISOString(), deadline: deadline.toISOString(),
  });
  const updated = await db.update(discoveryJobs).set({ topologyDispatch: snapshot, topologyDeadlineAt: deadline, topologyConfigGeneration: configurationGeneration, updatedAt: new Date() })
    .where(and(eq(discoveryJobs.id, input.jobId), eq(discoveryJobs.orgId, input.orgId), eq(discoveryJobs.siteId, input.siteId))).returning({ id: discoveryJobs.id });
  if (!updated.length) return null;
  return { acceptedAdjacencyVersions: [2], producerEpoch: snapshot.producerEpoch, sourceIdentity: snapshot.sourceIdentity, deadline: snapshot.deadline,
    protocols: snapshot.protocols, contexts: snapshot.contexts, expectedIntervalSeconds: snapshot.expectedIntervalSeconds };
}

export type DiscoveryParentRejection = { ok: false; status: 403 | 409 | 410; reason: string };
export type DiscoveryParentAuthority = { ok: true; job: typeof discoveryJobs.$inferSelect & { completedWithinGrace: boolean }; snapshot: DiscoveryTopologyDispatch };
/**
 * Live revalidation of a parent job for one device: ownership (collecting
 * device, not transport agentId), scope, lifecycle (running, or completed
 * within the grace), deadline, and that the profile's current configuration
 * generation still equals the dispatched one. Runs inside the caller's DB context.
 */
export async function evaluateDiscoveryParent(input: { deviceId: string; orgId: string; parentJobId: string; parentCommandId?: string; now?: Date }): Promise<DiscoveryParentAuthority | DiscoveryParentRejection> {
  const now = input.now ?? new Date();
  if (!uuid.safeParse(input.parentJobId).success || (input.parentCommandId !== undefined && input.parentCommandId !== input.parentJobId)) return { ok: false, status: 403, reason: 'parent_mismatch' };
  // completed_at is an offsetless UTC wall-clock column: compare it in SQL, never via a driver-parsed Date.
  const [job] = await db.select({ ...getTableColumns(discoveryJobs),
    completedWithinGrace: sql<boolean>`coalesce(${discoveryJobs.completedAt} > (now() AT TIME ZONE 'UTC') - make_interval(secs => ${DISCOVERY_TOPOLOGY_COMPLETED_GRACE_MS / 1000}), false)` })
    .from(discoveryJobs).where(and(eq(discoveryJobs.id, input.parentJobId), eq(discoveryJobs.orgId, input.orgId))).limit(1);
  if (!job) return { ok: false, status: 403, reason: 'foreign_job' };
  const parsed = discoveryTopologyDispatchSchema.safeParse(job.topologyDispatch);
  if (!parsed.success || !job.topologyDeadlineAt || !job.topologyConfigGeneration) return { ok: false, status: 403, reason: 'topology_not_dispatched' };
  const snapshot = parsed.data;
  if (snapshot.deviceId !== input.deviceId) return { ok: false, status: 403, reason: 'foreign_job' };
  if (snapshot.scope.orgId !== job.orgId || snapshot.scope.siteId !== job.siteId || snapshot.configurationGeneration !== job.topologyConfigGeneration) return { ok: false, status: 403, reason: 'topology_not_dispatched' };
  if (now.getTime() >= job.topologyDeadlineAt.getTime()) return { ok: false, status: 410, reason: 'parent_expired' };
  const live = job.status === 'running' || job.status === 'scheduled'
    || (job.status === 'completed' && job.completedWithinGrace === true);
  if (!live) return { ok: false, status: 409, reason: 'parent_not_running' };
  const [profile] = await db.select({ id: discoveryProfiles.id, siteId: discoveryProfiles.siteId, subnets: discoveryProfiles.subnets, excludeIps: discoveryProfiles.excludeIps })
    .from(discoveryProfiles).where(and(eq(discoveryProfiles.id, job.profileId), eq(discoveryProfiles.orgId, job.orgId))).limit(1);
  if (!profile || profile.id !== snapshot.profileId || discoveryTopologyConfigurationGeneration(profile) !== job.topologyConfigGeneration) return { ok: false, status: 409, reason: 'configuration_changed' };
  return { ok: true, job, snapshot };
}

/** The registered 'discovery' producer authority (D1/D7): re-run inside every ingest transaction. */
export async function discoveryTopologyAuthority(request: TopologyProducerAuthorityRequest): Promise<TopologyProducerAuthorityDecision> {
  if (request.producerKind !== 'discovery' || !request.parentJobId) return { authorized: false, reason: 'producer_authority_denied' };
  const parent = await evaluateDiscoveryParent({ deviceId: request.device.id, orgId: request.device.orgId, parentJobId: request.parentJobId, parentCommandId: request.parentCommandId });
  if (!parent.ok) return { authorized: false, reason: parent.reason };
  if (parent.job.orgId !== request.scope.orgId || parent.job.siteId !== request.scope.siteId) return { authorized: false, reason: 'foreign_job' };
  const target = parseDiscoveryTargetAuthorityKey(request.authorityKey);
  if (!target || target.zone !== null || !isDiscoveryTargetAuthorized(target.address, parent.snapshot)) return { authorized: false, reason: 'target_not_authorized' };
  return { authorized: true, configurationGeneration: parent.snapshot.configurationGeneration };
}

let registered = false;
/** Idempotent: the API process registers the discovery authority once. */
export function ensureDiscoveryTopologyAuthority(): void {
  if (registered) return;
  registerTopologyProducerAuthority('discovery', discoveryTopologyAuthority);
  registered = true;
}
