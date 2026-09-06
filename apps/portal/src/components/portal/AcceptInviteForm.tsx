import { withBase } from '@/lib/basePath';
import React, { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, AlertCircle, CheckCircle } from 'lucide-react';
import { buildPortalApiUrl } from '@/lib/api';
import { cn } from '@/lib/utils';
import { usePortalAuth } from '@/lib/auth';
import { navigateTo } from '@/lib/navigation';
import { safeNextPath } from '@/lib/nextPath';
import { BTN_PRIMARY, INPUT } from './ui';

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

export default function AcceptInviteForm({ token }: AcceptInviteFormProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  // False during SSR and until React hydrates. Before hydration the submit
  // button stays disabled so the browser can never perform a native form
  // submit that would serialize the password fields into the URL (#2868).
  const [hydrated, setHydrated] = useState(false);

  const { login } = usePortalAuth();
  const nextParam =
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('next')
      : null;

  useEffect(() => {
    setHydrated(true);
  }, []);

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
      const response = await fetch(buildPortalApiUrl('/portal/auth/accept-invite'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token, password: data.password })
      });

      const result = await response.json();

      if (!response.ok) {
        setError(result.error || 'We couldn\'t finish setting up your account. Try the link again, or ask your IT team to resend it.');
        return;
      }

      // The API has ALREADY signed this customer in: /portal/auth/accept-invite
      // calls setPortalSessionCookies and returns the user + tokens, and this
      // fetch uses credentials:'include', so the session cookie is in the
      // browser by now. The old success screen threw that away and sent them to
      // /login to retype the password they created seconds earlier, at the
      // single highest-drop-off moment in the product. Hydrate the store and
      // take them where they were going.
      if (result.user && result.tokens) {
        login(result.user, result.tokens);
        await navigateTo(safeNextPath(nextParam) ?? '/', { replace: true });
        return;
      }

      // No user payload (an older API build): fall back to the manual sign-in
      // screen rather than stranding them on a spinner.
      setSuccess(true);
    } catch (err) {
      console.error('[AcceptInviteForm] Request failed:', err);
      setError('We couldn\'t reach the server. Check your connection and try again.');
    } finally {
      setIsLoading(false);
    }
  };

  if (!token) {
    return (
      <div className="border-y border-border/70 py-12 text-center">
        <h3 className="font-display text-lg font-semibold text-foreground">This invite has expired</h3>
        <p className="mx-auto mt-1 max-w-[38ch] text-sm text-muted-foreground">
          Invite links only work once. Ask your IT team to send a fresh one.
        </p>
      </div>
    );
  }

  if (success) {
    return (
      <div className="space-y-6">
        <div role="status" className="border-y border-border/70 py-12 text-center">
          <h3 className="font-display text-lg font-semibold text-foreground">You're in</h3>
          <p className="mx-auto mt-1 max-w-[38ch] text-sm text-muted-foreground">
            Your account is active. Sign in to see what your IT team keeps for
            you.
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

  return (
    // method="post" is a pre-hydration safety net: if the island fails to
    // hydrate, a native submit must never be a GET that puts the password in
    // the URL / browser history / access logs (#2868). Once hydrated,
    // react-hook-form's handleSubmit preventDefaults and fetch() takes over.
    <form method="post" onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      <div className="text-center">
        <p className="text-sm text-muted-foreground">
          Choose a password and you're in.
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
          Confirm password
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
        disabled={!hydrated || isLoading}
        className={cn(BTN_PRIMARY, 'w-full')}
      >
        {isLoading ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Setting up
          </>
        ) : (
          'Set password & activate'
        )}
      </button>
    </form>
  );
}
