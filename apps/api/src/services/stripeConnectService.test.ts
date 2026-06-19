// apps/api/src/services/stripeConnectService.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Only the account-keyed read survives the move to the API-key model; the OAuth
// flow (buildOAuthUrl/completeOAuth/consumeState) was removed. No Stripe/Redis/config
// mocks are needed anymore — just the db read.
const selectRows = vi.hoisted(() => ({ value: [] as unknown[] }));
vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(selectRows.value) }) }),
    })),
  },
  withSystemDbAccessContext: (fn: () => Promise<unknown>) => fn(),
}));

import { getConnectionByAccount } from './stripeConnectService';

describe('getConnectionByAccount', () => {
  beforeEach(() => { selectRows.value = []; });

  it('returns the row for a known account (read in system context)', async () => {
    selectRows.value = [{ partnerId: 'p1', stripeAccountId: 'acct_5', livemode: true, status: 'connected' }];
    const row = await getConnectionByAccount('acct_5');
    expect(row).toMatchObject({ partnerId: 'p1', livemode: true });
  });

  it('returns null for an unknown account', async () => {
    selectRows.value = [];
    const row = await getConnectionByAccount('acct_missing');
    expect(row).toBeNull();
  });
});
