import type { ClipboardEvent, KeyboardEvent } from 'react';
import { useMemo, useRef, useState } from 'react';
import type { MfaMethod } from '../../stores/auth';

const DIGIT_COUNT = 6;

type MFASettingsProps = {
  enabled?: boolean;
  mfaMethod?: MfaMethod | null;
  phoneVerified?: boolean;
  phoneLast4?: string;
  smsAllowed?: boolean;
  qrCodeDataUrl?: string;
  recoveryCodes?: string[];
  onEnable?: (code: string) => void | Promise<void>;
  onDisable?: (code: string) => void | Promise<void>;
  onGenerateRecoveryCodes?: () => void | Promise<void>;
  onRequestSetup?: () => void | Promise<void>;
  onVerifyPhone?: (phoneNumber: string) => Promise<{ success: boolean; error?: string }>;
  onConfirmPhone?: (phoneNumber: string, code: string) => Promise<{ success: boolean; error?: string }>;
  onEnableSmsMfa?: () => Promise<{ success: boolean; recoveryCodes?: string[]; error?: string }>;
  errorMessage?: string;
  successMessage?: string;
  loading?: boolean;
};

type MFAView = 'status' | 'setup' | 'disable' | 'recovery' | 'phone-verify' | 'sms-setup';

export default function MFASettings({
  enabled = false,
  mfaMethod,
  phoneVerified = false,
  phoneLast4,
  smsAllowed = false,
  qrCodeDataUrl,
  recoveryCodes,
  onEnable,
  onDisable,
  onGenerateRecoveryCodes,
  onRequestSetup,
  onVerifyPhone,
  onConfirmPhone,
  onEnableSmsMfa,
  errorMessage,
  successMessage,
  loading
}: MFASettingsProps) {
  const [view, setView] = useState<MFAView>('status');
  const [digits, setDigits] = useState<string[]>(Array(DIGIT_COUNT).fill(''));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showCodes, setShowCodes] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const [localSuccess, setLocalSuccess] = useState<string>();
  const [smsRecoveryCodes, setSmsRecoveryCodes] = useState<string[]>();
  const [phoneInput, setPhoneInput] = useState('');
  const [phoneDigits, setPhoneDigits] = useState<string[]>(Array(DIGIT_COUNT).fill(''));
  const [phoneCodeSent, setPhoneCodeSent] = useState(false);
  const [localPhoneVerified, setLocalPhoneVerified] = useState(phoneVerified);
  const [localPhoneLast4, setLocalPhoneLast4] = useState(phoneLast4);
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const phoneInputRefs = useRef<Array<HTMLInputElement | null>>([]);

  const isLoading = useMemo(() => loading ?? isSubmitting, [loading, isSubmitting]);
  const code = digits.join('');
  const phoneCode = phoneDigits.join('');
  const currentMethod = mfaMethod || (enabled ? 'totp' : null);

  const resetDigits = () => {
    setDigits(Array(DIGIT_COUNT).fill(''));
  };

  const resetPhoneDigits = () => {
    setPhoneDigits(Array(DIGIT_COUNT).fill(''));
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

  // Phone digit handlers (separate refs)
  const focusPhoneIndex = (index: number) => {
    phoneInputRefs.current[index]?.focus();
    phoneInputRefs.current[index]?.select();
  };

  const handlePhoneDigitChange = (index: number, value: string) => {
    const sanitized = value.replace(/\D/g, '');
    if (!sanitized) {
      const next = [...phoneDigits];
      next[index] = '';
      setPhoneDigits(next);
      return;
    }

    const next = [...phoneDigits];
    const split = sanitized.slice(0, DIGIT_COUNT - index).split('');
    split.forEach((digit, offset) => {
      next[index + offset] = digit;
    });
    setPhoneDigits(next);
    const nextIndex = Math.min(index + split.length, DIGIT_COUNT - 1);
    focusPhoneIndex(nextIndex);
  };

  const handlePhoneKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace' && phoneDigits[index] === '' && index > 0) {
      const next = [...phoneDigits];
      next[index - 1] = '';
      setPhoneDigits(next);
      focusPhoneIndex(index - 1);
    }
  };

  const handlePhonePaste = (index: number, event: ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    handlePhoneDigitChange(index, event.clipboardData.getData('text'));
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
    const codes = smsRecoveryCodes || recoveryCodes;
    if (codes?.length) {
      navigator.clipboard.writeText(codes.join('\n'));
    }
  };

  const handleSendPhoneCode = async () => {
    if (!phoneInput || !onVerifyPhone) return;
    setIsSubmitting(true);
    setLocalError(undefined);
    const result = await onVerifyPhone(phoneInput);
    if (!result.success) {
      setLocalError(result.error);
    } else {
      setPhoneCodeSent(true);
      setLocalSuccess('Verification code sent');
    }
    setIsSubmitting(false);
  };

  const handleConfirmPhone = async () => {
    if (phoneCode.length !== DIGIT_COUNT || !onConfirmPhone) return;
    setIsSubmitting(true);
    setLocalError(undefined);
    const result = await onConfirmPhone(phoneInput, phoneCode);
    if (!result.success) {
      setLocalError(result.error);
    } else {
      setLocalPhoneVerified(true);
      setLocalPhoneLast4(phoneInput.slice(-4));
      setLocalSuccess('Phone number verified');
      setView('status');
      resetPhoneDigits();
      setPhoneInput('');
      setPhoneCodeSent(false);
    }
    setIsSubmitting(false);
  };

  const handleEnableSms = async () => {
    if (!onEnableSmsMfa) return;
    setIsSubmitting(true);
    setLocalError(undefined);
    const result = await onEnableSmsMfa();
    if (!result.success) {
      setLocalError(result.error);
    } else {
      setSmsRecoveryCodes(result.recoveryCodes);
      setLocalSuccess('SMS MFA enabled');
      setView('recovery');
      setShowCodes(true);
    }
    setIsSubmitting(false);
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

  const renderPhoneDigitInputs = () => (
    <div className="flex items-center gap-2">
      {phoneDigits.map((digit, index) => (
        <input
          key={`phone-digit-${index}`}
          ref={element => {
            phoneInputRefs.current[index] = element;
          }}
          autoFocus={index === 0}
          inputMode="numeric"
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          className="h-11 w-11 rounded-md border bg-background text-center text-lg tracking-widest focus:outline-none focus:ring-2 focus:ring-ring"
          maxLength={1}
          value={digit}
          onChange={event => handlePhoneDigitChange(index, event.target.value)}
          onKeyDown={event => handlePhoneKeyDown(index, event)}
          onPaste={event => handlePhonePaste(index, event)}
          disabled={isLoading}
        />
      ))}
    </div>
  );

  const displayError = localError || errorMessage;
  const displaySuccess = localSuccess || successMessage;

  const renderError = () =>
    displayError && (
      <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {displayError}
      </div>
    );

  const renderSuccess = () =>
    displaySuccess && (
      <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-600">
        {displaySuccess}
      </div>
    );

  // Phone verify view
  if (view === 'phone-verify') {
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Verify your phone number</h2>
          <p className="text-sm text-muted-foreground">
            Enter your phone number in E.164 format to receive a verification code.
          </p>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Phone number</label>
          <input
            type="tel"
            value={phoneInput}
            onChange={e => setPhoneInput(e.target.value)}
            placeholder="+14155551234"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            disabled={phoneCodeSent}
          />
        </div>

        {!phoneCodeSent && (
          <button
            type="button"
            onClick={handleSendPhoneCode}
            disabled={isLoading || !phoneInput}
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoading ? 'Sending...' : 'Send code'}
          </button>
        )}

        {phoneCodeSent && (
          <div className="space-y-2">
            <label className="text-sm font-medium">Verification code</label>
            {renderPhoneDigitInputs()}
            <p className="text-xs text-muted-foreground">
              Enter the 6-digit code sent to your phone.
            </p>
          </div>
        )}

        {renderError()}
        {renderSuccess()}

        <div className="flex flex-wrap items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => {
              setView('status');
              setPhoneCodeSent(false);
              setPhoneInput('');
              resetPhoneDigits();
              setLocalError(undefined);
              setLocalSuccess(undefined);
            }}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
          >
            Cancel
          </button>
          {phoneCodeSent && (
            <button
              type="button"
              onClick={handleConfirmPhone}
              disabled={isLoading || phoneCode.length !== DIGIT_COUNT}
              className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isLoading ? 'Verifying...' : 'Verify phone'}
            </button>
          )}
        </div>
      </div>
    );
  }

  // SMS setup confirmation view
  if (view === 'sms-setup') {
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Enable SMS MFA</h2>
          <p className="text-sm text-muted-foreground">
            Enable SMS-based multi-factor authentication for your account.
          </p>
        </div>

        <div className="rounded-md border bg-muted/30 p-4 text-sm">
          <p>
            SMS codes will be sent to your verified phone number ending in{' '}
            <span className="font-mono font-medium">{localPhoneLast4 || phoneLast4 || '****'}</span>.
          </p>
        </div>

        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-600">
          SMS MFA is less secure than an authenticator app due to SIM swapping risks. We recommend TOTP when possible.
        </div>

        {renderError()}

        <div className="flex flex-wrap items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => {
              setView('status');
              setLocalError(undefined);
            }}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleEnableSms}
            disabled={isLoading}
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoading ? 'Enabling...' : 'Enable SMS MFA'}
          </button>
        </div>
      </div>
    );
  }

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

        {/* Authenticator app row */}
        <div className="flex items-center justify-between rounded-md border bg-muted/30 p-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Authenticator app</span>
              {currentMethod === 'totp' ? (
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
              {currentMethod === 'totp'
                ? 'Your account is protected with an authenticator app.'
                : 'Use an authenticator app to generate verification codes. (Recommended)'}
            </p>
          </div>
          {currentMethod === 'totp' ? (
            <button
              type="button"
              onClick={() => {
                resetDigits();
                setLocalError(undefined);
                setLocalSuccess(undefined);
                setView('disable');
              }}
              className="h-9 rounded-md border border-destructive/40 px-3 text-sm font-medium text-destructive transition hover:bg-destructive/10"
            >
              Disable
            </button>
          ) : !enabled ? (
            <button
              type="button"
              onClick={handleStartSetup}
              disabled={isLoading}
              className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Enable
            </button>
          ) : null}
        </div>

        {/* SMS codes row — only visible if org allows SMS */}
        {smsAllowed && (
          <div className="flex items-center justify-between rounded-md border bg-muted/30 p-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">SMS codes</span>
                {currentMethod === 'sms' ? (
                  <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600">
                    Enabled
                  </span>
                ) : (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                    Disabled
                  </span>
                )}
                {localPhoneVerified && localPhoneLast4 && currentMethod !== 'sms' && (
                  <span className="text-xs text-muted-foreground">
                    (phone verified: ...{localPhoneLast4})
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {currentMethod === 'sms'
                  ? `SMS codes sent to phone ending in ${localPhoneLast4 || phoneLast4 || '****'}.`
                  : 'Receive verification codes via SMS as a backup.'}
              </p>
            </div>
            {currentMethod === 'sms' ? (
              <button
                type="button"
                onClick={() => {
                  resetDigits();
                  setLocalError(undefined);
                  setLocalSuccess(undefined);
                  setView('disable');
                }}
                className="h-9 rounded-md border border-destructive/40 px-3 text-sm font-medium text-destructive transition hover:bg-destructive/10"
              >
                Disable
              </button>
            ) : !enabled ? (
              <button
                type="button"
                onClick={() => {
                  setLocalError(undefined);
                  setLocalSuccess(undefined);
                  if (localPhoneVerified) {
                    setView('sms-setup');
                  } else {
                    setView('phone-verify');
                  }
                }}
                disabled={isLoading}
                className="h-9 rounded-md border px-3 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                {localPhoneVerified ? 'Enable' : 'Verify phone'}
              </button>
            ) : null}
          </div>
        )}

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
                setLocalError(undefined);
                setLocalSuccess(undefined);
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

  // Setup view - QR code and verification (TOTP)
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
          <h2 className="text-lg font-semibold">Disable MFA</h2>
          <p className="text-sm text-muted-foreground">
            {currentMethod === 'sms'
              ? 'Enter a verification code sent to your phone to disable MFA.'
              : 'Enter a verification code to disable multi-factor authentication.'}
          </p>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Verification code</label>
          {renderDigitInputs()}
          <p className="text-xs text-muted-foreground">
            {currentMethod === 'sms'
              ? 'Enter the 6-digit code sent to your phone.'
              : 'Enter the 6-digit code from your authenticator app.'}
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
    const displayCodes = smsRecoveryCodes || recoveryCodes;
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Recovery codes</h2>
          <p className="text-sm text-muted-foreground">
            Save these codes in a safe place. You can use them to access your account if you lose
            your authenticator device.
          </p>
        </div>

        {showCodes && displayCodes?.length ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/30 p-4 font-mono text-sm">
              {displayCodes.map((recoveryCode, index) => (
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
