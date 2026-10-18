/**
 * Anonymous, read-only registry client for workload image currency (#3813,
 * spec §9.2). Answers one question per `repo:tag`: what digest does the
 * registry serve for this tag right now (and, for a multi-arch index, which
 * platform manifests does it list)?
 *
 * SSRF posture (the reason this file is small and strict):
 * - Only the fixed v1 allowlist is ever contacted. A registry off the list is
 *   answered `unsupported_registry` with NO network call.
 * - Every request — manifest HEAD/GET and the token-realm GET — goes through
 *   `safeFetchFollowingRedirects` (`services/urlSafety.ts`), which resolves
 *   once, refuses private/loopback/link-local/metadata addresses, and pins the
 *   dial to the validated IP. Its `allowHost` predicate is checked against
 *   EVERY hop, so a redirect (or a token realm) off the allowlist is refused
 *   before it is resolved or dialed.
 * - https only; small response caps; header and total timeouts.
 * - Anonymous only: the only credential ever sent is the anonymous bearer
 *   token the registry itself issued for this request. Tokens and
 *   Authorization headers are never logged and never leave this module.
 */
import { createHash } from 'crypto';
import {
  HostNotAllowedError,
  ResponseTooLargeError,
  SsrfBlockedError,
  safeFetchFollowingRedirects,
  type SafeFetchInit,
} from '../urlSafety';

/** Allowlist v1 (spec §9.2). Request hosts, not the agent's canonical names. */
export const REGISTRY_HOST_ALLOWLIST: ReadonlySet<string> = new Set([
  'registry-1.docker.io',
  'ghcr.io',
  'quay.io',
  'mcr.microsoft.com',
  'registry.k8s.io',
  'gcr.io',
  'public.ecr.aws',
]);

/**
 * Redirect targets `registry.k8s.io` resolves manifests to (#8549). Exact hosts
 * only — no wildcard, so an arbitrary `*.pkg.dev` project/region is still refused.
 * Redirect-only: these are NOT valid image registries on their own
 * (`registryRequestHost` consults REGISTRY_HOST_ALLOWLIST).
 *
 * Enumerated 2026-10-17 with `curl -sI` on manifests for pause:3.9,
 * kube-proxy:v1.31.0, coredns/coredns:v1.11.3, metrics-server/metrics-server:v0.7.2
 * and ingress-nginx/controller:v1.11.2, observed from a US egress. Every one 307'd to
 * `us-central1-docker.pkg.dev` (anonymous GET there returns the manifest, 200).
 * registry.k8s.io routes by client region, so other regions may be sent to other
 * regional hosts; add those as exact entries when observed. Blob redirects
 * (`cdn.registry.k8s.io`) are not needed: currency reads manifests only.
 */
const K8S_REDIRECT_HOSTS = ['us-central1-docker.pkg.dev'] as const;

/** Hosts a token realm, or any redirect hop, may point at. */
export const REGISTRY_OUTBOUND_ALLOWLIST: ReadonlySet<string> = new Set([
  ...REGISTRY_HOST_ALLOWLIST,
  'auth.docker.io',
  ...K8S_REDIRECT_HOSTS,
]);

/**
 * The agent canonicalizes Docker Hub's aliases to `docker.io` (W02); requests
 * go to `registry-1.docker.io`. Every other registry is requested under the
 * (already lowercased) name the agent reported.
 */
const REQUEST_HOST_FOR_REGISTRY: Readonly<Record<string, string>> = { 'docker.io': 'registry-1.docker.io' };

export const MEDIA_TYPE_OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
export const MEDIA_TYPE_DOCKER_LIST = 'application/vnd.docker.distribution.manifest.list.v2+json';
export const MEDIA_TYPE_OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
export const MEDIA_TYPE_DOCKER_MANIFEST = 'application/vnd.docker.distribution.manifest.v2+json';
const MANIFEST_ACCEPT = [
  MEDIA_TYPE_OCI_INDEX,
  MEDIA_TYPE_DOCKER_LIST,
  MEDIA_TYPE_OCI_MANIFEST,
  MEDIA_TYPE_DOCKER_MANIFEST,
].join(', ');

export const isIndexMediaType = (mediaType: string | null): boolean =>
  mediaType === MEDIA_TYPE_OCI_INDEX || mediaType === MEDIA_TYPE_DOCKER_LIST;

