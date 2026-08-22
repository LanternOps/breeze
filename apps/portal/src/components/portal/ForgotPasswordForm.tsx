import { withBase } from '@/lib/basePath';
import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, AlertCircle, ArrowLeft } from 'lucide-react';
import { portalForgotPassword } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { BTN_PRIMARY, INPUT } from './ui';

const forgotPasswordSchema = z.object({
  email: z.string().email('Please enter a valid email address')
});

type ForgotPasswordFormData = z.infer<typeof forgotPasswordSchema>;

export function ForgotPasswordForm() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors }
  } = useForm<ForgotPasswordFormData>({
    resolver: zodResolver(forgotPasswordSchema)
  });

  const onSubmit = async (data: ForgotPasswordFormData) => {
    setIsLoading(true);
    setError(null);

    const result = await portalForgotPassword(data.email);

    if (result.success) {
      setSuccess(true);
    } else {
      setError(result.error || 'We couldn\'t send the reset link. Check the address and try again.');
    }

    setIsLoading(false);
  };

  if (success) {
    return (
      <div role="status" className="border-y border-border/70 py-12 text-center">
        <h3 className="font-display text-lg font-semibold text-foreground">Check your email</h3>
        <p className="mx-auto mt-1 max-w-[38ch] text-sm text-muted-foreground">
          We've sent a reset link to your inbox. The link inside brings you
          right back here.
        </p>
        <a
          href={withBase("/login")}
          className="mt-4 inline-flex items-center justify-center gap-2 text-sm font-medium text-primary-on-tint underline-offset-4 hover:underline"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to login
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
          Enter your email address and we'll send you a link to reset your
          password.
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
          htmlFor="email"
          className="block text-sm font-medium text-foreground"
        >
          Email address
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          {...register('email')}
          className={cn(INPUT, errors.email && 'border-destructive')}
        />
        {errors.email && (
          <p className="mt-1 text-sm text-destructive-on-tint">{errors.email.message}</p>
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
            Sending
          </>
        ) : (
          'Send reset link'
        )}
      </button>

      <a
        href={withBase("/login")}
        className="flex items-center justify-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to login
      </a>
    </form>
  );
}

export default ForgotPasswordForm;
