/**
 * Customer-portal self-registration client (portal registration W6 #11383).
 *
 * Two public calls, no portal session:
 * - `requestPortalAccess` posts name + email. The API answers every address
 *   the same way (uniform 200), so this client never branches on anything the
 *   server could vary per address.
 * - `confirmPortalAccessRequest` posts the single-use link token. It runs only
 *   from an explicit click on the verify page — mail scanners prefetch links,
 *   so nothing may spend the token on page load.
 */
import { buildPortalApiUrl } from './api';

export type RequestAccessResult =
  | { status: 'sent'; message: string }
  | { status: 'throttled' }
  | { status: 'invalid' }
  | { status: 'not_available' }
  | { status: 'failed' };

export type ConfirmAccessResult =
  | { status: 'request_sent' }
  | { status: 'request_unavailable' }
  | { status: 'existing_account' }
  | { status: 'account_created'; next: string }
  /** 400: unknown, expired, reused or refused — one answer for all of them. */
  | { status: 'invalid_link' }
  /** 404: this server does not run self-registration. */
  | { status: 'not_available' }
  /** Retryable (the token was NOT consumed): 429, the pre-consume 503, a network failure. */
  | { status: 'error'; message: string | null }
  /**
   * Terminal: the server consumed the token but could not finish (a 503 marked
   * SELF_REGISTER_LINK_SPENT), or answered a 200 this page cannot act on. A
   * retry could only 400, so the page offers none. `message` is the server's
   * copy when it sent one.
   */
  | { status: 'spent'; message: string | null };

/** Must match SELF_REGISTER_LINK_SPENT in apps/api/src/routes/portal/selfRegistration.ts. */
const LINK_SPENT_CODE = 'SELF_REGISTER_LINK_SPENT';

/** The fallback copy when the server's 200 body has no message (it always sends one). */
export const REQUEST_ACCESS_SENT_FALLBACK = "If this address can request access, we've emailed you.";

/** The only page the instant-mode handoff may navigate to. */
const ACCEPT_INVITE_NEXT = /^\/accept-invite\?token=[^#/\\\s]+$/;

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const data = await response.json();
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(buildPortalApiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body)
  });
}

export async function requestPortalAccess(input: { name: string; email: string }): Promise<RequestAccessResult> {
  try {
    const response = await post('/portal/auth/self-register', { name: input.name, email: input.email });
    if (response.ok) {
      const data = await readJson(response);
      const message = typeof data?.message === 'string' && data.message ? data.message : REQUEST_ACCESS_SENT_FALLBACK;
      return { status: 'sent', message };
    }
    if (response.status === 429) return { status: 'throttled' };
    if (response.status === 400) return { status: 'invalid' };
    if (response.status === 404) return { status: 'not_available' };
    return { status: 'failed' };
  } catch {
    return { status: 'failed' };
  }
}

export async function confirmPortalAccessRequest(token: string): Promise<ConfirmAccessResult> {
  let response: Response;
  try {
    response = await post('/portal/auth/self-register/verify', { token });
  } catch {
    return { status: 'error', message: null };
  }
  const data = await readJson(response);
  if (response.status === 400) return { status: 'invalid_link' };
  if (response.status === 404) return { status: 'not_available' };
  if (!response.ok) {
    const message = typeof data?.error === 'string' && data.error ? data.error : null;
    return data?.code === LINK_SPENT_CODE ? { status: 'spent', message } : { status: 'error', message };
  }
  // Any 200 means the server consumed the token: a body we cannot act on is
  // terminal, never a retry.
  switch (data?.outcome) {
    case 'request_sent':
    case 'request_unavailable':
    case 'existing_account':
      return { status: data.outcome };
    case 'account_created':
      // Navigate only to the accept-invite page on this portal: never follow a
      // server-supplied absolute or protocol-relative URL.
      if (typeof data.next === 'string' && ACCEPT_INVITE_NEXT.test(data.next)) {
        return { status: 'account_created', next: data.next };
      }
      return { status: 'spent', message: null };
    default:
      return { status: 'spent', message: null };
  }
}
