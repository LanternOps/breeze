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
  // Strip query/fragment so a hostile `next` carrying a token (e.g. an OAuth
  // code accidentally routed through this path) doesn't land in the console
  // or any forwarded log sink. Then bound the length.
  const pathOnly = raw.split(/[?#]/)[0]!;
  const preview = pathOnly.length > 64 ? pathOnly.slice(0, 64) + '…' : pathOnly;
  // No client-side observability sink exists today (no Sentry browser SDK in
  // apps/web). When one is added, route this through a structured breadcrumb
  // so probe campaigns leave a server-visible trace.
  // eslint-disable-next-line no-console
  console.warn('[authNext] dropping unsafe next', { raw: preview, fallback });
  return fallback;
}
