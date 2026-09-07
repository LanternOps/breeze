/**
 * Copy for the approver-device setup banner.
 *
 * The banner this feeds used to say "This device isn't set up for biometric
 * approval", which reads as "turn on Face ID" — the one action that cannot
 * possibly fix it. The banner is about this phone's approver key not being
 * REGISTERED WITH THE SERVER; iOS biometric enrolment is unrelated, and toggling
 * it changes nothing. Copy here must stay honest about that.
 *
 * The only in-app remedy today is a fresh sign-in, because registration needs a
 * `register_approver_device` grant that is minted at login and is single-use
 * (see `services/approverDevice.ts`). A password / step-up re-mint via
 * `POST /api/v1/authenticator/register-grant` would allow retry without signing
 * out, but that endpoint 403s for accounts holding TOTP or a passkey, so it
 * needs its own step-up flow — tracked separately, not wired here.
 */

export type ApproverBannerSeverity = 'failed' | 'deferred';

export interface ApproverBannerCopy {
  title: string;
  body: string;
  /** Short technical cause, shown small. Null when we have nothing useful. */
  detail: string | null;
  actionLabel: string;
}

/**
 * Turn an `ApproverRegistrationOutcome.reason` into something a technician can
 * act on or quote in a support ticket. Unknown codes are passed through rather
 * than swallowed — an opaque code the user can report beats no information.
 */
export function describeApproverReason(reason: string | null): string | null {
  if (!reason) return null;
  if (reason === 'no_reauth_grant') return null; // expected for a restored session
  if (reason === 'missing_device_id') return 'The server accepted the key but returned no device id.';
  // #1374 W05 — attestation reasons. None of these is fixed by signing in again:
  // a fresh grant re-runs the identical attestation against the identical
  // device and server. Say so, or the banner's remedy sends the user in a loop.
  if (reason === 'attestation_failed') {
    return 'This phone supports hardware attestation but could not complete it, so it was not registered. Signing in again will not change this — contact your administrator.';
  }
  if (reason === 'attestation_probe_failed') {
    return 'This phone could not determine whether it supports hardware attestation, so it was not registered. Signing in again will not change this — contact your administrator.';
  }
  if (reason === 'attestation_rejected_by_server') {
    return 'This phone is registered, but the server did not accept its hardware attestation, so critical approvals are unavailable from it. Signing in again will not change this — contact your administrator.';
  }
  if (reason === 'http_401' || reason === 'http_403') {
    return 'The server rejected this phone’s one-time registration grant (it expires a few minutes after sign-in).';
  }
  if (reason.startsWith('http_5')) return 'The server was unavailable during setup.';
  if (reason.startsWith('http_')) return `The server refused registration (${reason.slice(5)}).`;
  if (reason.startsWith('exception:')) return `Setup failed on this device (${reason.slice(10)}).`;
  return reason;
}

export function approverBannerCopy(
  severity: ApproverBannerSeverity,
  reason: string | null
): ApproverBannerCopy {
  const detail = describeApproverReason(reason);

  if (severity === 'deferred') {
    return {
      title: 'Finish approver setup',
      body:
        'Sign in again to let this phone sign approvals with Face ID. Until then approvals from this device are recorded at the lowest assurance level.',
      detail,
      actionLabel: 'Sign out and back in',
    };
  }

  return {
    title: 'Approver setup didn’t complete',
    body:
      'This phone couldn’t register its approval key with the server, so approvals from it are recorded at the lowest assurance level. This is not about Face ID being switched on — signing in again is what re-issues the setup grant.',
    detail,
    actionLabel: 'Sign out and back in',
  };
}
