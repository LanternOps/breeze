import { describe, expect, it } from 'vitest';
import { createManualNodeSchema, updateManualNodeSchema, createManualRelationshipSchema, expectedRevisionSchema, manualRelationshipSourceKey } from './manual';
import { physicalLinkKey } from './physicalIdentity';
import { canonicalIdentityKey } from './identity';
const id = '11111111-1111-4111-8111-111111111111';
describe('bounded manual topology mutation inputs', () => {
  it('accepts bounded manual node metadata and an explicit prefix', () => {
    expect(createManualNodeSchema.parse({ label: ' Router ', role: 'router', notes: '', prefix: '192.0.2.0/24' })).toMatchObject({ label: 'Router', prefix: '192.0.2.0/24' });
  });
  it.each(['192.0.2.0/33', 'example.com/24', '2001:db8::/129'])('rejects invalid prefix %s', prefix => {
    expect(createManualNodeSchema.safeParse({ label: 'x', role: 'router', prefix }).success).toBe(false);
  });
  it('rejects inventory kind, unbounded notes and empty updates', () => {
    expect(createManualNodeSchema.safeParse({ label: 'x', role: 'router', kind: 'endpoint' }).success).toBe(false);
    expect(createManualNodeSchema.safeParse({ label: 'x', role: 'router', notes: 'x'.repeat(8193) }).success).toBe(false);
    expect(updateManualNodeSchema.safeParse({ expectedRevision: '0' }).success).toBe(false);
  });
  it.each(['9223372036854775808', '18446744073709551615', '-1', '01', 'not-a-number', '1e3', 1])('rejects invalid or overflowing revision %s before SQL', value => {
    expect(expectedRevisionSchema.safeParse(value).success).toBe(false);
  });
  it('preserves exact PostgreSQL bigint revisions without numeric coercion', () => {
    expect(expectedRevisionSchema.parse('9223372036854775807')).toBe('9223372036854775807');
  });
  it('rejects self edges and arbitrary physical evidence', () => {
    expect(createManualRelationshipSchema.safeParse({ sourceNodeId: id, targetNodeId: id, kind: 'attachment' }).success).toBe(false);
    expect(createManualRelationshipSchema.safeParse({ sourceNodeId: id, targetNodeId: '22222222-2222-4222-8222-222222222222', kind: 'attachment', evidenceClass: 'observed' }).success).toBe(false);
  });
});

describe('manual relationship identity material (M2 D6)', () => {
  const a = '11111111-1111-4111-8111-111111111111'; const b = '22222222-2222-4222-8222-222222222222';
  const p1 = '33333333-3333-4333-8333-333333333333'; const p2 = '44444444-4444-4444-8444-444444444444'; const p3 = '55555555-5555-4555-8555-555555555555';
  it('accepts interface ids and physical_link in the request schema', () => {
    expect(createManualRelationshipSchema.parse({ sourceNodeId: a, targetNodeId: b, kind: 'physical_link', sourceInterfaceId: p1, targetInterfaceId: p2 })).toMatchObject({ sourceInterfaceId: p1, targetInterfaceId: p2 });
    expect(createManualRelationshipSchema.safeParse({ sourceNodeId: a, targetNodeId: b, kind: 'physical_link', sourceInterfaceId: 'presentation:x' }).success).toBe(false);
    expect(createManualRelationshipSchema.safeParse({ sourceNodeId: a, targetNodeId: b, kind: 'physical_link', confidence: 'high' }).success).toBe(false);
  });
  it('sorts a cable tuple so either orientation is the same cable', () => {
    expect(manualRelationshipSourceKey('physical_link', { nodeId: a, interfaceId: p1 }, { nodeId: b, interfaceId: p2 }, 7n))
      .toBe(manualRelationshipSourceKey('physical_link', { nodeId: b, interfaceId: p2 }, { nodeId: a, interfaceId: p1 }, 7n));
  });
  it('keeps directed kinds oriented', () => {
    expect(manualRelationshipSourceKey('attachment', { nodeId: a, interfaceId: null }, { nodeId: b, interfaceId: null }, 7n))
      .not.toBe(manualRelationshipSourceKey('attachment', { nodeId: b, interfaceId: null }, { nodeId: a, interfaceId: null }, 7n));
  });
  it('distinguishes parallel cables, unknown ports and generations', () => {
    const keys = new Set([
      manualRelationshipSourceKey('physical_link', { nodeId: a, interfaceId: p1 }, { nodeId: b, interfaceId: p2 }, 7n),
      manualRelationshipSourceKey('physical_link', { nodeId: a, interfaceId: p3 }, { nodeId: b, interfaceId: p2 }, 7n),
      manualRelationshipSourceKey('physical_link', { nodeId: a, interfaceId: null }, { nodeId: b, interfaceId: null }, 7n),
      manualRelationshipSourceKey('physical_link', { nodeId: a, interfaceId: p1 }, { nodeId: b, interfaceId: p2 }, 8n),
    ]);
    expect(keys.size).toBe(4);
  });
  it('never shares the measured cable namespace and is valid canonical identity material', () => {
    const key = manualRelationshipSourceKey('physical_link', { nodeId: a, interfaceId: p1 }, { nodeId: b, interfaceId: p2 }, 7n);
    expect(key).toMatch(/^manual-link-v1:/);
    expect(key).not.toBe(physicalLinkKey({ nodeId: a, interfaceId: p1 }, { nodeId: b, interfaceId: p2 }));
    expect(() => canonicalIdentityKey({ orgId: a, siteId: b }, 'physical_link', key)).not.toThrow();
  });
});
