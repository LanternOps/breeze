import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import vectors from '../testing/topology-vectors.json';
import { networkContextFixture } from '../testing/topologyFixtures';
import { networkContextFullSchema } from './topologyCollection';
import { canonicalizeTopologyContext, canonicalizeTopologySection } from './topologyCollectionCanonical';
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
describe('topology canonicalization v1', () => {
  it('matches frozen cross-language byte and digest vectors', () => {
    for (const vector of vectors.vectors) {
      const report = networkContextFullSchema.parse(vector.report);
      const canonical = canonicalizeTopologyContext(report, vector.sourceIdentity);
      expect(canonical).toBe(vector.canonical); expect(digest(canonical)).toBe(vector.sha256);
      for (const section of report.sections) {
        const fixture = vector.sections.find(s => s.kind === section.kind)!;
        const sectionBytes = canonicalizeTopologySection(report, section, vector.sourceIdentity);
        expect(sectionBytes).toBe(fixture.canonical); expect(digest(sectionBytes)).toBe(fixture.sha256);
      }
    }
  });
  it('ignores metadata and set-like order but retains source/coverage and resolver order', () => {
    const a = networkContextFixture(), b = networkContextFixture();
    b.sections.reverse(); b.sequence = '2'; b.capturedAt = '2026-09-15T12:05:00Z'; b.contentDigest = 'f'.repeat(64);
    const canonical = canonicalizeTopologyContext(a, 'producer');
    expect(canonicalizeTopologyContext(b, 'producer')).toBe(canonical);
    expect(canonicalizeTopologyContext(b, 'different')).not.toBe(canonical);
    b.sections[0]!.outcome = 'partial'; expect(canonicalizeTopologyContext(b, 'producer')).not.toBe(canonical);
    const resolver = a.sections.find(s => s.kind === 'resolvers')!;
    resolver.rows[0]!.domains.push({ name: 'second.example.test', routeOnly: false });
    const first = canonicalizeTopologyContext(a, 'producer'); resolver.rows[0]!.domains.reverse();
    expect(canonicalizeTopologyContext(a, 'producer')).not.toBe(first);
  });
  it('normalizes a route countdown to its semantic expiry anchor', () => {
    const a = networkContextFixture(), b = networkContextFixture();
    const ar = a.sections.find(s => s.kind === 'routes')!, br = b.sections.find(s => s.kind === 'routes')!;
    ar.rows[0]!.expiresInSeconds = 600; br.rows[0]!.expiresInSeconds = 300; b.capturedAt = '2026-09-15T12:05:00Z';
    expect(canonicalizeTopologyContext(a, 'producer')).toBe(canonicalizeTopologyContext(b, 'producer'));
  });
});
