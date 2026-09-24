import { z } from 'zod';

/**
 * Interactive AI approval timeout (#6475).
 *
 * How long a live AI chat turn blocks waiting for someone to approve a gated
 * (Tier 2/3) tool call before giving up on it. Configurable 5-60 minutes:
 * the wait holds the chat turn open, so it is deliberately NOT a 24-hour
 * value — long-running / unattended work belongs in the durable approvals
 * queue, which has its own expiry.
 *
 * Stored as `settings.aiApprovals.interactiveTimeoutMinutes` on BOTH
 * `partners.settings` (partner default) and `organizations.settings` (org
 * override). Resolution is inherit-with-override: the org value WINS when set,
 * the partner value fills the gap, then the product default. This is NOT the
 * partner-locks model of `getEffectiveOrgSettings` / `aiBudgets`.
 */
export const AI_APPROVAL_TIMEOUT_MIN_MINUTES = 5;
export const AI_APPROVAL_TIMEOUT_MAX_MINUTES = 60;
export const AI_APPROVAL_TIMEOUT_DEFAULT_MINUTES = 5;

const timeoutMinutesSchema = z
  .number()
  .int()
  .min(AI_APPROVAL_TIMEOUT_MIN_MINUTES)
  .max(AI_APPROVAL_TIMEOUT_MAX_MINUTES);

/**
 * Write-boundary schema for the `aiApprovals` settings block (partner and org).
 * Omit `interactiveTimeoutMinutes` (or send `{}`) to inherit.
 */
export const aiApprovalSettingsSchema = z
  .object({
    interactiveTimeoutMinutes: timeoutMinutesSchema.optional(),
  })
  .strict();

export type AiApprovalSettings = z.infer<typeof aiApprovalSettingsSchema>;

export type AiApprovalTimeoutSource = 'org' | 'partner' | 'default';

export interface ResolvedAiApprovalTimeout {
  /** Effective timeout for the org, in minutes. */
  minutes: number;
  source: AiApprovalTimeoutSource;
  /** What the org would get with no override (partner value or default) — for the "Inherit (…)" label. */
  inheritedMinutes: number;
  inheritedSource: Exclude<AiApprovalTimeoutSource, 'org'>;
}

function readTimeout(settings: unknown): number | undefined {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return undefined;
  const block = (settings as Record<string, unknown>).aiApprovals;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return undefined;
  const parsed = timeoutMinutesSchema.safeParse((block as Record<string, unknown>).interactiveTimeoutMinutes);
  // An invalid stored value (e.g. written through the system-scope wholesale
  // settings PATCH, which skips this schema) is ignored rather than clamped,
  // so it falls through to the next level instead of being half-honoured.
  return parsed.success ? parsed.data : undefined;
}

/** The single resolver for the interactive AI approval timeout. Org wins. */
export function resolveAiApprovalTimeout(
  partnerSettings: unknown,
  orgSettings: unknown,
): ResolvedAiApprovalTimeout {
  const partnerMinutes = readTimeout(partnerSettings);
  const inheritedMinutes = partnerMinutes ?? AI_APPROVAL_TIMEOUT_DEFAULT_MINUTES;
  const inheritedSource = partnerMinutes !== undefined ? 'partner' : 'default';
  const orgMinutes = readTimeout(orgSettings);
  if (orgMinutes !== undefined) {
    return { minutes: orgMinutes, source: 'org', inheritedMinutes, inheritedSource };
  }
  return { minutes: inheritedMinutes, source: inheritedSource, inheritedMinutes, inheritedSource };
}
