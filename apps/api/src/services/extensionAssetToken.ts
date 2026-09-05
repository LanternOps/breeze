import { createHmac, timingSafeEqual } from 'node:crypto';
import { getSecretDerivedKeyMaterials } from './secretCrypto';
import { createReportThrottle } from '../utils/reportThrottle';

/**
 * Short-lived, HMAC-signed capability for one extension's digest-addressed
 * web bundle (issue #4164).
 *
 * WHY THIS EXISTS. `GET /api/v1/extensions/assets/...` used to sit behind the
 * ordinary bearer `authMiddleware`, but the browser loads an extension's entry
 * module with a bare dynamic `import(url)` — a native module fetch that cannot
 * carry an `Authorization` header. Every enabled extension's UI therefore 401'd
 * permanently. The authenticated `GET /extensions/registry` now mints one of
 * these tokens per extension and embeds it in the `moduleUrl` it advertises;
 * the asset route verifies the token instead of a bearer header.
 *
 * WHY A PATH SEGMENT, NOT A QUERY PARAMETER. A relative specifier inside the
 * bundle (`import './chunk.js'`) resolves against the *importing module's* URL,
 * which drops the query string but keeps the parent path segments. A token
 * carried in the path is therefore inherited by every sibling chunk request; a
 * `?t=` token is not, and a code-split bundle's chunks would all 404.
 * `webAssets.ts` retains the whole `web/` subtree, so chunked bundles are in
 * scope by design even though today's `ee/workspace` bundle is single-file.
 *
 * WHAT THE TOKEN ACTUALLY AUTHORIZES — read this before trusting it for more.
 * It is a bearer capability for the `(name, digest)` web tree: every servable
 * member under that bundle's `web/` directory, for the token's lifetime. It is
 * deliberately NOT per-member, because sibling chunks share one token by
 * construction (see above). The corollary is a contract on bundle authors:
 * EVERYTHING UNDER `web/` IS BROWSER-PUBLIC TO A TOKEN HOLDER — an unreferenced
 * `web/config.json` is as readable as the entry module. Put no secrets there.
 *
 * `partnerId`/`orgId` are signed into the claims so a token cannot be
 * re-scoped to another tenant by tampering, and so the route already has the
 * scope in hand if extension enablement ever becomes org-scoped (today
 * `installed_extensions.enabled` is a GLOBAL fleet-wide flag — see the header
 * of routes/extensionsWeb.ts). They are NOT an authorization input today and
 * must not be described as one: asset bytes are identical for every tenant and
 * were already readable by any authenticated user before this change, so a
 * token replayed verbatim by whoever holds it grants nothing that user could
 * not already fetch. The enforceable properties are: the token cannot be
 * forged, cannot be re-pointed at a different extension or a different digest,
 * cannot be re-scoped to a different tenant, and cannot outlive its expiry.
 * `userId` is deliberately absent — it would put a decodable per-user
 * identifier into a URL (browser history, error stacks) while adding no
 * enforcement, and would invite false attribution of a stolen token's requests.
 *
 * DETERMINISTIC WITHIN A TIME BUCKET. `iat` is snapped down to a
 * {@link MINT_BUCKET_SECONDS} boundary rather than set to "now", so every
 * replica minting for the same `(name, digest, partnerId, orgId)` in the same
 * bucket emits byte-identical tokens. That preserves two things the registry
 * projection depends on: cross-replica determinism of the registry `revision`
 * (a client polling through a load balancer must not see the document flap),
 * and a stable `moduleUrl` so the browser's module cache and the web loader's
 * import memo are not fragmented by a credential that changes on every poll.
 * A token is therefore never handed out with less than
 * `TOKEN_TTL_SECONDS - MINT_BUCKET_SECONDS` of life remaining.
 */

const TOKEN_PREFIX = 'v1';
const TOKEN_AUDIENCE = 'breeze.extensions.web-asset';
const TOKEN_KEY_DOMAIN = 'extension-web-asset-token:v1';
const TOKEN_SIGNATURE_DOMAIN = 'extension-web-asset-token:v1:';

