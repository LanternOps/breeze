import { useId, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import PasswordInput from './PasswordInput';
import PasswordStrength from './PasswordStrength';

const resetPasswordSchema = z
  .object({
    password: z.string().min(8, 'Password must be at least 8 characters'),
    confirmPassword: z.string().min(8, 'Password must be at least 8 characters')
  })
  .refine(values => values.password === values.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword']
  });

type ResetPasswordFormValues = z.infer<typeof resetPasswordSchema>;

type ResetPasswordFormProps = {
  onSubmit?: (values: ResetPasswordFormValues) => void | Promise<void>;
  errorMessage?: string;
  submitLabel?: string;
  loading?: boolean;
};

export default function ResetPasswordForm({
  onSubmit,
  errorMessage,
  submitLabel = 'Reset password',
  loading
}: ResetPasswordFormProps) {
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting }
  } = useForm<ResetPasswordFormValues>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: {
      password: '',
      confirmPassword: ''
    }
  });

  const isLoading = useMemo(() => loading ?? isSubmitting, [loading, isSubmitting]);
  const password = watch('password');
  const passwordErrId = useId();
  const confirmErrId = useId();
  const formErrId = useId();

  return (
    <form
      onSubmit={handleSubmit(async values => {
        await onSubmit?.(values);
      })}
      className="space-y-6 rounded-lg border bg-card p-6 shadow-sm"
      aria-describedby={errorMessage ? formErrId : undefined}
    >
      <div className="space-y-2">
        <label htmlFor="password" className="text-sm font-medium">
          New password
        </label>
        <PasswordInput
          id="password"
          autoComplete="new-password"
          autoFocus
          placeholder="Enter a new password"
          aria-invalid={errors.password ? true : undefined}
          aria-describedby={errors.password ? passwordErrId : undefined}
          {...register('password')}
        />
        {errors.password && (
          <p id={passwordErrId} className="text-sm text-destructive">{errors.password.message}</p>
        )}
        <PasswordStrength password={password ?? ''} />
      </div>

      <div className="space-y-2">
        <label htmlFor="confirmPassword" className="text-sm font-medium">
          Confirm password
        </label>
        <PasswordInput
          id="confirmPassword"
          autoComplete="new-password"
          placeholder="Re-enter your new password"
          aria-invalid={errors.confirmPassword ? true : undefined}
          aria-describedby={errors.confirmPassword ? confirmErrId : undefined}
          {...register('confirmPassword')}
        />
        {errors.confirmPassword && (
          <p id={confirmErrId} className="text-sm text-destructive">
            {errors.confirmPassword.message}
          </p>
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
        {isLoading ? 'Resetting password…' : submitLabel}
      </button>

      <p className="text-center text-sm text-muted-foreground">
        Back to{' '}
        <a href="/login" className="font-medium text-primary hover:underline">
          sign in
        </a>
      </p>
    </form>
  );
}
