import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { canonicalIdentityKey } from './identity';
import { detachTopologyInventoryBinding, prepareTopologyOrgMerge, finalizeTopologyOrgMerge } from './tenantLifecycle';

const mocks = vi.hoisted(() => ({ execute: vi.fn(), assertInTransaction: vi.fn(), scope: 'system' }));
vi.mock('../../db', () => ({
  db: { execute: mocks.execute }, assertInTransaction: mocks.assertInTransaction,
  getCurrentDbAccessContext: () => ({ scope: mocks.scope }),
}));
const loser = '00000000-0000-4000-8000-000000000001';
const survivor = '00000000-0000-4000-8000-000000000002';
const site = '00000000-0000-4000-8000-000000000011';
const node = '00000000-0000-4000-8000-000000000021';
const other = '00000000-0000-4000-8000-000000000022';
const dialect = new PgDialect();
const queries = () => mocks.execute.mock.calls.map(([q]) => dialect.sqlToQuery(q));

beforeEach(() => { vi.clearAllMocks(); mocks.scope = 'system'; mocks.execute.mockResolvedValue([]); });

describe('topology tenant lifecycle', () => {
  it('requires an ambient system transaction for both org merge halves', async () => {
    mocks.scope = 'organization';
    await expect(prepareTopologyOrgMerge(loser, survivor)).rejects.toThrow(/system/i);
    await expect(finalizeTopologyOrgMerge(loser, survivor, [site])).rejects.toThrow(/system/i);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('locks sorted sites without blocking foreign-key readers, then fences state before registry moves', async () => {
    mocks.execute.mockResolvedValueOnce([{ id: site }]);
    await expect(prepareTopologyOrgMerge(loser, survivor)).resolves.toEqual({ siteIds: [site] });
    expect(queries()[0]!.sql).toMatch(/ORDER BY id.*FOR NO KEY UPDATE/s);
    expect(queries().some(q => /build_fence = build_fence \+ 1/.test(q.sql))).toBe(true);
    expect(queries().every(q => !/UPDATE sites/.test(q.sql))).toBe(true);
    expect(mocks.assertInTransaction).toHaveBeenCalled();
  });

  it('rejects a saved site whose owner did not become the survivor', async () => {
    mocks.execute.mockResolvedValueOnce([{ id: site, org_id: loser }]);
    await expect(finalizeTopologyOrgMerge(loser, survivor, [site])).rejects.toThrow(/ownership/i);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it('rekeys immutable material under the survivor while preserving canonical UUIDs', async () => {
    mocks.execute
      .mockResolvedValueOnce([{ id: site, org_id: survivor }])
      .mockResolvedValueOnce([{ site_id: site }])
      .mockResolvedValueOnce([{ id: node, site_id: site, kind: 'endpoint', identity_material: { version: 1, kind: 'endpoint', sourceKey: node } }])
      .mockResolvedValueOnce([{ id: other, site_id: site, kind: 'attachment', identity_material: { version: 1, kind: 'attachment', sourceKey: `legacy:${other}` } }]);
    await expect(finalizeTopologyOrgMerge(loser, survivor, [site])).resolves.toEqual({ rekeyed: 2, fenced: 1 });
    const nodeUpdate = queries().find(q => /UPDATE topology_nodes/.test(q.sql))!;
    expect(nodeUpdate.params).toContain(node);
    expect(nodeUpdate.params).toContain(canonicalIdentityKey({ orgId: survivor, siteId: site }, 'endpoint', node));
    expect(nodeUpdate.sql).not.toMatch(/SET id\s*=/);
    const outbox = queries().find(q => /UPDATE topology_change_outbox/.test(q.sql))!;
    expect(outbox.sql).toMatch(/delivered_at IS NULL/);
    expect(outbox.sql).not.toMatch(/source_revision\s*=/);
    expect(outbox.sql).toContain("payload ? 'oldIdentity'");
    expect(queries().some(q => /settings_revision = settings_revision \+ 1/.test(q.sql))).toBe(true);
  });

  it('fails closed for invalid immutable identity material', async () => {
    mocks.execute
      .mockResolvedValueOnce([{ id: site, org_id: survivor }])
      .mockResolvedValueOnce([{ site_id: site }])
      .mockResolvedValueOnce([{ id: node, site_id: site, kind: 'endpoint', identity_material: { version: 1, kind: 'endpoint', sourceKey: 'hostname:duplicate' } }])
      .mockResolvedValueOnce([]);
    await expect(finalizeTopologyOrgMerge(loser, survivor, [site])).rejects.toThrow(/identity/i);
    expect(queries().some(q => /UPDATE topology_nodes/.test(q.sql))).toBe(false);
  });

  it('delegates detachment to the same SQL backstop with explicit scopes', async () => {
    mocks.execute.mockResolvedValueOnce([{ detached: 1 }]);
    const tx = { execute: mocks.execute } as unknown as Parameters<typeof detachTopologyInventoryBinding>[0];
    await expect(detachTopologyInventoryBinding(tx, { kind: 'device', id: node,
      oldScope: { orgId: loser, siteId: site }, newScope: null })).resolves.toBe(1);
    expect(queries()[0]!.sql).toContain('breeze_detach_topology_inventory_binding');
    expect(queries()[0]!.params).toEqual(['device', node, loser, site, null, null]);
  });
});
