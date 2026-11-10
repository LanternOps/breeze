/**
 * Microsoft (Entra) sign-in client for the customer portal.
 *
 * No return URL travels through the API: the portal keeps the validated `next`
 * path in sessionStorage across the Microsoft round trip and applies
 * `safeNextPath` when the callback lands back on `/login?sso=signed_in`.
 * Every failure collapses to one generic message so the UI cannot be used to
 * tell a misconfigured tenant from a rate limit.
 */

import { buildPortalApiUrl } from './api';
import { replaceLocation } from './replaceLocation';

export const OIDC_NEXT_KEY = 'portal-oidc-next';
export const MICROSOFT_FAILURE_MESSAGE =
  "We couldn't start Microsoft sign-in. Try again, or use another sign-in option.";

const CSRF_HEADER_NAME = 'x-breeze-csrf';
const CSRF_COOKIE_NAME = 'breeze_portal_csrf_token';

export interface SignInMethods {
  password: boolean;
  microsoft: boolean;
}

export interface LinkStatus {
  available: boolean;
  linked: boolean;
}

export type StartResult = { ok: true } | { ok: false; error: string };

export type InviteMethodsResult =
  | { status: 'ok'; methods: SignInMethods }
  | { status: 'invalid' }
  | { status: 'unavailable' };

export type MicrosoftSignInInput =
  | { purpose: 'login'; next?: string }
  | { purpose: 'invite'; inviteToken: string; next?: string };

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const target = `${name}=`;
  for (const part of document.cookie.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(target)) {
      const value = trimmed.slice(target.length);
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return null;
}

function parseMethods(data: unknown): SignInMethods | null {
  if (!data || typeof data !== 'object') return null;
  const { password, microsoft } = data as Record<string, unknown>;
  if (typeof password !== 'boolean' || typeof microsoft !== 'boolean') return null;
  return { password, microsoft };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function postHeaders(withCsrf: boolean): Headers {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (withCsrf) {
    const token = readCookie(CSRF_COOKIE_NAME);
    if (token) headers.set(CSRF_HEADER_NAME, token);
  }
  return headers;
}

/** Which sign-in options this portal host offers. Null = unknown (treat as password only). */
export async function getSignInMethods(): Promise<SignInMethods | null> {
  try {
    const response = await fetch(buildPortalApiUrl('/portal/auth/methods'), { credentials: 'include' });
    if (!response.ok) return null;
    return parseMethods(await readJson(response));
  } catch {
    return null;
  }
}

/** Which options one invite offers. */
export async function getInviteMethods(token: string): Promise<InviteMethodsResult> {
  try {
    const response = await fetch(buildPortalApiUrl('/portal/auth/invite/methods'), {
      method: 'POST',
      headers: postHeaders(false),
      credentials: 'include',
      body: JSON.stringify({ token })
    });
    if (response.status === 400) return { status: 'invalid' };
    if (!response.ok) return { status: 'unavailable' };
    const methods = parseMethods(await readJson(response));
    return methods ? { status: 'ok', methods } : { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}

/** Link-card state for the signed-in profile page. Null = unknown (hide the card). */
export async function getLinkStatus(): Promise<LinkStatus | null> {
  try {
    const response = await fetch(buildPortalApiUrl('/portal/auth/oidc/entra/link-status'), {
      credentials: 'include'
    });
    if (!response.ok) return null;
    const data = (await readJson(response)) as Record<string, unknown> | null;
    if (!data || typeof data.available !== 'boolean' || typeof data.linked !== 'boolean') return null;
    return { available: data.available, linked: data.linked };
  } catch {
    return null;
  }
}

async function postForRedirect(path: string, body: unknown, withCsrf: boolean): Promise<StartResult> {
  try {
    const response = await fetch(buildPortalApiUrl(path), {
      method: 'POST',
      headers: postHeaders(withCsrf),
      credentials: 'include',
      body: JSON.stringify(body)
    });
    if (!response.ok) return { ok: false, error: MICROSOFT_FAILURE_MESSAGE };
    const data = (await readJson(response)) as { redirectUrl?: unknown } | null;
    if (!data || typeof data.redirectUrl !== 'string' || !data.redirectUrl) {
      return { ok: false, error: MICROSOFT_FAILURE_MESSAGE };
    }
    replaceLocation(data.redirectUrl);
    return { ok: true };
  } catch {
    return { ok: false, error: MICROSOFT_FAILURE_MESSAGE };
  }
}

/** Begin Microsoft sign-in (existing customers) or invite acceptance. */
export async function startMicrosoftSignIn(input: MicrosoftSignInInput): Promise<StartResult> {
  const body =
    input.purpose === 'invite'
      ? { purpose: 'invite' as const, inviteToken: input.inviteToken }
      : { purpose: 'login' as const };
  // Always overwrite: a stale destination from an earlier, abandoned attempt
  // must not be applied to this sign-in.
  storeNext(input.next ?? null);
  return postForRedirect('/portal/auth/oidc/entra/start', body, false);
}

/** Begin linking Microsoft to the signed-in portal user. */
export function startMicrosoftLink(): Promise<StartResult> {
  return postForRedirect('/portal/auth/oidc/entra/link/start', {}, true);
}

function storeNext(next: string | null): void {
  try {
    if (next) sessionStorage.setItem(OIDC_NEXT_KEY, next);
    else sessionStorage.removeItem(OIDC_NEXT_KEY);
  } catch {
    // Storage blocked: the customer lands on the default page instead.
  }
}

/** Read and clear the post-sign-in destination stored before the redirect. */
export function takeStoredNext(): string | null {
  try {
    const value = sessionStorage.getItem(OIDC_NEXT_KEY);
    sessionStorage.removeItem(OIDC_NEXT_KEY);
    return value;
  } catch {
    return null;
  }
}
