import { beforeEach, describe, expect, it, vi } from 'vitest';

const { calls, state } = vi.hoisted(() => ({
  calls: [] as Array<{ op: string; detail?: unknown }>,
  state: { insertError: null as Error | null, updateRows: [] as Array<Array<{ id: string }>>, inTx: 0 },
}));

vi.mock('../db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(async (rows: unknown) => {
        calls.push({ op: 'insert', detail: { rows, inTx: state.inTx } });
        if (state.insertError) throw state.insertError;
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: unknown) => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => {
            calls.push({ op: 'update', detail: { values, inTx: state.inTx } });
            return state.updateRows.shift() ?? [];
          }),
        })),
      })),
    })),
  },
  withDbAccessContext: vi.fn(async (ctx: unknown, fn: () => unknown) => {
    calls.push({ op: 'context', detail: ctx });
    return fn();
  }),
  withDbTransaction: vi.fn(async (fn: () => unknown) => {
    calls.push({ op: 'tx:start' });
    state.inTx++;
    try {
      return await fn();
    } finally {
      state.inTx--;
      calls.push({ op: 'tx:end' });
    }
  }),
}));

import { persistTurnDiscovery, type TurnDiscoveryWrite } from './aiToolDiscoveryLedger';
import { DISCOVERY_QUERY_MAX_BYTES, type DiscoverySearchEvent } from './aiToolDiscoveryObserver';
import { metricsRegistry } from './metricsRegistry';
import { redactAiToolOutputText } from './aiToolOutput';

const SESSION = '00000000-0000-4000-8000-000000000001';
const ORG = '00000000-0000-4000-8000-000000000002';
const TURN_MSG = '00000000-0000-4000-8000-000000000003';

function event(overrides: Partial<DiscoverySearchEvent> = {}): DiscoverySearchEvent {
  return {
    toolUseId: 'toolu_s1', roundTripId: 'msg_1', query: 'restart a service', maxResults: 5, selectMode: false,
    resultToolNames: ['manage_services'], calledToolNames: ['manage_services'], totalDeferred: null, empty: false,
    ...overrides,
  };
}

function write(overrides: Partial<TurnDiscoveryWrite> = {}): TurnDiscoveryWrite {
  return {
    sessionId: SESSION, orgId: ORG, turnMessageId: TURN_MSG, surface: 'chat', surfaceFingerprint: 'abcdef0123456789',
    events: [event()],
    turn: { searches: 1, searchOnlyRoundTrips: 1, workRoundTrips: 1, firstCallAfterSearches: 1, aborted: false },
    reconcile: new Map(),
    ...overrides,
  };
}

function insertedRows(): Array<Record<string, unknown>> {
  const insert = calls.find((c) => c.op === 'insert');
  return ((insert?.detail as { rows: Array<Record<string, unknown>> } | undefined)?.rows) ?? [];
}

async function searchCount(outcome: 'hit' | 'empty'): Promise<number> {
  const metric = metricsRegistry.getSingleMetric('breeze_ai_tool_search_total');
  const values = metric ? (await metric.get()).values : [];
  return values.find((v) => v.labels.outcome === outcome)?.value ?? 0;
}

beforeEach(() => {
  calls.length = 0;
  state.insertError = null;
  state.updateRows = [];
  state.inTx = 0;
  metricsRegistry.resetMetrics();
});

