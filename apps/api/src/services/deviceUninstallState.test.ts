import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

// Real drizzle-orm + real schema (deliberately NOT mocked), mirroring
// `deviceUninstallDrain.test.ts`: the security-relevant part of this read is
// its WHERE clause — a row that does NOT carry the `device_remove` reason
// belongs to tenant offboarding or abuse suspension, and reporting it as
// "this device's Remove" would tell an operator the wrong story about why
// their endpoint is being torn down. That clause is asserted on COMPILED SQL
// (`new PgDialect().sqlToQuery(...)`) rather than via
// `expect(where).toHaveBeenCalled()`, which would pass identically whether the
// code wrote `eq()`, `ne()`, or the wrong column.

const selectMock = vi.fn();

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
  },
}));

import { UNINSTALL_REASON_DEVICE_REMOVE } from './deviceUninstallDrain';
import { getDeviceUninstallStatus } from './deviceUninstallState';

const dialect = new PgDialect();

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const QUEUED_AT = new Date('2026-09-05T10:00:00.000Z');
const EXPIRES_AT = new Date('2026-09-08T10:00:00.000Z');

/** The shape `getDeviceUninstallStatus`'s SELECT projects, at its most boring:
 * a freshly queued, never-dispatched device-remove uninstall. */
const BASE_ROW = {
  status: 'pending',
  createdAt: QUEUED_AT,
  executedAt: null as Date | null,
  completedAt: null as Date | null,
  result: null as unknown,
  expiresAt: EXPIRES_AT as Date | null,
};

/**
 * Chainable `.from()/.where()/.orderBy()/.limit()` surface where every link is
 * both awaitable (resolves to `rows`) AND continues the chain — same helper
 * shape as `deviceUninstallDrain.test.ts`'s `rigSelect`. Captures the condition
 * handed to `.where()` so it can be compiled and asserted.
 */
function rigSelect(rows: unknown[]): { where: () => unknown; orderBy: () => unknown } {
  const captured: { where?: unknown; orderBy?: unknown } = {};
  const chain: Record<string, any> = {};
  for (const method of ['from', 'limit']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(rows), chain));
  }
  chain.where = vi.fn((cond: unknown) => {
    captured.where = cond;
    return Object.assign(Promise.resolve(rows), chain);
  });
  chain.orderBy = vi.fn((cond: unknown) => {
    captured.orderBy = cond;
    return Object.assign(Promise.resolve(rows), chain);
  });
  selectMock.mockReturnValueOnce(Object.assign(Promise.resolve(rows), chain));
  return { where: () => captured.where, orderBy: () => captured.orderBy };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getDeviceUninstallStatus — the query', () => {
  it('compiles a 3-way CONJUNCTION requiring the device, self_uninstall, and the device_remove reason', async () => {
    const rig = rigSelect([]);

    await getDeviceUninstallStatus(DEVICE_ID);

    const built = dialect.sqlToQuery(rig.where() as never);
    const sqlText = built.sql.toLowerCase();

    // AND, not OR. `or(a, b, c)` would contain every clause below as a
    // substring too, and would make an abuse-queued self_uninstall on some
    // OTHER device satisfy the predicate on its `type` clause alone.
    expect(sqlText).not.toContain(' or ');
    expect(sqlText.split(' and ')).toHaveLength(3);

    expect(built.params).toContain(DEVICE_ID);
    expect(built.params).toContain('self_uninstall');
    // THE provenance guard: uninstall_reasons @> ARRAY['device_remove'] — the
    // clause that keeps a tenant-offboarding or abuse-suspension uninstall
    // from being reported as this device's Remove.
    expect(sqlText).toContain('"uninstall_reasons" @> $');
    // Bound as a Postgres array literal; assert the value is actually bound
    // rather than depending on the exact literal formatting.
    expect(
      built.params.some(
        (p) => typeof p === 'string' && p.includes(UNINSTALL_REASON_DEVICE_REMOVE),
      ),
    ).toBe(true);
  });

  it('orders newest-first so a restore-then-remove cycle reports the CURRENT uninstall', async () => {
    const rig = rigSelect([]);

    await getDeviceUninstallStatus(DEVICE_ID);

    const built = dialect.sqlToQuery(rig.orderBy() as never);
    expect(built.sql.toLowerCase()).toContain('"created_at" desc');
  });
});

