import { withBase } from '@/lib/basePath';
import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, AlertCircle } from 'lucide-react';
import { portalLogin, usePortalAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { navigateTo } from '@/lib/navigation';
import { safeNextPath } from '@/lib/nextPath';
import { BTN_PRIMARY, INPUT } from './ui';

const loginSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  password: z.string().min(1, 'Password is required')
});

type LoginFormData = z.infer<typeof loginSchema>;

export function LoginForm() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { login } = usePortalAuth();

  const {
    register,
    handleSubmit,
    formState: { errors }
  } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema)
  });

  const onSubmit = async (data: LoginFormData) => {
    setIsLoading(true);
    setError(null);

    const result = await portalLogin(data.email, data.password);

    if (result.success && result.user && result.tokens) {
      login(result.user, result.tokens);
      // Return the customer to whatever they originally clicked. Emailed
      // invoice/proposal links are the main way into this portal, and the
      // login wall used to discard them and land everyone on /devices — a
      // technician's inventory, which is not why a customer is here.
      const next = safeNextPath(new URLSearchParams(window.location.search).get('next'));
      await navigateTo(next ?? '/', { replace: true });
    } else {
      setError(result.error || 'That email and password don\'t match our records. Try again, or reset your password.');
    }

    setIsLoading(false);
  };

  return (
    // method="post" is a pre-hydration safety net: if the island fails to
    // hydrate, a native submit must never be a GET that puts the password in
    // the URL / browser history / access logs (#2868). Once hydrated,
    // react-hook-form's handleSubmit preventDefaults and fetch() takes over.
    // AcceptInviteForm has carried this guard for a while; the other password
    // forms never got it.
    <form
      method="post"
      onSubmit={handleSubmit(onSubmit)}
      className="space-y-6 rounded-lg border border-border/70 bg-card p-6 sm:p-8"
    >
      {error && (
        <div role="alert" className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm font-medium text-destructive-on-tint">
          <AlertCircle className="h-4 w-4 shrink-0" />
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
          data-testid="portal-login-email"
          type="email"
          autoComplete="email"
          {...register('email')}
          className={cn(INPUT, errors.email && 'border-destructive')}
        />
        {errors.email && (
          <p className="mt-1 text-sm text-destructive-on-tint">{errors.email.message}</p>
        )}
      </div>

      <div>
        <label
          htmlFor="password"
          className="block text-sm font-medium text-foreground"
        >
          Password
        </label>
        <input
          id="password"
          data-testid="portal-login-password"
          type="password"
          autoComplete="current-password"
          {...register('password')}
          className={cn(INPUT, errors.password && 'border-destructive')}
        />
        {errors.password && (
          <p className="mt-1 text-sm text-destructive-on-tint">
            {errors.password.message}
          </p>
        )}
      </div>

      {/* "Remember me" used to sit here: an unregistered checkbox wired to
          nothing, present only because login forms have one. Session length is
          the server's policy; a dead control is a small lie to the user. */}
      <div className="text-right text-sm">
        <a
          href={withBase("/forgot-password")}
          className="font-medium text-primary-on-tint underline-offset-4 hover:underline"
        >
          Forgot your password?
        </a>
      </div>

      <button
        type="submit"
        data-testid="portal-login-submit"
        disabled={isLoading}
        className={cn(BTN_PRIMARY, 'w-full')}
      >
        {isLoading ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            Signing in
          </>
        ) : (
          'Sign in'
        )}
      </button>
    </form>
  );
}

export default LoginForm;
