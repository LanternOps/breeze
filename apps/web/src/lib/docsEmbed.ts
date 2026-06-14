const ALLOWED_HTTPS_HOSTS = new Set([
  'breezermm.com',
  '2breeze.app',
]);

const ALLOWED_HTTPS_SUFFIXES = [
  '.breezermm.com',
  '.2breeze.app',
];

const ALLOWED_HTTP_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  'tauri.localhost',
]);

export type DocsEmbedEnv = { PUBLIC_DOCS_URL?: string | undefined };

/**
 * Self-hosted / custom-domain deployments serve the app from an origin we can't
 * enumerate ahead of time (e.g. `https://rmm.example.com`), so the hard-coded
 * allowlist above would always disable the embedded docs panel and force the
 * new-tab fallback — even for operators who've correctly stood up their own
 * docs origin and authorized framing from their app.
 *
 * `PUBLIC_DOCS_URL` is the single deployment knob for "I run my own docs site."
 * Setting it already widens the CSP `frame-src` directive to that origin
 * (see `resolveFrameSrcDirective` in `csp.ts`). When it's present we treat the
 * *current app origin* as embed-eligible too, so the two halves of the embed
 * path (the CSP header and this client gate) stay in lock-step. Operators who
 * leave it unset keep the conservative Breeze-only allowlist and the graceful
 * new-tab fallback.
 *
 * The env map is injected so the gate is unit-testable; production callers fall
 * back to `import.meta.env`.
 */
function readEnv(env?: DocsEmbedEnv): DocsEmbedEnv {
  if (env) return env;
  try {
    return import.meta.env as unknown as DocsEmbedEnv;
  } catch {
    return {};
  }
}

/**
 * The origin (scheme + host + port) of a self-hosted docs site configured via
 * `PUBLIC_DOCS_URL`, or `null` when unset/invalid. Returning the bare origin
 * (not the full URL) lets callers rebase docs paths onto it and lets the
 * `isDocsUrl` security gate add it as a second trusted origin without ever
 * widening to a lookalike host.
 */
export function configuredDocsOrigin(env?: DocsEmbedEnv): string | null {
  const raw = readEnv(env).PUBLIC_DOCS_URL?.trim();
  if (!raw) return null;
  try {
    const { protocol, origin } = new URL(raw);
    if (protocol !== 'http:' && protocol !== 'https:') return null;
    return origin;
  } catch {
    return null;
  }
}

function hasConfiguredDocsOrigin(env: DocsEmbedEnv): boolean {
  return configuredDocsOrigin(env) !== null;
}

export function isDocsEmbeddableOrigin(origin: string, env?: DocsEmbedEnv): boolean {
  try {
    const { protocol, hostname } = new URL(origin);

    if (protocol === 'https:') {
      if (ALLOWED_HTTPS_HOSTS.has(hostname) || ALLOWED_HTTPS_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
        return true;
      }
      // Self-hosted opt-in: a configured docs origin signals the operator
      // controls both the app and the docs site and has authorized framing.
      return hasConfiguredDocsOrigin(readEnv(env));
    }

    if (protocol === 'http:') {
      // Local dev hosts are always embeddable. A plain-http custom origin is
      // only honored when the operator opted in via PUBLIC_DOCS_URL.
      return ALLOWED_HTTP_HOSTS.has(hostname) || hasConfiguredDocsOrigin(readEnv(env));
    }

    return false;
  } catch {
    return false;
  }
}