describe('getDeviceUninstallStatus — state mapping', () => {
  it('maps a queued row to pending and surfaces the drain deadline', async () => {
    rigSelect([{ ...BASE_ROW }]);

    const status = await getDeviceUninstallStatus(DEVICE_ID);

    expect(status).toEqual({
      state: 'pending',
      queuedAt: '2026-09-05T10:00:00.000Z',
      sentAt: null,
      completedAt: null,
      expiresAt: '2026-09-08T10:00:00.000Z',
    });
  });

  it('maps a dispatched row to sent and reports when it was handed over', async () => {
    const executedAt = new Date('2026-09-05T11:30:00.000Z');
    rigSelect([{ ...BASE_ROW, status: 'sent', executedAt }]);

    const status = await getDeviceUninstallStatus(DEVICE_ID);

    expect(status?.state).toBe('sent');
    expect(status?.sentAt).toBe('2026-09-05T11:30:00.000Z');
  });

  it('maps a reaper timeout (failed + result.status=timeout) to expired', async () => {
    // staleCommandReaper.ts writes exactly this shape when the drain window
    // runs out: status 'failed', result.status 'timeout'. "Failed" would tell
    // the operator the agent tried and could not; "expired" tells them the
    // agent never checked in at all, which is the actionable difference.
    rigSelect([{
      ...BASE_ROW,
      status: 'failed',
      completedAt: new Date('2026-09-08T10:05:00.000Z'),
      result: { status: 'timeout', error: 'Command expired', timedOutBy: 'server' },
    }]);

    const status = await getDeviceUninstallStatus(DEVICE_ID);

    expect(status?.state).toBe('expired');
    expect(status?.completedAt).toBe('2026-09-08T10:05:00.000Z');
  });

  it('maps a failure that is NOT a timeout to failed', async () => {
    rigSelect([{
      ...BASE_ROW,
      status: 'failed',
      result: { status: 'error', error: 'uninstaller exited 1' },
    }]);

    expect((await getDeviceUninstallStatus(DEVICE_ID))?.state).toBe('failed');
  });

  it('maps a failure with no result payload at all to failed, not expired', async () => {
    rigSelect([{ ...BASE_ROW, status: 'failed', result: null }]);

    expect((await getDeviceUninstallStatus(DEVICE_ID))?.state).toBe('failed');
  });

  it('maps a cancelled row to cancelled', async () => {
    rigSelect([{
      ...BASE_ROW,
      status: 'cancelled',
      completedAt: new Date('2026-09-05T12:00:00.000Z'),
    }]);

    expect((await getDeviceUninstallStatus(DEVICE_ID))?.state).toBe('cancelled');
  });

  it('maps a completed row to completed', async () => {
    rigSelect([{
      ...BASE_ROW,
      status: 'completed',
      executedAt: new Date('2026-09-05T11:00:00.000Z'),
      completedAt: new Date('2026-09-05T11:00:30.000Z'),
    }]);

    const status = await getDeviceUninstallStatus(DEVICE_ID);
    expect(status?.state).toBe('completed');
    expect(status?.completedAt).toBe('2026-09-05T11:00:30.000Z');
  });

  it('falls back to failed for an unrecognised command status rather than leaking it verbatim', async () => {
    // `device_commands.status` is a plain varchar, so a future writer can put
    // anything in it. The union type must stay closed: an unknown value is
    // reported as `failed` (the conservative "do not claim it came off"
    // reading), never passed through where the web would render a raw key.
    rigSelect([{ ...BASE_ROW, status: 'queued_somewhere_new' }]);

    expect((await getDeviceUninstallStatus(DEVICE_ID))?.state).toBe('failed');
  });

  it('tolerates a row with no drain deadline (a merged pre-provenance row)', async () => {
    rigSelect([{ ...BASE_ROW, expiresAt: null }]);

    expect((await getDeviceUninstallStatus(DEVICE_ID))?.expiresAt).toBeNull();
  });

  it('returns null when the device has no device_remove uninstall at all', async () => {
    rigSelect([]);

    expect(await getDeviceUninstallStatus(DEVICE_ID)).toBeNull();
  });
});
