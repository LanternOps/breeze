// Open-redirect guard for `?next=` query params: only same-origin relative
// paths (single leading `/`, second char not `/` or `\`). Some browsers
// historically normalize `\` to `/`, making `/\evil.com` resolvable as a host.
export function getSafeNext(raw: string | null | undefined, fallback = '/'): string {
  if (!raw) return fallback;
  if (!raw.startsWith('/')) return fallback;
  if (raw.length > 1 && (raw[1] === '/' || raw[1] === '\\')) return fallback;
  return raw;
}
