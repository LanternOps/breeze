/**
 * Asks for a policy-side refresh (#11242) after a config write that can change which
 * vendor updates link wins for a device: an `oem_updates` link added, changed or
 * removed, an assignment of a policy carrying one added or removed, such a policy
 * switched on or off, or deleted. The fleet view then shows the new state within
 * seconds instead of at the next worker tick.
 *
 * Kept apart from the store and the worker so configurationPolicy.ts pulls in no queue
 * or worker code: the worker module is imported only once the write has committed.
 */
import { and, eq } from 'drizzle-orm';
import { runAfterDbContextCommit, withSystemDbAccessContext, db } from '../../db';
import { configPolicyEffectiveFeatureLinks, configurationPolicies } from '../../db/schema';
import { captureException } from '../sentry';
import { oemUpdatesFlagOn } from './flags';

export type OemPolicySideRefreshScope = { partnerId: string } | { orgId: string };

export type OemPolicySideRefreshTarget =
  | OemPolicySideRefreshScope
  /**
   * Resolved to the policy's owner once the write has committed. `onlyIfOemLinked`
   * skips policies with no effective `oem_updates` link: an assignment of an unrelated
   * policy changes no device's vendor updates.
   */
  | { configPolicyId: string; onlyIfOemLinked?: boolean };

/** The owner whose devices a policy can reach, or null when there is nothing to refresh. */
export async function resolveOemPolicySideRefreshScope(
  target: OemPolicySideRefreshTarget,
): Promise<OemPolicySideRefreshScope | null> {
  if (!('configPolicyId' in target)) return target;
  return withSystemDbAccessContext(async () => {
    const [policy] = await db
      .select({ orgId: configurationPolicies.orgId, partnerId: configurationPolicies.partnerId })
      .from(configurationPolicies)
      .where(eq(configurationPolicies.id, target.configPolicyId))
      .limit(1);
    if (!policy) return null;
    if (target.onlyIfOemLinked) {
      const [link] = await db
        .select({ id: configPolicyEffectiveFeatureLinks.id })
        .from(configPolicyEffectiveFeatureLinks)
        .where(and(
          eq(configPolicyEffectiveFeatureLinks.configPolicyId, target.configPolicyId),
          eq(configPolicyEffectiveFeatureLinks.featureType, 'oem_updates'),
        ))
        .limit(1);
      if (!link) return null;
    }
    if (policy.orgId) return { orgId: policy.orgId };
    return policy.partnerId ? { partnerId: policy.partnerId } : null;
  });
}

/**
 * Enqueues the refresh once the caller's transaction has COMMITTED; a rolled-back write
 * asks for nothing. Never throws: the config write must not fail over this, and the
 * worker's tick refreshes every device within one interval anyway.
 */
export function scheduleOemPolicySideRefresh(target: OemPolicySideRefreshTarget, trigger: string): void {
  if (!oemUpdatesFlagOn()) return;
  try {
    runAfterDbContextCommit(`oemPolicySideRefresh.${trigger}`, async () => {
      try {
        const scope = await resolveOemPolicySideRefreshScope(target);
        if (!scope) return;
        const { requestOemPolicySideRefresh } = await import('../../jobs/oemUpdatesWorker');
        await requestOemPolicySideRefresh(scope);
      } catch (error) {
        console.error(`[OemUpdates] policy side refresh after ${trigger} not requested; the next tick covers it:`, error);
        captureException(error instanceof Error ? error : new Error(String(error)), undefined, {
          stage: 'policy side trigger',
          trigger,
        });
      }
    });
  } catch (error) {
    console.error(`[OemUpdates] could not schedule a policy side refresh after ${trigger}; the next tick covers it:`, error);
    captureException(error instanceof Error ? error : new Error(String(error)), undefined, {
      stage: 'policy side trigger',
      trigger,
    });
  }
}
