/**
 * Refresh-token rotation grace window (#10301, INC-2026-010 item 4).
 *
 * Rotation replay is fatal: presenting a consumed refresh token revokes the
 * whole grant family (adapter.ts, `OAUTH_REFRESH_TOKEN_REUSE`). Two processes
 * sharing one credential store routinely race at the access-token expiry; the
 * loser presents the parent a few ms after the winner rotated it and the family
 * dies. This module carves out only that innocent case: the SAME client
 * re-presenting a token rotated less than `OAUTH_REFRESH_ROTATION_GRACE_MS` ago
 * receives the successor the winner was issued, and nothing is revoked. Later
 * presentations, other clients and tokens that were never rotated still take
 * the reuse path (family revocation), as before.
 *
 * How the loser gets "the same successor" without storing a usable token:
 *   - The winner's consume() generates the successor value itself and, in the
 *     SAME UPDATE that consumes the parent, stamps `rotated_at` (rotation
 *     provenance: `revoked_at` alone is also written by destroy()) and
 *     `successor_sealed`, the successor sealed with AES-256-GCM.
 *   - The sealing key is HKDF over the RAW parent token, salted with a key
 *     derived from OAUTH_COOKIE_SECRET. The raw parent token is never stored
 *     (rows are keyed by its sha256), so a database read plus the server secret
 *     still cannot open a seal: it takes the parent token the client held.
 *   - Publishing the successor atomically with the consume closes the
 *     consume→save gap: a loser arriving before the winner has saved the
 *     successor row still finds the seal, and both requests save one row.
 *   - The provider mints the successor through generateTokenId(), which this
 *     module overrides to return the value consume() published for the current
 *     request (oidc-provider exposes the request through `Provider.ctx`). Every
 *     other refresh token keeps the provider's random id.
 *   - Each rotation by a client (window on) clears that client's seals older
 *     than REFRESH_ROTATION_GRACE_MAX_MS. Seals from the last 30 s, and the
 *     last seal of a client that stops refreshing, stay at rest until the row
 *     is cleaned up; opening one still takes the raw parent token.
 *
 * Trade-off (documented in apps/docs): Breeze's DCR and CIMD clients are all
 * public, so inside the window the client cannot be told apart from someone
 * else holding the same parent token and client_id (a confidential client's
 * secret is checked before any of this runs). Such a party receives the same
 * successor; the second of them to refresh presents a rotated token and
 * revokes the family.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { Provider } from 'oidc-provider';
import { Counter, Histogram } from 'prom-client';
import { metricsRegistry } from '../services/metricsRegistry';
import { grantErrorContext } from './grantErrorLog';
import { ERROR_IDS, logOauthDebug, logOauthWarn } from './log';

export const REFRESH_ROTATION_GRACE_ENV = 'OAUTH_REFRESH_ROTATION_GRACE_MS';
export const REFRESH_ROTATION_GRACE_DEFAULT_MS = 10_000;
export const REFRESH_ROTATION_GRACE_MAX_MS = 30_000;

const warnedGraceValues = new Set<string>();

/**
 * The window in ms, read at call time. Unset or empty (Compose passes '') is
 * the 10 s default; `0` disables; values above the 30 s cap are clamped. An
 * unparseable value selects 0, the pre-#10301 strict behaviour.
 */
export function refreshRotationGraceMs(): number {
  const raw = (process.env[REFRESH_ROTATION_GRACE_ENV] ?? '').trim();
  if (raw === '') return REFRESH_ROTATION_GRACE_DEFAULT_MS;
  if (!/^\d+$/.test(raw)) {
    if (!warnedGraceValues.has(raw)) {
      warnedGraceValues.add(raw);
      console.warn(
        `[oauth] Ignoring unrecognized ${REFRESH_ROTATION_GRACE_ENV} value ${JSON.stringify(raw.slice(0, 32))}; `
        + 'expected whole milliseconds (0 disables). Refresh-token rotation stays strict (no grace window).',
      );
    }
    return 0;
  }
  return Math.min(Number.parseInt(raw, 10), REFRESH_ROTATION_GRACE_MAX_MS);
}

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

const SEAL_SALT_LABEL = 'breeze/oauth/refresh-rotation-seal-salt/v1';
const SEAL_KEY_INFO = 'breeze/oauth/refresh-rotation-successor/v1';
const SEAL_PREFIX = 'v1.';
const IV_BYTES = 12;
const TAG_BYTES = 16;

let sealSalt: Buffer | null = null;

/**
 * Set (or, with null, clear) the server half of the sealing key. Called once
 * when the provider is built; without it no seal is written and every
 * presentation of a rotated token takes the strict reuse path.
 */
export function configureRotationSealKey(secret: string | null): void {
  sealSalt = secret
    // Domain-separated from the cookie-signing use of the same secret.
    ? createHmac('sha256', secret).update(SEAL_SALT_LABEL).digest()
    : null;
}

