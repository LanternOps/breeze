import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

/**
 * `autoResolveWarrantyAlerts`'s per-alert UPDATE is a compare-and-swap (#4094).
 * It used to update by id alone: a warranty sweep racing a technician's manual
 * resolve (or a second sweep on the same device) could both "win" and both
 * publish `alert.resolved` for the same alert.
 *
 * Only the CONNECTION is mocked here — drizzle-orm and ../db/schema are real
 * (unlike the sibling `warrantyAlertEvaluator.test.ts`, which mocks
 * `../db/schema` with fake string column stand-ins; that file cannot compile a
 * real predicate, which is exactly why this one exists as a separate suite),
 * so the predicate `autoResolveWarrantyAlerts` hands `.where()` is a real `SQL`
 * object that can be compiled through `PgDialect`.
 *
 * Two kinds of assertion, deliberately:
 *
 *  - BEHAVIOUR — of two open warranty alerts on the same device, the second
 *    losing its CAS (empty `RETURNING`) must not add a second `publishEvent`
 *    call — exactly one per real transition, matching the winner.
 *  - COMPILED SQL — same predicate shape as the other three CAS sites; a mocked-
 *    drizzle substring match on column names cannot distinguish `and` from `or`
 *    or catch a terminal status being admitted into the list (main 8763a3239).
 */
const { dbMock, selectQueues, updateWheres, updateReturns } = vi.hoisted(() => {
  const selectQueues = new Map<string, unknown[][]>();
  const updateWheres: unknown[] = [];
  const updateReturns: unknown[][] = [];

  // Table-keyed select queue, same technique as
  // alertService.autoResolveOutcome.test.ts: seeds are per real Drizzle table
  // (resolved via its Name symbol), not per call order.
  const tableName = (table: unknown): string => {
    const symbols = Object.getOwnPropertySymbols(table as object);
    for (const symbol of symbols) {
      if (symbol.description?.includes('Name')) {
        const value = (table as Record<symbol, unknown>)[symbol];
        if (typeof value === 'string') return value;
      }
    }
    return 'unknown';
  };
  const take = (table: unknown): unknown[] => selectQueues.get(tableName(table))?.shift() ?? [];

  const dbMock = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const rows = take(table);
          return {
            limit: () => Promise.resolve(rows),
            then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
              Promise.resolve(rows).then(resolve, reject),
          };
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: (predicate: unknown) => {
          updateWheres.push(predicate);
          return { returning: () => Promise.resolve(updateReturns.shift() ?? []) };
        },
      }),
    }),
  };

  return { dbMock, selectQueues, updateWheres, updateReturns };
});

const publishEvent = vi.fn((..._args: unknown[]) => Promise.resolve('evt'));

vi.mock('../db', () => ({ db: dbMock }));
vi.mock('./eventBus', () => ({ publishEvent: (...a: unknown[]) => publishEvent(...a) }));

import { evaluateWarrantyAlerts } from './warrantyAlertEvaluator';

const DEVICE_ID = '66666666-6666-4666-8666-666666666666';
const ORG_ID = 'org-1';

const seed = (table: string, ...batches: unknown[][]) => selectQueues.set(table, batches);

const openAlert = (id: string, status: 'active' | 'acknowledged' | 'suppressed' = 'active') => ({
  id,
  orgId: ORG_ID,
  deviceId: DEVICE_ID,
  status,
  suppressedUntil: null as Date | null,
});

beforeEach(() => {
  selectQueues.clear();
  updateWheres.length = 0;
  updateReturns.length = 0;
  vi.clearAllMocks();
  publishEvent.mockResolvedValue('evt');
});

// Drive autoResolveWarrantyAlerts via evaluateWarrantyAlerts' "warranty now
// resolves to disabled" path (settings.enabled === false): the shortest route
// that reaches the auto-resolve loop without needing to fabricate a full
// non-expiring-warranty scenario.
function runAutoResolveSweep() {
  seed('device_warranty', [{
    deviceId: DEVICE_ID,
    orgId: ORG_ID,
    manufacturer: 'apple',
    serialNumber: 'ABC123',
    status: 'expiring',
    warrantyEndDate: '2099-01-01',
    isSubscription: false,
  }]);
  seed('devices', [{ id: DEVICE_ID, orgId: ORG_ID, siteId: null, displayName: 'Test Mac', hostname: 'test-mac', isEphemeral: false }]);
  seed('devices', [{ orgId: ORG_ID, siteId: null }]); // resolveWarrantySettings' device lookup
  seed('device_group_memberships', []); // no group memberships
  seed('config_policy_feature_links', []); // no warranty policy assigned -> DISABLED_SETTINGS
  return evaluateWarrantyAlerts(DEVICE_ID);
}

describe('autoResolveWarrantyAlerts — mixed CAS outcome across two open alerts', () => {
  it('publishes alert.resolved once per real transition, not once per open alert', async () => {
    seed('alerts', [openAlert('alert-win'), openAlert('alert-lose')]);
    updateReturns.push([{ id: 'alert-win' }]); // first UPDATE: CAS matched, this sweep won
    updateReturns.push([]);                    // second UPDATE: CAS matched nothing, lost the race

    await runAutoResolveSweep();

    expect(updateWheres).toHaveLength(2); // both alerts were attempted...
    expect(publishEvent).toHaveBeenCalledTimes(1); // ...but only the winner fanned out
    expect(publishEvent.mock.calls[0]?.[2]).toMatchObject({ alertId: 'alert-win' });
  });
});

describe('autoResolveWarrantyAlerts — the shipped predicate (compiled SQL)', () => {
  it('scopes each UPDATE by id AND resolvable status', async () => {
    seed('alerts', [openAlert('alert-1')]);
    updateReturns.push([{ id: 'alert-1' }]);

    await runAutoResolveSweep();

    expect(updateWheres).toHaveLength(1);
    const dialect = new PgDialect();
    const { sql, params } = dialect.sqlToQuery(updateWheres[0] as SQL);

    // `or` instead of `and` would stamp every active/acknowledged/suppressed alert
    // in EVERY tenant from one sweep; dropping the status list makes the write
    // unconditional again; admitting 'resolved' or 'dismissed' makes the CAS a
    // no-op. Each of those changes this string or its params.
    expect(sql).toBe('("alerts"."id" = $1 and "alerts"."status" in ($2, $3, $4))');
    expect(params).toEqual(['alert-1', 'active', 'acknowledged', 'suppressed']);
  });
});
