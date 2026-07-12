import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import StatusIcon from './StatusIcon';
import { apiVerifyEmail } from '../../stores/auth';

type State =
  | { phase: 'loading' }
  | { phase: 'no-token' }
  | { phase: 'success'; autoActivated: boolean }
  | { phase: 'error'; reason: 'invalid' | 'expired' | 'consumed' | 'superseded' | 'network' | 'unknown' };

export default function VerifyEmailPage() {
  const { t } = useTranslation('auth');
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
        setState({ phase: 'success', autoActivated: !!result.autoActivated });
        return;
      }
      const err = result.error;
      if (err === 'invalid' || err === 'expired' || err === 'consumed' || err === 'superseded') {
        setState({ phase: 'error', reason: err });
        return;
      }
      if (err === 'Network error') {
        setState({ phase: 'error', reason: 'network' });
        return;
      }
      setState({ phase: 'error', reason: 'unknown' });
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
    expired: {
      title: t('verifyEmail.errors.expired.title', { defaultValue: 'This link has expired' }),
      body: t('verifyEmail.errors.expired.body', {
        defaultValue: 'Verification links expire after 24 hours. Sign in and request a new one from your account settings.',
      }),
    },
    consumed: {
      title: t('verifyEmail.errors.consumed.title', { defaultValue: 'This link has already been used' }),
      body: t('verifyEmail.errors.consumed.body', {
        defaultValue: 'Your email is already verified, or the link was used on another device.',
      }),
    },
    superseded: {
      title: t('verifyEmail.errors.superseded.title', { defaultValue: 'A newer verification link was sent' }),
      body: t('verifyEmail.errors.superseded.body', {
        defaultValue: 'Please use the most recent verification email — the older link is no longer valid.',
      }),
    },
    network: {
      title: t('verifyEmail.errors.network.title', { defaultValue: 'We couldn’t reach Breeze' }),
      body: t('verifyEmail.errors.network.body', { defaultValue: 'Check your connection and try the link again.' }),
    },
    unknown: {
      title: t('verifyEmail.errors.unknown.title', { defaultValue: 'Verification failed' }),
      body: t('verifyEmail.errors.unknown.body', {
        defaultValue: 'Something went wrong. Please try again or contact support.',
      }),
    },
  };
  const copy = errorCopy[state.reason];
  const showResendLink = state.reason === 'invalid' || state.reason === 'expired';

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
