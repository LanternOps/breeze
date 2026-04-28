// Returns a safe post-auth redirect target derived from a `?next=` query
// parameter. Only same-origin relative paths are accepted (single leading
// slash, never `//evil.com`). Prevents open-redirect via crafted OAuth flows.
export function getSafeNext(raw: string | null | undefined, fallback = '/'): string {
  if (!raw) return fallback;
  if (!raw.startsWith('/') || raw.startsWith('//')) return fallback;
  return raw;
}
