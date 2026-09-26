import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), assertInTransaction: vi.fn() }));
vi.mock('../../db', () => ({ db: { transaction: mocks.transaction }, assertInTransaction: mocks.assertInTransaction }));
import { publishTopologyBuild, validatePublicationInput, structuralFingerprint } from './publish';
import { canonicalIdentityKey } from './identity';

const scope = { orgId: '00000000-0000-4000-8000-000000000001', siteId: '00000000-0000-4000-8000-000000000002' };
const input = { buildFence: '2', inputRevision: '3', nodes: [], relationships: [], bindings: [] };
const state = { buildFence: 2n, materializedInputRevision: 2n, graphRevision: 7n, dirtyRevision: 3n };
function transactionWithState(row = state) {
  const locked = vi.fn().mockResolvedValue([row]);
  const where = vi.fn(() => Object.assign(Promise.resolve([]), { for: locked, orderBy: vi.fn(() => ({ for: vi.fn().mockResolvedValue([]) })) }));
  const tx = { select: vi.fn(() => ({ from: vi.fn(() => ({ where })) })), execute: vi.fn().mockResolvedValue([{ graph_revision: '8' }]), insert: vi.fn(), update: vi.fn() };
  mocks.transaction.mockImplementation(async work => work(tx));
  return tx;
}

