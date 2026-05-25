import * as Sentry from '@sentry/astro';

// Same precedence as astro.config.mjs to avoid a sourcemaps/errors split-brain.
// SENTRY_DSN_WEB_SERVER lets ops route SSR errors to a separate Sentry project
// from the public browser DSN if desired; falls back to the shared web DSN.
const dsn =
  process.env.SENTRY_DSN_WEB_SERVER ??
  process.env.PUBLIC_SENTRY_DSN_WEB ??
  process.env.SENTRY_DSN_WEB;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'production',
    release: process.env.SENTRY_RELEASE ?? process.env.PUBLIC_RELEASE_VERSION,
    // 10% trace sampling on SSR requests — matches the client config.
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
    beforeSend(event) {
      try {
        if (event.request) {
          delete event.request.cookies;
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
          delete event.request.data;
          delete event.request.query_string;
          if (typeof event.request.url === 'string') {
            event.request.url = event.request.url.replace(
              /([?&])(secret|token|password|api_key|apikey)=[^&]*/gi,
              '$1$2=[REDACTED]'
            );
          }
        }
        if (event.user) {
          delete event.user.email;
          delete event.user.ip_address;
          delete event.user.username;
        }
        return event;
      } catch {
        delete event.request;
        delete event.user;
        return event;
      }
    }
  });
}
