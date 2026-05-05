import { useEffect, useRef, useState } from 'react';
import StatusIcon from './StatusIcon';
import { apiVerifyEmail } from '../../stores/auth';

type State =
  | { phase: 'loading' }
  | { phase: 'no-token' }
  | { phase: 'success'; autoActivated: boolean }
  | { phase: 'error'; reason: 'invalid' | 'expired' | 'consumed' | 'superseded' | 'network' | 'unknown' };

const ERROR_COPY: Record<
  Extract<State, { phase: 'error' }>['reason'],
  { title: string; body: string }
> = {
  invalid: {
    title: 'This link is invalid',
    body: 'The verification link is not recognized. Sign in and request a new one from your account settings.',
  },
  expired: {
    title: 'This link has expired',
    body: 'Verification links expire after 24 hours. Sign in and request a new one from your account settings.',
  },
  consumed: {
    title: 'This link has already been used',
    body: 'Your email is already verified, or the link was used on another device.',
  },
  superseded: {
    title: 'A newer verification link was sent',
    body: 'Please use the most recent verification email — the older link is no longer valid.',
  },
  network: {
    title: 'We couldn’t reach Breeze',
    body: 'Check your connection and try the link again.',
  },
  unknown: {
    title: 'Verification failed',
    body: 'Something went wrong. Please try again or contact support.',
  },
};

export default function VerifyEmailPage() {
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
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-sm" aria-busy="true">
        <div className="space-y-2 text-center">
          <StatusIcon variant="pending" label="Verifying" />
          <h2 className="text-lg font-semibold">Verifying your email…</h2>
        </div>
      </div>
    );
  }

  if (state.phase === 'no-token') {
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
        <div className="space-y-2 text-center">
          <StatusIcon variant="error" />
          <h2 className="text-lg font-semibold">No verification token</h2>
          <p className="text-sm text-muted-foreground">
            This link is missing its token. Open the verification email and click the button again.
          </p>
        </div>
        <a
          href="/login"
          className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          Go to sign in
        </a>
      </div>
    );
  }

  if (state.phase === 'success') {
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
        <div className="space-y-2 text-center">
          <StatusIcon variant="success" />
          <h2 className="text-lg font-semibold">Email verified</h2>
          <p className="text-sm text-muted-foreground">
            {state.autoActivated
              ? 'Your account is now active. You can sign in to start using Breeze.'
              : 'Thanks for confirming your email. You can close this tab and return to Breeze.'}
          </p>
        </div>
        <a
          href="/login"
          className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          Sign in
        </a>
      </div>
    );
  }

  const copy = ERROR_COPY[state.reason];
  const showResendLink = state.reason === 'invalid' || state.reason === 'expired';

  return (
    <div className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
      <div className="space-y-2 text-center">
        <StatusIcon variant="error" />
        <h2 className="text-lg font-semibold">{copy.title}</h2>
        <p className="text-sm text-muted-foreground">{copy.body}</p>
      </div>
      <a
        href="/login"
        className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90"
      >
        {showResendLink ? 'Sign in to request a new link' : 'Go to sign in'}
      </a>
    </div>
  );
}
