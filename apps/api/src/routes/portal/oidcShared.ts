/**
 * The provider-neutral core of the portal SSO routes (portal registration W4
 * #11381 Task 7; moved here by W7 #11384, plan D10, unchanged in behaviour).
 *
 * Each provider's router (./oidc.ts for Microsoft, ./oidcGoogle.ts for Google)
 * keeps its own literal routes, config, query parser and token step, and uses
 * this module for everything a callback does around them:
 *  - the browser-binding cookie's `Secure` rule and the per-IP rate-limit keys
 *    (ONE `start` and ONE `callback` bucket shared by both providers, so
 *    switching providers buys no extra attempts);
 *  - minting the flow state and answering `{ redirectUrl }` at start;
 *  - the callback envelope: always 302, always clears the binding cookie,
 *    never a 500 (an unexpected throw is logged by message and refused);
 *  - the single-use, browser-bound state read;
 *  - `refuse` (one generic failure per purpose; the reason goes to the audit
 *    row and the log only, W4 D15), the audit writer, and `finishSignIn`
 *    (outcome → session mint, audit and the fixed result redirect);
 *  - the invite consumer the resolver calls.
 *
 * Result redirects are the fixed portal paths (`/login?sso=…`,
 * `/profile?sso=…`). A Microsoft flow's URL carries no provider parameter
 * (W4's, byte-identical); a Google flow's always ends in `&p=google` (D10).
 *
 * Nothing here logs or audits a code, token, id_token, secret or token-endpoint
 * body (W4 D14).
 */
import type { Context } from 'hono';
import { envStr } from '../../utils/envStr';
import { rateLimitIpKey } from '../../services/clientIp';
import { writeAuditEventAsync } from '../../services/auditEvents';
import { captureException } from '../../services/sentry';
import type { PortalOidcDenyReason, PortalOidcSignInOutcome } from '../../services/portalOidc/accountResolution';
import {
  PORTAL_OIDC_BINDING_COOKIE,
  PortalOidcStateUnavailableError,
  buildClearPortalOidcBindingCookie,
  buildPortalOidcBindingCookie,
  consumePortalOidcState,
  createPortalOidcState,
} from '../../services/portalOidc/stateStore';
import type { PortalOidcProvider, PortalOidcPurpose, PortalOidcState } from '../../services/portalOidc/types';
import { isRequestConnectionSecure } from '../auth/helpers';
import { auditTenantProofRefusal, entraSetupResult } from './oidcTenantProof';
import { PortalSessionStoreUnavailableError, mintPortalBrowserSession } from './browserSession';
import { consumePortalCapabilityTokenByHash, validatePortalCapability } from './capabilityTokens';
import { buildPortalUrl, getClientIp, getCookieValue, sweepPortalState } from './helpers';

// ============================================
// Constants
// ============================================

/** Global Constraints: per-IP start limiter (login, invite and link starts of every provider share it). */
export const START_RATE_LIMIT = { windowMs: 5 * 60 * 1000, maxAttempts: 20, blockMs: 15 * 60 * 1000 };
/** Global Constraints: per-IP callback limiter (every provider's callback shares it). */
export const CALLBACK_RATE_LIMIT = { windowMs: 5 * 60 * 1000, maxAttempts: 30, blockMs: 15 * 60 * 1000 };

/** The same body the password accept-invite answers for any unusable invite. */
export const INVALID_INVITE = 'Invalid or expired invite';
export const SERVICE_UNAVAILABLE = 'Service temporarily unavailable';

/** The name the server log uses for a provider (never shown to a user). */
function providerLabel(provider: PortalOidcProvider): string {
  return provider === 'google' ? 'Google' : 'Microsoft';
}

// ============================================
// Result redirects: the ONLY places a callback ever sends the browser
// ============================================

export type LoginResult = 'signed_in' | 'request_sent' | 'account_exists' | 'unavailable';
export type ProfileResult = 'linked' | 'unavailable';

/** Microsoft: no provider parameter (W4, byte-identical; the portal reads a missing `p` as Microsoft). */
function providerSuffix(provider: PortalOidcProvider): string {
  return provider === 'google' ? '&p=google' : '';
}

export function loginResult(code: LoginResult, provider: PortalOidcProvider): string {
  return buildPortalUrl(`/login?sso=${code}${providerSuffix(provider)}`);
}

