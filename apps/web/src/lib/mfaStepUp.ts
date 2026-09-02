import {
  startAuthentication,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { fetchWithAuth } from '../stores/auth';

/**
 * Mint an operation-bound, single-use step-up grant (RMM-QA-176 D10).
 *
 * Extracted from stores/authenticator.ts's `mintRegisterGrant` so the
 * maintenance dialog and approver-device registration cannot drift on the
 * ceremony or on the `skipUnauthorizedRetry` rationale. The store's `password`
 * branch stays there: it targets a different endpoint
 * (/authenticator/register-grant) and `password` is not a valid step-up method
 * for a resource-bound operation.
 */
export type StepUpReauth = { method: 'totp'; code: string } | { method: 'passkey' };

export class StepUpMintError extends Error {
  constructor(
    readonly code: 'invalid_factor' | 'unavailable',
    message: string,
    /** Preserved so the approver-device store can keep exposing `status` to
     * its callers, which map 401/403/429 to distinct copy. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'StepUpMintError';
  }
}

async function postOrThrow(
  path: string,
  body: unknown,
  fallback: string,
): Promise<Record<string, any>> {
  const response = await fetchWithAuth(path, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    // A 401 here means the TOTP code / passkey assertion was rejected (wrong
    // code, or an assertion already burned) — NOT a stale access token.
    // Replaying after a refresh would resubmit the same rejected factor.
    skipUnauthorizedRetry: true,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new StepUpMintError(
      response.status === 401 || response.status === 403 ? 'invalid_factor' : 'unavailable',
      (data as { error?: string } | null)?.error ?? fallback,
      response.status,
    );
  }
  // A 2xx with an unparseable body (empty body, truncated proxy response) must
  // not resolve to `null`: every caller immediately reads a field off the
  // result, which would throw a raw TypeError deep in the ceremony instead of
  // a catchable StepUpMintError. Parity with the store's `jsonOrThrow`.
  try {
    return await response.json();
  } catch {
    throw new StepUpMintError('unavailable', 'Unexpected server response.', response.status);
  }
}

export async function mintStepUpGrant(opts: {
  operation: string;
  resource?: unknown;
  reauth: StepUpReauth;
}): Promise<string> {
  let body: Record<string, unknown>;
  if (opts.reauth.method === 'totp') {
    body = { method: 'totp', code: opts.reauth.code, operation: opts.operation };
  } else {
    // Passkey: fetch an authenticated step-up challenge, run the assertion
    // ceremony, then prove it to /auth/mfa/step-up.
    const challengeData = await postOrThrow(
      '/auth/mfa/step-up/options',
      undefined,
      'Could not start passkey verification.',
    );
    const optionsJSON: PublicKeyCredentialRequestOptionsJSON =
      challengeData.options ?? challengeData.optionsJSON ?? (challengeData as never);
    const credential = await startAuthentication({ optionsJSON });
    body = { method: 'passkey', credential, operation: opts.operation };
  }
  // Only set when present: the mint route 400s a resource on an operation that
  // is not in RESOURCE_BOUND_OPERATIONS (routes/auth/mfa.ts).
  if (opts.resource !== undefined) body.resource = opts.resource;

  const data = await postOrThrow('/auth/mfa/step-up', body, 'Verification failed.');
  if (!data?.stepUpGrantId) throw new StepUpMintError('unavailable', 'Verification failed.');
  return data.stepUpGrantId as string;
}
