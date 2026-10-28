import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// #7207 — a provider that yields its window in time slices is persisted and
// checkpointed per slice, so a failure mid-run keeps every completed slice and
// the next run resumes from the last one instead of retrying (and losing) the
// whole window. Same depth-tracking DB mock as dnsSyncJob.dbcontext.test.ts:
// each slice fetch must run with no DB context held, each persist inside one.
// ---------------------------------------------------------------------------

let contextDepth = 0;
const fetchDepths: number[] = [];
const dbCallDepths: number[] = [];
let selectResults: unknown[][] = [];
const updatePayloads: Array<{ depth: number; payload: Record<string, unknown> }> = [];
const insertedBatches: Array<Array<Record<string, unknown>>> = [];

function chain(result: unknown, onValues?: (rows: Array<Record<string, unknown>>) => void) {
  const c: Record<string, unknown> = {};
  for (const m of [
    'from', 'where', 'limit', 'returning',
    'onConflictDoNothing', 'onConflictDoUpdate', 'innerJoin', 'leftJoin',
  ]) {
    c[m] = vi.fn(() => c);
  }
  c.values = vi.fn((rows: Array<Record<string, unknown>>) => {
    onValues?.(rows);
    return c;
  });
  c.set = vi.fn((payload: Record<string, unknown>) => {
    updatePayloads.push({ depth: contextDepth, payload });
    return c;
  });
  (c as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return c;
}

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => {
      dbCallDepths.push(contextDepth);
      return chain(selectResults.shift() ?? []);
    }),
    insert: vi.fn(() => {
      dbCallDepths.push(contextDepth);
      return chain([], (rows) => insertedBatches.push(rows));
    }),
    update: vi.fn(() => {
      dbCallDepths.push(contextDepth);
      return chain(undefined);
    }),
    delete: vi.fn(() => {
      dbCallDepths.push(contextDepth);
      return chain(undefined);
    }),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    contextDepth += 1;
    try {
      return await fn();
    } finally {
      contextDepth -= 1;
    }
  }),
  runOutsideDbContext: vi.fn((fn: () => unknown) => {
    const saved = contextDepth;
    contextDepth = 0;
    try {
      return fn();
    } finally {
      contextDepth = saved;
    }
  }),
}));

const createDnsProviderMock = vi.fn();
vi.mock('../services/dnsProviders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/dnsProviders')>();
  return { ...actual, createDnsProvider: createDnsProviderMock };
});

vi.mock('../services/secretCrypto', () => ({
  decryptForColumn: (_t: string, _c: string, value: unknown) => value ?? 'decrypted',
}));

vi.mock('../services/eventBus', () => ({
  publishEvent: vi.fn().mockResolvedValue(undefined),
  EVENT_TYPES: { DNS_THREAT_BLOCKED: 'dns.threat.blocked' },
}));

vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

const { processSyncIntegration } = await import('./dnsSyncJob');

const LAST_SYNC = new Date('2026-08-01T00:00:00.000Z');
const SLICE_1_END = new Date('2026-08-01T06:00:00.000Z');
const SLICE_2_END = new Date('2026-08-01T12:00:00.000Z');

function integrationRow() {
  return {
    id: 'int-1', orgId: 'org-1', provider: 'umbrella', apiKey: 'k', apiSecret: 's',
    isActive: true, config: {}, lastSync: LAST_SYNC,
  };
}

function event(domain: string, at: Date) {
  return { timestamp: at, domain, queryType: 'A', action: 'allowed' as const };
}

function successWrites() {
  return updatePayloads.filter((u) => u.payload.lastSyncStatus === 'success');
}

