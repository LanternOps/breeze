import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import ChangePasswordForm from './ChangePasswordForm';
import MFASettings from './MFASettings';
import { createPasskeyCredential, fetchWithAuth, useAuthStore } from '../../stores/auth';
import type { PasskeyRegistrationOptions } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import { useAvatarBlobUrl } from '@/lib/avatarBlobCache';

const profileSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
});

type ProfileFormValues = z.infer<typeof profileSchema>;

type User = {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string;
  mfaEnabled?: boolean;
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
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
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
    resolver: zodResolver(profileSchema),
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
          throw new Error('Failed to fetch user data');
        }
        const userData = await response.json();
        setUser(userData);
        reset({
          name: userData.name ?? '',
        });
      } catch {
        setProfileError('Failed to load profile data');
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
        throw new Error(errorData.error ?? errorData.message ?? 'Failed to load passkeys');
      }
      const data = await response.json();
      setPasskeys(Array.isArray(data) ? data : data.passkeys ?? []);
    } catch (error) {
      setPasskeyError(error instanceof Error ? error.message : 'Failed to load passkeys');
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
        throw new Error(errorData.message ?? 'Failed to update profile');
      }

      const updatedUser = await response.json();
      setUser(updatedUser);
      reset({
        name: updatedUser.name ?? '',
      });
      setProfileSuccess('Profile updated successfully');
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : 'Failed to update profile');
    } finally {
      setIsUpdatingProfile(false);
    }
  };

  // --- Avatar upload handlers ---

  const validateAvatarFile = useCallback((file: File): string | null => {
    if (!ALLOWED_AVATAR_MIMES.includes(file.type)) {
      return 'Unsupported file type. Use PNG, JPG, or WebP.';
    }
    if (file.size > MAX_AVATAR_BYTES) {
      return `File is too large (max ${formatBytes(MAX_AVATAR_BYTES)}).`;
    }
    if (file.size === 0) {
      return 'File is empty.';
    }
    return null;
  }, []);

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
        throw new Error(errorData.error ?? errorData.message ?? 'Failed to upload avatar');
      }

      const data = await response.json();
      const newAvatarUrl: string = data.avatarUrl;
      setUser((prev) => (prev ? { ...prev, avatarUrl: newAvatarUrl } : prev));
      // Update the global auth store so the Header avatar refreshes immediately.
      updateAuthUser({ avatarUrl: newAvatarUrl });

      // Clear local preview state — the canonical URL will be used now.
      cancelAvatarSelection();
      setAvatarSuccess('Avatar updated.');
    } catch (error) {
      setAvatarError(error instanceof Error ? error.message : 'Failed to upload avatar');
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
        throw new Error(errorData.error ?? errorData.message ?? 'Failed to remove avatar');
      }
      setUser((prev) => (prev ? { ...prev, avatarUrl: undefined } : prev));
      updateAuthUser({ avatarUrl: undefined });
      cancelAvatarSelection();
      setAvatarSuccess('Avatar removed.');
    } catch (error) {
      setAvatarError(error instanceof Error ? error.message : 'Failed to remove avatar');
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
        throw new Error(errorData.message ?? 'Failed to change password');
      }

      setPasswordSuccess('Password changed successfully');
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : 'Failed to change password');
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
          errorData.error ?? errorData.message ?? `Failed to start MFA setup (HTTP ${response.status})`
        );
      }

      const data = await response.json();
      setQrCodeDataUrl(data.qrCodeDataUrl);
      return true;
    } catch (error) {
      setMfaError(error instanceof Error ? error.message : 'Failed to start MFA setup');
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
          errorData.error ?? errorData.message ?? `Failed to enable MFA (HTTP ${response.status})`
        );
      }

      const data = await response.json();
      setUser(prev => (prev ? { ...prev, mfaEnabled: true } : null));
      setRecoveryCodes(data.recoveryCodes);
      setMfaSuccess('Multi-factor authentication enabled successfully');
      setQrCodeDataUrl(undefined);
    } catch (error) {
      setMfaError(error instanceof Error ? error.message : 'Failed to enable MFA');
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
          errorData.error ?? errorData.message ?? `Failed to disable MFA (HTTP ${response.status})`
        );
      }

      setUser(prev => (prev ? { ...prev, mfaEnabled: false } : null));
      setRecoveryCodes(undefined);
      setMfaSuccess('Multi-factor authentication disabled');
    } catch (error) {
      setMfaError(error instanceof Error ? error.message : 'Failed to disable MFA');
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
        throw new Error(errorData.message ?? 'Failed to generate recovery codes');
      }

      const data = await response.json();
      setRecoveryCodes(data.recoveryCodes);
      setMfaSuccess('New recovery codes generated');
    } catch (error) {
      setMfaError(error instanceof Error ? error.message : 'Failed to generate recovery codes');
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
          optionsData.error ?? optionsData.message ?? `Failed to start passkey setup (HTTP ${optionsResponse.status})`
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
          verifyData.error ?? verifyData.message ?? `Failed to save passkey (HTTP ${verifyResponse.status})`
        );
      }

      setUser(prev => (prev ? { ...prev, mfaEnabled: true } : null));
      setPasskeyName('');
      setPasskeyPassword('');
      if (Array.isArray(verifyData.recoveryCodes)) {
        setRecoveryCodes(verifyData.recoveryCodes);
      }
      setPasskeySuccess('Passkey added');
      await loadPasskeys();
    } catch (error) {
      if (error instanceof Error && error.name === 'NotAllowedError') {
        setPasskeyError('Passkey setup was canceled or timed out');
      } else {
        setPasskeyError(error instanceof Error ? error.message : 'Failed to add passkey');
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
        throw new Error(data.error ?? data.message ?? `Failed to rename passkey (HTTP ${response.status})`);
      }
      setPasskeys(prev => prev.map(passkey => (
        passkey.id === passkeyId ? { ...passkey, name: data.passkey?.name ?? name } : passkey
      )));
      setEditingPasskeyId(null);
      setEditingPasskeyName('');
      setPasskeySuccess('Passkey renamed');
    } catch (error) {
      setPasskeyError(error instanceof Error ? error.message : 'Failed to rename passkey');
    } finally {
      setMutatingPasskeyId(null);
    }
  };

  const handleDeletePasskey = async (passkeyId: string) => {
    if (mutatingPasskeyId) return;
    setPasskeyError(undefined);
    setPasskeySuccess(undefined);
    if (!passkeyPassword) {
      setPasskeyError('Current password is required to delete a passkey');
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
        throw new Error(data.error ?? data.message ?? `Failed to delete passkey (HTTP ${response.status})`);
      }
      setPasskeys(prev => prev.filter(passkey => passkey.id !== passkeyId));
      setPasskeyPassword('');
      setPasskeySuccess('Passkey deleted');
    } catch (error) {
      setPasskeyError(error instanceof Error ? error.message : 'Failed to delete passkey');
    } finally {
      setMutatingPasskeyId(null);
    }
  };

  if (isLoadingUser) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="text-sm text-muted-foreground">Loading profile...</div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Profile settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage your account settings and security preferences.
        </p>
      </div>

      {/* Profile Information */}
      <form
        onSubmit={handleSubmit(handleProfileSubmit)}
        className="space-y-6 rounded-lg border bg-card p-6 shadow-sm"
      >
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Profile information</h2>
          <p className="text-sm text-muted-foreground">Update your personal details.</p>
        </div>

        <div className="space-y-3">
          <p className="text-sm font-medium">Avatar</p>
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
                  alt={user?.name ?? 'User avatar'}
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
                  Upload new picture
                </button>
                {user?.avatarUrl && !avatarFile && (
                  <button
                    type="button"
                    onClick={handleAvatarDelete}
                    disabled={isUploadingAvatar || isDeletingAvatar}
                    className="rounded-md border px-3 py-1.5 text-sm font-medium text-destructive hover:bg-destructive/10 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isDeletingAvatar ? 'Removing...' : 'Remove'}
                  </button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                PNG, JPG, or WebP. Max 5 MB. Drag and drop onto the circle, or click Upload.
              </p>
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
                      {isUploadingAvatar ? 'Uploading...' : 'Upload'}
                    </button>
                    <button
                      type="button"
                      onClick={cancelAvatarSelection}
                      disabled={isUploadingAvatar}
                      className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Cancel
                    </button>
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
            Name
          </label>
          <input
            id="name"
            type="text"
            autoComplete="name"
            placeholder="Your name"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            {...register('name')}
          />
          {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
        </div>

        <div className="space-y-2">
          <label htmlFor="email" className="text-sm font-medium">
            Email
          </label>
          <input
            id="email"
            type="email"
            value={user?.email ?? ''}
            disabled
            className="h-10 w-full rounded-md border bg-muted px-3 text-sm text-muted-foreground"
          />
          <p className="text-xs text-muted-foreground">
            Email cannot be changed. Contact support for assistance.
          </p>
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
          {isProfileLoading ? 'Saving...' : 'Save changes'}
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

      {/* Passkeys */}
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Passkeys</h2>
          <p className="text-sm text-muted-foreground">
            Manage passkeys that can be used as multi-factor authentication for your account.
          </p>
        </div>

        <div className="space-y-3">
          {isLoadingPasskeys ? (
            <div className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
              Loading passkeys...
            </div>
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
                      <p className="truncate text-sm font-medium">{passkey.name || 'Passkey'}</p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Last used: {formatPasskeyDate(passkey.lastUsedAt)}
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
                          {mutatingPasskeyId === passkey.id ? 'Saving...' : 'Save'}
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
                          Cancel
                        </button>
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
                          Rename
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeletePasskey(passkey.id)}
                          disabled={!!mutatingPasskeyId}
                          className="h-9 rounded-md border border-destructive/40 px-3 text-sm font-medium text-destructive transition hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {mutatingPasskeyId === passkey.id ? 'Deleting...' : 'Delete'}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))
          ) : (
            <div className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
              No passkeys are registered for this account.
            </div>
          )}
        </div>

        <div className="space-y-4 rounded-md border p-4">
          <div className="space-y-1">
            <h3 className="text-sm font-medium">Add passkey</h3>
            <p className="text-xs text-muted-foreground">
              Re-enter your account password before adding or deleting a passkey.
            </p>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="passkey-name">
              Passkey name
            </label>
            <input
              id="passkey-name"
              type="text"
              value={passkeyName}
              onChange={event => setPasskeyName(event.target.value)}
              placeholder="MacBook Touch ID"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              disabled={isAddingPasskey}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="passkey-password">
              Current password
            </label>
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
            {isAddingPasskey ? 'Adding...' : 'Add passkey'}
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

      {/* Onboarding */}
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold">Onboarding</h2>
        <p className="text-sm text-muted-foreground mt-1 mb-4">
          Reset the product tour to see the welcome walkthrough again.
        </p>
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
          Restart tour
        </button>
      </div>
    </div>
  );
}
