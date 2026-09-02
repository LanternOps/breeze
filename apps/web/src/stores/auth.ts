import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  startAuthentication,
  startRegistration,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON
} from '@simplewebauthn/browser';
import { extractApiError } from '@/lib/apiError';
import { resetPartnerCurrencyCache } from '@/lib/partnerCurrencyCache';
import { resetApproximateTotalCache } from '@/lib/approximateTotalCache';
import { getSafeNext, loginPathWithNext } from '@/lib/authNext';
import {
  parseMfaChallengeResponse,
  type MfaChallenge,
  type MfaMethod,
} from '@/lib/mfaChallenge';
export type { MfaAllowedMethods, MfaChallenge, MfaMethod } from '@/lib/mfaChallenge';
import {
  applyAppearancePreferences,
  applyResolvedLocalePreferences,
  type Density,
  type FontPreference,
  type LocalePreference,
  type TimeFormatPreference,
  type ThemePreference,
} from '@/lib/appearance';

export interface UserPreferences {
  theme?: ThemePreference;
  density?: Density;
  font?: FontPreference;
  timeFormat?: TimeFormatPreference;
  locale?: LocalePreference;
  /**
   * #3389: the technician's preferred remote-access provider. An ID only — it
   * SELECTS from the tenant's configured providers and never supplies a URL
   * template, password or custom-field key, which is what keeps the launcher's
   * post-substitution scheme guard meaningful. An unknown or since-disabled id
   * falls back to the tenant default server-side rather than failing a launch.
   */
  remoteAccessProviderId?: string;
}

/** A single permission grant ({ resource, action }), mirroring the API. */
export interface Permission {
  resource: string;
  action: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  mfaEnabled: boolean;
  avatarUrl?: string;
  requiresSetup?: boolean;
  // True only for platform operators. Gates platform-admin-only nav (e.g.
  // account-deletion-requests) so ordinary users don't trigger its 403 badge
  // fetch. Absent/false for partner & org users.
  isPlatformAdmin?: boolean;
  // Effective permission grants from the user's role, surfaced by /users/me so
  // the UI can hide nav/actions the user can't use. UX only — the server still
  // enforces every route. Absent on sessions persisted before this field.
  permissions?: Permission[];
  // #3262: whether the user may create/modify partner-wide ("All organizations")
  // state — false for partner users with org_access = 'selected'. Surfaced by
  // /users/me so owner-scope pickers don't offer an option the server will 403.
  // UX only — the server still gates every partner-wide write. Absent on
  // sessions persisted before this field (treat absent as capable; the server
  // enforces regardless).
  canManagePartnerWide?: boolean;
  // #4018: whether the account has a password set. False for an SSO-provisioned
  // (JIT) account, which therefore cannot satisfy any password step-up — UI that
  // would otherwise tell such a user to "set up MFA and sign in again" has to
  // point them at their identity provider instead.
  //
  // Populated by `GET /users/me` (routes/users.ts), which is what
  // completeBootstrapLogin stores wholesale and what fetchAndApplyPreferences
  // merges below. Still OPTIONAL because a session persisted before the field
  // existed has no value until its next /users/me refresh: treat absent as
  // UNKNOWN, never as "has a password" — always compare with `=== false`, never
  // `!user?.hasPassword`.
  hasPassword?: boolean;
  preferences?: UserPreferences;
}

export interface Tokens {
  accessToken: string;
  expiresInSeconds: number;
}

/**
 * Why the app bounced the user to /login. Rendered as `?reason=<code>` by
 * handleSessionExpired() and turned into copy by LoginPage.
 */
export type SessionExpiredReason = 'session-expired' | 'idle' | 'origin-rejected';

interface AuthState {
  user: User | null;
  tokens: Tokens | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  mfaPending: boolean;
  mfaTempToken: string | null;
  // Set by handleSessionExpired() just before logout() so UI (the expiry
  // overlay, login-page notice) can render a reason in the same tick the nav
  // collapses. NOT persisted — see partialize below — a stale reason must
  // never survive a reload.
  //
  // 'origin-rejected' is NOT an expiry at all: the API refused the request's
  // Origin (403 "Invalid request origin"), so no session could be minted from
  // this address in the first place. It shares this field because the eviction
  // and redirect are identical — only the copy the user needs differs.
  sessionExpiredReason: SessionExpiredReason | null;
  // Epoch ms until which POST /auth/refresh is rate-limited for this user
  // (issue #3696). Non-null means "the session is FINE, the server is just
  // throttling us" — the opposite of sessionExpiredReason. AuthOverlay renders
  // a non-destructive waiting mask while it is set, so a throttled page can
  // never paint as an empty-but-loaded page. NOT persisted: a stale throttle
  // must never survive a reload.
  authThrottledUntil: number | null;
  sessionGeneration: number;

  // Actions
  setUser: (user: User | null) => void;
  setTokens: (tokens: Tokens | null) => void;
  setMfaPending: (pending: boolean, tempToken?: string) => void;
  setLoading: (loading: boolean) => void;
  login: (user: User, tokens: Tokens) => void;
  logout: () => void;
  updateUser: (user: Partial<User>) => void;
  commitMfaEnrollmentIfCurrent: (generation: number, tokens: Tokens) => boolean;
  setAuthThrottledUntil: (until: number | null) => void;
}

type PersistedAuthState = Pick<AuthState, 'user' | 'isAuthenticated'>;

// Guards handleSessionExpired() below against double-redirects when parallel
// requests both 401 at once. Reset on login() so a later re-login (or a fresh
// test) can trigger it again in the same JS context.
let sessionExpiryInFlight = false;

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      tokens: null,
      isAuthenticated: false,
      isLoading: true,
      mfaPending: false,
      mfaTempToken: null,
      sessionExpiredReason: null,
      authThrottledUntil: null,
      sessionGeneration: 0,

      setUser: (user) => set((state) => ({
        user,
        isAuthenticated: !!user,
        sessionGeneration: state.user?.id === user?.id
          ? state.sessionGeneration
          : state.sessionGeneration + 1,
      })),

      setAuthThrottledUntil: (until) => set({ authThrottledUntil: until }),

      setTokens: (tokens) => set({ tokens }),

      setMfaPending: (pending, tempToken) => set({
        mfaPending: pending,
        mfaTempToken: tempToken || null
      }),

      setLoading: (loading) => set({ isLoading: loading }),

      login: (user, tokens) => {
        // Re-login clears any stale expiry state and re-arms
        // handleSessionExpired for the new session.
        sessionExpiryInFlight = false;
        // A fresh login makes any pending throttle-recovery reload stale —
        // the session is already restored, don't reload out from under it.
        cancelThrottleReload();
        set((state) => ({
          user,
          tokens,
          isAuthenticated: true,
          isLoading: false,
          mfaPending: false,
          mfaTempToken: null,
          sessionExpiredReason: null,
          authThrottledUntil: null,
          sessionGeneration: state.sessionGeneration + 1,
        }));
      },

      // Deliberately does NOT clear `sessionExpiredReason`: handleSessionExpired
      // sets the reason and then calls this, and AuthOverlay's expiry mask must
      // keep rendering until the hard redirect completes. The reason is cleared
      // by login() and by the next page load (it isn't persisted).
      logout: () => {
        // A partner switch in the same tab must never render the previous
        // partner's currency (lib/usePartnerCurrency caches per page).
        resetPartnerCurrencyCache();
        // Reporting totals are converted into the VIEWER's partner reporting
        // currency (lib/useApproximateTotal), so they must not outlive the
        // session either.
        resetApproximateTotalCache();
        // An evicted session must never come back via a stray throttle-recovery
        // reload — the redirect to /login owns navigation from here.
        cancelThrottleReload();
        set((state) => ({
          user: null,
          tokens: null,
          isAuthenticated: false,
          mfaPending: false,
          mfaTempToken: null,
          // An evicted session is not "waiting out a throttle" — drop the mask
          // so the expiry overlay/redirect is what the user sees (#3696).
          authThrottledUntil: null,
          sessionGeneration: state.sessionGeneration + 1,
        }));
      },

      updateUser: (updates) => set((state) => ({
        user: state.user ? { ...state.user, ...updates } : null
      })),

      commitMfaEnrollmentIfCurrent: (generation, tokens) => {
        let committed = false;
        set((state) => {
          if (
            state.sessionGeneration !== generation
            || !state.isAuthenticated
            || !state.user
          ) return state;
          committed = true;
          return {
            tokens,
            user: { ...state.user, mfaEnabled: true },
          };
        });
        return committed;
      },
    }),
    {
      name: 'breeze-auth',
      version: 2,
      partialize: (state): PersistedAuthState => ({
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
      migrate: (persistedState): PersistedAuthState => {
        const nextState = (persistedState ?? {}) as Partial<PersistedAuthState> & { tokens?: unknown };
        // Access tokens stay in memory only. Refresh cookies restore them after reload.
        delete nextState.tokens;
        return {
          user: nextState.user ?? null,
          isAuthenticated:
            typeof nextState.isAuthenticated === 'boolean'
              ? nextState.isAuthenticated
              : nextState.user != null,
        };
      },
      onRehydrateStorage: () => (state) => {
        // Set isLoading to false after rehydration completes.
        // When rehydration fails, state is null — fall back to the raw store API
        // so isLoading is always cleared and the app never hangs on "Loading...".
        if (state) {
          state.setUser(state.user);
          state.setLoading(false);
        } else {
          useAuthStore.getState().setLoading(false);
        }
      }
    }
  )
);

// Org-context injection — orgStore registers a provider to avoid circular imports
let _getOrgId: (() => string | null) | null = null;
export function registerOrgIdProvider(fn: () => string | null) {
  _getOrgId = fn;
}

