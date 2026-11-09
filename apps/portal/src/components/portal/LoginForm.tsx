import { withBase } from '@/lib/basePath';
import React, { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2, AlertCircle } from 'lucide-react';
import { portalLogin, usePortalAuth } from '@/lib/auth';
import { portalApi } from '@/lib/api';
import { getSignInMethods, startMicrosoftSignIn, takeStoredNext, type SignInMethods } from '@/lib/oidc';
import { MicrosoftSignInButton } from './MicrosoftSignInButton';
import { cn } from '@/lib/utils';
import { navigateTo } from '@/lib/navigation';
import { safeNextPath } from '@/lib/nextPath';
import { BTN_PRIMARY, INPUT } from './ui';

const loginSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  password: z.string().min(1, 'Password is required')
});

type LoginFormData = z.infer<typeof loginSchema>;

const SSO_COPY: Record<string, string> = {
  request_sent: "Your request was sent. You'll get an email when you can sign in.",
  account_exists:
    'You already have an account. Sign in with your password and connect Microsoft, or ask your IT provider to re-invite you.'
};
const SSO_GENERIC_COPY = "Microsoft sign-in isn't set up for this account here.";

function readSsoParam(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('sso');
}

export function LoginForm() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // null = unknown / still loading: render the password form (today's behaviour)
  // and no Microsoft button. A failed methods fetch stays that way, silently.
  const [methods, setMethods] = useState<SignInMethods | null>(null);
  const [msBusy, setMsBusy] = useState(false);
  // Read after mount, never during render: the server has no query string, so
  // reading it in the initial state makes the hydrated tree differ from the SSR HTML.
  const [ssoCode, setSsoCode] = useState<string | null>(null);
  useEffect(() => { setSsoCode(readSsoParam()); }, []);
  const { login } = usePortalAuth();

  useEffect(() => {
    let cancelled = false;
    void getSignInMethods().then((result) => {
      if (!cancelled) setMethods(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The callback has already set the session cookies and redirected here with
  // ?sso=signed_in. Pick the session up like a password login would: hydrate
  // the profile into the store, then go to the stored (validated) destination.
  useEffect(() => {
    if (ssoCode !== 'signed_in') return;
    let cancelled = false;
    void (async () => {
      const next = safeNextPath(takeStoredNext());
      try {
        const profile = await portalApi.getProfile();
        if (profile.data && !cancelled) {
          usePortalAuth.getState().setUser({
            id: profile.data.id,
            email: profile.data.email,
            name: profile.data.name ?? '',
            organizationId: profile.data.organizationId,
            organizationName: profile.data.organizationName,
            orgId: profile.data.orgId,
            orgName: profile.data.orgName ?? undefined
          });
        }
      } catch (err) {
        // The cookie session is what authorizes requests; the store is a display cache.
        // A missing session shows up on the next page as the usual sign-in redirect.
        console.warn('[LoginForm] profile load after Microsoft sign-in failed', err);
      }
      if (!cancelled) await navigateTo(next ?? '/', { replace: true });
    })();
    return () => {
      cancelled = true;
    };
  }, [ssoCode]);

  const showPassword = methods?.password !== false;
  const showMicrosoft = methods?.microsoft === true;
  const ssoBanner = ssoCode && ssoCode !== 'signed_in' ? (SSO_COPY[ssoCode] ?? SSO_GENERIC_COPY) : null;

  const onMicrosoft = async () => {
    setMsBusy(true);
    setError(null);
    const next = safeNextPath(new URLSearchParams(window.location.search).get('next'));
    const result = await startMicrosoftSignIn({ purpose: 'login', ...(next ? { next } : {}) });
    if (!result.ok) {
      setError(result.error);
      setMsBusy(false);
    }
  };

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
    <div className="space-y-4">
      {ssoBanner && (
        <div
          role="status"
          data-testid="portal-login-sso-banner"
          className="rounded-md bg-muted p-3 text-sm text-foreground"
        >
          {ssoBanner}
        </div>
      )}

      {showPassword && (
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
      )}

      {!showPassword && error && (
        <div role="alert" className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm font-medium text-destructive-on-tint">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {showMicrosoft && (
        <div className="space-y-4">
          {showPassword && (
            <p className="text-center text-xs uppercase tracking-[0.08em] text-muted-foreground">or</p>
          )}
          <MicrosoftSignInButton onClick={onMicrosoft} busy={msBusy} />
        </div>
      )}
    </div>
  );
}

export default LoginForm;
