import type { APIRoute } from 'astro';

// Sentry smoke endpoint — intentionally throws so we can verify the SSR error
// pipeline (sentry.server.config.ts) and any source-map upload after a deploy.
//
// Strict opt-in: enabled ONLY when `ENABLE_SENTRY_SMOKE=1` is set in the
// environment. Earlier this endpoint also auto-enabled in production builds,
// which made it a publicly invokable unauth'd 500-on-GET endpoint by default
// — a Sentry-quota DoS and alert-noise vector. Production verification now
// requires ops to set the env var explicitly, hit it once, and unset it (or
// leave it set, ack the risk, and lean on the Sentry rate limit).
export const GET: APIRoute = async () => {
  if (!import.meta.env.ENABLE_SENTRY_SMOKE) {
    return new Response('Sentry smoke endpoint disabled. Set ENABLE_SENTRY_SMOKE=1 to enable.', {
      status: 404
    });
  }

  throw new Error('sentry-web-smoke (intentional)');
};

// Prerendered pages can't throw at request time; force SSR.
export const prerender = false;
