import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';

const { readRows, selectSpy } = vi.hoisted(() => ({ readRows: { value: [] as Array<{ id: string }> }, selectSpy: vi.fn() }));

vi.mock('../db', () => ({
  db: {
    select: (...args: unknown[]) => {
      selectSpy(...args);
      const chain: any = { from: () => chain, where: () => Promise.resolve(readRows.value) };
      return chain;
    },
  },
}));

vi.mock('./configPolicyReadScope', () => ({ policyReadCondition: vi.fn(() => sql`READ`) }));

import type { AuthContext } from '../middleware/auth';
import { keepReadablePolicies } from './configPolicyReadable';
import { policyReadCondition } from './configPolicyReadScope';

const rows = [
  { name: 'org-owned', id: 'p-org', orgId: 'org-a' },
  { name: 'msp-readable', id: 'p-msp-1', orgId: null },
  { name: 'msp-hidden', id: 'p-msp-2', orgId: null },
];
const pick = (r: (typeof rows)[number]) => ({ id: r.id, orgId: r.orgId });
const limited = { scope: 'partner', partnerId: 'pt', partnerOrgAccess: 'selected' } as AuthContext;

beforeEach(() => {
  selectSpy.mockClear();
  vi.mocked(policyReadCondition).mockClear();
});

describe('keepReadablePolicies', () => {
  it('drops a partner-owned policy the read predicate does not admit and keeps org-owned rows', async () => {
    readRows.value = [{ id: 'p-msp-1' }];
    const kept = await keepReadablePolicies(limited, rows, pick);
    expect(kept.map((r) => r.name)).toEqual(['org-owned', 'msp-readable']);
    expect(policyReadCondition).toHaveBeenCalledWith(limited);
  });

  it('applies to an org-scope caller the same way', async () => {
    readRows.value = [];
    const kept = await keepReadablePolicies({ scope: 'organization', partnerId: 'pt' } as AuthContext, rows, pick);
    expect(kept.map((r) => r.name)).toEqual(['org-owned']);
  });

  it('skips the read for system scope, a full-access partner and a page with no partner-owned row', async () => {
    expect(await keepReadablePolicies({ scope: 'system' } as AuthContext, rows, pick)).toHaveLength(3);
    expect(await keepReadablePolicies({ ...limited, partnerOrgAccess: 'all' } as AuthContext, rows, pick)).toHaveLength(3);
    expect(await keepReadablePolicies(limited, [rows[0]!], pick)).toHaveLength(1);
    expect(selectSpy).not.toHaveBeenCalled();
  });
});
