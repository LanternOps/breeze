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
  createdAt: string;
  lastUsedAt: string | null;
  // The list endpoint already filters to active devices server-side, so the DTO
  // omits this; kept optional for callers that defensively filter.
  disabledAt?: string | null;
}

/**
 * Register the current browser/platform authenticator as an approver device.
 * options → Windows Hello / Touch ID registration ceremony → verify.
 */
export async function registerApproverDevice(label: string): Promise<void> {
  const optionsResponse = await fetchWithAuth('/authenticator/devices/webauthn/options', {
    method: 'POST',
  });
  const optionsData = await optionsResponse.json().catch(() => null);
  // fetchWithAuth does NOT throw on a non-2xx — guard explicitly so a failed
  // options/verify rejects and runAction surfaces an error toast instead of a
  // false success (CLAUDE.md no-silent-mutations).
  if (!optionsResponse.ok) {
    throw new Error(optionsData?.error ?? 'Failed to start device registration.');
  }
  const optionsJSON: PublicKeyCredentialCreationOptionsJSON =
    optionsData.options ?? optionsData.optionsJSON ?? optionsData;

  const response = await startRegistration({ optionsJSON });

  const verifyResponse = await fetchWithAuth('/authenticator/devices/webauthn/verify', {
    method: 'POST',
    body: JSON.stringify({ label, response }),
  });
  if (!verifyResponse.ok) {
    const verifyData = await verifyResponse.json().catch(() => null);
    throw new Error(verifyData?.error ?? 'Device registration failed.');
  }
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
 * Run the approval-scoped assertion ceremony and return the proof body to attach
 * to an approve call. `basePath` is the decide resource — e.g. `/approvals` or
 * `/pam/elevation-requests`. challenge → Windows Hello → assertion proof.
 */
export async function getApprovalAssertion(basePath: string, id: string): Promise<AssertionProof> {
  const challengeResponse = await fetchWithAuth(`${basePath}/${id}/assertion-challenge`, {
    method: 'POST',
  });
  const challengeData = await challengeResponse.json().catch(() => null);
  // A genuine server error (500/404/403) must surface as a REAL error — NOT be
  // misclassified as the device-less case below (which would silently downgrade
  // a real outage to an L1 approval). Only a 2xx with no allowCredentials is the
  // benign "no registered device" fallback. (fetchWithAuth doesn't throw on non-2xx.)
  if (!challengeResponse.ok) {
    throw new Error(challengeData?.error ?? `Could not start verification (${challengeResponse.status}).`);
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