// API helper functions
// In development, set PUBLIC_API_URL=http://localhost:3001. In production behind a
// reverse proxy (Caddy), leave it empty so requests use relative paths (/api/v1/...).
const API_HOST = import.meta.env.PUBLIC_API_URL || '';
const CSRF_HEADER_NAME = 'x-breeze-csrf';
const CSRF_COOKIE_NAME = 'breeze_csrf_token';

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') {
    return null;
  }

  const target = `${name}=`;
  const parts = document.cookie.split(';');
  for (const part of parts) {
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

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

function resolveApiHost(): string {
  if (!API_HOST) {
    return '';
  }

  if (typeof window === 'undefined') {
    return API_HOST;
  }

  try {
    const parsed = new URL(API_HOST, window.location.origin);
    const windowHostname = window.location.hostname;

    // Keep localhost dev sessions same-site even when PUBLIC_API_URL points to
    // a different host (for example a LAN/Tailscale IP).
    if (isLoopbackHostname(windowHostname) && parsed.hostname !== windowHostname) {
      parsed.hostname = windowHostname;
      return parsed.origin;
    }

    if (isLoopbackHostname(parsed.hostname) && parsed.hostname !== window.location.hostname) {
      parsed.hostname = window.location.hostname;
    }
    return parsed.origin;
  } catch {
    return API_HOST;
  }
}

// Helper to build full API URL - converts /path to /api/v1/path
function buildApiUrl(path: string): string {
  // If already a full URL, return as-is
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }

  // Ensure path starts with /
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  // Remove only the exact "/api" or "/api/v1" prefix boundary to avoid
  // both "/api/v1/api/..." and "/api/v1/v1/..." while preserving legitimate
  // paths like "/api-keys". The "/api/v1/" case matters for server-stored
  // URLs (e.g. users.avatar_url = "/api/v1/users/:id/avatar") that the SPA
  // round-trips through buildApiUrl.
  const cleanPath = normalizedPath === '/api'
    ? ''
    : normalizedPath === '/api/v1'
      ? ''
      : normalizedPath.startsWith('/api/v1/')
        ? normalizedPath.slice(7)
        : normalizedPath.startsWith('/api/')
          ? normalizedPath.slice(4)
          : normalizedPath;

  const apiHost = resolveApiHost();
  return `${apiHost}/api/v1${cleanPath}`;
}

/**
 * Resolve the absolute origin (scheme + host) that serves the API, for building
 * user-facing copyable URLs (e.g. inbound webhook endpoints to paste into a
 * third-party integration). Unlike `resolveApiHost`, this never returns an empty
 * string: in production `PUBLIC_API_URL` is blank (relative paths behind Caddy),
 * so it falls back to the current page origin, which is region-correct
 * (us.2breeze.app / eu.2breeze.app). Returns '' only during SSR with no host.
 */
export function resolveApiOrigin(): string {
  const apiHost = resolveApiHost();
  if (apiHost) return apiHost;
  if (typeof window !== 'undefined') return window.location.origin;
  return '';
}

// The verdict requestTokenRefresh/requestTokenRefreshShared reach, threaded
// through to callers that need to distinguish "no verdict yet, retry later"
// (transient) from "verdict reached, session is dead" (auth-failed) — see
// restoreAccessTokenFromCookieDetailed below. Every internal caller in this
// file discriminates on `kind`; the only place the distinction is collapsed is
// `restoreAccessTokenFromCookie`, which flattens it to a boolean for callers
// that only care about restored-or-not.
type RefreshOutcome =
  | { kind: 'restored'; tokens: Tokens }
  // `originRejected` marks the sub-case where the refresh was refused because
  // of WHERE the browser is, not because of the cookie it sent — see the 403
  // branch in refreshFetchOnce. Still an eviction; only the reason differs.
  | { kind: 'auth-failed'; originRejected?: boolean }
  | { kind: 'transient' }
  // The server rate-limited POST /auth/refresh (429). Like 'transient' this is
  // NOT a verdict on the refresh cookie — but unlike a gateway blip it comes
  // with a known wait, and retrying before that wait elapses is guaranteed to
  // fail AND costs another slot in the server's sliding window. Kept separate
  // so callers can wait it out instead of evicting a healthy session (#3696).
  | { kind: 'throttled'; retryAfterMs: number };

const REFRESH_LOCK_NAME = 'breeze-token-refresh';

async function fetchAuthIssuerWithBindingRetry(
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('x-breeze-auth-transition', 'v1');
  const capableInit = { ...init, headers };
  const first = await fetch(input, capableInit);
  if (first.status !== 428) return first;
  return fetch(input, capableInit);
}

// One low-level /auth/refresh attempt. Returns the new tokens on success, or a
// discriminated result so the caller can tell three cases apart:
//   - raced:     a benign concurrent race (server reason 'refresh_raced',
//                #1107) — the winning sibling already rotated the SHARED refresh
//                cookie and the server deliberately did NOT clear it or kill the
//                session family, so an immediate retry picks up the fresh cookie.
//   - transient: a gateway/network blip (5xx, offline, timeout) — no verdict
//                was reached on the refresh cookie, so the session is very
//                likely still valid and this should be retried with backoff
//                rather than evicting the user (QA 2026-07-08: a single 502 on
//                /auth/refresh hard-logged-out the SPA mid-session).
//   - throttled: a 429 from the per-user refresh limiter, carrying the number
//                of ms to wait. Split out from `transient` in #3696 because the
//                two need OPPOSITE handling: a blip should be retried right
//                away, a throttle must NOT be (see requestTokenRefresh).
//   - originRejected: a hard failure too, but caused by the browser's Origin
//                not being allowed (403 "Invalid request origin"), not by the
//                refresh cookie. Same eviction, different explanation.
//   - neither:   a hard failure (expired/reused refresh cookie, real 401/403) —
//                the session is unrecoverable and the caller must evict.
type RefreshFetchResult = {
  tokens: Tokens | null;
  raced: boolean;
  transient: boolean;
  throttledForMs?: number;
  originRejected?: boolean;
};

// The exact body the API's cookie-CSRF guard answers with when the request's
// Origin isn't in CORS_ALLOWED_ORIGINS (apps/api/src/routes/auth/helpers.ts,
// validateCookieCsrfRequest). Matched on the BODY, not the bare 403: other
// 403s on this endpoint are genuine auth failures and must keep the generic
// expiry copy.
const ORIGIN_REJECTED_ERROR = 'Invalid request origin';

// Fallback wait when a 429 arrives without a usable Retry-After/retryAfter —
// matches the server's default 60s window (apps/api/src/services/rate-limit.ts,
// getRefreshRateWindowSeconds).
const DEFAULT_REFRESH_RETRY_AFTER_MS = 60_000;
// Never wait longer than this on a single throttle, however large a
// Retry-After the server (or a proxy in front of it) sends. A hostile or
// misconfigured value must not wedge the tab indefinitely.
const MAX_REFRESH_RETRY_AFTER_MS = 90_000;

// Every client throttled in the same server window reads the same
// Retry-After and, without this, would wake at the exact same instant — a
// throttled fleet's own recovery becomes a second synchronized burst (#3984).
// Jitter only ever ADDS time (never subtracts): retrying before the server's
// granted window elapses just earns another 429, so the floor stays the raw
// wait and only the ceiling spreads out.
const RETRY_JITTER_FACTOR = 0.25;

// The pre-jitter ceiling parseRetryAfterMs clamps to, chosen so base +
// up-to-25% jitter never exceeds MAX_REFRESH_RETRY_AFTER_MS. Clamping to
// MAX_REFRESH_RETRY_AFTER_MS itself and jittering AFTER would let the result
// exceed the documented ceiling, AND would collapse every value at/above the
// ceiling to the exact same ceiling deadline pre-jitter — recreating the
// lockstep problem for precisely the hostile/misconfigured Retry-After values
// this ceiling exists to bound.
const MAX_REFRESH_RETRY_BASE_MS = Math.floor(MAX_REFRESH_RETRY_AFTER_MS / (1 + RETRY_JITTER_FACTOR));

function withRetryJitter(waitMs: number): number {
  return waitMs + Math.floor(Math.random() * waitMs * RETRY_JITTER_FACTOR);
}

/**
 * Seconds-to-wait from a 429, preferring the standard `Retry-After` header and
 * falling back to the JSON `retryAfter` field the API also sends. Clamped into
 * a sane range so neither a `0` (retry immediately — the very hammering being
 * rejected) nor an absurd value can be honoured literally. Deliberately NOT
 * jittered here — jitter is applied once, at the single call site below, so
 * this stays a pure parse+clamp and the jitter itself can be tested/reasoned
 * about independently (#3984).
 */
function parseRetryAfterMs(response: Response, body: { retryAfter?: unknown } | null): number {
  // Optional chaining: `headers` is absent on partially-stubbed Response
  // objects (test doubles, some fetch polyfills), and a throw here would turn a
  // recoverable throttle into an unhandled rejection on the recovery path.
  const header = response.headers?.get('Retry-After') ?? null;
  const fromHeader = header !== null ? Number(header) : NaN;
  const fromBody = typeof body?.retryAfter === 'number' ? body.retryAfter : NaN;
  const seconds = Number.isFinite(fromHeader) && fromHeader > 0
    ? fromHeader
    : Number.isFinite(fromBody) && fromBody > 0
      ? fromBody
      : NaN;
  if (!Number.isFinite(seconds)) {
    // Reaching here means a 429 arrived with NO usable wait: a proxy/CDN
    // stripping Retry-After, or a server regression. The default keeps the
    // client correct, but silently guessing the window would hide the cause —
    // and if the operator has retuned AUTH_REFRESH_RATE_WINDOW_SECONDS the
    // guess is simply wrong. Make it visible.
    console.warn(
      '[auth] /auth/refresh returned 429 with no usable Retry-After; ' +
        `falling back to ${DEFAULT_REFRESH_RETRY_AFTER_MS}ms`
    );
    return Math.min(MAX_REFRESH_RETRY_BASE_MS, DEFAULT_REFRESH_RETRY_AFTER_MS);
  }
  return Math.min(MAX_REFRESH_RETRY_BASE_MS, Math.max(1_000, Math.round(seconds * 1_000)));
}

