import { beforeEach, describe, expect, it, vi } from 'vitest';

import { applyOrgId, fetchWithAuth } from '../../stores/auth';
import { listContractHourPeriods } from './contracts';

vi.mock('../../stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../stores/auth')>()),
  fetchWithAuth: vi.fn(),
}));

describe('listContractHourPeriods', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchWithAuth).mockResolvedValue(new Response());
  });

  // The route's query schema is .strict() and the contract is resolved by id
  // under the caller's tenant access, so the header switcher's ambient orgId
  // must not be appended (it 400s with `Unrecognized key: "orgId"`).
  it('opts out of ambient orgId injection so the strict query schema accepts the request', () => {
    void listContractHourPeriods('contract-1', { limit: 12 });

    const [url, init] = vi.mocked(fetchWithAuth).mock.calls[0];
    expect(url).toBe('/contracts/contract-1/hour-periods?limit=12');
    expect(init).toMatchObject({ skipOrgIdInjection: true });

    const sent = applyOrgId(String(url), { ...(init as object), ambient: 'org-selected' });
    expect(sent).not.toContain('orgId');
  });
});
