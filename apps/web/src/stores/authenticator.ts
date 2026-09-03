import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { fetchWithAuth } from './auth';
import type { AssertionProof } from '@breeze/shared';

/**
 * Browser-approver (Breeze Authenticator Phase 2) client helpers.
 *
 * Mirror the proven 3-step `apiVerifyPasskeyMFA` pattern in `stores/auth.ts`:
 * fetch options/challenge → run the WebAuthn ceremony via `@simplewebauthn/browser`
 * → POST the resulting attestation/assertion. All requests go through the app's
 * `fetchWithAuth` (bearer + org-id injection + token refresh).
 *
 * These are typed service-layer functions; the components that call them
 * (ProfilePage section, PamRespondModal, approvals) wrap the mutations in
 * `runAction` so success/failure surfaces to the user.
 */

export interface ApproverDevice {
  id: string;
  label: string | null;
  kind: string;
  isPlatformBound: boolean;
  /**
   * WHY this key counts as platform-bound (#1374). The boolean above is NOT the
   * L4 gate on its own — `L4_TRUSTED_PLATFORM_BOUND_BASES` on the server is —
   * so any UI that describes a device's assurance must read this, not
   * `isPlatformBound`. `webauthn_backup_flags` in particular means
   * `singleDevice && !backedUp`, i.e. backup-eligibility flags rather than a
   * hardware attestation.
   *
   * Optional so a client running against an API from before #1374 W02 still
   * type-checks. The honest attested/unattested badge that consumes it is W07.
   */
  platformBoundBasis?:
    | 'unattested'
    | 'legacy_unattested'
    | 'webauthn_backup_flags'
    | 'ios_keychain_rsa_app_attest'
    | 'ios_se_p256_app_attest'
    | 'android_tee_key_attestation'
    | 'android_strongbox_key_attestation';
  createdAt: string;
  lastUsedAt: string | null;
  // The list endpoint already filters to active devices server-side, so the DTO
  // omits this; kept optional for callers that defensively filter.
  disabledAt?: string | null;
}

export type RegisterReauth =
  | { method: 'passkey' }
  | { method: 'totp'; code: string }
  | { method: 'password'; password: string };

class RegisterStepError extends Error {
  status?: number;
  /**
   * #4470: the API's stable machine code for a rejected proof
   * (`mfa_proof_invalid`, `invalid_credentials`, ...). Carried through so the
   * UI can branch on it instead of string-matching the human message, which
   * was the only discriminator available while every rejection was a 401.
   */
  code?: string;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function jsonOrThrow(response: Response, fallback: string): Promise<any> {
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new RegisterStepError(
      data?.error ?? fallback,
      response.status,
      typeof data?.code === 'string' ? data.code : undefined,
    );
  }
  // A 2xx with an unparseable body (empty body, truncated proxy response) must
  // not silently resolve to `null` — every caller immediately reads a field
  // off the result (e.g. `data.registerGrantId`), which would throw a raw
  // TypeError deep in the ceremony instead of surfacing a clean, catchable
  // RegisterStepError the UI can map to a toast.
  try {
    return await response.json();
  } catch {
    throw new RegisterStepError('Unexpected server response.');
  }
}

/**
 * Mint a single-use register_approver_device grant with whichever re-auth
 * factor the caller proved (#2707 — spec: strongest available factor; the
 * password endpoint 403s `stronger_factor_required` if TOTP/passkey exist).
 */
async function mintRegisterGrant(reauth: RegisterReauth): Promise<string> {
  if (reauth.method === 'password') {
    const data = await jsonOrThrow(
      await fetchWithAuth('/authenticator/register-grant', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: reauth.password }),
        // A 401 here means "wrong password", not "stale access token" — unlike
        // most fetchWithAuth callers, replaying after a token refresh would
        // just resubmit the same bad password and fail again. Same rationale
        // as the single-use webauthn assertion in intentApprovals.ts.
        skipUnauthorizedRetry: true,
      }),
      'Verification failed.'
    );
    if (!data?.registerGrantId) throw new RegisterStepError('Verification failed.');
    return data.registerGrantId;
  }

  let stepUpBody: Record<string, unknown>;
  if (reauth.method === 'totp') {
    stepUpBody = { method: 'totp', code: reauth.code, operation: 'register_approver_device' };
  } else {
    // Passkey: fetch an authenticated step-up challenge, run the assertion
    // ceremony, then prove it to /auth/mfa/step-up.
    const challengeData = await jsonOrThrow(
      await fetchWithAuth('/auth/mfa/step-up/options', { method: 'POST' }),
      'Could not start passkey verification.'
    );
    const optionsJSON: PublicKeyCredentialRequestOptionsJSON =
      challengeData.options ?? challengeData.optionsJSON ?? challengeData;
    const credential = await startAuthentication({ optionsJSON });
    stepUpBody = { method: 'passkey', credential, operation: 'register_approver_device' };
  }

  const data = await jsonOrThrow(
    await fetchWithAuth('/auth/mfa/step-up', {
      method: 'POST',
      body: JSON.stringify(stepUpBody),
      // #4470: no opt-out here any more. A rejected proof is now 400
      // `mfa_proof_invalid`, and the handler has no 401 path left at all — so
      // every 401 from this endpoint comes from `authMiddleware`, BEFORE the
      // handler runs. The passkey assertion in this body is therefore still
      // unburned, and refreshing the bearer and replaying it is exactly right.
      // Keeping the flag would instead have signed the user out for an access
      // token that simply aged out mid-ceremony.
    }),
    'Verification failed.'
  );
  if (!data?.stepUpGrantId) throw new RegisterStepError('Verification failed.');
  // The step-up endpoint names it stepUpGrantId; the register routes take it
  // as registerGrantId — same value, different field name.
  return data.stepUpGrantId;
}

