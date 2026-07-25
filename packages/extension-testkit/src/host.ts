/**
 * Credentials the probe sends where auth is required. Either shape works, and
 * both may be combined (e.g. a session cookie plus an `x-csrf-token` header):
 *
 * - `{ cookie }` — a session cookie string, sent as the `cookie` header.
 * - `{ headers }` — arbitrary auth headers, e.g.
 *   `{ authorization: 'Bearer <token>' }` or `{ 'x-api-key': '<key>' }`.
 *   Header auth avoids driving the rate-limited login flow to mint a cookie.
 *
 * The union requires at least one of the two. **Every** supplied secret value is
 * redacted from observations and errors, whichever shape it arrived in.
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Below this length a derived fragment is too generic to blanket-replace. */
const MIN_DERIVED_SECRET_LENGTH = 8;

/**
 * Every secret string that must never appear in output: the cookie, each header
 * value, and — for scheme-prefixed values like `Bearer <token>` or
 * `Basic <base64>` — the bare credential after the scheme, since a host that
 * echoes an invalid token back usually echoes it without the scheme. Sorted
 * longest-first so the most specific match is replaced before its substrings.
 */
export function collectProbeSecrets(auth: StockHostProbeAuth): string[] {
  const secrets = new Set<string>();
  const add = (value: string | undefined): void => {
    // Empty values must never be added: ''.split('') would replace every char.
    if (value) secrets.add(value);
  };

  add(auth.cookie);
  for (const value of Object.values(auth.headers ?? {})) {
    add(value);
    // Split on the first space only — no regex (CodeQL js/polynomial-redos).
    const schemeEnd = value.indexOf(' ');
    if (schemeEnd > 0) {
      const credential = value.slice(schemeEnd + 1).trim();
      if (credential.length >= MIN_DERIVED_SECRET_LENGTH) add(credential);
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
 */
export async function probeStockHost(options: StockHostProbeOptions): Promise<HostProbeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  // Trim trailing slashes without a regex: /\/+$/ backtracks polynomially
  // on adversarial input (CodeQL js/polynomial-redos).
  let base = options.baseUrl;
  while (base.endsWith('/')) base = base.slice(0, -1);
  // Header auth and cookie auth compose; an explicit `cookie` wins over a
  // `cookie` key inside `headers`.
  const authedHeaders: Record<string, string> = { ...options.auth.headers };
  if (options.auth.cookie) authedHeaders.cookie = options.auth.cookie;
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
