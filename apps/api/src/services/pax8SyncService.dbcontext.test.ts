import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// #1697 — the Pax8 sync must NOT hold a pooled DB connection in an open
// transaction across its external HTTP fetch. Same depth-tracking model as the
// Huntress sync test: withSystemDbAccessContext increments depth,
// runOutsideDbContext zeroes it; assert the Pax8 client calls run at depth 0
// while DB reads/writes run at depth > 0. (Kept in a separate file from
// pax8SyncService.test.ts because it needs a chainable, context-aware db mock.)
// ---------------------------------------------------------------------------

let contextDepth = 0;
const fetchDepths: number[] = [];
const dbCallDepths: number[] = [];

function chain(result: unknown) {
  const c: Record<string, unknown> = {};
  for (const m of [
    'from', 'where', 'limit', 'set', 'values', 'returning',
    'onConflictDoUpdate', 'onConflictDoNothing', 'innerJoin', 'leftJoin',
  ]) {
    c[m] = vi.fn(() => c);
  }
  (c as { then: unknown }).then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return c;
}

const INTEGRATION_ROW = {
  id: 'pax8-int-1',
  partnerId: 'partner-1',
  isActive: true,
  clientIdEncrypted: 'enc-id',
  clientSecretEncrypted: 'enc-secret',
  accessTokenEncrypted: 'enc-token',
  accessTokenExpiresAt: null,
  apiBaseUrl: 'https://api.pax8.example',
  tokenUrl: 'https://auth.pax8.example/token',
};

vi.mock('../db', () => ({
  db: {
    // `.select()` (no projection) = the integration read in
    // createPax8ClientForIntegration; `.select({...})` = the mapped-company /
    // contract-line reads, which return empty for this empty-sync test.
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
      return chain([]);
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

const listCompanies = vi.fn(async () => {
  fetchDepths.push(contextDepth);
  return [];
});
const listSubscriptions = vi.fn(async () => {
  fetchDepths.push(contextDepth);
  return [];
});

vi.mock('./pax8Client', () => ({
  DEFAULT_PAX8_API_BASE_URL: 'https://api.pax8.example',
  DEFAULT_PAX8_TOKEN_URL: 'https://auth.pax8.example/token',
  Pax8Client: class {
    listCompanies = listCompanies;
    listSubscriptions = listSubscriptions;
    cachedAccessToken = { token: null as string | null, expiresAt: null };
  },
}));

vi.mock('./secretCrypto', () => ({
  decryptForColumn: vi.fn(() => 'plaintext-secret'),
  encryptSecret: vi.fn(() => 'ciphertext'),
}));

import { syncPax8Integration } from './pax8SyncService';

describe('pax8SyncService — DB context boundaries (#1697)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contextDepth = 0;
    fetchDepths.length = 0;
    dbCallDepths.length = 0;
  });

  it('fetches from Pax8 with no DB context held, but reads/writes inside one', async () => {
    const result = await syncPax8Integration('pax8-int-1');

    expect(listCompanies).toHaveBeenCalledTimes(1);
    expect(listSubscriptions).toHaveBeenCalledTimes(1);

    // Core regression guard: the external calls ran with NO open transaction.
    expect(fetchDepths).toEqual([0, 0]);

    // Reads/writes (running status, integration read, contract-line apply,
    // success status) all ran inside a context.
    expect(dbCallDepths.length).toBeGreaterThan(0);
    for (const depth of dbCallDepths) {
      expect(depth).toBeGreaterThan(0);
    }

    expect(result.integrationId).toBe('pax8-int-1');
  });
});
