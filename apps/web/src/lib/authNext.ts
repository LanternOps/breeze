// Open-redirect guard for `?next=` query params: only same-origin relative
// paths (single leading `/`, second char not `/` or `\`). Some browsers
// historically normalize `\` to `/`, making `/\evil.com` resolvable as a host.
//
// JS-navigation-safe only. The output is intended for `window.location.href`
// and in-app router targets; do not pass through to a server-side `Location`
// header without revalidating (this guard does not defend against header
// injection via embedded CRLF).
export function getSafeNext(raw: string | null | undefined, fallback = '/'): string {
  if (!raw) return fallback;
  if (!raw.startsWith('/')) return rejectAndWarn(raw, fallback);
  if (raw.length > 1 && (raw[1] === '/' || raw[1] === '\\')) return rejectAndWarn(raw, fallback);
  if (/[\x00-\x1F\x7F]/.test(raw)) return rejectAndWarn(raw, fallback);
  return raw;
}

function rejectAndWarn(raw: string, fallback: string): string {
  // Trimmed preview keeps the log line bounded if `raw` is hostile (long input).
  const preview = raw.length > 64 ? raw.slice(0, 64) + '…' : raw;
  // eslint-disable-next-line no-console
  console.warn('[authNext] dropping unsafe next', { raw: preview, fallback });
  return fallback;
}
