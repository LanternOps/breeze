import { withBase } from '@/lib/basePath';
import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, AlertCircle, CheckCircle } from 'lucide-react';
import { portalResetPassword } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { BTN_PRIMARY, INPUT } from './ui';

const resetPasswordSchema = z
  .object({
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
      .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
      .regex(/[0-9]/, 'Password must contain at least one number'),
    confirmPassword: z.string()
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ['confirmPassword']
  });

type ResetPasswordFormData = z.infer<typeof resetPasswordSchema>;

interface ResetPasswordFormProps {
  token: string;
}

export function ResetPasswordForm({ token }: ResetPasswordFormProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors }
  } = useForm<ResetPasswordFormData>({
    resolver: zodResolver(resetPasswordSchema)
  });

  const onSubmit = async (data: ResetPasswordFormData) => {
    setIsLoading(true);
    setError(null);

    const result = await portalResetPassword(token, data.password);

    if (result.success) {
      setSuccess(true);
    } else {
      setError(result.error || 'We couldn\'t reset your password. The link may have expired. Request a new one.');
    }

    setIsLoading(false);
  };

  if (success) {
    return (
      <div className="space-y-6">
        <div role="status" className="border-y border-border/70 py-12 text-center">
          <h3 className="font-display text-lg font-semibold text-foreground">Password changed</h3>
          <p className="mx-auto mt-1 max-w-[38ch] text-sm text-muted-foreground">
            You're all set — sign in with your new password.
          </p>
        </div>

        <a
          href={withBase("/login")}
          className={cn(BTN_PRIMARY, 'w-full')}
        >
          Sign in
        </a>
      </div>
    );
  }

  if (!token) {
    return (
      <div className="space-y-6">
        <div className="border-y border-border/70 py-12 text-center">
          <h3 className="font-display text-lg font-semibold text-foreground">This link has expired</h3>
          <p className="mx-auto mt-1 max-w-[38ch] text-sm text-muted-foreground">
            Reset links only work once. Request a fresh one and you'll be in
            within a minute.
          </p>
        </div>

        <a
          href={withBase("/forgot-password")}
          className={cn(BTN_PRIMARY, 'w-full')}
        >
          Request new link
        </a>
      </div>
    );
  }

  return (
    // Pre-hydration safety net, same rationale as AcceptInviteForm (#2868): a
    // native submit must never be a GET carrying credentials in the URL.
    <form method="post" onSubmit={handleSubmit(onSubmit)} className="space-y-6 rounded-lg border border-border/70 bg-card p-6 sm:p-8">
      <div className="text-center">
        <p className="text-sm text-muted-foreground">
          Enter your new password below.
        </p>
      </div>

      {error && (
        <div role="alert" className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive-on-tint">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      )}

      <div>
        <label
          htmlFor="password"
          className="block text-sm font-medium text-foreground"
        >
          New password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="new-password"
          aria-describedby="password-rules"
          {...register('password')}
          className={cn(INPUT, errors.password && 'border-destructive')}
        />
        <p id="password-rules" className="mt-1 text-xs text-muted-foreground">
          8+ characters, with a capital letter, a lowercase letter, and a number.
        </p>
        {errors.password && (
          <p className="mt-1 text-sm text-destructive-on-tint">
            {errors.password.message}
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
          {...register('confirmPassword')}
          className={cn(INPUT, errors.confirmPassword && 'border-destructive')}
        />
        {errors.confirmPassword && (
          <p className="mt-1 text-sm text-destructive-on-tint">
            {errors.confirmPassword.message}
          </p>
        )}
      </div>

      <button
        type="submit"
        disabled={isLoading}
        className={cn(BTN_PRIMARY, 'w-full')}
      >
        {isLoading ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Resetting
          </>
        ) : (
          'Reset password'
        )}
      </button>
    </form>
  );
}

export default ResetPasswordForm;