/**
 * Register the current browser/platform authenticator as an approver device.
 * re-auth mint → options (validates the grant) → Windows Hello / Touch ID
 * registration ceremony → verify (consumes the grant).
 */
export async function registerApproverDevice(label: string, reauth: RegisterReauth): Promise<void> {
  const registerGrantId = await mintRegisterGrant(reauth);

  const optionsData = await jsonOrThrow(
    await fetchWithAuth('/authenticator/devices/webauthn/options', {
      method: 'POST',
      body: JSON.stringify({ registerGrantId }),
    }),
    'Failed to start device registration.'
  );
  const optionsJSON: PublicKeyCredentialCreationOptionsJSON =
    optionsData.options ?? optionsData.optionsJSON ?? optionsData;

  const response = await startRegistration({ optionsJSON });

  await jsonOrThrow(
    await fetchWithAuth('/authenticator/devices/webauthn/verify', {
      method: 'POST',
      body: JSON.stringify({ registerGrantId, label, response }),
    }),
    'Device registration failed.'
  );
}

/** List the caller's active approver devices. */
export async function listApproverDevices(): Promise<ApproverDevice[]> {
  const response = await fetchWithAuth('/me/approver-devices');
  // Throw on a server error so the caller shows its retry/error state rather
  // than rendering an empty list (fetchWithAuth doesn't throw on non-2xx).
  if (!response.ok) throw new Error('Failed to load approver devices.');
  // The route returns `{ devices: [...] }` (GET /me/approver-devices). Unwrap
  // it; tolerate a bare array for forward-compat.
  const data = await response.json();
  return Array.isArray(data) ? data : (data?.devices ?? []);
}

/** Revoke (disable) one of the caller's approver devices. */
export async function revokeApproverDevice(id: string): Promise<Response> {
  return fetchWithAuth(`/me/approver-devices/${id}/revoke`, { method: 'POST' });
}

