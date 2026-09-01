import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import type { ClipboardEvent, KeyboardEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MfaMethod } from '../../stores/auth';
import { ConfirmDialog } from '../shared/ConfirmDialog';

const DIGIT_COUNT = 6;

type MFASettingsProps = {
  enabled?: boolean;
  mfaMethod?: MfaMethod | null;
  /**
   * #4018: whether this account has a password at all. `false` means an
   * SSO-provisioned (JIT) account that can never satisfy the password step-up,
   * so the enrollment gate offers a fresh IdP round-trip instead of a password
   * prompt. `undefined` is UNKNOWN (a session persisted before /users/me
   * carried the field) and must keep the password prompt — hence every check
   * below is an explicit `=== false`.
   */
  hasPassword?: boolean;
  /** Starts the IdP re-authentication round-trip. Only reachable when
   *  `hasPassword === false`. */
  onSsoReauth?: () => void | Promise<void>;
  /**
   * The parent already completed `/mfa/setup` out-of-band using an SSO
   * re-auth grant it picked up from the redirect fragment, so jump straight to
   * the QR/verify view rather than re-prompting for a proof that was already
   * spent on this page load.
   */
  ssoSetupReady?: boolean;
  /**
   * #4018: is the parent still holding the single-use SSO re-auth grant that
   * the terminal `/mfa/enable` call has to present?
   *
   * It lives only in the parent's React state and the `#ssoReauthGrant=`
   * fragment is stripped at mount, so a reload while the QR is on screen — or
   * a session restore, or opening the page in a second tab — loses it. Without
   * this the Verify button would post no proof at all, the server would 401,
   * and the user would be staring at that error on a screen with no password
   * field and no way to re-verify. Defaults to `true` so the password road and
   * any caller that does not pass it are unaffected.
   */
  ssoReauthGrantAvailable?: boolean;
  phoneVerified?: boolean;
  phoneLast4?: string;
  smsAllowed?: boolean;
  qrCodeDataUrl?: string;
  recoveryCodes?: string[];
  /**
   * #4413: resolve to `false` when the write was REJECTED (e.g. the 401 a
   * mistyped TOTP earns). `undefined` — what a handler that only sets
   * `errorMessage` returns — is treated as success, matching `onRequestSetup`
   * and keeping the prop back-compatible. Without a verdict the panel used to
   * collapse on every outcome, discarding a secret the server will never
   * re-issue.
   */
  onEnable?: (code: string, currentPassword: string) => void | boolean | Promise<void | boolean>;
  onDisable?: (code: string, currentPassword: string) => void | boolean | Promise<void | boolean>;
  onGenerateRecoveryCodes?: (currentPassword: string) => void | boolean | Promise<void | boolean>;
  onRequestSetup?: (currentPassword: string) => Promise<boolean> | boolean;
  onVerifyPhone?: (phoneNumber: string, currentPassword: string) => Promise<{ success: boolean; error?: string }>;
  onConfirmPhone?: (phoneNumber: string, code: string, currentPassword: string) => Promise<{ success: boolean; error?: string }>;
  onEnableSmsMfa?: (currentPassword: string) => Promise<{ success: boolean; recoveryCodes?: string[]; error?: string }>;
  errorMessage?: string;
  successMessage?: string;
  loading?: boolean;
};

type MFAView =
  | 'status'
  | 'confirm-password-setup'
  | 'setup'
  | 'disable'
  | 'recovery'
  | 'phone-verify'
  | 'sms-setup';