async function refreshFetchOnce(): Promise<RefreshFetchResult> {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  const csrfToken = readCookie(CSRF_COOKIE_NAME);
  if (csrfToken) {
    headers.set(CSRF_HEADER_NAME, csrfToken);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  let refreshResponse: Response;
  try {
    refreshResponse = await fetchAuthIssuerWithBindingRetry(buildApiUrl('/auth/refresh'), {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({}),
      signal: controller.signal,
    });
  } catch {
    // Network error, offline, or the 8s abort fired — no HTTP status reached
    // the client, so the refresh cookie is untouched. Retryable.
    return { tokens: null, raced: false, transient: true };
  } finally {
    clearTimeout(timeout);
  }

  if (refreshResponse.ok) {
    const { tokens } = await refreshResponse.json().catch(() => ({ tokens: undefined })) as { tokens?: Tokens };
    return { tokens: tokens?.accessToken ? tokens : null, raced: false, transient: false };
  }

  if (refreshResponse.status === 401) {
    const body = await refreshResponse.json().catch(() => null) as { reason?: string } | null;
    if (body?.reason === 'refresh_raced') {
      return { tokens: null, raced: true, transient: false };
    }
  }

  // Same benign race, second shape. #4097's per-binding issuance lease
  // (apps/api/src/services/authBrowserTransition.ts) rejects the LOSER of two
  // concurrent refreshes with a retryable AuthIssuanceConflictError, flattened
  // to a bare 409 with no `reason` — no verdict was reached on the refresh
  // cookie, so this is the raced path, not an expired session. An org switch
  // hits it every time (reload → bootstrap refresh racing the pre-reload one
  // the unload aborted client-side but the server is still executing).
  if (refreshResponse.status === 409) {
    return { tokens: null, raced: true, transient: false };
  }

  // 429 means the rate limiter rejected the request before the refresh cookie
  // was ever evaluated, so no verdict was reached and the session is very
  // likely still valid. Classifying it as a hard failure evicted people whose
  // session was fine — a runaway remote-desktop viewer poll exhausting the
  // shared per-IP budget (#3041), and normal sidebar navigation exhausting the
  // per-USER budget (#3696, one refresh per full page load in an MPA).
  //
  // Reported as its own kind rather than folded into `transient`: the server
  // told us exactly how long to wait, and an immediate retry both cannot
  // succeed and burns another slot in the server's sliding window (rejected
  // requests are still ZADDed), which deepens the throttle.
  if (refreshResponse.status === 429) {
    const body = await refreshResponse.json().catch(() => null) as { retryAfter?: unknown } | null;
    return {
      tokens: null,
      raced: false,
      transient: false,
      // Jitter applied once, here, so it covers every consumer of
      // `throttledForMs`/`retryAfterMs` uniformly (#3984).
      throttledForMs: withRetryJitter(parseRetryAfterMs(refreshResponse, body)),
    };
  }

  // A 403 "Invalid request origin" is a CONFIGURATION verdict, not a session
  // verdict: the request was rejected on its Origin header before the refresh
  // cookie was evaluated, so retrying (from this address) can only fail again.
  // It still evicts — no access token can be minted here — but the user needs
  // to be told about CORS_ALLOWED_ORIGINS / PUBLIC_APP_URL, not about their
  // password. Self-hosters hit this on every login when they reach the
  // dashboard at an address the API was never told about (an SSH tunnel's
  // https://localhost:8443 against a CORS_ALLOWED_ORIGINS of https://localhost).
  if (refreshResponse.status === 403) {
    const body = await refreshResponse.json().catch(() => null) as { error?: string } | null;
    if (body?.error === ORIGIN_REJECTED_ERROR) {
      return { tokens: null, raced: false, transient: false, originRejected: true };
    }
    return { tokens: null, raced: false, transient: false };
  }

  // 5xx (typically a 502/503/504 from the gateway) means the request never
  // reached a verdict on the refresh cookie — retryable, not an auth failure.
  if (refreshResponse.status >= 500) {
    return { tokens: null, raced: false, transient: true };
  }

  return { tokens: null, raced: false, transient: false };
}

// Serialize refresh across tabs AND across reloads via the Web Locks API.
// Multiple browser contexts share one refresh cookie jar; without a lock they
// can fire concurrent rotations that replay each other's just-revoked jti and
// (pre-#1107) tripped reuse-detection, logging everyone out on a hard refresh.
// Falls back to a direct call where Web Locks are unavailable (older browsers).
async function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined'
    ? (navigator as Navigator & { locks?: LockManager }).locks
    : undefined;
  if (!locks?.request) {
    return fn();
  }
  return locks.request(REFRESH_LOCK_NAME, fn) as Promise<T>;
}

// A single transient gateway/network blip must not boot the user mid-session
// (QA 2026-07-08), so transient refresh failures get a bounded exponential
// backoff. Kept small: enough to ride out a one-off 502, not so many that a
// genuinely dead session hangs the UI before eviction. Worst added wait ~0.9s.
const MAX_TRANSIENT_REFRESH_RETRIES = 2;
const TRANSIENT_REFRESH_BASE_DELAY_MS = 300;

