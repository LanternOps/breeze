import { describe, expect, it, vi } from 'vitest';

// The source keeps provider modules out of the reconciler's import graph, so it
// states the provider lists and the reconcile-error prefix as literals. These
// guards tie the literals to the registry and the service (#9127).
vi.mock('../../../db', async () => {
  const { QueryBuilder } = await import('drizzle-orm/pg-core');
  return { db: new QueryBuilder(), withSystemDbAccessContext: vi.fn() };
});

import { DAILY_BUDGET_PROVIDERS, RECONCILE_ERROR_PREFIX, RECONCILED_PROVIDERS } from './accounting';
import { findAccountingProvider, providerSupports } from '../../accounting/providerRegistry';
import { RECONCILE_RUN_ERROR_PREFIX } from '../../accounting/accountingConnectionService';
import { ACCOUNTING_PROVIDER_IDS } from '../../accounting/types';

const ALL_PROVIDERS = ACCOUNTING_PROVIDER_IDS;

describe('accounting source literals', () => {
  it('reconciled providers are exactly the ones whose sweep pulls payments', () => {
    expect([...RECONCILED_PROVIDERS].sort()).toEqual(ALL_PROVIDERS.filter((p) => providerSupports(p, 'paymentPull')).sort());
  });

  it('daily-budget providers are exactly the ones declaring a daily call budget', () => {
    expect([...DAILY_BUDGET_PROVIDERS].sort()).toEqual(
      ALL_PROVIDERS.filter((p) => findAccountingProvider(p)?.limits.rate.dailyPerConnection != null).sort(),
    );
  });

  it('the reconcile-error prefix matches the one the service stamps', () => {
    expect(RECONCILE_ERROR_PREFIX).toBe(RECONCILE_RUN_ERROR_PREFIX);
  });
});
