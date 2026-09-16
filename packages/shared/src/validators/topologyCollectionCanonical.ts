import type { NetworkContextFull, TopologyContextSection } from '../types/topologyCollection';
function compareUtf8(a: string, b: string): number {
  const left = new TextEncoder().encode(a), right = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i]! - right[i]!;
  return left.length - right.length;
}
/** Browser-safe bytes only. Hash these UTF-8 bytes with SHA-256 in the platform adapter. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => compareUtf8(a, b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
function sorted<T>(values: T[], identity: (value: T) => string): T[] {
  return [...values].sort((a, b) => compareUtf8(identity(a), identity(b)));
}
function semanticSection(section: TopologyContextSection, capturedAt: string): unknown {
  const { contentDigest: _digest, rows, ...scope } = section;
  return { ...scope, rows: sorted(rows.map(row => {
    if (section.kind === 'routes' && 'expiresInSeconds' in row) {
      const { expiresInSeconds, ...rest } = row;
      return { ...rest, ...('nextHops' in rest ? { nextHops: sorted(rest.nextHops, stable) } : {}), expiresAt: new Date(Date.parse(capturedAt) + Number(expiresInSeconds) * 1000).toISOString() };
    }
    if ('addresses' in row) return { ...row, addresses: sorted(row.addresses, stable) };
    if ('nextHops' in row) return { ...row, nextHops: sorted(row.nextHops, stable) };
    if ('selectors' in row) return { ...row, selectors: sorted(row.selectors, stable), ...(row.unsupportedSelectorKinds ? { unsupportedSelectorKinds: sorted(row.unsupportedSelectorKinds, s => s) } : {}) };
    return row;
  }), row => row.rowKey) };
}
/** sourceIdentity comes from authenticated configuration; this function grants no authority. */
export function canonicalizeTopologyContext(report: NetworkContextFull, sourceIdentity: string): string {
  return stable({ canonicalizationVersion: 1, sourceIdentity, version: report.version, producerEpoch: report.producerEpoch,
    capabilities: sorted(report.capabilities, c => c.name),
    contextManifest: { ...report.contextManifest, contexts: sorted(report.contextManifest.contexts.map(c => ({ ...c, families: sorted(c.families, s => s) })), c => c.contextKey) },
    sections: sorted(report.sections, s => stable([s.contextKey, s.kind, s.addressFamily ?? null])).map(s => semanticSection(s, report.capturedAt)),
  });
}
export function canonicalizeTopologySection(report: NetworkContextFull, section: TopologyContextSection, sourceIdentity: string): string {
  return stable({ canonicalizationVersion: 1, sourceIdentity, version: report.version, producerEpoch: report.producerEpoch,
    contextManifest: { outcome: report.contextManifest.outcome, context: report.contextManifest.contexts.filter(c => c.contextKey === section.contextKey).map(c => ({ ...c, families: sorted(c.families, s => s) }))[0] },
    section: semanticSection(section, report.capturedAt),
  });
}
