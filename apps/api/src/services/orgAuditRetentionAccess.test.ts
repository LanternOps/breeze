import { beforeEach, describe, expect, it, vi } from 'vitest';

const queue: unknown[][] = [];
const selects: unknown[] = [];
function chain(): unknown {
  const target = {
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(queue.shift() ?? []).then(resolve, reject),
  };
  return new Proxy(target, { get: (t, prop) => (prop === 'then' ? t.then : () => chain()) });
}
vi.mock('../db', () => ({ db: { select: (cols: unknown) => { selects.push(cols); return chain(); } } }));

import { canAccessOrgAuditRetention } from './orgAuditRetentionAccess';

const ORG = 'o-1';
const OTHER = 'o-2';

beforeEach(() => {
  queue.length = 0;
  selects.length = 0;
});

describe('canAccessOrgAuditRetention (W18, #6789; #5423 rule)', () => {
  it('an organization caller reaches its own org (CONTROL)', async () => {
    queue.push([{ id: ORG }]);
    expect(await canAccessOrgAuditRetention({ scope: 'organization', orgId: ORG, canAccessOrg: () => true } as never, ORG)).toBe(true);
  });

  it('an organization caller naming another org is refused without touching the table, even if its allowlist admits it', async () => {
    expect(await canAccessOrgAuditRetention({ scope: 'organization', orgId: ORG, canAccessOrg: () => true } as never, OTHER)).toBe(false);
    expect(selects).toHaveLength(0);
  });

  it('a partner outside its allowlist is refused without touching the table', async () => {
    expect(await canAccessOrgAuditRetention({ scope: 'partner', orgId: null, canAccessOrg: () => false } as never, ORG)).toBe(false);
    expect(selects).toHaveLength(0);
  });

  it('a deleted or missing org is refused; system scope skips only the allowlist', async () => {
    queue.push([]);
    expect(await canAccessOrgAuditRetention({ scope: 'partner', orgId: null, canAccessOrg: () => true } as never, ORG)).toBe(false);
    queue.push([{ id: ORG }]);
    expect(await canAccessOrgAuditRetention({ scope: 'system', orgId: null, canAccessOrg: () => false } as never, ORG)).toBe(true);
  });
});
