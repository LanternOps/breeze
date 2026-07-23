import { i18n } from '@/lib/i18n';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import ChangePasswordForm from './ChangePasswordForm';
import ConnectSsoCard from './ConnectSsoCard';
import MFASettings from './MFASettings';
import SecurityDevicesCard from './SecurityDevicesCard';
import ThemingSettings from './ThemingSettings';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import type { UserPreferences } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { useAvatarBlobUrl } from '@/lib/avatarBlobCache';
import { formatNumber } from '@/lib/i18n/format';

const createProfileSchema = (t: TFunction) => z.object({
  name: z.string().min(2, t('profilePage.nameMustBeAtLeast2Characters')),
});

type ProfileFormValues = z.infer<ReturnType<typeof createProfileSchema>>;

type User = {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string;
  mfaEnabled?: boolean;
  mfaMethod?: string | null;
  preferences?: UserPreferences;
};

const ALLOWED_AVATAR_MIMES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${formatNumber(n / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} KB`;
  return `${formatNumber(n / (1024 * 1024), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}

type ProfilePageProps = {
  initialUser?: User;
};

export default function ProfilePage({ initialUser }: ProfilePageProps) {
  const { t } = useTranslation('settings');
  const [user, setUser] = useState<User | null>(initialUser ?? null);
  const [isLoadingUser, setIsLoadingUser] = useState(!initialUser);
  const [profileError, setProfileError] = useState<string | undefined>();
  const [profileSuccess, setProfileSuccess] = useState<string | undefined>();
  const [tourResetMsg, setTourResetMsg] = useState<string | undefined>();
  const [passwordError, setPasswordError] = useState<string | undefined>();
  const [passwordSuccess, setPasswordSuccess] = useState<string | undefined>();
  const [mfaError, setMfaError] = useState<string | undefined>();
  const [mfaSuccess, setMfaSuccess] = useState<string | undefined>();
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | undefined>();
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | undefined>();
  const [isUpdatingProfile, setIsUpdatingProfile] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [mfaLoading, setMfaLoading] = useState(false);

  // Avatar upload state
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [isDeletingAvatar, setIsDeletingAvatar] = useState(false);
  const [avatarError, setAvatarError] = useState<string | undefined>();
  const [avatarSuccess, setAvatarSuccess] = useState<string | undefined>();
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const updateAuthUser = useAuthStore((s) => s.updateUser);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting }
  } = useForm<ProfileFormValues>({
    resolver: zodResolver(createProfileSchema(t)),
    defaultValues: {
      name: user?.name ?? '',
    }
  });

  const isProfileLoading = useMemo(
    () => isUpdatingProfile || isSubmitting,
    [isUpdatingProfile, isSubmitting]
  );
  // Preview priority: locally-selected file (object URL) → user's current
  // avatar (fetched as blob through fetchWithAuth so the Bearer token gets
  // attached — the API requires auth on GET /users/:id/avatar, and <img src=>
  // can't send headers).
  const resolvedAvatarUrl = useAvatarBlobUrl(avatarPreview ? null : user?.avatarUrl ?? null);
  const previewAvatarUrl = avatarPreview || resolvedAvatarUrl || '';

  // Fetch user data on mount
  useEffect(() => {
    if (initialUser) {
      return;
    }

    const fetchUser = async () => {
      try {
        setIsLoadingUser(true);
        const response = await fetchWithAuth('/users/me');
        if (!response.ok) {
          if (response.status === 401) {
            void navigateTo('/login', { replace: true });
            return;
          }
          throw new Error(t('profilePage.failedToFetchUserData'));
        }
        const userData = await response.json();
        setUser(userData);
        reset({
          name: userData.name ?? '',
        });
      } catch {
        setProfileError(t('profilePage.failedToLoadProfileData'));
      } finally {
        setIsLoadingUser(false);
      }
    };

    fetchUser();
  }, [initialUser, reset]);

  const clearMessages = useCallback(() => {
    setProfileError(undefined);
    setProfileSuccess(undefined);
  }, []);

  const handleProfileSubmit = async (values: ProfileFormValues) => {
    clearMessages();
    try {
      setIsUpdatingProfile(true);
      const payload = {
        name: values.name.trim(),
      };

      const response = await fetchWithAuth('/users/me', {
        method: 'PATCH',
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message ?? t('profilePage.failedToUpdateProfile'));
      }

      const updatedUser = await response.json();
      setUser(updatedUser);
      reset({
        name: updatedUser.name ?? '',
      });
      setProfileSuccess(t('profilePage.profileUpdatedSuccessfully'));
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : t('profilePage.failedToUpdateProfile'));
    } finally {
      setIsUpdatingProfile(false);
    }
  };

  // --- Avatar upload handlers ---

  const validateAvatarFile = useCallback((file: File): string | null => {
    if (!ALLOWED_AVATAR_MIMES.includes(file.type)) {
      return t('profilePage.unsupportedAvatarType');
    }
    if (file.size > MAX_AVATAR_BYTES) {
      return t('profilePage.avatarTooLarge', { max: formatBytes(MAX_AVATAR_BYTES) });
    }
    if (file.size === 0) {
      return t('profilePage.fileIsEmpty');
    }
    return null;
  }, [t]);

  const clearAvatarMessages = useCallback(() => {
    setAvatarError(undefined);
    setAvatarSuccess(undefined);
  }, []);

  const selectAvatarFile = useCallback((file: File) => {
    clearAvatarMessages();
    const err = validateAvatarFile(file);
    if (err) {
      setAvatarError(err);
      return;
    }
    // Revoke any previous preview to avoid leaks.
    if (avatarPreview && avatarPreview.startsWith('blob:')) {
      URL.revokeObjectURL(avatarPreview);
    }
    setAvatarFile(file);
    setAvatarPreview(URL.createObjectURL(file));
  }, [avatarPreview, validateAvatarFile, clearAvatarMessages]);

  const cancelAvatarSelection = useCallback(() => {
    if (avatarPreview && avatarPreview.startsWith('blob:')) {
      URL.revokeObjectURL(avatarPreview);
    }
    setAvatarFile(null);
    setAvatarPreview(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [avatarPreview]);

  const handleAvatarUpload = useCallback(async () => {
    if (!avatarFile) return;
    clearAvatarMessages();

    try {
      setIsUploadingAvatar(true);
      const form = new FormData();
      form.append('file', avatarFile);
      // fetchWithAuth skips its default JSON content-type for FormData bodies so
      // the browser can set multipart/form-data with the correct boundary.
      const response = await fetchWithAuth('/users/me/avatar', {
        method: 'POST',
        body: form,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error ?? errorData.message ?? t('profilePage.failedToUploadAvatar'));
      }

      const data = await response.json();
      const newAvatarUrl: string = data.avatarUrl;
      setUser((prev) => (prev ? { ...prev, avatarUrl: newAvatarUrl } : prev));
      // Update the global auth store so the Header avatar refreshes immediately.
      updateAuthUser({ avatarUrl: newAvatarUrl });

      // Clear local preview state — the canonical URL will be used now.
      cancelAvatarSelection();
      setAvatarSuccess(t('profilePage.avatarUpdated'));
    } catch (error) {
      setAvatarError(error instanceof Error ? error.message : t('profilePage.failedToUploadAvatar'));
    } finally {
      setIsUploadingAvatar(false);
    }
  }, [avatarFile, clearAvatarMessages, cancelAvatarSelection, updateAuthUser]);

  const handleAvatarDelete = useCallback(async () => {
    clearAvatarMessages();
    try {
      setIsDeletingAvatar(true);
      const response = await fetchWithAuth('/users/me/avatar', { method: 'DELETE' });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error ?? errorData.message ?? t('profilePage.failedToRemoveAvatar'));
      }
      setUser((prev) => (prev ? { ...prev, avatarUrl: undefined } : prev));
      updateAuthUser({ avatarUrl: undefined });
      cancelAvatarSelection();
      setAvatarSuccess(t('profilePage.avatarRemoved'));
    } catch (error) {
      setAvatarError(error instanceof Error ? error.message : t('profilePage.failedToRemoveAvatar'));
    } finally {
      setIsDeletingAvatar(false);
    }
  }, [clearAvatarMessages, cancelAvatarSelection, updateAuthUser]);

  const handleAvatarFilePicked = useCallback((evt: React.ChangeEvent<HTMLInputElement>) => {
    const file = evt.target.files?.[0];
    if (file) selectAvatarFile(file);
  }, [selectAvatarFile]);

  const handleAvatarDrop = useCallback((evt: React.DragEvent<HTMLDivElement>) => {
    evt.preventDefault();
    setIsDragging(false);
    const file = evt.dataTransfer.files?.[0];
    if (file) selectAvatarFile(file);
  }, [selectAvatarFile]);

  // Clean up object URLs on unmount.
  useEffect(() => {
    return () => {
      if (avatarPreview && avatarPreview.startsWith('blob:')) {
        URL.revokeObjectURL(avatarPreview);
      }
    };
  }, [avatarPreview]);

  const handlePasswordChange = async (values: {
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
  }) => {
    setPasswordError(undefined);
    setPasswordSuccess(undefined);
    try {
      setIsChangingPassword(true);
      const response = await fetchWithAuth('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({
          currentPassword: values.currentPassword,
          newPassword: values.newPassword
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message ?? t('profilePage.failedToChangePassword'));
      }

      setPasswordSuccess(t('profilePage.passwordChangedSuccessfully'));
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : t('profilePage.failedToChangePassword'));
    } finally {
      setIsChangingPassword(false);
    }
  };

  const handleMfaRequestSetup = async (currentPassword: string): Promise<boolean> => {
    setMfaError(undefined);
    setMfaSuccess(undefined);
    // Clear any QR code from a prior aborted attempt before issuing a new one.
    setQrCodeDataUrl(undefined);
    try {
      setMfaLoading(true);
      const response = await fetchWithAuth('/auth/mfa/setup', {
        method: 'POST',
        body: JSON.stringify({ currentPassword })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.error ?? errorData.message ?? t('profilePage.failedToStartMfaHttp', { status: response.status })
        );
      }

      const data = await response.json();
      setQrCodeDataUrl(data.qrCodeDataUrl);
      return true;
    } catch (error) {
      setMfaError(error instanceof Error ? error.message : t('profilePage.failedToStartMFASetup'));
      return false;
    } finally {
      setMfaLoading(false);
    }
  };

  const handleMfaEnable = async (code: string, currentPassword: string) => {
    setMfaError(undefined);
    setMfaSuccess(undefined);
    try {
      setMfaLoading(true);
      const response = await fetchWithAuth('/auth/mfa/enable', {
        method: 'POST',
        body: JSON.stringify({ code, currentPassword })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.error ?? errorData.message ?? t('profilePage.failedToEnableMfaHttp', { status: response.status })
        );
      }

      const data = await response.json();
      // Keep mfaMethod in sync too — passkeyStepUpTier derives from it, and a
      // stale method would let a same-session "enable TOTP → add passkey" flow
      // skip the now-required add_factor step-up and 403.
      setUser(prev => (prev ? { ...prev, mfaEnabled: true, mfaMethod: 'totp' } : null));
      setRecoveryCodes(data.recoveryCodes);
      setMfaSuccess(t('profilePage.multiFactorAuthenticationEnabledSuccessfully'));
      setQrCodeDataUrl(undefined);
    } catch (error) {
      setMfaError(error instanceof Error ? error.message : t('profilePage.failedToEnableMFA'));
    } finally {
      setMfaLoading(false);
    }
  };

  const handleMfaDisable = async (code: string, currentPassword: string) => {
    setMfaError(undefined);
    setMfaSuccess(undefined);
    try {
      setMfaLoading(true);
      const response = await fetchWithAuth('/auth/mfa/disable', {
        method: 'POST',
        body: JSON.stringify({ code, currentPassword })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.error ?? errorData.message ?? t('profilePage.failedToDisableMfaHttp', { status: response.status })
        );
      }

      setUser(prev => (prev ? { ...prev, mfaEnabled: false, mfaMethod: null } : null));
      setRecoveryCodes(undefined);
      setMfaSuccess(t('profilePage.multiFactorAuthenticationDisabled'));
    } catch (error) {
      setMfaError(error instanceof Error ? error.message : t('profilePage.failedToDisableMFA'));
    } finally {
      setMfaLoading(false);
    }
  };

  const handleGenerateRecoveryCodes = async (currentPassword: string) => {
    setMfaError(undefined);
    setMfaSuccess(undefined);
    try {
      setMfaLoading(true);
      const response = await fetchWithAuth('/auth/mfa/recovery-codes', {
        method: 'POST',
        body: JSON.stringify({ currentPassword })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message ?? t('profilePage.failedToGenerateRecoveryCodes'));
      }

      const data = await response.json();
      setRecoveryCodes(data.recoveryCodes);
      setMfaSuccess(t('profilePage.newRecoveryCodesGenerated'));
    } catch (error) {
      setMfaError(error instanceof Error ? error.message : t('profilePage.failedToGenerateRecoveryCodes'));
    } finally {
      setMfaLoading(false);
    }
  };

  // Delegated from SecurityDevicesCard's add-passkey flow (the card owns its
  // own passkey/approver state; it doesn't own the `user` record). Mirrors
  // the side effects the old inline flow applied directly: mark the account
  // as MFA-enabled and surface any freshly-issued recovery codes.
  const handleFactorAdded = useCallback(({ recoveryCodes: newRecoveryCodes }: { recoveryCodes?: string[] }) => {
    setUser(prev => (prev ? { ...prev, mfaEnabled: true } : null));
    if (Array.isArray(newRecoveryCodes)) {
      setRecoveryCodes(newRecoveryCodes);
    }
  }, []);

  if (isLoadingUser) {
    return (
      <div className="flex u-min-h-px-400 items-center justify-center">
        <div className="text-sm text-muted-foreground">{t('profilePage.loadingProfile')}</div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t('profilePage.profileSettings')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('profilePage.manageYourAccountSettingsAndSecurityPreferences')}</p>
      </div>

      {/* Profile Information */}
      <form
        onSubmit={handleSubmit(handleProfileSubmit)}
        className="space-y-6 rounded-lg border bg-card p-6 shadow-xs"
      >
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{t('profilePage.profileInformation')}</h2>
          <p className="text-sm text-muted-foreground">{t('profilePage.updateYourPersonalDetails')}</p>
        </div>

        <div className="space-y-3">
          <p className="text-sm font-medium">{t('profilePage.avatar')}</p>
          <div className="flex items-start gap-4">
            <div
              data-testid="avatar-dropzone"
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleAvatarDrop}
              className={`flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-full border text-xl font-medium ${
                isDragging
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-transparent bg-muted text-muted-foreground'
              }`}
            >
              {previewAvatarUrl ? (
                <img
                  src={previewAvatarUrl}
                  alt={user?.name ?? t('profilePage.userAvatar')}
                  className="h-24 w-24 rounded-full object-cover"
                />
              ) : (
                user?.name?.charAt(0).toUpperCase() ?? '?'
              )}
            </div>
            <div className="flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={handleAvatarFilePicked}
                  data-testid="avatar-file-input"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isUploadingAvatar || isDeletingAvatar}
                  className="rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {t('profilePage.uploadNewPicture')}</button>
                {user?.avatarUrl && !avatarFile && (
                  <button
                    type="button"
                    onClick={handleAvatarDelete}
                    disabled={isUploadingAvatar || isDeletingAvatar}
                    className="rounded-md border px-3 py-1.5 text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isDeletingAvatar ? t('profilePage.removing') : t('profilePage.remove')}
                  </button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {t('profilePage.pNGJPGOrWebPMax5MBDragAndDropOntoTheCircleOrClickUpload')}</p>
              {avatarFile && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
                  <span className="truncate">{avatarFile.name}</span>
                  <span className="text-xs text-muted-foreground">{formatBytes(avatarFile.size)}</span>
                  <div className="ml-auto flex gap-2">
                    <button
                      type="button"
                      onClick={handleAvatarUpload}
                      disabled={isUploadingAvatar}
                      className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isUploadingAvatar ? t('profilePage.uploading') : t('profilePage.upload')}
                    </button>
                    <button
                      type="button"
                      onClick={cancelAvatarSelection}
                      disabled={isUploadingAvatar}
                      className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {t('profilePage.cancel')}</button>
                  </div>
                </div>
              )}
              {avatarError && (
                <p className="text-sm text-destructive" role="alert">{avatarError}</p>
              )}
              {avatarSuccess && (
                <p className="text-sm text-emerald-600" role="status">{avatarSuccess}</p>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <label htmlFor="name" className="text-sm font-medium">
            {t('profilePage.name')}</label>
          <input
            id="name"
            type="text"
            autoComplete="name"
            placeholder={t('profilePage.yourName')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            {...register('name')}
          />
          {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
        </div>

        <div className="space-y-2">
          <label htmlFor="email" className="text-sm font-medium">
            {t('profilePage.email')}</label>
          <input
            id="email"
            type="email"
            value={user?.email ?? ''}
            disabled
            className="h-10 w-full rounded-md border bg-muted px-3 text-sm text-muted-foreground"
          />
          <p className="text-xs text-muted-foreground">
            {t('profilePage.emailCannotBeChangedContactSupportForAssistance')}</p>
        </div>

        {profileError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {profileError}
          </div>
        )}

        {profileSuccess && (
          <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-600">
            {profileSuccess}
          </div>
        )}

        <button
          type="submit"
          disabled={isProfileLoading}
          className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isProfileLoading ? t('profilePage.saving') : t('profilePage.saveChanges')}
        </button>
      </form>

      {/* Security devices group: password, TOTP MFA, SSO, and the unified
          security-devices card (unified-security-devices Phase 2, Task 7) —
          previously two separate groups ("Sign-in security" / "Approvals")
          collapsed into one since the card below merges both capabilities
          into a single per-device list. */}
      <div className="space-y-1 border-t pt-6" data-testid="security-devices-heading">
        <h2 className="text-lg font-semibold">{t('profilePage.securityDevices')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('profilePage.securityDevicesDescription')}</p>
      </div>

      {/* Change Password */}
      <ChangePasswordForm
        onSubmit={handlePasswordChange}
        errorMessage={passwordError}
        successMessage={passwordSuccess}
        loading={isChangingPassword}
      />

      {/* MFA Settings */}
      <MFASettings
        enabled={user?.mfaEnabled ?? false}
        qrCodeDataUrl={qrCodeDataUrl}
        recoveryCodes={recoveryCodes}
        onRequestSetup={handleMfaRequestSetup}
        onEnable={handleMfaEnable}
        onDisable={handleMfaDisable}
        onGenerateRecoveryCodes={handleGenerateRecoveryCodes}
        errorMessage={mfaError}
        successMessage={mfaSuccess}
        loading={mfaLoading}
      />

      {/* Connect SSO (self-service identity linking, #2183) */}
      <ConnectSsoCard />

      {/* Security devices (unified-security-devices Phase 2): merges the old
          Passkeys card (sign-in factors) and Approval-security section
          (Breeze Authenticator approval devices) into one per-device list. */}
      <SecurityDevicesCard
        mfaEnabled={user?.mfaEnabled ?? false}
        mfaMethod={user?.mfaMethod ?? null}
        onFactorAdded={handleFactorAdded}
      />
      <ThemingSettings
        preferences={user?.preferences}
        onSaved={(preferences) => setUser(prev => (prev ? { ...prev, preferences } : prev))}
      />

      {/* Onboarding */}
      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <h2 className="text-lg font-semibold">{t('profilePage.onboarding')}</h2>
        <p className="text-sm text-muted-foreground mt-1 mb-4">
          {t('profilePage.resetTheProductTourToSeeTheWelcomeWalkthroughAgain')}</p>
        {tourResetMsg && (
          <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-600 mb-3">
            {tourResetMsg}
          </div>
        )}
        <button
          type="button"
          onClick={() => {
            try {
              localStorage.removeItem('breeze-onboarding-complete');
              setTourResetMsg('Tour reset. It will appear on your next page load.');
              setTimeout(() => setTourResetMsg(undefined), 4000);
            } catch { /* ignore */ }
          }}
          className="rounded-md border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors"
        >
          {t('profilePage.restartTour')}</button>
      </div>
    </div>
  );
}
