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

export type ExchangeResponse =
  | {
      persona?: 'client';
      accessToken: string;
      expiresInSeconds: number;
      user: ExchangeUser;
      org?: ExchangeOrg;
      branding?: ExchangeBranding;
    }
  | {
      persona: 'tech';
      accessToken: string;
      expiresInSeconds: number;
      user: ExchangeUser;
      partner: { id: string };
    };

export type AuthBlockKind =
  | 'not_provisioned'
  | 'disabled'
  | 'user_not_permitted'
  | 'account_inactive'
  | 'retryable'
  | 'unsupported_persona';

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

/** Versioned discriminated union — the durable on-disk (sessionStorage) shape. */
export type ClientPersonaSession = {
  v: 2;
  persona: 'client';
  sessionToken: string;
  expiresAt: number; // epoch ms
  user: ExchangeUser;
  org: ExchangeOrg | null;
  branding: ExchangeBranding | null;
};

export type TechPersonaSession = {
  v: 2;
  persona: 'tech';
  sessionToken: string;
  expiresAt: number; // epoch ms
  user: ExchangeUser;
  partner: { id: string };
};

export type PersonaSession = ClientPersonaSession | TechPersonaSession;

/** Back-compat alias: the client-persona shape, as consumed by ChatPane/Word/Excel/PowerPoint. */
export type ClientSession = ClientPersonaSession;

const STORAGE_KEY = 'breeze-office-addin-session-v2';
/** Pre-Task-20 unversioned key. Never read — only ever removed, so a stale value can't bypass persona resolution. */
const LEGACY_STORAGE_KEY = 'breeze-client-ai-session';

let current: PersonaSession | null = null;

function isPersonaSession(value: unknown): value is PersonaSession {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.v !== 2) return false;
  if (typeof v.sessionToken !== 'string' || typeof v.expiresAt !== 'number') return false;
  if (v.persona === 'client') return true;
  if (v.persona === 'tech') return typeof v.partner === 'object' && v.partner !== null;
  return false;
}

export function getStoredSession(): PersonaSession | null {
  // Sweep the legacy unversioned key on every access — it must never be read,
  // only removed, so it can never bypass persona resolution.
  try {
    sessionStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    /* storage may be unavailable */
  }
  if (current && Date.now() < current.expiresAt) return current;
  current = null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isPersonaSession(parsed) || Date.now() >= parsed.expiresAt) return null;
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

function storeSession(res: ExchangeResponse): PersonaSession {
  const session: PersonaSession =
    res.persona === 'tech'
      ? {
          v: 2,
          persona: 'tech',
          sessionToken: res.accessToken,
          expiresAt: Date.now() + res.expiresInSeconds * 1000,
          user: res.user,
          partner: res.partner,
        }
      : {
          v: 2,
          persona: 'client',
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

const DEFAULT_EXCHANGE_PATH = '/client-ai/auth/exchange';

async function exchangeOnce(
  entraToken: string,
  fetchImpl: typeof fetch,
  exchangePath: string,
): Promise<PersonaSession> {
  const res = await fetchImpl(`${getApiBaseUrl()}${exchangePath}`, {
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

export interface SignInOptions {
  interactive: boolean;
  /** Which exchange endpoint to hit. Defaults to '/client-ai/auth/exchange' (Word/Excel/PowerPoint unchanged). */
  exchangePath?: string;
}

/** Remembered so reExchange (which takes no exchangePath) reuses whatever signIn last used. */
let lastExchangePath = DEFAULT_EXCHANGE_PATH;

export async function signIn(
  opts: SignInOptions,
  deps: SignInDeps = {},
): Promise<PersonaSession> {
  const exchangePath = opts.exchangePath ?? DEFAULT_EXCHANGE_PATH;
  lastExchangePath = exchangePath;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const entraDeps = deps.entra ?? defaultEntraTokenDeps;
  const getToken = opts.interactive ? getEntraTokenInteractive : getEntraTokenSilent;
  const entraToken = await getToken(entraDeps);
  try {
    return await exchangeOnce(entraToken, fetchImpl, exchangePath);
  } catch (err) {
    if (err instanceof InvalidEntraTokenError) {
      // Stale cached Entra token: clear everything and retry once from scratch.
      clearSession();
      const freshToken = await getToken(entraDeps);
      return exchangeOnce(freshToken, fetchImpl, exchangePath);
    }
    throw err;
  }
}

let reExchangeInFlight: Promise<PersonaSession> | null = null;

/** Single-flight silent re-auth for API-level 401s (Task 6 apiFetch). Reuses the last signIn's exchangePath. */
export function reExchange(deps: SignInDeps = {}): Promise<PersonaSession> {
  if (!reExchangeInFlight) {
    clearSession();
    reExchangeInFlight = signIn(
      { interactive: false, exchangePath: lastExchangePath },
      deps,
    ).finally(() => {
      reExchangeInFlight = null;
    });
  }
  return reExchangeInFlight;
}
