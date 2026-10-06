/**
 * Xero HTTP boundary (Xero W02). Everything that speaks Xero's wire format lives
 * here: the OAuth token endpoint, the identity /connections API, tenant-scoped
 * Accounting API reads, and the translation of Xero failures into
 * AccountingProviderError. xeroProvider.ts composes these; the accounting core
 * never imports this module.
 *
 * Token and identity calls run OUTSIDE the rate-limit slot (W01c convention): they
 * are not tenant-scoped and a throttled refresh is retried by accountingTokens.
 * Every tenant-scoped call goes through withProviderCallSlot, which wraps ONLY the
 * leaf round trip (request + body read), never a caller's retry or fallback.
 *
 * Throttles (W01c P5): a limiter refusal thrown by withProviderCallSlot is already
 * an AccountingProviderError{kind:'rate_limited'} and propagates untouched; an
 * HTTP 429 from Xero is classified `rate_limited` BEFORE anything else, whatever
 * its body says, so it is never read as a reauth or validation verdict.
 */
import { createHash } from 'node:crypto';
import { runOutsideDbContext } from '../../db';
import { xeroOAuthConfig } from '../../config/env';
import {
  AccountingProviderError, DEFAULT_RATE_LIMIT_DELAY_MS, type AccountingProviderErrorKind, type AccountingRefusalCode,
} from './accountingProviderError';
import { noteDailyRemaining, withProviderCallSlot } from './accountingRateLimit';
import { parseRetryAfterMs } from './retryAfter';
import type { ConnectionTokens, ProviderTenant, RateLimitSpec } from './types';

export const XERO_AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
export const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
export const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';
export const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0';

/**
 * Pinned granular scopes (spec open item 3; Xero moved apps to granular scopes on
 * 2026-03-02). Requested in full at W02 because Xero cannot widen a token's scope
 * without a fresh consent: contacts (W03), invoices (W04), payments (W05), and
 * settings — Organisation, Currencies, Accounts, TaxRates reads (W02) plus Item
 * writes (W03). Lab X16 (2026-09-28) proved Items are NOT written under
 * accounting.invoices: an Item create under accounting.settings.read returns
 * 401 insufficient_scope, so the write scope replaces the read one.
 * offline_access is what makes Xero issue a refresh token at all.
 */
export const XERO_SCOPES: readonly string[] = Object.freeze([
  'offline_access',
  'accounting.contacts',
  'accounting.invoices',
  'accounting.payments',
  'accounting.settings',
]);

/** Xero's refresh token lifetime is a sliding 60 days it does NOT return (spec W02 "Tokens"). */
export const XERO_REFRESH_TOKEN_LIFETIME_MS = 60 * 24 * 60 * 60 * 1000;
export const XERO_REQUEST_TIMEOUT_MS = 15_000;

export type XeroTokenGrant =
  | { grantType: 'authorization_code'; code: string }
  | { grantType: 'refresh_token'; refreshToken: string };

interface XeroTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface XeroRawConnection {
  id?: string;
  authEventId?: string | null;
  tenantId?: string;
  tenantType?: string;
  tenantName?: string | null;
}

interface XeroRawError {
  Message?: string;
  Detail?: string;
  Title?: string;
  Elements?: Array<{ ValidationErrors?: Array<{ Message?: string }> }>;
}

function providerError(init: {
  kind: AccountingProviderErrorKind; operation: string; message: string; httpStatus?: number;
  providerCode?: string; providerMessage?: string; retryAfterMs?: number; logBody?: string; cause?: unknown;
}): AccountingProviderError {
  return new AccountingProviderError({
    provider: 'xero',
    ...init,
    // Only Xero's own 429 reaches this helper as rate_limited; a local limiter
    // refusal is raised by withProviderCallSlot and never passes through here.
    throttleSource: init.kind === 'rate_limited' ? 'provider' : undefined,
  });
}

function retryAfterFor(headers: Headers): number {
  return parseRetryAfterMs(headers.get('retry-after')) ?? DEFAULT_RATE_LIMIT_DELAY_MS;
}

