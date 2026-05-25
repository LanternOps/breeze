import * as Sentry from '@sentry/astro';

const dsn = import.meta.env.PUBLIC_SENTRY_DSN_WEB;

if (dsn) {
  Sentry.init({
    dsn,
    environment:
      import.meta.env.PUBLIC_SENTRY_ENVIRONMENT ?? import.meta.env.MODE ?? 'production',
    // PUBLIC_APP_VERSION is stamped at build time (see apps/web/src/lib/version.ts).
    // PUBLIC_RELEASE_VERSION is an optional override for CI release tagging.
    release:
      import.meta.env.PUBLIC_RELEASE_VERSION ?? import.meta.env.PUBLIC_APP_VERSION ?? undefined,
    // Conservative trace sampling — 10% of page loads. Plenty of signal without
    // blowing up the Sentry quota on a multi-tenant SaaS surface.
    tracesSampleRate: 0.1,
    // Replays are expensive. Capture 0% of sessions; 50% of error sessions.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0.5,
    integrations: [
      Sentry.replayIntegration({
        maskAllText: true,
        maskAllInputs: true,
        blockAllMedia: true,
        // Never capture network payloads — they contain auth tokens, PII, and
        // tenant data. Replay's value here is the visual reproduction, not
        // network forensics.
        networkDetailAllowUrls: []
      })
    ],
    sendDefaultPii: false,
    // Filter noise that's not actionable.
    ignoreErrors: [
      // ResizeObserver loop is a known Chromium quirk; not a real error.
      'ResizeObserver loop limit exceeded',
      'ResizeObserver loop completed with undelivered notifications',
      // Browser extensions / third-party scripts throwing into our window.
      /Non-Error promise rejection captured/,
      // Chunk-load failures during deploys — expected.
      /Loading chunk \d+ failed/,
      /Failed to fetch dynamically imported module/,
      // Transient network errors during nav are noise.
      'Network request failed'
    ],
    beforeSend: safeBeforeSend,
    beforeBreadcrumb: safeBeforeBreadcrumb
  });
}

function safeBeforeSend(event: Sentry.ErrorEvent): Sentry.ErrorEvent | null {
  try {
    if (event.request) {
      delete event.request.cookies;
      // Defensively strip individual sensitive headers in case future code
      // disables the blanket `delete event.request.headers` below.
      if (event.request.headers && typeof event.request.headers === 'object') {
        const headers = event.request.headers as Record<string, unknown>;
        delete headers['authorization'];
        delete headers['Authorization'];
        delete headers['cookie'];
        delete headers['Cookie'];
        delete headers['x-csrf-token'];
        delete headers['X-CSRF-Token'];
      }
      delete event.request.headers;
      if (typeof event.request.url === 'string') {
        event.request.url = redactUrl(event.request.url);
      }
      delete event.request.query_string;
      delete event.request.data;
    }
    if (event.user) {
      delete event.user.email;
      delete event.user.ip_address;
      delete event.user.username;
    }
    return event;
  } catch {
    // Never let a scrub bug silently drop every event.
    delete event.request;
    delete event.user;
    return event;
  }
}

function safeBeforeBreadcrumb(crumb: Sentry.Breadcrumb): Sentry.Breadcrumb | null {
  try {
    if (crumb.data && typeof crumb.data === 'object') {
      if (typeof crumb.data.url === 'string') crumb.data.url = redactUrl(crumb.data.url);
      if (typeof crumb.data.to === 'string') crumb.data.to = redactUrl(crumb.data.to);
      if (typeof crumb.data.from === 'string') crumb.data.from = redactUrl(crumb.data.from);
    }
    return crumb;
  } catch {
    return { ...crumb, data: undefined };
  }
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX_RE = /\b[0-9a-f]{24,}\b/gi;
const SECRET_QS_RE = /([?&])(secret|token|password|api_key|apikey)=[^&]*/gi;

// Drops origin (host leaks tenant subdomains for MSP deployments) and search/hash;
// replaces UUIDs and long hex IDs in the path with placeholders. Also redacts
// any obvious secret-bearing query params before we drop the search string
// entirely — defense in depth in case a future change preserves it.
function redactUrl(url: string): string {
  const redactedQs = url.replace(SECRET_QS_RE, '$1$2=[REDACTED]');
  try {
    const u = new URL(redactedQs, 'http://placeholder.local');
    return u.pathname.replace(UUID_RE, ':id').replace(HEX_RE, ':hash');
  } catch {
    return redactedQs.replace(UUID_RE, ':id').replace(HEX_RE, ':hash');
  }
}