describe('fenced topology publication', () => {
  beforeEach(() => vi.clearAllMocks());
  it('rejects an older worker before any canonical or state writes', async () => {
    const tx = transactionWithState({ ...state, buildFence: 3n });
    expect(await publishTopologyBuild(scope, input)).toEqual({ published: false, graphRevision: '7' });
    expect(tx.execute).not.toHaveBeenCalled(); expect(tx.insert).not.toHaveBeenCalled(); expect(tx.update).not.toHaveBeenCalled();
  });
  it('rejects an equal input checkpoint without writes', async () => {
    const tx = transactionWithState({ ...state, materializedInputRevision: 3n });
    expect(await publishTopologyBuild(scope, input)).toEqual({ published: false, graphRevision: '7' });
    expect(tx.execute).not.toHaveBeenCalled();
  });
  it('advances a no-change checkpoint through the SQL guard and handles a rejected CAS without writes', async () => {
    const tx = transactionWithState();
    tx.execute.mockResolvedValueOnce([{ graph_revision: '7' }]);
    expect(await publishTopologyBuild(scope, input)).toEqual({ published: true, graphRevision: '7' });
    tx.execute.mockResolvedValueOnce([]);
    expect(await publishTopologyBuild(scope, input)).toEqual({ published: false, graphRevision: '7' });
    expect(tx.insert).not.toHaveBeenCalled(); expect(tx.update).not.toHaveBeenCalled();
  });
  it.each(['01', '-1', '1.5', '9223372036854775808'])('rejects invalid decimal revision %s', revision => {
    expect(() => validatePublicationInput(scope, { ...input, inputRevision: revision })).toThrow();
  });
  it('rejects forged scope and untyped JSON before opening a transaction', async () => {
    const node = { ...scope, id: crypto.randomUUID(), kind: 'endpoint' as const, identityMaterial: { version: 1 as const, kind: 'endpoint' as const, sourceKey: 'device:one' }, identityKey: canonicalIdentityKey(scope, 'endpoint', 'device:one') };
    expect(() => validatePublicationInput(scope, { ...input, nodes: [{ ...node, orgId: scope.siteId }] })).toThrow();
    expect(() => validatePublicationInput(scope, { ...input, nodes: [{ ...node, attributes: { secret: 'untyped' } } as never] })).toThrow();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it('excludes freshness, checkpoint, health and layout changes from structural comparison', () => {
    const before = { id: 'node', kind: 'endpoint', attributes: { label: 'same' }, lastObservedAt: new Date(1), revision: 1n, healthRevision: 1n, layoutRevision: 1n };
    const after = { ...before, lastObservedAt: new Date(2), revision: 2n, healthRevision: 2n, layoutRevision: 2n };
    expect(structuralFingerprint('node', before)).toBe(structuralFingerprint('node', after));
    expect(structuralFingerprint('node', { ...after, attributes: { label: 'changed' } })).not.toBe(structuralFingerprint('node', before));
  });
  it('excludes relationship support counters/timestamps while retaining confidence and endpoints', () => {
    const before = { id: 'relationship', sourceNodeId: 'a', targetNodeId: 'b', logicalContext: { addressFamily: 4, contextKey: 'routing:one' }, confidence: 'low', supportCount: 1n, lastSupportedAt: new Date(1) };
    expect(structuralFingerprint('relationship', { ...before, logicalContext: { contextKey: 'routing:one', addressFamily: 4 }, supportCount: 2n, lastSupportedAt: new Date(2) })).toBe(structuralFingerprint('relationship', before));
    expect(structuralFingerprint('relationship', { ...before, confidence: 'high' })).not.toBe(structuralFingerprint('relationship', before));
  });
});

describe('physical relationship publication variants (D15.4)', () => {
  const physicalRow = (over: Record<string, unknown> = {}, kind: 'physical_link' | 'attachment' = 'physical_link') => {
    const sourceKey = `physical-link-v1:${kind}:${JSON.stringify(over).length}`;
    return {
      id: '00000000-0000-4000-8000-0000000000aa', ...scope, kind, canonicalKey: canonicalIdentityKey(scope, kind, sourceKey),
      identityMaterial: { version: 1 as const, kind, sourceKey },
      sourceNodeId: '00000000-0000-4000-8000-0000000000b1', targetNodeId: '00000000-0000-4000-8000-0000000000b2',
      evidenceClass: 'observed' as const, confidence: 'high' as const, ...over,
    };
  };
  const publishRows = (...relationships: ReturnType<typeof physicalRow>[]) =>
    validatePublicationInput(scope, { ...input, relationships: relationships as never });
  it.each(['lldp', 'cdp', 'unifi'])('accepts a measured %s physical link with bounded physical attributes', method => {
    const parsed = publishRows(physicalRow({ attributes: { method, physical: {
      resolution: 'resolved', remoteChassis: { subtype: 'mac_address', value: '02:00:00:00:00:01' },
      localPort: { namespace: 'lldp_local', value: '7', resolvedInterfaceKey: 'if:7' }, remotePort: { subtype: 'interface_name', value: 'Gi0/1' },
    } } }));
    expect(parsed.relationships[0]!.attributes.method).toBe(method);
  });
  it('accepts an inferred FDB attachment candidate with selection metadata and physical context', () => {
    const parsed = publishRows(physicalRow({
      evidenceClass: 'inferred', confidence: 'low', directness: 'unknown',
      logicalContext: { bridgeContext: 'default', vlanIds: [10, 20] },
      attributes: { method: 'fdb', physical: { resolution: 'unresolved', bridgeContext: 'default', fdbSelection: 'competing',
        alternativeRelationshipIds: ['00000000-0000-4000-8000-0000000000c1'] } },
    }, 'attachment'));
    expect(parsed.relationships[0]!.logicalContext).toEqual({ bridgeContext: 'default', vlanIds: [10, 20] });
  });
  it('never lets FDB evidence mint a physical link or claim observed evidence', () => {
    expect(() => publishRows(physicalRow({ attributes: { method: 'fdb' } }))).toThrow();
    expect(() => publishRows(physicalRow({ attributes: { method: 'fdb' } }, 'attachment'))).toThrow();
  });
  it('keeps physical methods off logical relationship kinds', () => {
    const sourceKey = 'os:x:y';
    expect(() => validatePublicationInput(scope, { ...input, relationships: [{
      id: '00000000-0000-4000-8000-0000000000ab', ...scope, kind: 'default_route', canonicalKey: canonicalIdentityKey(scope, 'default_route', sourceKey),
      identityMaterial: { version: 1, kind: 'default_route', sourceKey }, sourceNodeId: '00000000-0000-4000-8000-0000000000b1',
      targetNodeId: '00000000-0000-4000-8000-0000000000b2', evidenceClass: 'observed', confidence: 'high', attributes: { method: 'lldp' },
    }] as never })).toThrow();
  });
  it('rejects unknown, oversized or misplaced physical attributes', () => {
    expect(() => publishRows(physicalRow({ attributes: { method: 'lldp', physical: { resolution: 'resolved', extra: 1 } } }))).toThrow();
    expect(() => publishRows(physicalRow({ attributes: { method: 'lldp', physical: { bridgeContext: 'x'.repeat(256) } } }))).toThrow();
    expect(() => publishRows(physicalRow({ attributes: { method: 'fdb', physical: { alternativeRelationshipIds: Array.from({ length: 65 }, () => '00000000-0000-4000-8000-0000000000c1') } } }, 'attachment'))).toThrow();
    expect(() => publishRows(physicalRow({ attributes: { method: 'os_network_context', physical: { resolution: 'resolved' } } }))).toThrow();
    expect(() => publishRows(physicalRow({ logicalContext: { vlanIds: [0] }, attributes: { method: 'lldp' } }))).toThrow();
  });
});
