import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_INVOICE_TERMS_DAYS, computeDueDate, resolveInvoiceTermsDays } from './invoiceTerms';

describe('resolveInvoiceTermsDays (settings rule 5 — the one terms resolver)', () => {
  it('org override wins over the partner default', () => {
    expect(resolveInvoiceTermsDays(7, 30)).toBe(7);
  });

  it('blank org (null/undefined) inherits the partner default', () => {
    expect(resolveInvoiceTermsDays(null, 14)).toBe(14);
    expect(resolveInvoiceTermsDays(undefined, 14)).toBe(14);
  });

  it('falls back to 30 when neither level is set', () => {
    expect(resolveInvoiceTermsDays(null, null)).toBe(DEFAULT_INVOICE_TERMS_DAYS);
    expect(DEFAULT_INVOICE_TERMS_DAYS).toBe(30);
  });

  it('an org override of 0 (due on receipt) is honoured, not treated as blank', () => {
    expect(resolveInvoiceTermsDays(0, 30)).toBe(0);
  });

  it('a partner default of 0 is honoured', () => {
    expect(resolveInvoiceTermsDays(null, 0)).toBe(0);
  });
});

describe('computeDueDate', () => {
  it('adds whole days in UTC and returns YYYY-MM-DD', () => {
    expect(computeDueDate(new Date('2026-09-23T23:30:00Z'), 7)).toBe('2026-09-30');
  });

  it('0 days is the issue date', () => {
    expect(computeDueDate(new Date('2026-09-23T10:00:00Z'), 0)).toBe('2026-09-23');
  });
});

/**
 * Sweep guard: every invoice issue writer must resolve terms through
 * resolveInvoiceTermsDays. A hand-rolled `partner?.invoiceTermsDays ?? 30` in a
 * new (or old) writer silently ignores the org override — exactly the drift
 * this wave fixed in quoteAcceptService.
 */
describe('no issue writer hand-rolls the terms fallback', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return walk(p);
      return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
    });
  }

  it('only invoiceTerms.ts applies a default to a terms value', () => {
    const root = join(__dirname, '..');
    const offenders = [...walk(join(root, 'services')), ...walk(join(root, 'jobs')), ...walk(join(root, 'routes'))]
      .filter((p) => !p.endsWith('invoiceTerms.ts'))
      // `?? null` is a projection passthrough (no default applied), not a fallback.
      .filter((p) => /[Tt]ermsDays\s*\?\?(?!\s*null\b)/.test(readFileSync(p, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
