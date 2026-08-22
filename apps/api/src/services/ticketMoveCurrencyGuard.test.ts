import { describe, it, expect, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  assertTicketMoveCurrencyCompatible,
  TicketMoveCurrencyBlockedError,
} from './ticketMoveCurrencyGuard';

// The guard only needs the request-transaction TYPE from ../db; keep the
// module from opening a pool in the unit run.
vi.mock('../db', () => ({ db: {} }));

const dialect = new PgDialect();
const render = (value: unknown) => dialect.sqlToQuery(value as SQL);

const T1 = '11111111-1111-4111-8111-111111111111';

/**
 * Hand-rolled tx stub: select().from().where().orderBy().for() resolves from a
 * queue, one entry per locked select, and records every where/for argument.
 */
function makeTx(queue: unknown[][]) {
  const wheres: unknown[] = [];
  const fors: string[] = [];
  const tables: unknown[] = [];
  const projections: Record<string, unknown>[] = [];
  const select = vi.fn((projection: Record<string, unknown>) => ({
    from: vi.fn((table: unknown) => {
      projections.push(projection);
      tables.push(table);
      return {
        where: vi.fn((w: unknown) => {
          wheres.push(w);
          return {
            orderBy: vi.fn(() => ({
              for: vi.fn((mode: string) => {
                fors.push(mode);
                return Promise.resolve(queue.shift() ?? []);
              }),
            })),
          };
        }),
      };
    }),
  }));
  return { tx: { select } as never, select, wheres, fors, tables, projections };
}

const base = { ticketIds: [T1], sourceCurrency: 'USD', targetCurrency: 'EUR', targetOrgName: 'Beta Corp' };

