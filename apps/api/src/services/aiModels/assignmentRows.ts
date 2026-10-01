import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { aiModelAssignments, type AiModelAssignmentRow } from '../../db/schema';

/**
 * Raw partner rows (orgId omitted/null) or one org's override rows, in the
 * ambient DB context (the caller's RLS, or the write's system transaction).
 * Every branch is pinned to partnerId, so a system-context read never crosses
 * tenants.
 */
export async function listAssignmentRows(input: { partnerId: string; orgId?: string | null }): Promise<AiModelAssignmentRow[]> {
  const owner = input.orgId
    ? and(eq(aiModelAssignments.orgId, input.orgId), eq(aiModelAssignments.offeringPartnerId, input.partnerId))
    : and(isNull(aiModelAssignments.orgId), eq(aiModelAssignments.partnerId, input.partnerId));
  return db.select().from(aiModelAssignments).where(owner);
}