/** Spec §9.2: the one manifest GET is capped at 256 KB. */
export const MANIFEST_MAX_BYTES = 256 * 1024;
const TOKEN_MAX_BYTES = 64 * 1024;
/** A HEAD has no body; this only bounds a misbehaving server. */
const HEAD_MAX_BYTES = 16 * 1024;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;
const HEADERS_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** At most this many digests are kept from one index (well above any real multi-arch image). */
const MAX_PLATFORM_DIGESTS = 64;

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
/** OCI distribution-spec repository name grammar, plus a length bound. */
const REPOSITORY_PATH_RE = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

export const isSha256Digest = (value: string | null | undefined): value is string =>
  typeof value === 'string' && DIGEST_RE.test(value);

export type RegistryLookupResult =
  | { kind: 'ok'; digest: string; mediaType: string | null; platformDigests: string[] | null }
  | { kind: 'private' }
  | { kind: 'not_found' }
  | { kind: 'unsupported_registry' }
  | { kind: 'error'; reason: string }
  /** Not attempted this pass (registry throttled us); the rows stay due. */
  | { kind: 'skipped'; reason: string };

export interface ImageRepositoryParts {
  /** The agent's canonical registry name (`docker.io`, `ghcr.io`, …). */
  registry: string;
  /** Repository path within the registry (`library/nginx`). */
  path: string;
}

/** Split the normalized `registry/repository` the agent reports (W02). */
export function splitImageRepository(imageRepository: string): ImageRepositoryParts | null {
  const slash = imageRepository.indexOf('/');
  if (slash <= 0 || slash === imageRepository.length - 1) return null;
  return { registry: imageRepository.slice(0, slash).toLowerCase(), path: imageRepository.slice(slash + 1) };
}

/** The host requests for `registry` go to, or null when it is off the allowlist. */
export function registryRequestHost(registry: string): string | null {
  const host = REQUEST_HOST_FOR_REGISTRY[registry] ?? registry;
  return REGISTRY_HOST_ALLOWLIST.has(host) ? host : null;
}

type FetchFn = (url: string, init: SafeFetchInit, options: { allowHost: (u: URL) => boolean }) => Promise<Response>;

export interface RegistryClientOptions {
  /** Max in-flight requests per registry host. */
  perRegistryConcurrency?: number;
  /** Test seams. */
  fetchImpl?: FetchFn;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  log?: (message: string) => void;
}

export interface LookupArgs {
  registry: string;
  path: string;
  tag: string;
  /**
   * Local digests the caller will compare against. When the registry's digest
   * differs from at least one of them AND the tag is an index/list, the index
   * is fetched once (bounded) to learn its platform manifests.
   */
  localDigests: readonly string[];
}

/** https, default port, no userinfo, host on the allowlist. */
const allowOutboundHost = (u: URL): boolean =>
  u.protocol === 'https:' && u.port === '' && !u.username && !u.password && REGISTRY_OUTBOUND_ALLOWLIST.has(u.hostname);

const defaultFetch: FetchFn = (url, init, options) =>
  safeFetchFollowingRedirects(url, init, MAX_REDIRECTS, { allowHost: options.allowHost });

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    // A released slot is handed straight to the next waiter (active is not
    // decremented), so a newcomer can never slip in between and overshoot.
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    else this.active++;
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
}

/** Parse `Bearer realm="…",service="…",scope="…"`. Null for any other scheme. */
export function parseBearerChallenge(header: string | null): Record<string, string> | null {
  if (!header) return null;
  const match = /^\s*Bearer\s+(.*)$/i.exec(header);
  if (!match) return null;
  const params: Record<string, string> = {};
  for (const m of match[1]!.matchAll(/([A-Za-z_]+)\s*=\s*"([^"]*)"/g)) params[m[1]!.toLowerCase()] = m[2]!;
  return params.realm ? params : null;
}

