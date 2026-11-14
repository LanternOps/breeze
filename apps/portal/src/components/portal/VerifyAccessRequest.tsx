import { withBase } from '@/lib/basePath';
import React, { useEffect, useState } from 'react';
import { Loader2, AlertCircle } from 'lucide-react';
import { confirmPortalAccessRequest } from '@/lib/selfRegistration';
import { navigateTo } from '@/lib/navigation';
import { cn } from '@/lib/utils';
import { BTN_PRIMARY } from './ui';

/**
 * The emailed "confirm your request" landing (portal registration W6, plan D9).
 *
 * The single-use token rides in the URL fragment (`#token=…`), which browsers
 * never send to a server, so it stays out of access logs, referrers and a mail
 * scanner's request. On mount the island reads it into memory and scrubs it
 * from the address bar. Nothing is posted on load: mail scanners and link
 * prefetchers open the page, and in instant mode spending the token creates
 * the account. Only the Confirm click posts it.
 */

type Phase =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'request_sent' }
  | { kind: 'request_unavailable' }
  | { kind: 'existing_account' }
  | { kind: 'account_created' }
  | { kind: 'invalid' }
  | { kind: 'not_available' }
  /** Retryable: the button stays, so the requester can try again without reopening the email. */
  | { kind: 'error'; message: string }
  /** Terminal: the link was consumed; no retry (it could only 400 and would hide this message). */
  | { kind: 'spent'; message: string };

const GENERIC_ERROR = 'Something went wrong. Try again in a few minutes.';
const SPENT_ERROR = 'Something went wrong. Request access again in a few minutes.';

function readFragmentToken(): string | null {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return null;
  const token = new URLSearchParams(hash).get('token');
  return token ? token : null;
}

const LINK = 'font-medium text-primary-on-tint underline-offset-4 hover:underline';

export function VerifyAccessRequest() {
  // `ready` stays false for the server render and the first client render, so
  // the hydrated tree matches the HTML (the server never sees the fragment).
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  useEffect(() => {
    const value = readFragmentToken();
    if (window.location.hash) {
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    }
    setToken(value);
    setReady(true);
  }, []);

  const confirm = async () => {
    if (!token || phase.kind === 'busy') return;
    setPhase({ kind: 'busy' });
    const result = await confirmPortalAccessRequest(token);
    switch (result.status) {
      case 'account_created':
        setPhase({ kind: 'account_created' });
        // replace: Back must not return to a spent single-use page.
        await navigateTo(result.next, { replace: true });
        return;
      case 'invalid_link':
        setPhase({ kind: 'invalid' });
        return;
      case 'error':
        setPhase({ kind: 'error', message: result.message ?? GENERIC_ERROR });
        return;
      case 'spent':
        setPhase({ kind: 'spent', message: result.message ?? SPENT_ERROR });
        return;
      default:
        setPhase({ kind: result.status });
    }
  };

  if (!ready) return null;

  const showInvalid = !token || phase.kind === 'invalid';
  const showConfirm = Boolean(token) && (phase.kind === 'idle' || phase.kind === 'busy' || phase.kind === 'error');

  return (
    <div className="space-y-6 rounded-lg border border-border/70 bg-card p-6 sm:p-8" data-testid="request-access-verify">
      {showInvalid && (
        <div role="alert" data-testid="request-access-invalid" className="space-y-2 text-center text-sm">
          <p className="text-foreground">This link is invalid or has expired.</p>
          <a href={withBase('/request-access')} className={LINK}>
            Request access again
          </a>
        </div>
      )}

      {phase.kind === 'request_sent' && (
        <div role="status" data-testid="request-access-request-sent" className="text-center text-sm text-foreground">
          Your request was sent. You'll get an email when your IT provider decides.
        </div>
      )}

      {phase.kind === 'request_unavailable' && (
        <div role="status" data-testid="request-access-unavailable" className="text-center text-sm text-foreground">
          We couldn't record your request right now. Contact your IT provider.
        </div>
      )}

      {phase.kind === 'existing_account' && (
        <div role="status" data-testid="request-access-existing" className="space-y-2 text-center text-sm text-foreground">
          <p>You already have an account. Sign in or reset your password.</p>
          <p className="flex items-center justify-center gap-4">
            <a href={withBase('/login')} className={LINK}>
              Sign in
            </a>
            <a href={withBase('/forgot-password')} className={LINK}>
              Reset password
            </a>
          </p>
        </div>
      )}

      {phase.kind === 'account_created' && (
        <div role="status" data-testid="request-access-created" className="text-center text-sm text-foreground">
          Your account is ready. Taking you to set it up…
        </div>
      )}

      {phase.kind === 'spent' && (
        <div role="alert" data-testid="request-access-spent" className="space-y-2 text-center text-sm text-foreground">
          <p>{phase.message}</p>
          <a href={withBase('/login')} className={LINK}>
            Back to sign in
          </a>
        </div>
      )}

      {phase.kind === 'not_available' && (
        <div role="alert" data-testid="request-access-error" className="text-center text-sm text-foreground">
          Requesting access isn't available here. Contact your IT provider.
        </div>
      )}

      {showConfirm && (
        <>
          <div className="text-center">
            <p className="text-sm text-muted-foreground">
              Confirm that you want to request access to this customer portal.
            </p>
          </div>
          {phase.kind === 'error' && (
            <div
              role="alert"
              data-testid="request-access-error"
              className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive-on-tint"
            >
              <AlertCircle className="h-4 w-4 shrink-0" />
              {phase.message}
            </div>
          )}
          <button
            type="button"
            data-testid="request-access-confirm"
            disabled={phase.kind === 'busy'}
            onClick={confirm}
            className={cn(BTN_PRIMARY, 'w-full')}
          >
            {phase.kind === 'busy' ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Confirming
              </>
            ) : (
              'Confirm my request'
            )}
          </button>
        </>
      )}
    </div>
  );
}

export default VerifyAccessRequest;
