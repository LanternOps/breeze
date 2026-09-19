import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { ssoProviders } from '../../db/schema';
import type { UserTokenContext } from './schemas';

// SCOPE OF THIS GATE (#4067): assertPasswordAuthAllowedBySso blocks password
// USE — login (/auth/login) and password changes (/auth/change-password) —
// when the tenant enforces SSO. The link-on-first-SSO-login ceremony
// (/sso/link/confirm and its MFA continuation) deliberately does NOT consult
// it: its password check only ever runs downstream of a successful, verified
// IdP assertion, so it is proof-of-account-ownership for creating the SSO
// link — not a password login, and not a bypass of enforce_sso. Without that
// exemption, enforce_sso is a hard lockout for every password-holding user
// whose account isn't linked yet (#4067 documents the two full-tenant
// lockouts, 2026-08-17 and 2026-08-26, that motivated the ceremony).
export class SsoPasswordAuthRequiredError extends Error {
  constructor(message = 'SSO is required for this organization') {
    super(message);
    this.name = 'SsoPasswordAuthRequiredError';
  }
}

export async function isPasswordAuthDisabledBySso(
  context: Pick<UserTokenContext, 'scope' | 'orgId' | 'partnerId'>
): Promise<boolean> {
  if (context.scope === 'organization' && context.orgId) {
    const orgId = context.orgId;
    const [provider] = await withSystemDbAccessContext(async () =>
      db
        .select({ id: ssoProviders.id })
        .from(ssoProviders)
        .where(and(
          eq(ssoProviders.orgId, orgId),
          eq(ssoProviders.status, 'active'),
          eq(ssoProviders.enforceSSO, true)
        ))
        .limit(1)
    );
    return Boolean(provider);
  }

  if (context.scope === 'partner' && context.partnerId) {
    const partnerId = context.partnerId;
    const [provider] = await withSystemDbAccessContext(async () =>
      db
        .select({ id: ssoProviders.id })
        .from(ssoProviders)
        .where(and(
          eq(ssoProviders.partnerId, partnerId),
          eq(ssoProviders.status, 'active'),
          eq(ssoProviders.enforceSSO, true)
        ))
        .limit(1)
    );
    return Boolean(provider);
  }

  return false;
}

export async function assertPasswordAuthAllowedBySso(
  context: Pick<UserTokenContext, 'scope' | 'orgId' | 'partnerId'>
): Promise<void> {
  if (await isPasswordAuthDisabledBySso(context)) {
    throw new SsoPasswordAuthRequiredError();
  }
}
