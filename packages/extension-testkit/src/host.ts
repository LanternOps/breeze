/** Options for a black-box probe of a running stock Breeze host. */
export interface StockHostProbeOptions {
  /** Base origin of the host, e.g. `https://localhost:3000`. */
  baseUrl: string;
  /** The extension's manifest `name`. */
  extensionName: string;
  /** The digest the enabled extension is expected to serve assets under. */
  expectedDigest: string;
  /** Session auth. The cookie is sent only where auth is required and is never surfaced. */
  auth: { cookie: string };
  /** Relative asset member under `assets/:name/:digest/` to probe (default `index.html`). */
  assetMember?: string;
  /** Injectable fetch (defaults to the global) — supply a fake in tests. */
  fetchImpl?: typeof fetch;
}

/** A single black-box observation. `detail` is always cookie-redacted. */
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

/**
 * Black-box HTTP conformance probes against a running stock host. Verifies the
 * health route, admin state (lists the extension), the runtime registry, the
 * immutable asset cache header, and that the extension's own namespace rejects
 * unauthenticated requests. The auth cookie is redacted from every observation
 * and error — it is never logged or returned in the clear.
 */
export async function probeStockHost(options: StockHostProbeOptions): Promise<HostProbeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const cookie = options.auth.cookie;
  // Trim trailing slashes without a regex: /\/+$/ backtracks polynomially
  // on adversarial input (CodeQL js/polynomial-redos).
  let base = options.baseUrl;
  while (base.endsWith('/')) base = base.slice(0, -1);
  const authedInit: RequestInit = { headers: { cookie } };
  const member = options.assetMember ?? 'index.html';

  // Never let the cookie value escape into a detail string or error message.
  const redact = (text: string): string => (cookie ? text.split(cookie).join('[redacted]') : text);

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
