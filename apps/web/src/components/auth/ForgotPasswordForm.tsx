import { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';

type ForgotPasswordFormValues = {
  email: string;
};

type ForgotPasswordFormProps = {
  onSubmit?: (values: ForgotPasswordFormValues) => void | Promise<void>;
  errorMessage?: string;
  submitLabel?: string;
  loading?: boolean;
};

export default function ForgotPasswordForm({
  onSubmit,
  errorMessage,
  submitLabel,
  loading
}: ForgotPasswordFormProps) {
  const { t } = useTranslation('auth');
  const forgotPasswordSchema = useMemo(
    () =>
      z.object({
        email: z.string().email(t('validation.email', { defaultValue: 'Enter a valid email address' })),
      }),
    [t],
  );
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting }
  } = useForm<ForgotPasswordFormValues>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: {
      email: ''
    }
  });

  const isLoading = useMemo(() => loading ?? isSubmitting, [loading, isSubmitting]);
  const emailErrId = useId();
  const formErrId = useId();

  return (
    <form
      onSubmit={handleSubmit(async values => {
        await onSubmit?.(values);
      })}
      className="space-y-6 rounded-lg border bg-card p-6 shadow-xs"
      aria-describedby={errorMessage ? formErrId : undefined}
    >
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t('forgotPassword.form.title', { defaultValue: 'Reset your password' })}</h2>
        <p className="text-sm text-muted-foreground">
          {t('forgotPassword.form.description', {
            defaultValue: "Enter your email address and we'll send you a link to reset your password.",
          })}
        </p>
      </div>

      <div className="space-y-2">
        <label htmlFor="email" className="text-sm font-medium">
          {t('fields.email', { defaultValue: 'Email' })}
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          autoFocus
          placeholder={t('placeholders.email', { defaultValue: 'you@company.com' })}
          aria-invalid={errors.email ? true : undefined}
          aria-describedby={errors.email ? emailErrId : undefined}
          className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          {...register('email')}
        />
        {errors.email && (
          <p id={emailErrId} className="text-sm text-destructive">{errors.email.message}</p>
        )}
      </div>

      {errorMessage && (
        <div
          id={formErrId}
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {errorMessage}
        </div>
      )}

      <button
        type="submit"
        disabled={isLoading}
        aria-busy={isLoading || undefined}
        className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isLoading
          ? t('forgotPassword.form.sending', { defaultValue: 'Sending link…' })
          : submitLabel ?? t('forgotPassword.form.submit', { defaultValue: 'Send reset link' })}
      </button>

      <p className="text-center text-sm text-muted-foreground">
        {t('forgotPassword.form.rememberedPassword', { defaultValue: 'Remembered your password?' })}{' '}
        <a href="/login" className="font-medium text-primary hover:underline">
          {t('common.signIn', { defaultValue: 'Sign in' })}
        </a>
      </p>
    </form>
  );
}
