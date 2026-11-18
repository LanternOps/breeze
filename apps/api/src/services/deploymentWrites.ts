import { db } from '../db';
import { deployments } from '../db/schema';
import {
  canMutateOrgWideGovernance,
  SiteCeilingWriteDeniedError,
  type SiteCeilingAuth,
} from './siteCeilingAccess';

/**
 * Shared creation path for generic deployments (`deployments` table), used by
 * both `POST /deployments` and the `manage_deployments` AI tool.
 *
 * A deployment has no site of its own: its target (`all`, a filter, groups or
 * a device list) is resolved against the whole organization when it is
 * initialized, so creating, editing or driving one is an organization-wide
 * change gated by `canMutateOrgWideGovernance`. Callers carrying a site or
 * exact-device ceiling may read the deployments their sites cover, and retry
 * their own failed member devices, but may not create or change a deployment.
 */

export type DraftDeploymentValues = Omit<typeof deployments.$inferInsert, 'id' | 'status'>;

/**
 * Insert a deployment in `draft` status. Throws `SiteCeilingWriteDeniedError`
 * before any database access when the caller may not change deployments.
 */
export async function createDraftDeployment(
  auth: SiteCeilingAuth,
  values: DraftDeploymentValues,
): Promise<typeof deployments.$inferSelect | undefined> {
  if (!canMutateOrgWideGovernance(auth)) throw new SiteCeilingWriteDeniedError();
  const [deployment] = await db
    .insert(deployments)
    .values({ ...values, status: 'draft' })
    .returning();
  return deployment;
}
