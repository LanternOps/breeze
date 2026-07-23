import { useTranslation } from 'react-i18next';

export type ReauthTier = 'passkey' | 'totp' | 'password';

/** Strongest-available-factor tiering — mirrors the server gate
 * (`userHasStrongerReauthFactor`): passkey → TOTP → password. SMS-method
 * accounts fall to password (no authenticated step-up SMS sender; spec #2707). */
export function pickReauthTier(passkeyCount: number, mfaMethod: string | null): ReauthTier {
  if (passkeyCount > 0) return 'passkey';
  if (mfaMethod === 'totp') return 'totp';
  return 'password';
}

type Props = {
  tier: ReauthTier;
  reauthValue: string;
  onChange: (value: string) => void;
  disabled: boolean;
  /**
   * DOM id / data-testid prefix. Both the Approvals card and the Passkeys card
   * render this component on the same page, so each consumer needs a distinct
   * prefix to keep ids unique. Defaults to the original approver ids.
   */
  idPrefix?: string;
};

/**
 * Re-auth input proving an existing factor before a sensitive registration.
 * Consumer: SecurityDevicesCard's add-passkey flow (add_factor grant, and the
 * register_approver_device grant for its dual-enroll checkbox).
 */
export default function StepUpPrompt({ tier, reauthValue, onChange, disabled, idPrefix = 'approver-stepup' }: Props) {
  const { t } = useTranslation('settings');

  if (tier === 'passkey') {
    return (
      <p className="text-xs text-muted-foreground" data-testid={`${idPrefix}-passkey-note`}>
        {t('stepUpPrompt.youWillConfirmWithYourPasskey')}
      </p>
    );
  }

  if (tier === 'totp') {
    return (
      <div className="space-y-2">
        <label className="text-sm font-medium" htmlFor={`${idPrefix}-code`}>
          {t('stepUpPrompt.authenticatorCode')}
        </label>
        <input
          id={`${idPrefix}-code`}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={reauthValue}
          onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          disabled={disabled}
          data-testid={`${idPrefix}-code`}
        />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium" htmlFor={`${idPrefix}-password`}>
        {t('stepUpPrompt.confirmYourPassword')}
      </label>
      <input
        id={`${idPrefix}-password`}
        type="password"
        autoComplete="current-password"
        value={reauthValue}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 w-full rounded-md border bg-background px-3 text-sm"
        disabled={disabled}
        data-testid={`${idPrefix}-password`}
      />
    </div>
  );
}
