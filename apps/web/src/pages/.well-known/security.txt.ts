import type { APIRoute } from 'astro';
import { buildSecurityTxt, resolveSecurityContacts } from '../../lib/securityContact';

// RFC 9116 security.txt (#8872). Driven entirely by the web container's
// environment so each deployment publishes its own contacts; 404 when none
// are set. Caddy's catch-all routes this path to web (it is not in the
// `@oauthWellKnown` matcher that goes to the API).
export const GET: APIRoute = () => {
  const body = buildSecurityTxt(resolveSecurityContacts(import.meta.env), new Date());
  if (!body) return new Response(null, { status: 404 });
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
};

// Must read the environment at request time, not at build.
export const prerender = false;
