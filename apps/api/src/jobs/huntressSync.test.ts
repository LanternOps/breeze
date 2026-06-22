import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// #1697 — the Huntress sync must NOT hold a pooled DB connection in an open
// transaction across its external HTTP fetch. We model the DB-context depth
// with a counter that withSystemDbAccessContext increments and
// runOutsideDbContext zeroes, then assert the HuntressClient calls were issued
// at depth 0 while the DB reads/writes ran at depth > 0.
// ---------------------------------------------------------------------------

let contextDepth = 0;
const fetchDepths: number[] = [];
const dbCallDepths: number[] = [];
// `.set(payload)` calls (update writes) with the context depth at call time, so
// tests can assert e.g. the error-status write happened inside a context.
const updatePayloads: Array<{ depth: number; payload: Record<string, unknown> }> = [];

// Chainable, awaitable stub for a drizzle query builder. Every builder method
// returns the same chain; awaiting it resolves to `result`.
function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'limit', 'values', 'onConflictDoUpdate']) {
    c[m] = vi.fn(() => c);
  }
  c.set = vi.fn((payload: Record<string, unknown>) => {
    updatePayloads.push({ depth: contextDepth, payload });
    return c;
  });
  (c as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return c;
}

const INTEGRATION_ROW = {
  id: 'integration-1',
  partnerId: 'partner-1',
  accountId: 'acct-1',
  apiBaseUrl: 'https://api.huntress.example',
  apiKeyEncrypted: 'enc',
  isActive: true,
  lastSyncAt: null,
};