describe('assertTicketMoveCurrencyCompatible', () => {
  it('(a) returns null and takes no locks when the currencies match', async () => {
    const { tx, select } = makeTx([]);
    const out = await assertTicketMoveCurrencyCompatible(tx, {
      ...base, targetCurrency: 'USD', acceptCurrencyMismatch: false,
    });
    expect(out).toBeNull();
    expect(select).not.toHaveBeenCalled();
  });

  it('returns null and takes no locks when there are no tickets to guard', async () => {
    const { tx, select } = makeTx([]);
    const out = await assertTicketMoveCurrencyCompatible(tx, { ...base, ticketIds: [], acceptCurrencyMismatch: false });
    expect(out).toBeNull();
    expect(select).not.toHaveBeenCalled();
  });

  it('(b) throws TicketMoveCurrencyBlockedError with counts when an unbilled monetary row is locked and the mismatch is not accepted', async () => {
    const { tx, fors } = makeTx([[{ id: 'te-1', currencyCode: 'USD' }], []]);
    const err = await assertTicketMoveCurrencyCompatible(tx, { ...base, acceptCurrencyMismatch: false }).catch((e) => e);
    expect(err).toBeInstanceOf(TicketMoveCurrencyBlockedError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('TICKET_MOVE_CURRENCY_BLOCKED');
    expect(err.details).toEqual({
      sourceCurrency: 'USD', targetCurrency: 'EUR', unbilledTimeEntries: 1, unbilledParts: 0, accepted: false,
      blockedByCurrency: [{ currencyCode: 'USD', timeEntries: 1, parts: 0 }],
    });
    expect(err.message).toContain('1 unbilled time entries and 0 unbilled parts are in USD');
    expect(err.message).toContain('Beta Corp bills in EUR');
    // Both source tables were locked (time_entries first, then ticket_parts).
    expect(fors).toEqual(['update', 'update']);
  });

  it('(c) returns accepted details instead of throwing when the mismatch is accepted', async () => {
    const { tx } = makeTx([
      [{ id: 'te-1', currencyCode: 'USD' }],
      [{ id: 'p-1', currencyCode: 'USD' }, { id: 'p-2', currencyCode: 'USD' }],
    ]);
    const out = await assertTicketMoveCurrencyCompatible(tx, { ...base, acceptCurrencyMismatch: true });
    expect(out).toEqual({
      sourceCurrency: 'USD', targetCurrency: 'EUR', unbilledTimeEntries: 1, unbilledParts: 2, accepted: true,
      blockedByCurrency: [{ currencyCode: 'USD', timeEntries: 1, parts: 2 }],
    });
  });

  it('(d) returns zero counts (no throw) when the currencies differ but nothing unbilled is stamped', async () => {
    const { tx } = makeTx([[], []]);
    const out = await assertTicketMoveCurrencyCompatible(tx, { ...base, acceptCurrencyMismatch: false });
    expect(out).toEqual({
      sourceCurrency: 'USD', targetCurrency: 'EUR', unbilledTimeEntries: 0, unbilledParts: 0, accepted: false,
      blockedByCurrency: [],
    });
  });

  it('(f) rows already snapshotted in the TARGET currency are not blocked (moving back after an accepted USD→EUR move)', async () => {
    // Ticket now lives in an EUR org; its preserved rows are still USD. Moving
    // it to a USD org must not 409 — the rows already match the destination.
    const { tx, fors } = makeTx([
      [{ id: 'te-1', currencyCode: 'USD' }],
      [{ id: 'p-1', currencyCode: 'USD' }],
    ]);
    const out = await assertTicketMoveCurrencyCompatible(tx, {
      ...base, sourceCurrency: 'EUR', targetCurrency: 'USD', acceptCurrencyMismatch: false,
    });
    expect(out).toEqual({
      sourceCurrency: 'EUR', targetCurrency: 'USD', unbilledTimeEntries: 0, unbilledParts: 0, accepted: false,
      blockedByCurrency: [],
    });
    // The locks are still taken (rows stay serialized behind the move).
    expect(fors).toEqual(['update', 'update']);
  });

  it('(g) mixed snapshots: groups by the ACTUAL row currency, counts only the groups ≠ target, and names them in the message', async () => {
    const { tx } = makeTx([
      [{ id: 'te-1', currencyCode: 'USD' }, { id: 'te-2', currencyCode: 'GBP' }, { id: 'te-3', currencyCode: 'EUR' }],
      [{ id: 'p-1', currencyCode: 'GBP' }, { id: 'p-2', currencyCode: 'EUR' }, { id: 'p-3', currencyCode: null }],
    ]);
    const err = await assertTicketMoveCurrencyCompatible(tx, { ...base, acceptCurrencyMismatch: false }).catch((e) => e);
    expect(err).toBeInstanceOf(TicketMoveCurrencyBlockedError);
    expect(err.details).toEqual({
      sourceCurrency: 'USD', targetCurrency: 'EUR', unbilledTimeEntries: 2, unbilledParts: 2, accepted: false,
      blockedByCurrency: [
        { currencyCode: 'GBP', timeEntries: 1, parts: 1 },
        { currencyCode: 'UNKNOWN', timeEntries: 0, parts: 1 },
        { currencyCode: 'USD', timeEntries: 1, parts: 0 },
      ],
    });
    expect(err.message).toContain('2 unbilled time entries and 2 unbilled parts are in GBP, UNKNOWN, USD');
    expect(err.message).not.toContain('EUR draft');
  });

  it('(e) time-entry predicate is ticket_id IN + not_billed + hourly_rate IS NOT NULL — and NOT is_billable', async () => {
    const { tx, wheres, tables, projections } = makeTx([[], []]);
    await assertTicketMoveCurrencyCompatible(tx, { ...base, acceptCurrencyMismatch: false });
    expect(wheres).toHaveLength(2);
    // Each locked select reads the row's own snapshot — never attributes it to
    // the source org's current currency (review #4).
    expect(projections).toHaveLength(2);
    for (const proj of projections) expect(Object.keys(proj).sort()).toEqual(['currencyCode', 'id']);

    const time = render(wheres[0]);
    expect(time.sql).toMatch(/"ticket_id" in \(\$1\)/);
    expect(time.sql).toMatch(/"billing_status" = \$2/);
    expect(time.sql).toMatch(/"hourly_rate" is not null/);
    expect(time.sql).not.toContain('is_billable');
    expect(time.params).toEqual([T1, 'not_billed']);

    const parts = render(wheres[1]);
    expect(parts.sql).toMatch(/"ticket_id" in \(\$1\)/);
    expect(parts.sql).toMatch(/"billing_status" = \$2/);
    expect(parts.sql).not.toContain('is_billable');
    expect(parts.sql).not.toContain('unit_price');
    expect(parts.params).toEqual([T1, 'not_billed']);

    // Table identity: time_entries locked before ticket_parts (global order).
    const names = tables.map((t) => (t as { [k: symbol]: unknown })[Symbol.for('drizzle:Name')]);
    expect(names).toEqual(['time_entries', 'ticket_parts']);
  });
});
