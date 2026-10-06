import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const {
  updateReturning, selectRows, selectWheres, executeRows, calls, updates, insertMock, executeMock, sigMock, dbAccessContextMock,
} = vi.hoisted(() => {
  const calls: string[] = [];
  const executeRows: unknown[][] = [];
  return {
    updateReturning: [] as unknown[][],
    selectRows: [] as unknown[][],
    selectWheres: [] as unknown[],
    executeRows,
    calls,
    updates: [] as Array<{ set: Record<string, unknown>; where: unknown }>,
    insertMock: vi.fn(),
    executeMock: vi.fn(async (_q: unknown) => { calls.push('execute'); return executeRows.shift() ?? []; }),
    sigMock: { sourceRefFor: vi.fn(), signatureForSource: vi.fn() },
    dbAccessContextMock: vi.fn(() => ({ scope: 'system' })),
  };
});
vi.mock('../../db', () => {
  const update = vi.fn(() => ({
    set: (set: Record<string, unknown>) => ({
      where: (where: unknown) => {
        calls.push('update');
        updates.push({ set, where });
        // Awaitable as-is (bulk UPDATE) and via .returning() (CAS UPDATE).
        return Object.assign(Promise.resolve(undefined), { returning: async () => updateReturning.shift() ?? [] });
      },
    }),
  }));
  // Every select chain is thenable; rows are consumed only when awaited, so a
  // select built as a subquery (partnerScope) consumes nothing.
  const select = vi.fn(() => {
    calls.push('select');
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'leftJoin', 'orderBy', 'limit', 'for']) chain[m] = () => chain;
    chain.where = (w: unknown) => { selectWheres.push(w); return chain; };
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(selectRows.shift() ?? []).then(res, rej);
    return chain;
  });
  return {
    db: { update, insert: insertMock, execute: executeMock, select, selectDistinct: select, delete: vi.fn() },
    getCurrentDbAccessContext: dbAccessContextMock,
  };
});
vi.mock('./signatureLoader', () => sigMock);

import {
  clearOrgErasureRequest, fillOutcomeSignature, groupContributions, identityLockKey, markFixMemoryStaleForOrgErasure,
  markOwnerDriftStale, markPartnerFixMemoryStale, recomputeForOutcome, recomputeIdentity, rebuildFixMemory,
  retireFixMemory, stalePartnerIds, transitionOutcome, type ContributingRow,
} from './store';

/** Flattens a Drizzle SQL object without a dialect: literal text plus bound primitive params. */
function flatten(node: unknown, out = { text: '', params: [] as unknown[] }, seen = new Set<unknown>()): { text: string; params: unknown[] } {
  if (node === null || node === undefined) return out;
  if (typeof node !== 'object') { out.params.push(node); return out; }
  if (seen.has(node)) return out;
  seen.add(node);
  const n = node as { queryChunks?: unknown[]; value?: unknown };
  if (Array.isArray(n.queryChunks)) { for (const c of n.queryChunks) flatten(c, out, seen); return out; }
  if (Array.isArray(n.value) && n.value.every((v) => typeof v === 'string')) { out.text += n.value.join(''); return out; } // StringChunk
  if ('value' in n && !Array.isArray(n.value) && (typeof n.value !== 'object' || n.value === null)) { out.params.push(n.value); return out; } // Param
  return out; // column / table / builder
}

beforeEach(() => {
  updateReturning.length = 0; selectRows.length = 0; selectWheres.length = 0; executeRows.length = 0; calls.length = 0; updates.length = 0;
  insertMock.mockReset(); executeMock.mockClear(); sigMock.sourceRefFor.mockReset(); sigMock.signatureForSource.mockReset();
  dbAccessContextMock.mockReset().mockReturnValue({ scope: 'system' });
});

