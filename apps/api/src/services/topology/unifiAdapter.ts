/**
 * UniFi topology adapter (M2 Task 5; amendments D1, D3, D9, D16).
 *
 * Turns one authenticated collector upload (`topologyV1`, shared
 * `unifiTopologyV1Schema`) into per-(controller site, resource) M1 source reports:
 *
 * 1. The collector-level epoch/identity the agent bound its digests to must be
 *    current (`currentUnifiCollectorTopology`), and every resource digest is
 *    recomputed with the shared canonicalizer.
 * 2. Each resource resolves its scope through an EXACT integration/host/
 *    controller-site mapping (`resolveUnifiSourceScope`). Unmapped (or
 *    other-org) controller sites emit nothing and leave one bounded coverage note
 *    on `unifi_controller_sites.topology_coverage_reason`. There is no fallback
 *    to the collector's own site.
 * 3. A mapped resource is normalized (identity material below), digested for its
 *    scoped producer and ingested through `ingestTopologySourceReport` — a
 *    `full` report, or an `unchanged` confirmation of the exact retained baseline
 *    when the normalized digest is unchanged (no run is created).
 *
 * Normalized UniFi rows (retained section rows; consumed by the Task 6 projector;
 * schemas in packages/shared/src/validators/topologyUnifiNormalized.ts):
 *
 *   section kind           row = wire row (topologyPhysical.ts) +
 *   unifi_device_list      endpointKey, inventoryDeviceId
 *   unifi_client_list      endpointKey, uplinkEndpointKey, inventoryDeviceId
 *   unifi_device_details   endpointKey, uplinkEndpointKey
 *   unifi_statistics       endpointKey
 *
 *   endpointKey        `unifi:<hostKey>:<controllerSiteId>:device:<deviceId>` for
 *                      controller devices; clients `…:mac:<mac>` (or
 *                      `…:client:<clientId>` without a MAC). Components are
 *                      URI-encoded. A controller endpoint is its OWN scoped
 *                      node identity (D16); never merged by name/IP.
 *   uplinkEndpointKey  the uplink controller device in the SAME host/site
 *                      namespace, or null. Port = the wire `uplinkPortIndex`.
 *   inventoryDeviceId  Breeze device bound by a unique same-site agent-reported
 *                      NIC MAC (`device_network`), else null (stays unbound).
 *
 * Section `contextKey` = authority key `<collectorId>:<controllerSiteId>`; rowKey
 * = the wire rowKey (controller device/client id), so a roaming client keeps its
 * row and the projector derives the association from (endpointKey,
 * uplinkEndpointKey, uplinkPortIndex). The adapter never reads legacy
 * `reconcileTelemetry` associations or `discovered_assets` MACs.
 */
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { canonicalizeUnifiResource, unifiEndpointKey, type TopologyScope, type UnifiDigestIdentity, type UnifiResource, type UnifiTopologyV1 } from '@breeze/shared';
import { assertInTransaction, db } from '../../db';
import { topologyCollectionSources, unifiControllerSites } from '../../db/schema';
import { canonicalMac } from '../unifi/unifiMac';
import { resolveTopologyPhysicalProducer, TOPOLOGY_PRODUCER_REJECTIONS } from './collectionAuthority';
import { canonicalFactValue } from './collectionFactKeys';
import { ingestTopologySourceReport } from './collectionIngest';
import type { NormalizedTopologyReport, UnifiSourceSection } from './collectionTypes';
import { currentUnifiCollectorTopology, resolveUnifiSourceScope, unifiAuthorityKey, unifiHostKey, type UnifiCollectorAuthority } from './unifiAuthority';

