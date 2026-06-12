/** Shared shapes for the /pam admin UI (#1159), mirroring routes/pam.ts responses. */

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
