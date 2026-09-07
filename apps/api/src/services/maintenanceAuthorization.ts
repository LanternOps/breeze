import { eq } from 'drizzle-orm';
import type { db } from '../db';
import { users } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { StepUpGrantBinding } from './mfaStepUpGrant';

/** Hold the actor's auth state stable until the device transaction commits.
 * Factor resets update this row, so a reset that wins the lock invalidates
 * admission; one that follows the lock cannot complete before the write.
 */
export async function lockMaintenanceAssurance(
  tx: Pick<typeof db, 'select'>,
  auth: AuthContext,
  binding: StepUpGrantBinding,
): Promise<boolean> {
  const [actor] = await tx.select({
    authEpoch: users.authEpoch,
    mfaEpoch: users.mfaEpoch,
    status: users.status,
  }).from(users).where(eq(users.id, auth.user.id)).limit(1).for('share');
  return actor?.status === 'active'
    && actor.authEpoch === binding.authEpoch
    && actor.mfaEpoch === binding.mfaEpoch
    && auth.token?.aep === actor.authEpoch
    && auth.token?.mep === actor.mfaEpoch;
}
