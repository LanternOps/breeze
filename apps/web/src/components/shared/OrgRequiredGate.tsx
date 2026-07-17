import type { ReactNode } from 'react';
import { useOrgScope } from '@/hooks/useOrgScope';
import { OrgRequiredState } from './OrgRequiredState';
import { OrgLoadFailedState } from './OrgLoadFailedState';

/** A neutral placeholder for the pre-resolution frame — no data, no scary
 * empty state, just enough height that the layout doesn't jump when the real
 * content lands. */
function OrgContextSkeleton() {
  return (
    <div data-testid="org-context-skeleton" className="animate-pulse space-y-4" aria-hidden="true">
      <div className="h-8 w-48 rounded bg-muted" />
      <div className="h-32 rounded-lg bg-muted/60" />
    </div>
  );
}

/**
 * The single gate for org-required pages (backup, C2C, DR, and any future page
 * whose APIs 400 without one org). It resolves the four non-org states so no
 * page has to re-derive them — and, crucially, so a failed org-context load
 * renders a retry affordance instead of a permanently blank page (the state
 * `if (!ready) return null` used to collapse into):
 *
 *   loading → skeleton;  error → retry card;  empty/fleet → org-required prompt.
 *
 * `description` is forwarded to OrgRequiredState for the page's own sentence.
 */
export function OrgRequiredGate({
  description,
  children,
}: {
  description?: string;
  children: ReactNode;
}) {
  const s = useOrgScope();
  if (s.status === 'loading') return <OrgContextSkeleton />;
  if (s.status === 'error') return <OrgLoadFailedState error={s.error} />;
  // 'empty' (partner has zero orgs) and explicit fleet view both mean "no single
  // org to scope to" — the prompt degrades gracefully to just its message when
  // there are no orgs to quick-pick.
  if (s.status === 'empty' || s.scope === 'all') return <OrgRequiredState description={description} />;
  return <>{children}</>;
}
