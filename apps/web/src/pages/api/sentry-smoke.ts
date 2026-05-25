import type { APIRoute } from 'astro';

// Sentry smoke endpoint — intentionally throws so we can verify the SSR error
// pipeline (sentry.server.config.ts) and any source-map upload after a deploy.
//
// Gated behind an explicit env flag in non-production so we don't accidentally
// fire alerts from a CI smoke run or a curious dev's first `pnpm dev`. In
// production, ops hits this once during deploy verification, sees the event in
// Sentry, then forgets it exists.
//
// Disable rules:
//   * `ENABLE_SENTRY_SMOKE=1` always enables.
//   * Otherwise enabled only when `MODE === 'production'` (i.e. the built/served
//     bundle), so `astro dev` returns 404 by default.
export const GET: APIRoute = async () => {
  const enabled =
    Boolean(import.meta.env.ENABLE_SENTRY_SMOKE) || import.meta.env.MODE === 'production';

  if (!enabled) {
    return new Response('Sentry smoke endpoint disabled. Set ENABLE_SENTRY_SMOKE=1 to enable.', {
      status: 404
    });
  }

  throw new Error('sentry-web-smoke (intentional)');
};

// Prerendered pages can't throw at request time; force SSR.
export const prerender = false;