export function rotationSealingAvailable(): boolean {
  return sealSalt !== null;
}

function sealKey(parentRaw: string, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(parentRaw, 'utf8'), salt, SEAL_KEY_INFO, 32));
}

/** Same shape as the provider's opaque ids: 256 random bits, 43 base64url chars. */
export function newSuccessorTokenValue(): string {
  return randomBytes(32).toString('base64url');
}

export function sealRotationSuccessor(args: {
  parentRaw: string;
  parentStorageId: string;
  successorRaw: string;
}): string | null {
  if (!sealSalt) return null;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', sealKey(args.parentRaw, sealSalt), iv);
  cipher.setAAD(Buffer.from(args.parentStorageId, 'utf8'));
  const body = Buffer.concat([cipher.update(args.successorRaw, 'utf8'), cipher.final()]);
  return SEAL_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

/** null when the seal is malformed, was sealed for another parent, or under another secret. */
export function openRotationSuccessor(args: {
  parentRaw: string;
  parentStorageId: string;
  sealed: string;
}): string | null {
  if (!sealSalt || !args.sealed.startsWith(SEAL_PREFIX)) return null;
  const bytes = Buffer.from(args.sealed.slice(SEAL_PREFIX.length), 'base64url');
  if (bytes.length <= IV_BYTES + TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      sealKey(args.parentRaw, sealSalt),
      bytes.subarray(0, IV_BYTES),
    );
    decipher.setAAD(Buffer.from(args.parentStorageId, 'utf8'));
    decipher.setAuthTag(bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(bytes.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Request context
// ---------------------------------------------------------------------------

export type RefreshGrantRequest = {
  /** The provider's Koa context; identity key for the per-request state below. */
  ctx: object;
  /** The raw refresh token the client presented. */
  presentedToken: string;
  /** The client the provider authenticated for this request, if any. */
  clientId: string | null;
};

type ProviderCtxLike = {
  oidc?: {
    client?: { clientId?: unknown } | null;
    params?: Record<string, unknown> | null;
  } | null;
};

/**
 * The in-flight `refresh_token` grant, or null for every other request
 * (authorization_code, introspection, revocation, no provider request at all).
 * The adapter is also called from introspection and revocation; the grace
 * window must never apply there.
 */
export function currentRefreshGrantRequest(): RefreshGrantRequest | null {
  const ctx = Provider.ctx as unknown as (ProviderCtxLike & object) | undefined;
  const params = ctx?.oidc?.params;
  if (!ctx || !params || params.grant_type !== 'refresh_token') return null;
  const presented = params.refresh_token;
  if (typeof presented !== 'string' || presented.length === 0) return null;
  const clientId = ctx.oidc?.client?.clientId;
  return {
    ctx,
    presentedToken: presented,
    clientId: typeof clientId === 'string' && clientId.length > 0 ? clientId : null,
  };
}

// find() records a validated grace hit so consume()'s expected CAS miss on the
// already-consumed parent is tolerated without re-reading the row; consume()
// records the successor the provider must mint next. Both are keyed by the
// request context, so nothing leaks across requests.
const graceHits = new WeakMap<object, Map<string, string>>();
const pendingSuccessors = new WeakMap<object, string>();

export function markRotationGraceHit(ctx: object, parentStorageId: string, successorRaw: string): void {
  const hits = graceHits.get(ctx) ?? new Map<string, string>();
  hits.set(parentStorageId, successorRaw);
  graceHits.set(ctx, hits);
}

export function rotationGraceHit(ctx: object, parentStorageId: string): string | null {
  return graceHits.get(ctx)?.get(parentStorageId) ?? null;
}

export function setPendingRotationSuccessor(ctx: object, successorRaw: string): void {
  pendingSuccessors.set(ctx, successorRaw);
}

/** Returns the pending successor once; the provider saves one refresh token per request. */
export function takePendingRotationSuccessor(ctx: object): string | null {
  const value = pendingSuccessors.get(ctx) ?? null;
  pendingSuccessors.delete(ctx);
  return value;
}

type TokenIdModel = { prototype: { generateTokenId: (this: unknown) => string } };
const INSTALLED = Symbol.for('breeze.oauth.rotationSuccessorIds');

/**
 * Configure the sealing key and make the provider mint a rotated refresh token
 * with the value consume() published for this request. Idempotent.
 */
export function installRotationSuccessorIds(provider: Provider, secret: string): void {
  configureRotationSealKey(secret);
  const model = (provider as unknown as { RefreshToken: TokenIdModel }).RefreshToken;
  const original = model.prototype.generateTokenId as ((this: unknown) => string) & { [INSTALLED]?: true };
  if (original[INSTALLED]) return;
  const patched = function generateTokenId(this: unknown): string {
    const ctx = Provider.ctx as unknown as object | undefined;
    const pending = ctx ? takePendingRotationSuccessor(ctx) : null;
    return pending ?? original.call(this);
  } as ((this: unknown) => string) & { [INSTALLED]?: true };
  patched[INSTALLED] = true;
  model.prototype.generateTokenId = patched;
}

// ---------------------------------------------------------------------------
// Metrics and logging
// ---------------------------------------------------------------------------

export const REFRESH_ROTATION_GRACE_METRIC = 'oauth_refresh_rotation_grace_total';
export const REFRESH_ROTATION_REUSE_SECONDS_METRIC = 'oauth_refresh_rotation_reuse_seconds';

export const ROTATION_GRACE_OUTCOMES = [
  // Granted: the successor was returned and nothing was revoked.
  'hit',
  'concurrent_hit',
  // A ROTATED token presented on the fatal path (the family was revoked):
  'outside_window',
  'client_mismatch',
  'successor_inactive',
  'unsealable',
] as const;
export type RotationGraceOutcome = (typeof ROTATION_GRACE_OUTCOMES)[number];

const graceCounter: Counter<'outcome'> =
  (metricsRegistry.getSingleMetric(REFRESH_ROTATION_GRACE_METRIC) as Counter<'outcome'> | undefined)
  ?? new Counter({
    name: REFRESH_ROTATION_GRACE_METRIC,
    help: 'Presentations of an already-rotated OAuth refresh token by grace-window outcome',
    labelNames: ['outcome'] as const,
    registers: [metricsRegistry],
  });

const reuseSeconds: Histogram<'outcome'> =
  (metricsRegistry.getSingleMetric(REFRESH_ROTATION_REUSE_SECONDS_METRIC) as Histogram<'outcome'> | undefined)
  ?? new Histogram({
    name: REFRESH_ROTATION_REUSE_SECONDS_METRIC,
    help: 'Seconds between an OAuth refresh-token rotation and a later presentation of the rotated token',
    labelNames: ['outcome'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15, 30, 60, 300, 1800, 3600],
    registers: [metricsRegistry],
  });

for (const outcome of ROTATION_GRACE_OUTCOMES) graceCounter.inc({ outcome }, 0);

export function recordRotationGraceOutcome(outcome: RotationGraceOutcome, reuseMs: number): void {
  graceCounter.inc({ outcome });
  reuseSeconds.observe({ outcome }, Math.max(reuseMs, 0) / 1000);
}

const GRACE_HIT_LOG_WINDOW_MS = 10 * 60 * 1000;
const GRACE_HIT_LOG_MAX_KEYS = 1000;

export type RotationGraceHit = {
  path: 'replay' | 'concurrent';
  clientId: string;
  grantId: string | null;
  reuseMs: number;
};

/**
 * One `OAUTH_REFRESH_GRACE_HIT` warn line per client per window, carrying the
 * number of hits it suppressed (same throttle shape as grantErrorLog.ts,
 * #8830). The counter and histogram above see every hit.
 */
export function createRotationGraceHitLogger(opts: {
  now?: () => number;
  windowMs?: number;
  maxKeys?: number;
} = {}) {
  const now = opts.now ?? Date.now;
  const windowMs = opts.windowMs ?? GRACE_HIT_LOG_WINDOW_MS;
  const maxKeys = opts.maxKeys ?? GRACE_HIT_LOG_MAX_KEYS;
  const windows = new Map<string, { startedAt: number; suppressed: number }>();

  return function logRotationGraceHit(ctx: unknown, hit: RotationGraceHit): void {
    const attribution = grantErrorContext(ctx);
    const context = {
      path: hit.path,
      client_id: hit.clientId,
      grant_id: hit.grantId,
      reuse_ms: hit.reuseMs,
      token_hash: attribution.token_hash,
      user_agent: attribution.user_agent,
    };
    const at = now();
    const current = windows.get(hit.clientId);
    if (current && at - current.startedAt < windowMs) {
      current.suppressed += 1;
      logOauthDebug({
        errorId: ERROR_IDS.OAUTH_REFRESH_GRACE_HIT,
        message: 'Rotated refresh token re-presented inside the grace window (suppressed repeat)',
        context,
      });
      return;
    }
    const suppressed = current?.suppressed ?? 0;
    windows.delete(hit.clientId);
    windows.set(hit.clientId, { startedAt: at, suppressed: 0 });
    while (windows.size > maxKeys) {
      const oldest = windows.keys().next().value;
      if (oldest === undefined) break;
      windows.delete(oldest);
    }
    logOauthWarn({
      errorId: ERROR_IDS.OAUTH_REFRESH_GRACE_HIT,
      message: 'Rotated refresh token re-presented inside the grace window; returned its successor, nothing revoked',
      context: { ...context, suppressed },
    });
  };
}

export const logRotationGraceHit = createRotationGraceHitLogger();
