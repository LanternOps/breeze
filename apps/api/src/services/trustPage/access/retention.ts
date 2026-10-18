// Owner: W02d (access-request retention: requester PII 365 days after the last state change, tokens 30 days
// after expiry — Open Decision 8). Called by the hourly trust-page sweep (jobs/trustPageSnapshotWorker.ts) in its
// own try/catch, OUTSIDE any db context: this function owns its `runOutsideDbContext(() =>
// withSystemDbAccessContext(...))`, or its deletes would match zero rows under forced RLS.
import { and, eq, gt, lt, not } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../../db';
import { trustPageAccessRequests, trustPageAccessTokens } from '../../../db/schema';

export const TRUST_ACCESS_REQUEST_RETENTION_DAYS = 365;
export const TRUST_ACCESS_TOKEN_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;

export async function pruneTrustAccessData(now: Date): Promise<{ tokens: number; requests: number }> {
  const tokenCutoff = new Date(now.getTime() - TRUST_ACCESS_TOKEN_RETENTION_DAYS * DAY_MS);
  const requestCutoff = new Date(now.getTime() - TRUST_ACCESS_REQUEST_RETENTION_DAYS * DAY_MS);
  return runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const tokens = await db.delete(trustPageAccessTokens)
      .where(lt(trustPageAccessTokens.expiresAt, tokenCutoff))
      .returning({ id: trustPageAccessTokens.id });
    // A grant still in force is kept whatever its age (an approval is its last state change; downloads are not).
    // The request's remaining tokens cascade with it (FK ON DELETE CASCADE).
    const requests = await db.delete(trustPageAccessRequests)
      .where(and(
        lt(trustPageAccessRequests.updatedAt, requestCutoff),
        not(and(eq(trustPageAccessRequests.status, 'approved'), gt(trustPageAccessRequests.grantExpiresAt, now))!),
      ))
      .returning({ id: trustPageAccessRequests.id });
    return { tokens: tokens.length, requests: requests.length };
  }));
}
