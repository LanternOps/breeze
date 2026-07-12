import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import MFASetupForm from './MFASetupForm';
import {
  AuthSessionExpiredError,
  createPasskeyCredential,
  fetchWithAuth,
  type PasskeyRegistrationOptions,
  ReauthenticationRequiredError,
  restoreAccessTokenFromCookie,
  useAuthStore,
} from '../../stores/auth';
import { extractApiError } from '../../lib/apiError';
import { navigateTo } from '../../lib/navigation';
import { normalizeEnrollmentMethods, type EnrollmentMethod } from './forcedMfaContract';

type Step = 'password' | 'totp' | 'sms-phone' | 'sms-code' | 'done';

export default function ForcedMfaSetupPage() {
  const { t } = useTranslation('auth');
  const [step, setStep] = useState<Step>('password');
  const [methods, setMethods] = useState<EnrollmentMethod[]>([]);
  const [selectedMethod, setSelectedMethod] = useState<EnrollmentMethod | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [phoneCode, setPhoneCode] = useState('');
  const [error, setError] = useState<string>();
  const [info, setInfo] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string>();
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>();
  const [forced, setForced] = useState(false);
  const updateUser = useAuthStore((state) => state.updateUser);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setForced(window.location.hash === '#required');
    let parsed: unknown;
    try { parsed = JSON.parse(sessionStorage.getItem('breeze-mfa-enrollment-methods') ?? 'null'); } catch { parsed = null; }
    const allowed = normalizeEnrollmentMethods(parsed);
    setMethods(allowed);
    setSelectedMethod(allowed[0] ?? null);
  }, []);

  useEffect(() => {
    const { isAuthenticated, tokens } = useAuthStore.getState();
    if (isAuthenticated && !tokens?.accessToken) void restoreAccessTokenFromCookie();
  }, []);

  const terminalError = (err: unknown) =>
    err instanceof AuthSessionExpiredError || err instanceof ReauthenticationRequiredError;

  const finish = (recovery?: unknown) => {
    updateUser({ mfaEnabled: true });
    if (Array.isArray(recovery)) setRecoveryCodes(recovery.filter((code): code is string => typeof code === 'string'));
    setStep('done');
    setInfo(t('forcedMfa.done.redirecting'));
    setTimeout(() => void navigateTo('/').catch(() => { window.location.href = '/'; }), 1500);
  };

  const readFailure = async (response: Response, fallback: string) => {
    const data = await response.json().catch(() => ({}));
    return extractApiError(data, fallback);
  };

  const startTotp = async () => {
    const response = await fetchWithAuth('/auth/mfa/setup', {
      method: 'POST', body: JSON.stringify({ currentPassword }),
    });
    if (!response.ok) throw new Error(await readFailure(response, t('forcedMfa.errors.startFailed')));
    const data = await response.json();
    setQrCodeDataUrl(data.qrCodeDataUrl);
    setRecoveryCodes(data.recoveryCodes);
    setStep('totp');
  };

  const startPasskey = async () => {
    const optionsResponse = await fetchWithAuth('/auth/passkeys/register/options', {
      method: 'POST', body: JSON.stringify({ currentPassword, name: 'Passkey' }),
    });
    if (!optionsResponse.ok) throw new Error(await readFailure(optionsResponse, t('forcedMfa.errors.startFailed')));
    const optionsData = await optionsResponse.json();
    const credential = await createPasskeyCredential(
      (optionsData.options ?? optionsData.optionsJSON) as PasskeyRegistrationOptions,
    );
    const verifyResponse = await fetchWithAuth('/auth/passkeys/register/verify', {
      method: 'POST', body: JSON.stringify({ name: 'Passkey', credential }),
    });
    if (!verifyResponse.ok) throw new Error(await readFailure(verifyResponse, t('forcedMfa.errors.startFailed')));
    const data = await verifyResponse.json();
    finish(data.recoveryCodes);
  };

  const handleStart = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!currentPassword || !selectedMethod) return;
    setLoading(true); setError(undefined);
    try {
      if (selectedMethod === 'totp') await startTotp();
      else if (selectedMethod === 'passkey') await startPasskey();
      else setStep('sms-phone');
    } catch (err) {
      if (!terminalError(err)) setError(err instanceof Error ? err.message : t('common.networkError'));
    } finally { setLoading(false); }
  };

  const handleEnableTotp = async (code: string) => {
    setLoading(true); setError(undefined);
    try {
      const response = await fetchWithAuth('/auth/mfa/enable', {
        method: 'POST', body: JSON.stringify({ code, currentPassword }),
      });
      if (!response.ok) throw new Error(await readFailure(response, t('forcedMfa.errors.invalidCode')));
      const data = await response.json();
      finish(data.recoveryCodes ?? recoveryCodes);
    } catch (err) {
      if (!terminalError(err)) setError(err instanceof Error ? err.message : t('common.networkError'));
    } finally { setLoading(false); }
  };

  const handleSendPhoneCode = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!phoneNumber) return;
    setLoading(true); setError(undefined);
    try {
      const response = await fetchWithAuth('/auth/phone/verify', {
        method: 'POST', body: JSON.stringify({ phoneNumber, currentPassword }),
      });
      if (!response.ok) throw new Error(await readFailure(response, t('forcedMfa.errors.startFailed')));
      setStep('sms-code');
    } catch (err) {
      if (!terminalError(err)) setError(err instanceof Error ? err.message : t('common.networkError'));
    } finally { setLoading(false); }
  };

  const handleConfirmSms = async (event: React.FormEvent) => {
    event.preventDefault();
    if (phoneCode.length !== 6) return;
    setLoading(true); setError(undefined);
    try {
      const confirm = await fetchWithAuth('/auth/phone/confirm', {
        method: 'POST', body: JSON.stringify({ phoneNumber, code: phoneCode, currentPassword }),
      });
      if (!confirm.ok) throw new Error(await readFailure(confirm, t('forcedMfa.errors.invalidCode')));
      const enable = await fetchWithAuth('/auth/mfa/sms/enable', {
        method: 'POST', body: JSON.stringify({ currentPassword }),
      });
      if (!enable.ok) throw new Error(await readFailure(enable, t('forcedMfa.errors.startFailed')));
      const data = await enable.json();
      finish(data.recoveryCodes);
    } catch (err) {
      if (!terminalError(err)) setError(err instanceof Error ? err.message : t('common.networkError'));
    } finally { setLoading(false); }
  };

  return (
    <div className="space-y-6">
      <div className="text-center">
        <p className="text-sm font-medium text-muted-foreground">{t('forcedMfa.eyebrow')}</p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">
          {step === 'done' ? t('forcedMfa.done.title') : t('forcedMfa.title')}
        </h1>
      </div>
      {forced && step !== 'done' && <div data-testid="forced-mfa-banner" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">{t('forcedMfa.requiredBanner')}</div>}

      {step === 'password' && (
        <form onSubmit={handleStart} className="space-y-4 rounded-lg border bg-card p-6 shadow-xs">
          <h2 className="text-lg font-semibold">{t('forcedMfa.password.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('forcedMfa.password.description')}</p>
          {methods.length === 0 ? (
            <div role="alert" className="text-sm text-destructive">{t('forcedMfa.errors.noAllowedMethods')}</div>
          ) : (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t('forcedMfa.method.title')}</legend>
              {methods.map((method) => <label key={method} className="flex items-center gap-2 text-sm"><input type="radio" name="enrollment-method" checked={selectedMethod === method} onChange={() => setSelectedMethod(method)} />{t(/* i18n-dynamic */ `forcedMfa.method.${method}`)}</label>)}
            </fieldset>
          )}
          <label className="block space-y-2 text-sm font-medium" htmlFor="forced-mfa-password">{t('fields.currentPassword')}<input id="forced-mfa-password" type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} className="h-10 w-full rounded-md border bg-background px-3 text-sm" disabled={loading} /></label>
          {error && <div role="alert" className="text-sm text-destructive">{error}</div>}
          <button type="submit" disabled={loading || !currentPassword || !selectedMethod} className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground disabled:opacity-60">{loading ? t('common.verifying') : t('common.continue')}</button>
        </form>
      )}

      {step === 'totp' && <MFASetupForm qrCodeDataUrl={qrCodeDataUrl} onSubmit={handleEnableTotp} errorMessage={error} loading={loading} />}
      {step === 'sms-phone' && <form onSubmit={handleSendPhoneCode} className="space-y-4 rounded-lg border bg-card p-6"><label className="block space-y-2 text-sm font-medium">{t('forcedMfa.sms.phone')}<input aria-label={t('forcedMfa.sms.phone')} type="tel" value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} className="h-10 w-full rounded-md border px-3" /></label>{error && <div role="alert">{error}</div>}<button type="submit" disabled={loading || !phoneNumber}>{t('forcedMfa.sms.send')}</button></form>}
      {step === 'sms-code' && <form onSubmit={handleConfirmSms} className="space-y-4 rounded-lg border bg-card p-6"><label className="block space-y-2 text-sm font-medium">{t('fields.verificationCode')}<input aria-label={t('fields.verificationCode')} inputMode="numeric" value={phoneCode} onChange={(e) => setPhoneCode(e.target.value.replace(/\D/g, '').slice(0, 6))} /></label>{error && <div role="alert">{error}</div>}<button type="submit" disabled={loading || phoneCode.length !== 6}>{t('common.continue')}</button></form>}
      {step === 'done' && info && <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-600">{info}</div>}
    </div>
  );
}
