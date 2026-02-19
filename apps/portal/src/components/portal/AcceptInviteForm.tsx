import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, AlertCircle, CheckCircle } from 'lucide-react';
import { buildPortalApiUrl } from '@/lib/api';
import { cn } from '@/lib/utils';

const acceptInviteSchema = z
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

type AcceptInviteFormData = z.infer<typeof acceptInviteSchema>;

interface AcceptInviteFormProps {
  token: string;
}

export function AcceptInviteForm({ token }: AcceptInviteFormProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors }
  } = useForm<AcceptInviteFormData>({
    resolver: zodResolver(acceptInviteSchema)
  });

  const onSubmit = async (data: AcceptInviteFormData) => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(buildPortalApiUrl('/auth/accept-invite'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token, password: data.password })
      });

      const result = await response.json();

      if (!response.ok) {
        setError(result.error || 'Failed to accept invite');
        setIsLoading(false);
        return;
      }

      setSuccess(true);
    } catch {
      setError('Network error');
    }

    setIsLoading(false);
  };

  if (success) {
    return (
      <div className="space-y-6">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-success/10">
            <CheckCircle className="h-6 w-6 text-success" />
          </div>
          <div>
            <h3 className="text-lg font-medium">Account activated</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Your password has been set and your account is now active. You can
              now sign in.
            </p>
          </div>
        </div>

        <a
          href="/login"
          className={cn(
            'flex w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground',
            'hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2'
          )}
        >
          Sign in
        </a>
      </div>
    );
  }

  if (!token) {
    return (
      <div className="space-y-6">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
            <AlertCircle className="h-6 w-6 text-destructive" />
          </div>
          <div>
            <h3 className="text-lg font-medium">Invalid invite link</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              This invite link is invalid or has expired.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      <div className="text-center">
        <p className="text-sm text-muted-foreground">
          Set your password to activate your account.
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
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
          {...register('password')}
          className={cn(
            'mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm shadow-sm',
            'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary',
            errors.password && 'border-destructive'
          )}
        />
        {errors.password && (
          <p className="mt-1 text-sm text-destructive">
            {errors.password.message}
          </p>
        )}
      </div>

      <div>
        <label
          htmlFor="confirmPassword"
          className="block text-sm font-medium text-foreground"
        >
          Confirm password
        </label>
        <input
          id="confirmPassword"
          type="password"
          autoComplete="new-password"
          {...register('confirmPassword')}
          className={cn(
            'mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm shadow-sm',
            'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary',
            errors.confirmPassword && 'border-destructive'
          )}
        />
        {errors.confirmPassword && (
          <p className="mt-1 text-sm text-destructive">
            {errors.confirmPassword.message}
          </p>
        )}
      </div>

      <div className="rounded-md bg-muted p-3">
        <p className="text-xs text-muted-foreground">Password requirements:</p>
        <ul className="mt-1 list-inside list-disc text-xs text-muted-foreground">
          <li>At least 8 characters</li>
          <li>At least one uppercase letter</li>
          <li>At least one lowercase letter</li>
          <li>At least one number</li>
        </ul>
      </div>

      <button
        type="submit"
        disabled={isLoading}
        className={cn(
          'flex w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground',
          'hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2',
          'disabled:cursor-not-allowed disabled:opacity-50'
        )}
      >
        {isLoading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Setting up account...
          </>
        ) : (
          'Set password & activate'
        )}
      </button>
    </form>
  );
}

export default AcceptInviteForm;
