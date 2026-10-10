import { describe, expect, it } from 'vitest';
import {
  PARTNER_SERVICE_PRINCIPAL_SCOPE_PERMISSIONS,
  validatePartnerServicePrincipalScopeDelegation,
} from './partnerServicePrincipalDelegation';
import { PARTNER_SERVICE_PRINCIPAL_SCOPES } from './partnerServicePrincipalScopes';
import type { UserPermissions } from './permissions';

function perms(...pairs: Array<[string, string]>): UserPermissions {
  return {
    permissions: pairs.map(([resource, action]) => ({ resource, action })),
    partnerId: 'p-1',
    orgId: null,
    roleId: 'r-1',
    scope: 'partner',
  } as UserPermissions;
}

describe('partner service principal scope delegation', () => {
  it('maps every grantable scope to at least one permission', () => {
    for (const scope of PARTNER_SERVICE_PRINCIPAL_SCOPES) {
      expect(PARTNER_SERVICE_PRINCIPAL_SCOPE_PERMISSIONS[scope]?.length, scope).toBeGreaterThan(0);
    }
  });

  it.each([
    ['tickets:read', 'tickets', 'read'],
    ['tickets:write', 'tickets', 'write'],
    ['alerts:read', 'alerts', 'read'],
    ['contracts:write', 'contracts', 'write'],
    ['device-status:read', 'devices', 'read'],
    ['backup-configuration:read', 'backup', 'read'],
    ['sites:write', 'sites', 'write'],
  ])('refuses %s for a granter without %s.%s', (scope, resource, action) => {
    const result = validatePartnerServicePrincipalScopeDelegation(
      [scope],
      perms(['organizations', 'write'], ['organizations', 'read']),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
    expect(result.error).toContain(scope);
    expect(result.details).toMatchObject({ scope, requiredPermission: { resource, action } });
  });

  it('accepts scopes the granter holds', () => {
    const result = validatePartnerServicePrincipalScopeDelegation(
      ['tickets:read', 'tickets:write', 'organizations:read'],
      perms(['tickets', 'read'], ['tickets', 'write'], ['organizations', 'read']),
    );
    expect(result).toEqual({ ok: true });
  });

  it('keeps the MCP scope baselines an org API key uses', () => {
    const lacking = validatePartnerServicePrincipalScopeDelegation(
      ['ai:read', 'ai:execute_admin'],
      perms(['devices', 'read'], ['alerts', 'read'], ['scripts', 'read'], ['automations', 'read']),
    );
    expect(lacking.ok).toBe(false);
    const holding = validatePartnerServicePrincipalScopeDelegation(
      ['ai:read', 'ai:execute_admin'],
      perms(['*', '*']),
    );
    expect(holding).toEqual({ ok: true });
  });

  it('fails closed without resolved permissions', () => {
    const result = validatePartnerServicePrincipalScopeDelegation(['organizations:read'], undefined);
    expect(result.ok).toBe(false);
  });
});
