/**
 * The tenant hint an MSP gives when creating an Entra tenant proof-run link
 * (portal registration W4, plan D6, Task 8): a tenant GUID, or a domain the
 * tenant has verified, resolved to its tid through Microsoft's public
 * `/{domain}/v2.0/.well-known/openid-configuration`.
 *
 * A hint is NOT proof (inv. 2). It only pins the link, so a link that was
 * forwarded or leaked cannot bind some other tenant whose admin opens it; the
 * callback requires the token's `tid` to equal the pinned tenant.
 *
 * The domain lookup is an outbound request built from MSP input, so the
 * domain must be hostname-shaped before anything is fetched: LDH labels and a
 * letter (or punycode) TLD, at least two labels, no path, port, userinfo,
 * query, fragment, percent-encoding or IP literal. The request host is fixed
 * (login.microsoftonline.com), redirects are refused and the lookup is
 * time-bounded. A single label is never accepted, which also rules out the
 * `common` / `organizations` / `consumers` authority aliases.
 */

export type TenantHint = { kind: 'guid'; tid: string } | { kind: 'domain'; domain: string };

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Upper bound on the openid-configuration lookup; the MSP is waiting on it. */
export const TENANT_HINT_LOOKUP_TIMEOUT_MS = 5_000;

const MICROSOFT_LOGIN_ORIGIN = 'https://login.microsoftonline.com';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Microsoft's consumer (MSA) tenant: never an organization's tenant. */
const CONSUMER_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad';
const MAX_DOMAIN_LENGTH = 253;
/** One LDH label: 1–63 characters, no leading or trailing hyphen. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** The last label: letters, or an IDN (punycode) label. Never numeric, so never an IPv4 literal. */
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
/** The v2 issuer Microsoft publishes for a tenant: exactly `https://login.microsoftonline.com/{tid}/v2.0`. */
const ISSUER = /^https:\/\/login\.microsoftonline\.com\/([0-9a-fA-F-]{36})\/v2\.0$/;

function normalizeTenantGuid(value: string): string | null {
  const tid = value.toLowerCase();
  return GUID.test(tid) && tid !== CONSUMER_TENANT_ID ? tid : null;
}

function normalizeDomain(value: string): string | null {
  const domain = value.toLowerCase();
  if (domain.length === 0 || domain.length > MAX_DOMAIN_LENGTH) return null;
  const labels = domain.split('.');
  if (labels.length < 2) return null;
  if (!labels.every((label) => LABEL.test(label))) return null;
  return TLD.test(labels[labels.length - 1]!) ? domain : null;
}

/**
 * A tenant GUID (lowercased; never the consumer tenant) or a hostname-shaped
 * domain (lowercased). Surrounding whitespace is ignored. Anything else → null.
 */
export function parseTenantHint(raw: string): TenantHint | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (GUID.test(value.toLowerCase())) {
    const tid = normalizeTenantGuid(value);
    return tid ? { kind: 'guid', tid } : null;
  }
  const domain = normalizeDomain(value);
  return domain ? { kind: 'domain', domain } : null;
}

export type TenantLookupResult =
  | { kind: 'tenant'; tid: string }
  /** A definite negative: not hostname-shaped, a consumer (MSA) domain, or Microsoft says no tenant verified it. */
  | { kind: 'unknown_domain' }
  /** Ambiguous: network, timeout, non-2xx other than invalid_tenant, unparseable or unexpected body. */
  | { kind: 'lookup_failed' };

/** Logged by reason, HTTP status and error name only, never the domain or a response body. */
function lookupFailed(reason: string, extra: { status?: number; errorName?: string } = {}): TenantLookupResult {
  console.warn('[portal] Entra tenant hint lookup failed', { reason, ...extra });
  return { kind: 'lookup_failed' };
}

/**
 * The tenant id of the Entra tenant that has verified `domain`, read from the
 * `issuer` of Microsoft's public openid-configuration for it. `unknown_domain`
 * is returned only for a definite negative (value not hostname-shaped, nothing
 * fetched; a consumer (MSA) domain; Microsoft's 400 `invalid_tenant`). Every
 * other failure is `lookup_failed`, so an outage is not shown as a bad hint.
 */
export async function resolveEntraTenantIdFromDomain(
  domain: string,
  deps: { fetch?: FetchLike } = {},
): Promise<TenantLookupResult> {
  const hint = typeof domain === 'string' ? parseTenantHint(domain) : null;
  if (!hint || hint.kind !== 'domain') return { kind: 'unknown_domain' };
  const fetchImpl: FetchLike = deps.fetch ?? globalThis.fetch;

  let response: Response;
  try {
    response = await fetchImpl(`${MICROSOFT_LOGIN_ORIGIN}/${hint.domain}/v2.0/.well-known/openid-configuration`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(TENANT_HINT_LOOKUP_TIMEOUT_MS),
    });
  } catch (err) {
    return lookupFailed('request', { errorName: err instanceof Error ? err.name : typeof err });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return lookupFailed(response.ok ? 'body' : 'status', response.ok ? {} : { status: response.status });
  }
  const record = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined;

  // Microsoft answers 400 {"error":"invalid_tenant"} (AADSTS90002) for a domain no tenant has verified.
  if (!response.ok) {
    if (response.status === 400 && record?.error === 'invalid_tenant') return { kind: 'unknown_domain' };
    return lookupFailed('status', { status: response.status });
  }

  const issuer = record?.issuer;
  const match = typeof issuer === 'string' ? ISSUER.exec(issuer) : null;
  if (!match) return lookupFailed('issuer');
  if (match[1]!.toLowerCase() === CONSUMER_TENANT_ID) return { kind: 'unknown_domain' };
  const tid = normalizeTenantGuid(match[1]!);
  return tid ? { kind: 'tenant', tid } : lookupFailed('issuer');
}
