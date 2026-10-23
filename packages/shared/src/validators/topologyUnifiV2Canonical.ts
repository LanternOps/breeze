import type { UnifiResourceV2, WirelessRadioOverview, WirelessRadioStatistics } from '../types/topologyUnifiV2';
import { sorted, stable } from './topologyCollectionCanonical';
import type { UnifiDigestIdentity } from './topologyPhysicalCanonical';

/**
 * UniFi topology canonicalization v2 — version-bound sibling of canonicalizeUnifiResource.
 *
 * Same `stable()` byte rules as v1 (mirrored in Go by agent/internal/topologycanon).
 * The contract name (`unifi_topology_v2`) and `version: 2` are part of the bytes, so a
 * v1 and a v2 resource can never share a digest. Nested sets are ordered here so that
 * the order a controller happened to return can never change the digest:
 * - device capability sets: sorted lexically (they are finite documented enums);
 * - radios: by frequency, then channel, width and standard (overview) or retry % (statistics).
 * A `null` set stays `null` and an empty set stays `[]`: they are different observations.
 */
type Radio = WirelessRadioOverview | WirelessRadioStatistics;
type Part = number | string | null;

function compareParts(a: Part, b: Part): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}
function sortRadios<T extends Radio>(radios: T[] | null, tieBreak: (radio: T) => Part[]): T[] | null {
  if (radios === null) return null;
  return [...radios].sort((a, b) => {
    const left = [a.frequencyGHz, ...tieBreak(a)];
    const right = [b.frequencyGHz, ...tieBreak(b)];
    for (let i = 0; i < left.length; i += 1) {
      const result = compareParts(left[i]!, right[i]!);
      if (result !== 0) return result;
    }
    return 0;
  });
}

type SemanticRow = { rowKey: string } & Record<string, unknown>;
function semanticRowV2(kind: UnifiResourceV2['kind'], row: UnifiResourceV2['rows'][number]): SemanticRow {
  switch (kind) {
    case 'device_list': {
      const device = row as Extract<UnifiResourceV2, { kind: 'device_list' }>['rows'][number];
      return { ...device, features: device.features === null ? null : sorted(device.features, s => s), interfaces: device.interfaces === null ? null : sorted(device.interfaces, s => s) };
    }
    case 'device_details': {
      const detail = row as Extract<UnifiResourceV2, { kind: 'device_details' }>['rows'][number];
      return { ...detail, radios: sortRadios(detail.radios, r => [r.channel, r.channelWidthMHz, r.wlanStandard]) };
    }
    case 'statistics': {
      const statistics = row as Extract<UnifiResourceV2, { kind: 'statistics' }>['rows'][number];
      return { ...statistics, radios: sortRadios(statistics.radios, r => [r.txRetriesPct]) };
    }
    default:
      return row as SemanticRow;
  }
}

/** One controller-site resource (device list, client list, details or statistics), v2 contract. */
export function canonicalizeUnifiResourceV2(id: UnifiDigestIdentity, resource: UnifiResourceV2): string {
  const { contentDigest: _digest, rows, ...scope } = resource;
  const semanticRows = (rows as UnifiResourceV2['rows']).map(row => semanticRowV2(resource.kind, row));
  return stable({ canonicalizationVersion: 1, contract: 'unifi_topology_v2', sourceIdentity: id.sourceIdentity, version: 2, producerEpoch: id.producerEpoch,
    resource: { ...scope, rows: sorted(semanticRows, r => r.rowKey) } });
}
