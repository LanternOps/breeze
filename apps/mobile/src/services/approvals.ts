import * as SecureStore from 'expo-secure-store';
import { getServerUrl } from './serverConfig';
import { fetchWithAuthRefresh } from './authedFetch';
import type { ScriptProposalDetailDto } from '../screens/approvals/scriptProposalCopy';

const FALLBACK_API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3001';
const PREFIX = '/api/v1/mobile/approvals';
const SCRIPT_PROPOSALS_PREFIX = '/api/v1/ai/script-proposals';
const CSRF_HEADER_NAME = 'x-breeze-csrf';
const CSRF_HEADER_VALUE = '1';
const TOKEN_KEY = 'breeze_auth_token';

export type RiskTier = 'low' | 'medium' | 'high' | 'critical';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'reported';

export interface ApprovalRequest {
  id: string;
  requestingClientLabel: string;
  requestingMachineLabel: string | null;
  actionLabel: string;
  actionToolName: string;
  /**
   * Server-issued approval flow discriminant (#1154). `'uac_intercept'` is a
   * PAM elevation surfaced for human approval; absent/other values render as a
   * standard approval. Optional for forward-compatibility — when the server
   * omits it, the flow type is derived from {@link actionToolName}
   * (see screens/approvals/approvalFlow.ts).
   */
  flowType?: string | null;
  actionArguments: Record<string, unknown>;
  riskTier: RiskTier;
  riskSummary: string;
  /**
   * Customer tenant (M365) this action targets, e.g. "Example Dental".
   * Server-derived for M365 mutation approvals (m365_reset_password /
   * m365_disable_user) by resolving the linked AI session's Delegant M365
   * connection. Null for all other approvals. Surfaced prominently on the
   * card so a technician sees the blast radius before deciding.
   */
  customerTenant: string | null;
  status: ApprovalStatus;
  expiresAt: string;
  decidedAt: string | null;
  decisionReason: string | null;
  /**
   * Set when this user approved but the server refused to apply it (a PAM
   * elevation whose target could not be verified); `status` is then
   * `denied`. Absent from older servers.
   */
  refusalReason?: string | null;
  /**
   * Server-issued flag. TRUE when the approval was triggered by this
   * user's own mobile app (the same phone is the requester) — gates
   * the 5-second hold-to-confirm UX for self-approval. Replaces the
   * legacy client-side label-prefix heuristic.
   */
  isRecursive: boolean;
  createdAt: string;
}

async function authedFetch(
  path: string,
  init?: RequestInit,
  opts?: { retryOnAuthFailure?: boolean }
) {
  const token = await SecureStore.getItemAsync(TOKEN_KEY);
  const baseUrl = (await getServerUrl()) || FALLBACK_API_BASE_URL;
  const res = await fetchWithAuthRefresh(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
      ...(init?.headers ?? {}),
    },
  }, undefined, opts);
  return res;
}

export async function fetchPendingApprovals(): Promise<ApprovalRequest[]> {
  const res = await authedFetch(`${PREFIX}/pending`);
  if (!res.ok) throw new Error(`Failed to fetch approvals: ${res.status}`);
  const json = await res.json();
  return json.approvals;
}

export async function fetchApproval(id: string): Promise<ApprovalRequest> {
  const res = await authedFetch(`${PREFIX}/${id}`);
  if (res.status === 404) throw new Error('NOT_FOUND');
  if (!res.ok) throw new Error(`Failed to fetch approval: ${res.status}`);
  const json = await res.json();
  return json.approval;
}

/**
 * Optional Breeze Authenticator step-up payload attached to an approve. A
 * hardware-signed `proof` upgrades the recorded decision to L2 (mobile_hw_key);
 * a verified `pin` upgrades it to L3. Both are optional — a device-less tech
 * approves with neither, recorded as L1 (Phase 3 is opt-in; enforcement is
 * Phase 4). The server treats a *presented-but-invalid* proof/pin as an error,
 * never a silent downgrade.
 */
export interface ApproveStepUp {
  proof?: unknown;
  pin?: string;
  /** #4052: fresh account re-auth for a critical-tier (L4) approval. */
  reauth?: ReauthFactor;
}

/**
 * Fresh account re-authentication a critical-tier (L4) approval requires on
 * top of the hardware-key step-up (server: routes/approvals.ts `/:id/approve`,
 * `reauthPassword` / `reauthMfaCode`). `totp` is the login authenticator-app
 * code, the only fallback the server accepts for a passwordless (SSO) account:
 * a passkey cannot satisfy this step yet (#4051).
 *
 * Holds a secret: never log it, persist it, or put it in Redux state/actions.
 */
export type ReauthFactor = { kind: 'password' | 'totp'; value: string };

/**
 * The 401s the approve route answers for a rejected re-auth, told apart from
 * a failed hardware step-up so the screen can say what to fix.
 *   - `reauth_required` (`error`): critical approve with a trusted key but no
 *     re-auth → collect the password/code and approve again.
 *   - `invalid_credentials` (`code`): the password/code we sent was rejected.
 */
async function approveUnauthorizedCode(res: Response, sentReauth: boolean): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: unknown; code?: unknown } | null;
  if (data?.error === 'reauth_required') return 'REAUTH_REQUIRED';
  if (sentReauth && data?.code === 'invalid_credentials') return 'REAUTH_INVALID';
  return 'STEP_UP_FAILED';
}

