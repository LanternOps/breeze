import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import StatusIcon from './StatusIcon';
import { apiVerifyEmail, useAuthStore } from '../../stores/auth';
import { navigateTo } from '../../lib/navigation';
// Initializes the shared i18next singleton. Islands hydrate independently, so
// an island that hydrates before whichever other island happens to pull i18n in
// would otherwise render raw keys (and mismatch the SSR markup).
import '../../lib/i18n';

type State =
  | { phase: 'loading' }
  | { phase: 'no-token' }
  | { phase: 'success'; autoActivated: boolean }
  // SR2-21 step 2: the token completed a PENDING REGISTRATION — the account was
  // just created and this browser is now logged in. We navigate to the dashboard;
  // this phase is the brief bridge state while that navigation happens.
  | { phase: 'registered' }
  // SR2-21: the address was registered while the link sat in the mailbox. No
  // account was created for this token; send the holder to sign in.
  | { phase: 'sign_in' }
  | {
      phase: 'error';
      // The verify endpoint returns ONE generic failure for every consume error
      // (invalid / expired / used / superseded / address-changed) to avoid an
      // enumeration oracle, so the client cannot distinguish them. We present a
      // single recoverable failure ('invalid') that always offers a fresh link,
      // and keep 'network' distinct because it is client-side (retry, not resend).
      reason: 'invalid' | 'network';
    };

export default function VerifyEmailPage() {
  const { t } = useTranslation('auth');
  const login = useAuthStore((s) => s.login);
  const [state, setState] = useState<State>({ phase: 'loading' });
  // Strict-mode in dev mounts components twice — block the duplicate POST so we
  // don't burn the single-use token before the user sees a result.
  const submittedRef = useRef(false);

  useEffect(() => {
    if (submittedRef.current) return;
    submittedRef.current = true;

    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (!token) {
      setState({ phase: 'no-token' });
      return;
    }

    (async () => {
      const result = await apiVerifyEmail(token);
      if (result.success) {
        // SR2-21: a registration-completion response carries the auto-login
        // session. This is the ONLY place partner signup logs a user in now —
        // the register form itself no longer does. Establish the session, then
        // navigate to the dashboard.
        if (result.user && result.tokens) {
          login(result.user, result.tokens);
          setState({ phase: 'registered' });
          await navigateTo('/');
          return;
        }
        setState({ phase: 'success', autoActivated: !!result.autoActivated });
        return;
      }
      // SR2-21: the address already had an account by step 2. Nothing was
      // created; point the holder at sign-in rather than an error.
      if (result.status === 'sign_in') {
        setState({ phase: 'sign_in' });
        return;
      }
      // Network is the only failure the client can distinguish; it warrants a
      // retry, not a resend. Every server-side consume failure is deliberately
      // indistinguishable (enumeration-safe), so it collapses to 'invalid',
      // which always offers a fresh link — the correct recovery for the whole
      // class (and resend-verification no-ops safely if already verified).
      if (result.error === 'Network error') {
        setState({ phase: 'error', reason: 'network' });
        return;
      }
      setState({ phase: 'error', reason: 'invalid' });
    })();
  }, []);

  if (state.phase === 'loading') {
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-xs" aria-busy="true">
        <div className="space-y-2 text-center">
          <StatusIcon variant="pending" label={t('verifyEmail.loading.iconLabel', { defaultValue: 'Verifying' })} />
          <h2 className="text-lg font-semibold">{t('verifyEmail.loading.title', { defaultValue: 'Verifying your email…' })}</h2>
        </div>
      </div>
    );
  }

  if (state.phase === 'no-token') {
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-xs">
        <div className="space-y-2 text-center">
          <StatusIcon variant="error" />
          <h2 className="text-lg font-semibold">{t('verifyEmail.noToken.title', { defaultValue: 'No verification token' })}</h2>
          <p className="text-sm text-muted-foreground">
            {t('verifyEmail.noToken.description', {
              defaultValue: 'This link is missing its token. Open the verification email and click the button again.',
            })}
          </p>
        </div>
        <a
          href="/login"
          className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          {t('common.goToSignIn', { defaultValue: 'Go to sign in' })}
        </a>
      </div>
    );
  }

  if (state.phase === 'registered') {
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-xs" aria-busy="true">
        <div className="space-y-2 text-center">
          <StatusIcon variant="success" />
          <h2 className="text-lg font-semibold">
            {t('verifyEmail.registered.title', { defaultValue: 'Account created' })}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t('verifyEmail.registered.description', {
              defaultValue: "You're all set — taking you to your dashboard.",
            })}
          </p>
        </div>
      </div>
    );
  }

  if (state.phase === 'sign_in') {
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-xs">
        <div className="space-y-2 text-center">
          <StatusIcon variant="success" />
          <h2 className="text-lg font-semibold">
            {t('verifyEmail.signIn.title', { defaultValue: 'This address already has an account' })}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t('verifyEmail.signIn.description', {
              defaultValue: 'Your email is already registered. Sign in to continue.',
            })}
          </p>
        </div>
        <a
          href="/login"
          className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          {t('common.signIn', { defaultValue: 'Sign in' })}
        </a>
      </div>
    );
  }

  if (state.phase === 'success') {
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-xs">
        <div className="space-y-2 text-center">
          <StatusIcon variant="success" />
          <h2 className="text-lg font-semibold">{t('verifyEmail.success.title', { defaultValue: 'Email verified' })}</h2>
          <p className="text-sm text-muted-foreground">
            {state.autoActivated
              ? t('verifyEmail.success.autoActivated', {
                  defaultValue: 'Your account is now active. You can sign in to start using Breeze.',
                })
              : t('verifyEmail.success.confirmed', {
                  defaultValue: 'Thanks for confirming your email. You can close this tab and return to Breeze.',
                })}
          </p>
        </div>
        <a
          href="/login"
          className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          {t('common.signIn', { defaultValue: 'Sign in' })}
        </a>
      </div>
    );
  }

  const errorCopy = {
    invalid: {
      title: t('verifyEmail.errors.invalid.title', { defaultValue: 'This link is invalid' }),
      body: t('verifyEmail.errors.invalid.body', {
        defaultValue: 'The verification link is not recognized. Sign in and request a new one from your account settings.',
      }),
    },
    network: {
      title: t('verifyEmail.errors.network.title', { defaultValue: 'We couldn’t reach Breeze' }),
      body: t('verifyEmail.errors.network.body', { defaultValue: 'Check your connection and try the link again.' }),
    },
  };
  const copy = errorCopy[state.reason];
  // Every server-side failure collapses to 'invalid' (see the consume handler),
  // so the recoverable case must always offer a fresh link — the user's route
  // back is a new link for their current address, and PATCH /users/me clears
  // email_verified_at so /auth/resend-verification will actually mint one (it
  // refuses while the account reads as already-verified). Network is a retry.
  const showResendLink = state.reason === 'invalid';

  return (
    <div className="space-y-6 rounded-lg border bg-card p-6 shadow-xs">
      <div className="space-y-2 text-center">
        <StatusIcon variant="error" />
        <h2 className="text-lg font-semibold">{copy.title}</h2>
        <p className="text-sm text-muted-foreground">{copy.body}</p>
      </div>
      <a
        href="/login"
        className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90"
      >
        {showResendLink
          ? t('verifyEmail.signInToRequestNewLink', { defaultValue: 'Sign in to request a new link' })
          : t('common.goToSignIn', { defaultValue: 'Go to sign in' })}
      </a>
    </div>
  );
}
