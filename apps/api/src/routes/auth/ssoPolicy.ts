import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { ssoProviders } from '../../db/schema';
import type { UserTokenContext } from './schemas';

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
