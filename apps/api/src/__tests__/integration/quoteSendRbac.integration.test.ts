import './setup';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS, hasPermission, type UserPermissions } from '../../services/permissions';

// The previously-dead quotes:send permission now gates POST /:id/send. The
// behavioral, route-level guarantee (a read+write user gets 403; the route is
// gated on quotes:send, not quotes:write) is enforced by the REAL middleware
// chain in routes/quotes/lifecycle.test.ts. This file pins the authorization
// DECISION function that requirePermission delegates to — hasPermission — so a
// regression in the grant logic (or the QUOTES_SEND constant) is caught too.
function userWith(grants: { resource: string; action: string }[]): UserPermissions {
  return { permissions: grants, partnerId: 'p1', orgId: null, roleId: 'r1', scope: 'partner' };
}

describe('quotes:send authorization (hasPermission)', () => {
  it('a quotes:read + quotes:write user is NOT authorized to send', () => {
    const user = userWith([PERMISSIONS.QUOTES_READ, PERMISSIONS.QUOTES_WRITE]);
    expect(hasPermission(user, PERMISSIONS.QUOTES_SEND.resource, PERMISSIONS.QUOTES_SEND.action)).toBe(false);
  });

  it('a quotes:send holder IS authorized to send', () => {
    const user = userWith([PERMISSIONS.QUOTES_READ, PERMISSIONS.QUOTES_WRITE, PERMISSIONS.QUOTES_SEND]);
    expect(hasPermission(user, PERMISSIONS.QUOTES_SEND.resource, PERMISSIONS.QUOTES_SEND.action)).toBe(true);
  });

  it('quotes:send is a distinct action from write (the route must not gate on write)', () => {
    expect(PERMISSIONS.QUOTES_SEND.action).toBe('send');
    expect(PERMISSIONS.QUOTES_SEND.action).not.toBe(PERMISSIONS.QUOTES_WRITE.action);
  });
});
