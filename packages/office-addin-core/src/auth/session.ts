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
  | 'unsupported_persona'
  /** office-addin only: 403 binding_denied/{epoch_advanced,revoked_relink} — the technician's
   *  Entra↔Breeze binding needs to be re-established via BindFlow. */
  | 'relink_required'
  /** office-addin only: 403 binding_denied/{user_inactive,membership_revoked} — hard stop,
   *  no self-serve recovery. */
  | 'access_revoked';

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

/** The exchange returned 200 but the body doesn't match the ExchangeResponse
 *  contract (a proxy error page, a half-deployed server, a wrong endpoint).
 *  Never stored — storing it would crash consumers like ChatPane later. */
export class MalformedExchangeResponseError extends Error {
  constructor() {
    super('Exchange returned 200 with a body that does not match the ExchangeResponse contract');
    this.name = 'MalformedExchangeResponseError';
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

function isExchangeUser(value: unknown): value is ExchangeUser {
  if (!value || typeof value !== 'object') return false;
  const u = value as Record<string, unknown>;
  return (
    typeof u.id === 'string' &&
    typeof u.email === 'string' &&
    (u.name === null || typeof u.name === 'string')
  );
}

function isPartnerRef(value: unknown): value is { id: string } {
  if (!value || typeof value !== 'object') return false;
  return typeof (value as Record<string, unknown>).id === 'string';
}

function isPersonaSession(value: unknown): value is PersonaSession {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.v !== 2) return false;
  if (typeof v.sessionToken !== 'string' || typeof v.expiresAt !== 'number') return false;
  // `user` is dereferenced downstream (ChatPane reads session.user.email), so a
  // blob without it must not pass — same for the tech persona's partner id.
  if (!isExchangeUser(v.user)) return false;
  if (v.persona === 'client') return true;
  if (v.persona === 'tech') return isPartnerRef(v.partner);
  return false;
}

/** Parse+validate the persisted session WITHOUT the expiry check — reExchange
 *  needs the persona of an expired session to pick the right exchange endpoint. */
function readPersistedSession(): PersonaSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPersonaSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
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
  const persisted = readPersistedSession();
  if (!persisted || Date.now() >= persisted.expiresAt) return null;
  current = persisted;
  return persisted;
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

/** ExchangeResponse with the back-compat optional `persona?: 'client'`
 *  discriminant resolved to a required value — only parseExchangeResponse
 *  produces this, so everything past the parse boundary can switch on persona
 *  without re-handling the optional wire form. */
type NormalizedExchangeResponse =
  | (Extract<ExchangeResponse, { persona?: 'client' }> & { persona: 'client' })
  | Extract<ExchangeResponse, { persona: 'tech' }>;

/** Validate the exchange 200 body against the ExchangeResponse contract and
 *  normalize the persona discriminant. Throws MalformedExchangeResponseError
 *  rather than letting a garbage body be stored as a session. */
function parseExchangeResponse(body: unknown): NormalizedExchangeResponse {
  if (!body || typeof body !== 'object') throw new MalformedExchangeResponseError();
  const b = body as Record<string, unknown>;
  if (
    typeof b.accessToken !== 'string' ||
    typeof b.expiresInSeconds !== 'number' ||
    !isExchangeUser(b.user)
  ) {
    throw new MalformedExchangeResponseError();
  }
  if (b.persona === 'tech') {
    if (!isPartnerRef(b.partner)) throw new MalformedExchangeResponseError();
    return {
      persona: 'tech',
      accessToken: b.accessToken,
      expiresInSeconds: b.expiresInSeconds,
      user: b.user,
      partner: b.partner,
    };
  }
  if (b.persona !== undefined && b.persona !== 'client') throw new MalformedExchangeResponseError();
  return {
    persona: 'client',
    accessToken: b.accessToken,
    expiresInSeconds: b.expiresInSeconds,
    user: b.user,
    org: b.org as ExchangeOrg | undefined,
    branding: b.branding as ExchangeBranding | undefined,
  };
}

function storeSession(res: NormalizedExchangeResponse): PersonaSession {
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

/** office-addin exchange `{error:'binding_denied', reason}` → block kind (Task 25). */
const BINDING_DENIED_KINDS: Record<string, AuthBlockKind> = {
  epoch_advanced: 'relink_required',
  revoked_relink: 'relink_required',
  user_inactive: 'access_revoked',
  membership_revoked: 'access_revoked',
};

const DEFAULT_EXCHANGE_PATH = '/client-ai/auth/exchange';
/** The persona-neutral endpoint the Outlook add-in signs in against (Task 20). */
const TECH_EXCHANGE_PATH = '/office-addin/auth/exchange';

/** Persona → exchange endpoint. Derived (not remembered from the last signIn)
 *  so a session RESTORED from sessionStorage — App's short-circuit never calls
 *  signIn — still re-exchanges against the endpoint that minted it: a tech
 *  session must never hit the client-ai exchange (worst case it would
 *  JIT-provision the technician as a portal user). */
function exchangePathForSession(session: PersonaSession | null): string {
  return session?.persona === 'tech' ? TECH_EXCHANGE_PATH : DEFAULT_EXCHANGE_PATH;
}

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
  if (res.ok) return storeSession(parseExchangeResponse(body));
  const code =
    body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `http_${res.status}`;
  if (res.status === 401) throw new InvalidEntraTokenError();
  if (code === 'binding_denied') {
    const reason =
      body && typeof body === 'object' && typeof (body as { reason?: unknown }).reason === 'string'
        ? (body as { reason: string }).reason
        : '';
    throw new AuthBlockedError(BINDING_DENIED_KINDS[reason] ?? 'retryable', `binding_denied:${reason}`);
  }
  throw new AuthBlockedError(BLOCK_KINDS[code] ?? 'retryable', code);
}

export type SignInDeps = { entra?: EntraTokenDeps; fetchImpl?: typeof fetch };

export interface SignInOptions {
  interactive: boolean;
  /** Which exchange endpoint to hit. Defaults to '/client-ai/auth/exchange' (Word/Excel/PowerPoint unchanged). */
  exchangePath?: string;
}

export async function signIn(
  opts: SignInOptions,
  deps: SignInDeps = {},
): Promise<PersonaSession> {
  const exchangePath = opts.exchangePath ?? DEFAULT_EXCHANGE_PATH;
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

/** Single-flight silent re-auth for API-level 401s (Task 6 apiFetch). The
 *  exchange endpoint is derived from the CURRENT session's persona (in-memory
 *  first, then the persisted copy even when expired) — never remembered from a
 *  prior signIn call, which a restored-from-storage session never made. */
export function reExchange(deps: SignInDeps = {}): Promise<PersonaSession> {
  if (!reExchangeInFlight) {
    const exchangePath = exchangePathForSession(current ?? readPersistedSession());
    clearSession();
    reExchangeInFlight = signIn({ interactive: false, exchangePath }, deps).finally(() => {
      reExchangeInFlight = null;
    });
  }
  return reExchangeInFlight;
}
