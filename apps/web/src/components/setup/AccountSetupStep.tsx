import { useState } from 'react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  fetchWithAuth,
  apiLogin,
  isInstalledAuthSessionCurrent,
  StaleWebSessionError,
  useAuthStore,
} from '../../stores/auth';
import { extractApiError } from '@/lib/apiError';

interface AccountSetupStepProps {
  onNext: () => void;
}

export default function AccountSetupStep({ onNext }: AccountSetupStepProps) {
  const { t } = useTranslation('auth');
  const [email, setEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPasswords, setShowPasswords] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();

  const user = useAuthStore((s) => s.user);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setSuccess(undefined);

    if (newPassword && newPassword !== confirmPassword) {
      setError(t('setup.account.errors.passwordsDoNotMatch'));
      return;
    }

    if (newPassword && newPassword.length < 8) {
      setError(t('setup.account.errors.passwordLength'));
      return;
    }

    // Changing the email now requires a step-up: the API re-verifies the
    // current password on the email change (account-takeover protection).
    if (email && email !== user?.email && !currentPassword) {
      setError(t('setup.account.errors.currentPasswordRequiredForEmail'));
      return;
    }

    setLoading(true);

    let installedSession: Awaited<ReturnType<typeof apiLogin>>['installedSession'];
    try {
      // Update email if changed
      if (email && email !== user?.email) {
        const emailRes = await fetchWithAuth('/users/me', {
          method: 'PATCH',
          body: JSON.stringify({ email, currentPassword })
        });
        if (!emailRes.ok) {
          const data = await emailRes.json().catch(() => null);
          setError(extractApiError(data, t('setup.account.errors.updateEmailFailed')));
          setLoading(false);
          return;
        }
        // Update auth store so downstream requests use new email
        useAuthStore.getState().updateUser({ email });
      }

      // Change password if provided
      if (newPassword && currentPassword) {
        const pwRes = await fetchWithAuth('/auth/change-password', {
          method: 'POST',
          body: JSON.stringify({ currentPassword, newPassword })
        });
        if (!pwRes.ok) {
          const data = await pwRes.json().catch(() => null);
          setError(extractApiError(data, t('setup.account.errors.changePasswordFailed')));
          setLoading(false);
          return;
        }

        // Password change invalidates session — re-login transparently
        const loginEmail = email || user?.email || '';
        const loginResult = await apiLogin(loginEmail, newPassword);
        if (
          loginResult.success
          && loginResult.user
          && loginResult.tokens
          && isInstalledAuthSessionCurrent(loginResult.installedSession)
        ) {
          installedSession = loginResult.installedSession;
        } else {
          setError(t('setup.account.errors.reloginFailed'));
          setLoading(false);
          return;
        }
      }

      if (installedSession && !isInstalledAuthSessionCurrent(installedSession)) return;
      setSuccess(t('setup.account.success'));
      setTimeout(() => {
        if (!installedSession || isInstalledAuthSessionCurrent(installedSession)) onNext();
      }, 600);
    } catch (error) {
      if (!(error instanceof StaleWebSessionError)) setError(t('setup.common.unexpectedError'));
    } finally {
      setLoading(false);
    }
  };

  const hasChanges = !!(email || (currentPassword && newPassword));
  // Only warn about an incomplete password change when a NEW password was
  // entered without the current one. A current password alone is now valid on
  // its own (it's the step-up for an email change), so it must not warn here.
  const partialPassword = !!(newPassword && !currentPassword);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">{t('setup.account.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('setup.account.description')}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="setup-email" className="block text-sm font-medium">
            {t('setup.account.emailAddress')}
          </label>
          <input
            id="setup-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={user?.email || t('setup.account.emailPlaceholder')}
            className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus:border-primary focus:outline-hidden focus:ring-1 focus:ring-primary"
          />
          {email && email !== user?.email && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t('setup.account.currentPasswordHint')}
            </p>
          )}
        </div>

        <div className="border-t pt-4">
          <p className="mb-3 text-sm font-medium">{t('setup.account.changePassword')}</p>

          <div className="space-y-3">
            <div>
              <label htmlFor="setup-current-pw" className="block text-sm text-muted-foreground">
                {t('setup.account.currentPassword')}
              </label>
              <input
                id="setup-current-pw"
                type={showPasswords ? 'text' : 'password'}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder={t('setup.account.currentPasswordPlaceholder')}
                className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus:border-primary focus:outline-hidden focus:ring-1 focus:ring-primary"
              />
            </div>

            <div>
              <label htmlFor="setup-new-pw" className="block text-sm text-muted-foreground">
                {t('setup.account.newPassword')}
              </label>
              <input
                id="setup-new-pw"
                type={showPasswords ? 'text' : 'password'}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder={t('setup.account.newPasswordPlaceholder')}
                className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus:border-primary focus:outline-hidden focus:ring-1 focus:ring-primary"
              />
            </div>

            <div>
              <label htmlFor="setup-confirm-pw" className="block text-sm text-muted-foreground">
                {t('setup.account.confirmNewPassword')}
              </label>
              <input
                id="setup-confirm-pw"
                type={showPasswords ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder={t('setup.account.confirmNewPasswordPlaceholder')}
                className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus:border-primary focus:outline-hidden focus:ring-1 focus:ring-primary"
              />
            </div>

            <button
              type="button"
              onClick={() => setShowPasswords(!showPasswords)}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              {showPasswords ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              {showPasswords ? t('setup.account.hidePasswords') : t('setup.account.showPasswords')}
            </button>
          </div>
        </div>

        {partialPassword && (
          <div className="rounded-md border border-yellow-500/50 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-700 dark:text-yellow-400">
            {t('setup.account.partialPasswordWarning')}
          </div>
        )}

        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {success && (
          <div className="rounded-md border border-green-500/50 bg-green-500/10 px-3 py-2 text-sm text-green-700 dark:text-green-400">
            {success}
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onNext}
            className="rounded-md px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            {t('setup.common.skip')}
          </button>
          <button
            type="submit"
            disabled={loading || !hasChanges}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:bg-primary/90 disabled:opacity-50"
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('setup.common.saveAndContinue')}
          </button>
        </div>
      </form>
    </div>
  );
}
