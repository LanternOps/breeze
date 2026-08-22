import React, { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, AlertCircle, CheckCircle } from 'lucide-react';
import { usePortalAuth } from '@/lib/auth';
import { portalApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import { BTN_PRIMARY, INPUT } from './ui';

// The API's updateProfile accepts `name` only (routes/portal/schemas.ts);
// it used to strip a changed email silently and this form then said
// "Details saved." with the old address still on file. Email is read-only here.
const profileSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  email: z.string()
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

    const result = await portalApi.updateProfile({ name: data.name });

    if (result.error) {
      setProfileError(result.error);
    } else {
      // Store what the server confirmed, not what was typed.
      updateUser({ name: result.data?.name ?? data.name });
      setProfileSuccess(true);
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
    }

    setPasswordLoading(false);
  };

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      {/* Your details — a ruled section, not a boxed card with an icon chip. */}
      <section className="border-t border-border/70 pt-5">
        <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Your details
        </h2>

        {/* method="post" is a pre-hydration safety net: if the island fails to
            hydrate, a native submit must never be a GET that puts field values
            in the URL / browser history / access logs (#2868). Once hydrated,
            react-hook-form's handleSubmit preventDefaults and fetch() takes over. */}
        <form
          method="post"
          onSubmit={profileForm.handleSubmit(onProfileSubmit)}
          className="mt-4"
        >
          {profileError && (
            <div
              role="alert"
              className="mb-4 flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive-on-tint"
            >
              <AlertCircle className="h-4 w-4" />
              {profileError}
            </div>
          )}

          {profileSuccess && (
            <div
              role="status"
              className="mb-4 flex items-center gap-2 rounded-md bg-success/10 p-3 text-sm text-success-on-tint"
            >
              <CheckCircle className="h-4 w-4" />
              Details saved.
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
                autoComplete="name"
                aria-invalid={!!profileForm.formState.errors.name}
                aria-describedby={
                  profileForm.formState.errors.name ? 'name-error' : undefined
                }
                {...profileForm.register('name')}
                className={cn(
                  INPUT,
                  profileForm.formState.errors.name && 'border-destructive'
                )}
              />
              {profileForm.formState.errors.name && (
                <p id="name-error" role="alert" className="mt-1 text-sm text-destructive-on-tint">
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
                autoComplete="email"
                readOnly
                aria-describedby="email-help"
                {...profileForm.register('email')}
                className={cn(INPUT, 'bg-muted/60 text-muted-foreground')}
              />
              <p id="email-help" className="mt-1 text-xs text-muted-foreground">
                To change the email on your account, ask your IT team.
              </p>
              {profileForm.formState.errors.email && (
                <p id="email-error" role="alert" className="mt-1 text-sm text-destructive-on-tint">
                  {profileForm.formState.errors.email.message}
                </p>
              )}
            </div>

            <div className="pt-2">
              <button
                type="submit"
                disabled={profileLoading}
                className={cn(BTN_PRIMARY)}
              >
                {profileLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                Save changes
              </button>
            </div>
          </div>
        </form>
      </section>

      {/* Change password */}
      <section className="border-t border-border/70 pt-5">
        <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Change password
        </h2>
        <p className="mt-1 max-w-[60ch] text-sm text-muted-foreground">
          Choose something you don't use anywhere else.
        </p>

        {/* method="post" matters most here: without it an unhydrated island
            submits natively as a GET, putting the current AND new password in
            the URL, browser history, the Referer header and server access logs
            (#2868). Same guard as AcceptInviteForm. */}
        <form
          method="post"
          onSubmit={passwordForm.handleSubmit(onPasswordSubmit)}
          className="mt-4"
        >
          {passwordError && (
            <div
              role="alert"
              className="mb-4 flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive-on-tint"
            >
              <AlertCircle className="h-4 w-4" />
              {passwordError}
            </div>
          )}

          {passwordSuccess && (
            <div
              role="status"
              className="mb-4 flex items-center gap-2 rounded-md bg-success/10 p-3 text-sm text-success-on-tint"
            >
              <CheckCircle className="h-4 w-4" />
              Password changed.
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label
                htmlFor="currentPassword"
                className="block text-sm font-medium text-foreground"
              >
                Current password
              </label>
              <input
                id="currentPassword"
                type="password"
                autoComplete="current-password"
                aria-invalid={!!passwordForm.formState.errors.currentPassword}
                aria-describedby={
                  passwordForm.formState.errors.currentPassword
                    ? 'currentPassword-error'
                    : undefined
                }
                {...passwordForm.register('currentPassword')}
                className={cn(
                  INPUT,
                  passwordForm.formState.errors.currentPassword &&
                    'border-destructive'
                )}
              />
              {passwordForm.formState.errors.currentPassword && (
                <p
                  id="currentPassword-error"
                  role="alert"
                  className="mt-1 text-sm text-destructive-on-tint"
                >
                  {passwordForm.formState.errors.currentPassword.message}
                </p>
              )}
            </div>

            <div>
              <label
                htmlFor="newPassword"
                className="block text-sm font-medium text-foreground"
              >
                New password
              </label>
              <input
                id="newPassword"
                type="password"
                autoComplete="new-password"
                aria-invalid={!!passwordForm.formState.errors.newPassword}
                aria-describedby={
                  passwordForm.formState.errors.newPassword
                    ? 'newPassword-error'
                    : undefined
                }
                {...passwordForm.register('newPassword')}
                className={cn(
                  INPUT,
                  passwordForm.formState.errors.newPassword && 'border-destructive'
                )}
              />
              {passwordForm.formState.errors.newPassword && (
                <p
                  id="newPassword-error"
                  role="alert"
                  className="mt-1 text-sm text-destructive-on-tint"
                >
                  {passwordForm.formState.errors.newPassword.message}
                </p>
              )}
            </div>

            <div>
              <label
                htmlFor="confirmPassword"
                className="block text-sm font-medium text-foreground"
              >
                Confirm new password
              </label>
              <input
                id="confirmPassword"
                type="password"
                autoComplete="new-password"
                aria-invalid={!!passwordForm.formState.errors.confirmPassword}
                aria-describedby={
                  passwordForm.formState.errors.confirmPassword
                    ? 'confirmPassword-error'
                    : undefined
                }
                {...passwordForm.register('confirmPassword')}
                className={cn(
                  INPUT,
                  passwordForm.formState.errors.confirmPassword &&
                    'border-destructive'
                )}
              />
              {passwordForm.formState.errors.confirmPassword && (
                <p
                  id="confirmPassword-error"
                  role="alert"
                  className="mt-1 text-sm text-destructive-on-tint"
                >
                  {passwordForm.formState.errors.confirmPassword.message}
                </p>
              )}
            </div>

            <div className="pt-2">
              <button
                type="submit"
                disabled={passwordLoading}
                className={cn(BTN_PRIMARY)}
              >
                {passwordLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                Change password
              </button>
            </div>
          </div>
        </form>
      </section>
    </div>
  );
}

export default ProfileSettings;
