import { describe, expect, it } from 'vitest';
import { legacyNodeIdentity, opaqueLegacyMismatchId, parseSnapshotEnvelope, projectLegacyNode, projectLegacyRelationship, shouldApplyLegacyRevision } from './legacyProjection';

const scope = { orgId: '00000000-0000-4000-8000-000000000001', siteId: '00000000-0000-4000-8000-000000000002' };
const id = '00000000-0000-4000-8000-000000000003';
const other = '00000000-0000-4000-8000-000000000004';
describe('legacy projection and source fences', () => {
  it.each([['0', '0', false], ['3', '2', false], ['3', '3', false], ['3', '4', true], ['9007199254740992', '9007199254740993', true]])('compares %s to %s without number rounding', (stored, incoming, expected) => {
    expect(shouldApplyLegacyRevision(stored, incoming)).toBe(expected);
  });
  it.each(['-1', '01', '1.2', '9223372036854775808'])('rejects invalid revision %s', value => {
    expect(() => shouldApplyLegacyRevision('0', value)).toThrow();
  });
  it('uses actual scoped immutable inventory IDs, never display/address data', () => {
    const a = legacyNodeIdentity(scope, 'discovered_assets', id);
    expect(a).toEqual(legacyNodeIdentity(scope, 'discovered_assets', id));
    expect(a.id).not.toBe(legacyNodeIdentity({ ...scope, siteId: other }, 'discovered_assets', id).id);
    const projected = projectLegacyNode(scope, { sourceTable: 'topology_manual_nodes', sourceId: id, sourceRevision: '0', data: { label: 'Core', role: 'switch', notes: '', createdBy: null } });
    expect(projected).toMatchObject({ kind: 'manual', labelOverride: 'Core', attributes: { notes: '' }, legacySourceRevision: 0n });
  });
  it('keeps legacy measured links unverified and manual assertions asserted', () => {
    const source = { sourceTable: 'network_topology' as const, sourceId: id, sourceRevision: '2', data: { sourceType: 'discovered_asset', sourceId: id, targetType: 'manual_node', targetId: other, connectionType: 'wired', interfaceName: 'Gi1', vlan: null, bandwidth: null, method: 'lldp', createdBy: null } };
    expect(projectLegacyRelationship(scope, source, id, other)).toMatchObject({ kind: 'attachment', directness: 'unknown', evidenceClass: 'inferred', confidence: 'low', attributes: { method: 'legacy' } });
    expect(projectLegacyRelationship(scope, { ...source, data: { ...source.data, firstSeenAt: '2026-01-01T00:00:00Z', lastVerifiedAt: '2026-01-02T00:00:00Z' } }, id, other)).toMatchObject({
      logicalContext: { contextKey: 'legacy-method:lldp' }, firstSupportedAt: new Date('2026-01-01T00:00:00Z'), lastSupportedAt: new Date('2026-01-02T00:00:00Z'),
    });
    expect(projectLegacyRelationship(scope, { ...source, data: { ...source.data, method: 'manual' } }, id, other)).toMatchObject({ evidenceClass: 'manual', confidence: 'asserted' });
  });
  it('distinguishes the capture/source barrier from snapshot delivery ordering', () => {
    const envelope = { version: 1, kind: 'legacy.snapshot', runId: other, sourceRevision: '0', item: { sourceTable: 'topology_manual_nodes', sourceId: id, data: { label: 'Core', role: 'switch', notes: null, createdBy: null } } };
    expect(parseSnapshotEnvelope(envelope).sourceRevision).toBe('0');
    expect(() => parseSnapshotEnvelope({ ...envelope, extra: true })).toThrow();
    expect(() => parseSnapshotEnvelope({ ...envelope, item: { ...envelope.item, data: { ...envelope.item.data, credential: 'forbidden' } } })).toThrow();
  });
  it('reports safe opaque identifiers with site isolation', () => {
    const value = opaqueLegacyMismatchId(scope, 'network_topology', id);
    expect(value).toMatch(/^[a-f0-9]{24}$/);
    expect(value).not.toContain(id);
    expect(value).not.toBe(opaqueLegacyMismatchId({ ...scope, siteId: other }, 'network_topology', id));
  });
});
