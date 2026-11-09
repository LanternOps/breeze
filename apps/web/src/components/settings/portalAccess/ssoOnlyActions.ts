import type { TFunction } from 'i18next';
import { PORTAL_ACCESS_POLICY_ERROR_CODES } from '@breeze/shared';
import { fetchWithAuth } from '../../../stores/auth';
import { ActionError, runAction } from '@/lib/runAction';
import { showToast } from '../../shared/Toast';
import {
  isSsoOnlyImpact,
  isStrandedPortalAccounts,
  type SsoOnlyImpact,
  type StrandedPortalAccounts,
} from './types';

/**
 * Requests behind the `sso_only` save flow (portal registration W4 #11381,
 * D12, spec §5.11): the 409 that carries the impact, the stranded list, and the
 * bulk "Send Microsoft sign-in invite" (`POST …/portal-users/sso-invite`,
 * at most 100 ids per call).
 */

export const SSO_INVITE_BATCH_SIZE = 100;
export const PORTAL_SSO_INVITE_UNAVAILABLE = 'PORTAL_SSO_INVITE_UNAVAILABLE';

/** The impact of a 409 `SSO_ONLY_CONFIRM_REQUIRED`, or null for any other error. */
export function confirmRequiredImpact(err: unknown): SsoOnlyImpact | null {
  if (!(err instanceof ActionError) || err.status !== 409) return null;
  if (err.code !== PORTAL_ACCESS_POLICY_ERROR_CODES.SSO_ONLY_CONFIRM_REQUIRED) return null;
  const impact = (err.body as { impact?: unknown } | null)?.impact;
  return isSsoOnlyImpact(impact) ? impact : null;
}

/** For runAction's `suppressErrorToast`: the confirmation 409 opens the dialog instead of a toast. */
export function isConfirmRequiredStatus(status: number, code: string | undefined): boolean {
  return status === 409 && code === PORTAL_ACCESS_POLICY_ERROR_CODES.SSO_ONLY_CONFIRM_REQUIRED;
}

/** The policy URL with the acknowledged digest, when there is one. */
export function withAcknowledge(url: string, digest: string | null): string {
  return digest ? `${url}?acknowledge=${encodeURIComponent(digest)}` : url;
}

const strandedUrl = (orgId: string) => `/orgs/organizations/${orgId}/portal-access-policy/stranded`;
const ssoInviteUrl = (orgId: string) => `/orgs/organizations/${orgId}/portal-users/sso-invite`;

/** `GET …/stranded`. Throws on a failed or malformed answer. */
export async function loadStrandedAccounts(orgId: string): Promise<StrandedPortalAccounts> {
  const res = await fetchWithAuth(strandedUrl(orgId));
  if (!res.ok) throw new Error(`stranded accounts load failed: ${res.status}`);
  const body = (await res.json()) as { data?: unknown };
  if (!isStrandedPortalAccounts(body.data)) throw new Error('stranded accounts load returned an unexpected body');
  return body.data;
}

/**
 * Invites the given accounts in batches of {@link SSO_INVITE_BATCH_SIZE}, one
 * request at a time, then shows one summary toast. A failed batch stops the
 * run: runAction has toasted it, and the ActionError is rethrown after a
 * partial-count toast when earlier batches went through.
 */
export async function sendSsoInvites(
  orgId: string,
  portalUserIds: string[],
  t: TFunction,
  onUnauthorized: () => void,
): Promise<{ invited: number; total: number; emailFailed: number }> {
  const ids = [...new Set(portalUserIds)];
  /** Invited AND emailed. */
  let invited = 0;
  /** Moved to invited by the server, but its email did not go out (`emailSent: false`). */
  let emailFailed = 0;
  for (let i = 0; i < ids.length; i += SSO_INVITE_BATCH_SIZE) {
    const batch = ids.slice(i, i + SSO_INVITE_BATCH_SIZE);
    let results: SsoInviteRow[];
    try {
      const body = await runAction<{ data: SsoInviteRow[] }>({
        request: () => fetchWithAuth(ssoInviteUrl(orgId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ portalUserIds: batch }),
        }),
        errorFallback: t('settings:portalAccessPolicy.stranded.errors.invite'),
        parseSuccess: (data) => {
          const rows = (data as { data?: unknown } | null)?.data;
          if (!Array.isArray(rows)) throw new Error('unexpected sso-invite body');
          return { data: rows as SsoInviteRow[] };
        },
        friendly: (code) => (code === PORTAL_SSO_INVITE_UNAVAILABLE ? t('settings:portalAccessPolicy.stranded.errors.unavailable') : undefined),
        onUnauthorized,
      });
      results = body.data;
    } catch (err) {
      if (invited > 0) {
        showToast({ type: 'warning', message: t('settings:portalAccessPolicy.stranded.toasts.partial', { invited, total: ids.length }) });
      }
      throw err;
    }
    for (const r of results) {
      if (r.result !== 'invited') continue;
      if (r.emailSent === false) emailFailed += 1;
      else invited += 1;
    }
  }
  if (emailFailed > 0) {
    // The accounts are now `invited` (so they leave the stranded list) but nobody was emailed.
    showToast({ type: 'warning', message: t('settings:portalAccessPolicy.stranded.toasts.emailFailed', { count: emailFailed }) });
  } else if (invited === ids.length) {
    showToast({ type: 'success', message: t('settings:portalAccessPolicy.stranded.toasts.invited', { count: invited }) });
  } else {
    showToast({ type: 'warning', message: t('settings:portalAccessPolicy.stranded.toasts.partial', { invited, total: ids.length }) });
  }
  return { invited, total: ids.length, emailFailed };
}

/** One row of `POST …/portal-users/sso-invite`: 'invited' | 'not_stranded' | a refusal code. */
type SsoInviteRow = { portalUserId: string; result: string; emailSent?: boolean };
