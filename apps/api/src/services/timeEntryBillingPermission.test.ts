import { describe, expect, it } from 'vitest';
import type { AuthContext } from '../middleware/auth';
import type { UserPermissions } from './permissions';
import { canManageTimeEntryBilling } from './timeEntryBillingPermission';

const grants = (resource: string, action: string) => ({ permissions: [{ resource, action }] }) as UserPermissions;
const auth = (kind: AuthContext['principal']['kind'], isPlatformAdmin = false) => ({
  principal: { kind }, user: { isPlatformAdmin },
}) as AuthContext;

describe('canManageTimeEntryBilling', () => {
  it.each(['user_session', 'oauth_grant'] as const)('uses the %s actor’s dedicated permission or wildcard grant', kind => {
    expect(canManageTimeEntryBilling(auth(kind), grants('time_entries', 'write'))).toBe(false);
    expect(canManageTimeEntryBilling(auth(kind), grants('time_entries', 'manage_billing'))).toBe(true);
    expect(canManageTimeEntryBilling(auth(kind), grants('*', '*'))).toBe(true);
    expect(canManageTimeEntryBilling(auth(kind), null)).toBe(false);
    expect(canManageTimeEntryBilling(auth(kind, true), null)).toBe(true);
  });
  it.each(['system', 'ai_agent', 'agent', 'helper', 'unknown', 'api_key', 'client_user'] as const)(
    '%s cannot inherit a billing override from platform or creator authority', kind => {
      expect(canManageTimeEntryBilling(auth(kind, true), grants('*', '*'))).toBe(false);
    },
  );
});
