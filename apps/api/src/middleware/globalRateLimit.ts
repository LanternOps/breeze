import type { Context, MiddlewareHandler, Next } from 'hono';
import { getTrustedClientIp, rateLimitIpKey } from '../services/clientIp';
import { verifyToken } from '../services/jwt';
import {
  markUserRateBudgetOwed,
  spendFromBucket,
  TOO_MANY_REQUESTS,
  userRateBudgetPerMinute,
} from './rateLimitBudget';
// Side-effect import: brings the `tunnelSurface` ContextVariableMap augmentation into scope.
import './tunnelHostDispatch';

export { __resetInMemoryCountersForTests } from './rateLimitBudget';

/**
 * Global per-IP rate limiter middleware: the front door, ahead of any auth.
 *
 * Every metered request spends exactly one per-IP bucket, chosen in this order:
 *   1. a tunnel host or an isolated path prefix spends that bucket;
 *   2. a verified session spends the raised session ceiling, and owes the
 *      per-user budget authMiddleware charges (#10962);
 *   3. everything else, anonymous and API-key traffic included, spends the
 *      shared bucket.
 *
 * Individual routes can still have their own stricter limits (login, register, etc.).
 *
 * Skips health/readiness probes so load balancers and monitoring aren't affected.
 *
 * When Redis is unavailable, falls back to a simple in-memory counter map
 * so requests are still metered (albeit per-process only).
 */

const SKIP_PATHS = new Set(['/health', '/ready']);

// Agent routes have their own per-agent rate limiter (agentAuthMiddleware),
// so exclude them from the global per-IP limit.  Without this, agent heartbeats
// and telemetry consume the same IP bucket as the dashboard UI — especially
// problematic in development where everything originates from localhost.
const BUILT_IN_SKIP_PREFIXES = ['/api/v1/agents/', '/api/v1/helper/'];
const skipPrefixes: string[] = [...BUILT_IN_SKIP_PREFIXES];

/**
 * The per-IP ceiling for verified sessions, as a multiple of the per-user
 * budget: ten users on one IP can each spend their whole budget before they
 * share a limit. It stays a ceiling, not an exemption, because the front door
 * cannot see whether a route authenticates: on a route with no authMiddleware
 * no per-user budget is ever charged, and a token that passes the signature
 * check here may still be rejected by authMiddleware's revocation and epoch
 * checks. Both remain bounded by this bucket.
 */
const SESSION_IP_CEILING_USERS = 10;

/**
 * A path prefix metered in its own per-IP bucket rather than the shared one.
 *
 * Isolation — not exemption. Traffic matching the prefix is still capped, so a
 * runaway or hostile client can't hammer the endpoint unbounded; it simply
 * spends a budget nothing else draws on.
 */
export interface IsolatedBucket {
  /** Path prefix routed into this bucket. */
  prefix: string;
  /** Key namespace. Must be unique across buckets. */
  name: string;
  /** Max requests per window for this bucket (independent of the global cap). */
  limit: number;
}

/**
 * Tunnel-host requests (Network Proxy host mode) carry arbitrary device paths,
 * so the path-prefix buckets below can't isolate them: one device admin page
 * loading 100 subresources would otherwise drain a budget shared by everyone
 * behind the same IP (plan G7).
 */
export const TUNNEL_HOST_BUCKET: IsolatedBucket = { prefix: '', name: 'tunnelhost', limit: 1200 };

/**
 * Remote-desktop viewer traffic gets its own bucket (issue #3041).
 *
 * While waiting for the agent's WebRTC answer the viewer polls
 * `/api/v1/desktop-ws/:id/viewer/session` repeatedly, so one connection attempt
 * is inherently dozens of requests — and when the session dies mid-poll every
 * one of them 401s. Sharing the default bucket let that burst exhaust the
 * per-IP budget and 429 the operator's *own* dashboard and auth calls, bouncing
 * them to the login screen while their session was still valid. A dedicated
 * bucket keeps the viewer path bounded without letting it starve the console.
 *
 * Sizing: with the viewer's backed-off poll a single connection attempt costs
 * ~35 requests (ice-servers + offer + ~34 answer polls across the 15s window),
 * so 600/min leaves room for roughly 16 attempts a minute from one IP — enough
 * for several techs behind one office NAT reconnecting, while still capping a
 * runaway client at ~10 req/s. Trickle ICE (#9182) adds at most ~30 more per
 * attempt (a ≤30 s, 1 s-paced poll for the agent's late candidates that stops
 * at its end-of-gathering marker, plus one POST per late viewer candidate) —
 * still ~10 attempts a minute. Note the prefix covers ALL desktop-ws traffic,
 * so one runaway viewer can still throttle other remote sessions from the same
 * IP; it just can no longer touch the dashboard or auth budget.
 */
