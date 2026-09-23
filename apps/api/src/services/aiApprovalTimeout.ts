import { eq } from 'drizzle-orm';
import {
  AI_APPROVAL_TIMEOUT_DEFAULT_MINUTES,
  resolveAiApprovalTimeout,
  type ResolvedAiApprovalTimeout,
} from '@breeze/shared';
import { db } from '../db';
import { readWithPartnerAxisVisibility } from '../db/partnerAxisRead';
import { organizations, partners } from '../db/schema';
import { captureException } from './sentry';

/**
 * Interactive AI approval timeout for an org (#6475).
 *
 * Partner default (`partners.settings.aiApprovals`) -> org override
 * (`organizations.settings.aiApprovals`), ORG WINS, then the 5-minute product
 * default. All precedence lives in the shared `resolveAiApprovalTimeout`; this
 * only loads the two settings blobs.
 *
 * Deliberately NOT routed through `getEffectiveOrgSettings` /
 * `getEffectiveAiBudget`: those make a partner-set value win over (and lock)
 * the org, which is the wrong model for an inherit-with-override setting.
 *
 * Two reads, same split as `loadMlFlagInputs` (mlFeatureFlags.ts, #2822): the
 * `organizations` row stays in the caller's RLS context; the `partners` row
 * (partner-axis) goes through `readWithPartnerAxisVisibility`, pinned to the
 * partnerId of the org row the caller could already see.
 *
 * Returns null when the org is not visible to the caller.
 */
export async function getAiApprovalTimeout(orgId: string): Promise<ResolvedAiApprovalTimeout | null> {
  const [org] = await db
    .select({ settings: organizations.settings, partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) return null;

  const [partner] = await readWithPartnerAxisVisibility(() =>
    db
      .select({ settings: partners.settings })
      .from(partners)
      .where(eq(partners.id, org.partnerId))
      .limit(1)
  );

  return resolveAiApprovalTimeout(partner?.settings, org.settings);
}

export const DEFAULT_APPROVAL_WAIT_BUDGET_MS = AI_APPROVAL_TIMEOUT_DEFAULT_MINUTES * 60_000;

/**
 * The per-assistant-cycle approval-wait budget for a chat session, in ms.
 *
 * Fail-safe: any lookup failure (or an invisible org) yields the 5-minute
 * default — the pre-#6475 behaviour and the shortest allowed window — so a
 * settings read error can never stretch a turn's blocking time.
 */
export async function loadApprovalWaitBudgetMs(orgId: string): Promise<number> {
  try {
    const resolved = await getAiApprovalTimeout(orgId);
    return resolved ? resolved.minutes * 60_000 : DEFAULT_APPROVAL_WAIT_BUDGET_MS;
  } catch (err) {
    captureException(err);
    console.error('[aiApprovalTimeout] Failed to resolve approval timeout, using default:', err);
    return DEFAULT_APPROVAL_WAIT_BUDGET_MS;
  }
}
