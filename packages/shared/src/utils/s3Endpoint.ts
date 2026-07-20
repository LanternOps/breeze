/**
 * Coerce a user-supplied S3-compatible endpoint into a fully-schemed URL
 * string safe to hand to `@aws-sdk/client-s3`'s `S3Client({ endpoint })`.
 *
 * Background: the SDK's endpoint resolver (@smithy/core's `parseUrl` /
 * `toEndpointV1`) calls `new URL(endpoint)` deep inside its call stack with no
 * scheme normalization. A scheme-less endpoint — which humans type all the
 * time — fails there in TWO different ways, and it matters that they are not
 * the same bug:
 *
 *   new URL('s3.example.com')    -> throws TypeError: Invalid URL
 *   new URL('minio.local:9000')  -> SUCCEEDS, as protocol 'minio.local:'
 *                                   with an EMPTY host and pathname '9000'
 *
 * The bare-host form is what produced the opaque `TypeError: Invalid URL` in
 * Sentry BREEZE-P. The `host:port` form is arguably worse: it parses, so
 * nothing throws, and the SDK goes on to build requests against a URL with no
 * host — surfacing later as a confusing connection/malformed-request error
 * that looks nothing like a config mistake. Coercing at the input boundary,
 * before the value ever reaches the SDK, turns both into either a normalized
 * value or one clear validation error.
 *
 * Mirrors the same "default to https:// when no scheme is present" rule
 * `deriveS3RegionFromEndpoint` (./s3Region.ts) already uses for region
 * derivation. There are three endpoint parsers in this repo and they are
 * deliberately distinct, by failure mode:
 *
 *   - deriveS3RegionFromEndpoint (./s3Region.ts) — fails SOFT to null, so the
 *     caller can fall back to a default region.
 *   - normalizeS3Endpoint (api/src/jobs/backupRetention.ts) — fails SOFT to a
 *     trimmed/lowercased raw string. It builds a storage *identity* key, where
 *     a wrong answer must fail toward "different bucket" (safe: splits one
 *     bucket in two) and must never throw, since that would break retention.
 *   - coerceS3EndpointUrl (this function) — fails LOUD, because an endpoint
 *     the SDK cannot parse is not something we can silently work around.
 *
 * All three share the default-to-https rule and must stay in sync on it.
 *
 * Returns `undefined` for a blank/absent endpoint so callers can pass the
 * result straight through to `S3Client({ endpoint })` and get the SDK's
 * default per-region AWS endpoint. Throws when the value can't be parsed as a
 * URL even after a scheme is added, or when it carries a scheme other than
 * http/https.
 */
export function coerceS3EndpointUrl(endpoint: string | null | undefined): string | undefined {
  const raw = endpoint?.trim();
  if (!raw) return undefined;

  const withScheme = raw.includes('://') ? raw : `https://${raw}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(invalidEndpointMessage(raw));
  }

  // Reject anything that isn't http(s). `new URL` happily accepts arbitrary
  // schemes, so without this check `s3://my-bucket` (a very common paste into
  // an "endpoint" field), `ftp://host`, and `file:///etc/passwd` all sail
  // through to S3Client and fail opaquely inside the SDK — the exact
  // BREEZE-P class this helper exists to close.
  //
  // The scheme-less `minio.local:9000` shape never reaches this check, since
  // we prepend https:// above and it then parses with a real host. The empty
  // -host guard below is for explicitly-schemed input that parses to nothing
  // usable (e.g. a bare 'https://'), which would otherwise reach the SDK.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(invalidEndpointMessage(raw));
  }
  if (!parsed.host) {
    throw new Error(invalidEndpointMessage(raw));
  }

  return parsed.toString();
}

function invalidEndpointMessage(raw: string): string {
  return (
    `S3 endpoint "${raw}" is not a valid URL. Use a host (e.g. s3.example.com) `
    + `or host:port (e.g. minio.local:9000), optionally prefixed with http:// or https://.`
  );
}