async function requestTokenRefresh(): Promise<RefreshOutcome> {
  return withRefreshLock(async () => {
    let transientRetries = 0;
    for (;;) {
      const result = await refreshFetchOnce();
      if (result.tokens) return { kind: 'restored', tokens: result.tokens };

      // Rate-limited. Return IMMEDIATELY — do not spend the transient-retry
      // budget. The whole backoff ladder below completes in ~0.9s, always
      // inside the server's 60s window, so every retry is a guaranteed 429 that
      // additionally consumes a slot in the sliding window (#3696). Waiting out
      // the throttle is the caller's job (requestTokenRefreshShared), which can
      // show the user why the page is waiting.
      if (result.throttledForMs !== undefined) {
        return { kind: 'throttled', retryAfterMs: result.throttledForMs };
      }

      if (result.raced) {
        // Benign race (#1107): a sibling context won the rotation. Give the
        // winner's rotated cookie a beat to settle in the shared jar, then
        // retry exactly once. The retry sends the now-current cookie.
        await new Promise((resolve) => setTimeout(resolve, 200));
        const retry = await refreshFetchOnce();
        if (retry.tokens) return { kind: 'restored', tokens: retry.tokens };
        if (retry.throttledForMs !== undefined) {
          return { kind: 'throttled', retryAfterMs: retry.throttledForMs };
        }
        // If the race-retry hit a transient blip — or raced AGAIN — fall
        // through to the backoff path below; otherwise the session is
        // genuinely gone. A second consecutive race is still not a verdict on
        // the refresh cookie: the fixed 200ms above simply wasn't long enough
        // for the winner's issuance transaction to commit and release the
        // #4097 lease (reachable under DB/pool contention), and evicting there
        // was the same org-switch logout, just rarer. Deliberately reuses the
        // existing bounded ladder rather than adding a second counter — the
        // whole loop stays capped at MAX_TRANSIENT_REFRESH_RETRIES passes.
        if (!retry.transient && !retry.raced) {
          return { kind: 'auth-failed', originRejected: retry.originRejected };
        }
      } else if (!result.transient) {
        // Hard failure (expired/reused refresh cookie, real 401/403): the
        // session is unrecoverable — evict.
        return { kind: 'auth-failed', originRejected: result.originRejected };
      }

      // Transient gateway/network failure. Retry with bounded exponential
      // backoff before giving up and letting the caller evict the session.
      if (transientRetries >= MAX_TRANSIENT_REFRESH_RETRIES) return { kind: 'transient' };
      const delay = TRANSIENT_REFRESH_BASE_DELAY_MS * 2 ** transientRetries;
      transientRetries += 1;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  });
}

let tokenRefreshInFlight: Promise<RefreshOutcome> | null = null;

// ---- SSO login gate (#3700) -------------------------------------------------
//
// When the page loads with `#ssoCode=` in the fragment, an SSO token exchange
// is about to run — but it only starts once AuthOverlay mounts and its 50ms
// rehydrate timer fires. Sibling islands (Header, AuthGuard, DashboardWrapper)
// race ahead of that: with a stale persisted `isAuthenticated: true` and a
// DEAD refresh cookie (exactly the state an enforce-SSO-locked-out user is
// in), their first fetchWithAuth/restore call fails the cookie refresh and
// hard-evicts to /login, abandoning the single-use grant mid-exchange.
//
// The gate is armed SYNCHRONOUSLY at module load (before any island effect can
// run) and makes every refresh attempt wait until the exchange settles. After
// a successful exchange the refresh cookie is fresh, so the queued refreshes
// succeed; after a failed one they proceed to their normal eviction path. The
// timeout is a deadlock backstop for the pathological case where nothing ever
// consumes the fragment (e.g. the landing page renders no AuthOverlay).
const SSO_LOGIN_GATE_TIMEOUT_MS = 15_000;
let ssoLoginGate: Promise<void> | null = null;
let ssoLoginGateSettle: (() => void) | null = null;
let ssoLoginGateTimer: ReturnType<typeof setTimeout> | null = null;

export function armSsoLoginGate(): void {
  if (ssoLoginGate) return;
  ssoLoginGate = new Promise<void>((resolve) => {
    ssoLoginGateSettle = resolve;
  });
  ssoLoginGateTimer = setTimeout(() => {
    console.warn('[ssoLoginGate] timed out waiting for the SSO exchange to settle');
    settleSsoLoginGate();
  }, SSO_LOGIN_GATE_TIMEOUT_MS);
}

/** Release refreshes held by the gate. Safe to call when no gate is armed. */
export function settleSsoLoginGate(): void {
  if (ssoLoginGateTimer) {
    clearTimeout(ssoLoginGateTimer);
    ssoLoginGateTimer = null;
  }
  ssoLoginGateSettle?.();
  ssoLoginGateSettle = null;
  ssoLoginGate = null;
}

// Optional chaining: tests (and some embedders) stub `window.location` with a
// partial object, and this runs at module load where a throw breaks every
// importer of the store.
if (typeof window !== 'undefined' && window.location?.hash?.startsWith('#ssoCode=')) {
  armSsoLoginGate();
}
// ----------------------------------------------------------------------------

// A throttled refresh is waited out at most this many times before the caller
// is told the refresh is still throttled. One wait is enough to clear a full
// server window; more would let a genuinely wedged client hang for minutes.
const MAX_THROTTLE_WAITS = 1;

// Single owner of the "throttle outlasted the bounded in-memory wait above"
// recovery action (#3984). Before this, AuthThrottledMask (AuthOverlay.tsx)
// independently counted down to its OWN `window.location.reload()` using the
// same `authThrottledUntil` deadline this module publishes — so the mask's
// reload and this module's own retry-in-progress fired at the same instant,
// and the reload usually preempted the retry, wasting it. Only this module
// schedules a reload now; the mask is pure display.
//
// A reload (not an in-place retry) is deliberate: the web app is an Astro MPA
// whose access token lives in memory only, and AuthOverlay's own recovery
// effect runs once per mount — a fresh document is what re-arms it.
let throttleReloadTimer: ReturnType<typeof setTimeout> | null = null;

// Gate: only reload on a page that actually renders AuthThrottledMask (i.e.
// mounts AuthOverlay). Pages that handle `AuthThrottledError` with their own
// non-destructive UI instead — `ForcedMfaSetupPage` on `AuthLayout`, which
// mounts no AuthOverlay by design and shows a "still signed in, please wait"
// message with no reload — must never have that work discarded by a reload
// they never opted into. AuthThrottledMask toggles this on mount/unmount.
let throttleMaskMounted = false;

export function setThrottleMaskMounted(mounted: boolean): void {
  throttleMaskMounted = mounted;
}

function scheduleThrottleReload(waitMs: number): void {
  if (typeof window === 'undefined') return;
  if (throttleReloadTimer) clearTimeout(throttleReloadTimer);
  throttleReloadTimer = setTimeout(() => {
    throttleReloadTimer = null;
    // A newer refresh cycle (a concurrent fetchWithAuth call, or
    // AdminSessionManager's keepalive) may have started — and be in its OWN
    // bounded in-memory wait — since this timer was armed. That cycle owns
    // the next decision (it will call scheduleThrottleReload/
    // cancelThrottleReload itself once it settles); reloading here would
    // discard ITS in-progress retry, recreating the exact race this module
    // exists to remove.
    if (tokenRefreshInFlight) return;
    // Only reload if a mask is actually visible to explain it, and the
    // throttle is still actually blocking the page. A background keepalive
    // refresh (AdminSessionManager) can get throttled while the access token
    // is still valid and every data call is still succeeding — reloading
    // there would discard unsaved work to "recover" a session that was never
    // impaired.
    if (throttleMaskMounted && !useAuthStore.getState().tokens?.accessToken) {
      window.location.reload();
    }
  }, waitMs);
}

function cancelThrottleReload(): void {
  if (throttleReloadTimer) {
    clearTimeout(throttleReloadTimer);
    throttleReloadTimer = null;
  }
}

/**
 * Wait out a `429` on /auth/refresh and try once more (#3696).
 *
 * A throttle is NOT a verdict on the refresh cookie — the session is fine, the
 * server is just rationing. Evicting here is what turned normal sidebar
 * navigation into a forced logout. Instead we publish `authThrottledUntil` so
 * AuthOverlay can mask the page with an honest "waiting" state (which also
 * makes the silent-broken-page variant impossible: the page can never look
 * loaded-but-empty while this is set), sleep for the server-supplied window,
 * and retry.
 *
 * Bounded by MAX_THROTTLE_WAITS and by the clamp in parseRetryAfterMs, so the
 * worst case is one bounded wait, never an indefinite hang.
 */
async function requestTokenRefreshWaitingOutThrottle(): Promise<RefreshOutcome> {
  let outcome = await requestTokenRefresh();

  for (let waits = 0; waits < MAX_THROTTLE_WAITS; waits += 1) {
    if (outcome.kind !== 'throttled') break;
    const waitMs = outcome.retryAfterMs;
    useAuthStore.getState().setAuthThrottledUntil(Date.now() + waitMs);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    outcome = await requestTokenRefresh();
  }

  // Still throttled after the bounded wait: leave the mask up (with the fresh
  // deadline) so the user keeps seeing WHY the page is stuck rather than a
  // page that looks loaded but has no data. It is cleared by login(), by
  // logout(), and by the next successful refresh.
  if (outcome.kind === 'throttled') {
    useAuthStore.getState().setAuthThrottledUntil(Date.now() + outcome.retryAfterMs);
    // The in-memory bounded wait above is exhausted — schedule the ONE
    // automatic recovery action left (see comment on scheduleThrottleReload).
    scheduleThrottleReload(outcome.retryAfterMs);
  } else {
    // Any other verdict (restored, auth-failed, transient) ends the throttle —
    // drop the mask so a wait we entered above can never outlive its cause.
    useAuthStore.getState().setAuthThrottledUntil(null);
    cancelThrottleReload();
  }

  return outcome;
}

async function requestTokenRefreshShared(): Promise<RefreshOutcome> {
  // Hold every refresh while an SSO exchange is (about to be) in flight — a
  // dead-cookie verdict reached mid-exchange evicts the session and abandons
  // the grant. See the SSO login gate block above.
  if (ssoLoginGate) {
    await ssoLoginGate;
  }

  if (tokenRefreshInFlight) {
    return tokenRefreshInFlight;
  }

  tokenRefreshInFlight = requestTokenRefreshWaitingOutThrottle().finally(() => {
    tokenRefreshInFlight = null;
  });

  return tokenRefreshInFlight;
}

/**
 * Resolve when any in-flight token refresh has settled. Used by reload-class
 * code paths (OrgSwitcher, SiteSwitcher) to avoid the post-reload page racing
 * the pre-reload page on the same refresh cookie jti — see #950.
 *
 * The v0.67.0 launch-readiness security sweep (#900) introduced NX-claim
 * refresh-token reuse-detection: only ONE concurrent /auth/refresh wins;
 * the loser gets 401 AND has its refresh cookie cleared. If OrgSwitcher
 * fires window.location.reload() while a refresh is mid-flight, the
 * post-reload page hydrates fresh, its Astro islands fire /auth/refresh,
 * lose the race, get the cookie cleared, and the user is bounced to /login.
 *
 * Returns immediately if no refresh is in flight. Swallows refresh errors —
 * we only care about serialization; if the pre-reload refresh failed, the
 * post-reload page will get its own fresh attempt with no race.
 */
export async function waitForPendingRefresh(): Promise<void> {
  if (tokenRefreshInFlight) {
    try {
      await tokenRefreshInFlight;
    } catch {
      // Intentionally swallowed — see comment above.
    }
  }
}

/**
 * Like `restoreAccessTokenFromCookie`, but surfaces WHY a refresh didn't
 * restore a session instead of collapsing everything to `false`. Callers that
 * need to react differently to "session is dead" vs. "couldn't reach a
 * verdict, try again later" (the AdminSessionManager heartbeat, #Task-3) use
 * this; callers that only care about restored-or-not keep using the boolean
 * wrapper below.
 */
export async function restoreAccessTokenFromCookieDetailed(): Promise<'restored' | 'auth-failed' | 'origin-rejected' | 'transient' | 'throttled'> {
  try {
    const outcome = await requestTokenRefreshShared();
    if (outcome.kind === 'restored') {
      useAuthStore.getState().setTokens(outcome.tokens);
    }
    // Reported separately from 'auth-failed' so callers that evict can pass the
    // reason on to handleSessionExpired. Callers that only branch on 'restored'
    // or 'throttled' are unaffected: this is still a dead end.
    if (outcome.kind === 'auth-failed' && outcome.originRejected) return 'origin-rejected';
    return outcome.kind;
  } catch (err) {
    // Unexpected throw, not a verdict from the server — treat as transient so
    // callers retry rather than treat an unrelated exception as proof the
    // session is dead. refreshFetchOnce already absorbs network/HTTP failures
    // internally, so anything landing here is genuinely unexpected (Web Locks
    // unavailable/rejected, a regression upstream) and worth a log line.
    console.warn(
      '[restoreAccessTokenFromCookieDetailed] unexpected error during refresh; treating as transient',
      err
    );
    return 'transient';
  }
}

export async function restoreAccessTokenFromCookie(): Promise<boolean> {
  return (await restoreAccessTokenFromCookieDetailed()) === 'restored';
}

/**
 * Bootstraps the auth store after a Cloudflare Access redirect login.
 *
 * The server's GET /api/v1/auth/cf-access-login endpoint mints a Breeze
 * session and sets the HttpOnly refresh cookie, but there's no JSON body
 * for the SPA to consume since it's a 302 redirect. This helper completes
 * the handshake:
 *
 *   1. Trade the refresh cookie for a fresh access token (`/auth/refresh`)
 *   2. Fetch the user record (`/users/me`) with that token
 *   3. Populate the store via `login(user, tokens)`
 *
 * Returns true if the store was populated; false if any step failed (the
 * caller should fall back to the regular login form).
 */
export async function bootstrapFromCfAccessRedirect(): Promise<boolean> {
  const outcome = await requestTokenRefreshShared();
  if (outcome.kind !== 'restored' || !outcome.tokens.accessToken) return false;
  return completeBootstrapLogin(outcome.tokens);
}

/**
 * Bootstraps the auth store after an SSO (OIDC/SAML) redirect login (#3700).
 *
 * The SSO callback mints a one-time token-exchange grant and redirects to the
 * app with `#ssoCode=<grant>` in the fragment (never a query param, so the
 * grant is not sent to the server or logged in access logs). AuthOverlay
 * consumes the fragment and calls this helper, which:
 *
 *   1. Trades the grant for an access token via POST `/sso/exchange` (which
 *      also sets the HttpOnly refresh cookie server-side)
 *   2. Fetches the user record (`/users/me`) with that token
 *   3. Populates the store via `login(user, tokens)`
 *
 * Returns true if the store was populated; false if any step failed (the
 * caller should bounce to /login with an error notice). The grant is
 * single-use and short-lived, so a failed exchange is not retryable — the
 * user re-initiates SSO login instead. One partial-success shape to know
 * about: if the exchange succeeded but the /users/me step failed, the
 * HttpOnly refresh cookie IS already set, so the /login page's cookie-restore
 * path may sign the user in without any re-initiation.
 */
export async function bootstrapFromSsoCode(code: string): Promise<boolean> {
  let exchangeResponse: Response;
  try {
    exchangeResponse = await fetch(buildApiUrl('/sso/exchange'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ code }),
      // Bounded so a black-holed request settles before AuthOverlay's 10s
      // safety net fires its bare (error-less) /login redirect.
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    console.warn('[bootstrapFromSsoCode] /sso/exchange request failed', err);
    return false;
  }

  if (!exchangeResponse.ok) {
    console.warn('[bootstrapFromSsoCode] /sso/exchange rejected', exchangeResponse.status);
    return false;
  }

  const data = (await exchangeResponse.json().catch(() => null)) as
    | { accessToken?: string; expiresInSeconds?: number }
    | null;
  if (!data?.accessToken) {
    console.warn('[bootstrapFromSsoCode] /sso/exchange returned no access token');
    return false;
  }

  return completeBootstrapLogin({
    accessToken: data.accessToken,
    expiresInSeconds: data.expiresInSeconds ?? 900,
  });
}

// Shared tail of the redirect-login bootstraps (CF Access, SSO): fetch the
// user record with the freshly-minted access token and populate the store.
async function completeBootstrapLogin(tokens: Tokens): Promise<boolean> {
  let meResponse: Response;
  try {
    meResponse = await fetch(buildApiUrl('/users/me'), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    console.warn('[completeBootstrapLogin] /users/me request failed', err);
    return false;
  }

  if (!meResponse.ok) {
    console.warn('[completeBootstrapLogin] /users/me rejected', meResponse.status);
    return false;
  }

  // .catch: a 200 with a non-JSON body (proxy/CDN interstitial) must resolve
  // to a clean `false` — an uncaught rejection here escapes both bootstrap
  // callers' .then chains, and the user hangs on the overlay spinner until
  // the 10s safety net drops them on a bare /login with no error notice.
  const user = (await meResponse.json().catch(() => null)) as User | null;
  if (!user || !user.id) return false;

  useAuthStore.getState().login(user, tokens);

  // Mirror what LoginPage does after a successful password login: pull
  // /users/me into the store and apply the theme to the DOM. Without
  // this, dark mode reverts to default and the onboarding tour reads
  // an empty preferences object on first render.
  await fetchAndApplyPreferences();
  return true;
}

// Default request timeout for JSON API calls. Uploads get a much longer ceiling
// (see UPLOAD_TIMEOUT_MS) because large installer files take far longer to send.
const DEFAULT_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 10 * 60_000;

/**
 * Thrown by `fetchWithAuth` when the store claims to be authenticated but the
 * refresh cookie can no longer mint an access token, so there is no Bearer to
 * attach. Rather than fire a knowingly-unauthenticated request (which the API
 * answers with a confusing "Missing or invalid authorization header" 401),
 * `fetchWithAuth` clears the session, redirects to /login, and throws this so
 * callers can short-circuit. Callers that already special-case auth failures
 * can `instanceof`-check it; most callers can ignore it (the page is navigating
 * away to /login anyway).
 */
export class AuthSessionExpiredError extends Error {
  constructor(message = 'Session expired') {
    super(message);
    this.name = 'AuthSessionExpiredError';
  }
}

/**
 * Thrown by `fetchWithAuth` when the bootstrap refresh could not mint an access
 * token because the server is RATE-LIMITING /auth/refresh — the session itself
 * is fine (issue #3696).
 *
 * Deliberately NOT a subclass of `AuthSessionExpiredError`: dozens of callers
 * do `if (err instanceof AuthSessionExpiredError) return;` on the (correct)
 * assumption that the page is already navigating to /login. Inheriting that
 * would make every one of them swallow a throttle silently and render an empty
 * page — the exact "looks loaded, has no data" failure this fix exists to
 * remove. Callers that don't know this type instead fall through to their
 * normal error UI.
 *
 * SCOPE, precisely: on pages rendered by `DashboardLayout.astro` (and the
 * `/account/*` pages) `authThrottledUntil` also puts AuthOverlay's waiting mask
 * on top, so the throttle is impossible to miss. `pages/remote/**` (the
 * full-screen remote-access viewers) now mount AuthOverlay too (#3984) — a
 * throttle over a live video/terminal session forces a reload (see
 * `scheduleThrottleReload`), which re-mints any single-use session ticket on
 * reconnect, an accepted tradeoff for making the throttle visible/recoverable
 * there at all. The forced-MFA enrollment page (`AuthLayout.astro`) is the
 * one bare-shell exception: it mounts no AuthOverlay by design, so no mask
 * and no automatic reload ever happen there (`throttleMaskMounted` gates the
 * store's reload on a mask actually being on screen) — `ForcedMfaSetupPage`
 * instead handles this type explicitly with its own non-destructive "still
 * signed in, please wait" copy, so a throttle mid-enrollment can never
 * silently discard a typed code.
 */
export class AuthThrottledError extends Error {
  readonly retryAt: number;
  constructor(retryAt: number, message = 'Too many session refreshes — retrying shortly') {
    super(message);
    this.name = 'AuthThrottledError';
    this.retryAt = retryAt;
  }
}

/**
 * Reason code for an eviction caused by a failed refresh. Everything except an
 * origin rejection is reported as a plain expiry — including 'transient', where
 * the bounded retries were exhausted without a verdict.
 */
function expiryReasonFor(outcome: RefreshOutcome): SessionExpiredReason {
  return outcome.kind === 'auth-failed' && outcome.originRejected
    ? 'origin-rejected'
    : 'session-expired';
}

/**
 * Single entry point for "the session is unrecoverable, evict and redirect."
 * Both fetchWithAuth expiry paths (dead refresh cookie on bootstrap, and a
 * 401 that survives a refresh-and-retry) funnel through here so idle-timeout
 * and future callers get identical behavior.
 *
 * Idempotent: concurrent 401s from parallel requests must not double-redirect.
 * The in-flight flag resets on login() so a later re-login (or the next test)
 * can trigger it again.
 */
export function handleSessionExpired(reason: SessionExpiredReason = 'session-expired'): void {
  if (sessionExpiryInFlight) return;
  sessionExpiryInFlight = true;

  // Set before logout() so UI (the expiry overlay) can render a mask in the
  // same tick the nav state collapses.
  useAuthStore.setState({ sessionExpiredReason: reason });
  useAuthStore.getState().logout();

  if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
    const url = loginPathWithNext();
    window.location.replace(`${url}${url.includes('?') ? '&' : '?'}reason=${reason}`);
  }
}

export interface FetchWithAuthOptions extends RequestInit {
  /**
   * Skip the automatic refresh-and-replay on a 401. Opt-in, for the rare
   * request whose body is SINGLE-USE: `/mobile/approvals/:id/approve` carries a
   * WebAuthn assertion that the server consumes (and may reject with 401
   * `assertion_failed`). Replaying it re-sends an already-burned assertion,
   * which can only fail again. Callers that set this get the raw 401 and must
   * handle it themselves (e.g. runAction's `treatUnauthorizedAsError`).
   */
  skipUnauthorizedRetry?: boolean;
  /**
   * Skip the automatic `?orgId=` injection below. Opt-in, for the rare
   * partner-scope read that is deliberately CROSS-ORG: the API treats an absent
   * orgId as "all accessible orgs" (e.g. `/fleet/findings`), so injecting the
   * switcher's active org silently narrows an "All organizations" query to one
   * org. Callers that set this own their org scoping entirely.
   */
  skipOrgIdInjection?: boolean;
}

export async function fetchWithAuth(rawUrl: string, options: FetchWithAuthOptions = {}): Promise<Response> {
  // Auto-inject orgId from the org store so partner/system users always scope API calls
  let url = rawUrl;
  const orgId = _getOrgId?.();
  if (orgId && !options.skipOrgIdInjection && !url.includes('orgId=')) {
    const separator = url.includes('?') ? '&' : '?';
    url = `${url}${separator}orgId=${orgId}`;
  }

  const { tokens: initialTokens, isAuthenticated, setTokens } = useAuthStore.getState();
  let tokens = initialTokens;
  const previousAccessToken = tokens?.accessToken ?? null;

  // During app bootstrap we can have a persisted authenticated user but no in-memory access token yet.
  // Recover from refresh cookie first to avoid firing unauthenticated API calls.
  //
  // This is the ONLY token-recovery point for pages rendered outside the
  // dashboard shell — most importantly the forced-MFA enrollment page
  // (`/auth/mfa/setup`, AuthLayout), which has no AuthGuard/DashboardWrapper to
  // proactively call restoreAccessTokenFromCookie() on mount. That page is
  // always reached via a full-page navigation (`window.location.href`), so the
  // in-memory access token is always gone and enrollment depends entirely on
  // this refresh succeeding here.
  if (!tokens?.accessToken && isAuthenticated) {
    const outcome = await requestTokenRefreshShared();
    if (outcome.kind === 'restored') {
      setTokens(outcome.tokens);
      tokens = outcome.tokens;
    } else {
      // The session claims to be authenticated but the refresh cookie can no
      // longer mint an access token (rotated/revoked/expired, or — as seen in
      // the 0.83.0 forced-MFA enrollment regression — the rotated cookie failed
      // to round-trip so every subsequent /auth/refresh replays a revoked jti
      // and 401s). Falling through here would fire the request with NO
      // Authorization header, and the API answers 401 "Missing or invalid
      // authorization header" — a confusing dead end that strands the user on
      // the forced-MFA page (its only recovery is a clean re-login).
      //
      // Fail closed instead: clear the dead session and bounce to /login so the
      // user re-authenticates and re-enters the flow with a fresh token. This
      // does NOT weaken auth — protected endpoints (including /auth/mfa/setup)
      // still require a valid Bearer; we simply refuse to send a request we know
      // can't carry one.
      //
      // A THROTTLE is not an expiry (#3696). requestTokenRefreshShared already
      // waited out the server's window once and it is still rationing, so the
      // refresh cookie has never been judged — evicting here would sign out a
      // perfectly good session (and lie about why). Keep the session, keep
      // AuthOverlay's waiting mask up, and let the caller fail this one request.
      if (outcome.kind === 'throttled') {
        throw new AuthThrottledError(
          useAuthStore.getState().authThrottledUntil ?? Date.now() + outcome.retryAfterMs
        );
      }

      // This evicts on 'transient' too (bounded retries exhausted), unlike the
      // background heartbeat which can wait forever: a foreground fetch needs a
      // verdict now — bounded retries, then evict.
      handleSessionExpired(expiryReasonFor(outcome));
      throw new AuthSessionExpiredError();
    }
  }

  const headers = new Headers(options.headers);

  if (tokens?.accessToken) {
    headers.set('Authorization', `Bearer ${tokens.accessToken}`);
  }

  // Don't force a JSON content-type on FormData uploads — the browser must set
  // `multipart/form-data` itself so it can append the boundary. Forcing JSON
  // here strips the boundary and the server can't parse the body (avatar upload).
  // Also don't clobber a caller-provided Content-Type (e.g. `application/octet-stream`
  // for raw chunk PUTs) — only default to JSON when the caller set none.
  if (!(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  // Use caller-provided signal or create a default timeout to prevent indefinite hangs.
  // FormData bodies are file uploads (software installers can be hundreds of MB); a 30s
  // cap aborts an in-flight upload the server then completes anyway, surfacing the
  // confusing "signal is aborted without reason" DOMException even though the file
  // landed (issue #1601). Give uploads a much longer ceiling while keeping it bounded.
  const externalSignal = options.signal;
  const timeoutMs = options.body instanceof FormData ? UPLOAD_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  const controller = !externalSignal ? new AbortController() : null;
  const timeout = controller
    ? setTimeout(
        () =>
          controller.abort(
            new DOMException(`Request timed out after ${Math.round(timeoutMs / 1000)}s`, 'TimeoutError'),
          ),
        timeoutMs,
      )
    : null;
  const signal = externalSignal ?? controller!.signal;

  let response: Response;
  try {
    response = await fetch(buildApiUrl(url), { ...options, headers, credentials: 'include', signal });
  } catch (err) {
    if (timeout) clearTimeout(timeout);
    throw err;
  }
  if (timeout) clearTimeout(timeout);

  // If unauthorized, attempt cookie-backed refresh once (unless the caller's
  // body is single-use and must never be replayed — see skipUnauthorizedRetry).
  if (response.status === 401 && !options.skipUnauthorizedRetry) {
    const outcome = await requestTokenRefreshShared();
    if (outcome.kind === 'restored') {
      setTokens(outcome.tokens);

      // Retry original request with new token
      headers.set('Authorization', `Bearer ${outcome.tokens.accessToken}`);
      response = await fetch(buildApiUrl(url), { ...options, headers, credentials: 'include', signal });
    } else {
      // If another in-flight request already refreshed state, retry once with latest token.
      const latestToken = useAuthStore.getState().tokens?.accessToken;
      if (latestToken && latestToken !== previousAccessToken) {
        headers.set('Authorization', `Bearer ${latestToken}`);
        response = await fetch(buildApiUrl(url), { ...options, headers, credentials: 'include', signal });
      } else {
        // Refresh failed and no newer token exists; the session is
        // unrecoverable. Still return the 401 below — callers may inspect it,
        // and the page is navigating away.
        //
        // Also reached on 'transient' (bounded retries exhausted), unlike the
        // background heartbeat which can wait forever: a foreground fetch needs
        // a verdict now — bounded retries, then evict.
        //
        // A THROTTLE is not an expiry (#3696): the server never judged the
        // refresh cookie, so there is nothing to evict on. Throw rather than
        // fall through and return the original 401 — `lib/errorMessages.ts`
        // classifies a 401 Response as "Session expired", so returning it would
        // put the same false copy in every widget's error card. The typed error
        // is unrecognised by callers (deliberately — see AuthThrottledError) and
        // AuthOverlay's waiting mask owns the visible state.
        if (outcome.kind === 'throttled') {
          throw new AuthThrottledError(
            useAuthStore.getState().authThrottledUntil ?? Date.now() + outcome.retryAfterMs
          );
        }
        handleSessionExpired(expiryReasonFor(outcome));
      }
    }
  }

  // If the partner is inactive, redirect to the account inactive page.
  // This catches any API call that hits the server-side partner guard.
  if (response.status === 403) {
    try {
      const cloned = response.clone();
      const body = await cloned.json();
      if (body?.code === 'PARTNER_INACTIVE') {
        const path = window.location.pathname;
        if (!path.startsWith('/account/') && !path.startsWith('/login')) {
          window.location.href = '/account/inactive';
        }
      }
    } catch {
      // Not JSON or parse failed — treat as normal 403
    }
  }

  // 428 Precondition Required → role-level force_mfa gate fired. The user
  // must enroll MFA before they can hit any protected endpoint (except
  // the small allowlist on the API side: logout, /users/me, MFA setup).
  // Bounce them to the forced-enrollment page unless they're already on it.
  if (response.status === 428 && typeof window !== 'undefined') {
    try {
      const cloned = response.clone();
      const body = await cloned.json();
      if (body?.error === 'mfa_enrollment_required') {
        const path = window.location.pathname;
        if (path !== '/auth/mfa/setup') {
          window.location.href = '/auth/mfa/setup?forced=1';
        }
      }
    } catch {
      // Not JSON or parse failed — surface as a normal 428 to caller
    }
  }

  return response;
}

type ApiAuthSuccess = {
  success: boolean;
  user?: User;
  tokens?: Tokens;
  requiresSetup?: boolean;
  error?: string;
  // #4067: present when the completed step was the link-on-first-SSO-login
  // ceremony — the sanitized post-login relay target from the SSO initiation.
  redirectPath?: string;
};

export type PasskeyRegistrationOptions = PublicKeyCredentialCreationOptionsJSON;
export type PasskeyAuthenticationOptions = PublicKeyCredentialRequestOptionsJSON;
export type PasskeyRegistrationResponse = RegistrationResponseJSON;
export type PasskeyAuthenticationResponse = AuthenticationResponseJSON;

export async function createPasskeyCredential(
  optionsJSON: PasskeyRegistrationOptions
): Promise<PasskeyRegistrationResponse> {
  return startRegistration({ optionsJSON });
}

export async function getPasskeyCredential(
  optionsJSON: PasskeyAuthenticationOptions
): Promise<PasskeyAuthenticationResponse> {
  return startAuthentication({ optionsJSON });
}

export async function apiLogin(email: string, password: string): Promise<{
  success: boolean;
  mfaRequired?: boolean;
  challenge?: MfaChallenge;
  tempToken?: string;
  mfaMethod?: MfaMethod;
  passkeyAvailable?: boolean;
  phoneLast4?: string | null;
  user?: User;
  tokens?: Tokens;
  requiresSetup?: boolean;
  error?: string;
}> {
  try {
    const response = await fetchAuthIssuerWithBindingRetry(buildApiUrl('/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password })
    });

    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: extractApiError(data, 'Login failed') };
    }

    if (data.mfaRequired) {
      const challenge = parseMfaChallengeResponse(data);
      if (!challenge) {
        return { success: false, error: 'Invalid MFA challenge response' };
      }
      return {
        success: true,
        mfaRequired: true,
        challenge,
        tempToken: challenge.tempToken,
        mfaMethod: challenge.primary,
        // #2153: whether a passkey can be used as an alternate factor for this
        // login even when the primary method is totp/sms.
        passkeyAvailable: challenge.allowedMethods.passkey,
        phoneLast4: challenge.phoneLast4
      };
    }

    const user = data.user ? { ...data.user, requiresSetup: !!data.requiresSetup } : data.user;

    return {
      success: true,
      user,
      tokens: data.tokens,
      requiresSetup: !!data.requiresSetup,
      ...(typeof data.redirectPath === 'string' ? { redirectPath: data.redirectPath } : {})
    };
  } catch {
    return { success: false, error: 'Network error' };
  }
}

export async function apiVerifyMFA(
  code: string,
  tempToken: string,
  method?: Exclude<MfaMethod, 'passkey'>,
): Promise<ApiAuthSuccess> {
  try {
    const response = await fetchAuthIssuerWithBindingRetry(buildApiUrl('/auth/mfa/verify'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ code, tempToken, method })
    });

    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: extractApiError(data, 'MFA verification failed') };
    }

    const user = data.user ? { ...data.user, requiresSetup: !!data.requiresSetup } : data.user;

    return {
      success: true,
      user,
      tokens: data.tokens,
      requiresSetup: !!data.requiresSetup,
      ...(typeof data.redirectPath === 'string' ? { redirectPath: data.redirectPath } : {})
    };
  } catch {
    return { success: false, error: 'Network error' };
  }
}

