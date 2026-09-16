import { describe, expect, it } from 'vitest';
import { canonicalIdentityKey, planCanonicalMerge, planAliasPosition } from './identity';

const scope = { orgId: '00000000-0000-4000-8000-000000000001', siteId: '00000000-0000-4000-8000-000000000002' };
const a = { ...scope, id: '00000000-0000-4000-8000-000000000003', createdAt: new Date('2020-01-01'), labelOverride: 'Pinned label' };
const b = { ...scope, id: '00000000-0000-4000-8000-000000000004', createdAt: new Date('2021-01-01'), labelOverride: null };

describe('scoped canonical identity', () => {
  it('survives address/label edits because only immutable source material participates', () => {
    const source = { sourceKey: `device:${a.id}`, label: 'old', address: '192.0.2.1' };
    const before = canonicalIdentityKey(scope, 'endpoint', source.sourceKey);
    source.label = 'new'; source.address = '192.0.2.2';
    expect(canonicalIdentityKey(scope, 'endpoint', source.sourceKey)).toBe(before);
    expect(before).toMatch(/^v1:[a-f0-9]{64}$/);
  });
  it('separates reused prefixes by site and observer routing context', () => {
    const key = canonicalIdentityKey(scope, 'network', 'observer:a:interface:eth0:192.0.2.0/24');
    expect(canonicalIdentityKey({ ...scope, siteId: b.id }, 'network', 'observer:a:interface:eth0:192.0.2.0/24')).not.toBe(key);
    expect(canonicalIdentityKey(scope, 'network', 'observer:b:interface:eth0:192.0.2.0/24')).not.toBe(key);
  });
  it.each(['192.0.2.1', '2001:db8::1', 'workstation', 'name:workstation', 'ip:192.0.2.1', '', 'device: x', `device:${'x'.repeat(8192)}`])('rejects mutable/unqualified source material %s', source => {
    expect(() => canonicalIdentityKey(scope, 'endpoint', source)).toThrow();
  });
  it('rejects missing scope', () => {
    expect(() => canonicalIdentityKey({ ...scope, siteId: '' }, 'endpoint', 'device:immutable')).toThrow();
  });
});

describe('alias position migration', () => {
  const position = { nodeId: a.id, layoutId: a.id, x: 1, y: 2, pinned: false, revision: 2n, legacySourceRevision: 2n, deletedAt: null as Date | null };
  it('carries the pinned source and advances both replay and row revision fences', () => {
    const alias = { ...position, nodeId: b.id, x: 11, pinned: true, revision: 4n, legacySourceRevision: 10n };
    expect(planAliasPosition(a.id, alias, position)).toMatchObject({ nodeId: a.id, x: 11, pinned: true, revision: 5n, legacySourceRevision: 10n });
  });
  it('retains the destination tombstone high-water when transferring an active alias pin', () => {
    const alias = { ...position, nodeId: b.id, x: 11, pinned: true, revision: 4n, legacySourceRevision: 10n };
    expect(planAliasPosition(a.id, alias, { ...position, revision: 12n, legacySourceRevision: 20n, deletedAt: new Date() })).toMatchObject({ x: 11, pinned: true, revision: 13n, legacySourceRevision: 20n, deletedAt: null });
  });
  it('retains the removed alias tombstone fence while preserving a canonical pin', () => {
    const alias: typeof position = { ...position, nodeId: b.id, legacySourceRevision: 30n, deletedAt: new Date() };
    expect(planAliasPosition(a.id, alias, { ...position, pinned: true })).toMatchObject({ x: 1, pinned: true, revision: 3n, legacySourceRevision: 30n, deletedAt: null });
  });
  it('keeps a tombstone and null source fence when neither slot is live or captured', () => {
    const alias = { ...position, nodeId: b.id, legacySourceRevision: null, deletedAt: new Date() };
    expect(planAliasPosition(a.id, alias)).toMatchObject({ nodeId: a.id, revision: 3n, legacySourceRevision: null, deletedAt: alias.deletedAt });
  });
});

describe('canonical merge plan', () => {
  it('chooses the oldest UUID and preserves manual facts regardless of input order', () => {
    expect(planCanonicalMerge(scope, b, a, [], 'accepted_link')).toMatchObject({ canonicalId: a.id, aliasId: b.id, labelOverride: 'Pinned label' });
  });
  it('rejects weak identity and cross-site aliases', () => {
    expect(() => planCanonicalMerge(scope, a, b, [], 'shared_ip' as never)).toThrow();
    expect(() => planCanonicalMerge(scope, a, { ...b, siteId: b.id }, [], 'accepted_link')).toThrow();
  });
  it('stops conflicting pins or manual labels', () => {
    const pins = [{ nodeId: a.id, layoutId: a.id, x: 1, y: 2, pinned: true }, { nodeId: b.id, layoutId: a.id, x: 2, y: 2, pinned: true }];
    expect(() => planCanonicalMerge(scope, a, b, pins, 'accepted_link')).toThrow(/pin/);
    expect(() => planCanonicalMerge(scope, a, { ...b, labelOverride: 'other' }, [], 'accepted_link')).toThrow(/manual/);
  });
});
