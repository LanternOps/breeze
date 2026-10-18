// The portal sits behind a TLS-terminating proxy and sets no security.allowedDomains, so
// Astro.url.origin reports the internal http origin. Derive the public origin from the
// forwarded headers instead, validating both so a hostile header cannot inject into a
// canonical/og:url. Anything missing or malformed falls back to the supplied URL's origin.
const HOST_RE = /^[a-z0-9.-]+(?::\d{1,5})?$/i;

function first(value: string | null): string {
  return value?.split(',')[0]?.trim() ?? '';
}

export function publicOriginFor(request: Request, fallback: URL): string {
  const proto = first(request.headers.get('x-forwarded-proto')).toLowerCase();
  const host = first(request.headers.get('x-forwarded-host')) || first(request.headers.get('host'));
  if ((proto !== 'http' && proto !== 'https') || !HOST_RE.test(host)) return fallback.origin;
  return `${proto}://${host}`;
}
