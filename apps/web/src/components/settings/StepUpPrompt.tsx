import { useTranslation } from 'react-i18next';

export type ReauthTier = 'passkey' | 'totp' | 'password';

/** Strongest-available-factor tiering — mirrors the server gate
 * (`userHasStrongerReauthFactor`): passkey → TOTP → password. SMS-method
 * accounts fall to password (no authenticated step-up SMS sender; spec #2707).
 *
 * #10650: `totpEnrolled` (from `GET /users/me`) is true for an authenticator
 * app held as the primary OR as the backup beside a primary passkey. Only an
 * explicit `true` counts: `undefined` (a session from before the field) is
 * treated as "not enrolled", the fail-safe direction — no new option is
 * offered, and the server stays authoritative either way. */
export function pickReauthTier(
  passkeyCount: number,
  mfaMethod: string | null,
  totpEnrolled?: boolean,
): ReauthTier {
  if (passkeyCount > 0) return 'passkey';
  if (mfaMethod === 'totp' || totpEnrolled === true) return 'totp';
  return 'password';
}

/** #9007: the tiers approver-device registration can be proved with.
 *
 * `sso` is NOT a {@link ReauthTier}: only `POST /authenticator/register-grant`
 * accepts an SSO re-auth grant (exchanged once for a `register_approver_device`
 * grant). Every other step-up endpoint takes a password, TOTP code or passkey,
 * so keeping `sso` out of the shared union stops a caller from offering a proof
 * its endpoint would refuse. */
export type RegisterReauthTier = ReauthTier | 'sso';

/** #9007: {@link pickReauthTier} plus the server's passwordless road. An
 * account with no password (SSO-provisioned) and no passkey or TOTP proves
 * itself with a fresh IdP re-auth instead of a password it does not have.
 *
 * It never outranks a stronger factor, mirroring the server: register-grant
 * 403s `stronger_factor_required` before either proof is read. Only an
 * explicit `hasPassword === false` selects it; `undefined` (unknown, e.g. a
 * session from before the field) keeps the password road, the same fail-safe
 * as the profile page's Change-password gate. SMS-only falls through to `sso`
 * for the same reason it falls to `password` in the shared picker. */
export function pickRegisterReauthTier(
  passkeyCount: number,
  mfaMethod: string | null,
  totpEnrolled?: boolean,
  hasPassword?: boolean,
): RegisterReauthTier {
  const tier = pickReauthTier(passkeyCount, mfaMethod, totpEnrolled);
  return tier === 'password' && hasPassword === false ? 'sso' : tier;
}

/** #10650: the proof a step-up prompt offers as "Use authenticator app
 * instead" beside the passkey. A user who lost the passkey and signed in with
 * the authenticator would otherwise be stranded on a passkey-only prompt. */
export function alternateReauthTier(
  passkeyCount: number,
  mfaMethod: string | null,
  totpEnrolled?: boolean,
): ReauthTier | null {
  return pickReauthTier(passkeyCount, mfaMethod, totpEnrolled) === 'passkey' && totpEnrolled === true
    ? 'totp'
    : null;
}

type Props = {
  tier: RegisterReauthTier;
  reauthValue: string;
  onChange: (value: string) => void;
  disabled: boolean;
  /** #9007: the IdP round-trip, used only when `tier === 'sso'`. `verified`
   * means a re-auth grant is in hand; `onStart` leaves for the IdP (absent =
   * no way to start one here, so the button is disabled). */
  sso?: { verified: boolean; starting: boolean; onStart?: () => void };
};

/**
 * Re-auth input for approver-device registration. Reusable: ProfilePage's
 * add-passkey flow (currently dead-ends for MFA-protected users on
 * existing_factor_step_up_required) is the intended second consumer —
 * tracked as a PR #2710 follow-up, not yet wired up.
 */
export default function StepUpPrompt({ tier, reauthValue, onChange, disabled, sso }: Props) {
  const { t } = useTranslation('settings');

  if (tier === 'sso') {
    if (sso?.verified) {
      return (
        // role="status": this appears on the return from the IdP while focus
        // lands on Register, so announce that verification succeeded.
        <p role="status" className="text-xs text-muted-foreground" data-testid="approver-stepup-sso-verified">
          {t('stepUpPrompt.ssoVerified')}
        </p>
      );
    }
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">{t('stepUpPrompt.ssoVerifyFirst')}</p>
        <button
          type="button"
          onClick={() => sso?.onStart?.()}
          disabled={disabled || !sso?.onStart || sso.starting}
          data-testid="approver-stepup-sso-start"
          className="inline-flex h-10 items-center justify-center rounded-md border px-4 text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
        >
          {t('stepUpPrompt.ssoVerifyButton')}
        </button>
      </div>
    );
  }

  if (tier === 'passkey') {
    return (
      <p className="text-xs text-muted-foreground" data-testid="approver-stepup-passkey-note">
        {t('stepUpPrompt.youWillConfirmWithYourPasskey')}
      </p>
    );
  }

  if (tier === 'totp') {
    return (
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor="approver-stepup-code">
          {t('stepUpPrompt.authenticatorCode')}
        </label>
        <input
          id="approver-stepup-code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={reauthValue}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          disabled={disabled}
          data-testid="approver-stepup-code"
        />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium" htmlFor="approver-stepup-password">
        {t('stepUpPrompt.confirmYourPassword')}
      </label>
      <input
        id="approver-stepup-password"
        type="password"
        autoComplete="current-password"
        value={reauthValue}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 w-full rounded-md border bg-background px-3 text-sm"
        disabled={disabled}
        data-testid="approver-stepup-password"
      />
    </div>
  );
}
