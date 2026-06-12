/** Shared shapes for the /pam admin UI (#1159), mirroring routes/pam.ts responses. */

import { Bot, MonitorCog, UserCog, type LucideIcon } from 'lucide-react';

export type ElevationStatus =
  | 'pending'
  | 'approved'
  | 'auto_approved'
  | 'denied'
  | 'expired'
  | 'revoked'
  | 'actuating';

export type ElevationFlowType = 'uac_intercept' | 'tech_jit_admin' | 'ai_tool_action';

export type PamVerdict = 'auto_approve' | 'auto_deny' | 'require_approval' | 'ignore';

export interface ElevationRequest {
  id: string;
  orgId: string;
  siteId?: string | null;
  deviceId: string;
  flowType: ElevationFlowType;
  subjectUsername: string;
  reason: string;
  targetExecutablePath?: string | null;
  targetExecutableHash?: string | null;
  targetExecutableSigner?: string | null;
  targetPublisher?: string | null;
  status: ElevationStatus;
  requestedAt: string;
  approvedAt?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
  revokedReason?: string | null;
  approvedByUserId?: string | null;
  deniedByUserId?: string | null;
  revokedByUserId?: string | null;
  denialReason?: string | null;
  toolName?: string | null;
  riskTier?: number | null;
  executionId?: string | null;
  // Joined by the API
  deviceHostname?: string | null;
  siteName?: string | null;
  // Decider display names joined by the API (null when unset or when the
  // joined user row isn't visible to the caller).
  approvedByName?: string | null;
  deniedByName?: string | null;
  revokedByName?: string | null;
  // Decision provenance joined by the API (#1159 follow-up): which software
  // policy / PAM rule auto-decided the request, and the kind of decider.
  softwarePolicyMatchId?: string | null;
  matchedPolicyName?: string | null;
  pamRuleId?: string | null;
  pamRuleName?: string | null;
  // 'human' and null are display-equivalent today (both fall through to
  // decidedByLabel); the variant exists to mirror the API's derivation — do not
  // assume 'human' implies decidedByLabel() is non-null (older rows may lack
  // joined names).
  decisionSource?: 'software_policy' | 'pam_rule' | 'human' | null;
}

export interface PamTimeWindow {
  start: string;
  end: string;
  days?: number[];
  timezone?: string;
}

export interface PamRule {
  id: string;
  orgId: string;
  siteId?: string | null;
  name: string;
  description?: string | null;
  enabled: boolean;
  priority: number;
  matchSigner?: string | null;
  matchHash?: string | null;
  matchPathGlob?: string | null;
  matchParentImage?: string | null;
  matchUser?: string | null;
  matchAdGroup?: string | null;
  matchToolName?: string | null;
  matchRiskTier?: number | null;
  timeWindow?: PamTimeWindow | null;
  verdict: PamVerdict;
  approvalDurationMinutes?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
}

export type PamRuleDraft =
  | {
      shape: 'executable';
      name?: string;
      orgId?: string;
      siteId?: string | null;
      matchSigner?: string | null;
      matchHash?: string | null;
      matchPathGlob?: string | null;
      matchUser?: string | null;
    }
  | {
      shape: 'tool';
      name?: string;
      orgId?: string;
      siteId?: string | null;
      matchToolName?: string | null;
      matchRiskTier?: number | null;
    };

function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * Seed a rule draft from a request. Prefers the stable criterion: signer
 * over hash (hashes churn with updates) over path; tool actions seed
 * toolName + riskTier; JIT admin seeds the subject user.
 */
export function requestToRuleDraft(r: ElevationRequest): PamRuleDraft {
  if (r.flowType === 'ai_tool_action') {
    return {
      shape: 'tool',
      name: r.toolName ? `Rule for ${r.toolName}` : undefined,
      orgId: r.orgId,
      siteId: r.siteId ?? null,
      matchToolName: r.toolName ?? null,
      matchRiskTier: r.riskTier ?? null,
    };
  }
  if (r.flowType === 'tech_jit_admin') {
    return { shape: 'executable', orgId: r.orgId, siteId: r.siteId ?? null, matchUser: r.subjectUsername };
  }
  const name = r.targetExecutablePath ? `Rule for ${baseName(r.targetExecutablePath)}` : undefined;
  if (r.targetExecutableSigner) {
    return { shape: 'executable', name, orgId: r.orgId, siteId: r.siteId ?? null, matchSigner: r.targetExecutableSigner };
  }
  if (r.targetExecutableHash) {
    return { shape: 'executable', name, orgId: r.orgId, siteId: r.siteId ?? null, matchHash: r.targetExecutableHash };
  }
  return { shape: 'executable', name, orgId: r.orgId, siteId: r.siteId ?? null, matchPathGlob: r.targetExecutablePath ?? null };
}

