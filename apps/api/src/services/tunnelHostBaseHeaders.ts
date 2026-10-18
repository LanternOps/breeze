/**
 * The security headers every Network Proxy tunnel-host response carries
 * (spec 2026-10-06 §6), whoever produced it: the tunnel app, an outer gate
 * (global rate limit, body limit, FORCE_HTTPS) or the host classifier. Leaf
 * module (no imports) so middleware can apply it without pulling routes in.
 */

/** `frame-ancestors` only: the app origin plus `'self'`; `'none'` when the config is missing (fail closed). */
export function hostModeCsp(frameAncestor: string | null): string {
  return frameAncestor ? `frame-ancestors ${frameAncestor} 'self'` : "frame-ancestors 'none'";
}

/**
 * Keeps a CSP the handler already set (the enter page's nonce CSP carries its
 * own frame-ancestors); everything else is forced.
 */
export function applyHostModeBaseHeaders(headers: Headers, frameAncestor: string | null): void {
  if (!headers.has('content-security-policy')) headers.set('content-security-policy', hostModeCsp(frameAncestor));
  headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
}

/**
 * Apply the base headers (and optionally `X-Request-Id`) to a Response,
 * cloning it when its headers are immutable. Returns the Response to use.
 */
export function withHostModeBaseHeaders(res: Response, frameAncestor: string | null, requestId?: string): Response {
  const apply = (headers: Headers) => {
    applyHostModeBaseHeaders(headers, frameAncestor);
    if (requestId) headers.set('X-Request-Id', requestId);
  };
  try {
    apply(res.headers);
    return res;
  } catch {
    const copy = new Response(res.body, res);
    apply(copy.headers);
    return copy;
  }
}
