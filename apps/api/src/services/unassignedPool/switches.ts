/**
 * The two switches for deploy-key enrollment into a partner's holding area:
 * the platform flag PRE_ASSIGNMENT_ENROLLMENT_ENABLED and the partner's own
 * `partners.deploy_key_enrollment_enabled`. Enrollment runs only when BOTH
 * are on; either one off is a kill switch. Both default off.
 */
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { partners } from '../../db/schema';
import { preAssignmentEnrollmentEnabled } from '../../config/env';

export function preAssignmentPlatformEnabled(): boolean {
  return preAssignmentEnrollmentEnabled();
}

/**
 * Reads the partner column in a fresh system context: the caller (the
 * enrollment path) has no user context, and the answer must not depend on
 * one. The platform flag is checked first, so with it off nothing is read.
 */
export async function isDeployKeyEnrollmentEnabled(partnerId: string): Promise<boolean> {
  if (!preAssignmentPlatformEnabled()) return false;
  const [row] = await runOutsideDbContext(() => withSystemDbAccessContext(() => db
    .select({ enabled: partners.deployKeyEnrollmentEnabled })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1)));
  return row?.enabled === true;
}