vi.mock('../db', () => ({
  db: {
    // `.select()` with no projection = Phase 1 integration read; with a
    // projection arg = loadMappedOrgIds. Distinguish so each returns the right
    // shape. Both record the context depth at call time.
    select: vi.fn((projection?: unknown) => {
      dbCallDepths.push(contextDepth);
      return chain(projection === undefined ? [INTEGRATION_ROW] : []);
    }),
    update: vi.fn(() => {
      dbCallDepths.push(contextDepth);
      return chain(undefined);
    }),
    insert: vi.fn(() => {
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
  // Mirrors AsyncLocalStorage.exit: store disabled for the synchronous call (and
  // the async work it kicks off). The fetch promises are created synchronously
  // inside `fn`, so the client methods are invoked while depth is 0.
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

const listOrganizations = vi.fn(async () => {
  fetchDepths.push(contextDepth);
  return [];
});
const listAgents = vi.fn(async () => {
  fetchDepths.push(contextDepth);
  return [];
});
const listIncidents = vi.fn(async () => {
  fetchDepths.push(contextDepth);
  return [];
});

vi.mock('../services/huntressClient', () => ({
  HuntressClient: class {
    listOrganizations = listOrganizations;
    listAgents = listAgents;
    listIncidents = listIncidents;
  },
  parseHuntressWebhookPayload: vi.fn(),
}));

vi.mock('../services/secretCrypto', () => ({
  decryptSecret: vi.fn(() => 'plaintext-api-key'),
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

import { syncIntegrationById } from './huntressSync';

describe('huntressSync — DB context boundaries (#1697)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contextDepth = 0;
    fetchDepths.length = 0;
    dbCallDepths.length = 0;
    updatePayloads.length = 0;
  });

  it('fetches from Huntress with no DB context held, but reads/writes inside one', async () => {
    const result = await syncIntegrationById('integration-1', 'scheduled');

    // All three external calls were issued.
    expect(listOrganizations).toHaveBeenCalledTimes(1);
    expect(listAgents).toHaveBeenCalledTimes(1);
    expect(listIncidents).toHaveBeenCalledTimes(1);

    // The core regression guard: every external HTTP call ran with NO open
    // transaction held (depth 0). Pre-fix the whole job ran inside one context,
    // so these would all be > 0.
    expect(fetchDepths).toEqual([0, 0, 0]);

    // Sanity: the DB reads/writes still ran inside a context (depth > 0), so RLS
    // is satisfied and the contextless-write guard (#1375) stays quiet.
    expect(dbCallDepths.length).toBeGreaterThan(0);
    for (const depth of dbCallDepths) {
      expect(depth).toBeGreaterThan(0);
    }

    expect(result.integrationId).toBe('integration-1');
  });

  it('keeps the fetch outside the transaction even when wrapped in an outer DB context (guards against re-adding the blanket worker wrap)', async () => {
    const dbm = await import('../db');
    await dbm.withSystemDbAccessContext(async () => {
      await syncIntegrationById('integration-1', 'scheduled');
    });

    // Even with an outer context held (depth >= 1), runOutsideDbContext escaped
    // it for the fetch. If a future change drops that escape, these become >= 1.
    expect(fetchDepths).toEqual([0, 0, 0]);
    for (const depth of dbCallDepths) {
      expect(depth).toBeGreaterThan(0);
    }
  });

  it('on fetch failure, records the error status on a fresh context and re-throws the ORIGINAL error', async () => {
    const boom = new Error('huntress fetch exploded');
    listAgents.mockRejectedValueOnce(boom);

    // The original sync error must propagate — never be masked by the
    // error-status bookkeeping write.
    await expect(syncIntegrationById('integration-1', 'scheduled')).rejects.toBe(boom);

    // The failure-status write happened, carried 'error', and ran inside a
    // context (depth > 0) — i.e. on a real (fresh) transaction, not contextless.
    const errorWrite = updatePayloads.find((u) => u.payload.lastSyncStatus === 'error');
    expect(errorWrite).toBeDefined();
    expect(errorWrite!.depth).toBeGreaterThan(0);
  });

  it('does NOT record a terminal error on a non-final retry attempt (#1736)', async () => {
    const boom = new Error('transient CONNECTION_CLOSED');
    listAgents.mockRejectedValueOnce(boom);

    // The original error still propagates so BullMQ schedules the retry...
    await expect(
      syncIntegrationById('integration-1', 'scheduled', undefined, { isFinalAttempt: false })
    ).rejects.toBe(boom);

    // ...but the row is left at 'running' (no terminal 'error' write), so the UI
    // keeps showing "Syncing" while the backoff/retry runs.
    expect(updatePayloads.some((u) => u.payload.lastSyncStatus === 'running')).toBe(true);
    expect(updatePayloads.some((u) => u.payload.lastSyncStatus === 'error')).toBe(false);
  });

  it('records a terminal error on the final retry attempt (#1736)', async () => {
    const boom = new Error('exhausted CONNECTION_CLOSED');
    listAgents.mockRejectedValueOnce(boom);

    await expect(
      syncIntegrationById('integration-1', 'scheduled', undefined, { isFinalAttempt: true })
    ).rejects.toBe(boom);

    const errorWrite = updatePayloads.find((u) => u.payload.lastSyncStatus === 'error');
    expect(errorWrite).toBeDefined();
    expect(String(errorWrite!.payload.lastSyncError)).toContain('scheduled:');
  });

  it('on the webhook path, persists without any external fetch', async () => {
    const result = await syncIntegrationById('integration-1', 'webhook', { agents: [], incidents: [] });

    expect(listOrganizations).not.toHaveBeenCalled();
    expect(listAgents).not.toHaveBeenCalled();
    expect(listIncidents).not.toHaveBeenCalled();
    expect(fetchDepths).toEqual([]);

    // The persist still ran inside a context.
    expect(dbCallDepths.length).toBeGreaterThan(0);
    for (const depth of dbCallDepths) {
      expect(depth).toBeGreaterThan(0);
    }
    expect(result.integrationId).toBe('integration-1');
  });

  it('marks the integration running before the fetch and records result counts on success (#1736)', async () => {
    await syncIntegrationById('integration-1', 'scheduled');

    // A 'running' status is written before any external fetch, on a real context
    // (depth > 0), so the UI can observe a definitive running → terminal flip.
    const runningWrite = updatePayloads.find((u) => u.payload.lastSyncStatus === 'running');
    expect(runningWrite).toBeDefined();
    expect(runningWrite!.depth).toBeGreaterThan(0);
    expect(runningWrite!.payload.lastSyncError).toBeNull();

    // The success write carries the per-run result counts in the same write as
    // the success status, so counts never drift from "succeeded at <lastSyncAt>".
    const successWrite = updatePayloads.find((u) => u.payload.lastSyncStatus === 'success');
    expect(successWrite).toBeDefined();
    expect(successWrite!.payload).toMatchObject({
      lastSyncAgents: 0,
      lastSyncIncidents: 0,
      lastSyncOrgs: 0,
    });

    // Ordering: running is written before success.
    expect(updatePayloads.indexOf(runningWrite!)).toBeLessThan(updatePayloads.indexOf(successWrite!));
  });

  it('does NOT write a running status on the webhook path (synchronous, same context)', async () => {
    await syncIntegrationById('integration-1', 'webhook', { agents: [], incidents: [] });

    expect(updatePayloads.some((u) => u.payload.lastSyncStatus === 'running')).toBe(false);
    expect(updatePayloads.some((u) => u.payload.lastSyncStatus === 'success')).toBe(true);
  });

  it('skips an inactive integration without fetching', async () => {
    const { db } = (await import('../db')) as unknown as { db: { select: ReturnType<typeof vi.fn> } };
    db.select.mockReturnValueOnce(chain([{ ...INTEGRATION_ROW, isActive: false }]) as never);

    const result = await syncIntegrationById('integration-1', 'scheduled');

    expect(listOrganizations).not.toHaveBeenCalled();
    expect(result.upsertedAgents).toBe(0);
  });
});
