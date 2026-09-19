import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same chainable-mock dialect as deliverableAutoEvidence.test.ts: each awaited
// chain resolves the next queued result.
const { rows, inserted, conflicts } = vi.hoisted(() => ({
  rows: [] as unknown[],
  inserted: [] as unknown[],
  conflicts: [] as unknown[],
}));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'returning']) chain[m] = vi.fn(() => chain);
  chain.values = vi.fn((v: unknown) => { inserted.push(v); return chain; });
  chain.onConflictDoNothing = vi.fn((c: unknown) => { conflicts.push(c); return chain; });
  (chain as { then: unknown }).then = (r: (v: unknown) => unknown) => Promise.resolve(rows.shift() ?? []).then(r);
  return { db: chain, withSystemDbAccessContext: (fn: () => unknown) => fn(), runOutsideDbContext: (fn: () => unknown) => fn() };
});

vi.mock('./managedEvidenceRegistry', () => {
  const entry = { type: 'test_type', defaultConfig: { sites: [] }, definitionName: 'Service evidence — Test' };
  return {
    MANAGED_EVIDENCE_REGISTRY: { test_type: entry },
    isManagedEvidenceType: (v: string) => v === 'test_type',
    managedEvidenceEntry: (t: string) => { if (t !== 'test_type') throw new Error(`${t} is not a managed evidence type`); return entry; },
    MANAGED_EVIDENCE_DEFINITION_NAME_PREFIX: 'Service evidence — ',
  };
});

import { db } from '../db';
import { resolveManagedEvidenceDefinition, loadManagedEvidenceDefinition } from './managedEvidenceDefinitions';

describe('resolveManagedEvidenceDefinition', () => {
  beforeEach(() => { rows.length = 0; inserted.length = 0; conflicts.length = 0; vi.clearAllMocks(); });

  it('adopts an existing portal_self_service definition without rewriting its config', async () => {
    rows.push([{ id: 'r1', type: 'test_type', config: { sites: ['tuned'] } }]);
    const got = await resolveManagedEvidenceDefinition('org1', 'test_type' as never, 'u1');
    expect(got).toEqual({ id: 'r1', type: 'test_type', config: { sites: ['tuned'] }, adopted: true });
    expect(inserted).toHaveLength(0);
  });

  it('provisions with the registry default config when absent, then re-reads the settled row', async () => {
    rows.push([]);                                                    // first load: absent
    rows.push([]);                                                    // insert (onConflictDoNothing) resolves
    rows.push([{ id: 'r2', type: 'test_type', config: { sites: [] } }]); // settled re-read
    const got = await resolveManagedEvidenceDefinition('org1', 'test_type' as never, 'u1');
    expect(got).toEqual({ id: 'r2', type: 'test_type', config: { sites: [] }, adopted: false });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      orgId: 'org1', type: 'test_type', name: 'Service evidence — Test', config: { sites: [] },
      portalSelfService: true, createdBy: 'u1', executionScopeKind: 'unrestricted', executionScopePrincipalKind: 'user',
    });
    // Insert-if-absent under the partial unique index — never an updating upsert.
    expect(conflicts).toHaveLength(1);
  });

  it('refuses a type that is not in the registry before touching the database', async () => {
    await expect(resolveManagedEvidenceDefinition('org1', 'device_inventory' as never, 'u1'))
      .rejects.toThrow(/not a managed evidence type/i);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('fails loudly when the re-read after insert finds nothing', async () => {
    rows.push([]); rows.push([]); rows.push([]);
    await expect(resolveManagedEvidenceDefinition('org1', 'test_type' as never, 'u1'))
      .rejects.toThrow(/Failed to provision managed evidence definition/);
  });

  it('uses the caller-supplied executor for every read and write', async () => {
    const ex: Record<string, unknown> = {};
    const seen: unknown[] = [];
    for (const m of ['select', 'from', 'where', 'limit', 'insert', 'values', 'onConflictDoNothing']) ex[m] = vi.fn(() => ex);
    (ex as { then: unknown }).then = (r: (v: unknown) => unknown) => Promise.resolve(seen.shift() ?? []).then(r);
    seen.push([]); seen.push([]); seen.push([{ id: 'r3', type: 'test_type', config: {} }]);
    const got = await resolveManagedEvidenceDefinition('org1', 'test_type' as never, 'u1', ex as never);
    expect(got.id).toBe('r3');
    expect(ex.select).toHaveBeenCalledTimes(2);
    expect(ex.insert).toHaveBeenCalledTimes(1);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });
});

describe('loadManagedEvidenceDefinition', () => {
  beforeEach(() => { rows.length = 0; vi.clearAllMocks(); });

  it('returns null when the org has no managed definition of that type', async () => {
    rows.push([]);
    expect(await loadManagedEvidenceDefinition('org1', 'test_type' as never)).toBeNull();
  });
});
