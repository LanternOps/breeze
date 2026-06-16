/**
 * Runtime configuration. The bundle is deployment-neutral: it fetches
 * `/config.json` (served from the add-in's own origin) at boot via
 * loadRuntimeConfig(), so one prebuilt bundle works for every deployment
 * (hosted SaaS and self-hosters) with no per-deployment rebuild.
 *
 * If /config.json is absent or malformed, we fall back to the build-time
 * VITE_* env (apps/<host>-addin/.env, gitignored — see .env.example) and then
 * to localhost defaults, so local dev needs no config file.
 *
 * NOTE: the manifest is NOT runtime-configurable — Office reads static XML and
 * cannot fetch this file. Each deployment still generates its own manifest
 * (scripts/generate-manifest.mjs). config.json covers only the JS bundle.
 */
export type RuntimeConfig = {
  /** Origin of the Breeze API, no trailing slash, e.g. https://us.2breeze.app */
  apiBaseUrl: string;
  /** Entra app-registration client ID; must equal the API's CLIENT_AI_ENTRA_CLIENT_ID. */
  entraClientId: string;
};

const FALLBACK: RuntimeConfig = {
  apiBaseUrl: ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:3001').replace(
    /\/+$/,
    '',
  ),
  entraClientId: (import.meta.env.VITE_CLIENT_AI_ENTRA_CLIENT_ID as string | undefined) ?? '',
};

function warnConfigFallback(reason: string): void {
  // Visible in the Office webview console so a misdeployed config.json (absent,
  // non-2xx, or malformed) is diagnosable — the getters then return the
  // build-time fallback (localhost), which in a DEPLOYED environment almost
  // certainly means the API origin + Entra client ID are wrong.
  console.warn(
    `[client-ai] runtime /config.json not loaded (${reason}); using fallback config — ` +
      'API origin + Entra client ID may be misconfigured in this environment.',
  );
}

let runtime: RuntimeConfig = { ...FALLBACK };

/** API origin (no trailing slash). Valid before load (returns the fallback). */
export function getApiBaseUrl(): string {
  return runtime.apiBaseUrl;
}

/** Entra client ID. Valid before load (returns the fallback). */
export function getEntraClientId(): string {
  return runtime.entraClientId;
}

/**
 * Fetch /config.json once at boot and populate the runtime config. Always
 * resolves — on any failure it keeps the fallback. Safe to call more than once
 * (the last successful load wins). cache:'no-store' so a deploy that swaps
 * config.json is picked up without an Office webview cache hit.
 */
export async function loadRuntimeConfig(fetchImpl: typeof fetch = fetch): Promise<RuntimeConfig> {
  try {
    const res = await fetchImpl('/config.json', { cache: 'no-store' });
    if (res.ok) {
      const body = (await res.json()) as Partial<RuntimeConfig>;
      runtime = {
        apiBaseUrl: (typeof body.apiBaseUrl === 'string' && body.apiBaseUrl
          ? body.apiBaseUrl
          : FALLBACK.apiBaseUrl
        ).replace(/\/+$/, ''),
        // Symmetric with apiBaseUrl: an empty string falls back too, so the
        // committed dev config.json (entraClientId "") lets VITE_CLIENT_AI_ENTRA_CLIENT_ID
        // fill it in, and a deployment that forgets the client ID degrades to
        // the fallback rather than locking in an unusable empty SSO client.
        entraClientId:
          typeof body.entraClientId === 'string' && body.entraClientId
            ? body.entraClientId
            : FALLBACK.entraClientId,
      };
      return runtime;
    }
    warnConfigFallback(`HTTP ${res.status}`);
  } catch {
    // fetch rejected, or res.json() threw on a non-JSON body (e.g. an HTML 200
    // error page) — keep the fallback.
    warnConfigFallback('fetch/parse error');
  }
  return runtime;
}

/** Test-only: reset to the build-time fallback. */
export function __resetRuntimeConfigForTests(): void {
  runtime = { ...FALLBACK };
}