export default function MFASettings({
  enabled = false,
  mfaMethod,
  hasPassword,
  onSsoReauth,
  ssoSetupReady = false,
  ssoReauthGrantAvailable = true,
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
  const { t } = useTranslation('settings');
  const [view, setView] = useState<MFAView>('status');
  const [digits, setDigits] = useState<string[]>(Array(DIGIT_COUNT).fill(''));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showCodes, setShowCodes] = useState(false);
  // #4414: the regeneration is destructive and irreversible, so it is gated on
  // an explicit confirm that states the invalidation BEFORE the request goes
  // out — not on a warning the user reads after their saved codes are dead.
  const [confirmRegenerateOpen, setConfirmRegenerateOpen] = useState(false);
  // #4413: the last enrollment submit was rejected. Drives the "your QR is
  // still good, just try the next code" hint — without it a bare "Invalid MFA
  // code" reads as "start over", which is exactly what mints a second secret.
  const [enrollCodeRejected, setEnrollCodeRejected] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const [localSuccess, setLocalSuccess] = useState<string>();
  const [smsRecoveryCodes, setSmsRecoveryCodes] = useState<string[]>();
  const [phoneInput, setPhoneInput] = useState('');
  const [phoneDigits, setPhoneDigits] = useState<string[]>(Array(DIGIT_COUNT).fill(''));
  const [phoneCodeSent, setPhoneCodeSent] = useState(false);
  const [localPhoneVerified, setLocalPhoneVerified] = useState(phoneVerified);
  const [localPhoneLast4, setLocalPhoneLast4] = useState(phoneLast4);
  // Password is held in component state for the duration of the setup flow:
  // /mfa/setup and /mfa/enable both require it, and we want to avoid
  // double-prompting between the two steps. Cleared on view exit / completion.
  const [currentPassword, setCurrentPassword] = useState('');
  const [disablePassword, setDisablePassword] = useState('');
  const [recoveryPassword, setRecoveryPassword] = useState('');
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const phoneInputRefs = useRef<Array<HTMLInputElement | null>>([]);

  const isLoading = useMemo(() => loading ?? isSubmitting, [loading, isSubmitting]);
  const code = digits.join('');
  const phoneCode = phoneDigits.join('');
  const currentMethod = mfaMethod || (enabled ? 'totp' : null);
  // #4018: only `false` takes the SSO road. `undefined` (unknown) keeps the
  // password prompt, which is the fail-safe direction: the server rejects a
  // wrong password, whereas wrongly hiding the prompt would strand a password
  // user with a button their account cannot use.
  const isPasswordless = hasPassword === false;
  // #4018: a passwordless account whose grant has been lost cannot complete the
  // terminal write. It is not an error state to report AFTER the fact — there
  // is nothing the user can type that would fix it — so the enable action is
  // withheld and replaced by a fresh IdP round-trip.
  const needsSsoReVerify = isPasswordless && !ssoReauthGrantAvailable;

  // The parent consumed an `#ssoReauthGrant=` fragment and already ran
  // /mfa/setup with it. Open the QR view directly. Deliberately keyed on the
  // prop only: once the user cancels back to 'status' this must not re-open,
  // and it won't — the effect doesn't re-run while the prop stays true.
  useEffect(() => {
    if (ssoSetupReady) setView('setup');
  }, [ssoSetupReady]);

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

  const handleConfirmPasswordSetup = async () => {
    if (!currentPassword || isLoading || isSubmitting) return;
    try {
      setIsSubmitting(true);
      const result = await onRequestSetup?.(currentPassword);
      // Treat undefined (legacy/no-op) as success to keep prop optional.
      const ok = result === undefined ? true : result;
      if (ok) {
        setView('setup');
      }
    } catch {
      // Parent handler surfaces errors via the errorMessage prop. If it
      // unexpectedly throws, stay on this view so the user can retry.
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEnableSubmit = async () => {
    // A passwordless account has no password to carry from the gate above —
    // the parent supplies the SSO re-auth grant instead, so requiring a
    // non-empty password here would make the Verify button permanently inert.
    // But a passwordless account with NO grant left has no proof at all, and
    // firing the request anyway just buys a 401 on a screen with nothing to
    // retry with. Refuse to issue it; the view offers re-verification instead.
    if (isLoading || isSubmitting || code.length !== DIGIT_COUNT
      || needsSsoReVerify
      || (!isPasswordless && !currentPassword)) {
      return;
    }
    // `undefined` (a handler that only sets `errorMessage`) counts as success;
    // only an explicit `false` or a throw is a rejection.
    let succeeded = true;
    try {
      setIsSubmitting(true);
      succeeded = (await onEnable?.(code, currentPassword)) !== false;
    } catch {
      // Parent handler surfaces errors via the errorMessage prop.
      succeeded = false;
    } finally {
      setIsSubmitting(false);
      // Clear the digits either way: on success they are spent, on failure the
      // user needs an empty field for the NEXT 30-second code.
      resetDigits();
      setEnrollCodeRejected(!succeeded);
      if (succeeded) {
        // Clear the plaintext password as soon as the flow that needs it ends.
        setCurrentPassword('');
        // #4414: /auth/mfa/enable is the only moment the recovery codes exist
        // in plaintext. Show them once, here — the regenerate action is the
        // only other way to see any, and it destroys these.
        setShowCodes(true);
        setView('recovery');
      } else {
        // #4413: stay on the QR. Leaving this view discards a secret the server
        // will not re-issue, so a mistyped digit would cost a whole re-
        // enrollment — and the password collected at the gate has to survive
        // with it, or the retry 401s for an entirely different reason.
        focusIndex(0);
      }
    }
  };

  const handleDisableSubmit = async () => {
    if (isLoading || isSubmitting || code.length !== DIGIT_COUNT || !disablePassword) {
      return;
    }
    // Same verdict contract as enable: only `false`/throw means rejected.
    let succeeded = true;
    try {
      setIsSubmitting(true);
      succeeded = (await onDisable?.(code, disablePassword)) !== false;
    } catch {
      // Parent handler surfaces errors via the errorMessage prop.
      succeeded = false;
    } finally {
      setIsSubmitting(false);
      resetDigits();
      setDisablePassword('');
      // #4413 (same class): collapsing on a rejected code hid the error behind
      // a panel that still read "Enabled", so the user could not tell whether
      // the code or the password was wrong — or that anything had failed.
      if (succeeded) setView('status');
    }
  };

  const handleRegenerateCodes = async () => {
    if (!recoveryPassword) {
      setLocalError(t('mFASettings.currentPasswordIsRequired'));
      setConfirmRegenerateOpen(false);
      return;
    }

    try {
      setIsSubmitting(true);
      setLocalError(undefined);
      // #4414: only reveal on a confirmed success. The old unconditional
      // `setShowCodes(true)` re-displayed the PREVIOUS set after a failed
      // regeneration, which reads as "here are your new codes".
      if ((await onGenerateRecoveryCodes?.(recoveryPassword)) !== false) {
        setShowCodes(true);
      }
    } catch {
      // Parent handler surfaces errors via the errorMessage prop.
    } finally {
      setIsSubmitting(false);
      // The field is on this same screen, so re-typing costs one action —
      // cheap next to leaving a plaintext password in component state.
      setRecoveryPassword('');
      setConfirmRegenerateOpen(false);
    }
  };

  const handleCopyRecoveryCodes = () => {
    const codes = smsRecoveryCodes || recoveryCodes;
    if (codes?.length) {
      navigator.clipboard.writeText(codes.join('\n'));
    }
  };

  const handleSendPhoneCode = async () => {
    if (!phoneInput || !currentPassword || !onVerifyPhone) return;
    setIsSubmitting(true);
    setLocalError(undefined);
    const result = await onVerifyPhone(phoneInput, currentPassword);
    if (!result.success) {
      setLocalError(result.error);
    } else {
      setPhoneCodeSent(true);
      setLocalSuccess(t('mFASettings.verificationCodeSent'));
    }
    setIsSubmitting(false);
  };

  const handleConfirmPhone = async () => {
    if (phoneCode.length !== DIGIT_COUNT || !currentPassword || !onConfirmPhone) return;
    setIsSubmitting(true);
    setLocalError(undefined);
    const result = await onConfirmPhone(phoneInput, phoneCode, currentPassword);
    if (!result.success) {
      setLocalError(result.error);
    } else {
      setLocalPhoneVerified(true);
      setLocalPhoneLast4(phoneInput.slice(-4));
      setLocalSuccess(t('mFASettings.phoneNumberVerified'));
      setView('status');
      resetPhoneDigits();
      setPhoneInput('');
      setPhoneCodeSent(false);
      setCurrentPassword('');
    }
    setIsSubmitting(false);
  };

  const handleEnableSms = async () => {
    if (!currentPassword || !onEnableSmsMfa) return;
    setIsSubmitting(true);
    setLocalError(undefined);
    const result = await onEnableSmsMfa(currentPassword);
    if (!result.success) {
      setLocalError(result.error);
    } else {
      setSmsRecoveryCodes(result.recoveryCodes);
      setLocalSuccess(t('mFASettings.sMSMFAEnabled'));
      setView('recovery');
      setShowCodes(true);
      setCurrentPassword('');
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
          className="h-11 w-11 rounded-md border bg-background text-center text-lg tracking-widest focus:outline-hidden focus:ring-2 focus:ring-ring"
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
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-xs">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{t('mFASettings.verifyYourPhoneNumber')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('mFASettings.enterYourPhoneNumberInE164FormatToReceiveAVerificationCo')}</p>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">{t('mFASettings.phoneNumber')}</label>
          <input
            type="tel"
            value={phoneInput}
            onChange={e => setPhoneInput(e.target.value)}
            placeholder="+14155551234"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            disabled={phoneCodeSent}
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="mfa-phone-password">
            {t('mFASettings.currentPassword')}</label>
          <input
            id="mfa-phone-password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={e => setCurrentPassword(e.target.value)}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            disabled={isLoading}
          />
        </div>

        {!phoneCodeSent && (
          <button
            type="button"
            onClick={handleSendPhoneCode}
            disabled={isLoading || !phoneInput || !currentPassword}
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoading ? t('mFASettings.sending') : t('mFASettings.sendCode')}
          </button>
        )}

        {phoneCodeSent && (
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('mFASettings.verificationCode')}</label>
            {renderPhoneDigitInputs()}
            <p className="text-xs text-muted-foreground">
              {t('mFASettings.enterThe6DigitCodeSentToYourPhone')}</p>
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
              setCurrentPassword('');
              resetPhoneDigits();
              setLocalError(undefined);
              setLocalSuccess(undefined);
            }}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
          >
            {t('mFASettings.cancel')}</button>
          {phoneCodeSent && (
            <button
              type="button"
              onClick={handleConfirmPhone}
              disabled={isLoading || phoneCode.length !== DIGIT_COUNT || !currentPassword}
              className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isLoading ? t('mFASettings.verifying') : t('mFASettings.verifyPhone')}
            </button>
          )}
        </div>
      </div>
    );
  }

  // SMS setup confirmation view
  if (view === 'sms-setup') {
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-xs">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{t('mFASettings.enableSMSMFA')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('mFASettings.enableSMSBasedMultiFactorAuthenticationForYourAccount')}</p>
        </div>

        <div className="rounded-md border bg-muted/30 p-4 text-sm">
          <p>
            {t('mFASettings.sMSCodesWillBeSentToYourVerifiedPhoneNumberEndingIn')}{' '}
            <span className="font-mono font-medium">{localPhoneLast4 || phoneLast4 || '****'}</span>.
          </p>
        </div>

        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-600">
          {t('mFASettings.sMSMFAIsLessSecureThanAnAuthenticatorAppDueToSIMSwapping')}</div>

        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="mfa-sms-password">
            {t('mFASettings.currentPassword')}</label>
          <input
            id="mfa-sms-password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={e => setCurrentPassword(e.target.value)}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            disabled={isLoading}
          />
        </div>

        {renderError()}

        <div className="flex flex-wrap items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => {
              setView('status');
              setCurrentPassword('');
              setLocalError(undefined);
            }}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
          >
            {t('mFASettings.cancel')}</button>
          <button
            type="button"
            onClick={handleEnableSms}
            disabled={isLoading || !currentPassword}
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoading ? t('mFASettings.enabling') : t('mFASettings.enableSMSMFA')}
          </button>
        </div>
      </div>
    );
  }

  // Status view - shows current MFA state
  if (view === 'status') {
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-xs">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{t('mFASettings.multiFactorAuthentication')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('mFASettings.addAnExtraLayerOfSecurityToYourAccount')}</p>
        </div>

        {/* Authenticator app row */}
        <div className="flex items-center justify-between rounded-md border bg-muted/30 p-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{t('mFASettings.authenticatorApp')}</span>
              {currentMethod === 'totp' ? (
                <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600">
                  {t('mFASettings.enabled')}</span>
              ) : (
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  {t('mFASettings.disabled')}</span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {currentMethod === 'totp'
                ? t('mFASettings.yourAccountIsProtectedWithAnAuthenticatorApp')
                : t('mFASettings.useAnAuthenticatorAppToGenerateVerificationCodesRecommen')}
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
              {t('mFASettings.disable')}</button>
          ) : !enabled ? (
            <button
              type="button"
              data-testid="mfa-setup-start"
              onClick={() => {
                setCurrentPassword('');
                setLocalError(undefined);
                setLocalSuccess(undefined);
                setEnrollCodeRejected(false);
                setView('confirm-password-setup');
              }}
              disabled={isLoading}
              className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t('mFASettings.enable')}</button>
          ) : null}
        </div>

        {/* SMS codes row — only visible if org allows SMS */}
        {smsAllowed && (
          <div className="flex items-center justify-between rounded-md border bg-muted/30 p-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{t('mFASettings.sMSCodes')}</span>
                {currentMethod === 'sms' ? (
                  <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600">
                    {t('mFASettings.enabled')}</span>
                ) : (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                    {t('mFASettings.disabled')}</span>
                )}
                {localPhoneVerified && localPhoneLast4 && currentMethod !== 'sms' && (
                  <span className="text-xs text-muted-foreground">
                    {t('mFASettings.phoneVerifiedLast4', { last4: localPhoneLast4 })}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {currentMethod === 'sms'
                  ? t('mFASettings.smsSentToPhone', { last4: localPhoneLast4 || phoneLast4 || '****' })
                  : t('mFASettings.receiveVerificationCodesViaSMSAsABackup')}
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
                {t('mFASettings.disable')}</button>
            ) : !enabled ? (
              <button
                type="button"
                onClick={() => {
                  setLocalError(undefined);
                  setLocalSuccess(undefined);
                  if (localPhoneVerified) {
                    setCurrentPassword('');
                    setView('sms-setup');
                  } else {
                    setCurrentPassword('');
                    setView('phone-verify');
                  }
                }}
                disabled={isLoading}
                className="h-9 rounded-md border px-3 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                {localPhoneVerified ? t('mFASettings.enable') : t('mFASettings.verifyPhone')}
              </button>
            ) : null}
          </div>
        )}

        {enabled && (
          <div className="flex items-center justify-between rounded-md border bg-muted/30 p-4">
            <div className="space-y-1">
              <span className="text-sm font-medium">{t('mFASettings.recoveryCodes')}</span>
              <p className="text-xs text-muted-foreground">
                {t('mFASettings.useTheseCodesToAccessYourAccountIfYouLoseYourAuthenticat')}</p>
              {/* #4414: there is no read action here and there cannot be — the
                  server keeps only hashes. Saying so is what stops the one
                  remaining button from being mistaken for one. */}
              <p className="text-xs text-muted-foreground">
                {t('mFASettings.recoveryCodesAreShownOnceAndCannotBeDisplayedAgain')}</p>
            </div>
            <button
              type="button"
              data-testid="mfa-recovery-regenerate-start"
              onClick={() => {
                setView('recovery');
                setShowCodes(false);
                setLocalError(undefined);
                setLocalSuccess(undefined);
              }}
              className="h-9 rounded-md border px-3 text-sm font-medium text-muted-foreground transition hover:text-foreground"
            >
              {t('mFASettings.regenerateRecoveryCodes')}</button>
          </div>
        )}

        {renderSuccess()}
        {renderError()}
      </div>
    );
  }

  // Confirm-password gate before /mfa/setup. The server requires the user's
  // current password to attach a new TOTP factor; we collect it here and reuse
  // it for the subsequent /mfa/enable call without re-prompting.
  if (view === 'confirm-password-setup') {
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-xs">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">
            {isPasswordless
              ? t('mFASettings.verifyYourIdentity')
              : t('mFASettings.confirmYourPassword')}
          </h2>
          <p className="text-sm text-muted-foreground">
            {isPasswordless
              ? t('mFASettings.thisAccountSignsInThroughAnIdentityProviderAndHasNoPassw')
              : t('mFASettings.reEnterYourAccountPasswordToStartSettingUpAnAuthenticato')}
          </p>
        </div>

        {/* #4018: a passwordless SSO account proves identity with a fresh,
            forced IdP round-trip instead of a password it does not have. */}
        {!isPasswordless && (
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="mfa-confirm-password">
              {t('mFASettings.currentPassword')}</label>
            <input
              id="mfa-confirm-password"
              data-testid="mfa-current-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && currentPassword && !isLoading && !isSubmitting) {
                  handleConfirmPasswordSetup();
                }
              }}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              disabled={isLoading || isSubmitting}
            />
          </div>
        )}

        {renderError()}

        <div className="flex flex-wrap items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => {
              setCurrentPassword('');
              setLocalError(undefined);
              setView('status');
            }}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
          >
            {t('mFASettings.cancel')}</button>
          {isPasswordless ? (
            <button
              type="button"
              data-testid="mfa-sso-reauth"
              onClick={() => { void onSsoReauth?.(); }}
              disabled={isLoading || isSubmitting}
              className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t('mFASettings.verifyWithYourIdentityProvider')}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleConfirmPasswordSetup}
              disabled={isLoading || isSubmitting || !currentPassword}
              className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isLoading ? t('mFASettings.verifying') : t('mFASettings.continue')}
            </button>
          )}
        </div>
      </div>
    );
  }

  // Setup view - QR code and verification (TOTP)
  if (view === 'setup') {
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-xs">
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">{t('mFASettings.setUpAuthenticator')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('mFASettings.scanThisQRCodeWithYourAuthenticatorAppThenEnterThe6Digit')}</p>
          <div className="flex items-center justify-center rounded-md border bg-muted p-4">
            {qrCodeDataUrl ? (
              <img
                src={qrCodeDataUrl}
                alt={t('mFASettings.authenticatorQRCode')}
                className="h-48 w-48"
              />
            ) : (
              <div className="flex h-48 w-48 items-center justify-center text-sm text-muted-foreground">
                {t('mFASettings.qRCodeUnavailable')}</div>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">{t('mFASettings.verificationCode')}</label>
          {renderDigitInputs()}
          <p className="text-xs text-muted-foreground">
            {t('mFASettings.enterThe6DigitCodeGeneratedByYourAuthenticatorApp')}</p>
        </div>

        {/* #4018: the single-use grant is gone (reload, restored session, or a
            second tab), so there is no proof left to send. Say so and offer the
            only thing that fixes it rather than letting the submit 401. */}
        {needsSsoReVerify && (
          <p data-testid="mfa-sso-grant-lost" className="text-sm text-muted-foreground">
            {t('mFASettings.ssoReauthProofExpired')}
          </p>
        )}

        {renderError()}

        {/* #4413: the server's "Invalid MFA code" says nothing about whether
            the enrollment survived. It does — say so, or the user re-enrolls
            and strands the secret they just scanned. */}
        {enrollCodeRejected && (
          <p data-testid="mfa-code-rejected-hint" className="text-sm text-muted-foreground">
            {t('mFASettings.thatCodeWasNotAcceptedYourQRCodeIsStillValidWaitForThe')}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => {
              resetDigits();
              setEnrollCodeRejected(false);
              setView('status');
            }}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
          >
            {t('mFASettings.cancel')}</button>
          {needsSsoReVerify ? (
            <button
              type="button"
              data-testid="mfa-sso-reauth-retry"
              onClick={() => { void onSsoReauth?.(); }}
              disabled={isLoading || isSubmitting}
              className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t('mFASettings.verifyWithYourIdentityProvider')}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleEnableSubmit}
              disabled={isLoading || code.length !== DIGIT_COUNT}
              className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isLoading ? t('mFASettings.verifying') : t('mFASettings.verifyAndEnable')}
            </button>
          )}
        </div>
      </div>
    );
  }

  // Disable view - requires verification
  if (view === 'disable') {
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-xs">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{t('mFASettings.disableMFA')}</h2>
          <p className="text-sm text-muted-foreground">
            {currentMethod === 'sms'
              ? t('mFASettings.enterAVerificationCodeSentToYourPhoneToDisableMFA')
              : t('mFASettings.enterAVerificationCodeToDisableMultiFactorAuthentication')}
          </p>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">{t('mFASettings.verificationCode')}</label>
          {renderDigitInputs()}
          <p className="text-xs text-muted-foreground">
            {currentMethod === 'sms'
              ? t('mFASettings.enterThe6DigitCodeSentToYourPhone')
              : t('mFASettings.enterThe6DigitCodeFromYourAuthenticatorApp')}
          </p>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="mfa-disable-password">
            {t('mFASettings.currentPassword')}</label>
          <input
            id="mfa-disable-password"
            type="password"
            autoComplete="current-password"
            value={disablePassword}
            onChange={e => setDisablePassword(e.target.value)}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            disabled={isLoading}
          />
          <p className="text-xs text-muted-foreground">
            {t('mFASettings.reEnterYourAccountPasswordToConfirmThisChange')}</p>
        </div>

        {renderError()}

        <div className="flex flex-wrap items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => {
              resetDigits();
              setDisablePassword('');
              setView('status');
            }}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
          >
            {t('mFASettings.cancel')}</button>
          <button
            type="button"
            onClick={handleDisableSubmit}
            disabled={isLoading || code.length !== DIGIT_COUNT || !disablePassword}
            className="inline-flex h-10 items-center justify-center rounded-md border border-destructive/40 bg-destructive/10 px-4 text-sm font-medium text-destructive transition hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoading ? t('mFASettings.disabling') : t('mFASettings.disableMFA')}
          </button>
        </div>
      </div>
    );
  }

  // Recovery codes view
  if (view === 'recovery') {
    const displayCodes = smsRecoveryCodes || recoveryCodes;
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-xs">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{t('mFASettings.recoveryCodes')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('mFASettings.saveTheseCodesInASafePlaceYouCanUseThemToAccessYourAccou')}</p>
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
              {t('mFASettings.copyCodes')}</button>
          </div>
        ) : (
          <div
            data-testid="mfa-recovery-no-codes"
            className="rounded-md border bg-muted/30 p-4 text-center text-sm text-muted-foreground"
          >
            {t('mFASettings.existingCodesCannotBeDisplayedAgainRegeneratingIssuesA')}</div>
        )}

        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-600">
          {t('mFASettings.eachCodeCanOnlyBeUsedOnceGeneratingNewCodesWillInvalidat')}</div>

        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="mfa-recovery-password">
            {t('mFASettings.currentPassword')}</label>
          <input
            id="mfa-recovery-password"
            type="password"
            autoComplete="current-password"
            value={recoveryPassword}
            onChange={e => setRecoveryPassword(e.target.value)}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            disabled={isLoading}
          />
        </div>

        {renderError()}
        {renderSuccess()}

        <div className="flex flex-wrap items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => {
              setRecoveryPassword('');
              setView('status');
            }}
            className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
          >
            {t('mFASettings.back')}</button>
          {/* #4414: one action, and it is honestly named. The label no longer
              flips to a read verb before the first press — that flip is what
              made a regeneration look like a way to look your codes up. */}
          <button
            type="button"
            data-testid="mfa-recovery-regenerate"
            onClick={() => setConfirmRegenerateOpen(true)}
            disabled={isLoading || !recoveryPassword}
            className="inline-flex h-10 items-center justify-center rounded-md border border-destructive/40 bg-destructive/10 px-4 text-sm font-medium text-destructive transition hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoading ? t('mFASettings.generating') : t('mFASettings.regenerateCodes')}
          </button>
        </div>

        <ConfirmDialog
          open={confirmRegenerateOpen}
          onClose={() => setConfirmRegenerateOpen(false)}
          onConfirm={() => { void handleRegenerateCodes(); }}
          title={t('mFASettings.regenerateRecoveryCodesQuestion')}
          message={t('mFASettings.regeneratingImmediatelyInvalidatesEveryRecoveryCodeYou')}
          confirmLabel={t('mFASettings.regenerateCodes')}
          variant="destructive"
          isLoading={isLoading}
          confirmTestId="confirm-regenerate-recovery-codes"
        />
      </div>
    );
  }

  return null;
}