export function profileResult(code: ProfileResult, provider: PortalOidcProvider): string {
  return buildPortalUrl(`/profile?sso=${code}${providerSuffix(provider)}`);
}

/** The generic failure page for a flow's purpose (D15); before a state is read, the login page. */
function failureLocation(purpose: PortalOidcPurpose | undefined, provider: PortalOidcProvider): string {
  switch (purpose?.kind) {
    case 'link': return profileResult('unavailable', provider);
    case 'tenant_proof': return entraSetupResult('failed');
    default: return loginResult('unavailable', provider);
  }
}

// ============================================
// Request helpers
// ============================================

/**
 * `Secure` on the binding cookie (D3): ALWAYS in production. Entra and Google
 * accept an https redirect URI only (localhost aside), so the callback that
 * reads this cookie is always https there, whatever a proxy reports. Outside
 * production it follows the portal session cookie's rule for a `Lax` cookie:
 * the request's transport (HTTPS or a trusted forwarded `X-Forwarded-Proto`)
 * or an explicit PORTAL_COOKIE_FORCE_SECURE / COOKIE_FORCE_SECURE.
 */
export function bindingCookieSecure(c: Context): boolean {
  if (process.env.NODE_ENV === 'production') return true;
  const forced = envStr('PORTAL_COOKIE_FORCE_SECURE', envStr('COOKIE_FORCE_SECURE', '')).toLowerCase();
  return forced === '1' || forced === 'true' || isRequestConnectionSecure(c);
}

export function ipRateKey(prefix: 'start' | 'callback', c: Context): string {
  return `portal:oidc:${prefix}:ip:${rateLimitIpKey(getClientIp(c))}`;
}

/**
 * Mint the state, set the binding cookie, answer `{ redirectUrl }`. 503 when
 * the state store is unavailable. `authorizeUrl` builds the provider's
 * authorize request from the minted state, nonce and PKCE challenge.
 */
export async function startFlow(
  c: Context,
  input: { provider: PortalOidcProvider; purpose: PortalOidcPurpose; hostOrgId: string | null; authority: string },
  authorizeUrl: (flow: { state: string; nonce: string; codeChallenge: string }) => string,
) {
  let flow: Awaited<ReturnType<typeof createPortalOidcState>>;
  try {
    flow = await createPortalOidcState(input);
  } catch (error) {
    if (error instanceof PortalOidcStateUnavailableError) return c.json({ error: SERVICE_UNAVAILABLE }, 503);
    throw error;
  }
  const redirectUrl = authorizeUrl({ state: flow.state, nonce: flow.nonce, codeChallenge: flow.codeChallenge });
  c.header('Set-Cookie', buildPortalOidcBindingCookie(flow.bindingCookie, { secure: bindingCookieSecure(c) }), { append: true });
  c.header('Cache-Control', 'no-store');
  return c.json({ redirectUrl });
}

// ============================================
// Audit (the callback is a GET: the POST-only portal auth audit wrapper skips it)
// ============================================

export type CallbackFailureReason =
  | PortalOidcDenyReason
  | 'rate_limited'
  | 'not_configured'
  | 'query_invalid'
  | 'provider_error'
  | 'state_invalid'
  | 'token_invalid'
  | 'session_unavailable'
  | 'internal_error';

interface OidcAuditInput {
  action: 'portal.auth.oidc.login' | 'portal.auth.identity.link';
  orgId: string | null;
  portalUserId: string | null;
  result: 'success' | 'failure';
  details: Record<string, unknown>;
}