/**
 * The leaf round trip every Xero call makes: fetch + body read, with no DB
 * context held. A fetch that never produced a response (timeout, DNS, reset)
 * becomes a Xero-attributed `transient` whose message names only the operation
 * and the failure class — never the URL, a header or a token (the raw error is
 * kept as `cause` for the server log). An AccountingProviderError is never
 * re-wrapped, so a throttle keeps its `rate_limited` kind (W01c P5).
 */
async function xeroRoundTrip(operation: string, url: string, init: RequestInit): Promise<{ response: Response; text: string }> {
  try {
    return await runOutsideDbContext(async () => {
      const response = await fetch(url, init);
      return { response, text: await response.text() };
    });
  } catch (err) {
    if (err instanceof AccountingProviderError) throw err;
    const name = err && typeof err === 'object' ? (err as { name?: unknown }).name : undefined;
    const failure = name === 'TimeoutError' || name === 'AbortError' ? 'timed out' : 'could not reach Xero';
    throw providerError({ kind: 'transient', operation, message: `${operation} ${failure}`, cause: err });
  }
}

/** Same shape the token decoder accepts: an id, never a query fragment. */
const AUTH_EVENT_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Which /connections rows a caller may see. There is deliberately no nullable
 * form: a missing `authentication_event_id` claim (decoder returns null) can
 * never type-check as — or be coerced into — the unfiltered read.
 */
export type XeroConnectionsFilter =
  | { authEventId: string }
  /**
   * The UNFILTERED read. Reserved for the reconnect lookup (plan refinement
   * item 2): its result may only be used to SELECT the tenant id the partner's
   * own row already holds. Never a fallback for a missing claim, never used to
   * pick, list for choice, or delete another tenant.
   */
  | { all: true };

/** The most specific human message in a Xero error body, or null. Never the whole body. */
export function xeroFaultMessage(text: string): string | null {
  try {
    const body = JSON.parse(text) as XeroRawError | null;
    if (!body || typeof body !== 'object') return null;
    const validation = body.Elements
      ?.flatMap((e) => e?.ValidationErrors ?? [])
      .map((v) => v?.Message)
      .find((m): m is string => typeof m === 'string' && m.length > 0);
    const message = validation ?? body.Message ?? body.Detail ?? body.Title ?? null;
    return typeof message === 'string' ? message.slice(0, 200) : null;
  } catch {
    return null;
  }
}

function allValidationMessages(text: string): string[] {
  try {
    const body = JSON.parse(text) as XeroRawError | null;
    if (!body || typeof body !== 'object') return [];
    return (body.Elements ?? [])
      .flatMap((e) => e?.ValidationErrors ?? [])
      .map((v) => v?.Message)
      .filter((m): m is string => typeof m === 'string' && m.length > 0);
  } catch {
    return [];
  }
}

/**
 * Structured verdict for a Xero 400 (refinement 5). Runs over EVERY validation
 * message, untruncated — `xeroFaultMessage` keeps only the first, cut at 200
 * chars, and a contact name alone may be 255.
 */
