// Typed fetch wrappers for the Trust Center access-request inbox (#8770 W02d), mounted under the org router at
// /orgs/:orgId/trust-page/access-requests. Same idiom as trustPage.ts: the fetcher is a PARAMETER, reads unwrap
// `{ data }`, and mutation wrappers return the raw Response so the component owns the `runAction` call.
import type { TrustAccessRequestStatus } from '@breeze/shared';
import { unwrapData, type Fetcher } from './serviceDeliverables';

export interface TrustAccessRequestItem {
  id: string;
  status: TrustAccessRequestStatus;
  requesterEmail: string;
  requesterName: string;
  requesterCompany: string;
  purpose: string;
  ndaAccepted: boolean;
  createdAt: string;
  emailVerifiedAt: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  grantExpiresAt: string | null;
  revokedAt: string | null;
  downloadCount: number;
  lastDownloadedAt: string | null;
  grantedDocumentIds: string[];
  /** When the current state lapses on its own (verify link or grant); null when it does not. */
  expiresAt: string | null;
  expired: boolean;
}

function base(orgId: string): string {
  return `/orgs/${encodeURIComponent(orgId)}/trust-page/access-requests`;
}
function action(f: Fetcher, orgId: string, requestId: string, verb: 'approve' | 'deny' | 'revoke' | 'resend', body: unknown): Promise<Response> {
  return f(`${base(orgId)}/${encodeURIComponent(requestId)}/${verb}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

export async function listTrustAccessRequests(f: Fetcher, orgId: string, status?: TrustAccessRequestStatus): Promise<TrustAccessRequestItem[]> {
  const path = status ? `${base(orgId)}?status=${encodeURIComponent(status)}` : base(orgId);
  return (await unwrapData<{ requests: TrustAccessRequestItem[] }>(await f(path))).requests;
}

/** Needs MFA (403 MFA_REQUIRED otherwise). */
export function approveTrustAccessRequest(f: Fetcher, orgId: string, requestId: string, note?: string): Promise<Response> {
  return action(f, orgId, requestId, 'approve', note ? { note } : {});
}
export function denyTrustAccessRequest(f: Fetcher, orgId: string, requestId: string, note?: string): Promise<Response> {
  return action(f, orgId, requestId, 'deny', note ? { note } : {});
}
export function revokeTrustAccessGrant(f: Fetcher, orgId: string, requestId: string): Promise<Response> {
  return action(f, orgId, requestId, 'revoke', {});
}
/** Needs MFA. Emails a new link; the previous one stops working; the grant's expiry does not move. */
export function resendTrustAccessGrant(f: Fetcher, orgId: string, requestId: string): Promise<Response> {
  return action(f, orgId, requestId, 'resend', {});
}
