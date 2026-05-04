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

export async function isPasswordAuthDisabledBySso(context: Pick<UserTokenContext, 'scope' | 'orgId'>): Promise<boolean> {
  if (context.scope !== 'organization' || !context.orgId) {
    return false;
  }

  const orgId = context.orgId;
  const [provider] = await withSystemDbAccessContext(async () =>
    db
      .select({ id: ssoProviders.id })
      .from(ssoProviders)
      .where(
        and(
          eq(ssoProviders.orgId, orgId),
          eq(ssoProviders.status, 'active'),
          eq(ssoProviders.enforceSSO, true)
        )
      )
      .limit(1)
  );

  return Boolean(provider);
}

export async function assertPasswordAuthAllowedBySso(
  context: Pick<UserTokenContext, 'scope' | 'orgId'>
): Promise<void> {
  if (await isPasswordAuthDisabledBySso(context)) {
    throw new SsoPasswordAuthRequiredError();
  }
}
