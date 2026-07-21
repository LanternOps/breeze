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
};

/**
 * Re-auth input for approver-device registration. Reusable: ProfilePage's
 * add-passkey flow (currently dead-ends for MFA-protected users on
 * existing_factor_step_up_required) is the intended second consumer.
 */
export default function StepUpPrompt({ tier, reauthValue, onChange, disabled }: Props) {
  const { t } = useTranslation('settings');

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
