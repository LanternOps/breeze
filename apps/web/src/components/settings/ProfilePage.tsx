import { useCallback, useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import ChangePasswordForm from './ChangePasswordForm';
import MFASettings from './MFASettings';

const profileSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  avatarUrl: z.string().optional()
});

type ProfileFormValues = z.infer<typeof profileSchema>;

type User = {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string;
  mfaEnabled?: boolean;
};

type ProfilePageProps = {
  initialUser?: User;
};

export default function ProfilePage({ initialUser }: ProfilePageProps) {
  const [user, setUser] = useState<User | null>(initialUser ?? null);
  const [isLoadingUser, setIsLoadingUser] = useState(!initialUser);
  const [profileError, setProfileError] = useState<string | undefined>();
  const [profileSuccess, setProfileSuccess] = useState<string | undefined>();
  const [passwordError, setPasswordError] = useState<string | undefined>();
  const [passwordSuccess, setPasswordSuccess] = useState<string | undefined>();
  const [mfaError, setMfaError] = useState<string | undefined>();
  const [mfaSuccess, setMfaSuccess] = useState<string | undefined>();
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | undefined>();
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | undefined>();
  const [isUpdatingProfile, setIsUpdatingProfile] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [mfaLoading, setMfaLoading] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting }
  } = useForm<ProfileFormValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      name: user?.name ?? '',
      avatarUrl: user?.avatarUrl ?? ''
    }
  });

  const isProfileLoading = useMemo(
    () => isUpdatingProfile || isSubmitting,
    [isUpdatingProfile, isSubmitting]
  );

  // Fetch user data on mount
  useEffect(() => {
    if (initialUser) {
      return;
    }

    const fetchUser = async () => {
      try {
        setIsLoadingUser(true);
        const response = await fetch('/api/users/me');
        if (!response.ok) {
          throw new Error('Failed to fetch user data');
        }
        const userData = await response.json();
        setUser(userData);
        reset({
          name: userData.name ?? '',
          avatarUrl: userData.avatarUrl ?? ''
        });
      } catch {
        setProfileError('Failed to load profile data');
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
      const response = await fetch('/api/users/me', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(values)
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message ?? 'Failed to update profile');
      }

      const updatedUser = await response.json();
      setUser(updatedUser);
      setProfileSuccess('Profile updated successfully');
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : 'Failed to update profile');
    } finally {
      setIsUpdatingProfile(false);
    }
  };

  const handlePasswordChange = async (values: {
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
  }) => {
    setPasswordError(undefined);
    setPasswordSuccess(undefined);
    try {
      setIsChangingPassword(true);
      const response = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
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

  const handleMfaRequestSetup = async () => {
    setMfaError(undefined);
    setMfaSuccess(undefined);
    try {
      setMfaLoading(true);
      const response = await fetch('/api/auth/mfa/setup', {
        method: 'POST'
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message ?? 'Failed to start MFA setup');
      }

      const data = await response.json();
      setQrCodeDataUrl(data.qrCodeDataUrl);
    } catch (error) {
      setMfaError(error instanceof Error ? error.message : 'Failed to start MFA setup');
    } finally {
      setMfaLoading(false);
    }
  };

  const handleMfaEnable = async (code: string) => {
    setMfaError(undefined);
    setMfaSuccess(undefined);
    try {
      setMfaLoading(true);
      const response = await fetch('/api/auth/mfa/enable', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ code })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message ?? 'Failed to enable MFA');
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

  const handleMfaDisable = async (code: string) => {
    setMfaError(undefined);
    setMfaSuccess(undefined);
    try {
      setMfaLoading(true);
      const response = await fetch('/api/auth/mfa/disable', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ code })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message ?? 'Failed to disable MFA');
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

  const handleGenerateRecoveryCodes = async () => {
    setMfaError(undefined);
    setMfaSuccess(undefined);
    try {
      setMfaLoading(true);
      const response = await fetch('/api/auth/mfa/recovery-codes', {
        method: 'POST'
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
        <h1 className="text-2xl font-bold">Profile settings</h1>
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

        <div className="flex items-center gap-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-lg font-medium text-muted-foreground">
            {user?.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt={user.name}
                className="h-16 w-16 rounded-full object-cover"
              />
            ) : (
              user?.name?.charAt(0).toUpperCase() ?? '?'
            )}
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium">Avatar</p>
            <p className="text-xs text-muted-foreground">
              Click to upload a new avatar (coming soon)
            </p>
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
    </div>
  );
}
