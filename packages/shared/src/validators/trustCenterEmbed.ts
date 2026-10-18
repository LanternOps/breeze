// packages/shared/src/validators/trustCenterEmbed.ts
// Owner: W03a (Trust Center embed, #8771). The per-page iframe allowlist: exact https origins that may frame the
// public embed card (`/portal/trust/embed/*`). The same normalizer runs in the API (PUT validation), the portal
// (defence in depth before a value reaches a CSP header) and the web editor (preview), so all three agree.
import { z } from 'zod';

/** Most origins a page may allow (also a DB CHECK: trust_pages_embed_origins_max_chk). */
export const TRUST_EMBED_ORIGINS_MAX = 10;
/** Longest raw entry accepted before normalization. */
export const TRUST_EMBED_ORIGIN_MAX_CHARS = 300;

const HOST_RE = /^[a-z0-9.-]+$/;

/**
 * Normalize one allowlist entry to `https://host[:port]`, or null when it is not an exact https origin.
 * Rejected, never silently stripped: any path, query or fragment; credentials; non-https schemes; wildcards and
 * CSP keywords; IP literals; `localhost` and single-label hosts. IDNs come back as punycode (URL's own conversion).
 * The result is a fixed point: `normalizeEmbedOrigin(x) === x` for every non-null output.
 */
export function normalizeEmbedOrigin(input: string): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (raw.length === 0 || raw.length > TRUST_EMBED_ORIGIN_MAX_CHARS) return null;
  // `https://x/?` and `https://x#` parse to an empty search/hash; a host never contains either character, so
  // their presence anywhere means a query or fragment was supplied.
  if (raw.includes('?') || raw.includes('#')) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
  const host = url.hostname;
  if (!HOST_RE.test(host)) return null; // wildcards, IPv6 literals, separators, anything a CSP could misread
  const labels = host.split('.');
  if (labels.length < 2 || labels.some((l) => l.length === 0)) return null; // localhost, intranet, trailing dot
  if (/^\d+$/.test(labels[labels.length - 1]!)) return null; // IPv4 literal (WHATWG treats a numeric last label as IPv4)
  if (host === 'localhost' || host.endsWith('.localhost')) return null;
  return url.origin;
}

/** PUT /orgs/:orgId/trust-page/embed. Normalizes every entry; an unusable or duplicate entry is an issue at its index. */
export const trustEmbedOriginsUpdateSchema = z.strictObject({
  origins: z.array(z.string().max(TRUST_EMBED_ORIGIN_MAX_CHARS)).max(TRUST_EMBED_ORIGINS_MAX),
}).transform((value, ctx) => {
  const seen = new Set<string>();
  const origins: string[] = [];
  value.origins.forEach((entry, i) => {
    const origin = normalizeEmbedOrigin(entry);
    if (origin === null) {
      ctx.addIssue({ code: 'custom', path: ['origins', i], message: 'Enter an exact https origin, such as https://www.example.com (no path, wildcard or IP address).' });
      return;
    }
    if (seen.has(origin)) {
      ctx.addIssue({ code: 'custom', path: ['origins', i], message: `Duplicate origin: ${origin}` });
      return;
    }
    seen.add(origin);
    origins.push(origin);
  });
  return { origins };
});
export type TrustEmbedOriginsUpdateInput = z.input<typeof trustEmbedOriginsUpdateSchema>;