/**
 * 403s the approve route answers:
 *   - `{ error: 'step_up_required' }`: an enforcing partner policy wants a
 *     higher assurance than this approve reached.
 *   - `{ error, message }` from requireFreshMfaStepUp when the partner's MFA
 *     policy does not permit TOTP. It is the only 403 on this route that
 *     carries `message`; the decide-path 403s are bare snake_case tokens
 *     (services/approvals/decideApprovalRequest.ts), so this is told apart by
 *     shape, never by matching the human text.
 * Anything else keeps the generic `Approve failed: 403`.
 */
async function approveForbiddenCode(res: Response, reauth: ReauthFactor | undefined): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: unknown; message?: unknown } | null;
  if (data?.error === 'step_up_required') return 'STEP_UP_REQUIRED';
  if (reauth?.kind === 'totp' && typeof data?.message === 'string') return 'REAUTH_METHOD_NOT_PERMITTED';
  return `Approve failed: ${res.status}`;
}

export async function approveRequest(
  id: string,
  stepUp?: ApproveStepUp,
  /** W03 (#5612): STRICT patterns the approver ticked on a script_proposal's
   *  checklist. Omitted (not an empty array) when there is nothing to send —
   *  most approvals never carry this. */
  acknowledgedPatterns?: string[],
): Promise<ApprovalRequest> {
  const reauth = stepUp?.reauth?.value ? stepUp.reauth : undefined;
  const hasStepUp = !!(stepUp && (stepUp.proof || stepUp.pin || reauth));
  const hasAcknowledgements = !!(acknowledgedPatterns && acknowledgedPatterns.length > 0);
  const body = hasStepUp || hasAcknowledgements
    ? JSON.stringify({
        proof: stepUp?.proof,
        pin: stepUp?.pin,
        reauthPassword: reauth?.kind === 'password' ? reauth.value : undefined,
        reauthMfaCode: reauth?.kind === 'totp' ? reauth.value : undefined,
        acknowledgedPatterns: hasAcknowledgements ? acknowledgedPatterns : undefined,
      })
    : undefined;
  // A 401 on a decision is a failed step-up or re-auth (see below), not an
  // expired token, so it must not be refreshed and replayed — and a re-auth
  // password/code must never be sent twice.
  const res = await authedFetch(`${PREFIX}/${id}/approve`, { method: 'POST', body }, { retryOnAuthFailure: false });
  if (res.status === 409) throw new Error('ALREADY_DECIDED');
  if (res.status === 410) throw new Error('EXPIRED');
  if (res.status === 401) throw new Error(await approveUnauthorizedCode(res, !!reauth));
  // The re-auth helpers rate-limit per user (5 per 5 min) and answer 429, and
  // answer 503 when their rate-limit store is down.
  if (res.status === 429 && reauth) throw new Error('REAUTH_THROTTLED');
  if (res.status === 503 && reauth) throw new Error('REAUTH_UNAVAILABLE');
  if (res.status === 403) throw new Error(await approveForbiddenCode(res, reauth));
  if (!res.ok) throw new Error(`Approve failed: ${res.status}`);
  const json = await res.json();
  return refusedAsDenied(json);
}

/**
 * An approve the server refused to apply (a PAM elevation whose target could
 * not be verified) is not an approval. Current servers store and return the
 * row as `denied` with `refusalReason`. Older servers return it still
 * `approved` and report the refusal only as `enforcementStatus: 'refused'`
 * beside it, so read that the same way.
 */
function refusedAsDenied(json: {
  approval: ApprovalRequest;
  enforcementStatus?: unknown;
  reason?: unknown;
}): ApprovalRequest {
  const { approval } = json;
  if (json.enforcementStatus !== 'refused' || approval.status !== 'approved') return approval;
  return {
    ...approval,
    status: 'denied',
    refusalReason: approval.refusalReason ?? (typeof json.reason === 'string' ? json.reason : null),
  };
}

export async function denyRequest(id: string, reason?: string): Promise<ApprovalRequest> {
  const res = await authedFetch(`${PREFIX}/${id}/deny`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  }, { retryOnAuthFailure: false });
  if (res.status === 409) throw new Error('ALREADY_DECIDED');
  if (res.status === 410) throw new Error('EXPIRED');
  if (!res.ok) throw new Error(`Deny failed: ${res.status}`);
  const json = await res.json();
  return json.approval;
}

// Reports the in-flight approval as malicious. Server denies the row, revokes
// the requesting OAuth client + its refresh tokens, and writes a security
// audit log. Returns nothing (204).
export async function reportSuspicious(id: string): Promise<void> {
  const res = await authedFetch(`${PREFIX}/${id}/report-suspicious`, { method: 'POST' });
  if (res.status === 404) throw new Error('NOT_FOUND');
  if (!res.ok) throw new Error(`Report failed: ${res.status}`);
}

/**
 * W03 (#5612): the approval row carries only the proposal id
 * (`actionArguments.proposalId`) — the card content (goal, reviewer
 * findings, STRICT patterns, script body) lives behind this live-authorised
 * detail endpoint, which re-derives this user's authority per request rather
 * than trusting anything cached on the approval row.
 */
export async function fetchScriptProposal(id: string): Promise<ScriptProposalDetailDto> {
  const res = await authedFetch(`${SCRIPT_PROPOSALS_PREFIX}/${id}`);
  if (res.status === 404) throw new Error('NOT_FOUND');
  if (!res.ok) throw new Error(`Failed to fetch proposal: ${res.status}`);
  return (await res.json()) as ScriptProposalDetailDto;
}
