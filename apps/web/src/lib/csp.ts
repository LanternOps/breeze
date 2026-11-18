export type EnvMap = Record<string, string | undefined>;

function readFlagFromEnv(env: EnvMap, name: string): boolean {
  const raw = env[name]?.trim().toLowerCase();
  return raw === '1' || raw === 'true';
}

function addConfiguredOrigin(sources: Set<string>, rawUrl: string | undefined): void {
  if (!rawUrl) return;

  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;

    sources.add(parsed.origin);
    if (parsed.protocol === 'http:') {
      sources.add(`ws://${parsed.host}`);
    } else {
      sources.add(`wss://${parsed.host}`);
    }
  } catch {
    // Ignore invalid URL configuration and fall back to the rest of the policy.
  }
}

function addConfiguredConnectHosts(sources: Set<string>, rawHosts: string | undefined): void {
  for (const host of rawHosts?.split(',') ?? []) {
    const trimmed = host.trim();
    if (!trimmed || /[\u0000-\u001F\u007F;]/.test(trimmed)) continue;
    sources.add(trimmed);
  }
}

function addSentryOrigin(sources: Set<string>, rawDsn: string | undefined): void {
  if (!rawDsn) return;

  try {
    const parsed = new URL(rawDsn);
    if (parsed.protocol === 'https:') {
      sources.add(parsed.origin);
    }
  } catch {
    // Ignore invalid DSN configuration.
  }
}

/** Canonical hosted documentation origin embedded by the in-app help panel. */
const DOCS_FRAME_ORIGIN = 'https://docs.breezermm.com';

function addFrameOrigin(sources: Set<string>, rawUrl: string | undefined): void {
  if (!rawUrl) return;

  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;

    // Only the origin — frame-src has no WebSocket counterpart, and a bare
    // scheme (e.g. `https:`) would defeat the point of scoping the iframe.
    sources.add(parsed.origin);
  } catch {
    // Ignore invalid URL configuration and fall back to the default origin.
  }
}

// Same shape the API accepts for TUNNEL_ORIGIN_TEMPLATE
// (apps/api/src/config/tunnelOrigin.ts TEMPLATE_RE / LABEL_RE). The API refuses
// to boot on anything else, so a template this rejects never serves host mode.
const TUNNEL_TEMPLATE_RE = /^(https?):\/\/\{id\}\.([a-z0-9.-]+?)(?::(\d{1,5}))?$/;
const DNS_LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * Network Proxy host mode (#11300): every tunnel is served from its own origin
 * `<scheme>://<tunnel-id>.<suffix>`, so the frame source is the wildcard
 * `<scheme>://*.<suffix>`. Returns null when host mode is off or the template is
 * malformed; plain http and a port are only accepted for `*.localhost` stacks,
 * as on the API.
 */
export function resolveTunnelFrameSource(rawTemplate: string | undefined): string | null {
  const match = TUNNEL_TEMPLATE_RE.exec(rawTemplate?.trim() ?? '');
  if (!match) return null;

  const scheme = match[1];
  const suffix = match[2] ?? '';
  const port = match[3] ?? '';
  const labels = suffix.split('.');
  if (labels.length < 2 || !labels.every((label) => DNS_LABEL_RE.test(label))) return null;

  const localhost = suffix === 'localhost' || suffix.endsWith('.localhost');
  if ((scheme !== 'https' || port) && !localhost) return null;

  return `${scheme}://*.${suffix}${port ? `:${port}` : ''}`;
}

/**
 * `HelpPanel.tsx` embeds the docs site in an <iframe>. Without an explicit
 * frame-src the browser falls back to `default-src 'self'` and blocks it.
 * Always allow the canonical hosted docs origin, plus a self-hosted docs
 * origin when `PUBLIC_DOCS_URL` is configured.
 *
 * `blob:` is retained in frame-src as a defensive allowance for framing
 * same-origin, in-memory blob URLs the app itself creates. It was originally
 * required by the auth-gated quote PDF preview (`QuotePreview`), which fetched
 * the PDF with a Bearer header and framed the resulting `blob:` object URL.
 * That component was replaced by the HTML preview (`QuoteDocumentPreview`),
 * but an uploaded agreement's PDF inside it is framed the same way
 * (`AgreementFrame` in billing/documentHostComponents.tsx), so `blob:` is
 * load-bearing again: removing it breaks the agreement viewer. It permits only
 * same-origin app-created blobs (the `frame-ancestors` and `object-src`
 * directives are independent and unaffected).
 *
 * The Network Proxy tunnel origin (`TUNNEL_ORIGIN_TEMPLATE`) is runtime-only:
 * the web image is built once for every region, so the build-time copy in
 * astro.config.mjs never has it and the middleware widens the Astro CSP with
 * this directive on each response.
 */
export function resolveFrameSrcDirective(options: { env?: EnvMap }): string {
  const env = options.env ?? process.env;
  const sources = new Set<string>(["'self'", 'blob:', DOCS_FRAME_ORIGIN]);

  addFrameOrigin(sources, env.PUBLIC_DOCS_URL);

  const tunnelSource = resolveTunnelFrameSource(env.TUNNEL_ORIGIN_TEMPLATE);
  if (tunnelSource) sources.add(tunnelSource);

  return `frame-src ${Array.from(sources).join(' ')}`;
}

export function resolveConnectSrcDirective(options: {
  env?: EnvMap;
  isDev: boolean;
}): string {
  const env = options.env ?? process.env;
  const sources = new Set<string>(["'self'"]);

  addConfiguredOrigin(sources, env.PUBLIC_API_URL);
  addConfiguredOrigin(sources, env.PUBLIC_DOCS_URL);
  addSentryOrigin(sources, env.PUBLIC_SENTRY_DSN_WEB ?? env.SENTRY_DSN_WEB);
  addConfiguredConnectHosts(sources, env.CSP_CONNECT_HOSTS);

  // Cloudflare Web Analytics: the beacon script (allowed in script-src from
  // static.cloudflareinsights.com) POSTs its RUM payload here. Without this
  // the runtime-tightened connect-src (SOC 2 header hardening) blocks it.
  sources.add('https://cloudflareinsights.com');

  if (options.isDev) {
    sources.add('http://localhost:3001');
    sources.add('ws://localhost:3001');
    sources.add('ws:');
    sources.add('wss:');
  }

  return `connect-src ${Array.from(sources).join(' ')}`;
}

export function resolveUnsafeInlineCspOptions(options: {
  env?: EnvMap;
  isDev: boolean;
  strictDevCsp: boolean;
}): { allowInlineScript: boolean; allowInlineStyle: boolean } {
  const env = options.env ?? process.env;
  const allowUnsafeInlineInDev =
    options.isDev && (readFlagFromEnv(env, 'CSP_ALLOW_DEV_UNSAFE_INLINE') || !options.strictDevCsp);

  return {
    allowInlineScript:
      allowUnsafeInlineInDev ||
      (options.isDev &&
        (readFlagFromEnv(env, 'CSP_ALLOW_UNSAFE_INLINE') ||
          readFlagFromEnv(env, 'CSP_ALLOW_UNSAFE_INLINE_SCRIPT'))),
    allowInlineStyle:
      allowUnsafeInlineInDev ||
      (options.isDev &&
        (readFlagFromEnv(env, 'CSP_ALLOW_UNSAFE_INLINE') ||
          readFlagFromEnv(env, 'CSP_ALLOW_UNSAFE_INLINE_STYLE'))),
  };
}