/** Rename one of the caller's approver devices. */
export async function renameApproverDevice(id: string, label: string): Promise<Response> {
  return fetchWithAuth(`/me/approver-devices/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ label }),
  });
}

/**
 * A challenge the server REFUSED, carrying the machine token it answered with
 * (`batch_not_homogeneous`, `step_up_required`, …) alongside the status.
 *
 * The batch challenge route re-validates the whole set before minting anything,
 * so the 422 a raced set produces arrives here rather than at the decide call —
 * without the token the caller could only report a generic "verification
 * failed" and the approver would never learn the set had drifted. `message` is
 * unchanged from the pre-existing plain `Error`, so the single-card callers see
 * exactly what they always did.
 */
export class AssertionChallengeError extends Error {
  status: number;
  token?: string;
  /** Issue #4459 — the `offending` approval-request ids the server's
   *  `batch_not_homogeneous` 422 carries (`loadHomogeneousBatch`,
   *  `services/approvals/batchDecide.ts`). The challenge route re-validates
   *  the whole set BEFORE minting anything, so on an APPROVE this is where a
   *  drifted set is usually refused — the later `/batch/decide` 422 is only
   *  reached on a DENY (which skips the challenge/proof round-trip
   *  entirely). Without carrying this through, only the deny path could ever
   *  tell the inbox which cards to deselect. */
  offending?: string[];
  constructor(message: string, status: number, token?: string, offending?: string[]) {
    super(message);
    this.name = 'AssertionChallengeError';
    this.status = status;
    this.token = token;
    this.offending = offending;
  }
}

/**
 * Everything after the challenge POST: validate the body, detect the
 * device-less case, run the WebAuthn ceremony, shape the proof.
 *
 * Shared by the single-card and batch entry points so the two can never drift —
 * a batch that skipped, say, the `NoApproverDeviceError` branch would fire a
 * Windows Hello prompt the technician cannot satisfy, and one that skipped the
 * malformed-2xx guard would tell a user who HAS a registered authenticator to
 * go register one.
 */
async function completeAssertionCeremony(
  challengeResponse: Response,
): Promise<AssertionProof> {
  const challengeData = await challengeResponse.json().catch(() => null);
  // A genuine server error (500/404/403) must surface as a REAL error — NOT be
  // misclassified as the device-less case below (which would silently downgrade
  // a real outage to an L1 approval). Only a 2xx with no allowCredentials is the
  // benign "no registered device" fallback. (fetchWithAuth doesn't throw on non-2xx.)
  if (!challengeResponse.ok) {
    const token = typeof challengeData?.error === 'string' ? challengeData.error : undefined;
    const offending = Array.isArray(challengeData?.offending)
      ? challengeData.offending.filter((id: unknown): id is string => typeof id === 'string')
      : undefined;
    throw new AssertionChallengeError(
      token ?? `Could not start verification (${challengeResponse.status}).`,
      challengeResponse.status,
      token,
      offending,
    );
  }
  // A 2xx whose body isn't a usable challenge (empty body, truncated proxy
  // response, a future field rename) must NOT fall through to the device-less
  // branch below — that would tell a user who HAS a registered authenticator to
  // go register one, and in PamRespondModal it silently downgrades the approve
  // to a proofless L1. Require the device-less case to be explicit: a real
  // options object carrying a `challenge`, whose allowCredentials is empty.
  const optionsJSON: PublicKeyCredentialRequestOptionsJSON | null =
    challengeData && typeof challengeData === 'object'
      ? (challengeData.options ?? challengeData.optionsJSON ?? challengeData)
      : null;
  if (
    !optionsJSON ||
    typeof optionsJSON !== 'object' ||
    typeof optionsJSON.challenge !== 'string' ||
    optionsJSON.challenge.length === 0
  ) {
    throw new Error('Could not start verification: the server returned an unusable challenge.');
  }

  // No registered approver device → the challenge carries no allowCredentials.
  // Signal this distinctly (name='NoApproverDeviceError') BEFORE the ceremony so
  // callers can fall back to an L1 (session-tap) approval instead of firing a
  // Windows Hello prompt the technician can't satisfy. Thrown before
  // startAuthentication, so it can never be confused with a ceremony failure
  // (which callers treat as a genuine cancel/abort). P2 is opt-in, not required
  // (enforcement is Phase 4).
  if (!optionsJSON.allowCredentials || optionsJSON.allowCredentials.length === 0) {
    const err = new Error('No registered approver device');
    err.name = 'NoApproverDeviceError';
    throw err;
  }

  const response = await startAuthentication({ optionsJSON });

  return {
    type: 'webauthn_platform',
    credentialId: response.id,
    authenticatorData: response.response.authenticatorData,
    clientDataJSON: response.response.clientDataJSON,
    signature: response.response.signature,
    userHandle: response.response.userHandle ?? null,
  };
}

/**
 * Run the approval-scoped assertion ceremony and return the proof body to attach
 * to an approve call. `basePath` is the decide resource — e.g. `/approvals` or
 * `/pam/elevation-requests`. challenge → Windows Hello → assertion proof.
 */
export async function getApprovalAssertion(basePath: string, id: string): Promise<AssertionProof> {
  return completeAssertionCeremony(
    await fetchWithAuth(`${basePath}/${id}/assertion-challenge`, { method: 'POST' }),
  );
}

/**
 * P2-2 (#4189): ONE ceremony for a whole homogeneous set of supervised,
 * agent-originated cards — a scheduled sweep fans one card out per device, so
 * deciding a fleet-wide finding otherwise costs one Touch ID prompt per device.
 *
 * The challenge the server mints is bound to the exact set AND direction
 * (`batchAssertionKey` in `services/approvals/batchDecide.ts`), so the proof
 * this returns can only be spent on `decision` over `ids` — never replayed to
 * flip an approve into a deny, nor to sweep in a card that was not signed for.
 * `decision` therefore uses the SERVER's spelling (`approved`/`denied`), since
 * it is part of that binding rather than a UI label.
 *
 * The route re-validates homogeneity before minting, so a set that has drifted
 * (a row decided elsewhere, an org moved) rejects here with 422
 * `batch_not_homogeneous` — surfaced as an `AssertionChallengeError` carrying
 * that token so the caller can say so precisely.
 */
export async function getBatchApprovalAssertion(
  basePath: string,
  ids: string[],
  decision: 'approved' | 'denied',
): Promise<AssertionProof> {
  return completeAssertionCeremony(
    await fetchWithAuth(`${basePath}/batch/assertion-challenge`, {
      method: 'POST',
      body: JSON.stringify({ approvalRequestIds: ids, decision }),
    }),
  );
}
