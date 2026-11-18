import { describe, it, expect, vi } from 'vitest';
import { AUTO_CONTRACT_VARIABLES, QUOTE_ONLY_CONTRACT_VARIABLES } from '@breeze/shared';

// contractTemplateRender imports '../db'; keep the real pool out of a pure test.
vi.mock('../db', () => ({
  db: { select: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

import { resolveAutoVariables } from './contractTemplateRender';

// Drift guard for #9296: the web record-signed dialog uses the shared
// QUOTE_ONLY_CONTRACT_VARIABLES list to tell, before submit, which declared
// auto variables a quote-less render cannot fill. If the resolver starts
// resolving (or stops resolving) a key without a quote, this must fail so the
// shared list moves with it.
describe('resolveAutoVariables vs the shared auto/quote-only lists (#9296)', () => {
  const base = {
    clientName: 'Acme', clientAddress: null, sellerName: 'MSP', currencyCode: 'USD', renderLocale: 'en',
    effectiveDate: '2026-10-01',
  };

  it('without a quote, resolves exactly AUTO_CONTRACT_VARIABLES minus QUOTE_ONLY_CONTRACT_VARIABLES', () => {
    const keys = Object.keys(resolveAutoVariables(base)).sort();
    const expected = AUTO_CONTRACT_VARIABLES.filter((n) => !QUOTE_ONLY_CONTRACT_VARIABLES.includes(n)).sort();
    expect(keys).toEqual(expected);
  });

  it('with a quote, resolves every AUTO_CONTRACT_VARIABLES entry', () => {
    const keys = Object.keys(resolveAutoVariables({
      ...base,
      quote: {
        number: 'Q-1', title: 'T', expiryDate: '2026-11-01',
        totals: { oneTime: '0.00', monthly: '0.00', annual: '0.00', total: '0.00' },
      },
    })).sort();
    expect(keys).toEqual([...AUTO_CONTRACT_VARIABLES].sort());
  });
});
