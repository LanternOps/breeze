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
};

export function BlockedScreen({ kind, onRetry }: { kind: AuthBlockKind; onRetry?: () => void }) {
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
    </div>
  );
}
