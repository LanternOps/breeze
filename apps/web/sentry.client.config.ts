import * as Sentry from '@sentry/astro';

const dsn = import.meta.env.PUBLIC_SENTRY_DSN_WEB;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1.0,
    integrations: [
      Sentry.replayIntegration({
        maskAllText: true,
        maskAllInputs: true,
        blockAllMedia: true,
        networkDetailAllowUrls: []
      })
    ],
    sendDefaultPii: false,
    beforeSend: safeBeforeSend,
    beforeBreadcrumb: safeBeforeBreadcrumb
  });
}

function safeBeforeSend(event: Sentry.ErrorEvent): Sentry.ErrorEvent | null {
  try {
    if (event.request) {
      delete event.request.cookies;
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

// Drops origin (host leaks tenant subdomains for MSP deployments) and search/hash;
// replaces UUIDs and long hex IDs in the path with placeholders.
function redactUrl(url: string): string {
  try {
    const u = new URL(url, 'http://placeholder.local');
    return u.pathname.replace(UUID_RE, ':id').replace(HEX_RE, ':hash');
  } catch {
    return url.replace(UUID_RE, ':id').replace(HEX_RE, ':hash');
  }
}
