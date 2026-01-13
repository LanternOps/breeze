import type { ClipboardEvent, KeyboardEvent } from 'react';
import { useMemo, useRef, useState } from 'react';

const DIGIT_COUNT = 6;

type MFASettingsProps = {
  enabled?: boolean;
  qrCodeDataUrl?: string;
  recoveryCodes?: string[];
  onEnable?: (code: string) => void | Promise<void>;
  onDisable?: (code: string) => void | Promise<void>;
  onGenerateRecoveryCodes?: () => void | Promise<void>;
  onRequestSetup?: () => void | Promise<void>;
  errorMessage?: string;
  successMessage?: string;
  loading?: boolean;
};

type MFAView = 'status' | 'setup' | 'disable' | 'recovery';

export default function MFASettings({
  enabled = false,
  qrCodeDataUrl,
  recoveryCodes,
  onEnable,
  onDisable,
  onGenerateRecoveryCodes,
  onRequestSetup,
  errorMessage,
  successMessage,
  loading
}: MFASettingsProps) {
  const [view, setView] = useState<MFAView>('status');
  const [digits, setDigits] = useState<string[]>(Array(DIGIT_COUNT).fill(''));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showCodes, setShowCodes] = useState(false);
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);

  const isLoading = useMemo(() => loading ?? isSubmitting, [loading, isSubmitting]);
  const code = digits.join('');

  const resetDigits = () => {
    setDigits(Array(DIGIT_COUNT).fill(''));
  };

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

  const handleStartSetup = async () => {
    await onRequestSetup?.();
    setView('setup');
  };

  const handleEnableSubmit = async () => {
    if (isLoading || code.length !== DIGIT_COUNT) {
      return;
    }
    try {
      setIsSubmitting(true);
      await onEnable?.(code);
      resetDigits();
      setView('status');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDisableSubmit = async () => {
    if (isLoading || code.length !== DIGIT_COUNT) {
      return;
    }
    try {
      setIsSubmitting(true);
      await onDisable?.(code);
      resetDigits();
      setView('status');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRegenerateCodes = async () => {
    try {
      setIsSubmitting(true);
      await onGenerateRecoveryCodes?.();
      setShowCodes(true);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCopyRecoveryCodes = () => {
    if (recoveryCodes?.length) {
      navigator.clipboard.writeText(recoveryCodes.join('\n'));
    }
  };

  const renderDigitInputs = () => (
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
  );

  const renderError = () =>
    errorMessage && (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {errorMessage}
      </div>
    );

  const renderSuccess = () =>
    successMessage && (
      <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-600">
        {successMessage}
      </div>
    );

  // Status view - shows current MFA state
  if (view === 'status') {
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Multi-factor authentication</h2>
          <p className="text-sm text-muted-foreground">
            Add an extra layer of security to your account.
          </p>
        </div>

        <div className="flex items-center justify-between rounded-md border bg-muted/30 p-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Authenticator app</span>
              {enabled ? (
                <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600">
                  Enabled
                </span>
              ) : (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  Disabled
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {enabled
                ? 'Your account is protected with an authenticator app.'
                : 'Use an authenticator app to generate verification codes.'}
            </p>
          </div>
          {enabled ? (
            <button
              type="button"
              onClick={() => {
                resetDigits();
                setView('disable');
              }}
              className="h-9 rounded-md border border-destructive/40 px-3 text-sm font-medium text-destructive transition hover:bg-destructive/10"
            >
              Disable
            </button>
          ) : (
            <button
              type="button"
              onClick={handleStartSetup}
              disabled={isLoading}
              className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Enable
            </button>
          )}
        </div>

        {enabled && (
          <div className="flex items-center justify-between rounded-md border bg-muted/30 p-4">
            <div className="space-y-1">
              <span className="text-sm font-medium">Recovery codes</span>
              <p className="text-xs text-muted-foreground">
                Use these codes to access your account if you lose your authenticator.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setView('recovery');
                setShowCodes(false);
              }}
              className="h-9 rounded-md border px-3 text-sm font-medium text-muted-foreground transition hover:text-foreground"
            >
              View codes
            </button>
          </div>
        )}

        {renderSuccess()}
        {renderError()}
      </div>
    );
  }

  // Setup view - QR code and verification
  if (view === 'setup') {
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Set up authenticator</h2>
          <p className="text-sm text-muted-foreground">
            Scan this QR code with your authenticator app, then enter the 6-digit code.
          </p>
          <div className="flex items-center justify-center rounded-md border bg-muted p-4">
            {qrCodeDataUrl ? (
              <img
                src={qrCodeDataUrl}
                alt="Authenticator QR code"
                className="h-48 w-48"
              />
            ) : (
              <div className="flex h-48 w-48 items-center justify-center text-sm text-muted-foreground">
                QR code unavailable
              </div>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Verification code</label>
          {renderDigitInputs()}
          <p className="text-xs text-muted-foreground">
            Enter the 6-digit code generated by your authenticator app.
          </p>
        </div>

        {renderError()}

        <div className="flex flex-wrap items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => {
              resetDigits();
              setView('status');
            }}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleEnableSubmit}
            disabled={isLoading || code.length !== DIGIT_COUNT}
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoading ? 'Verifying...' : 'Verify and enable'}
          </button>
        </div>
      </div>
    );
  }

  // Disable view - requires verification
  if (view === 'disable') {
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Disable authenticator</h2>
          <p className="text-sm text-muted-foreground">
            Enter a verification code to disable multi-factor authentication.
          </p>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Verification code</label>
          {renderDigitInputs()}
          <p className="text-xs text-muted-foreground">
            Enter the 6-digit code from your authenticator app.
          </p>
        </div>

        {renderError()}

        <div className="flex flex-wrap items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => {
              resetDigits();
              setView('status');
            }}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleDisableSubmit}
            disabled={isLoading || code.length !== DIGIT_COUNT}
            className="inline-flex h-10 items-center justify-center rounded-md border border-destructive/40 bg-destructive/10 px-4 text-sm font-medium text-destructive transition hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoading ? 'Disabling...' : 'Disable MFA'}
          </button>
        </div>
      </div>
    );
  }

  // Recovery codes view
  if (view === 'recovery') {
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Recovery codes</h2>
          <p className="text-sm text-muted-foreground">
            Save these codes in a safe place. You can use them to access your account if you lose
            your authenticator device.
          </p>
        </div>

        {showCodes && recoveryCodes?.length ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/30 p-4 font-mono text-sm">
              {recoveryCodes.map((recoveryCode, index) => (
                <div key={`recovery-code-${index}`} className="text-center">
                  {recoveryCode}
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={handleCopyRecoveryCodes}
              className="flex h-9 w-full items-center justify-center gap-2 rounded-md border text-sm font-medium text-muted-foreground transition hover:text-foreground"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="h-4 w-4"
              >
                <path d="M7 3.5A1.5 1.5 0 018.5 2h3.879a1.5 1.5 0 011.06.44l3.122 3.12A1.5 1.5 0 0117 6.622V12.5a1.5 1.5 0 01-1.5 1.5h-1v-3.379a3 3 0 00-.879-2.121L10.5 5.379A3 3 0 008.379 4.5H7v-1z" />
                <path d="M4.5 6A1.5 1.5 0 003 7.5v9A1.5 1.5 0 004.5 18h7a1.5 1.5 0 001.5-1.5v-5.879a1.5 1.5 0 00-.44-1.06L9.44 6.439A1.5 1.5 0 008.378 6H4.5z" />
              </svg>
              Copy codes
            </button>
          </div>
        ) : (
          <div className="rounded-md border bg-muted/30 p-4 text-center text-sm text-muted-foreground">
            Click the button below to view or generate new recovery codes.
          </div>
        )}

        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-600">
          Each code can only be used once. Generating new codes will invalidate any previously
          generated codes.
        </div>

        {renderError()}
        {renderSuccess()}

        <div className="flex flex-wrap items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => setView('status')}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
          >
            Back
          </button>
          <button
            type="button"
            onClick={handleRegenerateCodes}
            disabled={isLoading}
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoading
              ? 'Generating...'
              : showCodes
                ? 'Regenerate codes'
                : 'Show recovery codes'}
          </button>
        </div>
      </div>
    );
  }

  return null;
}
