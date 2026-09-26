import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateReturning, selectRows, executeRows, calls, updates, insertMock, executeMock, sigMock } = vi.hoisted(() => {
  const calls: string[] = [];
  const executeRows: unknown[][] = [];
  return {
    updateReturning: [] as unknown[][],
    selectRows: [] as unknown[][],
    executeRows,
    calls,
    updates: [] as Array<{ set: Record<string, unknown>; where: unknown }>,
    insertMock: vi.fn(),
    executeMock: vi.fn(async (_q: unknown) => { calls.push('execute'); return executeRows.shift() ?? []; }),
    sigMock: { sourceRefFor: vi.fn(), signatureForSource: vi.fn() },
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
    for (const m of ['from', 'leftJoin', 'where', 'orderBy', 'limit', 'for']) chain[m] = () => chain;
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(selectRows.shift() ?? []).then(res, rej);
    return chain;
  });
  return { db: { update, insert: insertMock, execute: executeMock, select, selectDistinct: select, delete: vi.fn() } };
});
vi.mock('./signatureLoader', () => sigMock);

import {
  fillOutcomeSignature, groupContributions, identityLockKey, recomputeIdentity, transitionOutcome, type ContributingRow,
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
  updateReturning.length = 0; selectRows.length = 0; executeRows.length = 0; calls.length = 0; updates.length = 0;
  insertMock.mockReset(); executeMock.mockClear(); sigMock.sourceRefFor.mockReset(); sigMock.signatureForSource.mockReset();
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
