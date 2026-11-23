import type { AuthContext } from '../../middleware/auth';

// Shared by every /unifi route file: which partner a request acts for. The
// capability guard (canManagePartnerWidePolicies) is applied once, in
// routes/unifi/index.ts, to everything mounted there. Each route file declares
// its own requirePermission aliases: the AI route-binding contract
// (aiGuardrails.routeBinding.contract.test.ts) resolves same-file aliases only.

type RouteAuth = Pick<AuthContext, 'scope' | 'partnerId' | 'orgId' | 'partnerOrgAccess' | 'canAccessOrg'>;

export function requestedPartnerId(c: { req: { query: (key: string) => string | undefined } }): string | undefined {
  return c.req.query('partnerId');
}

export function resolvePartnerId(auth: RouteAuth, requested?: string): { partnerId: string } | { error: string; status: 400 | 403 } {
  if (auth.scope === 'partner') {
    if (!auth.partnerId) return { error: 'Partner context required', status: 403 };
    if (requested && requested !== auth.partnerId) return { error: 'Access to this partner denied', status: 403 };
    return { partnerId: auth.partnerId };
  }
  if (auth.scope === 'organization') {
    return { error: 'UniFi network integrations are managed at partner scope', status: 403 };
  }
  if (!requested) return { error: 'partnerId is required for system scope', status: 400 };
  return { partnerId: requested };
}
