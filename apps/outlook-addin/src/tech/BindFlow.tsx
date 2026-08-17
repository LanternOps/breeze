/**
 * Technician bind flow (spec Task 25): acquires a fresh Entra identity token
 * (silent Office SSO, falling back to the MSAL popup — this component IS the
 * user gesture that unblocks the popup), then collects the Breeze login
 * credential (email + password + MFA code) and calls `bindTechnician` to
 * establish the Entra <-> Breeze technician binding.
 *
 * On success, `onBound()` fires — the caller (OutlookAuthExtras) is
 * responsible for the subsequent silent `signIn` against
 * `/office-addin/auth/exchange` and re-entering the normal App flow; this
 * component only owns the bind step itself.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { getEntraTokenInteractive, getEntraTokenSilent } from '@breeze/office-addin-core';
import { bindTechnician, TechApiError } from './api';

export interface BindFlowProps {
  onBound(): void;
}

type TokenFailureReason = 'popup_blocked' | 'cancelled' | 'unknown';

type TokenState =
  | { status: 'acquiring' }
  | { status: 'ready'; token: string }
  | { status: 'failed'; reason: TokenFailureReason };

/** Map the MSAL BrowserAuthError codes we can act on to a user-actionable
 *  reason; everything else (consent, conditional access, network, Office SSO
 *  error codes) stays generic — the full error is on the console either way. */
function tokenFailureReason(err: unknown): TokenFailureReason {
  const code =
    err && typeof err === 'object' ? (err as { errorCode?: unknown }).errorCode : undefined;
  if (code === 'popup_window_error' || code === 'empty_window_error') return 'popup_blocked';
  if (code === 'user_cancelled') return 'cancelled';
  return 'unknown';
}

const TOKEN_FAILURE_MESSAGES: Record<TokenFailureReason, string> = {
  popup_blocked:
    'Your browser blocked the Microsoft sign-in popup. Allow popups for this add-in, then try again.',
  cancelled: 'Microsoft sign-in was cancelled. Try again.',
  unknown: "Couldn't get a Microsoft sign-in token. Try again.",
};

const BIND_ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: 'Incorrect email or password.',
  invalid_mfa: 'Incorrect verification code. Try again.',
  not_a_technician: 'This Breeze account is not a technician account.',
  mfa_enrollment_required: 'Multi-factor authentication is required for your account but is not set up yet. Enroll in MFA in Breeze first, then try again.',
  identity_already_bound: 'This Microsoft identity is already linked to a different Breeze technician.',
};

function bindErrorMessage(err: unknown): string {
  if (err instanceof TechApiError) {
    return BIND_ERROR_MESSAGES[err.code] ?? 'Something went wrong linking your account. Try again.';
  }
  return 'Something went wrong linking your account. Try again.';
}

export function BindFlow({ onBound }: BindFlowProps) {
  const [tokenState, setTokenState] = useState<TokenState>({ status: 'acquiring' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Silent first (may already have a live Office SSO session); this
    // component only mounts from a user click, so the interactive (MSAL
    // popup) fallback is safe to fire from here.
    getEntraTokenSilent()
      .catch(() => getEntraTokenInteractive())
      .then((token) => {
        if (!cancelled) setTokenState({ status: 'ready', token });
      })
      .catch((err: unknown) => {
        // Popup-blocked / consent / conditional-access / network all land here —
        // keep the full error on the console so support isn't debugging blind.
        console.error('BindFlow: Entra token acquisition failed', err);
        if (!cancelled) setTokenState({ status: 'failed', reason: tokenFailureReason(err) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const formValid = email.trim() !== '' && password !== '' && mfaCode.trim() !== '';

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (tokenState.status !== 'ready' || !formValid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await bindTechnician({ accessToken: tokenState.token, email, password, mfaCode });
      onBound();
    } catch (err) {
      setError(bindErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (tokenState.status === 'acquiring') {
    return (
      <div className="p-4 text-center text-sm text-gray-400" data-testid="bind-loading">
        Connecting to Microsoft…
      </div>
    );
  }

  if (tokenState.status === 'failed') {
    return (
      <div className="p-4 text-center text-sm text-red-600" data-testid="bind-token-error">
        {TOKEN_FAILURE_MESSAGES[tokenState.reason]}
      </div>
    );
  }

  return (
    <form className="flex flex-col gap-3 p-4" onSubmit={handleSubmit}>
      <div className="text-sm font-semibold text-gray-800">Link your Breeze technician account</div>
      <label className="flex flex-col gap-1 text-left text-xs text-gray-600">
        Breeze email
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          data-testid="bind-email"
          autoComplete="username"
        />
      </label>
      <label className="flex flex-col gap-1 text-left text-xs text-gray-600">
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          data-testid="bind-password"
          autoComplete="current-password"
        />
      </label>
      <label className="flex flex-col gap-1 text-left text-xs text-gray-600">
        MFA code
        <input
          type="text"
          inputMode="numeric"
          value={mfaCode}
          onChange={(e) => setMfaCode(e.target.value)}
          className="rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          data-testid="bind-mfa"
          autoComplete="one-time-code"
        />
      </label>
      {error && (
        <p className="text-xs text-red-600" data-testid="bind-error">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={!formValid || submitting}
        className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        data-testid="bind-submit"
      >
        {submitting ? 'Linking…' : 'Link account'}
      </button>
    </form>
  );
}
