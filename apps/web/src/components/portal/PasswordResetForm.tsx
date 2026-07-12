import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

type ResetRequestValues = {
  email: string;
};

type ResetConfirmValues = {
  code: string;
  password: string;
  confirmPassword: string;
};

type PasswordResetFormProps = {
  mode?: 'request' | 'confirm';
  onSubmit?: (values: ResetRequestValues | ResetConfirmValues) => void | Promise<void>;
  errorMessage?: string;
  submitLabel?: string;
  loading?: boolean;
};

function RequestForm({
  onSubmit,
  errorMessage,
  submitLabel,
  loading
}: Omit<PasswordResetFormProps, 'mode'>) {
  const { t } = useTranslation('portal');
  const resetRequestSchema = useMemo(
    () =>
      z.object({
        email: z.string().email(t('passwordReset.validation.email'))
      }),
    [t]
  );
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting }
  } = useForm<ResetRequestValues>({
    resolver: zodResolver(resetRequestSchema),
    defaultValues: { email: '' }
  });

  const isLoading = loading ?? isSubmitting;

  return (
    <form
      onSubmit={handleSubmit(async values => {
        await onSubmit?.(values);
      })}
      className="space-y-6 rounded-lg border bg-card p-6 shadow-xs"
    >
      <div className="space-y-2">
        <label htmlFor="email" className="text-sm font-medium">
          {t('passwordReset.email')}
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          placeholder={t('passwordReset.emailPlaceholder')}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          {...register('email')}
        />
        {errors.email && (
          <p className="text-sm text-destructive">{errors.email.message}</p>
        )}
      </div>

      {errorMessage && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {errorMessage}
        </div>
      )}

      <button
        type="submit"
        disabled={isLoading}
        className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isLoading
          ? t('passwordReset.request.sending')
          : submitLabel ?? t('passwordReset.request.submit')}
      </button>

      <p className="text-center text-sm text-muted-foreground">
        {t('passwordReset.rememberedPassword')}{' '}
        <a href="/portal/login" className="font-medium text-primary hover:underline">
          {t('passwordReset.signIn')}
        </a>
      </p>
    </form>
  );
}

function ConfirmForm({
  onSubmit,
  errorMessage,
  submitLabel,
  loading
}: Omit<PasswordResetFormProps, 'mode'>) {
  const { t } = useTranslation('portal');
  const resetConfirmSchema = useMemo(
    () =>
      z
        .object({
          code: z.string().min(6, t('passwordReset.validation.code')),
          password: z.string().min(8, t('passwordReset.validation.passwordLength')),
          confirmPassword: z.string().min(8, t('passwordReset.validation.passwordLength'))
        })
        .refine(values => values.password === values.confirmPassword, {
          message: t('passwordReset.validation.passwordsMatch'),
          path: ['confirmPassword']
        }),
    [t]
  );
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting }
  } = useForm<ResetConfirmValues>({
    resolver: zodResolver(resetConfirmSchema),
    defaultValues: { code: '', password: '', confirmPassword: '' }
  });

  const isLoading = loading ?? isSubmitting;

  return (
    <form
      onSubmit={handleSubmit(async values => {
        await onSubmit?.(values);
      })}
      className="space-y-6 rounded-lg border bg-card p-6 shadow-xs"
    >
      <div className="space-y-2">
        <label htmlFor="code" className="text-sm font-medium">
          {t('passwordReset.confirm.code')}
        </label>
        <input
          id="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder={t('passwordReset.confirm.codePlaceholder')}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          {...register('code')}
        />
        {errors.code && (
          <p className="text-sm text-destructive">{errors.code.message}</p>
        )}
      </div>
      <div className="space-y-2">
        <label htmlFor="password" className="text-sm font-medium">
          {t('passwordReset.confirm.newPassword')}
        </label>
        <input
          id="password"
          type="password"
          autoComplete="new-password"
          placeholder={t('passwordReset.confirm.newPasswordPlaceholder')}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          {...register('password')}
        />
        {errors.password && (
          <p className="text-sm text-destructive">{errors.password.message}</p>
        )}
      </div>
      <div className="space-y-2">
        <label htmlFor="confirmPassword" className="text-sm font-medium">
          {t('passwordReset.confirm.confirmPassword')}
        </label>
        <input
          id="confirmPassword"
          type="password"
          autoComplete="new-password"
          placeholder={t('passwordReset.confirm.confirmPasswordPlaceholder')}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          {...register('confirmPassword')}
        />
        {errors.confirmPassword && (
          <p className="text-sm text-destructive">
            {errors.confirmPassword.message}
          </p>
        )}
      </div>

      {errorMessage && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {errorMessage}
        </div>
      )}

      <button
        type="submit"
        disabled={isLoading}
        className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isLoading
          ? t('passwordReset.confirm.resetting')
          : submitLabel ?? t('passwordReset.confirm.submit')}
      </button>

      <p className="text-center text-sm text-muted-foreground">
        {t('passwordReset.rememberedPassword')}{' '}
        <a href="/portal/login" className="font-medium text-primary hover:underline">
          {t('passwordReset.signIn')}
        </a>
      </p>
    </form>
  );
}

export default function PasswordResetForm({
  mode = 'request',
  onSubmit,
  errorMessage,
  submitLabel,
  loading
}: PasswordResetFormProps) {
  if (mode === 'confirm') {
    return (
      <ConfirmForm
        onSubmit={onSubmit}
        errorMessage={errorMessage}
        submitLabel={submitLabel}
        loading={loading}
      />
    );
  }

  return (
    <RequestForm
      onSubmit={onSubmit}
      errorMessage={errorMessage}
      submitLabel={submitLabel}
      loading={loading}
    />
  );
}