export const ISOLATED_BUCKETS: readonly IsolatedBucket[] = [
  { prefix: '/api/v1/desktop-ws/', name: 'desktopws', limit: 600 },
  // Public invoice view-and-pay links (2026-08-21 spec §6): unauthenticated,
  // bearer-URL surface. Isolated so a scanner hammering a leaked/expired link
  // can't burn the shared budget of everything else behind the same NAT, and
  // capped well below the global 600 — a human paying an invoice makes a
  // handful of requests. The Stripe-backed mutations (/pay, /settle-return)
  // carry an additional per-token limiter inside the route.
  { prefix: '/api/v1/invoices/public/', name: 'invoicepublic', limit: 60 },
  // Public agreement signing links (#9075 W2b): the same unauthenticated
  // bearer-URL shape and the same reasoning and size as invoicepublic — a human
  // signing an agreement makes a handful of requests. The portal page fetches
  // client-side (no SSR call, which would key every visitor to the portal's own
  // IP). Accept/decline also carry a per-token limiter inside the route.
  { prefix: '/api/v1/agreements/public/', name: 'agreementpublic', limit: 60 },
  // Bare-metal recovery (2026-09-09 assurance campaign, D13): the recovery
  // helper fetches ONE object per file through /backup/bmr/recover/download,
  // so a 10k-file server would be capped at 600 files/min by the shared
  // bucket. Only the download route is isolated: it is token-authenticated,
  // path-scoped to a single snapshot and carries its own per-token limiter,
  // so the bucket only needs to stay below "runaway client" territory.
  // /recover/authenticate and /recover/complete keep the shared budget plus
  // their tighter per-route limiters.
  { prefix: '/api/v1/backup/bmr/recover/download', name: 'bmrrecover', limit: 12_000 },
  // Partner sending-domain delivery events (W06). One provider egress IP
  // delivers every partner's bounces, complaints and deliveries, so on the
  // shared 600/min per-IP budget a busy partner lane would throttle anonymous
  // and API-key traffic that happens to share an egress address — and vice versa. The
  // route carries its own 600/min limiter and rejects anything unsigned, so
  // this bucket only needs to stay out of runaway territory.
  { prefix: '/api/v1/webhooks/email-provider/', name: 'emaildomainswebhook', limit: 1200 },
  // EDR vendor push hints (W03 PR-B). One vendor egress IP delivers every
  // partner's console events, so the shared per-IP budget would couple partners
  // to each other and to anything else on it. The route carries its own
  // per-connection 60/min limiter (checked before any DB read) and rejects
  // anything without the connection's secret.
  { prefix: '/api/v1/webhooks/edr/', name: 'edrwebhook', limit: 1200 },
  { prefix: '/api/v1/webhooks/flows/', name: 'flowwebhook', limit: 1200 },
  // Public trust pages (spec trust-center §8, §10): unauthenticated by design. Isolated so a scanner
  // enumerating slugs cannot burn the shared budget; 120/min is generous for one human reading a page
  // (payload + badge + a few documents). The SSR card path lives under /trust/card/ and is skip-listed
  // instead, because portal SSR shares one IP — see routes/trustPagePublic.ts for why it is DB-free.
  { prefix: '/api/v1/trust/public/', name: 'trustpublic', limit: 120 },
  // Signed trust attestation + JWKS (Trust Center W3b): unauthenticated, read by insurer/auditor tooling that
  // fetches one page at a time. Isolated from 'trustpublic' so a verifier polling attestations cannot starve a
  // human reading the page, and vice versa.
  { prefix: '/api/v1/trust/attestation/', name: 'trustattest', limit: 60 },
  // Agent WebSocket upgrades (W08 D11, #10962). A fleet behind one NAT must not
  // spend the budget of the operators behind that NAT. One upgrade is one
  // request, so 3000/min lets 3000 agents on one address reconnect inside a
  // minute; a larger fleet catches up through the agent's jittered backoff. The
  // route carries its own per-agent connection limiter.
  { prefix: '/api/v1/agent-ws/', name: 'agentws', limit: 3000 },
];