export function classifyXeroValidation(text: string): AccountingRefusalCode | undefined {
  for (const message of allValidationMessages(text)) {
    if (/^The contact name .+ is already assigned to another contact/is.test(message)) return 'duplicate_name';
    if (/^The contact number .+ is already assigned to another contact/is.test(message)) return 'duplicate_key';
    if (/^(Price List Item|Item code) .+ already exists/is.test(message)) return 'duplicate_key';
    // Xero W05 (refinement 16). The first two texts are reported by Xero integrators
    // (the docs state the rules, not the words); the reconciled-delete text is
    // undocumented. Lab X55/X56 record the real messages; adjust here if they differ.
    if (/^Payment amount exceeds the amount outstanding/i.test(message)) return 'amount_exceeds_due';
    if (/can only be made against Authori[sz]ed documents/i.test(message)) return 'remote_missing';
    // #7300: a member of a batch payment. BEFORE the reconciled test: a batch can
    // also be reconciled, and the batch is the more specific instruction. The
    // first form is the text integrators report ("Payments within a batch cannot
    // be deleted."); the rest are defensive until lab X55/X56 records Xero's words.
    // Every form needs both a batch AND a refusal, so a text that merely names a
    // batch payment is not read as one.
    if (/\b(within|part of|belongs? to|member of) a batch\b/i.test(message)
      || /\bbatch(ed)?\b[^.]*\b(cannot|can ?not|can't|unable to)\b[^.]*\b(delet|remov|void)/i.test(message)) return 'remote_batched';
    if (/\b(has been|is) reconciled\b|\breconciled (payment|transaction)/i.test(message)) return 'remote_locked';
  }
  return undefined;
}

/**
 * 400s that are not plain validation refusals (Xero W04):
 *  - duplicate_doc_number — Xero's OpenAPI example text "Invoice # must be unique."
 *    The provider absorbs it (adoption look, then one numberless retry).
 *  - payment_linked — a void (or a line edit) refused because a payment or credit
 *    note is allocated. Texts reported by Xero integrators; lab X39 confirms.
 *  - transient — "Idempotency Key: … is used with a different request." The same
 *    request identity was sent earlier with other bytes (a concurrent push, or a
 *    settings change inside the 6-minute window): an UNCERTAIN outcome, so the
 *    caller looks again instead of treating it as a refusal (refinement 2).
 * Runs over every validation message, untruncated, and the top-level Message.
 */
export function classifyXeroInvoiceKind(text: string): 'duplicate_doc_number' | 'payment_linked' | 'transient' | undefined {
  let topLevel: string | null = null;
  try {
    const parsed = JSON.parse(text) as { Message?: unknown } | null;
    topLevel = typeof parsed?.Message === 'string' ? parsed.Message : null;
  } catch { /* not JSON: no verdict from the top level */ }
  for (const message of [...allValidationMessages(text), ...(topLevel ? [topLevel] : [])]) {
    if (/^Invoice # must be unique/i.test(message)) return 'duplicate_doc_number';
    if (/(has|have) (payments? or credit notes?|a payment or credit note) allocated/i.test(message)) return 'payment_linked';
    if (/^Idempotency Key: .* is used with a different request/i.test(message)) return 'transient';
  }
  return undefined;
}

/** Matches `insufficient_scope` and Xero's documented misspelling `insufficent_scope` (the optional `i`). */
const INSUFFICIENT_SCOPE_RE = /insuffici?ent_scope/i;

function apiKindFor(status: number, headers: Headers, text: string): AccountingProviderErrorKind {
  // 429 first: a throttle is never read as any other verdict (W01c P5).
  if (status === 429) return 'rate_limited';
  // A token that lacks a scope is a partner-fixable refusal (reconnect with the
  // scope), never a transient to retry forever.
  if ((status === 401 || status === 403) && INSUFFICIENT_SCOPE_RE.test(headers.get('www-authenticate') ?? '')) return 'validation';
  if (status === 400) return classifyXeroInvoiceKind(text) ?? 'validation';
  if (status === 404) return 'not_found';
  return 'transient'; // 401/403 (link removed), 5xx, anything else
}

export function xeroApiError(operation: string, status: number, headers: Headers, text: string): AccountingProviderError {
  const kind = apiKindFor(status, headers, text);
  const providerCode = kind === 'rate_limited'
    ? headers.get('x-rate-limit-problem') ?? undefined // 'minute' | 'day' | 'appminute' | 'concurrent'
    : kind === 'validation'
      ? (status === 400 ? classifyXeroValidation(text) : 'insufficient_scope')
      : undefined;
  return providerError({
    kind,
    operation,
    message: `${operation} failed with ${status}`,
    httpStatus: status,
    providerMessage: xeroFaultMessage(text) ?? undefined,
    providerCode,
    retryAfterMs: kind === 'rate_limited' ? retryAfterFor(headers) : undefined,
    logBody: text.slice(0, 500),
  });
}

export function xeroTokenError(operation: string, status: number, headers: Headers, text: string): AccountingProviderError {
  let parsed: XeroTokenResponse = {};
  try {
    const body = JSON.parse(text) as unknown;
    if (body && typeof body === 'object') parsed = body as XeroTokenResponse;
  } catch { /* non-JSON error page */ }
  const errorCode = typeof parsed.error === 'string' ? parsed.error : undefined;
  // Order matters:
  // 1. A 429 is a throttle WHATEVER its body says (W01c P5; mirrors the QuickBooks
  //    token-endpoint fix) — never reauth, which would force-disconnect the partner.
  // 2. Only an explicit `error: invalid_grant` on a 4xx is permanent reauth (OAuth
  //    returns it as 400). accountingTokens re-checks for a lost rotation race
  //    before acting on it. A 5xx is transient even if its body names invalid_grant.
  const kind: AccountingProviderErrorKind = status === 429
    ? 'rate_limited'
    : errorCode === 'invalid_grant' && status >= 400 && status < 500
      ? 'reauth'
      : status === 400 ? 'validation' : 'transient';
  return providerError({
    kind,
    operation,
    message: `${operation} failed with ${status}`,
    httpStatus: status,
    providerCode: errorCode,
    providerMessage: typeof parsed.error_description === 'string' ? parsed.error_description.slice(0, 200) : undefined,
    retryAfterMs: kind === 'rate_limited' ? retryAfterFor(headers) : undefined,
  });
}

export async function requestXeroTokens(grant: XeroTokenGrant): Promise<ConnectionTokens> {
  const { clientId, clientSecret, redirectUri } = xeroOAuthConfig();
  const operation = grant.grantType === 'authorization_code' ? 'Xero token exchange' : 'Xero token refresh';
  if (!clientId || !clientSecret) {
    // The partner's grant is fine; THIS instance is misconfigured (env vars
    // removed while Xero rows exist). Transient, never reauth — flipping every
    // Xero partner to reauth_required would be wrong and unrecoverable by them.
    // Refused before any fetch: sending `Basic base64(":")` only earns a 401.
    throw providerError({ kind: 'transient', operation, message: 'Xero OAuth is not configured on this instance' });
  }
  const body = new URLSearchParams();
  if (grant.grantType === 'authorization_code') {
    body.set('grant_type', 'authorization_code');
    body.set('code', grant.code);
    body.set('redirect_uri', redirectUri);
  } else {
    body.set('grant_type', 'refresh_token');
    body.set('refresh_token', grant.refreshToken);
  }

  const { response, text } = await xeroRoundTrip(operation, XERO_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(XERO_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw xeroTokenError(operation, response.status, response.headers, text);

  let parsed: XeroTokenResponse;
  try {
    parsed = JSON.parse(text) as XeroTokenResponse;
  } catch {
    throw providerError({ kind: 'transient', operation, message: `${operation} returned invalid JSON` });
  }
  if (
    !parsed || typeof parsed.access_token !== 'string' || !parsed.access_token
    || typeof parsed.refresh_token !== 'string' || !parsed.refresh_token
    || typeof parsed.expires_in !== 'number' || !(parsed.expires_in > 0)
  ) {
    throw providerError({ kind: 'transient', operation, message: `${operation} response was missing required fields` });
  }
  const now = Date.now();
  return {
    // Xero's callback carries no realm: the tenant is chosen after the exchange
    // (spec W02 "OAuth"). The callback never reads this field for Xero.
    realmId: '',
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    accessTokenExpiresAt: new Date(now + parsed.expires_in * 1000),
    refreshTokenExpiresAt: new Date(now + XERO_REFRESH_TOKEN_LIFETIME_MS),
  };
}

/**
 * The access token's `authentication_event_id` claim, or null (fail closed —
 * spec open item 4). The token came straight from Xero's token endpoint over
 * TLS, so its payload is read, not verified; nothing here grants access, the
 * value only NARROWS which /connections rows this flow may touch.
 */
export function decodeXeroAuthEventId(accessToken: string): string | null {
  const parts = accessToken.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
    if (!claims || typeof claims !== 'object') return null;
    const value = (claims as Record<string, unknown>).authentication_event_id;
    return typeof value === 'string' && AUTH_EVENT_ID_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * GET /connections.
 * - `{ authEventId }`: only links created by THAT auth event — filtered by Xero
 *   (query param) AND here on strict equality (defence in depth: a Xero that
 *   ignored the parameter must still never hand back another Breeze partner's
 *   links; spec quorum finding 3). An id that is not the decoder's shape (empty,
 *   null, a query fragment) fails closed as `validation` before any request.
 * - `{ all: true }`: the unfiltered reconnect lookup ONLY — see XeroConnectionsFilter.
 * Anything else fails closed as `validation`.
 */
export async function listXeroConnections(accessToken: string, filter: XeroConnectionsFilter): Promise<ProviderTenant[]> {
  const operation = 'Xero connections list';
  let authEventId: string | null;
  if (filter && typeof filter === 'object' && 'authEventId' in filter) {
    const candidate: unknown = filter.authEventId;
    if (typeof candidate !== 'string' || !AUTH_EVENT_ID_RE.test(candidate)) {
      throw providerError({ kind: 'validation', operation, message: `${operation} refused: invalid auth event id` });
    }
    authEventId = candidate;
  } else if (filter && typeof filter === 'object' && 'all' in filter && filter.all === true) {
    authEventId = null;
  } else {
    throw providerError({ kind: 'validation', operation, message: `${operation} refused: no filter mode` });
  }
  const url = authEventId === null
    ? XERO_CONNECTIONS_URL
    : `${XERO_CONNECTIONS_URL}?authEventId=${encodeURIComponent(authEventId)}`;
  const { response, text } = await xeroRoundTrip(operation, url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(XERO_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw xeroApiError(operation, response.status, response.headers, text);
  let rows: unknown;
  try {
    rows = JSON.parse(text);
  } catch {
    throw providerError({ kind: 'transient', operation, message: `${operation} returned invalid JSON` });
  }
  if (!Array.isArray(rows)) throw providerError({ kind: 'transient', operation, message: `${operation} returned an unexpected shape` });
  return (rows as Array<XeroRawConnection | null>)
    .filter((r): r is XeroRawConnection => !!r && typeof r === 'object'
      && typeof r.id === 'string' && typeof r.tenantId === 'string')
    .filter((r) => authEventId === null || r.authEventId === authEventId)
    .map((r) => ({
      tenantId: r.tenantId as string,
      connectionRef: r.id as string,
      name: r.tenantName || (r.tenantId as string),
      tenantType: typeof r.tenantType === 'string' ? r.tenantType : '',
      authEventId: typeof r.authEventId === 'string' ? r.authEventId : null,
    }));
}

/** DELETE /connections/{id}: removes exactly one link. 404 = already gone = success. Never token revocation. */
export async function deleteXeroConnection(accessToken: string, connectionRef: string): Promise<void> {
  const operation = 'Xero connection delete';
  const { response, text } = await xeroRoundTrip(operation, `${XERO_CONNECTIONS_URL}/${encodeURIComponent(connectionRef)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(XERO_REQUEST_TIMEOUT_MS),
  });
  if (response.ok || response.status === 404) return;
  throw xeroApiError(operation, response.status, response.headers, text);
}

export interface XeroCallContext {
  connectionId: string;
  tenantId: string;
  accessToken: string;
  rate: RateLimitSpec;
  timeoutMs?: number;
}

export function xeroQuery(params: Record<string, string | number | boolean | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/**
 * One key per immutable request (refinement 9): an identical retry replays inside
 * Xero's 6-minute window; any change to tenant, method, path or body yields a new
 * key, so Xero's "used with a different request" 400 cannot happen. Keys are
 * per-app at Xero, so the tenant is part of the input.
 */
export function xeroIdempotencyKey(tenantId: string, method: string, path: string, body: string): string {
  return `breeze-${createHash('sha256').update([tenantId, method, path, body].join('\n')).digest('hex')}`;
}

/**
 * `xeroApiGet`/`xeroApiWrite` type their return as `T` but only guarantee valid
 * JSON — a `null` body (or any non-object shape) parses cleanly and would
 * otherwise throw a bare TypeError the first time a caller reads a property off
 * it. Never wraps an error the call itself threw; it only guards the parsed
 * payload once that call has already succeeded.
 */
export function requireXeroBody<T extends object>(body: T | null, operation: string): T {
  if (body === null || typeof body !== 'object') {
    throw new AccountingProviderError({
      kind: 'transient',
      provider: 'xero',
      operation,
      message: `${operation} returned an unexpected response`,
    });
  }
  return body;
}

/** A field Xero documents as an array can still come back missing or of the
 *  wrong shape on a malformed/partial response; treat anything but a real
 *  array as empty rather than let `.filter`/`.length` throw. */
export function xeroArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Xero's If-Modified-Since format: "A UTC timestamp (yyyy-mm-ddThh:mm:ss)",
 * "accurate to the second" (Requests and responses). No zone suffix.
 */
export function formatXeroIfModifiedSince(at: Date): string {
  return at.toISOString().slice(0, 19);
}

export interface XeroGetOptions {
  /** Only rows created or modified since this instant (Xero W05 payment pull). */
  ifModifiedSince?: Date;
}

async function xeroApiCall<T>(
  ctx: XeroCallContext, method: 'GET' | 'PUT' | 'POST', path: string, operation: string,
  write?: { body: string; idempotencyKey?: string; beforeCreate?: () => Promise<void> }, read?: XeroGetOptions,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${ctx.accessToken}`,
    'xero-tenant-id': ctx.tenantId,
    Accept: 'application/json',
  };
  if (write) headers['Content-Type'] = 'application/json';
  if (write?.idempotencyKey) headers['Idempotency-Key'] = write.idempotencyKey;
  if (read?.ifModifiedSince) headers['If-Modified-Since'] = formatXeroIfModifiedSince(read.ifModifiedSince);
  // The slot wraps only this leaf round trip (request + body read), like the
  // QuickBooks boundary; the abort budget starts inside the slot, so a queue
  // wait for a slot never eats into Xero's own response time.
  // A limiter refusal is thrown by withProviderCallSlot itself (outside the
  // leaf) and propagates untouched as rate_limited.
  const { response, text } = await withProviderCallSlot('xero', ctx.rate, ctx.connectionId, async () => {
    await write?.beforeCreate?.();
    return xeroRoundTrip(
    operation,
    `${XERO_API_BASE}/${path}`,
    { method, headers, body: write?.body, signal: AbortSignal.timeout(ctx.timeoutMs ?? XERO_REQUEST_TIMEOUT_MS) },
  ); });

  const remainingHeader = response.headers.get('x-daylimit-remaining');
  const remaining = remainingHeader === null || remainingHeader.trim() === '' ? NaN : Number(remainingHeader);
  if (Number.isFinite(remaining)) {
    // Best-effort: the local daily counter is the primary budget; this only refines it.
    // noteDailyRemaining never rejects (it catches and logs internally).
    await noteDailyRemaining('xero', ctx.connectionId, remaining);
  }

  if (response.status === 304 && read?.ifModifiedSince) return null as T; // nothing changed since the cursor (lab X59)

  if (!response.ok) {
    const err = xeroApiError(operation, response.status, response.headers, text);
    console.error(
      `[xeroHttp] ${operation} failed`, `status=${response.status}`, `kind=${err.kind}`,
      ...(err.providerCode ? [`providerCode=${err.providerCode}`] : []),
    );
    throw err;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw providerError({ kind: 'transient', operation, message: `${operation} returned invalid JSON` });
  }
}

/** A tenant-scoped Accounting API GET through the rate-limit slot. With `ifModifiedSince`, a 304 resolves to null. */
export async function xeroApiGet<T>(ctx: XeroCallContext, path: string, operation: string, opts: XeroGetOptions = {}): Promise<T> {
  return xeroApiCall<T>(ctx, 'GET', path, operation, undefined, opts);
}

/**
 * A tenant-scoped Accounting API write (PUT = create only, POST = create or
 * update) through the same slot, day-remaining note and error translation as
 * reads. Only a create carries an Idempotency-Key by default (refinement 9): an
 * update is idempotent by content, and keying it would let an A → B → A edit
 * inside Xero's 6-minute window replay A's stale response.
 */
export async function xeroApiWrite<T>(
  ctx: XeroCallContext, method: 'PUT' | 'POST', path: string, body: unknown, operation: string,
  opts: { idempotencyKey?: string; beforeCreate?: () => Promise<void> } = {},
): Promise<T> {
  const json = JSON.stringify(body);
  return xeroApiCall<T>(ctx, method, path, operation, {
    body: json,
    beforeCreate: opts.beforeCreate,
    idempotencyKey: opts.idempotencyKey ?? (method === 'PUT' ? xeroIdempotencyKey(ctx.tenantId, method, path, json) : undefined),
  });
}

const MS_DATE_RE = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/;

/**
 * Xero's Microsoft JSON date (or a bare ISO timestamp, which Xero treats as UTC)
 * → ISO-8601, else null. In `/Date(ms±hhmm)/` the millisecond epoch IS the
 * instant; the offset is display information only and is ignored.
 */
export function parseXeroDate(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  const ms = MS_DATE_RE.exec(value);
  const date = ms ? new Date(Number(ms[1])) : new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
