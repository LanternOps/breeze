// apps/api/src/services/actionIntents/intentQuery.test.ts
//
// TDD red-first coverage for intentQuery.ts (AI patch agent W02 Task 2,
// docs/superpowers/plans/ai-mcp/2026-09-13-ai-patch-agent-02-actionable-installs.md).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock, getCurrentDbAccessContextMock, runOutsideDbContextMock, withSystemDbAccessContextMock } = vi.hoisted(() => {
  const selectMock = vi.fn();
  return {
    dbMock: { select: selectMock },
    getCurrentDbAccessContextMock: vi.fn(() => undefined as { scope: string } | undefined),
    runOutsideDbContextMock: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContextMock: vi.fn(async (fn: () => unknown) => fn()),
  };
});

vi.mock('../../db', () => ({
  db: dbMock,
  getCurrentDbAccessContext: getCurrentDbAccessContextMock,
  runOutsideDbContext: runOutsideDbContextMock,
  withSystemDbAccessContext: withSystemDbAccessContextMock,
}));

vi.mock('../../db/schema/actionIntents', () => ({
  actionIntents: {
    orgId: 'orgId',
    idempotencyKey: 'idempotencyKey',
    status: 'status',
    createdAt: 'createdAt',
    decidedAt: 'decidedAt',
  },
}));

import { findIntentsByIdempotencyKey, INTENT_QUERY_KEY_BATCH } from './intentQuery';

function makeChain(rows: unknown[]) {
  const orderBy = vi.fn(async () => rows);
  const where = vi.fn((_condition: unknown) => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  return { from, where, orderBy };
}

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentDbAccessContextMock.mockReturnValue(undefined);
  runOutsideDbContextMock.mockImplementation((fn: () => unknown) => fn());
  withSystemDbAccessContextMock.mockImplementation(async (fn: () => unknown) => fn());
});

describe('findIntentsByIdempotencyKey', () => {
  it('reads only the given org, in one query, for up to the batch size', async () => {
    const rows = [{ idempotencyKey: 'patch:org-1:d:p', status: 'rejected', createdAt: new Date(), decidedAt: null }];
    const chain = makeChain(rows);
    dbMock.select.mockReturnValue({ from: chain.from });

    const result = await findIntentsByIdempotencyKey({
      orgId: 'org-1',
      keys: ['patch:org-1:d:p1', 'patch:org-1:d:p2'],
      since: new Date('2026-01-01'),
    });

    expect(dbMock.select).toHaveBeenCalledTimes(1);
    expect(chain.from).toHaveBeenCalledTimes(1);
    expect(chain.where).toHaveBeenCalledTimes(1);
    const whereArgJson = JSON.stringify(chain.where.mock.calls[0]![0]);
    expect(whereArgJson).toContain('org-1');
    expect(whereArgJson).toContain('patch:org-1:d:p1');
    expect(whereArgJson).toContain('patch:org-1:d:p2');
    expect(result).toEqual(rows);
  });

  it('returns rows most-recent-first', async () => {
    const older = { idempotencyKey: 'k1', status: 'expired', createdAt: new Date('2026-01-01'), decidedAt: null };
    const newer = { idempotencyKey: 'k2', status: 'expired', createdAt: new Date('2026-02-01'), decidedAt: null };
    const chain = makeChain([newer, older]);
    dbMock.select.mockReturnValue({ from: chain.from });

    const result = await findIntentsByIdempotencyKey({ orgId: 'org-1', keys: ['k1', 'k2'], since: new Date('2025-01-01') });

    expect(result[0]).toBe(newer);
    expect(result[1]).toBe(older);
  });

  it('runs inside a system DB context when the ambient scope is not already system', async () => {
    const chain = makeChain([]);
    dbMock.select.mockReturnValue({ from: chain.from });
    getCurrentDbAccessContextMock.mockReturnValue(undefined);

    await findIntentsByIdempotencyKey({ orgId: 'org-1', keys: ['k1'], since: new Date() });

    expect(runOutsideDbContextMock).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
  });

  it('does not re-enter system context when already in one (avoids double-holding a pooled connection)', async () => {
    const chain = makeChain([]);
    dbMock.select.mockReturnValue({ from: chain.from });
    getCurrentDbAccessContextMock.mockReturnValue({ scope: 'system' });

    await findIntentsByIdempotencyKey({ orgId: 'org-1', keys: ['k1'], since: new Date() });

    expect(runOutsideDbContextMock).not.toHaveBeenCalled();
    expect(withSystemDbAccessContextMock).not.toHaveBeenCalled();
  });

  it('returns [] with no query for empty keys', async () => {
    const result = await findIntentsByIdempotencyKey({ orgId: 'org-1', keys: [], since: new Date() });

    expect(result).toEqual([]);
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('splits more than the batch size into multiple selects', async () => {
    const chain = makeChain([]);
    dbMock.select.mockReturnValue({ from: chain.from });
    const keys = Array.from({ length: INTENT_QUERY_KEY_BATCH + 1 }, (_, i) => `k${i}`);

    await findIntentsByIdempotencyKey({ orgId: 'org-1', keys, since: new Date() });

    expect(dbMock.select).toHaveBeenCalledTimes(2);
  });

  it('dedupes duplicate keys before querying', async () => {
    const chain = makeChain([]);
    dbMock.select.mockReturnValue({ from: chain.from });

    await findIntentsByIdempotencyKey({ orgId: 'org-1', keys: ['k1', 'k1', 'k1'], since: new Date() });

    const whereArgJson = JSON.stringify(chain.where.mock.calls[0]![0]);
    // A single select was made (dedupe means one key never needs a second batch).
    expect(dbMock.select).toHaveBeenCalledTimes(1);
    expect(whereArgJson).toContain('k1');
  });
});