export async function apiVerifyPasskeyMFA(tempToken: string): Promise<ApiAuthSuccess> {
  try {
    const optionsResponse = await fetch(buildApiUrl('/auth/mfa/passkey/options'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ tempToken })
    });

    const optionsData = await optionsResponse.json();

    if (!optionsResponse.ok) {
      return { success: false, error: extractApiError(optionsData, 'Failed to start passkey verification') };
    }

    const optionsJSON = optionsData.options ?? optionsData.optionsJSON;
    const credential = await getPasskeyCredential(optionsJSON);

    const verifyResponse = await fetchAuthIssuerWithBindingRetry(buildApiUrl('/auth/mfa/passkey/verify'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ tempToken, credential })
    });

    const verifyData = await verifyResponse.json();

    if (!verifyResponse.ok) {
      return { success: false, error: extractApiError(verifyData, 'Passkey verification failed') };
    }

    const user = verifyData.user
      ? { ...verifyData.user, requiresSetup: !!verifyData.requiresSetup }
      : verifyData.user;

    return {
      success: true,
      user,
      tokens: verifyData.tokens,
      requiresSetup: !!verifyData.requiresSetup,
      ...(typeof verifyData.redirectPath === 'string' ? { redirectPath: verifyData.redirectPath } : {})
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'NotAllowedError') {
      return { success: false, error: 'Passkey verification was canceled or timed out' };
    }
    console.warn('[apiVerifyPasskeyMFA] passkey MFA verification failed:', error);
    return { success: false, error: 'Network error' };
  }
}