export type ScopedMacCandidate = { id: string; orgId: string; siteId: string; mac: string };
/** Binding only for exactly one distinct same-scope candidate; never the first org-wide match. */
export function uniqueSiteMacMatch(scope: TopologyScope, mac: string, rows: ScopedMacCandidate[]): string | null {
  const target = canonicalMac(mac);
  if (!target) return null;
  const ids = new Set(rows.filter(r => r.orgId === scope.orgId && r.siteId === scope.siteId && canonicalMac(r.mac) === target).map(r => r.id));
  return ids.size === 1 ? [...ids][0]! : null;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
/** Recompute the collector's resource digest (shared canonicalization v1). */
export function unifiWireDigestMatches(identity: UnifiDigestIdentity, resource: UnifiResource): boolean {
  return sha256(canonicalizeUnifiResource(identity, resource)) === resource.contentDigest;
}

const SECTION_KIND = { device_list: 'unifi_device_list', client_list: 'unifi_client_list', device_details: 'unifi_device_details', statistics: 'unifi_statistics' } as const;
type UnnormalizedSection = Omit<UnifiSourceSection, 'contentDigest'>;
/** Pure: wire resource → retained section without digest (rows sorted by rowKey). */
export function normalizeUnifiResource(input: { hostKey: string; authorityKey: string; resource: UnifiResource; bindings: ReadonlyMap<string, string> }): UnnormalizedSection {
  const { resource } = input;
  const key = (kind: 'device' | 'mac' | 'client', value: string) => unifiEndpointKey({ hostKey: input.hostKey, controllerSiteId: resource.controllerSiteId, kind, value });
  const bind = (mac: string | null) => { const m = canonicalMac(mac); return m ? input.bindings.get(m) ?? null : null; };
  const uplink = (id: string | null) => (id ? key('device', id) : null);
  let rows: { rowKey: string }[];
  switch (resource.kind) {
    case 'device_list': rows = resource.rows.map(r => ({ ...r, endpointKey: key('device', r.deviceId), inventoryDeviceId: bind(r.mac) })); break;
    case 'client_list': rows = resource.rows.map(r => {
      const mac = canonicalMac(r.mac);
      return { ...r, endpointKey: mac ? key('mac', mac) : key('client', r.clientId), uplinkEndpointKey: uplink(r.uplinkDeviceId), inventoryDeviceId: bind(r.mac) };
    }); break;
    case 'device_details': rows = resource.rows.map(r => ({ ...r, endpointKey: key('device', r.deviceId), uplinkEndpointKey: uplink(r.uplinkDeviceId) })); break;
    case 'statistics': rows = resource.rows.map(r => ({ ...r, endpointKey: key('device', r.deviceId) })); break;
  }
  rows.sort((a, b) => (a.rowKey < b.rowKey ? -1 : a.rowKey > b.rowKey ? 1 : 0));
  return {
    kind: SECTION_KIND[resource.kind], contextKey: input.authorityKey, outcome: resource.outcome, ...(resource.reasonCode !== undefined ? { reasonCode: resource.reasonCode } : {}),
    rowCount: rows.length, ...(resource.omittedRowCount !== undefined ? { omittedRowCount: resource.omittedRowCount } : {}), rows,
  } as UnnormalizedSection;
}
/** Normalized-section digest, bound to the scoped producer identity and epoch. */
export function unifiNormalizedDigest(producer: { sourceIdentity: string; producerEpoch: string }, section: UnnormalizedSection | UnifiSourceSection): string {
  const { contentDigest: _digest, rows, ...rest } = section as UnifiSourceSection;
  const ordered = [...(rows as { rowKey: string }[])].sort((a, b) => (a.rowKey < b.rowKey ? -1 : a.rowKey > b.rowKey ? 1 : 0));
  return sha256(JSON.stringify(canonicalFactValue({ contract: 'unifi_topology_normalized_v1', sourceIdentity: producer.sourceIdentity, producerEpoch: producer.producerEpoch, section: { ...rest, rows: ordered } })));
}

/** Agent-reported NIC MACs of devices in exactly this scope (D16: the only binding source). */
async function siteMacCandidates(scope: TopologyScope, macs: string[]): Promise<ScopedMacCandidate[]> {
  if (!macs.length) return [];
  const rows = await db.execute(sql`SELECT d.id::text AS id, d.org_id::text AS org_id, d.site_id::text AS site_id, dn.mac_address AS mac
    FROM device_network dn JOIN devices d ON d.id = dn.device_id AND d.org_id = dn.org_id
    WHERE d.org_id = ${scope.orgId}::uuid AND d.site_id = ${scope.siteId}::uuid AND NOT d.is_ephemeral AND d.status <> 'decommissioned'
      AND dn.mac_address IS NOT NULL
      AND lower(replace(btrim(dn.mac_address), '-', ':')) IN (SELECT jsonb_array_elements_text(${JSON.stringify(macs)}::jsonb))`);
  return rows.map(r => ({ id: String(r.id), orgId: String(r.org_id), siteId: String(r.site_id), mac: String(r.mac) }));
}
async function bindingsFor(scope: TopologyScope, resource: UnifiResource): Promise<Map<string, string>> {
  if (resource.kind !== 'device_list' && resource.kind !== 'client_list') return new Map();
  const macs = [...new Set((resource.rows as { mac: string | null }[]).map(r => canonicalMac(r.mac)).filter((m): m is string => m !== null))];
  const candidates = await siteMacCandidates(scope, macs);
  const bindings = new Map<string, string>();
  for (const mac of macs) { const id = uniqueSiteMacMatch(scope, mac, candidates); if (id) bindings.set(mac, id); }
  return bindings;
}

export type UnifiResourceReceipt = {
  controllerSiteId: string; kind: UnifiResource['kind']; accepted: boolean;
  /** The collector's (wire) digest that was accepted; the agent acknowledges exactly this. */
  contentDigest?: string; acceptedSequence?: string; reason?: string;
};
export type UnifiTopologyReceipt = { accepted: boolean; producerEpoch?: string; reportSequence?: string; reason?: string; resources: UnifiResourceReceipt[] };
const ADAPTER_REJECTIONS = new Set([...TOPOLOGY_PRODUCER_REJECTIONS, 'source_key_mismatch', 'invalid_source_section']);

async function noteCoverage(collector: UnifiCollectorAuthority, notes: Map<string, string | null>) {
  for (const [controllerSiteId, reason] of notes) {
    if (reason === null) {
      await db.update(unifiControllerSites).set({ topologyCoverageReason: null, topologyCoverageAt: new Date() }).where(and(eq(unifiControllerSites.collectorId, collector.id),
        eq(unifiControllerSites.localSiteId, controllerSiteId), sql`${unifiControllerSites.topologyCoverageReason} IS NOT NULL`));
    } else {
      await db.execute(sql`INSERT INTO unifi_controller_sites (collector_id, org_id, local_site_id, topology_coverage_reason, topology_coverage_at)
        VALUES (${collector.id}::uuid, ${collector.orgId}::uuid, ${controllerSiteId}, ${reason}, now())
        ON CONFLICT (collector_id, local_site_id) DO UPDATE SET topology_coverage_reason = EXCLUDED.topology_coverage_reason, topology_coverage_at = now()
        WHERE unifi_controller_sites.topology_coverage_reason IS DISTINCT FROM EXCLUDED.topology_coverage_reason`);
    }
  }
}

/** Synchronous ingest of one collector upload. Callers own the transaction and
 * system DB context; each resource runs in its own savepoint so one rejected
 * controller site never discards another's receipt. */
export async function adaptUnifiTopology(deviceId: string, collector: UnifiCollectorAuthority, report: UnifiTopologyV1): Promise<UnifiTopologyReceipt> {
  assertInTransaction('adaptUnifiTopology');
  const base = { reportSequence: report.sequence };
  const current = await currentUnifiCollectorTopology(deviceId, collector);
  if (!current) return { ...base, accepted: false, reason: 'topology_unavailable', resources: [] };
  if (report.producerEpoch !== current.producerEpoch) return { ...base, producerEpoch: current.producerEpoch, accepted: false, reason: 'producer_epoch_changed', resources: [] };
  const hostKey = unifiHostKey(collector);
  const scopes = new Map<string, TopologyScope | null>();
  const coverage = new Map<string, string | null>();
  const resources: UnifiResourceReceipt[] = [];
  for (const resource of report.resources) {
    const out = { controllerSiteId: resource.controllerSiteId, kind: resource.kind };
    const reject = (reason: string, note?: string) => {
      if (note) coverage.set(resource.controllerSiteId, note);
      resources.push({ ...out, accepted: false, reason });
    };
    if (!unifiWireDigestMatches(current, resource)) { reject('content_digest_mismatch'); continue; }
    if (!scopes.has(resource.controllerSiteId)) scopes.set(resource.controllerSiteId, await resolveUnifiSourceScope(collector.id, resource.controllerSiteId));
    const scope = scopes.get(resource.controllerSiteId)!;
    if (!scope) { reject('controller_site_unmapped', 'controller_site_unmapped'); continue; }
    if (scope.orgId !== collector.orgId) { reject('controller_site_other_org', 'controller_site_other_org'); continue; }
    const authorityKey = unifiAuthorityKey(collector.id, resource.controllerSiteId);
    if (!authorityKey) { reject('controller_site_key_invalid', 'controller_site_key_invalid'); continue; }
    if (!coverage.has(resource.controllerSiteId)) coverage.set(resource.controllerSiteId, null);
    try {
      const receipt = await db.transaction(async () => {
        const producer = await resolveTopologyPhysicalProducer({ producerKind: 'unifi', deviceId, scope, authorityKey, collectorId: collector.id });
        const section = normalizeUnifiResource({ hostKey, authorityKey, resource, bindings: await bindingsFor(scope, resource) });
        const contentDigest = unifiNormalizedDigest(producer, section);
        const key = { protocol: section.kind, contextKey: authorityKey, addressFamily: 'any' as const };
        const [source] = await db.select({ producerEpoch: topologyCollectionSources.producerEpoch, contentDigest: topologyCollectionSources.contentDigest,
          baseSnapshotId: topologyCollectionSources.baseSnapshotId, revokedAt: topologyCollectionSources.revokedAt }).from(topologyCollectionSources)
          .where(and(eq(topologyCollectionSources.orgId, scope.orgId), eq(topologyCollectionSources.siteId, scope.siteId), eq(topologyCollectionSources.producerKind, 'unifi'),
            eq(topologyCollectionSources.producerId, deviceId), eq(topologyCollectionSources.protocol, key.protocol), eq(topologyCollectionSources.contextKey, key.contextKey),
            eq(topologyCollectionSources.addressFamily, key.addressFamily))).limit(1);
        const envelope = { snapshotId: report.snapshotId, sequence: report.sequence, capturedAt: report.capturedAt, captureAgeAtSendMs: report.captureAgeAtSendMs,
          expectedIntervalSeconds: report.expectedIntervalSeconds, contentDigest };
        const normalized: NormalizedTopologyReport = source && !source.revokedAt && source.baseSnapshotId && source.producerEpoch === producer.producerEpoch && source.contentDigest === contentDigest
          ? { reportKind: 'unchanged', confirmation: { key, producerEpoch: producer.producerEpoch, baseSnapshotId: source.baseSnapshotId, ...envelope } }
          : { reportKind: 'full', snapshot: { key, producerEpoch: producer.producerEpoch, ...envelope, section: { ...section, contentDigest } as UnifiSourceSection,
            manifest: { contract: 'unifi_topology_v1', controllerSiteId: resource.controllerSiteId,
              resources: [{ kind: resource.kind, outcome: resource.outcome, rowCount: resource.rowCount, ...(resource.omittedRowCount !== undefined ? { omittedRowCount: resource.omittedRowCount } : {}) }] } } };
        return ingestTopologySourceReport(producer, normalized);
      });
      resources.push(receipt.accepted
        ? { ...out, accepted: true, contentDigest: resource.contentDigest, ...(receipt.acceptedSequence ? { acceptedSequence: receipt.acceptedSequence } : {}) }
        : { ...out, accepted: false, reason: receipt.reason ?? 'not_accepted' });
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      const reason = error instanceof Error ? error.message : '';
      if (code === '55P03') { reject('producer_busy'); continue; }
      if (!ADAPTER_REJECTIONS.has(reason)) throw error;
      reject(reason);
    }
  }
  await noteCoverage(collector, coverage);
  return { ...base, producerEpoch: current.producerEpoch, accepted: resources.length > 0 && resources.every(r => r.accepted), resources };
}