/** Lifetime of a minted token. Sized to cover a page session's module-graph
 *  load comfortably while keeping a URL-embedded credential short-lived.
 *  A bundle that lazily imports a chunk MORE than this long after the page
 *  loaded will 404 (the importing module's base URL still carries the original
 *  token and cannot be re-signed) — extension bundles are expected to load
 *  their graph eagerly, which `ee/workspace` enforces with `splitting: false`.
 *  The page recovers on the next navigation, which re-fetches the registry. */
const TOKEN_TTL_SECONDS = 60 * 60;
/** `iat` quantum — see "DETERMINISTIC WITHIN A TIME BUCKET" above. */
const MINT_BUCKET_SECONDS = 15 * 60;
/** Tolerance for a verifier whose clock trails the minting replica's. */
const CLOCK_SKEW_SECONDS = 60;
/** Refuse an oversized segment before doing any HMAC work. */
const MAX_TOKEN_LENGTH = 1024;
/** UUID or null — the only shapes a tenant claim may take. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
/** A token is one path segment: base64url payload/signature joined by dots. */
export const EXTENSION_ASSET_TOKEN_PATTERN = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Verification answers every failure with the same `null` so the asset route
 * can answer every rejection with the same bare 404 — an attacker gets no
 * oracle. Giving OPERATORS no oracle is a different thing, and would be a
 * repeat of #4164: a signing-key rotation that drops a key while tokens minted
 * under it are still live silently 404s every extension UI in the fleet, and
 * nobody finds out until a support ticket arrives. These throttled warnings are
 * the internal-only signal; nothing about them reaches the HTTP response.
 */
const REPORT_THROTTLE = createReportThrottle(5 * 60_000);

/** Test seam — the throttle is module-global, so a suite that asserts on the
 *  warning must be able to clear the window between cases. */
export function __resetExtensionAssetTokenReportThrottleForTests(): void {
  REPORT_THROTTLE.reset();
}

export type ExtensionAssetTokenScope = Readonly<{
  partnerId: string | null | undefined;
  orgId: string | null | undefined;
}>;

export type ExtensionAssetTokenClaims = Readonly<{
  v: 1;
  aud: typeof TOKEN_AUDIENCE;
  name: string;
  digest: string;
  partnerId: string | null;
  orgId: string | null;
  iat: number;
  exp: number;
}>;

export type VerifiedExtensionAssetToken = Readonly<{
  claims: ExtensionAssetTokenClaims;
  signingKeyId: string | null;
  /** Whole seconds of life left; 0 when the token expires this second. */
  remainingSeconds: number;
}>;

/** What the asset route knows from the request path and must bind the token to. */
export interface ExtensionAssetTokenBinding {
  readonly name: string;
  readonly digest: string;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function validTenantClaim(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && UUID_PATTERN.test(value));
}

/**
 * Coerce a caller-supplied tenant id to the claim's shape. Anything that isn't
 * a UUID becomes null rather than throwing: the tenant claim is a tamper-proof
 * BINDING, not an authorization input (see the header), so a principal whose
 * token carries an unexpected scope shape — a system-scoped session, say —
 * must still be able to load extension UI. Failing the mint would 500 the
 * registry for that user and take every extension page down with it, which is
 * strictly worse than minting a token with a null scope.
 */
function normalizeTenantClaim(
  field: 'partnerId' | 'orgId',
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && UUID_PATTERN.test(value)) return value;
  // A present-but-malformed tenant id is a "should never happen" upstream bug,
  // not a shape we should quietly normalise away without trace: the claim is
  // carried precisely so a future org-scoped enablement check has something to
  // compare against, and that check would then be comparing against a null we
  // manufactured. Warn (throttled — one broken principal must not flood), keep
  // serving.
  if (REPORT_THROTTLE.shouldReport(`extension-asset-token:bad-scope:${field}`)) {
    console.warn(
      `[extensionAssetToken] discarding a malformed ${field} on an asset-token mint; `
      + 'the token will carry a null tenant binding. This indicates an upstream auth bug.',
    );
  }
  return null;
}