// ── #4067: link-on-first-SSO-login ceremony ─────────────────────────────────
// The SSO callback parked the verified IdP identity server-side and bound the
// ceremony to this browser via an HttpOnly cookie scoped to the API's
// /sso/link endpoints (the API owns the exact path), so both calls just need
// credentials: 'include'.

export async function apiSsoLinkPending(): Promise<
  | { success: true; email: string; providerName: string | null }
  | { success: false; expired: boolean; error?: string }
> {
  try {
    const response = await fetch(buildApiUrl('/sso/link/pending'), {
      method: 'GET',
      credentials: 'include'
    });
    const data = await response.json();
    if (!response.ok) {
      return { success: false, expired: response.status === 404, error: extractApiError(data, 'Ceremony unavailable') };
    }
    return { success: true, email: String(data.email ?? ''), providerName: data.providerName ?? null };
  } catch {
    return { success: false, expired: false, error: 'Network error' };
  }
}

export type SsoLinkConfirmResult =
  | { state: 'mfa'; challenge: MfaChallenge }
  | { state: 'complete'; user: User; tokens: Tokens; requiresSetup: boolean; redirectPath?: string }
  | { state: 'failed'; reason: 'expired' | 'identity_in_use' | 'completion_failed' | 'other'; error?: string };

export async function apiSsoLinkConfirm(password: string): Promise<SsoLinkConfirmResult> {
  try {
    const response = await fetch(buildApiUrl('/sso/link/confirm'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ password })
    });
    const data = await response.json();

    if (!response.ok) {
      if (response.status === 409) return { state: 'failed', reason: 'identity_in_use' };
      if (data?.error === 'sso_link_expired') return { state: 'failed', reason: 'expired' };
      if (data?.error === 'completion_failed') return { state: 'failed', reason: 'completion_failed' };
      return { state: 'failed', reason: 'other', error: extractApiError(data, 'Confirmation failed') };
    }

    if (data.mfaRequired) {
      const challenge = parseMfaChallengeResponse(data);
      if (!challenge) {
        return { state: 'failed', reason: 'other', error: 'Confirmation failed' };
      }
      return { state: 'mfa', challenge };
    }

    if (data.user && data.tokens) {
      return {
        state: 'complete',
        user: data.user,
        tokens: data.tokens,
        requiresSetup: !!data.requiresSetup,
        ...(typeof data.redirectPath === 'string' ? { redirectPath: data.redirectPath } : {})
      };
    }

    // 200 without a recognizable shape — API drift; surface, don't strand.
    return { state: 'failed', reason: 'other', error: 'Confirmation failed' };
  } catch {
    return { state: 'failed', reason: 'other', error: 'Network error' };
  }
}

