import { createHash, timingSafeEqual } from 'node:crypto';
import {
  canonicalizeAdjacencyReport, canonicalizeAdjacencyScope, normalizeFdbSection,
  type AdjacencyDigestIdentity, type AdjacencySection, type AdjacencyV2Full, type NormalizedFdbSection,
} from '@breeze/shared';
import type { AdjacencySourceManifest, AdjacencySourceSection, NormalizedTopologyReport, TopologySourceKey } from './collectionTypes';

/**
 * Discovery adjacency transport (M2 D14): pure normalization and digest rules
 * for one per-target AdjacencyV2 report. Grants no authority — the route
 * resolves the producer and ingest re-verifies it.
 *
 * Digest form: the agent and the server hash the SAME normalized bytes. A
 * section is taken as uploaded except FDB, which first goes through the shared
 * D13 rule (`normalizeFdbSection`, mirrored in Go by the
 * topology-fdb-normalization-v1 vectors). The wire FDB section keeps raw rows so
 * the rule is applied exactly once, server-side, and the digest over the
 * normalized form is what binds the upload.
 */
export type AdjacencyDigestFormSection = Exclude<AdjacencySection, { kind: 'fdb' }> | NormalizedFdbSection;
const WIRE_TO_SOURCE_KIND = { lldp: 'lldp', cdp: 'cdp', fdb: 'fdb', interfaces: 'snmp_interfaces' } as const;
const SOURCE_TO_WIRE_KIND: Record<string, keyof typeof WIRE_TO_SOURCE_KIND> = { lldp: 'lldp', cdp: 'cdp', fdb: 'fdb', snmp_interfaces: 'interfaces' };

/** Target authority key: `snmp:<address>` (link-local IPv6 adds `%<zone>`). Also the report's source key. */
export function discoveryTargetAuthorityKey(source: { address: string; zone: string | null }): string {
  return source.zone ? `snmp:${source.address}%${source.zone}` : `snmp:${source.address}`;
}
/** Inverse of `discoveryTargetAuthorityKey`; null when the key is not a discovery target key. */
export function parseDiscoveryTargetAuthorityKey(authorityKey: string): { address: string; zone: string | null } | null {
  if (!authorityKey.startsWith('snmp:')) return null;
  const rest = authorityKey.slice(5);
  const at = rest.indexOf('%');
  const address = at < 0 ? rest : rest.slice(0, at);
  const zone = at < 0 ? null : rest.slice(at + 1);
  if (!address || zone === '') return null;
  return { address, zone };
}

export function adjacencyDigestFormSection(section: AdjacencySection): AdjacencyDigestFormSection {
  return section.kind === 'fdb' ? normalizeFdbSection(section) : section;
}
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
/** Digest of one scope over its normalized form. */
export function adjacencyScopeDigest(id: AdjacencyDigestIdentity, section: AdjacencyDigestFormSection): string {
  return sha256(canonicalizeAdjacencyScope(id, section as AdjacencySection));
}
/** Digest of the whole per-target snapshot over every normalized scope. */
export function adjacencyReportDigest(id: AdjacencyDigestIdentity, sections: AdjacencyDigestFormSection[]): string {
  return sha256(canonicalizeAdjacencyReport(id, sections as AdjacencySection[]));
}
function matches(expected: string, actual: string): boolean {
  return expected.length === actual.length && timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

export const discoverySourceContextKey = (authorityKey: string, wireContextKey: string) => `${authorityKey}/${wireContextKey}`;
export function discoverySourceKey(authorityKey: string, section: { kind: keyof typeof WIRE_TO_SOURCE_KIND; contextKey: string }): TopologySourceKey {
  return { protocol: WIRE_TO_SOURCE_KIND[section.kind], contextKey: discoverySourceContextKey(authorityKey, section.contextKey), addressFamily: 'any' };
}

/**
 * Recompute every digest over the normalized sections (rejecting a mismatch
 * with `content_digest_mismatch` / `section_digest_mismatch`) and emit one
 * normalized full report per section, keyed under the target authority. The
 * section's contentDigest is always the server-recomputed value — the D13
 * normalizer passes its input digest through, so it is overwritten here.
 */
export function normalizeDiscoveryAdjacencyReport(input: {
  report: AdjacencyV2Full; identity: AdjacencyDigestIdentity; authorityKey: string; producerEpoch: string;
}): NormalizedTopologyReport[] {
  const { report, identity, authorityKey } = input;
  const digestForms = report.sections.map(adjacencyDigestFormSection);
  if (!matches(adjacencyReportDigest(identity, digestForms), report.contentDigest)) throw new Error('content_digest_mismatch');
  const manifest: AdjacencySourceManifest = { contract: 'adjacency_v2', target: report.source, scopes: report.finalManifest.scopes };
  return digestForms.map((form, index) => {
    const wire = report.sections[index]!;
    const digest = adjacencyScopeDigest(identity, form);
    if (!matches(digest, wire.contentDigest)) throw new Error('section_digest_mismatch');
    const key = discoverySourceKey(authorityKey, wire);
    const section = { ...form, kind: key.protocol, contextKey: key.contextKey, contentDigest: digest } as AdjacencySourceSection;
    return { reportKind: 'full', snapshot: {
      key, snapshotId: report.snapshotId, producerEpoch: input.producerEpoch, sequence: report.sequence, capturedAt: report.capturedAt,
      captureAgeAtSendMs: report.captureAgeAtSendMs, expectedIntervalSeconds: report.expectedIntervalSeconds, contentDigest: digest, manifest, section,
    } } satisfies NormalizedTopologyReport;
  });
}

/** Map a retained normalized source section back to its digest form (wire kind and context). */
export function retainedDigestFormSection(authorityKey: string, section: AdjacencySourceSection): AdjacencyDigestFormSection | null {
  const kind = SOURCE_TO_WIRE_KIND[section.kind];
  const prefix = `${authorityKey}/`;
  if (!kind || !section.contextKey.startsWith(prefix)) return null;
  return { ...section, kind, contextKey: section.contextKey.slice(prefix.length) } as AdjacencyDigestFormSection;
}
