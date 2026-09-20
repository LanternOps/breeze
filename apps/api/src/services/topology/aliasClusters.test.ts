import { describe, expect, it } from 'vitest';
import { planAcceptedAliasClusters } from './aliasClusters';
import { planAliasClusterPosition } from './identity';

const scope = { orgId: '00000000-0000-4000-8000-000000000001', siteId: '00000000-0000-4000-8000-000000000002' };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const nodes = [3, 4, 5].map((n, i) => ({ ...scope, id: id(n), kind: 'endpoint' as const, createdAt: new Date([2000, 1000, 3000][i]!), labelOverride: null as string | null, attributes: {} as { notes?: string } }));
const bindings = [{ nodeId: id(3), deviceId: id(10) }, { nodeId: id(4), discoveredAssetId: id(11) }, { nodeId: id(5), discoveredAssetId: id(12) }];
const assets = [11, 12].map(n => ({ id: id(n), linkedDeviceId: id(10), autoLinkSuppressedAt: null as Date | null }));
const requests = [{ sourceId: id(4), targetId: id(3) }, { sourceId: id(5), targetId: id(3) }];
const plan = (overrides: Partial<Parameters<typeof planAcceptedAliasClusters>[1]> = {}) => planAcceptedAliasClusters(scope, { nodes, bindings, assets, requests, positions: [], ...overrides });

describe('accepted alias components', () => {
  it('precomputes one component and chooses its globally oldest UUID independent of request order', () => {
    const expected = [{ canonicalId: id(4), aliasIds: [id(3), id(5)], labelOverride: null }];
    expect(plan()).toMatchObject(expected);
    expect(plan({ nodes: [...nodes].reverse(), requests: [...requests].reverse() })).toEqual(plan());
  });
  it('accepts an acyclic chain only when every member is connected by current accepted inventory', () => {
    expect(plan({ requests: [{ sourceId: id(5), targetId: id(4) }, { sourceId: id(4), targetId: id(3) }] })).toEqual(plan());
    expect(() => plan({ bindings: bindings.slice(0, 2) })).toThrow(/accepted inventory link/);
  });
  it('combines manual labels and notes across the full component before choosing a representative', () => {
    expect(plan({ nodes: nodes.map((n, i) => ({ ...n, labelOverride: i === 0 ? 'Manual label' : null, attributes: i === 2 ? { notes: 'Manual note' } : {} })) })[0])
      .toMatchObject({ canonicalId: id(4), labelOverride: 'Manual label', notes: 'Manual note' });
  });
  it.each([
    { field: 'label' as const, emptyAt: 'oldest', emptyId: id(4) },
    { field: 'label' as const, emptyAt: 'intermediate', emptyId: id(3) },
    { field: 'notes' as const, emptyAt: 'oldest', emptyId: id(4) },
    { field: 'notes' as const, emptyAt: 'intermediate', emptyId: id(3) },
  ])('retains a later nonempty $field when the $emptyAt member has an empty string', ({ field, emptyId }) => {
    const changed = nodes.map(node => {
      const value = node.id === emptyId ? '' : node.id === id(5) ? 'Retained operator fact' : undefined;
      return { ...node, labelOverride: field === 'label' ? value ?? null : null,
        attributes: field === 'notes' && value !== undefined ? { notes: value } : {} };
    });
    expect(plan({ nodes: changed })[0]).toMatchObject(field === 'label'
      ? { canonicalId: id(4), labelOverride: 'Retained operator fact' }
      : { canonicalId: id(4), notes: 'Retained operator fact' });
  });
  it('rejects conflicting noncanonical pins and manual facts before any component is applied', () => {
    const positions = [3, 5].map((n, i) => ({ nodeId: id(n), layoutId: id(20), x: i, y: 0, pinned: true }));
    expect(() => plan({ positions })).toThrow(/pins/);
    expect(() => plan({ nodes: nodes.map((n, i) => ({ ...n, labelOverride: i === 1 ? null : String(i) })) })).toThrow(/manual labels/);
    expect(() => plan({ nodes: nodes.map((n, i) => ({ ...n, attributes: i === 1 ? {} : { notes: String(i) } })) })).toThrow(/manual notes/);
  });
  it.each(['suppressed', 'unlinked', 'other_device', 'manual', 'unbound'] as const)('rejects %s membership instead of accepting one valid pair for the whole group', variant => {
    const changedAssets = assets.map((a, i) => i === 0 ? a : { ...a, linkedDeviceId: variant === 'unlinked' ? null : variant === 'other_device' ? id(30) : a.linkedDeviceId, autoLinkSuppressedAt: variant === 'suppressed' ? new Date() : null });
    const changedBindings = variant === 'manual' ? [...bindings.slice(0, 2), { nodeId: id(5), manualNodeId: id(31) }] : variant === 'unbound' ? bindings.slice(0, 2) : bindings;
    expect(() => plan({ assets: changedAssets, bindings: changedBindings })).toThrow(/accepted inventory link/);
  });
  it('rejects two managed devices, cycles, self aliases, foreign scope and non-endpoint members', () => {
    expect(() => plan({ bindings: [...bindings, { nodeId: id(5), deviceId: id(30) }] })).toThrow(/accepted inventory link/);
    expect(() => plan({ requests: [...requests, { sourceId: id(3), targetId: id(4) }] })).toThrow(/cycle/);
    expect(() => plan({ requests: [{ sourceId: id(3), targetId: id(3) }] })).toThrow(/itself/);
    expect(() => plan({ nodes: nodes.map((n, i) => i === 2 ? { ...n, siteId: id(40) } : n) })).toThrow(/scope/);
    expect(() => plan({ nodes: nodes.map((n, i) => i === 2 ? { ...n, kind: 'manual' } : n) })).toThrow(/alias target/);
  });
});

describe('component layout collapse', () => {
  const position = (node: number, extras: Record<string, unknown> = {}) => ({ nodeId: id(node), layoutId: id(20), x: 0, y: 0, pinned: false, revision: 1n, legacySourceRevision: 1n as bigint | null, deletedAt: null as Date | null, ...extras });
  it('preserves the only live pin against later unpinned aliases and combines every source fence once', () => {
    const rows = [position(4, { revision: 2n }), position(3, { x: 8, pinned: true, revision: 8n, legacySourceRevision: 20n }), position(5, { x: 99, revision: 5n, legacySourceRevision: 30n })];
    expect(planAliasClusterPosition(id(4), rows)).toMatchObject({ nodeId: id(4), x: 8, pinned: true, revision: 9n, legacySourceRevision: 30n });
  });
  it('retains a tombstone high-water without overwriting a surviving live pin', () => {
    const rows = [position(4, { deletedAt: new Date(0), revision: 10n, legacySourceRevision: 40n }), position(3, { pinned: true, x: 8 }), position(5, { deletedAt: new Date(0), legacySourceRevision: 50n })];
    expect(planAliasClusterPosition(id(4), rows)).toMatchObject({ pinned: true, x: 8, deletedAt: null, revision: 11n, legacySourceRevision: 50n });
  });
});