// An error body may offer a recoverable next step as `{ actionUrl, actionLabel }`.
// Only absolute http(s) URLs are accepted: the value is rendered as an href, so a
// `javascript:`/`data:` scheme must never survive even though the only producer
// today is our own API reading an operator-set env var.
function errorAction(data: unknown): { url: string; label: string } | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const { actionUrl, actionLabel } = data as { actionUrl?: unknown; actionLabel?: unknown };
  if (typeof actionUrl !== 'string' || typeof actionLabel !== 'string' || !actionLabel.trim()) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(actionUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
  return { url: parsed.href, label: actionLabel };
}

// SR2-21: register-partner is now email-first. The endpoint creates NOTHING and
// returns a uniform `{ success: true, message }` whether or not the address
// already has an account (anti-enumeration). No `user`/`partner`/`tokens`/
// `redirectUrl` — the account is created and the session minted only at
// verify-email time (see apiVerifyEmail). Callers must not branch on the body.
export async function apiRegisterPartner(
  companyName: string,
  email: string,
  password: string,
  name: string
): Promise<
  | { success: true; message: string }
  | { success: false; error: string; action?: { url: string; label: string } }
> {
  try {
    const response = await fetch(buildApiUrl('/auth/register-partner'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ companyName, email, password, name, acceptTerms: true })
    });

    const data = await response.json();

    if (!response.ok) {
      // A rejection may carry a recoverable next step (BUSINESS_EMAIL_REQUIRED
      // returns a scheduling link). Dropping it would leave the copy telling
      // the user to "schedule a call" with nothing to click. This is a failure
      // shape only — it never runs on the success path, so it cannot
      // reintroduce the enumeration branch SR2-21 removed.
      return { success: false, error: extractApiError(data, 'Registration failed'), action: errorAction(data) };
    }

    return { success: true, message: data.message };
  } catch {
    return { success: false, error: 'Network error' };
  }
}

// The server-side revoke is best-effort; client-side eviction must never be
// gated on it. Without a bound, a hung /auth/logout strands the idle-timeout
// flow forever: AdminSessionManager awaits this before handleSessionExpired(),
// so the modal sits on "Signing you out…" and idleLogoutInFlightRef
// permanently gates both the heartbeat and the countdown tick. 8s matches
// refreshFetchOnce above.
const LOGOUT_TIMEOUT_MS = 8000;

export type LogoutOutcome =
  | Readonly<{ kind: 'complete' }>
  | Readonly<{ kind: 'partial'; message: string }>;

export type CfTerminalLogoutPreparationOutcome =
  | Readonly<{ kind: 'ready'; navigationUrl: string }>
  | Readonly<{ kind: 'partial'; message: string }>;

function evictLocalAuthState(): void {
  useAuthStore.getState().logout();
  try {
    localStorage.removeItem('breeze-auth');
    localStorage.removeItem('breeze-org');
    localStorage.removeItem('breeze-ai-chat');
  } catch {
    // localStorage may be unavailable
  }
}

function terminalLogoutHeaders(accessToken: string): Headers {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    'x-breeze-auth-transition': 'v1',
  });
  const csrfToken = readCookie(CSRF_COOKIE_NAME);
  if (csrfToken) headers.set(CSRF_HEADER_NAME, csrfToken);
  return headers;
}

export function validateCfTerminalNavigationUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || typeof window === 'undefined') return null;
  try {
    const url = new URL(raw, window.location.origin);
    if (
      url.origin !== window.location.origin
      || url.username !== ''
      || url.password !== ''
      || url.pathname !== '/api/v1/auth/cf-access-logout'
      || url.hash !== ''
    ) return null;
    const entries = [...url.searchParams.entries()];
    if (entries.length !== 1 || entries[0]?.[0] !== 'ticket' || !entries[0][1]) return null;
    return `${url.pathname}?ticket=${encodeURIComponent(entries[0][1])}`;
  } catch {
    return null;
  }
}

export async function apiLogout(retainedAccessToken?: string): Promise<LogoutOutcome> {
  const { tokens } = useAuthStore.getState();
  const accessToken = retainedAccessToken ?? tokens?.accessToken;
  let outcome: LogoutOutcome = {
    kind: 'partial',
    message: 'Your local session was cleared, but durable server sign-out could not be confirmed.',
  };

  if (accessToken) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LOGOUT_TIMEOUT_MS);
    try {
      const response = await fetch(buildApiUrl('/auth/logout'), {
        method: 'POST',
        headers: terminalLogoutHeaders(accessToken),
        credentials: 'include',
        signal: controller.signal
      });
      if (response.ok) {
        const body: unknown = await response.json();
        if (
          typeof body === 'object'
          && body !== null
          && !Array.isArray(body)
          && Object.keys(body).length === 1
          && (body as { success?: unknown }).success === true
        ) {
          outcome = { kind: 'complete' };
        }
      }
    } catch (err) {
      // Network error, offline, or the 8s abort fired. Ignored on purpose —
      // the refresh-token family may survive server-side, but the client must
      // still evict. Logged so a systematically failing revoke is diagnosable.
      console.warn('[apiLogout] logout request failed; evicting client session anyway', err);
    } finally {
      clearTimeout(timeout);
    }
  }

  evictLocalAuthState();
  return outcome;
}

export async function apiPrepareCfTerminalLogout(
  retainedAccessToken?: string,
): Promise<CfTerminalLogoutPreparationOutcome> {
  const { tokens } = useAuthStore.getState();
  const accessToken = retainedAccessToken ?? tokens?.accessToken;
  let outcome: CfTerminalLogoutPreparationOutcome = {
    kind: 'partial',
    message: 'Your local session was cleared, but Cloudflare sign-out could not be prepared.',
  };
  if (accessToken) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LOGOUT_TIMEOUT_MS);
    try {
      const response = await fetch(buildApiUrl('/auth/cf-access-logout/prepare'), {
        method: 'POST',
        headers: terminalLogoutHeaders(accessToken),
        credentials: 'include',
        signal: controller.signal,
      });
      if (response.ok) {
        const body = await response.json().catch(() => null) as { navigationUrl?: unknown } | null;
        const navigationUrl = validateCfTerminalNavigationUrl(body?.navigationUrl);
        if (navigationUrl) outcome = { kind: 'ready', navigationUrl };
      }
    } catch (error) {
      console.warn('[apiLogout] Cloudflare terminal preparation failed; evicting locally', error);
    } finally {
      clearTimeout(timeout);
    }
  }
  evictLocalAuthState();
  return outcome;
}

export async function fetchAndApplyPreferences(): Promise<void> {
  try {
    const response = await fetchWithAuth('/users/me');
    if (!response.ok) {
      console.warn(
        `[fetchAndApplyPreferences] GET /users/me returned ${response.status}; locale resolution skipped`
      );
      return;
    }

    const data = await response.json();
    // isPlatformAdmin rides along with this refresh: fresh logins carry it in
    // the login payload, but sessions persisted before the field existed only
    // learn it here — without the merge, the platform-admin nav stays hidden
    // until the next re-login.
    if (typeof data.isPlatformAdmin === 'boolean') {
      useAuthStore.getState().updateUser({ isPlatformAdmin: data.isPlatformAdmin });
    }
    // Permissions ride along on the same refresh so sessions persisted before
    // the field existed still pick up their grants without a re-login.
    if (Array.isArray(data.permissions)) {
      useAuthStore.getState().updateUser({ permissions: data.permissions });
    }
    // #4018: same rationale — the password-login path stores `data.user` from
    // /auth/login, which carries no hasPassword, and sessions persisted before
    // the field existed carry none either. This refresh (run on every login and
    // on the SSO bootstrap) is what makes `user.hasPassword === false` a real
    // runtime signal rather than a permanently-absent field.
    if (typeof data.hasPassword === 'boolean') {
      useAuthStore.getState().updateUser({ hasPassword: data.hasPassword });
    }
    if (typeof data.canManagePartnerWide === 'boolean') {
      useAuthStore.getState().updateUser({ canManagePartnerWide: data.canManagePartnerWide });
    }
    if (data.preferences) {
      useAuthStore.getState().updateUser({ preferences: data.preferences });
      applyAppearancePreferences(data.preferences);
    }
    applyResolvedLocalePreferences(data.preferences?.locale, data.partnerDefaultLocale);
  } catch (err) {
    // Non-critical for theme — localStorage still has the cached theme — but this
    // also skips locale resolution, which guards against cross-account locale
    // leakage on shared browsers (see applyResolvedLocalePreferences). Log so that
    // failure isn't silent.
    console.warn('[fetchAndApplyPreferences] failed to fetch /users/me; locale resolution skipped:', err);
  }
}