describe('dnsSyncJob — per-slice persistence and checkpointing (#7207)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contextDepth = 0;
    fetchDepths.length = 0;
    dbCallDepths.length = 0;
    selectResults = [];
    updatePayloads.length = 0;
    insertedBatches.length = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('persists and advances lastSync per completed slice, keeping them when a later slice fails', async () => {
    // Phase 1 integration read, then one mapDevicesByIp read per persisted slice.
    selectResults = [[integrationRow()], [], []];
    const boom = new Error('HTTP 503 mid-run');
    let requestedSince: Date | undefined;
    async function* syncEventSlices(since: Date) {
      requestedSince = since;
      fetchDepths.push(contextDepth);
      yield { events: [event('one.example', new Date('2026-08-01T01:00:00.000Z'))], until: SLICE_1_END };
      fetchDepths.push(contextDepth);
      yield { events: [event('two.example', new Date('2026-08-01T07:00:00.000Z'))], until: SLICE_2_END };
      fetchDepths.push(contextDepth);
      throw boom;
    }
    const syncEvents = vi.fn();
    createDnsProviderMock.mockReturnValue({ syncEvents, syncEventSlices });

    await expect(
      processSyncIntegration({ type: 'sync-integration', integrationId: 'int-1' }),
    ).rejects.toBe(boom);

    // The existing one-minute overlap is preserved (dedupe covers it).
    expect(requestedSince?.getTime()).toBe(LAST_SYNC.getTime() - 60_000);
    // The sliced path replaces the all-at-once fetch.
    expect(syncEvents).not.toHaveBeenCalled();
    // Both completed slices landed, in order, each checkpointing lastSync.
    expect(insertedBatches.flat().map((row) => row.domain)).toEqual(['one.example', 'two.example']);
    expect(successWrites().map((u) => (u.payload.lastSync as Date).getTime())).toEqual([
      SLICE_1_END.getTime(),
      SLICE_2_END.getTime(),
    ]);
    // ...then the failure is still recorded, without touching lastSync.
    const errorWrite = updatePayloads.find((u) => u.payload.lastSyncStatus === 'error');
    expect(errorWrite).toBeDefined();
    expect(errorWrite!.payload).not.toHaveProperty('lastSync');

    // Every slice fetch ran with no DB context held; every DB call inside one.
    expect(fetchDepths).toEqual([0, 0, 0]);
    for (const depth of dbCallDepths) expect(depth).toBeGreaterThan(0);
    for (const write of successWrites()) expect(write.depth).toBeGreaterThan(0);
  });

  it('reports fetched/inserted totals across all slices on success', async () => {
    selectResults = [[integrationRow()], [], []];
    async function* syncEventSlices() {
      yield { events: [event('one.example', new Date('2026-08-01T01:00:00.000Z'))], until: SLICE_1_END };
      yield {
        events: [
          event('two.example', new Date('2026-08-01T07:00:00.000Z')),
          event('three.example', new Date('2026-08-01T08:00:00.000Z')),
        ],
        until: SLICE_2_END,
      };
    }
    createDnsProviderMock.mockReturnValue({ syncEvents: vi.fn(), syncEventSlices });

    const result = await processSyncIntegration({ type: 'sync-integration', integrationId: 'int-1' });

    expect(result.fetched).toBe(3);
    expect(successWrites()).toHaveLength(2);
    expect((successWrites()[1]!.payload.lastSync as Date).getTime()).toBe(SLICE_2_END.getTime());
  });

  // #10018 — a walk that ran out of its request budget used to write nothing,
  // so the row kept its previous `success` while lastSync sat still for days.
  describe('a walk that stops short at the request budget (#10018)', () => {
    function partialWrites() {
      return updatePayloads.filter((u) => u.payload.lastSyncStatus === 'partial');
    }

    it('records partial with the unfetched range, without moving lastSync past the last slice', async () => {
      selectResults = [[integrationRow()], []];
      let requestedUntil: Date | undefined;
      async function* syncEventSlices(_since: Date, until: Date) {
        requestedUntil = until;
        yield { events: [event('one.example', new Date('2026-08-01T01:00:00.000Z'))], until: SLICE_1_END };
        return { stoppedShort: { from: SLICE_1_END, to: until }, sliceWidthMs: 6 * 60 * 60 * 1000 };
      }
      createDnsProviderMock.mockReturnValue({ syncEvents: vi.fn(), syncEventSlices });

      const result = await processSyncIntegration({ type: 'sync-integration', integrationId: 'int-1' });

      expect(result.fetched).toBe(1);
      // The completed slice still checkpoints...
      expect(successWrites().map((u) => (u.payload.lastSync as Date).getTime())).toEqual([SLICE_1_END.getTime()]);
      // ...and the run is then recorded as partial, naming what is left.
      expect(partialWrites()).toHaveLength(1);
      const partial = partialWrites()[0]!;
      expect(partial.depth).toBeGreaterThan(0);
      expect(partial.payload).not.toHaveProperty('lastSync');
      expect(partial.payload.lastSyncError).toBe(
        `Reached the per-run request budget; ${SLICE_1_END.toISOString()}..${requestedUntil!.toISOString()} ` +
        'not yet fetched, resumes next run'
      );
      // The partial write is the LAST status write, so it is what the row shows.
      const statusWrites = updatePayloads.filter((u) => 'lastSyncStatus' in u.payload);
      expect(statusWrites[statusWrites.length - 1]!.payload.lastSyncStatus).toBe('partial');
    });

    it('records partial even when the budget ran out before any slice completed', async () => {
      selectResults = [[integrationRow()]];
      async function* syncEventSlices(since: Date, until: Date) {
        return { stoppedShort: { from: since, to: until }, sliceWidthMs: 60_000 };
      }
      createDnsProviderMock.mockReturnValue({ syncEvents: vi.fn(), syncEventSlices });

      await processSyncIntegration({ type: 'sync-integration', integrationId: 'int-1' });

      expect(successWrites()).toEqual([]);
      expect(partialWrites()).toHaveLength(1);
      expect(updatePayloads.some((u) => 'lastSync' in u.payload)).toBe(false);
      expect(String(partialWrites()[0]!.payload.lastSyncError)).toMatch(/request budget/);
    });

    it('passes the remembered slice width to the provider and stores the width the walk ended on', async () => {
      selectResults = [[{ ...integrationRow(), config: { syncSliceWidthMs: 1_800_000 } }], []];
      let options: unknown;
      async function* syncEventSlices(_since: Date, _until: Date, opts?: unknown) {
        options = opts;
        yield { events: [], until: SLICE_1_END };
        return { sliceWidthMs: 900_000 };
      }
      createDnsProviderMock.mockReturnValue({ syncEvents: vi.fn(), syncEventSlices });

      await processSyncIntegration({ type: 'sync-integration', integrationId: 'int-1' });

      expect(options).toEqual({ initialSliceMs: 1_800_000 });
      const configWrites = updatePayloads.filter((u) => 'config' in u.payload);
      expect(configWrites).toHaveLength(1);
      expect(configWrites[0]!.depth).toBeGreaterThan(0);
      // A MERGE into the existing config under the key the next run reads —
      // never a replacement that would wipe the tenant's settings.
      const query = new PgDialect().sqlToQuery(configWrites[0]!.payload.config as SQL);
      expect(query.sql).toBe(
        `"dns_filter_integrations"."config" || jsonb_build_object('syncSliceWidthMs', $1::bigint)`
      );
      expect(query.params).toEqual([900_000]);
      // A walk that reached `until` is not partial: the slice's success stands.
      expect(partialWrites()).toEqual([]);
      expect(configWrites[0]!.payload).not.toHaveProperty('lastSyncStatus');
    });

    it.each([
      ['an unchanged width', 900_000],
      ['no width', undefined],
    ])('records partial when the walk stops short with %s, without touching config', async (_label, sliceWidthMs) => {
      selectResults = [[{ ...integrationRow(), config: { syncSliceWidthMs: 900_000 } }], []];
      async function* syncEventSlices(_since: Date, until: Date) {
        yield { events: [], until: SLICE_1_END };
        return { stoppedShort: { from: SLICE_1_END, to: until }, sliceWidthMs };
      }
      createDnsProviderMock.mockReturnValue({ syncEvents: vi.fn(), syncEventSlices });

      await processSyncIntegration({ type: 'sync-integration', integrationId: 'int-1' });

      expect(partialWrites()).toHaveLength(1);
      expect(partialWrites()[0]!.payload).not.toHaveProperty('config');
    });

    it('writes nothing extra when the walk completes at the width already stored', async () => {
      selectResults = [[{ ...integrationRow(), config: { syncSliceWidthMs: 900_000 } }], []];
      async function* syncEventSlices() {
        yield { events: [], until: SLICE_1_END };
        return { sliceWidthMs: 900_000 };
      }
      createDnsProviderMock.mockReturnValue({ syncEvents: vi.fn(), syncEventSlices });

      await processSyncIntegration({ type: 'sync-integration', integrationId: 'int-1' });

      expect(updatePayloads).toHaveLength(1);
      expect(updatePayloads[0]!.payload.lastSyncStatus).toBe('success');
    });
  });

  describe('a slice the provider could only partly fetch (#10047)', () => {
    const BURST_FROM = new Date('2026-08-01T03:00:00.000Z');
    const BURST_TO = new Date('2026-08-01T03:00:01.000Z');

    function truncatedWrites() {
      return updatePayloads.filter((u) => u.payload.lastSyncStatus === 'truncated');
    }

    function lastStatusWrite() {
      const statusWrites = updatePayloads.filter((u) => 'lastSyncStatus' in u.payload);
      return statusWrites[statusWrites.length - 1]!;
    }

    it('records truncated, naming the window that lost records, after the slices checkpoint', async () => {
      selectResults = [[integrationRow()], [], []];
      async function* syncEventSlices() {
        yield {
          events: [event('burst.example', BURST_FROM)],
          until: BURST_TO,
          truncated: { from: BURST_FROM, to: BURST_TO, reachableRecords: 11_000 },
        };
        yield { events: [], until: SLICE_2_END };
        // No walk-end value: truncation must not depend on one.
      }
      createDnsProviderMock.mockReturnValue({ syncEvents: vi.fn(), syncEventSlices });

      await processSyncIntegration({ type: 'sync-integration', integrationId: 'int-1' });

      // Both slices still checkpoint — what was fetched is kept, the walk moves on.
      expect(successWrites().map((u) => (u.payload.lastSync as Date).getTime()))
        .toEqual([BURST_TO.getTime(), SLICE_2_END.getTime()]);
      // ...and the run then ends as truncated, not as a clean success.
      expect(truncatedWrites()).toHaveLength(1);
      const write = truncatedWrites()[0]!;
      expect(write.depth).toBeGreaterThan(0);
      expect(write.payload).not.toHaveProperty('lastSync');
      expect(write.payload.lastSyncError).toBe(
        '1 window held more records than the provider lets a sync page through; records past that ' +
        `limit were not fetched and will not be retried: ${BURST_FROM.toISOString()}..${BURST_TO.toISOString()} ` +
        '(11000 fetched)'
      );
      expect(lastStatusWrite().payload.lastSyncStatus).toBe('truncated');
    });

    it('keeps the truncation visible when the same run also stops short at the request budget', async () => {
      selectResults = [[integrationRow()], []];
      let requestedUntil: Date | undefined;
      async function* syncEventSlices(_since: Date, until: Date) {
        requestedUntil = until;
        yield {
          events: [],
          until: BURST_TO,
          truncated: { from: BURST_FROM, to: BURST_TO, reachableRecords: 10_400 },
        };
        return { stoppedShort: { from: BURST_TO, to: until } };
      }
      createDnsProviderMock.mockReturnValue({ syncEvents: vi.fn(), syncEventSlices });

      await processSyncIntegration({ type: 'sync-integration', integrationId: 'int-1' });

      // Data loss outranks "catching up": the row says truncated, and the
      // message carries both facts.
      expect(updatePayloads.filter((u) => u.payload.lastSyncStatus === 'partial')).toEqual([]);
      expect(truncatedWrites()).toHaveLength(1);
      const message = String(truncatedWrites()[0]!.payload.lastSyncError);
      expect(message).toContain(`${BURST_FROM.toISOString()}..${BURST_TO.toISOString()} (10400 fetched)`);
      expect(message).toContain(
        `Reached the per-run request budget; ${BURST_TO.toISOString()}..${requestedUntil!.toISOString()} ` +
        'not yet fetched, resumes next run'
      );
      expect(lastStatusWrite().payload.lastSyncStatus).toBe('truncated');
    });

    it('counts every truncated window but lists only the first few', async () => {
      selectResults = [[integrationRow()]];
      const windows = Array.from({ length: 5 }, (_, i) => {
        const from = new Date(BURST_FROM.getTime() + i * 60_000);
        return { from, to: new Date(from.getTime() + 1000), reachableRecords: 10_001 + i };
      });
      async function* syncEventSlices() {
        for (const w of windows) yield { events: [], until: w.to, truncated: w };
        return {};
      }
      createDnsProviderMock.mockReturnValue({ syncEvents: vi.fn(), syncEventSlices });

      await processSyncIntegration({ type: 'sync-integration', integrationId: 'int-1' });

      const message = String(truncatedWrites()[0]!.payload.lastSyncError);
      expect(message).toMatch(/^5 windows held more records/);
      for (const w of windows.slice(0, 3)) expect(message).toContain(`${w.from.toISOString()}..`);
      expect(message).not.toContain(`${windows[3]!.from.toISOString()}..`);
      expect(message).toMatch(/, and 2 more$/);
    });

    it('names the truncation in the recorded error when a later slice fails the run', async () => {
      selectResults = [[integrationRow()], []];
      async function* syncEventSlices() {
        yield {
          events: [],
          until: BURST_TO,
          truncated: { from: BURST_FROM, to: BURST_TO, reachableRecords: 11_000 },
        };
        throw new Error('HTTP 503 Service Unavailable');
      }
      createDnsProviderMock.mockReturnValue({ syncEvents: vi.fn(), syncEventSlices });

      await expect(
        processSyncIntegration({ type: 'sync-integration', integrationId: 'int-1' }),
      ).rejects.toThrow('HTTP 503');

      // The truncated slice was checkpointed, so the next run starts past it:
      // the error this run records is the only place the loss can be named.
      expect(truncatedWrites()).toEqual([]);
      const errorWrite = lastStatusWrite();
      expect(errorWrite.payload.lastSyncStatus).toBe('error');
      expect(errorWrite.payload.lastSyncError).toBe(
        'HTTP 503 Service Unavailable. Earlier in this run: 1 window held more records than the provider ' +
        'lets a sync page through; records past that limit were not fetched and will not be retried: ' +
        `${BURST_FROM.toISOString()}..${BURST_TO.toISOString()} (11000 fetched)`
      );
    });

    it('leaves a run with no truncated slice as a plain success', async () => {
      selectResults = [[integrationRow()], []];
      async function* syncEventSlices() {
        yield { events: [], until: SLICE_1_END };
      }
      createDnsProviderMock.mockReturnValue({ syncEvents: vi.fn(), syncEventSlices });

      await processSyncIntegration({ type: 'sync-integration', integrationId: 'int-1' });

      expect(truncatedWrites()).toEqual([]);
      expect(updatePayloads).toHaveLength(1);
      expect(updatePayloads[0]!.payload.lastSyncStatus).toBe('success');
    });
  });

  it('releases the provider session even when a slice fails', async () => {
    selectResults = [[integrationRow()], []];
    const dispose = vi.fn(async () => {});
    async function* syncEventSlices() {
      yield { events: [], until: SLICE_1_END };
      throw new Error('boom');
    }
    createDnsProviderMock.mockReturnValue({ syncEvents: vi.fn(), syncEventSlices, dispose });

    await expect(
      processSyncIntegration({ type: 'sync-integration', integrationId: 'int-1' }),
    ).rejects.toThrow('boom');
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('a throwing dispose does not mask the error that failed the sync', async () => {
    selectResults = [[integrationRow()], []];
    const boom = new Error('slice fetch failed');
    async function* syncEventSlices() {
      yield { events: [], until: SLICE_1_END };
      throw boom;
    }
    createDnsProviderMock.mockReturnValue({
      syncEvents: vi.fn(),
      syncEventSlices,
      dispose: vi.fn(async () => { throw new Error('dispose exploded'); }),
    });

    await expect(
      processSyncIntegration({ type: 'sync-integration', integrationId: 'int-1' }),
    ).rejects.toBe(boom);
  });
});
