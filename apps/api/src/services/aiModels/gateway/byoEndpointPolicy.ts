/**
 * Egress policy for a partner's BYO OpenAI-compatible base URL (spec §12, W06).
 *
 * This is the AUTHORING-time gate (write, discovery). It is not the rebinding
 * defence: every request re-resolves and pins its dial through safeFetch with the
 * same allowances (gateway/forward.ts). Mirrors the long-standing self-host
 * policy of the deleted env-only OpenAI-compatible provider, so absorbing that
 * path (W06) is not a regression: private RFC 1918/ULA only on an explicitly self-hosted deployment,
 * cleartext only to a private address, loopback/link-local/metadata never.
 */
import { isHosted, selfHostAllowsPrivateNetwork } from '../../../config/env';
import { assertSafeUrl, SsrfBlockedError } from '../../urlSafety';

export interface ByoEgressAllowances {
  allowPrivateNetwork: boolean;
  requirePrivateForCleartext: true;
}

export class ByoEndpointRejected extends Error {
  readonly status = 400 as const;
  constructor(message: string, readonly code: 'egress_blocked' | 'invalid_url') {
    super(message);
    this.name = 'ByoEndpointRejected';
  }
}

export function byoEgressAllowances(): ByoEgressAllowances {
  return { allowPrivateNetwork: !isHosted() && selfHostAllowsPrivateNetwork(), requirePrivateForCleartext: true };
}

function parse(raw: string): URL {
  const trimmed = raw.trim().replace(/\/+$/, '');
  let u: URL;
  try { u = new URL(trimmed); } catch { throw new ByoEndpointRejected('Enter a valid http(s) URL.', 'invalid_url'); }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname
    || u.username !== '' || u.password !== '' || trimmed.includes('?') || trimmed.includes('#')) {
    throw new ByoEndpointRejected('The URL must be http(s) with no credentials, query or fragment.', 'invalid_url');
  }
  return u;
}

export async function validateByoBaseUrl(raw: string): Promise<string> {
  const u = parse(raw);
  const allow = byoEgressAllowances();
  if (u.protocol === 'http:' && isHosted()) {
    throw new ByoEndpointRejected('Hosted Breeze only connects to https endpoints.', 'egress_blocked');
  }
  try {
    await assertSafeUrl(u.toString(), { allowPrivateNetwork: allow.allowPrivateNetwork });
  } catch (error) {
    if (error instanceof SsrfBlockedError) {
      throw new ByoEndpointRejected(
        allow.allowPrivateNetwork
          ? 'That host is not reachable from Breeze (loopback, link-local and metadata addresses are never allowed).'
          : 'That host resolves to a private or reserved address, which Breeze does not connect to.',
        'egress_blocked',
      );
    }
    throw error;
  }
  if (u.protocol === 'http:') {
    // Cleartext is only allowed to a private address (the key would otherwise
    // cross the internet in the clear). assertSafeUrl has no flag for this, so
    // check the classification of what the name resolves to now; the per-request
    // dial re-checks via safeFetch({ requirePrivateForCleartext: true }).
    try {
      await assertSafeUrl(u.toString(), { allowPrivateNetwork: false });
      // Resolved to a public address over http: refuse.
      throw new ByoEndpointRejected('Use https for an endpoint on a public address.', 'egress_blocked');
    } catch (error) {
      if (error instanceof ByoEndpointRejected) throw error;
      if (!(error instanceof SsrfBlockedError)) throw error;
      // SsrfBlocked under the strict policy ⇒ it is private ⇒ cleartext allowed.
    }
  }
  return u.toString().replace(/\/+$/, '');
}

export function joinByoUrl(baseUrl: string, path: string): string {
  if (!/^[a-z][a-z/_-]*$/.test(path)) throw new Error(`joinByoUrl: illegal path ${JSON.stringify(path)}`);
  return `${baseUrl.replace(/\/+$/, '')}/${path}`;
}
