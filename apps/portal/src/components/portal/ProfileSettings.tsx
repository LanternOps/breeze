import React, { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, AlertCircle, CheckCircle, User, Lock } from 'lucide-react';
import { usePortalAuth } from '@/lib/auth';
import { portalApi } from '@/lib/api';
import { cn } from '@/lib/utils';

const profileSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  email: z.string().email('Please enter a valid email address')
});

const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
      .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
      .regex(/[0-9]/, 'Password must contain at least one number'),
    confirmPassword: z.string()
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords don't match",
    path: ['confirmPassword']
  });

type ProfileFormData = z.infer<typeof profileSchema>;
type PasswordFormData = z.infer<typeof passwordSchema>;

export function ProfileSettings() {
  const { user, updateUser } = usePortalAuth();
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileSuccess, setProfileSuccess] = useState(false);
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState(false);

  const profileForm = useForm<ProfileFormData>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      name: user?.name || '',
      email: user?.email || ''
    }
  });

  const passwordForm = useForm<PasswordFormData>({
    resolver: zodResolver(passwordSchema)
  });

  useEffect(() => {
    if (user) {
      profileForm.reset({
        name: user.name,
        email: user.email
      });
    }
  }, [user]);

  const onProfileSubmit = async (data: ProfileFormData) => {
    setProfileLoading(true);
    setProfileError(null);
    setProfileSuccess(false);

    const result = await portalApi.updateProfile(data);

    if (result.error) {
      setProfileError(result.error);
    } else {
      updateUser(data);
      setProfileSuccess(true);
      setTimeout(() => setProfileSuccess(false), 3000);
    }

    setProfileLoading(false);
  };

  const onPasswordSubmit = async (data: PasswordFormData) => {
    setPasswordLoading(true);
    setPasswordError(null);
    setPasswordSuccess(false);

    const result = await portalApi.changePassword({
      currentPassword: data.currentPassword,
      newPassword: data.newPassword
    });

    if (result.error) {
      setPasswordError(result.error);
    } else {
      setPasswordSuccess(true);
      passwordForm.reset();
      setTimeout(() => setPasswordSuccess(false), 3000);
    }

    setPasswordLoading(false);
  };

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      {/* Profile Information */}
      <div className="rounded-lg border bg-card">
        <div className="border-b p-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <User className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">Profile Information</h2>
              <p className="text-sm text-muted-foreground">
                Update your account details
              </p>
            </div>
          </div>
        </div>

        <form onSubmit={profileForm.handleSubmit(onProfileSubmit)} className="p-6">
          {profileError && (
            <div className="mb-4 flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {profileError}
            </div>
          )}

          {profileSuccess && (
            <div className="mb-4 flex items-center gap-2 rounded-md bg-success/10 p-3 text-sm text-success">
              <CheckCircle className="h-4 w-4" />
              Profile updated successfully
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label
                htmlFor="name"
                className="block text-sm font-medium text-foreground"
              >
                Name
              </label>
              <input
                id="name"
                type="text"
                {...profileForm.register('name')}
                className={cn(
                  'mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm shadow-sm',
                  'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary',
                  profileForm.formState.errors.name && 'border-destructive'
                )}
              />
              {profileForm.formState.errors.name && (
                <p className="mt-1 text-sm text-destructive">
                  {profileForm.formState.errors.name.message}
                </p>
              )}
            </div>

            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-foreground"
              >
                Email
              </label>
              <input
                id="email"
                type="email"
                {...profileForm.register('email')}
                className={cn(
                  'mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm shadow-sm',
                  'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary',
                  profileForm.formState.errors.email && 'border-destructive'
                )}
              />
              {profileForm.formState.errors.email && (
                <p className="mt-1 text-sm text-destructive">
                  {profileForm.formState.errors.email.message}
                </p>
              )}
            </div>

            <div className="pt-2">
              <button
                type="submit"
                disabled={profileLoading}
                className={cn(
                  'flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground',
                  'hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2',
                  'disabled:cursor-not-allowed disabled:opacity-50'
                )}
              >
                {profileLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                Save Changes
              </button>
            </div>
          </div>
        </form>
      </div>

      {/* Change Password */}
      <div className="rounded-lg border bg-card">
        <div className="border-b p-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <Lock className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h2 className="text-lg font-semibold">Change Password</h2>
              <p className="text-sm text-muted-foreground">
                Update your password for security
              </p>
            </div>
          </div>
        </div>

        <form onSubmit={passwordForm.handleSubmit(onPasswordSubmit)} className="p-6">
          {passwordError && (
            <div className="mb-4 flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {passwordError}
            </div>
          )}

          {passwordSuccess && (
            <div className="mb-4 flex items-center gap-2 rounded-md bg-success/10 p-3 text-sm text-success">
              <CheckCircle className="h-4 w-4" />
              Password changed successfully
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label
                htmlFor="currentPassword"
                className="block text-sm font-medium text-foreground"
              >
                Current Password
              </label>
              <input
                id="currentPassword"
                type="password"
                {...passwordForm.register('currentPassword')}
                className={cn(
                  'mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm shadow-sm',
                  'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary',
                  passwordForm.formState.errors.currentPassword &&
                    'border-destructive'
                )}
              />
              {passwordForm.formState.errors.currentPassword && (
                <p className="mt-1 text-sm text-destructive">
                  {passwordForm.formState.errors.currentPassword.message}
                </p>
              )}
            </div>

            <div>
              <label
                htmlFor="newPassword"
                className="block text-sm font-medium text-foreground"
              >
                New Password
              </label>
              <input
                id="newPassword"
                type="password"
                {...passwordForm.register('newPassword')}
                className={cn(
                  'mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm shadow-sm',
                  'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary',
                  passwordForm.formState.errors.newPassword && 'border-destructive'
                )}
              />
              {passwordForm.formState.errors.newPassword && (
                <p className="mt-1 text-sm text-destructive">
                  {passwordForm.formState.errors.newPassword.message}
                </p>
              )}
            </div>

            <div>
              <label
                htmlFor="confirmPassword"
                className="block text-sm font-medium text-foreground"
              >
                Confirm New Password
              </label>
              <input
                id="confirmPassword"
                type="password"
                {...passwordForm.register('confirmPassword')}
                className={cn(
                  'mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm shadow-sm',
                  'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary',
                  passwordForm.formState.errors.confirmPassword &&
                    'border-destructive'
                )}
              />
              {passwordForm.formState.errors.confirmPassword && (
                <p className="mt-1 text-sm text-destructive">
                  {passwordForm.formState.errors.confirmPassword.message}
                </p>
              )}
            </div>

            <div className="pt-2">
              <button
                type="submit"
                disabled={passwordLoading}
                className={cn(
                  'flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground',
                  'hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2',
                  'disabled:cursor-not-allowed disabled:opacity-50'
                )}
              >
                {passwordLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                Change Password
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

export default ProfileSettings;
