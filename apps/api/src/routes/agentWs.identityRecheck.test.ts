/**
 * #8318 §6.4 "Live sockets" (F5): the lease re-check compares the row's
 * identity (id, org, site, partner) with the socket's cached context.
 * The pure comparison is unit-tested here; the real-PostgreSQL proof is in
 * __tests__/integration/reattachStaleCallers.integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { agentSocketIdentityMatches } from './agentWs';

const identity = { deviceId: 'dev-1', orgId: 'org-1', siteId: 'site-1', partnerId: 'partner-1' };
const row = { id: 'dev-1', orgId: 'org-1', siteId: 'site-1', partnerId: 'partner-1' };

describe('agentSocketIdentityMatches', () => {
  it('matches when every identity column equals the cached context', () => {
    expect(agentSocketIdentityMatches(row, identity)).toBe(true);
  });

  it.each([
    ['device id (the row was reattached / re-created)', { ...row, id: 'dev-2' }],
    ['org (the device moved org)', { ...row, orgId: 'org-2' }],
    ['site (the device moved site)', { ...row, siteId: 'site-2' }],
    ['partner (the org changed hands)', { ...row, partnerId: 'partner-2' }],
    ['a NULL partner', { ...row, partnerId: null }],
  ])('denies when the %s differs', (_label, changed) => {
    expect(agentSocketIdentityMatches(changed, identity)).toBe(false);
  });

  it('keeps the handler-test seam: a mocked row that reports no identity column at all skips the comparison', () => {
    expect(agentSocketIdentityMatches({}, identity)).toBe(true);
    // ...but a row that reports even one of them is compared in full.
    expect(agentSocketIdentityMatches({ id: 'dev-1' }, identity)).toBe(false);
  });
});