describe('persistTurnDiscovery (#12421 W01)', () => {
  it('writes one turn row plus one row per search in an org context and one transaction', async () => {
    const outcome = await persistTurnDiscovery(write({ events: [event(), event({ toolUseId: 'toolu_s2', empty: true, resultToolNames: [], calledToolNames: [] })] }));
    expect(outcome).toEqual({ ok: true, rows: 3, reconciled: 0 });
    expect(calls[0]).toEqual({ op: 'context', detail: { scope: 'organization', orgId: ORG, accessibleOrgIds: [ORG] } });
    expect(calls.map((c) => c.op)).toEqual(['context', 'tx:start', 'insert', 'tx:end']);
    const rows = insertedRows();
    expect(rows.map((r) => r.kind)).toEqual(['search', 'search', 'turn']);
    expect(rows[0]).toMatchObject({
      sessionId: SESSION, turnMessageId: TURN_MSG, kind: 'search', toolUseId: 'toolu_s1', roundTripId: 'msg_1',
      surface: 'chat', surfaceFingerprint: 'abcdef0123456789', query: 'restart a service', maxResults: 5,
      selectMode: false, resultToolNames: ['manage_services'], calledToolNames: ['manage_services'], totalDeferred: null, empty: false,
    });
    expect(rows[2]).toMatchObject({
      sessionId: SESSION, turnMessageId: TURN_MSG, kind: 'turn', searches: 1, searchOnlyRoundTrips: 1,
      workRoundTrips: 1, firstCallAfterSearches: 1, aborted: false,
    });
    expect(rows[2]!.query).toBeUndefined();
  });

  it('a zero-search turn still writes its turn row', async () => {
    const outcome = await persistTurnDiscovery(write({ events: [], turn: { searches: 0, searchOnlyRoundTrips: 0, workRoundTrips: 1, firstCallAfterSearches: 0, aborted: false } }));
    expect(outcome).toEqual({ ok: true, rows: 1, reconciled: 0 });
    expect(insertedRows().map((r) => r.kind)).toEqual(['turn']);
  });

  it('returns { ok: false } and does not throw when the insert rejects', async () => {
    // The shape Drizzle throws: the statement and its parameters ride on the error.
    class DrizzleQueryError extends Error {
      constructor(public query: string, public params: unknown[]) { super(`Failed query: ${query}\nparams: ${params.join(',')}`); }
    }
    state.insertError = new DrizzleQueryError('insert into "ai_tool_search_events" values ($1)', ['secret customer words']);
    const outcome = await persistTurnDiscovery(write());
    expect(outcome.ok).toBe(false);
    // safeErrorMessage keeps the query's parameters out of the returned text.
    expect((outcome as { error: string }).error).not.toContain('secret customer words');
  });

  it('stores redacted query text (a bearer token in the query is replaced)', async () => {
    const token = 'abcdefghijklmnopqrstuvwxyz0123456789ABCD';
    await persistTurnDiscovery(write({ events: [event({ query: `Authorization: Bearer ${token} restart spooler` })] }));
    const stored = insertedRows()[0]!.query as string;
    expect(stored).not.toContain(token);
    expect(stored).toContain('restart spooler');
  });

  it('redaction runs before the bound: a query whose redaction grows past 1,024 B is still ≤ 1,024 B, and a token straddling the cut is redacted whole', async () => {
    const token = 'sk-ant-api03-' + 'Z'.repeat(60);
    // Place the token so it straddles the 1,024-byte cut.
    // 995 bytes: the 1,010-byte budget before the marker keeps only 'sk-ant-api03-ZZ',
    // too short for the redactor's 16-char vendor-token body.
    const prefix = `${'a '.repeat(497)} `;
    const query = `${prefix}${token} tail`;
    expect(Buffer.byteLength(prefix)).toBeLessThan(DISCOVERY_QUERY_MAX_BYTES);
    expect(Buffer.byteLength(prefix + token)).toBeGreaterThan(DISCOVERY_QUERY_MAX_BYTES);
    // Precondition: the redactor recognises the whole token.
    expect(redactAiToolOutputText(token)).not.toContain('Z'.repeat(20));

    await persistTurnDiscovery(write({ events: [event({ query })] }));
    const stored = insertedRows()[0]!.query as string;
    expect(Buffer.byteLength(stored)).toBeLessThanOrEqual(DISCOVERY_QUERY_MAX_BYTES);
    expect(stored).not.toContain('sk-ant-api03-');

    // Control: bound-then-redact leaves the token's head in place.
    const { boundQuery } = await import('./aiToolDiscoveryObserver');
    const wrongOrder = redactAiToolOutputText(boundQuery(query));
    expect(wrongOrder).toContain('sk-ant-api03-ZZ');

    // Growth: many short secrets whose redaction marker is longer than the secret.
    const grown = Array.from({ length: 200 }, () => 'password=hunter2').join(' ');
    await persistTurnDiscovery(write({ events: [event({ query: grown })] }));
    const rows = calls.filter((c) => c.op === 'insert').at(-1)!.detail as { rows: Array<{ query: string }> };
    expect(Buffer.byteLength(rows.rows[0]!.query)).toBeLessThanOrEqual(DISCOVERY_QUERY_MAX_BYTES);
  });

  it('reconcile issues one UPDATE per entry, sequentially, inside the same transaction, and counts the rows that changed', async () => {
    state.updateRows = [[{ id: 'exec-1' }], [], [{ id: 'exec-3' }]];
    const reconcile = new Map([
      ['toolu_c1', 'searched_this_turn' as const],
      ['toolu_c2', 'always_loaded' as const],
      ['toolu_c3', 'loaded_earlier' as const],
    ]);
    const outcome = await persistTurnDiscovery(write({ reconcile }));
    expect(outcome).toEqual({ ok: true, rows: 2, reconciled: 2 });
    expect(calls.map((c) => c.op)).toEqual(['context', 'tx:start', 'insert', 'update', 'update', 'update', 'tx:end']);
    const updates = calls.filter((c) => c.op === 'update').map((c) => c.detail as { values: unknown; inTx: number });
    expect(updates.map((u) => u.values)).toEqual([
      { discovery: 'searched_this_turn' },
      { discovery: 'always_loaded' },
      { discovery: 'loaded_earlier' },
    ]);
    expect(updates.every((u) => u.inTx === 1)).toBe(true);
  });

  it('increments breeze_ai_tool_search_total once per event, even when the insert rejects', async () => {
    state.insertError = new Error('db down');
    await persistTurnDiscovery(write({ events: [event(), event({ toolUseId: 'toolu_s2', empty: true, resultToolNames: [] })] }));
    expect(await searchCount('hit')).toBe(1);
    expect(await searchCount('empty')).toBe(1);
  });
});
