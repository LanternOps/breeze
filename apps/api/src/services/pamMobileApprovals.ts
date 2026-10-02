/**
 * PAM mobile bridge (#1254): retiring the approval_requests rows a
 * uac_intercept elevation fanned out to approvers' phones once the elevation
 * itself has been decided somewhere else (the web console).
 */
import { and, eq, exists, ne, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { approvalRequests, elevationRequests } from '../db/schema';

/**
 * Expire every still-pending approval row linked to `elevationId`, but only
 * once the elevation is no longer pending. Returns the number of rows expired.
 *
 * System scope: approval_requests is Shape-6 (user-id-scoped), so the rows
 * belong to the fanned-out approvers and are invisible to the deciding user's
 * own context. Takes only approval_requests row locks — never the elevation —
 * and is meant to run after the transaction that decided the elevation has
 * committed (#7526: elevation first, then approval rows). The pending-elevation
 * guard makes it a no-op when that transaction rolled back instead.
 */
export async function expireSupersededMobileApprovals(elevationId: string): Promise<number> {
  return withSystemDbAccessContext(async () => {
    const expired = await db
      .update(approvalRequests)
      .set({ status: 'expired' })
      .where(
        and(
          eq(approvalRequests.elevationRequestId, elevationId),
          eq(approvalRequests.status, 'pending'),
          exists(
            db
              .select({ one: sql`1` })
              .from(elevationRequests)
              .where(and(eq(elevationRequests.id, elevationId), ne(elevationRequests.status, 'pending'))),
          ),
        ),
      )
      .returning({ id: approvalRequests.id });
    return expired.length;
  });
}
