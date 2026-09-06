import { fetchWithTimeout } from './fetchWithTimeout';

/**
 * `fetchWithTimeout` for services that build their own bearer request instead
 * of going through `coreRequest`: on a 401 it refreshes the access token once
 * (through the app's single shared refresher) and replays the request with the
 * new bearer, keeping every other header and the body. A second 401 is
 * returned as-is, and so is the first when no bearer was sent, when the
 * refresh fails, or when the caller opts out because a 401 means something
 * else on that endpoint (step-up failure on an approval decision).
 *
 * Without this, these services hard-401'd from JWT_EXPIRES_IN (15 minutes)
 * after sign-in until some coreRequest call happened to refresh the token.
 */
export async function fetchWithAuthRefresh(
  url: string,
  init: RequestInit,
  timeoutMs?: number,
  opts: { retryOnAuthFailure?: boolean } = {}
): Promise<Response> {
  const res = await fetchWithTimeout(url, init, timeoutMs);
  if (res.status !== 401 || opts.retryOnAuthFailure === false) return res;
  if (!readHeader(init.headers, 'Authorization')) return res;
  // Lazy: api.ts drags react-native into the module graph, and the services
  // that use this wrapper are node-testable precisely because they do not.
  const { refreshAccessToken } = await import('./api');
  const fresh = await refreshAccessToken();
  if (!fresh) return res;
  return fetchWithTimeout(
    url,
    { ...init, headers: withHeader(init.headers, 'Authorization', `Bearer ${fresh}`) },
    timeoutMs
  );
}

// The callers pass plain records, but RequestInit admits Headers and tuple
// arrays too, so handle all three rather than narrowing the parameter type.
function readHeader(headers: HeadersInit | undefined, name: string): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    const hit = headers.find(([k]) => k.toLowerCase() === name.toLowerCase());
    return hit ? hit[1] : null;
  }
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : null;
}

function withHeader(headers: HeadersInit | undefined, name: string, value: string): HeadersInit {
  if (headers instanceof Headers) {
    const next = new Headers(headers);
    next.set(name, value);
    return next;
  }
  if (Array.isArray(headers)) {
    return [...headers.filter(([k]) => k.toLowerCase() !== name.toLowerCase()), [name, value]];
  }
  const rest = Object.fromEntries(
    Object.entries(headers ?? {}).filter(([k]) => k.toLowerCase() !== name.toLowerCase())
  );
  return { ...rest, [name]: value };
}
