/**
 * #11671 — a finished specialist's result reaches the chat model on the next
 * Wisp turn, from the run rows (durable), once per session.
 *
 * The SQL's own predicates (session, grant, ceiling orgs, settled, 24 h) are
 * pinned against Postgres in wispSpecialistResultsTurn.integration.test.ts;
 * here the reads are table-keyed fakes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const h = vi.hoisted(() => ({
  wispEnabled: vi.fn(() => true),
  aiWorkspaceEnabled: vi.fn(() => true),
  wheres: [] as unknown[],
  resolveGrantCeiling: vi.fn(),
  captureException: vi.fn(),
  rows: {} as Record<string, unknown[]>,
  readFails: null as Error | null,
  sets: new Map<string, Set<string>>(),
  expires: [] as Array<[string, number]>,
  redisFails: false,
  expireFails: false,
  redisAvailable: true,
}));

vi.mock('../../config/env', () => ({ wispEnabled: h.wispEnabled, aiWorkspaceEnabled: h.aiWorkspaceEnabled }));
vi.mock('../sentry', () => ({ captureException: h.captureException }));
vi.mock('./grantAuthority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./grantAuthority')>()),
  resolveGrantCeiling: h.resolveGrantCeiling,
}));
vi.mock('../redis', () => ({
  getRedis: () => (h.redisAvailable ? {
    smembers: async (key: string) => {
      if (h.redisFails) throw new Error('redis down');
      return [...(h.sets.get(key) ?? [])];
    },
    multi: () => {
      const ops: Array<() => void> = [];
      const chain = {
        sadd: (key: string, ...members: string[]) => {
          ops.push(() => {
            const set = h.sets.get(key) ?? new Set<string>();
            for (const m of members) set.add(m);
            h.sets.set(key, set);
          });
          return chain;
        },
        expire: (key: string, seconds: number) => {
          ops.push(() => { h.expires.push([key, seconds]); });
          return chain;
        },
        exec: async () => {
          if (h.redisFails) throw new Error('redis down');
          if (h.expireFails) return [[null, 1], [new Error('EXPIRE refused'), null]];
          for (const op of ops) op();
          return ops.map(() => [null, 1]);
        },
      };
      return chain;
    },
  } : null),
}));
vi.mock('../../db', async () => {
  const { getTableName } = await import('drizzle-orm');
  const select = () => {
    let rows: unknown[] = [];
    const chain: Record<string, unknown> = {};
    for (const m of ['limit', 'orderBy', 'groupBy']) chain[m] = () => chain;
    chain.where = (cond: unknown) => { h.wheres.push(cond); return chain; };
    chain.from = (table: unknown) => {
      rows = h.rows[getTableName(table as Parameters<typeof getTableName>[0])] ?? [];
      return chain;
    };
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      (h.readFails ? Promise.reject(h.readFails) : Promise.resolve(rows)).then(resolve, reject);
    return chain;
  };
  return {
    db: { select },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

import { GrantInactiveError } from './grantAuthority';
import {
  MAX_SPECIALIST_RESULTS_PER_TURN,
  SPECIALIST_DELIVERED_KEY_PREFIX,
  SPECIALIST_DELIVERED_TTL_SECONDS,
  markSpecialistResultsDelivered,
  specialistResultsForTurn,
} from './specialistResultsTurn';

const GRANT = '11111111-1111-4111-8111-111111111111';
const REV = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';
const ORG = '44444444-4444-4444-8444-444444444444';
const KEY = `${SPECIALIST_DELIVERED_KEY_PREFIX}${SESSION}`;
const input = { grantId: GRANT, revisionId: REV, sessionId: SESSION };

const run = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  orgId: ORG,
  status: 'completed',
  profile: 'device_troubleshooting',
  summary: `Summary of ${id}`,
  finishedAt: new Date('2027-02-01T12:00:00Z'),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.wispEnabled.mockReturnValue(true);
  h.aiWorkspaceEnabled.mockReturnValue(true);
  h.wheres = [];
  h.resolveGrantCeiling.mockResolvedValue({ grantId: GRANT, revisionId: REV, orgIds: new Set([ORG]), siteIds: null });
  h.rows = {};
  h.readFails = null;
  h.sets = new Map();
  h.expires = [];
  h.redisFails = false;
  h.expireFails = false;
  h.redisAvailable = true;
});

const OUTCOME = {
  summary: 'Three drivers crash.',
  findings: [{ title: 'nvlddmkm', severity: 'high' as const, detail: '14 BSODs', artifactHandles: [] }],
  artifactHandles: [],
  proposedActions: [],
};
const paramsOf = (cond: unknown) => new PgDialect().sqlToQuery(cond as SQL).params;

describe('specialistResultsForTurn: analysis runs (#11845)', () => {
  it('delivers a settled analysis run with its parsed outcome and only its output files', async () => {
    h.rows.ai_agent_runs = [run('run-a', { profile: 'analysis', outcome: { analysis: OUTCOME } })];
    h.rows.ai_run_artifacts = [
      { runId: 'run-a', handle: 'o1', name: 'out.csv', bytes: '10', contentType: 'text/csv', kind: 'output' },
      { runId: 'run-a', handle: 'c1', name: 'devices.jsonl', bytes: '99', contentType: 'application/jsonl', kind: 'input_capture' },
      { runId: 'run-a', handle: 's1', name: 'step1.py', bytes: '5', contentType: 'text/plain', kind: 'step_script' },
    ];
    const turn = await specialistResultsForTurn(input);
    expect(turn?.results).toEqual([expect.objectContaining({
      runId: 'run-a', profile: 'analysis', analysis: OUTCOME,
      artifacts: [{ handle: 'o1', name: 'out.csv', bytes: 10, contentType: 'text/csv' }],
    })]);
  });

  it('carries chain_depth on a delivered analysis run', async () => {
    h.rows.ai_agent_runs = [run('run-a', { profile: 'analysis', chainDepth: 2, outcome: { analysis: OUTCOME } })];
    const turn = await specialistResultsForTurn(input);
    expect(turn?.results[0]).toMatchObject({ runId: 'run-a', chainDepth: 2 });
  });

  it('does not set chainDepth on a non-analysis run', async () => {
    h.rows.ai_agent_runs = [run('run-t', { chainDepth: 3 })];
    const turn = await specialistResultsForTurn(input);
    expect(turn?.results[0]).not.toHaveProperty('chainDepth');
  });

  it('an outcome that fails the schema becomes null, never a throw', async () => {
    h.rows.ai_agent_runs = [run('run-a', { profile: 'analysis', outcome: { analysis: { summary: 42 } } })];
    expect((await specialistResultsForTurn(input))?.results[0]).toMatchObject({ analysis: null, summary: 'Summary of run-a' });
    // An unreadable outcome is reported (paths only, never values), not silently dropped.
    expect(h.captureException).toHaveBeenCalledTimes(1);
    expect(h.captureException.mock.calls[0]![2]).toMatchObject({ runId: 'run-a', op: 'wisp.analysis_outcome_unreadable' });
    expect(JSON.stringify(h.captureException.mock.calls[0])).not.toContain('42');
  });

  it('an analysis run with no outcome at all (failed, cancelled) has a null analysis', async () => {
    h.rows.ai_agent_runs = [run('run-a', { profile: 'analysis', status: 'failed', outcome: null })];
    expect((await specialistResultsForTurn(input))?.results[0]).toMatchObject({ analysis: null, status: 'failed' });
    // No outcome submitted is the normal failed/cancelled case: nothing to report.
    expect(h.captureException).not.toHaveBeenCalled();
  });

  it('troubleshooting runs keep every artifact kind and carry no analysis key', async () => {
    h.rows.ai_agent_runs = [run('run-t', { outcome: { analysis: OUTCOME } })];
    h.rows.ai_run_artifacts = [{ runId: 'run-t', handle: 'c1', name: 'eventlog.txt', bytes: '7', contentType: 'text/plain', kind: 'input_capture' }];
    const [result] = (await specialistResultsForTurn(input))!.results;
    expect(result!.artifacts).toEqual([{ handle: 'c1', name: 'eventlog.txt', bytes: 7, contentType: 'text/plain' }]);
    expect(result).not.toHaveProperty('analysis');
  });

  it('reads analysis rows only with the workspace on, and still keys on the exact session', async () => {
    h.rows.ai_agent_runs = [];
    await specialistResultsForTurn(input);
    expect(paramsOf(h.wheres[0])).toEqual(expect.arrayContaining([SESSION, GRANT, 'device_troubleshooting', 'analysis']));
    h.aiWorkspaceEnabled.mockReturnValue(false);
    h.wheres = [];
    await specialistResultsForTurn(input);
    const params = paramsOf(h.wheres[0]);
    expect(params).toEqual(expect.arrayContaining([SESSION, GRANT, 'device_troubleshooting']));
    expect(params).not.toContain('analysis');
  });
});

describe('specialistResultsForTurn', () => {
  it('returns a settled run of this session as a result, keyed by run and status', async () => {
    h.rows.ai_agent_runs = [run('run-1')];
    h.rows.ai_run_artifacts = [{ runId: 'run-1', handle: 'art-1', name: 'eventlog.txt', bytes: '2048', contentType: 'text/plain' }];

    const turn = await specialistResultsForTurn(input);

    expect(turn).toEqual({
      results: [{
        runId: 'run-1',
        status: 'completed',
        profile: 'device_troubleshooting',
        summary: 'Summary of run-1',
        artifacts: [{ handle: 'art-1', name: 'eventlog.txt', bytes: 2048, contentType: 'text/plain' }],
      }],
      keys: ['run-1:completed'],
    });
  });

  it('carries the pending step count of a run waiting for approval', async () => {
    h.rows.ai_agent_runs = [run('run-1', { status: 'awaiting_approval' })];
    h.rows.action_intents = [{ runId: 'run-1', n: 2 }];
    const turn = await specialistResultsForTurn(input);
    expect(turn?.results[0]).toMatchObject({ status: 'awaiting_approval', pendingIntentCount: 2 });
    expect(turn?.keys).toEqual(['run-1:awaiting_approval']);
  });

  it('says cancelled for a cancelled run', async () => {
    h.rows.ai_agent_runs = [run('run-1', { status: 'cancelled' })];
    const turn = await specialistResultsForTurn(input);
    expect(turn?.results[0]?.status).toBe('cancelled');
  });

  it('skips a result this session was already given, and gives a later status of the same run once', async () => {
    h.sets.set(KEY, new Set(['run-1:awaiting_approval', 'run-2:completed']));
    h.rows.ai_agent_runs = [run('run-1', { status: 'completed' }), run('run-2')];
    const turn = await specialistResultsForTurn(input);
    expect(turn?.results.map((r) => r.runId)).toEqual(['run-1']);
    expect(turn?.keys).toEqual(['run-1:completed']);
  });

  it('returns null when every result was already given', async () => {
    h.sets.set(KEY, new Set(['run-1:completed']));
    h.rows.ai_agent_runs = [run('run-1')];
    expect(await specialistResultsForTurn(input)).toBeNull();
  });

  it('gives at most the newest few per turn, oldest first; the rest wait for the next turn', async () => {
    // Read newest first, as the query orders them.
    const ids = Array.from({ length: MAX_SPECIALIST_RESULTS_PER_TURN + 2 }, (_, i) => `run-${MAX_SPECIALIST_RESULTS_PER_TURN + 2 - i}`);
    h.rows.ai_agent_runs = ids.map((id) => run(id));
    const first = await specialistResultsForTurn(input);
    expect(first?.results).toHaveLength(MAX_SPECIALIST_RESULTS_PER_TURN);
    expect(first?.results[0]?.runId).toBe('run-3');
    expect(first?.results.at(-1)?.runId).toBe(`run-${MAX_SPECIALIST_RESULTS_PER_TURN + 2}`);

    await markSpecialistResultsDelivered(SESSION, first!.keys);
    const second = await specialistResultsForTurn(input);
    expect(second?.results.map((r) => r.runId)).toEqual(['run-1', 'run-2']);
  });

  it('returns null with Wisp off, and reads nothing', async () => {
    h.wispEnabled.mockReturnValue(false);
    h.rows.ai_agent_runs = [run('run-1')];
    expect(await specialistResultsForTurn(input)).toBeNull();
    expect(h.resolveGrantCeiling).not.toHaveBeenCalled();
  });

  it('returns null for an inactive grant, and reports only a corrupt pin', async () => {
    h.rows.ai_agent_runs = [run('run-1')];
    h.resolveGrantCeiling.mockRejectedValueOnce(new GrantInactiveError(GRANT, 'paused', 'paused', 'paused'));
    expect(await specialistResultsForTurn(input)).toBeNull();
    expect(h.captureException).not.toHaveBeenCalled();
  });

  it('returns null for an empty ceiling without querying', async () => {
    h.resolveGrantCeiling.mockResolvedValueOnce({ grantId: GRANT, revisionId: REV, orgIds: new Set(), siteIds: null });
    h.readFails = new Error('must not query');
    expect(await specialistResultsForTurn(input)).toBeNull();
    expect(h.captureException).not.toHaveBeenCalled();
  });

  it('a failed read reports and returns null; nothing is marked, so the next turn tries again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.readFails = new Error('db down');
    expect(await specialistResultsForTurn(input)).toBeNull();
    expect(h.captureException).toHaveBeenCalledTimes(1);
    expect(h.sets.size).toBe(0);
    warn.mockRestore();
  });

  it('with Redis unreadable, still gives the result (a repeat beats a loss)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.redisFails = true;
    h.rows.ai_agent_runs = [run('run-1')];
    expect((await specialistResultsForTurn(input))?.keys).toEqual(['run-1:completed']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('with no Redis configured, still gives the result', async () => {
    h.redisAvailable = false;
    h.rows.ai_agent_runs = [run('run-1')];
    expect((await specialistResultsForTurn(input))?.keys).toEqual(['run-1:completed']);
  });
});

describe('markSpecialistResultsDelivered', () => {
  it('records the keys on the session with a TTL past the session lifetime', async () => {
    await markSpecialistResultsDelivered(SESSION, ['run-1:completed']);
    expect([...(h.sets.get(KEY) ?? [])]).toEqual(['run-1:completed']);
    expect(h.expires).toEqual([[KEY, SPECIALIST_DELIVERED_TTL_SECONDS]]);
    expect(SPECIALIST_DELIVERED_TTL_SECONDS).toBeGreaterThan(24 * 60 * 60);
  });

  it('does nothing for no keys', async () => {
    await markSpecialistResultsDelivered(SESSION, []);
    expect(h.sets.size).toBe(0);
  });

  it('logs a command the MULTI reports as failed (the TTL), never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.expireFails = true;
    await expect(markSpecialistResultsDelivered(SESSION, ['run-1:completed'])).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to record them as delivered'), expect.objectContaining({ error: 'EXPIRE refused' }));
    warn.mockRestore();
  });

  it('never throws on a Redis failure (the result is given again next turn)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.redisFails = true;
    await expect(markSpecialistResultsDelivered(SESSION, ['run-1:completed'])).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
