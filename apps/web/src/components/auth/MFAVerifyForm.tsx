import type { ClipboardEvent, FormEvent, KeyboardEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MfaMethod } from '../../stores/auth';

const DIGIT_COUNT = 6;

type MFAVerifyFormProps = {
  onSubmit?: (code: string) => void | Promise<void>;
  errorMessage?: string;
  submitLabel?: string;
  loading?: boolean;
  mfaMethod?: MfaMethod;
  phoneLast4?: string;
  onSendSmsCode?: () => Promise<void>;
  smsSending?: boolean;
  smsSent?: boolean;
};

export default function MFAVerifyForm({
  onSubmit,
  errorMessage,
  submitLabel = 'Verify',
  loading,
  mfaMethod = 'totp',
  phoneLast4,
  onSendSmsCode,
  smsSending,
  smsSent
}: MFAVerifyFormProps) {
  const [digits, setDigits] = useState<string[]>(Array(DIGIT_COUNT).fill(''));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);

  const isLoading = useMemo(() => loading ?? isSubmitting, [loading, isSubmitting]);
  const code = digits.join('');
  const isSms = mfaMethod === 'sms';

  // Resend cooldown timer
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setTimeout(() => setResendCooldown(resendCooldown - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCooldown]);

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

  const handleSendSms = async () => {
    if (smsSending || resendCooldown > 0) return;
    await onSendSmsCode?.();
    setResendCooldown(60);
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-6 rounded-lg border bg-card p-6 shadow-sm"
    >
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Enter your verification code</h2>
        <p className="text-sm text-muted-foreground">
          {isSms
            ? smsSent
              ? `Enter the 6-digit code sent to your phone ending in ${phoneLast4 || '****'}.`
              : `We'll send a code to your phone ending in ${phoneLast4 || '****'}.`
            : 'Use your authenticator app to get the 6-digit code.'}
        </p>
      </div>

      {isSms && !smsSent && (
        <button
          type="button"
          onClick={handleSendSms}
          disabled={smsSending || resendCooldown > 0}
          className="flex h-11 w-full items-center justify-center rounded-md border bg-muted text-sm font-medium transition hover:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {smsSending ? 'Sending...' : 'Send code'}
        </button>
      )}

      {(!isSms || smsSent) && (
        <>
          <div className="space-y-2">
            <label className="text-sm font-medium">Verification code</label>
            <div className="flex items-center gap-2">
              {digits.map((digit, index) => (
                <input
                  key={`mfa-verify-digit-${index}`}
                  ref={element => {
                    inputRefs.current[index] = element;
                  }}
                  autoFocus={index === 0}
                  inputMode="numeric"
                  autoComplete={index === 0 ? 'one-time-code' : 'off'}
                  className="h-11 w-11 rounded-md border bg-background text-center text-lg tracking-widest focus:outline-none focus:ring-2 focus:ring-ring"
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
                ? 'If you lose access to your phone, use a recovery code.'
                : 'If you lose access to your device, use a recovery code.'}
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
                ? `Resend code (${resendCooldown}s)`
                : smsSending
                  ? 'Sending...'
                  : 'Resend code'}
            </button>
          )}
        </>
      )}

      {errorMessage && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {errorMessage}
        </div>
      )}

      {(!isSms || smsSent) && (
        <button
          type="submit"
          disabled={isLoading || code.length !== DIGIT_COUNT}
          className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isLoading ? 'Verifying...' : submitLabel}
        </button>
      )}
    </form>
  );
}
