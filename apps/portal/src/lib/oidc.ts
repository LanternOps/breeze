/**
 * Microsoft (Entra) and Google sign-in client for the customer portal.
 *
 * No return URL travels through the API: the portal keeps the validated `next`
 * path in sessionStorage across the provider round trip and applies
 * `safeNextPath` when the callback lands back on `/login?sso=signed_in`.
 * Every failure collapses to one generic message so the UI cannot be used to
 * tell a misconfigured tenant from a rate limit.
 */

import { buildPortalApiUrl } from './api';
import { replaceLocation } from './replaceLocation';

export const OIDC_NEXT_KEY = 'portal-oidc-next';
export const MICROSOFT_FAILURE_MESSAGE =
  "We couldn't start Microsoft sign-in. Try again, or use another sign-in option.";
export const GOOGLE_FAILURE_MESSAGE =
  "We couldn't start Google sign-in. Try again, or use another sign-in option.";

const CSRF_HEADER_NAME = 'x-breeze-csrf';
const CSRF_COOKIE_NAME = 'breeze_portal_csrf_token';

/** What one invite offers (`POST /auth/invite/methods`). */
export interface InviteMethods {
  password: boolean;
  microsoft: boolean;
  /**
   * The API sends `google` only when the deployment has a Google client; an
   * absent key (and anything but a literal `true`) reads as false, so a
   * deployment without Google renders no Google option anywhere.
   */
  google: boolean;
}

/** What the login page offers (`GET /auth/methods`). */
export interface SignInMethods extends InviteMethods {
  /** Show the Request access link (W6). Anything but a literal `true` reads as false. */
  requestAccess: boolean;
}

export interface LinkStatus {
  available: boolean;
  linked: boolean;
}

/**
 * `inviteInvalid`: an invite start the API answered 400 (the invite is unusable
 * for single sign-on, e.g. its account already holds that provider's identity).
 * The accept-invite page shows its normal expired-invite state for it.
 */
export type StartResult = { ok: true } | { ok: false; error: string; inviteInvalid?: true };

export type InviteMethodsResult =
  | { status: 'ok'; methods: InviteMethods }
  | { status: 'invalid' }
  | { status: 'unavailable' };

export type SsoSignInInput =
  | { purpose: 'login'; next?: string }
  | { purpose: 'invite'; inviteToken: string; next?: string };
export type MicrosoftSignInInput = SsoSignInInput;
export type GoogleSignInInput = SsoSignInInput;

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
  const { password, microsoft, google, requestAccess } = data as Record<string, unknown>;
  if (typeof password !== 'boolean' || typeof microsoft !== 'boolean') return null;
  return { password, microsoft, google: google === true, requestAccess: requestAccess === true };
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
    return methods
      ? { status: 'ok', methods: { password: methods.password, microsoft: methods.microsoft, google: methods.google } }
      : { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}

async function fetchLinkStatus(path: string): Promise<LinkStatus | null> {
  try {
    const response = await fetch(buildPortalApiUrl(path), { credentials: 'include' });
    if (!response.ok) return null;
    const data = (await readJson(response)) as Record<string, unknown> | null;
    if (!data || typeof data.available !== 'boolean' || typeof data.linked !== 'boolean') return null;
    return { available: data.available, linked: data.linked };
  } catch {
    return null;
  }
}

/** Microsoft link-card state for the signed-in profile page. Null = unknown (hide the card). */
export function getLinkStatus(): Promise<LinkStatus | null> {
  return fetchLinkStatus('/portal/auth/oidc/entra/link-status');
}

/**
 * Google link-card state. The API answers 404 when the deployment has no
 * Google client: that, like any failure, is null and the card stays hidden.
 */
export function getGoogleLinkStatus(): Promise<LinkStatus | null> {
  return fetchLinkStatus('/portal/auth/oidc/google/link-status');
}

async function postForRedirect(
  path: string,
  body: { purpose: 'login' } | { purpose: 'invite'; inviteToken: string } | Record<string, never>,
  withCsrf: boolean,
  failure: string
): Promise<StartResult> {
  try {
    const response = await fetch(buildPortalApiUrl(path), {
      method: 'POST',
      headers: postHeaders(withCsrf),
      credentials: 'include',
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      return response.status === 400 && 'purpose' in body && body.purpose === 'invite'
        ? { ok: false, error: failure, inviteInvalid: true }
        : { ok: false, error: failure };
    }
    const data = (await readJson(response)) as { redirectUrl?: unknown } | null;
    if (!data || typeof data.redirectUrl !== 'string' || !data.redirectUrl) {
      return { ok: false, error: failure };
    }
    replaceLocation(data.redirectUrl);
    return { ok: true };
  } catch {
    return { ok: false, error: failure };
  }
}

function startBody(input: SsoSignInInput) {
  return input.purpose === 'invite'
    ? { purpose: 'invite' as const, inviteToken: input.inviteToken }
    : { purpose: 'login' as const };
}

/** Begin Microsoft sign-in (existing customers) or invite acceptance. */
export async function startMicrosoftSignIn(input: MicrosoftSignInInput): Promise<StartResult> {
  // Always overwrite: a stale destination from an earlier, abandoned attempt
  // must not be applied to this sign-in.
  storeNext(input.next ?? null);
  return postForRedirect('/portal/auth/oidc/entra/start', startBody(input), false, MICROSOFT_FAILURE_MESSAGE);
}

/** Begin linking Microsoft to the signed-in portal user. */
export function startMicrosoftLink(): Promise<StartResult> {
  return postForRedirect('/portal/auth/oidc/entra/link/start', {}, true, MICROSOFT_FAILURE_MESSAGE);
}

/**
 * Begin Google sign-in (existing customers) or invite acceptance. Shares the
 * stored `next` key with Microsoft: one SSO round trip runs at a time.
 */
export async function startGoogleSignIn(input: GoogleSignInInput): Promise<StartResult> {
  storeNext(input.next ?? null);
  return postForRedirect('/portal/auth/oidc/google/start', startBody(input), false, GOOGLE_FAILURE_MESSAGE);
}

/** Begin linking Google to the signed-in portal user. */
export function startGoogleLink(): Promise<StartResult> {
  return postForRedirect('/portal/auth/oidc/google/link/start', {}, true, GOOGLE_FAILURE_MESSAGE);
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
