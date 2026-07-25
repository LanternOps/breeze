/**
 * Credentials the probe sends where auth is required. Either shape works, and
 * both may be combined (e.g. a session cookie plus an `x-csrf-token` header):
 *
 * - `{ cookie }` — a session cookie string, sent as the `cookie` header.
 * - `{ headers }` — arbitrary auth headers, e.g.
 *   `{ authorization: 'Bearer <token>' }` or `{ 'x-api-key': '<key>' }`.
 *   Header auth avoids driving the rate-limited login flow to mint a cookie.
 *
 * Every value in `headers` is treated as a secret: **every** supplied credential
 * is redacted from observations and errors, whichever shape it arrived in. Put
 * non-sensitive headers here too if you must, but note they are redacted from
 * the report as well (see `MIN_SECRET_LENGTH` for the short-value carve-out).
 *
 * The union requires one of the two *properties* to be present — it cannot rule
 * out `{ headers: {} }` or `{ cookie: '' }`, which supply no actual credential.
 * `probeStockHost` throws on those rather than probing anonymously.
 */
export type StockHostProbeAuth =
  | { cookie: string; headers?: Record<string, string> }
  | { cookie?: string; headers: Record<string, string> };

/** Options for a black-box probe of a running stock Breeze host. */
export interface StockHostProbeOptions {
  /** Base origin of the host, e.g. `https://localhost:3000`. */
  baseUrl: string;
  /** The extension's manifest `name`. */
  extensionName: string;
  /** The digest the enabled extension is expected to serve assets under. */
  expectedDigest: string;
  /** Auth credentials, sent only where auth is required and never surfaced. */
  auth: StockHostProbeAuth;
  /** Relative asset member under `assets/:name/:digest/` to probe (default `index.html`). */
  assetMember?: string;
  /** Injectable fetch (defaults to the global) — supply a fake in tests. */
  fetchImpl?: typeof fetch;
}

/** A single black-box observation. `detail` is always secret-redacted. */
export interface ProbeObservation {
  name: string;
  ok: boolean;
  status: number | null;
  detail: string;
}

export interface HostProbeResult {
  ok: boolean;
  observations: ProbeObservation[];
}

/**
 * `fetch` reports connection, TLS and DNS failures as a bare `fetch failed`,
 * stranding the actionable reason (`ECONNREFUSED`, cert mismatch, `ENOTFOUND`)
 * on `error.cause`. Fold it in, or an unreachable host observes as one useless
 * word. The result still goes through `redact` before it reaches a caller.
 */
function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const { cause } = error;
  const causeText = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  if (!causeText || error.message.includes(causeText)) return error.message;
  return `${error.message}: ${causeText}`;
}

/**
 * Redaction is blanket substring replacement, so a short value is not safe to
 * replace: scrubbing `1` would rewrite the HTTP status codes, digests and URLs
 * that are this probe's entire diagnostic product (a stray `x-tenant: 1` header
 * would turn `-> 401` into `-> 40[redacted]`). Nothing this short is a credible
 * credential — every session cookie, Bearer token and API key is far longer —
 * so the floor costs no real protection. Applies to supplied and derived values
 * alike.
 */
const MIN_SECRET_LENGTH = 8;

/**
 * Auth schemes whose credential is worth registering on its own. Deriving from
 * *any* spaced value would make ordinary headers into secrets — a
 * `user-agent: probe/1.0 conformance-suite` would blanket-replace
 * `conformance-suite` throughout the report.
 */
const AUTH_SCHEMES = new Set(['bearer', 'basic', 'token', 'digest']);

/**
 * Every secret string that must never appear in output, longest-first so the
 * most specific match is replaced before its own substrings:
 *
 * - the cookie string, plus each `name=value` pair and each pair's value — a
 *   host rejecting a session echoes back just the offending pair, not the whole
 *   multi-pair string;
 * - each header value, plus — for scheme-prefixed values like `Bearer <token>`
 *   — the bare credential after the scheme, since a host that rejects a token
 *   usually echoes it without the scheme.
 *
 * Values below {@link MIN_SECRET_LENGTH} are skipped. Non-string header values
 * are ignored (this package is consumable from plain JS).
 *
 * @internal Exported for the co-located tests; not part of the package API.
 */
export function collectProbeSecrets(auth: StockHostProbeAuth): readonly string[] {
  const secrets = new Set<string>();
  // An empty value must never be added — ''.split('') would put a marker
  // between every character — which the length floor already precludes.
  const add = (value: string): void => {
    if (value.length >= MIN_SECRET_LENGTH) secrets.add(value);
  };

  if (typeof auth.cookie === 'string' && auth.cookie.trim()) {
    add(auth.cookie);
    for (const pair of auth.cookie.split(';')) {
      const trimmed = pair.trim();
      add(trimmed);
      const nameEnd = trimmed.indexOf('=');
      if (nameEnd > 0) add(trimmed.slice(nameEnd + 1).trim());
    }
  }

  for (const value of Object.values(auth.headers ?? {})) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    add(value);
    add(trimmed);
    // Split on the first space only — no regex (CodeQL js/polynomial-redos).
    // Derive off the *trimmed* value: a leading space would otherwise put the
    // scheme at index 0 and silently skip derivation.
    const schemeEnd = trimmed.indexOf(' ');
    if (schemeEnd > 0 && AUTH_SCHEMES.has(trimmed.slice(0, schemeEnd).toLowerCase())) {
      add(trimmed.slice(schemeEnd + 1).trim());
    }
  }

  return [...secrets].sort((a, b) => b.length - a.length);
}

