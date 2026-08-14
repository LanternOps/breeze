/**
 * Audit fan-out for AI software-policy writes (#3543).
 *
 * The HTTP routes write BOTH stores — `software_policy_audit` (the feature's own
 * forensic trail) and `audit_logs` (the platform-wide trail) — but the AI tools
 * wrote neither, so "who armed enforcement on this policy" was unanswerable for
 * any AI-driven change (the gap surfaced during incident #3381, where the
 * reporter's complete `audit_logs` trail contained no arming event at all).
 *
 * AI tool handlers receive `auth`, not a Hono context, so `writeRouteAudit(c, …)`
 * is unusable. This mirrors the context-less pattern established in
 * aiToolsOrgs.ts: `requestLikeFromSnapshot({})`, with actor identity pulled off
 * `auth.user`. No ip/userAgent is recoverable from an `AuthContext`.
 *
 * Both writes are best-effort and never fail the tool result, but neither is
 * silent: `recordSoftwarePolicyAudit` reports to Sentry internally, and the
 * `audit_logs` path logs here.
 */

import type { AuthContext } from '../middleware/auth';
import { requestLikeFromSnapshot, writeAuditEvent } from './auditEvents';
import { recordSoftwarePolicyAudit } from './softwarePolicyService';

export type SoftwarePolicyToolAuditEntry = {
  orgId: string | null;
  partnerId?: string | null;
  policyId: string;
  policyName?: string | null;
  /** `software_policy_audit.action` — e.g. 'policy_created'. */
  policyAuditAction: string;
  /** `audit_logs.action` — e.g. 'software_policy.create'. */
  auditLogAction: string;
  result?: 'success' | 'denied';
  details?: Record<string, unknown>;
};

export function auditSoftwarePolicyToolEvent(
  auth: AuthContext,
  toolName: string,
  entry: SoftwarePolicyToolAuditEntry
): void {
  recordSoftwarePolicyAudit({
    orgId: entry.orgId,
    partnerId: entry.partnerId ?? null,
    policyId: entry.policyId,
    action: entry.policyAuditAction,
    actor: 'ai',
    actorId: auth.user.id,
    details: { ...entry.details, toolName },
  }).catch((err) => {
    console.error(`[aiTools] Software policy audit write failed for ${entry.policyAuditAction}:`, err);
  });

  try {
    writeAuditEvent(requestLikeFromSnapshot({}), {
      orgId: entry.orgId,
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: entry.auditLogAction,
      resourceType: 'software_policy',
      resourceId: entry.policyId,
      resourceName: entry.policyName ?? undefined,
      result: entry.result ?? 'success',
      details: { ...entry.details, tool_name: toolName },
    });
  } catch (err) {
    console.error(`[aiTools] Audit log write failed for ${entry.auditLogAction}:`, err);
  }
}

/**
 * Which enforcement-relevant fields an AI write touched. Surfaced explicitly in
 * both audit stores so arming a policy is greppable, rather than buried inside a
 * generic `updatedFields` list.
 */
export function summarizeEnforcementChange(input: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  if (typeof input.enforceMode === 'boolean') summary.enforceMode = input.enforceMode;
  if (input.remediationOptions && typeof input.remediationOptions === 'object') {
    summary.remediationOptions = input.remediationOptions;
    summary.autoUninstall = (input.remediationOptions as Record<string, unknown>).autoUninstall === true;
  }
  return summary;
}
