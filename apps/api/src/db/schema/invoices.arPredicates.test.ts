import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { INVOICE_STATUSES } from '@breeze/shared';
import { AR_OPEN_STATUSES, invoices, sqlOpenAr, sqlOpenForOverdue } from './invoices';

const dialect = new PgDialect();
const compile = (q: Parameters<PgDialect['sqlToQuery']>[0]) => dialect.sqlToQuery(q).sql;

describe('AR open statuses (#3198 W02 R3)', () => {
  it('is exactly sent, partially_paid and overdue', () => {
    expect([...AR_OPEN_STATUSES]).toEqual(['sent', 'partially_paid', 'overdue']);
  });

  /** The reason this file exists. runOverdueSweep (invoiceService.ts) FLIPS
   *  sent/partially_paid to 'overdue', so an AR aging report built on
   *  sqlOpenForOverdue's status list would omit almost every past-due invoice —
   *  the exact rows the report is for. */
  it('includes overdue, which the sweep-candidate predicate deliberately does not', () => {
    expect(AR_OPEN_STATUSES).toContain('overdue');
    expect(compile(sqlOpenForOverdue(invoices))).not.toContain('overdue');
  });

  it('every AR-open status is a real invoice_status value', () => {
    for (const s of AR_OPEN_STATUSES) expect(INVOICE_STATUSES).toContain(s);
  });

  it('sqlOpenAr renders exactly the AR_OPEN_STATUSES list', () => {
    expect(compile(sqlOpenAr(invoices)))
      .toBe(`"invoices"."status" IN (${AR_OPEN_STATUSES.map((s) => `'${s}'`).join(',')})`);
  });

  it('sqlOpenForOverdue is AR-open minus overdue — and still the partial-index predicate, unchanged', () => {
    expect(compile(sqlOpenForOverdue(invoices))).toBe(`"invoices"."status" IN ('sent','partially_paid')`);
    const idx = getTableConfig(invoices).indexes.find((i) => i.config.name === 'invoices_due_overdue_idx');
    expect(idx).toBeDefined();
    expect(compile(idx!.config.where!)).toBe(`"invoices"."status" IN ('sent','partially_paid')`);
  });
});