export function registerGlobalRateLimitSkipPrefix(prefix: string): void {
  if (!skipPrefixes.includes(prefix)) {
    skipPrefixes.push(prefix);
  }
}

export function __resetSkipPrefixesForTests(): void {
  skipPrefixes.splice(0, skipPrefixes.length, ...BUILT_IN_SKIP_PREFIXES);
}

/**
 * Whether the request carries a valid session: a signed, unexpired access token
 * for this API. A bearer header alone is not enough, or `Bearer x` would leave
 * the anonymous bucket for free. HS256 verification is local CPU with no I/O.
 * API keys and other bearer formats fail this and stay in the shared bucket.
 */
async function carriesValidSession(c: Context): Promise<boolean> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return false;
  const payload = await verifyToken(authHeader.slice(7));
  return payload?.type === 'access' && Boolean(payload.sub);
}

interface GlobalRateLimitOptions {
  /**
   * Max requests per window for the shared bucket, the ceiling for anonymous
   * and API-key traffic. Default: 600, which caps a runaway client at ~10 req/s.
   */
  limit?: number;
  /**
   * Max requests per window per IP across all verified sessions.
   * Default: {@link SESSION_IP_CEILING_USERS} times the per-user budget.
   */
  sessionIpLimit?: number;
  /** Window size in seconds. Default: 60 */
  windowSeconds?: number;
  /**
   * Paths metered separately from the shared bucket.
   * Defaults to {@link ISOLATED_BUCKETS}; overridable so tests can exercise the
   * capping behaviour without issuing hundreds of requests.
   */
  isolatedBuckets?: readonly IsolatedBucket[];
}

export function globalRateLimit(options?: GlobalRateLimitOptions): MiddlewareHandler {
  const limit = options?.limit ?? 600;
  const windowSeconds = options?.windowSeconds ?? 60;
  const isolatedBuckets = options?.isolatedBuckets ?? ISOLATED_BUCKETS;
  const e2eMode = process.env.E2E_MODE === '1' || process.env.E2E_MODE === 'true';

  return async (c: Context, next: Next) => {
    // In E2E testing mode, skip all rate limiting to avoid test flakiness
    if (e2eMode) {
      return next();
    }

    // Tunnel hosts choose their own path, so path-based skips would let a
    // device-served `/health` or `/api/v1/agents/x` bypass metering entirely.
    const tunnelSurface = c.get('tunnelSurface') === true;

    // Skip health checks — used by load balancers / k8s probes
    if (!tunnelSurface && SKIP_PATHS.has(c.req.path)) {
      return next();
    }

    // Skip agent routes — they have dedicated per-agent rate limiting
    if (!tunnelSurface && skipPrefixes.some(prefix => c.req.path.startsWith(prefix))) {
      return next();
    }

    // Bucket identity, not the client's address: rateLimitIpKey folds IPv6 to
    // its /64 so a subscriber holding 2^64 addresses gets one bucket rather
    // than an unlimited supply. IPv4 and the 'unknown' sentinel pass through.
    const clientIp = rateLimitIpKey(getTrustedClientIp(c, 'unknown'));

    // Route into a dedicated bucket when the path has one, so high-volume
    // endpoints can't drain the budget shared by the dashboard and auth.
    const bucket = tunnelSurface
      ? TUNNEL_HOST_BUCKET
      : isolatedBuckets.find(b => c.req.path.startsWith(b.prefix));

    let bucketLimit = bucket?.limit ?? limit;
    let bucketKey = bucket ? `global:${bucket.name}:${clientIp}` : `global:${clientIp}`;

    if (!bucket && await carriesValidSession(c)) {
      bucketLimit = options?.sessionIpLimit ?? userRateBudgetPerMinute() * SESSION_IP_CEILING_USERS;
      bucketKey = `global:session:${clientIp}`;
      markUserRateBudgetOwed(c);
    }

    const allowed = await spendFromBucket(c, bucketKey, bucketLimit, windowSeconds);
    if (!allowed) {
      c.set('rejectReason', 'global_rate_limit');
      return c.json({ error: TOO_MANY_REQUESTS }, 429);
    }

    return next();
  };
}
