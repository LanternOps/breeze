/**
 * Breeze client-AI session: POST /client-ai/auth/exchange (Plan 1, authoritative
 * — see Pinned server contracts §1). Stores { sessionToken, user, org?, branding? }
 * in memory + sessionStorage; reExchange() is the single-flight 401 recovery
 * path the API client (Task 6) calls.
 */
import { getApiBaseUrl } from '../config';
import {
  defaultEntraTokenDeps,
  getEntraTokenInteractive,
  getEntraTokenSilent,
  type EntraTokenDeps,
} from './entraToken';

export type ExchangeUser = { id: string; email: string; name: string | null };
/** Not sent by Plan 1 yet (Deviation D2) — typed optional so a later server addition needs zero client changes. */
export type ExchangeOrg = { id: string; name?: string | null };
export type ExchangeBranding = { displayName?: string | null; logoUrl?: string | null };

export type ExchangeResponse = {
  accessToken: string;
  expiresInSeconds: number;
  user: ExchangeUser;
  org?: ExchangeOrg;
  branding?: ExchangeBranding;
};

export type AuthBlockKind =
  | 'not_provisioned'
  | 'disabled'
  | 'user_not_permitted'
  | 'account_inactive'
  | 'retryable';

export class AuthBlockedError extends Error {
  constructor(
    public kind: AuthBlockKind,
    public errorCode: string,
  ) {
    super(`client-ai auth blocked: ${errorCode}`);
    this.name = 'AuthBlockedError';
  }
}

/** The exchange 401'd (stale/garbled Entra token). signIn retries once; then this propagates. */
export class InvalidEntraTokenError extends Error {
  constructor() {
    super('Entra token rejected by the exchange');
    this.name = 'InvalidEntraTokenError';
  }
}

export type ClientSession = {
  sessionToken: string;
  expiresAt: number; // epoch ms
  user: ExchangeUser;
  org: ExchangeOrg | null;
  branding: ExchangeBranding | null;
};

const STORAGE_KEY = 'breeze-client-ai-session';
let current: ClientSession | null = null;

export function getStoredSession(): ClientSession | null {
  if (current && Date.now() < current.expiresAt) return current;
  current = null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ClientSession;
    if (typeof parsed.sessionToken !== 'string' || Date.now() >= parsed.expiresAt) return null;
    current = parsed;
    return parsed;
  } catch {
    return null;
  }
}

export function getSessionToken(): string | null {
  return getStoredSession()?.sessionToken ?? null;
}

export function clearSession(): void {
  current = null;
  sessionStorage.removeItem(STORAGE_KEY);
}

/** Test-only: drops the in-memory cache WITHOUT touching sessionStorage. */
export function __resetSessionForTests(): void {
  current = null;
}

function storeSession(res: ExchangeResponse): ClientSession {
  const session: ClientSession = {
    sessionToken: res.accessToken,
    expiresAt: Date.now() + res.expiresInSeconds * 1000,
    user: res.user,
    org: res.org ?? null,
    branding: res.branding ?? null,
  };
  current = session;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    /* storage may be unavailable in some webviews — in-memory still works */
  }
  return session;
}

/** Plan 1 error-code table → screen family (Pinned server contracts §1). */
const BLOCK_KINDS: Record<string, AuthBlockKind> = {
  tenant_not_provisioned: 'not_provisioned',
  not_enabled: 'not_provisioned',
  disabled: 'disabled',
  user_not_permitted: 'user_not_permitted',
  account_inactive: 'account_inactive',
  provisioning_failed: 'retryable',
  rate_limited: 'retryable',
  service_unavailable: 'retryable',
};

async function exchangeOnce(entraToken: string, fetchImpl: typeof fetch): Promise<ClientSession> {
  const res = await fetchImpl(`${getApiBaseUrl()}/client-ai/auth/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: entraToken }),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error body */
  }
  if (res.ok) return storeSession(body as ExchangeResponse);
  const code =
    body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `http_${res.status}`;
  if (res.status === 401) throw new InvalidEntraTokenError();
  throw new AuthBlockedError(BLOCK_KINDS[code] ?? 'retryable', code);
}

export type SignInDeps = { entra?: EntraTokenDeps; fetchImpl?: typeof fetch };

export async function signIn(
  opts: { interactive: boolean },
  deps: SignInDeps = {},
): Promise<ClientSession> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const entraDeps = deps.entra ?? defaultEntraTokenDeps;
  const getToken = opts.interactive ? getEntraTokenInteractive : getEntraTokenSilent;
  const entraToken = await getToken(entraDeps);
  try {
    return await exchangeOnce(entraToken, fetchImpl);
  } catch (err) {
    if (err instanceof InvalidEntraTokenError) {
      // Stale cached Entra token: clear everything and retry once from scratch.
      clearSession();
      const freshToken = await getToken(entraDeps);
      return exchangeOnce(freshToken, fetchImpl);
    }
    throw err;
  }
}

let reExchangeInFlight: Promise<ClientSession> | null = null;

/** Single-flight silent re-auth for API-level 401s (Task 6 apiFetch). */
export function reExchange(deps: SignInDeps = {}): Promise<ClientSession> {
  if (!reExchangeInFlight) {
    clearSession();
    reExchangeInFlight = signIn({ interactive: false }, deps).finally(() => {
      reExchangeInFlight = null;
    });
  }
  return reExchangeInFlight;
}