function validClaims(value: unknown): value is ExtensionAssetTokenClaims {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const claims = value as Record<string, unknown>;
  return Object.keys(claims).length === 8
    && claims.v === 1
    && claims.aud === TOKEN_AUDIENCE
    && typeof claims.name === 'string'
    && claims.name.length > 0
    && typeof claims.digest === 'string'
    && claims.digest.length > 0
    && validTenantClaim(claims.partnerId)
    && validTenantClaim(claims.orgId)
    && typeof claims.iat === 'number'
    && Number.isSafeInteger(claims.iat)
    && claims.iat >= 0
    && typeof claims.exp === 'number'
    && Number.isSafeInteger(claims.exp)
    && claims.exp > claims.iat;
}

/** Fixed key order — never `Object.keys` of a spread. The verifier re-derives
 *  this and compares it byte-for-byte against the decoded payload, so a
 *  re-ordered or re-spaced JSON encoding of the same claims is rejected. */
function canonicalClaims(claims: ExtensionAssetTokenClaims): string {
  return JSON.stringify({
    v: claims.v,
    aud: claims.aud,
    name: claims.name,
    digest: claims.digest,
    partnerId: claims.partnerId,
    orgId: claims.orgId,
    iat: claims.iat,
    exp: claims.exp,
  });
}

/**
 * Called only when NO retained key verified a token. Decodes the (unsigned,
 * attacker-controllable) payload to ask one question: does this token look
 * exactly like one we would have minted — right audience, bound to the asset
 * actually being requested, not yet expired — and yet verify under no key we
 * hold? That is the fingerprint of a signing-key rotation that dropped a key
 * too early, which would blank every extension UI in the fleet.
 *
 * An attacker CAN synthesise that shape (the claims are plaintext), so this is
 * a canary, not proof — hence the throttle, and hence a `console.warn` rather
 * than a Sentry exception: it belongs in the operator's log stream where a
 * sustained rate is the actual signal, not in an alerting channel a single
 * scanner could trip. Nothing here changes the response.
 */
function reportIfIndistinguishableFromOurOwn(payload: string, binding: ExtensionAssetTokenBinding): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return;
  }
  if (!validClaims(parsed)) return;
  if (parsed.name !== binding.name || parsed.digest !== binding.digest) return;
  if (parsed.exp <= nowSeconds()) return;
  if (!REPORT_THROTTLE.shouldReport('extension-asset-token:unverifiable')) return;
  // `parsed` came out of an UNVERIFIED payload, so `name` is attacker-chosen
  // text — `validClaims` only requires a non-empty string. Quote and truncate
  // it so a crafted name cannot inject newlines and forge log lines.
  const reportedName = JSON.stringify(parsed.name).slice(0, 120);
  console.warn(
    `[extensionAssetToken] a well-formed, unexpired asset token for ${reportedName} `
    + 'verified under NO retained signing key. If this is sustained, a signing-key '
    + 'rotation has dropped a key while tokens minted under it are still live — '
    + 'every extension web UI will 404 until those tokens expire (issue #4164).',
  );
}

function signature(payload: string, key: Buffer): Buffer {
  return createHmac('sha256', key)
    .update(`${TOKEN_SIGNATURE_DOMAIN}${payload}`)
    .digest();
}

/**
 * Mint the capability for one extension bundle. Callers must already have
 * authenticated the requester — `GET /extensions/registry` is the only mint
 * point, and it stays behind `authMiddleware`.
 */
