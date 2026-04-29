import * as Sentry from '@sentry/astro';

// Same precedence as astro.config.mjs to avoid a sourcemaps/errors split-brain.
const dsn = process.env.PUBLIC_SENTRY_DSN_WEB ?? process.env.SENTRY_DSN_WEB;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'production',
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend(event) {
      try {
        if (event.request) {
          delete event.request.cookies;
          delete event.request.headers;
          delete event.request.data;
          delete event.request.query_string;
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