export const STATUS_LABELS: Record<ElevationStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  auto_approved: 'Auto-approved',
  denied: 'Denied',
  expired: 'Expired',
  revoked: 'Revoked',
  actuating: 'Actuating',
};

export const FLOW_LABELS: Record<ElevationFlowType, string> = {
  uac_intercept: 'UAC intercept',
  tech_jit_admin: 'Tech JIT admin',
  ai_tool_action: 'AI tool action',
};

/** Per-flow lucide glyph, paired with FLOW_LABELS in the Flow cells. */
export const FLOW_ICONS: Record<ElevationFlowType, LucideIcon> = {
  uac_intercept: MonitorCog,
  tech_jit_admin: UserCog,
  ai_tool_action: Bot,
};

export const VERDICT_LABELS: Record<PamVerdict, string> = {
  auto_approve: 'Auto-approve',
  auto_deny: 'Auto-deny',
  require_approval: 'Require approval',
  ignore: 'Ignore',
};

export const ACTIVE_STATUSES: readonly ElevationStatus[] = [
  'approved',
  'auto_approved',
  'actuating',
];

/** Badge color classes per status, matching the muted Tailwind palette used app-wide. */
export function statusBadgeClass(status: ElevationStatus): string {
  switch (status) {
    case 'pending':
      return 'bg-yellow-500/15 text-yellow-600 dark:text-yellow-400';
    case 'approved':
    case 'auto_approved':
      return 'bg-green-500/15 text-green-600 dark:text-green-400';
    case 'actuating':
      return 'bg-blue-500/15 text-blue-600 dark:text-blue-400';
    case 'denied':
    case 'revoked':
      return 'bg-red-500/15 text-red-600 dark:text-red-400';
    case 'expired':
      return 'bg-muted text-muted-foreground';
  }
}

/** Human summary of what a request is asking for. */
export function requestTarget(r: ElevationRequest): string {
  if (r.flowType === 'ai_tool_action') return r.toolName ?? 'AI tool action';
  return r.targetExecutablePath ?? 'Elevation';
}

function shortUserId(id: string | null | undefined): string | null {
  return id ? `${id.slice(0, 8)}…` : null;
}

/**
 * Who approved/denied/revoked the request — prefers the API-joined display
 * name, falling back to a truncated user id (older cached rows, or a decider
 * the caller's users policy can't see). Null when no human decided yet
 * (pending / auto_approved).
 */
export function decidedByLabel(r: ElevationRequest): string | null {
  switch (r.status) {
    case 'denied':
      return r.deniedByName ?? shortUserId(r.deniedByUserId);
    case 'revoked':
      return r.revokedByName ?? shortUserId(r.revokedByUserId);
    case 'approved':
    case 'actuating':
    case 'expired':
      return r.approvedByName ?? shortUserId(r.approvedByUserId);
    default:
      return null;
  }
}

/**
 * Who/what decided the request, for display under the status badge.
 * Auto decisions name their source (software policy / PAM rule); human
 * decisions defer to decidedByLabel. Null while pending/undecided.
 *
 * A human revoke supersedes the original auto-decision for display: an
 * auto-approved request later revoked by a person keeps decisionSource
 * 'pam_rule', but the revoker is the more actionable attribution.
 */
export function decisionAttribution(r: ElevationRequest): string | null {
  if (r.status === 'revoked') {
    const revoker = decidedByLabel(r);
    if (revoker) return `by ${revoker}`;
  }
  if (r.decisionSource === 'software_policy') {
    return `Policy · ${r.matchedPolicyName ?? 'Software policy'}`;
  }
  if (r.decisionSource === 'pam_rule') {
    return `Rule · ${r.pamRuleName ?? 'PAM rule'}`;
  }
  const human = decidedByLabel(r);
  return human ? `by ${human}` : null;
}