export async function apiForgotPassword(email: string): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const response = await fetch(buildApiUrl('/auth/forgot-password'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email })
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      return { success: false, error: extractApiError(data, 'Failed to send reset email') };
    }

    return { success: true };
  } catch {
    return { success: false, error: 'Network error' };
  }
}

export async function apiResetPassword(token: string, password: string): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const response = await fetch(buildApiUrl('/auth/reset-password'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      referrerPolicy: 'no-referrer',
      body: JSON.stringify({ token, password })
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      return { success: false, error: extractApiError(data, 'Failed to reset password') };
    }

    return { success: true };
  } catch {
    return { success: false, error: 'Network error' };
  }
}

export async function apiVerifyEmail(token: string): Promise<{
  success: boolean;
  error?: 'invalid' | 'expired' | 'consumed' | string;
  partnerId?: string;
  email?: string;
  autoActivated?: boolean;
  // SR2-21 step 2: when the token belongs to a PENDING REGISTRATION, verify-email
  // is the account-creation + session-mint site. A successful completion carries
  // the auto-login `user` + `tokens` (the page calls login() with them). When the
  // address was registered while the link sat in the mailbox, the server returns
  // `{ verified: false, status: 'sign_in' }` — no account is created, direct the
  // holder to sign in.
  user?: User;
  tokens?: Tokens;
  status?: 'sign_in';
  redirectUrl?: string;
}> {
  try {
    const response = await fetchAuthIssuerWithBindingRetry(buildApiUrl('/auth/verify-email'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ token })
    });

    const data = await response.json();
    if (!response.ok) {
      return { success: false, error: data.error };
    }

    // Registration-completion path bounced to sign-in (address already taken).
    // 200 body but `verified: false` — surface the status, not success.
    if (data.verified === false && data.status === 'sign_in') {
      return { success: false, error: 'already_registered', status: 'sign_in' };
    }

    return {
      success: true,
      partnerId: data.partnerId,
      email: data.email,
      autoActivated: data.autoActivated,
      user: data.user,
      tokens: data.tokens,
      // Where the post-registration hook wants a still-inactive partner to go
      // (hosted: /billing/plans). Runs through the shared open-redirect guard
      // rather than a bare `startsWith('/')`, which would admit the
      // protocol-relative `//evil.com` and the `/\evil.com` form some browsers
      // normalize to it. `navigateTo` re-applies getSafeNext at the sink, so
      // this is defence in depth — but the value this function RETURNS must
      // already be safe, or a future caller that navigates directly inherits a
      // hole from a field that looks validated.
      redirectUrl: typeof data.redirectUrl === 'string'
        ? getSafeNext(data.redirectUrl, '') || undefined
        : undefined,
    };
  } catch {
    return { success: false, error: 'Network error' };
  }
}

export async function apiResendVerification(): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetchWithAuth(buildApiUrl('/auth/resend-verification'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return { success: false, error: extractApiError(data, 'Failed to resend verification email') };
    }
    return { success: true };
  } catch {
    return { success: false, error: 'Network error' };
  }
}

export async function apiSendSmsMfaCode(tempToken: string): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const response = await fetch(buildApiUrl('/auth/mfa/sms/send'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tempToken })
    });

    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: extractApiError(data, 'Failed to send SMS code') };
    }

    return { success: true };
  } catch {
    return { success: false, error: 'Network error' };
  }
}

export interface MfaEnrollmentOptions {
  allowedMethods: { totp: boolean; sms: boolean; passkey: boolean };
  phoneConfigured: boolean;
}

export type MfaEnrollmentCompletion =
  | { success: true; recoveryCodes: string[]; tokens: Tokens }
  | { success: false; error: string };

function parseMfaEnrollmentCompletion(data: unknown): MfaEnrollmentCompletion | null {
  if (!data || typeof data !== 'object') return null;
  const value = data as Record<string, unknown>;
  const tokens = value.tokens as Record<string, unknown> | undefined;
  if (
    !Array.isArray(value.recoveryCodes)
    || value.recoveryCodes.some((code) => typeof code !== 'string')
    || !tokens
    || typeof tokens.accessToken !== 'string'
    || typeof tokens.expiresInSeconds !== 'number'
  ) return null;
  return { success: true, recoveryCodes: value.recoveryCodes, tokens: tokens as unknown as Tokens };
}

export async function apiGetMfaEnrollmentOptions(): Promise<
  | { success: true; options: MfaEnrollmentOptions }
  | { success: false; error: string }
> {
  try {
    const response = await fetchWithAuth('/auth/mfa/enrollment-options');
    const data = await response.json().catch(() => null);
    if (!response.ok) return { success: false, error: extractApiError(data, 'Could not load MFA options') };
    if (
      !data
      || typeof data.allowedMethods?.totp !== 'boolean'
      || typeof data.allowedMethods?.sms !== 'boolean'
      || typeof data.allowedMethods?.passkey !== 'boolean'
      || typeof data.phoneConfigured !== 'boolean'
    ) return { success: false, error: 'Invalid MFA enrollment options' };
    return { success: true, options: data as MfaEnrollmentOptions };
  } catch {
    return { success: false, error: 'Network error' };
  }
}

export async function apiEnableTotpMfa(code: string, currentPassword: string): Promise<MfaEnrollmentCompletion> {
  try {
    const response = await fetchWithAuth('/auth/mfa/enable', {
      method: 'POST',
      // #4413: a rejected TOTP comes back as 401, same status the bearer guard
      // uses. Without this the generic 401 path replays the code, or evicts the
      // session outright — on the forced-enrollment page that strands the user
      // with no way back in. The caller already renders the raw error.
      skipUnauthorizedRetry: true,
      body: JSON.stringify({ code, currentPassword }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) return { success: false, error: extractApiError(data, 'Failed to enable MFA') };
    return parseMfaEnrollmentCompletion(data) ?? { success: false, error: 'Invalid MFA enrollment response' };
  } catch {
    return { success: false, error: 'Network error' };
  }
}

export async function apiEnrollPasskey(currentPassword: string): Promise<MfaEnrollmentCompletion> {
  try {
    const optionsResponse = await fetchWithAuth('/auth/passkeys/register/options', {
      method: 'POST',
      body: JSON.stringify({ currentPassword }),
    });
    const optionsData = await optionsResponse.json().catch(() => null);
    if (!optionsResponse.ok) {
      return { success: false, error: extractApiError(optionsData, 'Failed to start passkey enrollment') };
    }
    const credential = await createPasskeyCredential(optionsData.options ?? optionsData.optionsJSON);
    const verifyResponse = await fetchWithAuth('/auth/passkeys/register/verify', {
      method: 'POST',
      body: JSON.stringify({ credential }),
    });
    const verifyData = await verifyResponse.json().catch(() => null);
    if (!verifyResponse.ok) {
      return { success: false, error: extractApiError(verifyData, 'Failed to enroll passkey') };
    }
    return parseMfaEnrollmentCompletion(verifyData) ?? { success: false, error: 'Invalid MFA enrollment response' };
  } catch (error) {
    if (error instanceof Error && error.name === 'NotAllowedError') {
      return { success: false, error: 'Passkey enrollment was canceled or timed out' };
    }
    return { success: false, error: 'Network error' };
  }
}

export async function apiVerifyPhone(phoneNumber: string, currentPassword: string): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const response = await fetchWithAuth('/auth/phone/verify', {
      method: 'POST',
      body: JSON.stringify({ phoneNumber, currentPassword })
    });

    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: extractApiError(data, 'Failed to send verification code') };
    }

    return { success: true };
  } catch {
    return { success: false, error: 'Network error' };
  }
}

export async function apiConfirmPhone(phoneNumber: string, code: string, currentPassword: string): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const response = await fetchWithAuth('/auth/phone/confirm', {
      method: 'POST',
      body: JSON.stringify({ phoneNumber, code, currentPassword })
    });

    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: extractApiError(data, 'Failed to verify phone') };
    }

    return { success: true };
  } catch {
    return { success: false, error: 'Network error' };
  }
}

export async function apiEnableSmsMfa(currentPassword: string): Promise<MfaEnrollmentCompletion> {
  try {
    const response = await fetchWithAuth('/auth/mfa/sms/enable', {
      method: 'POST',
      body: JSON.stringify({ currentPassword })
    });

    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: extractApiError(data, 'Failed to enable SMS MFA') };
    }

    return parseMfaEnrollmentCompletion(data) ?? { success: false, error: 'Invalid MFA enrollment response' };
  } catch {
    return { success: false, error: 'Network error' };
  }
}

export async function apiPreviewInvite(token: string): Promise<{
  success: boolean;
  email?: string;
  name?: string;
  orgName?: string;
  partnerName?: string;
  error?: string;
}> {
  try {
    const response = await fetch(buildApiUrl('/auth/invite/preview'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      referrerPolicy: 'no-referrer',
      body: JSON.stringify({ token }),
    });

    if (!response.ok) {
      return { success: false, error: `Preview unavailable (${response.status})` };
    }

    const data = await response.json();
    return {
      success: true,
      email: data.email,
      name: data.name,
      orgName: data.orgName,
      partnerName: data.partnerName,
    };
  } catch {
    return { success: false, error: 'Network error' };
  }
}

export async function apiAcceptInvite(token: string, password: string): Promise<{
  success: boolean;
  user?: User;
  tokens?: Tokens;
  error?: string;
}> {
  try {
    const response = await fetchAuthIssuerWithBindingRetry(buildApiUrl('/auth/accept-invite'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      referrerPolicy: 'no-referrer',
      body: JSON.stringify({ token, password })
    });

    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: extractApiError(data, 'Failed to accept invite') };
    }

    return { success: true, user: data.user, tokens: data.tokens };
  } catch (err) {
    console.error('[apiAcceptInvite] Request failed:', err);
    return { success: false, error: 'Network error' };
  }
}
