import { describe, expect, it } from 'vitest';
import { adjacencySectionSchema, canonicalizeAdjacencyScope, type AdjacencyDigestIdentity, type AdjacencySection } from '@breeze/shared';
import adjacencyFixture from '../../../../../packages/shared/src/testing/topology-adjacency-v2.json';
import fdbVectors from '../../../../../packages/shared/src/testing/topology-fdb-normalization-v1.json';
import transport from '../../../../../packages/shared/src/testing/topology-adjacency-transport-v1.json';
import {
  adjacencyDigestFormSection, adjacencyReportDigest, adjacencyScopeDigest, discoveryTargetAuthorityKey, normalizeDiscoveryAdjacencyReport,
  parseDiscoveryTargetAuthorityKey, retainedDigestFormSection,
} from './discoveryAdjacency';
import { discoveryDispatchEpoch, discoveryTopologyConfigurationGeneration, isDiscoveryTargetAuthorized } from './discoveryDispatch';

/** Rebuilds the cross-language transport vector the Go agent is pinned to. */
function buildVector() {
  const base = adjacencyFixture.vectors[0]!.report;
  const identity = transport.identity as AdjacencyDigestIdentity;
  const sections: AdjacencySection[] = base.sections.map(raw => adjacencySectionSchema.parse(raw.kind === 'fdb' ? fdbVectors.vectors[0]!.input : raw));
  const forms = sections.map(adjacencyDigestFormSection);
  return { sections, scopes: forms.map(form => ({ kind: form.kind, contextKey: form.contextKey, canonical: canonicalizeAdjacencyScope(identity, form as AdjacencySection), digest: adjacencyScopeDigest(identity, form) })), reportDigest: adjacencyReportDigest(identity, forms) };
}

describe('discovery adjacency transport digests', () => {
  it('pins packages/shared/src/testing/topology-adjacency-transport-v1.json (Go mirror vector)', () => {
    const built = buildVector();
    expect(built.sections).toEqual(transport.sections);
    expect(built.scopes).toEqual(transport.expected.scopes);
    expect(built.reportDigest).toBe(transport.expected.reportDigest);
    // FDB digests are taken over the D13 normalized form, not the raw rows.
    expect(transport.expected.scopes[2]!.canonical).toContain('"metadata":{"collapsedRowCount":34');
  });

  it('normalizes one report per section under the target authority with server-recomputed digests', () => {
    const identity = transport.identity as AdjacencyDigestIdentity;
    const sections = structuredClone(transport.sections) as AdjacencySection[];
    const forms = sections.map(adjacencyDigestFormSection);
    sections.forEach((s, i) => { s.contentDigest = adjacencyScopeDigest(identity, forms[i]!); });
    const report = { ...adjacencyFixture.vectors[0]!.report, sections, contentDigest: adjacencyReportDigest(identity, forms),
      finalManifest: { scopes: sections.map(s => ({ kind: s.kind, contextKey: s.contextKey, outcome: s.outcome, rowCount: s.rowCount, contentDigest: s.contentDigest })) } } as never;
    const out = normalizeDiscoveryAdjacencyReport({ report, identity, authorityKey: 'snmp:192.0.2.10', producerEpoch: 'server-epoch' });
    expect(out.map(r => r.reportKind === 'full' && [r.snapshot.key.protocol, r.snapshot.key.contextKey, r.snapshot.producerEpoch])).toEqual([
      ['lldp', 'snmp:192.0.2.10/default', 'server-epoch'], ['cdp', 'snmp:192.0.2.10/default', 'server-epoch'],
      ['fdb', 'snmp:192.0.2.10/default', 'server-epoch'], ['snmp_interfaces', 'snmp:192.0.2.10/default', 'server-epoch']]);
    const fdb = out[2]!.reportKind === 'full' ? out[2]!.snapshot.section : undefined;
    expect(fdb).toMatchObject({ kind: 'fdb', contentDigest: transport.expected.scopes[2]!.digest, metadata: { sharedPortCount: 2 } });
    // The retained section maps back to the same digest form.
    expect(adjacencyScopeDigest(identity, retainedDigestFormSection('snmp:192.0.2.10', fdb as never)!)).toBe(transport.expected.scopes[2]!.digest);
    const tampered = structuredClone(report) as { sections: AdjacencySection[] };
    tampered.sections[0]!.contentDigest = 'f'.repeat(64);
    expect(() => normalizeDiscoveryAdjacencyReport({ report: tampered as never, identity, authorityKey: 'snmp:192.0.2.10', producerEpoch: 'e' })).toThrow('section_digest_mismatch');
    expect(() => normalizeDiscoveryAdjacencyReport({ report: { ...(report as object), contentDigest: 'f'.repeat(64) } as never, identity, authorityKey: 'snmp:192.0.2.10', producerEpoch: 'e' })).toThrow('content_digest_mismatch');
  });

  it('round-trips target authority keys', () => {
    expect(discoveryTargetAuthorityKey({ address: '192.0.2.10', zone: null })).toBe('snmp:192.0.2.10');
    expect(parseDiscoveryTargetAuthorityKey('snmp:fe80::1%eth0')).toEqual({ address: 'fe80::1', zone: 'eth0' });
    expect(parseDiscoveryTargetAuthorityKey('unifi:host:site')).toBeNull();
  });
});

describe('discovery dispatch authority helpers', () => {
  const snapshot = { includedTargets: ['192.0.2.0/24', '198.51.100.7'], excludedTargets: ['192.0.2.99'] };
  it('authorizes only included, non-excluded targets', () => {
    expect(isDiscoveryTargetAuthorized('192.0.2.10', snapshot)).toBe(true);
    expect(isDiscoveryTargetAuthorized('198.51.100.7', snapshot)).toBe(true);
    expect(isDiscoveryTargetAuthorized('192.0.2.99', snapshot)).toBe(false);
    expect(isDiscoveryTargetAuthorized('192.0.3.1', snapshot)).toBe(false);
    expect(isDiscoveryTargetAuthorized('not-an-ip', snapshot)).toBe(false);
    expect(isDiscoveryTargetAuthorized('192.0.2.10', { includedTargets: ['garbage/99'], excludedTargets: [] })).toBe(false);
  });
  it('derives a generation that ignores ordering/whitespace but not ranges, and an epoch bound to the root', () => {
    const base = { id: 'p', siteId: 's', subnets: ['192.0.2.0/24', '10.0.0.0/8'], excludeIps: [] };
    expect(discoveryTopologyConfigurationGeneration(base)).toBe(discoveryTopologyConfigurationGeneration({ ...base, subnets: [' 10.0.0.0/8', '192.0.2.0/24'] }));
    expect(discoveryTopologyConfigurationGeneration(base)).not.toBe(discoveryTopologyConfigurationGeneration({ ...base, excludeIps: ['10.0.0.1'] }));
    const gen = discoveryTopologyConfigurationGeneration(base);
    expect(discoveryDispatchEpoch({ producerEpoch: 'a', configurationRevision: 'b' }, gen)).not.toBe(discoveryDispatchEpoch({ producerEpoch: 'a2', configurationRevision: 'b' }, gen));
    expect(discoveryDispatchEpoch({ producerEpoch: 'a', configurationRevision: 'b' }, gen)).toMatch(/^[0-9a-f]{64}$/);
  });
});
