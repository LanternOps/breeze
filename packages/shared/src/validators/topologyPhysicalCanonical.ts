import type { AdjacencySection, AdjacencyV2Full, UnifiResource } from '../types/topologyPhysical';
import { sorted, stable } from './topologyCollectionCanonical';

/**
 * Physical canonicalization v1 — sibling of the M1 network-context canonicalizer,
 * same `stable()` byte rules (mirrored in Go by agent/internal/topologycanon).
 * Hash the returned UTF-8 bytes with SHA-256 in the platform adapter.
 *
 * Semantic identity EXCLUDES: capturedAt/sequence/snapshotId, LLDP timeMark,
 * parent job/command ids and transport shape. It INCLUDES: authorized source
 * identity + target scope, typed ids, per-scope outcome/reason and omissions.
 */
export type AdjacencyDigestIdentity = { sourceIdentity: string; producerEpoch: string; source: AdjacencyV2Full['source'] };
export type UnifiDigestIdentity = { sourceIdentity: string; producerEpoch: string };

function semanticAdjacencySection(section: AdjacencySection): unknown {
  const { contentDigest: _digest, rows, ...scope } = section;
  const semanticRows = (rows as AdjacencySection['rows']).map(row => {
    if (section.kind === 'lldp' && 'timeMark' in row) {
      const { timeMark: _mark, ...rest } = row;
      return rest.remoteAddresses ? { ...rest, remoteAddresses: sorted(rest.remoteAddresses, s => s) } : rest;
    }
    return row;
  });
  return { ...scope, rows: sorted(semanticRows, r => r.rowKey) };
}
const scopeOrder = (s: { contextKey: string; kind: string }) => stable([s.contextKey, s.kind]);
const header = (id: AdjacencyDigestIdentity) => ({ canonicalizationVersion: 1, contract: 'adjacency_v2', sourceIdentity: id.sourceIdentity, version: 2, producerEpoch: id.producerEpoch, source: id.source });

/** One authorized scope (kind+context). */
export function canonicalizeAdjacencyScope(id: AdjacencyDigestIdentity, section: AdjacencySection): string {
  return stable({ ...header(id), section: semanticAdjacencySection(section) });
}
/** Whole source snapshot: every scope. */
export function canonicalizeAdjacencyReport(id: AdjacencyDigestIdentity, sections: AdjacencySection[]): string {
  return stable({ ...header(id), sections: sorted(sections, scopeOrder).map(semanticAdjacencySection) });
}
/** One controller-site resource (device list, client list, details or statistics). */
export function canonicalizeUnifiResource(id: UnifiDigestIdentity, resource: UnifiResource): string {
  const { contentDigest: _digest, rows, ...scope } = resource;
  return stable({ canonicalizationVersion: 1, contract: 'unifi_topology_v1', sourceIdentity: id.sourceIdentity, version: 1, producerEpoch: id.producerEpoch,
    resource: { ...scope, rows: sorted(rows as { rowKey: string }[], r => r.rowKey) } });
}