/** One secret-free row. A failed audit write never changes the redirect. */
async function writeOidcAudit(c: Context, provider: PortalOidcProvider, input: OidcAuditInput): Promise<void> {
  try {
    await writeAuditEventAsync(c, {
      orgId: input.orgId,
      actorType: input.portalUserId ? 'user' : 'system',
      // Null → the anonymous actor id (no `rawActorId` noise in the details).
      actorId: input.portalUserId,
      initiatedBy: 'manual',
      action: input.action,
      resourceType: input.portalUserId ? 'portal_user' : 'portal_auth',
      resourceId: input.portalUserId,
      result: input.result,
      details: input.details,
    });
  } catch (error) {
    console.error(`[portal] ${providerLabel(provider)} sign-in audit write failed:`, error instanceof Error ? error.message : error);
    captureException(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * A refused sign-in: the reason goes to the audit row and the log only (D15).
 * A proof flow refused here (before its branch) is audited as a refused proof
 * on the run's org; its branch audits its own refusals.
 */
export async function refuse(
  c: Context,
  reason: CallbackFailureReason,
  ctx: { purpose?: PortalOidcPurpose; orgId?: string | null; provider: PortalOidcProvider },
): Promise<string> {
  const { purpose, provider } = ctx;
  console.warn(`[portal] ${providerLabel(provider)} sign-in refused`, { reason, purpose: purpose?.kind ?? null, orgId: ctx.orgId ?? null });
  if (purpose?.kind === 'tenant_proof') {
    await auditTenantProofRefusal(c, purpose.orgId, reason);
  } else {
    await writeOidcAudit(c, provider, {
      action: 'portal.auth.oidc.login',
      orgId: ctx.orgId ?? (purpose?.kind === 'link' ? purpose.orgId : null),
      portalUserId: purpose?.kind === 'link' ? purpose.portalUserId : null,
      result: 'failure',
      details: { provider, outcome: 'denied', reason },
    });
  }
  return failureLocation(purpose, provider);
}

// ============================================
// Callback
// ============================================

export type CallbackQuery =
  | { kind: 'code'; state: string; code: string }
  | { kind: 'provider_error'; state: string | null };

const CALLBACK_CODE_KEYS: ReadonlySet<string> = new Set(['code', 'state', 'session_state']);

export function single(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? values[0]! : null;
}

export function validOpaque(value: string | null, maxLength: number): value is string {
  return value !== null && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * Strict allowlist parse of Microsoft's authorization response
 * (`response_mode=query`), the approach of `parseM365ConsentCallbackQuery`. A
 * response carrying `error` is a provider error whatever else it carries (its
 * single, well-formed `state` is still consumed so it cannot be replayed).
 * Otherwise only `code`, `state` and `session_state`, each exactly once;
 * anything else is null.
 */
export function parseCallbackQuery(params: URLSearchParams): CallbackQuery | null {
  if (params.has('error')) {
    const state = single(params, 'state');
    return { kind: 'provider_error', state: validOpaque(state, 512) ? state : null };
  }
  const keys = [...params.keys()];
  if (new Set(keys).size !== keys.length) return null;
  if (keys.some((key) => !CALLBACK_CODE_KEYS.has(key))) return null;
  const state = single(params, 'state');
  const code = single(params, 'code');
  if (!validOpaque(state, 512) || !validOpaque(code, 8192)) return null;
  if (params.has('session_state') && !validOpaque(single(params, 'session_state'), 256)) return null;
  return { kind: 'code', state, code };
}

/** What a callback carries across its steps: `purpose` is set as soon as the state is read. */
export interface CallbackContext {
  purpose?: PortalOidcPurpose;
}

/**
 * Step 2: the single-use, browser-bound state. A provider error burns the
 * state the provider echoed (if it is ours and this browser's) and lands on
 * that purpose's page. `ctx.purpose` is set as soon as a state is read, so an
 * unexpected throw later still lands on the right page.
 */
export async function readCallbackState(
  c: Context,
  provider: PortalOidcProvider,
  query: CallbackQuery,
  ctx: CallbackContext,
): Promise<{ ok: true; state: PortalOidcState; code: string } | { ok: false; location: string }> {
  const bindingCookie = getCookieValue(c.req.header('cookie'), PORTAL_OIDC_BINDING_COOKIE) ?? undefined;

  if (query.kind === 'provider_error') {
    const state = query.state ? await consumePortalOidcState(query.state, bindingCookie) : null;
    ctx.purpose = state?.purpose;
    return { ok: false, location: await refuse(c, 'provider_error', { purpose: state?.purpose, provider }) };
  }

  const state = await consumePortalOidcState(query.state, bindingCookie);
  if (!state) return { ok: false, location: await refuse(c, 'state_invalid', { provider }) };
  ctx.purpose = state.purpose;
  return { ok: true, state, code: query.code };
}

/**
 * The callback envelope: ALWAYS clears the binding cookie (single-use whatever
 * the outcome) and ALWAYS answers 302. An unexpected throw from `run` (the
 * database, an invariant) is logged by message only and refused (no token
 * material reaches this point: each token step catches its own errors).
 */
export async function answerCallback(
  c: Context,
  provider: PortalOidcProvider,
  run: (ctx: CallbackContext) => Promise<string>,
) {
  sweepPortalState();
  c.header('Set-Cookie', buildClearPortalOidcBindingCookie({ secure: bindingCookieSecure(c) }), { append: true });
  c.header('Cache-Control', 'no-store');

  const ctx: CallbackContext = {};
  let location: string;
  try {
    location = await run(ctx);
  } catch (error) {
    console.error(`[portal] ${providerLabel(provider)} sign-in callback failed:`, error instanceof Error ? error.message : error);
    location = await refuse(c, 'internal_error', { purpose: ctx.purpose, provider });
  }
  return c.redirect(location, 302);
}

/**
 * The real invite consumer the resolver calls (step 2): GET+DEL by the hash the
 * state carries, then the W2 re-check without the password requirement. It
 * answers the epoch the invite was ISSUED at; the resolver re-checks it under
 * a row lock.
 */
export async function consumeInviteForSso(
  inviteTokenHash: string,
): Promise<{ portalUserId: string; orgId: string; authEpoch: number } | null> {
  const consumed = await consumePortalCapabilityTokenByHash('invite', inviteTokenHash);
  if (!consumed || consumed.format !== 'v2') return null;
  const check = await validatePortalCapability('invite', consumed, { requirePasswordMethod: false });
  if (!check.ok) return null;
  return { portalUserId: check.user.id, orgId: check.user.orgId, authEpoch: consumed.payload.authEpoch };
}

/** Steps 6–7: map the resolver's outcome to a redirect, minting the session and auditing. */
export async function finishSignIn(
  c: Context,
  provider: PortalOidcProvider,
  purpose: Exclude<PortalOidcPurpose, { kind: 'tenant_proof' }>,
  outcome: PortalOidcSignInOutcome,
): Promise<string> {
  if (outcome.kind === 'denied') return refuse(c, outcome.reason, { purpose, orgId: outcome.orgId, provider });

  // A link flow only ever ends linked (or denied, above).
  if (purpose.kind === 'link') {
    if (outcome.kind !== 'linked') return refuse(c, 'link_invalid', { purpose, orgId: outcome.orgId, provider });
    await writeOidcAudit(c, provider, {
      action: 'portal.auth.identity.link',
      orgId: outcome.orgId,
      portalUserId: outcome.portalUserId,
      result: 'success',
      details: { provider, linkedVia: 'self_link' },
    });
    return profileResult('linked', provider);
  }

  switch (outcome.kind) {
    case 'session': {
      // This callback resolves only Microsoft identities; a Google session is
      // never minted here (W7 Task 7 adds the Google callback). Fail closed.
      if (outcome.method === 'google') return refuse(c, 'internal_error', { purpose, orgId: outcome.orgId, provider });
      // An invite activation has already committed (account active, identity
      // linked): record it whether or not the session store takes the session.
      if (outcome.via === 'invite') {
        await writeOidcAudit(c, provider, {
          action: 'portal.auth.identity.link',
          orgId: outcome.orgId,
          portalUserId: outcome.portalUserId,
          result: 'success',
          details: { provider, linkedVia: 'invite' },
        });
      }
      try {
        await mintPortalBrowserSession(c, {
          portalUserId: outcome.portalUserId,
          orgId: outcome.orgId,
          authEpoch: outcome.authEpoch,
          method: 'entra',
          entraTenantId: outcome.entraTenantId,
        });
      } catch (error) {
        if (error instanceof PortalSessionStoreUnavailableError) {
          return refuse(c, 'session_unavailable', { purpose, orgId: outcome.orgId, provider });
        }
        throw error;
      }
      if (outcome.via !== 'invite') {
        await writeOidcAudit(c, provider, {
          action: 'portal.auth.oidc.login',
          orgId: outcome.orgId,
          portalUserId: outcome.portalUserId,
          result: 'success',
          details: { provider, outcome: 'session', via: outcome.via },
        });
      }
      return loginResult('signed_in', provider);
    }
    case 'request_sent':
    case 'account_exists':
      await writeOidcAudit(c, provider, {
        action: 'portal.auth.oidc.login',
        orgId: outcome.orgId,
        portalUserId: null,
        result: 'success',
        details: { provider, outcome: outcome.kind },
      });
      return loginResult(outcome.kind, provider);
    default:
      // `linked` for a non-link purpose cannot happen; fail closed.
      return refuse(c, 'link_invalid', { purpose, orgId: outcome.orgId, provider });
  }
}