export function mintExtensionAssetToken(
  binding: ExtensionAssetTokenBinding,
  scope: ExtensionAssetTokenScope,
): string {
  const iat = Math.floor(nowSeconds() / MINT_BUCKET_SECONDS) * MINT_BUCKET_SECONDS;
  const claims: ExtensionAssetTokenClaims = {
    v: 1,
    aud: TOKEN_AUDIENCE,
    name: binding.name,
    digest: binding.digest,
    partnerId: normalizeTenantClaim('partnerId', scope.partnerId),
    orgId: normalizeTenantClaim('orgId', scope.orgId),
    iat,
    exp: iat + TOKEN_TTL_SECONDS,
  };
  if (!validClaims(claims)) {
    throw new Error('[extensionAssetToken] refusing to mint a token for invalid claims');
  }
  const payload = Buffer.from(canonicalClaims(claims), 'utf8').toString('base64url');
  const material = getSecretDerivedKeyMaterials(TOKEN_KEY_DOMAIN).active;
  return `${TOKEN_PREFIX}.${payload}.${signature(payload, material.key).toString('base64url')}`;
}

/**
 * Verify a presented token against the `(name, digest)` the request path is
 * asking for. Returns null — never throws, never distinguishes the failure
 * reason — for a malformed, forged, re-scoped, mis-bound or expired token, so
 * the caller can answer every rejection with the same bare 404 (the asset
 * route's no-oracle property).
 */
export function verifyExtensionAssetToken(
  token: string,
  binding: ExtensionAssetTokenBinding,
): VerifiedExtensionAssetToken | null {
  // Cheap syntactic gates BEFORE any HMAC work, so an unauthenticated flood of
  // junk tokens costs nothing but a regex.
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  if (!binding.name || !binding.digest) return null;

  const parts = token.split('.');
  if (
    parts.length !== 3
    || parts[0] !== TOKEN_PREFIX
    || !parts[1]
    || !parts[2]
    || !BASE64URL_PATTERN.test(parts[1])
    || !BASE64URL_PATTERN.test(parts[2])
  ) return null;

  const payload = parts[1];
  let supplied: Buffer;
  try {
    supplied = Buffer.from(parts[2], 'base64url');
  } catch {
    return null;
  }
  if (supplied.length !== 32) return null;
  // Reject a non-canonical base64url encoding of the same 32 bytes.
  if (supplied.toString('base64url') !== parts[2]) return null;

  // Try every retained key so a signing-key rotation doesn't invalidate tokens
  // already in flight. Exactly one must match — an ambiguous match means two
  // derived keys collided, which is a reason to reject, not to pick one.
  const matches = getSecretDerivedKeyMaterials(TOKEN_KEY_DOMAIN).retained.filter((material) => {
    const expected = signature(payload, material.key);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  });
  if (matches.length !== 1) {
    reportIfIndistinguishableFromOurOwn(payload, binding);
    return null;
  }

  const decodedPayload = Buffer.from(payload, 'base64url');
  if (decodedPayload.toString('base64url') !== payload) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodedPayload.toString('utf8'));
  } catch {
    return null;
  }
  if (!validClaims(parsed)) return null;
  if (canonicalClaims(parsed) !== decodedPayload.toString('utf8')) return null;

  // Bind to the asset actually being requested: a token for extension A, or
  // for a superseded digest of extension A, must not serve extension B or the
  // new digest.
  if (parsed.name !== binding.name) return null;
  if (parsed.digest !== binding.digest) return null;

  const now = nowSeconds();
  if (parsed.exp <= now) return null;
  if (parsed.iat > now + CLOCK_SKEW_SECONDS) return null;
  // A token that claims a longer life than we ever mint is forged-shaped even
  // if its signature verifies under a retained key (e.g. a key that leaked and
  // was used to mint a decade-long token).
  if (parsed.exp - parsed.iat > TOKEN_TTL_SECONDS) return null;

  return Object.freeze({
    claims: Object.freeze(parsed),
    signingKeyId: matches[0]!.keyId,
    remainingSeconds: parsed.exp - now,
  });
}
