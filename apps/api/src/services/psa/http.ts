import { isHosted } from '../../config/env';
import { checkSsrfSafe, type SsrfMode } from '../ssrfGuard';
import { safeFetch, SsrfBlockedError, type SafeFetchInit } from '../urlSafety';

const DEFAULT_PSA_TIMEOUT_MS = 20_000;

/**
 * Ceiling on a single PSA response body.
 *
 * `safeFetch` treats an unset `maxBytes` as unbounded, which was survivable when
 * every PSA call was a one-shot request. Company import walks up to
 * MAX_PSA_PAGES responses per preview against a TENANT-CONTROLLED `baseUrl`, so
 * an operator pointing a connection at their own server could otherwise make the
 * API buffer that many arbitrarily-large bodies in memory. 8 MiB is far above any
 * real page of companies or tickets (100 companies is a few KB) while keeping a
 * hostile endpoint bounded.
 */
const MAX_PSA_RESPONSE_BYTES = 8 * 1024 * 1024;

// On-prem PSAs (ConnectWise / Autotask / ServiceNow / Jira Data Center, etc.)
// legitimately live on the customer LAN, so on SELF-HOSTED deployments their
// base URL may be plain http:// and/or an RFC1918/ULA address. Hosted SaaS stays
// strict (HTTPS-only, no private networking) because a private IP is genuinely
// unreachable from us and is a real SSRF target. Loopback, link-local, cloud
// metadata, and CGNAT remain blocked in BOTH modes (see ssrfGuard +
// urlSafety.isAlwaysBlockedIp).
//
// Fail closed: only open http/RFC1918 when self-host is AFFIRMATIVELY declared
// (IS_HOSTED explicitly set to a recognized non-truthy value: 'false'/'0'/'no'/
// 'off'). Unset/empty/garbage IS_HOSTED => strict, mirroring the #570 hardening
// lesson and the dnsProviders precedent (an unmapped IS_HOSTED must never
// silently weaken security). `!isHosted()` is implied by falsey-set membership
// but kept explicit so the truthy/falsey vocabularies can never drift apart.
function psaAllowsPrivateNetwork(): boolean {
  const isHostedRaw = (process.env.IS_HOSTED ?? '').trim().toLowerCase();
  const recognizedSelfHostSignal = new Set(['0', 'false', 'no', 'off']).has(isHostedRaw);
  return recognizedSelfHostSignal && !isHosted();
}

export function validatePsaBaseUrl(rawUrl: string): string | null {
  // Self-hosted operators own both ends, so permit http + RFC1918/ULA via the
  // on-prem mode. Hosted SaaS keeps the strict HTTPS-only, no-private-IP mode.
  const mode: SsrfMode = psaAllowsPrivateNetwork() ? 'on-prem-http' : 'strict-https';
  const result = checkSsrfSafe(rawUrl, { mode });
  return result.ok ? null : result.reason ?? 'URL is not safe';
}

export async function psaFetch(input: string | URL, init: SafeFetchInit = {}): Promise<Response> {
  const rawUrl = String(input);
  const staticError = validatePsaBaseUrl(rawUrl);
  if (staticError) {
    throw new SsrfBlockedError(`PSA URL rejected: ${staticError}`);
  }

  return safeFetch(rawUrl, {
    timeoutMs: DEFAULT_PSA_TIMEOUT_MS,
    maxBytes: MAX_PSA_RESPONSE_BYTES,
    // Self-hosters may legitimately reach RFC1918/ULA PSAs; metadata/loopback/
    // link-local/CGNAT stay blocked even when this is true. Hosted SaaS: strict.
    allowPrivateNetwork: psaAllowsPrivateNetwork(),
    ...init,
  });
}