/** `Retry-After` as delta-seconds or an HTTP date; null when absent/unparseable. */
export function parseRetryAfterMs(header: string | null, now: number = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

const contentTypeOf = (res: Response): string | null => {
  const raw = res.headers.get('content-type');
  return raw ? raw.split(';')[0]!.trim().toLowerCase() : null;
};

/** Class of an outbound failure, safe to log (no URL query, no headers). */
function failureReason(err: unknown): string {
  if (err instanceof SsrfBlockedError) return 'blocked_by_policy';
  if (err instanceof ResponseTooLargeError) return 'response_too_large';
  const code = (err as { code?: unknown; cause?: { code?: unknown } } | null)?.cause?.code ?? (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z_]{2,40}$/.test(code) ? `request_failed_${code.toLowerCase()}` : 'request_failed';
}

/** The token endpoint gave no usable anonymous token (a fault, not "private"). */
class TokenUnavailable extends Error {
  constructor() {
    super('token_unavailable');
  }
}

class RetryableStatus extends Error {
  constructor(public readonly status: number, public readonly retryAfterMs: number | null) {
    super(`retryable status ${status}`);
  }
}

export interface RegistryClient {
  lookup(args: LookupArgs): Promise<RegistryLookupResult>;
  /** Number of HTTP requests issued (manifest + token), for the per-pass summary. */
  requestCount(): number;
}

export function createRegistryClient(options: RegistryClientOptions = {}): RegistryClient {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const log = options.log ?? ((message: string) => console.warn(`[imageCurrency] ${message}`));
  const perRegistry = Math.max(1, options.perRegistryConcurrency ?? 2);
  const semaphores = new Map<string, Semaphore>();
  /** A registry that still answered 429 after our retries is left alone for the rest of the pass. */
  const throttled = new Set<string>();
  let requests = 0;

  const semaphoreFor = (host: string): Semaphore => {
    let s = semaphores.get(host);
    if (!s) {
      s = new Semaphore(perRegistry);
      semaphores.set(host, s);
    }
    return s;
  };

  /** One request with bounded retries on 429/5xx/transport errors (exponential + jitter, honours Retry-After). */
  async function request(host: string, url: string, init: SafeFetchInit): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        const retryAfter = lastError instanceof RetryableStatus ? lastError.retryAfterMs : null;
        const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
        const delay = Math.min(BACKOFF_MAX_MS, retryAfter ?? backoff + Math.floor(random() * BACKOFF_BASE_MS));
        await sleep(delay);
      }
      try {
        requests++;
        const res = await semaphoreFor(host).run(() =>
          fetchImpl(url, { timeoutMs: REQUEST_TIMEOUT_MS, headersTimeoutMs: HEADERS_TIMEOUT_MS, ...init }, {
            allowHost: allowOutboundHost,
          }),
        );
        if (res.status === 429 || res.status >= 500) {
          lastError = new RetryableStatus(res.status, parseRetryAfterMs(res.headers.get('retry-after')));
          continue;
        }
        return res;
      } catch (err) {
        // Policy refusals and oversize bodies are not transient: do not retry them.
        if (err instanceof SsrfBlockedError || err instanceof ResponseTooLargeError) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }

  async function fetchAnonymousToken(
    host: string,
    challenge: Record<string, string>,
    path: string,
  ): Promise<string | null> {
    let realm: URL;
    try {
      realm = new URL(challenge.realm!);
    } catch {
      throw new TokenUnavailable();
    }
    // The realm is registry-controlled: it must be on the allowlist like any other hop.
    if (!allowOutboundHost(realm)) throw new HostNotAllowedError(realm.hostname);
    if (challenge.service) realm.searchParams.set('service', challenge.service);
    realm.searchParams.set('scope', challenge.scope || `repository:${path}:pull`);
    const res = await request(host, realm.toString(), { method: 'GET', maxBytes: TOKEN_MAX_BYTES });
    // The realm refusing an ANONYMOUS token is how some registries say "credentials required".
    if (res.status === 401 || res.status === 403) return null;
    if (res.status !== 200) throw new TokenUnavailable();
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new TokenUnavailable();
    }
    const token = (body as { token?: unknown; access_token?: unknown } | null) ?? {};
    const value = typeof token.token === 'string' ? token.token : typeof token.access_token === 'string' ? token.access_token : null;
    // A malformed token answer is a registry fault, not proof the repository is private.
    if (!value || value.length > 8192) throw new TokenUnavailable();
    return value;
  }

  /** Manifest request with the anonymous token dance. `private` = refused even after it. */
  async function manifestRequest(
    host: string,
    path: string,
    tag: string,
    method: 'HEAD' | 'GET',
    auth: { token: string | null },
  ): Promise<Response | 'private'> {
    const url = `https://${host}/v2/${path}/manifests/${encodeURIComponent(tag)}`;
    const send = () =>
      request(host, url, {
        method,
        headers: { Accept: MANIFEST_ACCEPT, ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}) },
        maxBytes: method === 'GET' ? MANIFEST_MAX_BYTES : HEAD_MAX_BYTES,
      });
    let res = await send();
    if (res.status === 401 && !auth.token) {
      const challenge = parseBearerChallenge(res.headers.get('www-authenticate'));
      if (!challenge) return 'private';
      auth.token = await fetchAnonymousToken(host, challenge, path);
      if (!auth.token) return 'private';
      res = await send();
    }
    if (res.status === 401 || res.status === 403) return 'private';
    return res;
  }

  async function readIndexDigests(res: Response): Promise<string[] | null> {
    let body: unknown;
    try {
      body = JSON.parse(Buffer.from(await res.arrayBuffer()).toString('utf8'));
    } catch {
      return null;
    }
    const manifests = (body as { manifests?: unknown } | null)?.manifests;
    if (!Array.isArray(manifests)) return null;
    const digests = manifests
      .map((m) => (m && typeof m === 'object' ? (m as { digest?: unknown }).digest : null))
      .filter((d): d is string => isSha256Digest(d as string));
    return [...new Set(digests)].slice(0, MAX_PLATFORM_DIGESTS);
  }

  async function lookup(args: LookupArgs): Promise<RegistryLookupResult> {
    const host = registryRequestHost(args.registry);
    if (!host) return { kind: 'unsupported_registry' };
    if (!REPOSITORY_PATH_RE.test(args.path) || args.path.length > 255 || !TAG_RE.test(args.tag)) {
      return { kind: 'error', reason: 'invalid_reference' };
    }
    if (throttled.has(host)) return { kind: 'skipped', reason: 'registry_throttled' };

    const auth = { token: null as string | null };
    try {
      const head = await manifestRequest(host, args.path, args.tag, 'HEAD', auth);
      if (head === 'private') return { kind: 'private' };
      if (head.status === 404) return { kind: 'not_found' };
      if (head.status !== 200) return { kind: 'error', reason: `status_${head.status}` };

      let digest = head.headers.get('docker-content-digest');
      let mediaType = contentTypeOf(head);
      let platformDigests: string[] | null = null;
      const needsBody = !isSha256Digest(digest);
      const mismatch = isSha256Digest(digest) && args.localDigests.some((local) => local !== digest);

      // One bounded GET, only when the HEAD could not give us the digest, or
      // the tag is an index and some local digest differs (platform membership).
      // A HEAD without Content-Type cannot rule out an index: GET to find out.
      if (needsBody || (mismatch && (mediaType === null || isIndexMediaType(mediaType)))) {
        const get = await manifestRequest(host, args.path, args.tag, 'GET', auth);
        if (get === 'private') return { kind: 'private' };
        if (get.status === 404) return { kind: 'not_found' };
        if (get.status !== 200) return { kind: 'error', reason: `status_${get.status}` };
        const bytes = Buffer.from(await get.arrayBuffer());
        const headerDigest = get.headers.get('docker-content-digest');
        digest = isSha256Digest(headerDigest) ? headerDigest : `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
        mediaType = contentTypeOf(get) ?? mediaType;
        if (isIndexMediaType(mediaType)) {
          platformDigests = await readIndexDigests(new Response(bytes));
          // An index we cannot list would leave the rows undecidable (and due) forever.
          if (platformDigests === null) return { kind: 'error', reason: 'index_unreadable' };
        }
      }
      if (!isSha256Digest(digest)) return { kind: 'error', reason: 'no_digest' };
      return { kind: 'ok', digest, mediaType, platformDigests };
    } catch (err) {
      if (err instanceof TokenUnavailable) {
        log(`lookup on ${host} failed: token_unavailable`);
        return { kind: 'error', reason: 'token_unavailable' };
      }
      if (err instanceof RetryableStatus) {
        if (err.status === 429) {
          throttled.add(host);
          log(`registry ${host} rate-limited; skipping it for the rest of this pass`);
          return { kind: 'skipped', reason: 'registry_throttled' };
        }
        log(`lookup on ${host} failed: status_${err.status}`);
        return { kind: 'error', reason: `status_${err.status}` };
      }
      const reason = failureReason(err);
      // Host + class only: never the URL query, headers or token.
      log(`lookup on ${host} failed: ${reason}`);
      // A redirect or token realm to a host outside the v1 allowlist means this
      // registry is not servable under it (registry.k8s.io, for one, redirects
      // manifests to off-list hosts): a standing answer, rechecked on the 6 h
      // cadence. Address-policy refusals (e.g. a private-range resolution) may
      // be transient and stay `error` (1 h).
      if (err instanceof HostNotAllowedError) return { kind: 'unsupported_registry' };
      return { kind: 'error', reason };
    }
  }

  return { lookup, requestCount: () => requests };
}
