import type { ReactNode } from 'react';
import type { AuthBlockKind } from '../auth/session';

const COPY: Record<AuthBlockKind, { title: string; body: string }> = {
  not_provisioned: {
    title: 'Not set up yet',
    body: 'Breeze AI has not been provisioned for your organization. Contact your IT provider to enable it.',
  },
  disabled: {
    title: 'Disabled',
    body: 'Breeze AI is currently disabled for your organization. Contact your IT provider.',
  },
  user_not_permitted: {
    title: 'No access',
    body: 'Your account does not have access to Breeze AI. Contact your IT provider.',
  },
  account_inactive: {
    title: 'Account inactive',
    body: 'Your account is inactive. Contact your IT provider.',
  },
  retryable: {
    title: 'Temporarily unavailable',
    body: 'Something went wrong talking to Breeze. Try again in a moment.',
  },
  unsupported_persona: {
    title: 'Not available',
    body: 'This session type is not supported here. Please reload the add-in.',
  },
  relink_required: {
    title: 'Re-link required',
    body: 'Your technician account needs to be re-linked (e.g. after a password reset). Sign in again to reconnect.',
  },
  access_revoked: {
    title: 'Access revoked',
    body: 'Your access has been revoked. Contact your administrator.',
  },
};

export function BlockedScreen({
  kind,
  onRetry,
  extra,
}: {
  kind: AuthBlockKind;
  onRetry?: () => void;
  /** Outlook-only technician bind/re-link affordance (App's `signInExtra`), shown
   *  for the kinds where self-serve recovery is possible (not_provisioned, relink_required). */
  extra?: ReactNode;
}) {
  const copy = COPY[kind];
  return (
    <div
      className="flex h-screen flex-col items-center justify-center gap-2 p-6 text-center"
      data-testid={`blocked-${kind}`}
    >
      <div className="text-base font-semibold text-gray-800">{copy.title}</div>
      <p className="text-sm text-gray-500">{copy.body}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 rounded-md border border-gray-300 px-4 py-1.5 text-sm text-gray-700"
          data-testid="blocked-retry"
        >
          Try again
        </button>
      )}
      {extra}
    </div>
  );
}
