import { and, eq, isNull } from 'drizzle-orm';
import { organizations } from '../db/schema';

export function organizationLifecycleWriteCondition(
  auth: { scope: string; partnerId: string | null; orgId: string | null },
  organizationId: string,
) {
  return and(
    eq(organizations.id, organizationId),
    isNull(organizations.deletedAt),
    auth.scope === 'partner'
      ? eq(organizations.partnerId, auth.partnerId!)
      : auth.orgId
        ? eq(organizations.id, auth.orgId)
        : undefined,
  );
}