/**
 * Black-box HTTP conformance probes against a running stock host. Verifies the
 * health route, admin state (lists the extension), the runtime registry, the
 * immutable asset cache header, and that the extension's own namespace rejects
 * unauthenticated requests. Auth is a session cookie, auth headers (Bearer /
 * API key), or both. Every supplied secret value is redacted from every
 * observation and error — none is ever logged or returned in the clear.
 *
 * A failing probe is reported as an `ok: false` observation, never thrown.
 *
 * @throws if `auth` carries no usable credential — a caller precondition, not a
 * host observation, so it must not be reported as a host conformance failure.
 */
export async function probeStockHost(options: StockHostProbeOptions): Promise<HostProbeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  // Trim trailing slashes without a regex: /\/+$/ backtracks polynomially
  // on adversarial input (CodeQL js/polynomial-redos).
  let base = options.baseUrl;
  while (base.endsWith('/')) base = base.slice(0, -1);
  // Header auth and cookie auth compose. Header names are case-insensitive, so
  // normalise before merging: without this, `headers: { Cookie }` plus an
  // explicit `cookie` survives as two keys that `Headers` joins into one
  // `cookie: "stale; fresh"` value, sending the stale credential first.
  // Blank values are dropped — they authenticate nothing.
  const authedHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.auth.headers ?? {})) {
    if (typeof value === 'string' && value.trim()) authedHeaders[name.toLowerCase()] = value;
  }
  if (typeof options.auth.cookie === 'string' && options.auth.cookie.trim()) {
    authedHeaders.cookie = options.auth.cookie;
  }
  // The union enforces that an auth *property* is present, but `{ headers: {} }`
  // and `{ cookie: '' }` satisfy it while supplying nothing. Probing anonymously
  // would report the authed routes as conformance failures when the real fault
  // is missing credentials — so fail on the caller's precondition instead.
  if (Object.keys(authedHeaders).length === 0) {
    throw new Error(
      'probeStockHost: `auth` supplied no usable credentials — pass a non-empty `cookie` '
      + 'or at least one non-blank header value.',
    );
  }
  const authedInit: RequestInit = { headers: authedHeaders };
  const member = options.assetMember ?? 'index.html';

  // Never let ANY supplied secret — cookie or header value — escape into a
  // detail string or error message.
  const secrets = collectProbeSecrets(options.auth);
  const redact = (text: string): string => {
    let out = text;
    for (const secret of secrets) out = out.split(secret).join('[redacted]');
    return out;
  };

  const observations: ProbeObservation[] = [];
  const probe = async (name: string, run: () => Promise<ProbeObservation>): Promise<void> => {
    try {
      observations.push(await run());
    } catch (error) {
      observations.push({ name, ok: false, status: null, detail: redact(errorMessage(error)) });
    }
  };

  await probe('health', async () => {
    const res = await fetchImpl(`${base}/health`, {});
    return { name: 'health', ok: res.ok, status: res.status, detail: redact(`GET /health -> ${res.status}`) };
  });

  await probe('adminState', async () => {
    const res = await fetchImpl(`${base}/api/v1/admin/extensions`, authedInit);
    let listed = false;
    try {
      const body = (await res.json()) as { extensions?: Array<{ name?: unknown }> };
      listed = Array.isArray(body?.extensions)
        && body.extensions.some((row) => row?.name === options.extensionName);
    } catch {
      listed = false;
    }
    return {
      name: 'adminState',
      ok: res.ok && listed,
      status: res.status,
      detail: redact(`GET /api/v1/admin/extensions -> ${res.status}${listed ? `, lists "${options.extensionName}"` : ', extension not listed'}`),
    };
  });

  await probe('registry', async () => {
    const res = await fetchImpl(`${base}/api/v1/extensions/registry`, authedInit);
    return { name: 'registry', ok: res.ok, status: res.status, detail: redact(`GET /api/v1/extensions/registry -> ${res.status}`) };
  });

  await probe('assetImmutable', async () => {
    const url = `${base}/api/v1/extensions/assets/${options.extensionName}/${options.expectedDigest}/${member}`;
    const res = await fetchImpl(url, authedInit);
    const cacheControl = res.headers.get('cache-control') ?? '';
    const immutable = cacheControl.includes('immutable');
    return {
      name: 'assetImmutable',
      ok: res.ok && immutable,
      status: res.status,
      detail: redact(`GET assets/${options.extensionName}/${options.expectedDigest}/${member} -> ${res.status}, Cache-Control="${cacheControl}"`),
    };
  });

  await probe('routeAuth', async () => {
    // Deliberately unauthenticated: the extension namespace must reject anonymous access.
    const res = await fetchImpl(`${base}/api/v1/ext/${options.extensionName}`, {});
    const rejected = res.status === 401 || res.status === 403;
    return {
      name: 'routeAuth',
      ok: rejected,
      status: res.status,
      detail: redact(`unauthenticated GET /api/v1/ext/${options.extensionName} -> ${res.status} (${rejected ? 'rejected' : 'NOT rejected'})`),
    };
  });

  return { ok: observations.every((observation) => observation.ok), observations };
}
