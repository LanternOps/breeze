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

/**
 * `HelpPanel.tsx` embeds the docs site in an <iframe>. Without an explicit
 * frame-src the browser falls back to `default-src 'self'` and blocks it.
 * Always allow the canonical hosted docs origin, plus a self-hosted docs
 * origin when `PUBLIC_DOCS_URL` is configured.
 */
export function resolveFrameSrcDirective(options: { env?: EnvMap }): string {
  const env = options.env ?? process.env;
  const sources = new Set<string>(["'self'", DOCS_FRAME_ORIGIN]);

  addFrameOrigin(sources, env.PUBLIC_DOCS_URL);

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

