import type { ClipboardEvent, FormEvent, KeyboardEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MfaMethod } from '../../stores/auth';

const DIGIT_COUNT = 6;

type MFAVerifyFormProps = {
  onSubmit?: (code: string) => void | Promise<void>;
  onPasskeyVerify?: () => void | Promise<void>;
  errorMessage?: string;
  submitLabel?: string;
  loading?: boolean;
  mfaMethod?: MfaMethod;
  methods?: MfaMethod[];
  onMethodChange?: (method: MfaMethod) => void;
  /**
   * #2153: true when the account has a passkey registered as an ALTERNATE
   * second factor while the primary method is totp/sms. Surfaces a "use a
   * passkey instead" affordance without changing the primary prompt.
   */
  passkeyAvailable?: boolean;
  phoneLast4?: string;
  onSendSmsCode?: () => Promise<boolean | void>;
  smsSending?: boolean;
  smsSent?: boolean;
};

export default function MFAVerifyForm({
  onSubmit,
  onPasskeyVerify,
  errorMessage,
  submitLabel,
  loading,
  mfaMethod = 'totp',
  methods = [mfaMethod],
  onMethodChange,
  passkeyAvailable = false,
  phoneLast4,
  onSendSmsCode,
  smsSending,
  smsSent
}: MFAVerifyFormProps) {
  const { t } = useTranslation('auth');
  const [digits, setDigits] = useState<string[]>(Array(DIGIT_COUNT).fill(''));
  const [recoveryCode, setRecoveryCode] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const smsAutoSent = useRef(false);

  const isLoading = useMemo(() => loading ?? isSubmitting, [loading, isSubmitting]);
  const code = digits.join('');
  const isSms = mfaMethod === 'sms';
  const isPasskey = mfaMethod === 'passkey';
  const isRecovery = mfaMethod === 'recovery';
  // #2153: offer the passkey as an alternate factor when the primary method is
  // the code-based totp/sms flow but the account also has a passkey.
  const showPasskeyAlternate = !isPasskey && passkeyAvailable && Boolean(onPasskeyVerify);

  // Resend cooldown timer
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setTimeout(() => setResendCooldown(resendCooldown - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCooldown]);

  useEffect(() => {
    if (!isSms) {
      smsAutoSent.current = false;
      return;
    }
    if (smsSent || smsSending || smsAutoSent.current || !onSendSmsCode) return;
    smsAutoSent.current = true;
    void onSendSmsCode().then((sent) => {
      if (sent !== false) setResendCooldown(60);
      else smsAutoSent.current = false;
    });
  }, [isSms, onSendSmsCode, smsSending, smsSent]);

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
    const submittedCode = isRecovery ? recoveryCode.trim() : code;
    if (isLoading || (isRecovery ? submittedCode.length === 0 : submittedCode.length !== DIGIT_COUNT)) {
      return;
    }
    try {
      setIsSubmitting(true);
      await onSubmit?.(submittedCode);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSendSms = async () => {
    if (smsSending || resendCooldown > 0) return;
    const sent = await onSendSmsCode?.();
    if (sent !== false) setResendCooldown(60);
  };

  const handlePasskeyVerify = async () => {
    if (isLoading) return;
    try {
      setIsSubmitting(true);
      await onPasskeyVerify?.();
    } finally {
      setIsSubmitting(false);
    }
  };

  const methodSelector = methods.length > 1 ? (
    <label className="block space-y-2 text-sm font-medium">
      <span>{t('mfaVerify.method.label', { defaultValue: 'Verification method' })}</span>
      <select
        data-testid="mfa-method-select"
        value={mfaMethod}
        onChange={(event) => onMethodChange?.(event.target.value as MfaMethod)}
        disabled={isLoading}
        className="h-11 w-full rounded-md border bg-background px-3"
      >
        {methods.map((method) => (
          <option key={method} value={method}>
            {{ totp: 'Authenticator app', sms: 'Text message', passkey: 'Passkey', recovery: 'Recovery code' }[method]}
          </option>
        ))}
      </select>
    </label>
  ) : null;

  if (isPasskey) {
    return (
      <div className="space-y-6">
        {methodSelector}
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">{t('mfaVerify.passkey.title', { defaultValue: 'Use your passkey' })}</h2>
          <p className="text-sm text-muted-foreground">
            {t('mfaVerify.passkey.description', { defaultValue: 'Continue with the passkey registered to your account.' })}
          </p>
        </div>

        {errorMessage && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {errorMessage}
          </div>
        )}

        <button
          type="button"
          data-testid="mfa-passkey-submit"
          onClick={handlePasskeyVerify}
          disabled={isLoading}
          className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isLoading ? t('common.verifying', { defaultValue: 'Verifying...' }) : submitLabel ?? t('mfaVerify.submit', { defaultValue: 'Verify' })}
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-6"
    >
      {methodSelector}
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">{t('mfaVerify.code.title', { defaultValue: 'Enter your verification code' })}</h2>
        <p className="text-sm text-muted-foreground">
          {isRecovery
            ? t('mfaVerify.recovery.description', { defaultValue: 'Enter one of your recovery codes.' })
            : isSms
            ? smsSent
              ? t('mfaVerify.sms.sentDescription', {
                  defaultValue: `Enter the 6-digit code sent to your phone ending in ${phoneLast4 || '****'}.`,
                  phoneLast4: phoneLast4 || '****',
                })
              : t('mfaVerify.sms.readyDescription', {
                  defaultValue: `We'll send a code to your phone ending in ${phoneLast4 || '****'}.`,
                  phoneLast4: phoneLast4 || '****',
                })
            : t('mfaVerify.totp.description', {
                defaultValue: 'Use your authenticator app to get the 6-digit code.',
              })}
        </p>
      </div>

      {isSms && !smsSent && (
        <button
          type="button"
          onClick={handleSendSms}
          disabled={smsSending || resendCooldown > 0}
          className="flex h-11 w-full items-center justify-center rounded-md border bg-muted text-sm font-medium transition hover:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {smsSending ? t('mfaVerify.sms.sending', { defaultValue: 'Sending...' }) : t('mfaVerify.sms.sendCode', { defaultValue: 'Send code' })}
        </button>
      )}

      {isRecovery && (
        <div className="space-y-2">
          <label htmlFor="mfa-recovery-code" className="text-sm font-medium">
            {t('mfaVerify.recovery.label', { defaultValue: 'Recovery code' })}
          </label>
          <input
            id="mfa-recovery-code"
            data-testid="mfa-recovery-code"
            type="text"
            autoComplete="one-time-code"
            value={recoveryCode}
            onChange={(event) => setRecoveryCode(event.target.value)}
            disabled={isLoading}
            className="h-11 w-full rounded-md border bg-background px-3 font-mono uppercase"
          />
        </div>
      )}

      {!isRecovery && (!isSms || smsSent) && (
        <>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('fields.verificationCode', { defaultValue: 'Verification code' })}</label>
            <div className="flex items-center gap-2">
              {digits.map((digit, index) => (
                <input
                  key={`mfa-verify-digit-${index}`}
                  data-testid={`mfa-digit-${index}`}
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
              {isSms
                ? t('mfaVerify.sms.recoveryHelp', {
                    defaultValue: 'If you lose access to your phone, use a recovery code.',
                  })
                : t('mfaVerify.totp.recoveryHelp', {
                    defaultValue: 'If you lose access to your device, use a recovery code.',
                  })}
            </p>
          </div>

          {isSms && (
            <button
              type="button"
              onClick={handleSendSms}
              disabled={smsSending || resendCooldown > 0}
              className="text-sm text-muted-foreground underline hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              {resendCooldown > 0
                ? t('mfaVerify.sms.resendCooldown', {
                    defaultValue: `Resend code (${resendCooldown}s)`,
                    seconds: resendCooldown,
                  })
                : smsSending
                  ? t('mfaVerify.sms.sending', { defaultValue: 'Sending...' })
                  : t('mfaVerify.sms.resendCode', { defaultValue: 'Resend code' })}
            </button>
          )}
        </>
      )}

      {errorMessage && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {errorMessage}
        </div>
      )}

      {(isRecovery || !isSms || smsSent) && (
        <button
          type="submit"
          data-testid="mfa-submit"
          disabled={isLoading || (isRecovery ? recoveryCode.trim().length === 0 : code.length !== DIGIT_COUNT)}
          className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isLoading ? t('common.verifying', { defaultValue: 'Verifying...' }) : submitLabel ?? t('mfaVerify.submit', { defaultValue: 'Verify' })}
        </button>
      )}

      {showPasskeyAlternate && (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <span className="h-px flex-1 bg-border" />
            <span className="text-xs uppercase tracking-wide text-muted-foreground">{t('common.or', { defaultValue: 'or' })}</span>
            <span className="h-px flex-1 bg-border" />
          </div>
          <button
            type="button"
            data-testid="mfa-passkey-alternate"
            onClick={handlePasskeyVerify}
            disabled={isLoading}
            className="flex h-11 w-full items-center justify-center rounded-md border text-sm font-medium transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t('mfaVerify.passkey.useInstead', { defaultValue: 'Use a passkey instead' })}
          </button>
        </div>
      )}
    </form>
  );
}
