/**
 * Unit tests for the MSP status read (portal registration W8 #11385, plan
 * Task 8) over a scripted Drizzle mock: mode, last runs per source, the open
 * actions of the latest evaluated run, rearmed identities, and the org-merge
 * filter (only runs whose chain names this org). Real-Postgres behaviour is
 * proven by the W8 integration suite.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const calls: Array<{ steps: Array<[string, unknown[]]>; depth: number }> = [];
  const results: unknown[] = [];
  const txDepth = { current: 0 };
  function builder(): unknown {
    const call = { steps: [] as Array<[string, unknown[]]>, depth: txDepth.current };
    calls.push(call);
    const proxy: unknown = new Proxy(() => undefined, {
      get(_target, prop) {
        if (prop === 'then') {
          const next = results.length > 0 ? results.shift() : [];
          return (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
            next instanceof Error ? reject(next) : resolve(next);
        }
        return (...stepArgs: unknown[]) => {
          call.steps.push([String(prop), stepArgs]);
          return proxy;
        };
      },
    });
    return proxy;
  }
  return { calls, results, txDepth, builder };
});

vi.mock('../../db', () => ({
  db: { select: () => h.builder() },
  hasDbAccessContext: vi.fn(() => h.txDepth.current > 0),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    h.txDepth.current += 1;
    try { return await fn(); } finally { h.txDepth.current -= 1; }
  }),
  runOutsideDbContext: vi.fn(<T,>(fn: () => T) => fn()),
}));
const mode = vi.hoisted(() => ({ value: 'report' as 'report' | 'enforce' }));
vi.mock('./mode', () => ({ directoryMode: vi.fn(() => mode.value) }));

import { entraChainKey, googleChainKey } from './chain';
import { getPortalDirectoryStatus, runNamesOrg } from './status';

const ORG = '7c0a1f7e-1111-4222-8333-444455556666';
const ABSORBED = '7c0a1f7e-9999-4222-8333-444455556666';
const CONN = '9b0a1f7e-1111-4222-8333-444455556666';
const ENTRA_CHAIN = entraChainKey({ tenantId: 'a1a1a1a1-b2b2-4c3c-8d4d-e5e5e5e5e5e5', connectionId: CONN, consentGeneration: 2, orgId: ORG });
const ABSORBED_CHAIN = entraChainKey({ tenantId: 'a1a1a1a1-b2b2-4c3c-8d4d-e5e5e5e5e5e5', connectionId: CONN, consentGeneration: 2, orgId: ABSORBED });
const GOOGLE_CHAIN = googleChainKey({ customerId: 'C01abc', connectionId: CONN, binding: 'b1', orgId: ORG });
const T0 = new Date('2027-02-01T10:00:00.000Z');

function run(over: Record<string, unknown>) {
  return {
    id: 'run-x', source: 'entra', chainKey: ENTRA_CHAIN, outcome: 'evaluated', reason: null, disposition: 'reported',
    holdReason: null, directoryUserCount: 120, usableCount: 40, affectedCount: 1, impactDigest: 'd'.repeat(64), createdAt: T0,
    ...over,
  };
}

function action(over: Record<string, unknown>) {
  return {
    id: 'act-x', runId: 'run-e1', identityId: 'idn-x', portalUserId: 'pu-x', email: 'x@customer.example', name: 'X',
    provider: 'entra', reason: 'account_disabled', effect: 'identity_and_account', keepsPassword: false, status: 'reported', skipReason: null,
    ...over,
  };
}

beforeEach(() => {
  h.calls.length = 0;
  h.results.length = 0;
  h.txDepth.current = 0;
  mode.value = 'report';
});

describe('runNamesOrg', () => {
  it('a refused run (no chain) is the org\'s own; a chain must name this org and the run\'s source', () => {
    expect(runNamesOrg({ chainKey: null, source: 'entra' }, ORG)).toBe(true);
    expect(runNamesOrg({ chainKey: ENTRA_CHAIN, source: 'entra' }, ORG)).toBe(true);
    expect(runNamesOrg({ chainKey: ABSORBED_CHAIN, source: 'entra' }, ORG)).toBe(false);
    expect(runNamesOrg({ chainKey: ENTRA_CHAIN, source: 'google' }, ORG)).toBe(false);
    expect(runNamesOrg({ chainKey: 'garbage', source: 'entra' }, ORG)).toBe(false);
  });
});

describe('getPortalDirectoryStatus', () => {
  it('status lists mode, last runs per source, open actions, and rearmed identities', async () => {
    mode.value = 'enforce';
    h.results.push(
      // entra: last run (a refused run, no chain), then last evaluated run
      [run({ id: 'run-e2', chainKey: null, outcome: 'incomplete', reason: 'sync_incomplete', disposition: 'none', impactDigest: null })],
      [run({ id: 'run-e1', disposition: 'held', holdReason: 'first_enforcement' })],
      // google: last run and last evaluated run are the same
      [run({ id: 'run-g1', source: 'google', chainKey: GOOGLE_CHAIN })],
      [run({ id: 'run-g1', source: 'google', chainKey: GOOGLE_CHAIN })],
      // actions of the latest evaluated runs
      [
        action({ id: 'act-1', identityId: 'idn-1', portalUserId: 'pu-1', email: 'a@customer.example', status: 'held' }),
        action({ id: 'act-2', runId: 'run-g1', identityId: 'idn-2', portalUserId: 'pu-2', email: 'b@customer.example', provider: 'google', reason: 'suspended', status: 'reported', keepsPassword: true, effect: 'identity' }),
        action({ id: 'act-3', identityId: 'idn-3', portalUserId: 'pu-3', email: 'c@customer.example', status: 'skipped', skipReason: 'rearmed' }),
      ],
      // identities with directory_rearm_since set
      [
        { identityId: 'idn-3', portalUserId: 'pu-3', email: 'c@customer.example', name: 'C', provider: 'entra' },
        { identityId: 'idn-4', portalUserId: 'pu-4', email: 'd@customer.example', name: null, provider: 'google' },
      ],
    );

    const status = await getPortalDirectoryStatus(ORG);

    expect(status.mode).toBe('enforce');
    expect(status.sources).toEqual([
      {
        source: 'entra',
        lastRun: expect.objectContaining({ id: 'run-e2', outcome: 'incomplete', reason: 'sync_incomplete', disposition: 'none' }),
        lastEvaluatedRun: expect.objectContaining({ id: 'run-e1', disposition: 'held', holdReason: 'first_enforcement', impactDigest: 'd'.repeat(64) }),
      },
      {
        source: 'google',
        lastRun: expect.objectContaining({ id: 'run-g1' }),
        lastEvaluatedRun: expect.objectContaining({ id: 'run-g1' }),
      },
    ]);
    // RunSummary carries exactly the plan's fields (no chain key, no snapshot key).
    expect(Object.keys(status.sources[0]!.lastEvaluatedRun!).sort()).toEqual([
      'affectedCount', 'createdAt', 'directoryUserCount', 'disposition', 'holdReason', 'id', 'impactDigest', 'outcome', 'reason', 'usableCount',
    ]);

    expect(status.openActions).toEqual([
      expect.objectContaining({ id: 'act-1', runId: 'run-e1', identityId: 'idn-1', portalUserId: 'pu-1', status: 'held', rearmed: false }),
      expect.objectContaining({ id: 'act-2', runId: 'run-g1', provider: 'google', reason: 'suspended', effect: 'identity', keepsPassword: true, status: 'reported', rearmed: false }),
      // the latest run still reports the rearmed person disabled: the action row, flagged
      expect.objectContaining({ id: 'act-3', identityId: 'idn-3', reason: 'account_disabled', status: 'skipped', rearmed: true }),
      // rearmed, with no action on the latest run
      { id: null, runId: null, identityId: 'idn-4', portalUserId: 'pu-4', email: 'd@customer.example', name: null, provider: 'google', reason: null, effect: null, keepsPassword: false, status: null, rearmed: true },
    ]);
    // One system transaction; every read inside it, sequentially.
    expect(h.calls.every((c) => c.depth === 1)).toBe(true);
    expect(h.calls).toHaveLength(6);
  });

  it('status hides runs whose chain names an absorbed org', async () => {
    h.results.push(
      // entra last run: newest names the absorbed org (merged in), the next is ours
      [run({ id: 'run-absorbed', chainKey: ABSORBED_CHAIN }), run({ id: 'run-own', disposition: 'reported' })],
      // entra last evaluated: only the absorbed org's
      [run({ id: 'run-absorbed', chainKey: ABSORBED_CHAIN })],
      [],
      [],
      // no actions read for an absent evaluated run; rearmed identities
      [],
    );

    const status = await getPortalDirectoryStatus(ORG);

    expect(status.sources[0]).toEqual({ source: 'entra', lastRun: expect.objectContaining({ id: 'run-own' }), lastEvaluatedRun: null });
    expect(status.sources[1]).toEqual({ source: 'google', lastRun: null, lastEvaluatedRun: null });
    expect(status.openActions).toEqual([]);
    // No evaluated run of ours ⇒ the action read is skipped (4 run reads + rearmed).
    expect(h.calls).toHaveLength(5);
  });

  it('refuses to run inside a held DB context (routes go through runOutsideDbContext)', async () => {
    h.txDepth.current = 1;
    await expect(getPortalDirectoryStatus(ORG)).rejects.toThrow(/runOutsideDbContext/);
  });
});
