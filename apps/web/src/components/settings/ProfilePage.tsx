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
import ApproverDevicesSection from './ApproverDevicesSection';
import ThemingSettings from './ThemingSettings';
import { createPasskeyCredential, fetchWithAuth, useAuthStore } from '../../stores/auth';
import type { PasskeyRegistrationOptions, UserPreferences } from '../../stores/auth';
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

type PasskeySummary = {
  id: string;
  name: string;
  createdAt?: string;
  lastUsedAt?: string | null;
};

const ALLOWED_AVATAR_MIMES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${formatNumber(n / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} KB`;
  return `${formatNumber(n / (1024 * 1024), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}

function formatPasskeyDate(value?: string | null): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
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
  const [passkeys, setPasskeys] = useState<PasskeySummary[]>([]);
  const [passkeyName, setPasskeyName] = useState('');
  const [passkeyPassword, setPasskeyPassword] = useState('');
  const [passkeyError, setPasskeyError] = useState<string | undefined>();
  const [passkeySuccess, setPasskeySuccess] = useState<string | undefined>();
  const [isLoadingPasskeys, setIsLoadingPasskeys] = useState(false);
  const [isAddingPasskey, setIsAddingPasskey] = useState(false);
  const [editingPasskeyId, setEditingPasskeyId] = useState<string | null>(null);
  const [editingPasskeyName, setEditingPasskeyName] = useState('');
  const [mutatingPasskeyId, setMutatingPasskeyId] = useState<string | null>(null);
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

  const loadPasskeys = useCallback(async () => {
    try {
      setIsLoadingPasskeys(true);
      const response = await fetchWithAuth('/auth/passkeys');
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error ?? errorData.message ?? t('profilePage.failedToLoadPasskeys'));
      }
      const data = await response.json();
      setPasskeys(Array.isArray(data) ? data : data.passkeys ?? []);
    } catch (error) {
      setPasskeyError(error instanceof Error ? error.message : t('profilePage.failedToLoadPasskeys'));
    } finally {
      setIsLoadingPasskeys(false);
    }
  }, []);

  useEffect(() => {
    loadPasskeys();
  }, [loadPasskeys]);

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
      setUser(prev => (prev ? { ...prev, mfaEnabled: true } : null));
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

      setUser(prev => (prev ? { ...prev, mfaEnabled: false } : null));
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

  const handleAddPasskey = async () => {
    if (!passkeyPassword || isAddingPasskey) return;
    setPasskeyError(undefined);
    setPasskeySuccess(undefined);
    try {
      setIsAddingPasskey(true);
      const label = passkeyName.trim() || 'Passkey';
      const optionsResponse = await fetchWithAuth('/auth/passkeys/register/options', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: passkeyPassword, name: label })
      });

      const optionsData = await optionsResponse.json().catch(() => ({}));
      if (!optionsResponse.ok) {
        throw new Error(
          optionsData.error ?? optionsData.message ?? t('profilePage.failedToStartPasskeyHttp', { status: optionsResponse.status })
        );
      }

      const optionsJSON = (optionsData.options ?? optionsData.optionsJSON) as PasskeyRegistrationOptions;
      const credential = await createPasskeyCredential(optionsJSON);
      const verifyResponse = await fetchWithAuth('/auth/passkeys/register/verify', {
        method: 'POST',
        body: JSON.stringify({ name: label, credential })
      });

      const verifyData = await verifyResponse.json().catch(() => ({}));
      if (!verifyResponse.ok) {
        throw new Error(
          verifyData.error ?? verifyData.message ?? t('profilePage.failedToSavePasskeyHttp', { status: verifyResponse.status })
        );
      }

      setUser(prev => (prev ? { ...prev, mfaEnabled: true } : null));
      setPasskeyName('');
      setPasskeyPassword('');
      if (Array.isArray(verifyData.recoveryCodes)) {
        setRecoveryCodes(verifyData.recoveryCodes);
      }
      setPasskeySuccess(t('profilePage.passkeyAdded'));
      await loadPasskeys();
    } catch (error) {
      if (error instanceof Error && error.name === 'NotAllowedError') {
        setPasskeyError(t('profilePage.passkeySetupWasCanceledOrTimedOut'));
      } else {
        setPasskeyError(error instanceof Error ? error.message : t('profilePage.failedToAddPasskey'));
      }
    } finally {
      setIsAddingPasskey(false);
    }
  };

  const handleRenamePasskey = async (passkeyId: string) => {
    const name = editingPasskeyName.trim();
    if (!name || mutatingPasskeyId) return;
    setPasskeyError(undefined);
    setPasskeySuccess(undefined);
    try {
      setMutatingPasskeyId(passkeyId);
      const response = await fetchWithAuth(`/auth/passkeys/${encodeURIComponent(passkeyId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error ?? data.message ?? t('profilePage.failedToRenamePasskeyHttp', { status: response.status }));
      }
      setPasskeys(prev => prev.map(passkey => (
        passkey.id === passkeyId ? { ...passkey, name: data.passkey?.name ?? name } : passkey
      )));
      setEditingPasskeyId(null);
      setEditingPasskeyName('');
      setPasskeySuccess(t('profilePage.passkeyRenamed'));
    } catch (error) {
      setPasskeyError(error instanceof Error ? error.message : t('profilePage.failedToRenamePasskey'));
    } finally {
      setMutatingPasskeyId(null);
    }
  };

  const handleDeletePasskey = async (passkeyId: string) => {
    if (mutatingPasskeyId) return;
    setPasskeyError(undefined);
    setPasskeySuccess(undefined);
    if (!passkeyPassword) {
      setPasskeyError(t('profilePage.currentPasswordIsRequiredToDeleteAPasskey'));
      return;
    }
    try {
      setMutatingPasskeyId(passkeyId);
      const response = await fetchWithAuth(`/auth/passkeys/${encodeURIComponent(passkeyId)}`, {
        method: 'DELETE',
        body: JSON.stringify({ currentPassword: passkeyPassword })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error ?? data.message ?? t('profilePage.failedToDeletePasskeyHttp', { status: response.status }));
      }
      setPasskeys(prev => prev.filter(passkey => passkey.id !== passkeyId));
      setPasskeyPassword('');
      setPasskeySuccess(t('profilePage.passkeyDeleted'));
    } catch (error) {
      setPasskeyError(error instanceof Error ? error.message : t('profilePage.failedToDeletePasskey'));
    } finally {
      setMutatingPasskeyId(null);
    }
  };

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

      {/* Passkeys */}
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-xs">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">{t('profilePage.passkeys')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('profilePage.managePasskeysThatCanBeUsedAsMultiFactorAuthenticationFo')}</p>
        </div>

        <div className="space-y-3">
          {isLoadingPasskeys ? (
            <div className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
              {t('profilePage.loadingPasskeys')}</div>
          ) : passkeys.length ? (
            passkeys.map(passkey => (
              <div key={passkey.id} className="rounded-md border bg-muted/30 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    {editingPasskeyId === passkey.id ? (
                      <input
                        type="text"
                        value={editingPasskeyName}
                        onChange={event => setEditingPasskeyName(event.target.value)}
                        className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                        disabled={mutatingPasskeyId === passkey.id}
                        autoFocus
                      />
                    ) : (
                      <p className="truncate text-sm font-medium">{passkey.name || t('profilePage.passkey')}</p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {t('profilePage.lastUsed')}{formatPasskeyDate(passkey.lastUsedAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {editingPasskeyId === passkey.id ? (
                      <>
                        <button
                          type="button"
                          onClick={() => handleRenamePasskey(passkey.id)}
                          disabled={!editingPasskeyName.trim() || mutatingPasskeyId === passkey.id}
                          className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {mutatingPasskeyId === passkey.id ? t('profilePage.saving') : t('profilePage.save')}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingPasskeyId(null);
                            setEditingPasskeyName('');
                          }}
                          disabled={mutatingPasskeyId === passkey.id}
                          className="h-9 rounded-md border px-3 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {t('profilePage.cancel')}</button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingPasskeyId(passkey.id);
                            setEditingPasskeyName(passkey.name || 'Passkey');
                            setPasskeyError(undefined);
                            setPasskeySuccess(undefined);
                          }}
                          disabled={!!mutatingPasskeyId}
                          className="h-9 rounded-md border px-3 text-sm font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {t('profilePage.rename')}</button>
                        <button
                          type="button"
                          onClick={() => handleDeletePasskey(passkey.id)}
                          disabled={!!mutatingPasskeyId}
                          className="h-9 rounded-md border border-destructive/40 px-3 text-sm font-medium text-destructive transition hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {mutatingPasskeyId === passkey.id ? t('profilePage.deleting') : t('profilePage.delete')}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))
          ) : (
            <div className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
              {t('profilePage.noPasskeysAreRegisteredForThisAccount')}</div>
          )}
        </div>

        <div className="space-y-4 rounded-md border p-4">
          <div className="space-y-1">
            <h3 className="text-sm font-medium">{t('profilePage.addPasskey')}</h3>
            <p className="text-xs text-muted-foreground">
              {t('profilePage.reEnterYourAccountPasswordBeforeAddingOrDeletingAPasskey')}</p>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="passkey-name">
              {t('profilePage.passkeyName')}</label>
            <input
              id="passkey-name"
              type="text"
              value={passkeyName}
              onChange={event => setPasskeyName(event.target.value)}
              placeholder={t('profilePage.macBookTouchID')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              disabled={isAddingPasskey}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="passkey-password">
              {t('profilePage.currentPassword')}</label>
            <input
              id="passkey-password"
              type="password"
              autoComplete="current-password"
              value={passkeyPassword}
              onChange={event => setPasskeyPassword(event.target.value)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              disabled={isAddingPasskey}
            />
          </div>
          <button
            type="button"
            onClick={handleAddPasskey}
            disabled={isAddingPasskey || !passkeyPassword}
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isAddingPasskey ? t('profilePage.adding') : t('profilePage.addPasskey')}
          </button>
        </div>

        {passkeySuccess && (
          <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-600">
            {passkeySuccess}
          </div>
        )}
        {passkeyError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {passkeyError}
          </div>
        )}
      </div>

      {/* Approval security (Breeze Authenticator) */}
      <ApproverDevicesSection passkeyCount={passkeys.length} mfaMethod={user?.mfaMethod ?? null} />
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
