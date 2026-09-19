import type { ClipboardEvent, FormEvent, KeyboardEvent } from 'react';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

const DIGIT_COUNT = 6;

type MFASetupFormProps = {
  qrCodeDataUrl?: string;
  /**
   * #5319: the base32 TOTP secret returned alongside the QR image. Forced MFA
   * enrollment is mandatory, so a QR-only screen locks out anyone enrolling on
   * this same device or using a screen reader.
   */
  totpSecret?: string;
  onSubmit?: (code: string) => void | Promise<void>;
  errorMessage?: string;
  submitLabel?: string;
  loading?: boolean;
};

export default function MFASetupForm({
  qrCodeDataUrl,
  totpSecret,
  onSubmit,
  errorMessage,
  submitLabel,
  loading
}: MFASetupFormProps) {
  const { t } = useTranslation('auth');
  const [digits, setDigits] = useState<string[]>(Array(DIGIT_COUNT).fill(''));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [secretCopyState, setSecretCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);

  const isLoading = useMemo(() => loading ?? isSubmitting, [loading, isSubmitting]);
  // Authenticator apps take the key unspaced; humans read it in groups of four.
  const normalizedSecret = totpSecret?.replace(/\s+/g, '').toUpperCase() || undefined;
  const groupedSecret = normalizedSecret
    ? (normalizedSecret.match(/.{1,4}/g) ?? []).join(' ')
    : undefined;

  // A denied clipboard (insecure context, permissions policy, missing gesture)
  // must say so — this is the only place the key is ever shown.
  const handleCopySecret = async () => {
    if (!normalizedSecret) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(normalizedSecret);
      setSecretCopyState('copied');
      window.setTimeout(() => setSecretCopyState(state => (state === 'copied' ? 'idle' : state)), 2000);
    } catch {
      setSecretCopyState('failed');
    }
  };
  const code = digits.join('');

  const focusIndex = (index: number) => {
    inputRefs.current[index]?.focus();
    inputRefs.current[index]?.select();
  };

  const setDigitAt = (index: number, value: string) => {
    const nextDigits = [...digits];
    nextDigits[index] = value;
    setDigits(nextDigits);
  };

  const handleChange = (index: number, value: string) => {
    const sanitized = value.replace(/\D/g, '');
    if (!sanitized) {
      setDigitAt(index, '');
      return;
    }

    const nextDigits = [...digits];
    const split = sanitized.slice(0, DIGIT_COUNT - index).split('');
    split.forEach((digit, offset) => {
      nextDigits[index + offset] = digit;
    });
    setDigits(nextDigits);
    const nextIndex = Math.min(index + split.length, DIGIT_COUNT - 1);
    focusIndex(nextIndex);
  };

  const handleKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace' && digits[index] === '' && index > 0) {
      setDigitAt(index - 1, '');
      focusIndex(index - 1);
    }
  };

  const handlePaste = (index: number, event: ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    handleChange(index, event.clipboardData.getData('text'));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isLoading || code.length !== DIGIT_COUNT) {
      return;
    }
    try {
      setIsSubmitting(true);
      await onSubmit?.(code);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-6 rounded-lg border bg-card p-6 shadow-xs"
    >
      <div className="space-y-3">
        <h2 className="text-lg font-semibold">{t('mfaSetup.title', { defaultValue: 'Set up multi-factor authentication' })}</h2>
        <p className="text-sm text-muted-foreground">
          {t('mfaSetup.description', {
            defaultValue: 'Scan this QR code with your authenticator app, then enter the 6-digit code.',
          })}
        </p>
        <div className="flex items-center justify-center rounded-md border bg-muted p-4">
          {qrCodeDataUrl ? (
            <img
              src={qrCodeDataUrl}
              alt={t('mfaSetup.qrAlt', { defaultValue: 'Authenticator QR code' })}
              className="h-48 w-48"
            />
          ) : (
            <div className="flex h-48 w-48 items-center justify-center text-sm text-muted-foreground">
              {t('mfaSetup.qrUnavailable', { defaultValue: 'QR code unavailable' })}
            </div>
          )}
        </div>
        {groupedSecret && (
          <div className="space-y-2 rounded-md border bg-muted/30 p-4">
            <p className="text-sm font-medium">
              {t('mfaSetup.manualKeyPrompt', { defaultValue: "Can't scan the code?" })}
            </p>
            <p className="text-sm text-muted-foreground">
              {t('mfaSetup.manualKeyHelp', {
                defaultValue: 'Enter this setup key in your authenticator app instead.',
              })}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              {/* sr-only SIBLING, not an aria-label: an accessible name would
                  replace the key's text for a screen reader. */}
              <span>
                <span className="sr-only">
                  {t('mfaSetup.manualKeyLabel', { defaultValue: 'Setup key' })}
                </span>
                <code
                  data-testid="mfa-totp-secret"
                  className="rounded-sm bg-background px-2 py-1 font-mono text-sm tracking-wider break-all select-all"
                >
                  {groupedSecret}
                </code>
              </span>
              <button
                type="button"
                data-testid="mfa-copy-totp-secret"
                onClick={handleCopySecret}
                className="inline-flex h-9 items-center justify-center rounded-md border px-3 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                {secretCopyState === 'copied'
                  ? t('mfaSetup.manualKeyCopied', { defaultValue: 'Copied' })
                  : t('mfaSetup.manualKeyCopy', { defaultValue: 'Copy setup key' })}
              </button>
            </div>
            {secretCopyState === 'failed' && (
              <p
                data-testid="mfa-copy-totp-secret-error"
                role="alert"
                className="text-sm text-destructive"
              >
                {t('mfaSetup.manualKeyCopyFailed', {
                  defaultValue: "Couldn't copy the setup key. Select it and copy it manually.",
                })}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">{t('fields.verificationCode', { defaultValue: 'Verification code' })}</label>
        <div className="flex items-center gap-2">
          {digits.map((digit, index) => (
            <input
              key={`mfa-digit-${index}`}
              ref={element => {
                inputRefs.current[index] = element;
              }}
              autoFocus={index === 0}
              inputMode="numeric"
              autoComplete={index === 0 ? 'one-time-code' : 'off'}
              className="h-11 w-11 rounded-md border bg-background text-center text-lg tracking-widest focus:outline-hidden focus:ring-2 focus:ring-ring"
              maxLength={1}
              value={digit}
              onChange={event => handleChange(index, event.target.value)}
              onKeyDown={event => handleKeyDown(index, event)}
              onPaste={event => handlePaste(index, event)}
              disabled={isLoading}
            />
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {t('mfaSetup.codeHelp', { defaultValue: 'Enter the 6-digit code generated by your authenticator app.' })}
        </p>
      </div>

      {errorMessage && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {errorMessage}
        </div>
      )}

      <button
        type="submit"
        disabled={isLoading || code.length !== DIGIT_COUNT}
        className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isLoading ? t('common.verifying', { defaultValue: 'Verifying...' }) : submitLabel ?? t('mfaSetup.submit', { defaultValue: 'Verify and enable' })}
      </button>
    </form>
  );
}