const row = (over: Partial<ContributingRow> = {}): ContributingRow => ({
  orgId: 'org-a', partnerId: 'p-1', signatureVersion: 1, signatureKey: 'k'.repeat(64), broadKey: 'b'.repeat(64),
  osType: 'windows', fixKind: 'partner_script', fixIdentity: 'script_version:v1', scriptId: 's-1', scriptVersionId: 'v1',
  builtinAction: null, playbookId: null, instructionsRef: null, state: 'verified', humanVote: null,
  terminalAt: new Date('2026-11-01T00:00:00Z'), script: { isSystem: false, orgId: null, partnerId: 'p-1' }, playbook: null,
  ...over,
});

describe('groupContributions', () => {
  it('folds attempts from different orgs of one partner into ONE partner row for a partner-wide script', () => {
    const groups = groupContributions([row(), row({ orgId: 'org-b' }), row({ orgId: 'org-c', state: 'failed' })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.owner).toEqual({ orgId: null, partnerId: 'p-1' });
    expect(groups[0]!.attempts.map((a) => a.result)).toEqual(['verified', 'verified', 'failed']);
  });

  it('keeps org scripts private per org and follows CURRENT ownership (re-scope fold)', () => {
    const orgScript = { isSystem: false, orgId: 'org-a', partnerId: 'p-1' };
    const groups = groupContributions([row({ fixKind: 'org_script', script: orgScript })]);
    expect(groups[0]!.owner).toEqual({ orgId: 'org-a', partnerId: null });
    // Same historical outcome, script since promoted partner-wide:
    const folded = groupContributions([row({ fixKind: 'org_script', script: { isSystem: false, orgId: null, partnerId: 'p-1' } })]);
    expect(folded[0]!.owner).toEqual({ orgId: null, partnerId: 'p-1' });
    expect(folded[0]!.identity.fixKind).toBe('partner_script');
  });

  it('drops uncounted attempts and attempts whose fix no longer belongs to this tenant', () => {
    expect(groupContributions([row({ state: 'inconclusive' }), row({ state: 'cancelled', humanVote: 'down' })])).toEqual([]);
    expect(groupContributions([row({ fixKind: 'org_script', script: { isSystem: false, orgId: 'org-z', partnerId: 'p-1' } })])).toEqual([]);
  });

  it('splits identities by script version', () => {
    const groups = groupContributions([row(), row({ fixIdentity: 'script_version:v2', scriptVersionId: 'v2' })]);
    expect(groups).toHaveLength(2);
  });
});

describe('transitionOutcome', () => {
  it('a lost compare-and-swap is a no-op: no aggregate write (exactly-once)', async () => {
    updateReturning.push([]);
    const won = await transitionOutcome(
      { id: 'o-1', state: 'awaiting_recovery', countedAt: null, partnerId: 'p-1', signatureVersion: 1, signatureKey: 'k'.repeat(64), osType: 'windows', fixIdentity: 'script_version:v1' } as never,
      { to: 'failed', reason: 'condition_persisted' }, new Date(),
    );
    expect(won).toBe(false);
    expect(executeMock).not.toHaveBeenCalled(); // no advisory lock, no recompute
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('the CAS predicate is (id, prior state) AND counted_at IS NULL — the exactly-once guard, not just the mock call shape', async () => {
    updateReturning.push([]);
    await transitionOutcome(
      { id: 'o-1', state: 'holding', countedAt: null } as never,
      { to: 'verified', reason: 'x' }, new Date(),
    );
    const q = new PgDialect().sqlToQuery(updates.at(-1)!.where as never);
    expect(q.sql.toLowerCase()).toContain('"counted_at" is null');
    expect(q.sql.toLowerCase()).toMatch(/"state" = \$\d/);
    expect(q.sql.toLowerCase()).toMatch(/"id" = \$\d/);
  });

  it('a non-terminal transition never recomputes', async () => {
    updateReturning.push([{ id: 'o-1' }]);
    const won = await transitionOutcome(
      { id: 'o-1', state: 'pending', countedAt: null } as never,
      { to: 'awaiting_recovery', reason: 'script_succeeded', deadlineAt: new Date() }, new Date(),
    );
    expect(won).toBe(true);
    expect(executeMock).not.toHaveBeenCalled();
  });

  const identity = { partnerId: 'p-1', signatureVersion: 1, signatureKey: 'k'.repeat(64), osType: 'windows', fixIdentity: 'script_version:v1' };
  const unsignedHolding = {
    id: 'o-1', state: 'holding', countedAt: null, partnerId: 'p-1',
    signatureVersion: null, signatureKey: null, broadKey: null, osType: null, fixIdentity: 'script_version:v1',
  };

  it('aggregates from the PERSISTED row the CAS returned, not the caller’s unsigned snapshot', async () => {
    // The snapshot predates a concurrent signature fill; the row the UPDATE hit carries the signature.
    updateReturning.push([{ ...unsignedHolding, state: 'verified', countedAt: new Date(), signatureVersion: 1, signatureKey: 'k'.repeat(64), broadKey: 'b'.repeat(64), osType: 'windows' }]);
    const won = await transitionOutcome(unsignedHolding as never, { to: 'verified', reason: 'held_with_fresh_telemetry' }, new Date());
    expect(won).toBe(true);
    // recomputeIdentity ran for the persisted identity: its first statement is that identity's advisory lock.
    expect(flatten(executeMock.mock.calls[0]![0]).params).toContain(identityLockKey(identity));
  });

  it('a counted row that is still unsigned asks the sweeper to recount it instead of silently skipping the aggregate', async () => {
    updateReturning.push([{ ...unsignedHolding, state: 'verified', countedAt: new Date() }]);
    expect(await transitionOutcome(unsignedHolding as never, { to: 'verified', reason: 'held_with_fresh_telemetry' }, new Date())).toBe(true);
    expect(executeMock).not.toHaveBeenCalled(); // nothing to aggregate yet
    expect(updates.at(-1)!.set.recountRequestedAt).toBeInstanceOf(Date);
  });
});

describe('fillOutcomeSignature', () => {
  it('a lost signature CAS returns the PERSISTED (reloaded) row, never the unsigned snapshot', async () => {
    sigMock.sourceRefFor.mockReturnValue({ kind: 'alert', alertId: 'a-1' });
    sigMock.signatureForSource.mockResolvedValue({
      signature: { version: 1, key: 'k'.repeat(64), broadKey: 'b'.repeat(64), facets: { osFamily: 'windows' } },
      deviceId: 'd-1', alertId: 'a-1', anomalyEpisodeId: null,
    });
    updateReturning.push([]); // another writer stamped the signature first: our CAS matched 0 rows
    selectRows.push([{ id: 'o-1', state: 'holding', signatureVersion: 1, signatureKey: 'k'.repeat(64), broadKey: 'b'.repeat(64), osType: 'windows' }]);
    const row = await fillOutcomeSignature({ id: 'o-1', state: 'holding', sourceType: 'alert', sourceId: 'a-1', signatureKey: null, alertId: 'a-1', anomalyEpisodeId: null } as never, new Date());
    expect(row.signatureKey).toBe('k'.repeat(64));
    expect(calls).toEqual(['update', 'select']); // CAS, then reload
    // The CAS predicate itself guards against overwriting a signature another
    // writer already stamped — not just the mocked call shape.
    const q = new PgDialect().sqlToQuery(updates.at(-1)!.where as never);
    expect(q.sql.toLowerCase()).toContain('"signature_key" is null');
  });
});

describe('recomputeIdentity(clearStale) — the durable org-erasure rebuild request', () => {
  const identity = { partnerId: 'p-1', signatureVersion: 1, signatureKey: 'k'.repeat(64), osType: 'windows', fixIdentity: 'script_version:v1' };
  const memoryWrites = () => updates.filter((u) => 'staleSince' in u.set || 'rebuildPendingOrgIds' in u.set);

  it('reads which pending orgs are already gone BEFORE it reads contributions', async () => {
    executeRows.push([], []); // advisory lock, erased-org read
    await recomputeIdentity(identity, new Date(), { clearStale: true });
    expect(calls.slice(0, 3)).toEqual(['execute', 'execute', 'select']);
  });

  it('while the erased org still exists (cascade not finished) it keeps the request and clears stale only where none is pending', async () => {
    executeRows.push([], []); // nothing erased yet
    await recomputeIdentity(identity, new Date(), { clearStale: true });
    const writes = memoryWrites();
    expect(writes.map((u) => Object.keys(u.set).sort())).toEqual([['staleSince', 'updatedAt']]); // no request removal
    expect(flatten(writes[0]!.where).text).toContain('cardinality(');
  });

  it('once the org row is gone it removes exactly that org from the request, then clears stale', async () => {
    executeRows.push([], [{ org_id: 'org-gone' }]);
    await recomputeIdentity(identity, new Date(), { clearStale: true });
    const writes = memoryWrites();
    expect(writes).toHaveLength(2);
    expect(Object.keys(writes[0]!.set)).toContain('rebuildPendingOrgIds');
    expect(flatten(writes[0]!.set.rebuildPendingOrgIds).params).toEqual(['org-gone']);
    expect(writes[1]!.set).toMatchObject({ staleSince: null });
  });

  it('a plain recompute (no clearStale) never reads erasure requests or touches stale_since', async () => {
    executeRows.push([]);
    await recomputeIdentity(identity, new Date());
    expect(executeMock).toHaveBeenCalledTimes(1); // the identity lock only
    expect(memoryWrites()).toEqual([]);
  });
});

describe('markFixMemoryStaleForOrgErasure — identity locks before the UPDATE (no deadlock with a concurrent rebuild)', () => {
  it('locks every affected identity (sorted) before writing the erasure mark, and only touches those rows', async () => {
    selectRows.push([{ partnerId: 'p-1' }]); // org lookup
    selectRows.push([
      { id: 'm-2', partnerId: 'p-1', signatureVersion: 1, signatureKey: 'b'.repeat(64), osType: 'windows', fixIdentity: 'script_version:v2' },
      { id: 'm-1', partnerId: 'p-1', signatureVersion: 1, signatureKey: 'a'.repeat(64), osType: 'windows', fixIdentity: 'script_version:v1' },
    ]); // target identities, selected in arbitrary (not sorted) order
    executeRows.push([], []); // two advisory locks
    const partnerId = await markFixMemoryStaleForOrgErasure('org-a');
    expect(partnerId).toBe('p-1');
    expect(calls).toEqual(['select', 'select', 'execute', 'execute', 'update']);
    const keyA = identityLockKey({ partnerId: 'p-1', signatureVersion: 1, signatureKey: 'a'.repeat(64), osType: 'windows', fixIdentity: 'script_version:v1' });
    const keyB = identityLockKey({ partnerId: 'p-1', signatureVersion: 1, signatureKey: 'b'.repeat(64), osType: 'windows', fixIdentity: 'script_version:v2' });
    // Locks are taken in SORTED key order regardless of the select's row order —
    // the same order rebuildFixMemory uses, so the two can never deadlock.
    expect(flatten(executeMock.mock.calls[0]![0]).params).toContain(keyA);
    expect(flatten(executeMock.mock.calls[1]![0]).params).toContain(keyB);
    // The final UPDATE is restricted to the resolved target ids, not a re-run
    // of the original scan predicate (which could race a concurrent writer).
    const q = new PgDialect().sqlToQuery(updates.at(-1)!.where as never);
    expect(q.sql.toLowerCase()).toContain('"id" in');
  });

  it('does nothing — no locks, no update — when the org has no matching fix_memory rows', async () => {
    selectRows.push([{ partnerId: 'p-1' }]);
    selectRows.push([]); // no targets
    const partnerId = await markFixMemoryStaleForOrgErasure('org-a');
    expect(partnerId).toBe('p-1');
    expect(calls).toEqual(['select', 'select']);
    expect(executeMock).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });
});

describe('markPartnerFixMemoryStale — identity locks before the UPDATE, partner-owned rows only', () => {
  it('locks every partner-owned identity (sorted) before writing the stale mark, and only touches those rows', async () => {
    selectRows.push([
      { id: 'm-2', partnerId: 'p-1', signatureVersion: 1, signatureKey: 'b'.repeat(64), osType: 'windows', fixIdentity: 'script_version:v2' },
      { id: 'm-1', partnerId: 'p-1', signatureVersion: 1, signatureKey: 'a'.repeat(64), osType: 'windows', fixIdentity: 'script_version:v1' },
    ]); // target identities, selected in arbitrary (not sorted) order
    executeRows.push([], []); // two advisory locks
    await markPartnerFixMemoryStale('p-1');
    expect(calls).toEqual(['select', 'execute', 'execute', 'update']);
    const keyA = identityLockKey({ partnerId: 'p-1', signatureVersion: 1, signatureKey: 'a'.repeat(64), osType: 'windows', fixIdentity: 'script_version:v1' });
    const keyB = identityLockKey({ partnerId: 'p-1', signatureVersion: 1, signatureKey: 'b'.repeat(64), osType: 'windows', fixIdentity: 'script_version:v2' });
    // Locks are taken in SORTED key order regardless of the select's row order.
    expect(flatten(executeMock.mock.calls[0]![0]).params).toContain(keyA);
    expect(flatten(executeMock.mock.calls[1]![0]).params).toContain(keyB);
    // The final UPDATE only sets staleSince/updatedAt (no rebuildPendingOrgIds
    // — this function has no org id to append) and targets the resolved ids.
    expect(Object.keys(updates.at(-1)!.set).sort()).toEqual(['staleSince', 'updatedAt']);
    const q = new PgDialect().sqlToQuery(updates.at(-1)!.where as never);
    expect(q.sql.toLowerCase()).toContain('"id" in');
  });

  it('does nothing — no locks, no update — when the partner has no partner-owned fix_memory rows', async () => {
    selectRows.push([]); // no targets
    await markPartnerFixMemoryStale('p-1');
    expect(calls).toEqual(['select']);
    expect(executeMock).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });
});

describe('clearOrgErasureRequest — undo the pre-cascade mark when the cascade refuses (I1)', () => {
  it('locks every identity carrying the request (sorted), then array_removes exactly that org from exactly those rows', async () => {
    selectRows.push([
      { id: 'm-2', partnerId: 'p-1', signatureVersion: 1, signatureKey: 'b'.repeat(64), osType: 'windows', fixIdentity: 'script_version:v2' },
      { id: 'm-1', partnerId: 'p-1', signatureVersion: 1, signatureKey: 'a'.repeat(64), osType: 'windows', fixIdentity: 'script_version:v1' },
    ]);
    executeRows.push([], []);
    updateReturning.push([{ id: 'm-1' }, { id: 'm-2' }]);
    expect(await clearOrgErasureRequest('org-held')).toBe(2);
    expect(calls).toEqual(['select', 'execute', 'execute', 'update']);
    const keyA = identityLockKey({ partnerId: 'p-1', signatureVersion: 1, signatureKey: 'a'.repeat(64), osType: 'windows', fixIdentity: 'script_version:v1' });
    const keyB = identityLockKey({ partnerId: 'p-1', signatureVersion: 1, signatureKey: 'b'.repeat(64), osType: 'windows', fixIdentity: 'script_version:v2' });
    expect(flatten(executeMock.mock.calls[0]![0]).params).toContain(keyA);
    expect(flatten(executeMock.mock.calls[1]![0]).params).toContain(keyB);
    const write = updates.at(-1)!;
    // stale_since is left alone: the next sweep rebuilds and lifts it (no request pending).
    expect(Object.keys(write.set).sort()).toEqual(['rebuildPendingOrgIds', 'updatedAt']);
    const removal = flatten(write.set.rebuildPendingOrgIds);
    expect(removal.text).toContain('array_remove(');
    expect(removal.params).toEqual(['org-held']);
    expect(new PgDialect().sqlToQuery(write.where as never).sql.toLowerCase()).toContain('"id" in');
  });

  it('does nothing — no locks, no update — when no row carries the request', async () => {
    selectRows.push([]);
    expect(await clearOrgErasureRequest('org-held')).toBe(0);
    expect(calls).toEqual(['select']);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('refuses outside system scope', async () => {
    dbAccessContextMock.mockReturnValue({ scope: 'organization' });
    await expect(clearOrgErasureRequest('org-held')).rejects.toThrow(/system-scoped/);
    expect(calls).toHaveLength(0);
  });
});

describe('stalePartnerIds — oldest stale first, so held/poison partners cannot starve the retry pass (I1b)', () => {
  it('orders by the oldest stale_since (NULLS LAST) then partner id, before the LIMIT', async () => {
    executeRows.push([{ partner_id: 'p-old' }, { partner_id: 'p-new' }]);
    expect(await stalePartnerIds(20)).toEqual(['p-old', 'p-new']);
    const q = flatten(executeMock.mock.calls[0]![0]);
    const text = q.text.replace(/\s+/g, ' ').toLowerCase();
    expect(text).toMatch(/order by min\(m\.stale_since\) asc nulls last, partner_id asc limit/);
    expect(q.params).toEqual([20]);
  });
});

describe('markOwnerDriftStale — identity locks before the UPDATE', () => {
  it('locks every affected identity (sorted; an org row is resolved via its organization\'s partner) before marking drift stale', async () => {
    selectRows.push([
      { id: 'm-1', partnerId: 'p-1', signatureVersion: 1, signatureKey: 'a'.repeat(64), osType: 'windows', fixIdentity: 'script_version:v1' },
    ]);
    executeRows.push([]);
    updateReturning.push([{ id: 'm-1' }]);
    const n = await markOwnerDriftStale();
    expect(n).toBe(1);
    expect(calls).toEqual(['select', 'execute', 'update']);
    expect(flatten(executeMock.mock.calls[0]![0]).params).toContain(
      identityLockKey({ partnerId: 'p-1', signatureVersion: 1, signatureKey: 'a'.repeat(64), osType: 'windows', fixIdentity: 'script_version:v1' }),
    );
  });

  it('never flags a retired row, and a NULL-producing ownership test counts as drift (M3)', async () => {
    selectRows.push([]);
    await markOwnerDriftStale();
    const where = flatten(selectWheres[0]);
    const text = where.text.replace(/\s+/g, ' ').toLowerCase();
    // status <> 'retired' — a retired row would otherwise be re-flagged and rebuilt every sweep.
    expect(text).toContain('<>');
    expect(where.params).toContain('retired');
    // NOT COALESCE((expected-owner test), false): NULL (e.g. a NULL partner_id) is drift, not "fine".
    expect(text).toMatch(/not coalesce\(\(/);
    expect(text).toMatch(/\), false\)\)/);
  });

  it('does nothing — no locks, no update — when nothing has drifted', async () => {
    selectRows.push([]);
    expect(await markOwnerDriftStale()).toBe(0);
    expect(calls).toEqual(['select']);
    expect(executeMock).not.toHaveBeenCalled();
  });
});

describe('system-scope guard — every fix_memory writer requires an open system-scoped DB context', () => {
  const outsideSystem = () => dbAccessContextMock.mockReturnValue({ scope: 'organization' });

  it('transitionOutcome refuses outside system scope, before touching the DB at all', async () => {
    outsideSystem();
    await expect(transitionOutcome({ id: 'o-1', state: 'pending', countedAt: null } as never, { to: 'verified', reason: 'x' }, new Date()))
      .rejects.toThrow(/system-scoped/);
    expect(calls).toHaveLength(0);
  });

  it('recomputeForOutcome refuses outside system scope', async () => {
    outsideSystem();
    await expect(recomputeForOutcome('o-1')).rejects.toThrow(/system-scoped/);
    expect(calls).toHaveLength(0);
  });

  it('rebuildFixMemory refuses outside system scope', async () => {
    outsideSystem();
    await expect(rebuildFixMemory({ partnerId: 'p-1' })).rejects.toThrow(/system-scoped/);
    expect(calls).toHaveLength(0);
  });

  it('markFixMemoryStaleForOrgErasure refuses outside system scope', async () => {
    outsideSystem();
    await expect(markFixMemoryStaleForOrgErasure('org-a')).rejects.toThrow(/system-scoped/);
    expect(calls).toHaveLength(0);
  });

  it('markOwnerDriftStale refuses outside system scope', async () => {
    outsideSystem();
    await expect(markOwnerDriftStale()).rejects.toThrow(/system-scoped/);
    expect(calls).toHaveLength(0);
  });

  it('markPartnerFixMemoryStale refuses outside system scope', async () => {
    outsideSystem();
    await expect(markPartnerFixMemoryStale('p-1')).rejects.toThrow(/system-scoped/);
    expect(calls).toHaveLength(0);
  });

  it('retireFixMemory is the documented exception: caller-facing, runs under a request context, but needs SOME context', async () => {
    dbAccessContextMock.mockReturnValue(undefined as never);
    await expect(retireFixMemory({ id: 'm-1', userId: 'u-1' })).rejects.toThrow(/open DB access context/);
    expect(calls).toHaveLength(0);
    outsideSystem(); // an organization-scoped request context is accepted
    selectRows.push([{ id: 'm-1', partnerId: 'p-1', orgId: null, signatureVersion: 1, signatureKey: 'k', osType: 'windows', fixIdentity: 'x', status: 'active' }]);
    updateReturning.push([{ id: 'm-1' }]);
    await expect(retireFixMemory({ id: 'm-1', userId: 'u-1' })).resolves.toBe('retired');
  });

  it('the ambient scope is CHECKED, not merely a truthy context — reports "none" when unset', async () => {
    dbAccessContextMock.mockReturnValue(undefined as never);
    await expect(recomputeForOutcome('o-1')).rejects.toThrow(/ambient scope: none/);
  });
});

describe('retireFixMemory (W2 Task 18)', () => {
  const memRow = (status: string) => ({ id: 'm-1', partnerId: 'p-1', orgId: null, signatureVersion: 1, signatureKey: 'k', osType: 'windows', fixIdentity: 'builtin:reboot', status });
  beforeEach(() => { dbAccessContextMock.mockReturnValue({ scope: 'organization' }); });

  it('takes the identity lock before the update, then retires once', async () => {
    selectRows.push([memRow('active')]);
    updateReturning.push([{ id: 'm-1' }]);
    await expect(retireFixMemory({ id: 'm-1', userId: 'u-1' })).resolves.toBe('retired');
    expect(calls).toEqual(['select', 'execute', 'update']);
    expect(flatten(executeMock.mock.calls.at(-1)![0]).params).toContain(
      identityLockKey({ partnerId: 'p-1', signatureVersion: 1, signatureKey: 'k', osType: 'windows', fixIdentity: 'builtin:reboot' }));
    const u = updates.at(-1)!;
    expect(u.set).toMatchObject({ status: 'retired', retiredBy: 'u-1' });
  });

  it('is idempotent and honest about missing rows', async () => {
    selectRows.push([memRow('retired')]);
    updateReturning.push([]);
    await expect(retireFixMemory({ id: 'm-1', userId: 'u-1' })).resolves.toBe('already_retired');
    selectRows.push([]);
    await expect(retireFixMemory({ id: 'nope', userId: 'u-1' })).resolves.toBe('not_found');
  });

  it('resolves the partner of an org-private row for the lock key', async () => {
    selectRows.push([{ ...memRow('active'), partnerId: null, orgId: 'org-1' }], [{ partnerId: 'p-9' }]);
    updateReturning.push([{ id: 'm-1' }]);
    await retireFixMemory({ id: 'm-1', userId: 'u-1' });
    expect(flatten(executeMock.mock.calls.at(-1)![0]).params.join(' ')).toContain('fix_memory:p-9:');
  });
});
