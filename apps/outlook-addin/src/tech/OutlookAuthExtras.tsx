/**
 * Outlook's `App` `signInExtra` node (Task 25) — a low-key "Technician
 * sign-in" control that opens BindFlow. Rendered by core App on:
 *   - the sign-in screen (first-run technician onboarding),
 *   - the `not_provisioned` blocked screen (a technician hit the client-AI
 *     404 before ever binding),
 *   - the `relink_required` blocked screen (a previously-bound technician
 *     whose binding needs to be re-established, e.g. after a password reset).
 *
 * App itself stays host-neutral: it only renders whatever ReactNode Outlook's
 * main.tsx hands it. This component owns the local "open BindFlow" toggle and,
 * once BindFlow reports `onBound`, performs the fresh silent exchange
 * (`/office-addin/auth/exchange`) and notifies `onSessionReady` — the caller
 * (main.tsx) remounts `App` so it re-reads the now-stored tech session and
 * re-enters the normal ready flow.
 */
import { useState } from 'react';
import { signIn } from '@breeze/office-addin-core';
import { BindFlow } from './BindFlow';

export interface OutlookAuthExtrasProps {
  /** Fires once the post-bind silent re-exchange succeeds — the caller should
   *  remount/refresh App so it picks up the newly stored tech session. */
  onSessionReady: () => void;
}

export function OutlookAuthExtras({ onSessionReady }: OutlookAuthExtrasProps) {
  const [open, setOpen] = useState(false);
  const [reSignInError, setReSignInError] = useState(false);

  if (!open) {
    return (
      <div className="mt-3 flex flex-col items-center gap-1">
        {reSignInError && (
          <p className="text-xs text-red-600" data-testid="technician-resignin-error">
            Account linked, but signing you in failed. Try again.
          </p>
        )}
        <button
          type="button"
          onClick={() => {
            setReSignInError(false);
            setOpen(true);
          }}
          className="text-xs text-gray-400 underline"
          data-testid="technician-signin-link"
        >
          Technician sign-in
        </button>
      </div>
    );
  }

  async function handleBound(): Promise<void> {
    try {
      await signIn({ interactive: false, exchangePath: '/office-addin/auth/exchange' });
      onSessionReady();
    } catch {
      // The binding itself succeeded — a transient failure of the immediate
      // follow-up exchange shouldn't strand the technician silently. Falling
      // back to the closed state lets them retry via the same link; App's own
      // boot-time signIn (on next mount/reload) will also pick the binding up.
      setReSignInError(true);
      setOpen(false);
    }
  }

  return (
    <div className="mt-3 w-full">
      <BindFlow onBound={handleBound} />
    </div>
  );
}
